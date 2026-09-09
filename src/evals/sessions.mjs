import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { AppError } from './validation.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => timingSafeEqual(Buffer.from(hash(a), 'hex'), Buffer.from(hash(b), 'hex'));
const loopback = host => ['localhost', '127.0.0.1', '[::1]', '::1', '::ffff:127.0.0.1'].includes(host);
function integer(env, name, fallback, min, max) {
  const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}

export function createSessions(store, env) {
  const workshopId = env.WORKSHOP_ID || 'workshop';
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(workshopId)) throw new Error('WORKSHOP_ID must contain 1–80 letters, numbers, underscores or hyphens.');
  const ttl = integer(env, 'WORKSHOP_SESSION_HOURS', 24, 1, 168) * 3600000;
  let origin;
  if (env.APP_ORIGIN) {
    const parsed = new URL(env.APP_ORIGIN);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' || (parsed.protocol !== 'https:' && !loopback(parsed.hostname))) throw new Error('APP_ORIGIN must be an HTTPS origin (HTTP is allowed only for localhost).');
    origin = parsed.origin;
  }
  if (!origin && (env.NODE_ENV === 'production' || (env.HOST && !loopback(env.HOST)))) throw new Error('Set APP_ORIGIN to the public HTTPS origin before exposing this server.');
  const secure = origin?.startsWith('https:') || false;
  const cookieName = secure ? '__Host-testcraft_session' : 'testcraft_session';
  // The random cookie is the session secret; no shared access code is required.
  const csrf = token => createHmac('sha256', token).update(`csrf:${workshopId}`).digest('hex');

  function expectedOrigin(req) {
    if (origin) return origin;
    let candidate;
    try { candidate = new URL(`http://${req.headers.host}`); } catch { throw new AppError('Invalid request origin.', 403); }
    if (!loopback(candidate.hostname) || !loopback(req.socket.remoteAddress)) throw new AppError('Configure APP_ORIGIN before allowing remote access.', 403);
    return candidate.origin;
  }
  function checkOrigin(req, required = false) {
    const expected = expectedOrigin(req);
    if ((required || req.headers.origin) && req.headers.origin !== expected) throw new AppError('Cross-origin requests are not allowed.', 403);
    if (req.headers['sec-fetch-site'] === 'cross-site') throw new AppError('Cross-site requests are not allowed.', 403);
  }
  function read(req) {
    const cookies = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(cookieName + '='));
    if (cookies.length !== 1) return null;
    const token = cookies[0].slice(cookieName.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = store.db.prepare('SELECT * FROM sessions WHERE token_hash=? AND workshop_id=? AND expires_at>?').get(hash(token), workshopId, Date.now());
    if (!row) return null;
    return { ownerId: row.owner_id, workshopId, expiresAt: row.expires_at, csrfToken: csrf(token) };
  }
  function describe(session) {
    if (!session) return { authenticated: false, accessMode: 'anonymous' };
    return { authenticated: true, workspaceId: session.ownerId, expiresAt: new Date(session.expiresAt).toISOString(), csrfToken: session.csrfToken };
  }
  function requireSession(req) {
    const session = read(req);
    if (!session) throw new AppError('Your browser session is missing or expired. Reload the page to create one automatically.', 401);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      checkOrigin(req, true);
      if (typeof req.headers['x-csrf-token'] !== 'string' || !equal(req.headers['x-csrf-token'], session.csrfToken)) throw new AppError('Invalid session request. Reload the page and try again.', 403);
    }
    return session;
  }
  function rateLimit(req) {
    const now = Date.now();
    const allowed = store.transaction(() => {
      store.db.prepare('DELETE FROM access_attempts WHERE expires_at<=?').run(now);
      const keys = [['session:global', 100], ['session:ip:' + hash(req.socket.remoteAddress || 'unknown'), 20]];
      const counts = keys.map(([key, max]) => {
        store.db.prepare('INSERT INTO access_attempts VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(key, now + 60000);
        return store.db.prepare('SELECT count FROM access_attempts WHERE key=?').get(key).count <= max;
      });
      return counts.every(Boolean);
    });
    if (!allowed) throw new AppError('Too many new sessions. Wait one minute and try again.', 429);
  }
  function ensure(req, res, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new AppError('Session creation expects an empty JSON object.');
    const existing = read(req);
    if (existing) return describe(existing);
    rateLimit(req);
    const token = randomBytes(32).toString('base64url');
    const ownerId = randomUUID(), expiresAt = Date.now() + ttl;
    // Retain the legacy column for an additive, non-destructive upgrade.
    store.db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(hash(token), ownerId, workshopId, 'anonymous-v1', expiresAt);
    res.setHeader('set-cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttl / 1000}${secure ? '; Secure' : ''}`);
    return describe({ ownerId, expiresAt, csrfToken: csrf(token) });
  }
  return { workshopId, checkOrigin, read, describe, requireSession, ensure };
}
