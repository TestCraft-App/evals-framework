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

export function createSessions(store, env, fetchImpl = fetch) {
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
  const oauthCookie = secure ? '__Host-testcraft_oauth' : 'testcraft_oauth';
  const admins = new Set((env.ADMIN_GITHUB_IDS || '').split(',').map(value => value.trim()).filter(Boolean));
  if ([...admins].some(id => !/^[1-9][0-9]*$/.test(id))) throw new Error('ADMIN_GITHUB_IDS must contain comma-separated numeric GitHub IDs.');
  const loginAvailable = Boolean(env.OAUTH_GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
  const pending = new Map();
  for (const user of store.db.prepare('SELECT id, github_id FROM users').all()) store.db.prepare('UPDATE users SET role=? WHERE id=?').run(admins.has(user.github_id) ? 'admin' : 'collaborator', user.id);
  workspace('main');
  const csrf = token => createHmac('sha256', token).update(`csrf:${workshopId}`).digest('hex');

  function workspace(kind, userId = null) {
    let row = store.db.prepare('SELECT * FROM workspaces WHERE workshop_id=? AND kind=? AND user_id IS ?').get(workshopId, kind, userId);
    if (!row) {
      store.db.prepare('INSERT OR IGNORE INTO workspaces VALUES (?,?,?,?)').run(randomUUID(), workshopId, kind, userId);
      row = store.db.prepare('SELECT * FROM workspaces WHERE workshop_id=? AND kind=? AND user_id IS ?').get(workshopId, kind, userId);
    }
    return { ownerId: row.id, workshopId, alias: kind, name: kind === 'main' ? 'TestCraft' : 'My workspace' };
  }
  function resolveWorkspace(session, alias = 'personal') {
    if (!['main', 'personal'].includes(alias)) throw new AppError('Workspace not found.', 404);
    return workspace(alias, alias === 'personal' ? session.user.id : null);
  }
  function workspaces(session) {
    return ['main', 'personal'].map(alias => ({ id: alias, name: alias === 'main' ? 'TestCraft' : 'My workspace', canWrite: alias === 'personal' || session.user.role === 'admin', canRun: true }));
  }
  function cookie(req, name) {
    const values = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
    return values.length === 1 ? values[0].slice(name.length + 1) : '';
  }
  const serializeCookie = (name, value, age, sameSite = 'Strict') => `${name}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${age}${secure ? '; Secure' : ''}`;

  function expectedOrigin(req) {
    if (origin) return origin;
    let candidate;
    try { candidate = new URL(`http://${req.headers.host}`); } catch { throw new AppError('Invalid request origin.', 403); }
    if (!loopback(candidate.hostname) || !loopback(req.socket.remoteAddress)) throw new AppError('Configure APP_ORIGIN before allowing remote access.', 403);
    return candidate.origin;
  }
  function checkOrigin(req, required = false, allowNavigation = false) {
    const expected = expectedOrigin(req);
    if ((required || req.headers.origin) && req.headers.origin !== expected) throw new AppError('Cross-origin requests are not allowed.', 403);
    const publicNavigation = allowNavigation && req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
    if (req.headers['sec-fetch-site'] === 'cross-site' && !publicNavigation) throw new AppError('Cross-site requests are not allowed.', 403);
  }
  function read(req) {
    const token = cookie(req, cookieName);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = store.db.prepare('SELECT s.expires_at, u.* FROM account_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.workshop_id=? AND s.expires_at>?').get(hash(token), workshopId, Date.now());
    if (!row) return null;
    const user = { id: row.id, githubId: row.github_id, login: row.login, name: row.name, role: row.role };
    return { ...workspace('personal', user.id), user, expiresAt: row.expires_at, csrfToken: csrf(token) };
  }
  function describe(session) {
    if (!session) return { authenticated: false, loginAvailable };
    return { authenticated: true, user: session.user, workspaces: workspaces(session), workspaceId: session.ownerId, expiresAt: new Date(session.expiresAt).toISOString(), csrfToken: session.csrfToken };
  }
  function requireSession(req) {
    const session = read(req);
    if (!session) throw new AppError('Sign in with GitHub to continue.', 401);
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
  function start(req, res, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new AppError('Login expects an empty JSON object.');
    if (!loginAvailable) throw new AppError('GitHub login is not configured. Contact the app administrator.', 503);
    rateLimit(req);
    for (const [key, value] of pending) if (value.expiresAt <= Date.now()) pending.delete(key);
    if (pending.size >= 1000) throw new AppError('Too many pending logins. Try again shortly.', 429);
    const state = randomBytes(32).toString('base64url'), binding = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    const redirectUri = expectedOrigin(req) + '/api/auth/github/callback';
    pending.set(hash(state), { binding: hash(binding), verifier, redirectUri, expiresAt: Date.now() + 600000, previousToken: hash(cookie(req, cookieName)) });
    res.setHeader('set-cookie', serializeCookie(oauthCookie, binding, 600, 'Lax'));
    const url = new URL('https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({ client_id: env.OAUTH_GITHUB_CLIENT_ID, redirect_uri: redirectUri, scope: '', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    return { authorizeUrl: url.href };
  }
  async function callback(req, res, params) {
    res.setHeader('set-cookie', serializeCookie(oauthCookie, '', 0, 'Lax'));
    const state = params.get('state') || '', key = hash(state), transaction = pending.get(key);
    pending.delete(key);
    if (!transaction || transaction.expiresAt <= Date.now() || !equal(transaction.binding, hash(cookie(req, oauthCookie)))) throw new AppError('Login expired or could not be verified. Sign in again.', 400);
    if (params.has('error')) throw new AppError('GitHub login was cancelled. You can sign in again.', 400);
    const code = params.get('code');
    if (!code || code.length > 512) throw new AppError('GitHub login could not be verified. Sign in again.', 400);
    let identity;
    try {
      const response = await fetchImpl('https://github.com/login/oauth/access_token', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.OAUTH_GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: transaction.redirectUri, code_verifier: transaction.verifier }).toString(), redirect: 'error', signal: AbortSignal.timeout(15000) });
      const token = await response.json();
      if (!response.ok || typeof token.access_token !== 'string' || !token.access_token) throw new Error('Token unavailable');
      const profile = await fetchImpl('https://api.github.com/user', { headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'TestCraft-Evals' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
      identity = await profile.json();
      if (!profile.ok || !Number.isSafeInteger(identity.id) || identity.id <= 0 || typeof identity.login !== 'string' || !/^[a-zA-Z0-9-]{1,39}$/.test(identity.login)) throw new Error('Identity unavailable');
    } catch { throw new AppError('Could not verify your GitHub account. Sign in again.', 502); }
    const githubId = String(identity.id), now = new Date().toISOString(), token = randomBytes(32).toString('base64url');
    store.transaction(() => {
      store.db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?) ON CONFLICT(github_id) DO UPDATE SET login=excluded.login,name=excluded.name,role=excluded.role,last_login_at=excluded.last_login_at').run(randomUUID(), githubId, identity.login, typeof identity.name === 'string' ? identity.name.slice(0, 200) : identity.login, admins.has(githubId) ? 'admin' : 'collaborator', now, now);
      const user = store.db.prepare('SELECT id FROM users WHERE github_id=?').get(githubId);
      workspace('personal', user.id);
      store.db.prepare('DELETE FROM account_sessions WHERE token_hash=? OR expires_at<=?').run(transaction.previousToken, Date.now());
      store.db.prepare('INSERT INTO account_sessions VALUES (?,?,?,?)').run(hash(token), user.id, workshopId, Date.now() + ttl);
    });
    res.setHeader('set-cookie', [serializeCookie(oauthCookie, '', 0, 'Lax'), serializeCookie(cookieName, token, ttl / 1000)]);
  }
  function logout(req, res) {
    requireSession(req);
    store.db.prepare('DELETE FROM account_sessions WHERE token_hash=?').run(hash(cookie(req, cookieName)));
    res.setHeader('set-cookie', serializeCookie(cookieName, '', 0));
    return { authenticated: false };
  }
  return { workshopId, checkOrigin, read, describe, requireSession, start, callback, logout, resolveWorkspace, workspaces };
}
