import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './src/evals/store.mjs';
import { Engine } from './src/evals/engine.mjs';
import { summarizeRun } from './src/evals/runs.mjs';
import { environments, localAvailable, resolveEnvironment, validateRunRequest, validateRunModels } from './src/evals/run-config.mjs';
import { AppError, validateEvaluation } from './src/evals/validation.mjs';
import { publicConfig } from './src/evals/providers.mjs';
import { createModelCatalog } from './src/evals/models.mjs';
import { createSessions } from './src/evals/sessions.mjs';
import { workshopSuites, basicWorkshopSuites } from './src/evals/workshop.mjs';
import { loadRuntimeSecrets } from './src/runtime/secrets.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));

export function createApp({ env = process.env, dbPath = env.TESTCRAFT_EVALS_DB || join(root, 'data', 'evals.sqlite'), fetchImpl = fetch } = {}) {
  const store = new Store(dbPath);
  let sessions;
  try { sessions = createSessions(store, env, fetchImpl); } catch (error) { store.close(); throw error; }
  const engine = new Engine(store, env, fetchImpl);
  const catalogs = Object.fromEntries(Object.entries(environments).map(([id, base]) => [id, createModelCatalog({ ...env, TESTCRAFT_BASE_URL: base }, fetchImpl)]));
  let stopping = false, shutdownPromise;
  const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/run-detail.js': ['run-detail.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  async function readBody(req, maxBytes = 350000) {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new AppError('Request body is too large.', 413);
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError('Request body must be valid JSON.'); }
  }
  const validateEvaluationBody = body => validateEvaluation(typeof body?.suiteId === 'string' ? { ...body, suiteId: body.suiteId.trim() } : body);
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url, 'http://localhost');
      // External links may open the public dashboard; API requests remain protected.
      sessions.checkOrigin(req, req.method === 'POST', ['/', '/api/auth/github/callback'].includes(url.pathname));
      if (env.APP_ORIGIN?.startsWith('https://')) res.setHeader('strict-transport-security', 'max-age=31536000');
      if (req.method === 'GET' && url.pathname === '/healthz') {
        store.db.prepare('SELECT 1').get();
        return json(res, engine.accepting && !stopping ? 200 : 503, {
          status: engine.accepting && !stopping ? 'ok' : 'draining', idle: engine.idle,
          release: /^[a-f0-9]{40}$/.test(env.APP_RELEASE || '') ? env.APP_RELEASE : 'local',
        });
      }
      if (stopping && !['GET', 'HEAD'].includes(req.method)) {
        res.setHeader('retry-after', '10');
        throw new AppError('The server is restarting. Retry shortly.', 503);
      }
      const jsonRequest = ['POST', 'PUT', 'PATCH'].includes(req.method) || (req.method === 'DELETE' &&
        (req.headers['content-type'] !== undefined || req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length']) > 0));
      if (jsonRequest && !/^application\/json\s*(?:;|$)/i.test(req.headers['content-type'] || '')) throw new AppError('Use application/json.', 415);
      if (url.pathname === '/api/session') {
        if (req.method === 'GET') return json(res, 200, sessions.describe(sessions.read(req)));
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/github/start') return json(res, 200, sessions.start(req, res, await readBody(req, 2048)));
      if (req.method === 'GET' && url.pathname === '/api/auth/github/callback') {
        try { await sessions.callback(req, res, url.searchParams); }
        catch (error) {
          if (!(error instanceof AppError)) throw error;
          res.writeHead(303, { location: '/?login=failed', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(); return;
        }
        res.writeHead(303, { location: '/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') return json(res, 200, sessions.logout(req, res));
      const account = url.pathname.startsWith('/api/') ? sessions.requireSession(req) : null;
      if (req.method === 'GET' && url.pathname === '/api/workspaces') return json(res, 200, { workspaces: sessions.workspaces(account) });
      const workspaceMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)(\/.*)$/);
      const scope = account ? sessions.resolveWorkspace(account, workspaceMatch?.[1] || 'personal') : null;
      if (workspaceMatch) url.pathname = '/api' + workspaceMatch[2];
      const canWrite = account?.user.role === 'admin' || scope?.alias === 'personal';
      if (account && !['GET', 'HEAD'].includes(req.method) && !canWrite && !(url.pathname === '/api/runs' && req.method === 'POST')) throw new AppError('The TestCraft workspace is read-only for collaborators.', 403);
      const allowLocal = localAvailable(env, server.address());
      if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, { ...publicConfig(env), credentialMode: account.user.role === 'admin' ? 'server' : 'personal', environments: Object.keys(environments).map(id => ({ id, label: { prod: 'Prod', dev: 'Dev', local: 'Local' }[id], enabled: id !== 'local' || allowLocal })) });
      if (req.method === 'GET' && url.pathname === '/api/models') {
        const environment = url.searchParams.get('environment') || 'prod';
        resolveEnvironment(environment, allowLocal);
        return json(res, 200, { ...await catalogs[environment](), environment });
      }
      if (req.method === 'GET' && url.pathname === '/api/workspace') return json(res, 200, store.workspaceSummary(scope));
      if (req.method === 'DELETE' && url.pathname === '/api/workspace') return json(res, 200, store.clearWorkspace(await readBody(req, 2048), scope));
      if (req.method === 'POST' && ['/api/workshop-suite', '/api/basic-workshop-suite'].includes(url.pathname)) {
        const body = await readBody(req, 2048);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new AppError('Workshop import expects an empty JSON object.');
        const { created, ...result } = store.importWorkshop(url.pathname === '/api/basic-workshop-suite' ? basicWorkshopSuites : workshopSuites, scope);
        return json(res, created ? 201 : 200, result);
      }
      if (url.pathname === '/api/suites') {
        if (req.method === 'GET') return json(res, 200, { suites: store.suites(scope) });
        if (req.method === 'POST') return json(res, 201, store.createSuite(await readBody(req, 2048), scope));
      }
      const suiteMatch = url.pathname.match(/^\/api\/suites\/([a-z0-9-]+)$/i);
      if (suiteMatch) {
        const suite = store.suite(suiteMatch[1], scope);
        if (!suite) throw new AppError('Suite not found.', 404);
        if (req.method === 'GET') return json(res, 200, suite);
        if (req.method === 'PUT') return json(res, 200, store.updateSuite(suite.id, await readBody(req, 2048), scope));
        if (req.method === 'DELETE') return json(res, 200, store.deleteSuite(suite.id, scope));
      }
      if (url.pathname === '/api/evaluations') {
        if (req.method === 'GET') {
          const runs = store.runs(scope);
          const evaluations = store.evaluations(scope).map(evaluation => {
            const matches = item => item.evaluationId === evaluation.id && item.evaluation && (item.evaluation.revision ?? 1) === evaluation.revision;
            const latestRun = runs.find(run => run.items.some(matches));
            const latestItem = latestRun?.items.find(matches);
            return { ...evaluation, latest: latestItem ? { status: latestItem.status, score: latestItem.score, runId: latestRun.id, createdAt: latestRun.createdAt } : null };
          });
          return json(res, 200, { evaluations });
        }
        if (req.method === 'POST') return json(res, 201, store.create(validateEvaluationBody(await readBody(req)), scope));
      }
      const evaluationMatch = url.pathname.match(/^\/api\/evaluations\/([a-z0-9-]+)$/i);
      if (evaluationMatch) {
        const evaluation = store.evaluation(evaluationMatch[1], scope);
        if (!evaluation) throw new AppError('Evaluation not found.', 404);
        if (req.method === 'GET') return json(res, 200, evaluation);
        if (req.method === 'PATCH') return json(res, 200, store.renameEvaluation(evaluation.id, await readBody(req, 2048), scope));
        if (req.method === 'PUT') {
          const body = await readBody(req);
          return json(res, 200, store.updateEvaluation(evaluation.id, validateEvaluationBody(body), body.revision, scope));
        }
        if (req.method === 'DELETE') return json(res, 200, store.deleteEvaluation(evaluation.id, scope));
      }
      const duplicateMatch = url.pathname.match(/^\/api\/evaluations\/([a-z0-9-]+)\/duplicate$/i);
      if (duplicateMatch && req.method === 'POST') {
        if (!store.evaluation(duplicateMatch[1], scope)) throw new AppError('Evaluation not found.', 404);
        return json(res, 201, store.duplicateEvaluation(duplicateMatch[1], await readBody(req, 2048), scope));
      }
      if (url.pathname === '/api/runs') {
        if (req.method === 'POST') {
          const body = await readBody(req), settings = validateRunRequest(body, allowLocal);
          const collaborator = account.user.role !== 'admin';
          if (collaborator && (typeof body.openAiApiKey !== 'string' || !body.openAiApiKey.trim() || body.openAiApiKey.length > 4096 || /[\s\x00-\x1f\x7f]/.test(body.openAiApiKey))) throw new AppError('Enter your OpenAI API key before creating a run.');
          const credentials = collaborator ? { OPENAI_API_KEY: body.openAiApiKey, TESTCRAFT_OPENAI_API_KEY: body.openAiApiKey } : { OPENAI_API_KEY: env.OPENAI_API_KEY, TESTCRAFT_OPENAI_API_KEY: env.TESTCRAFT_OPENAI_API_KEY };
          engine.evaluationsForRun(body.evaluationIds, scope);
          const catalog = await catalogs[settings.environment]();
          // Re-read after the asynchronous catalog lookup: edits/deletions may have completed meanwhile.
          const normalized = validateRunModels(settings, engine.evaluationsForRun(body.evaluationIds, scope), catalog);
          const destination = collaborator ? sessions.resolveWorkspace(account, 'personal') : scope;
          return json(res, 202, engine.start(body.evaluationIds, scope, normalized, { destination, credentials, user: account.user }));
        }
        if (req.method === 'GET') return json(res, 200, { runs: store.runs(scope).map(run => ({ ...summarizeRun(run), canDelete: canWrite && summarizeRun(run).canDelete })) });
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([a-z0-9-]+)$/i);
      if (runMatch && req.method === 'DELETE') return json(res, 200, store.deleteRun(runMatch[1], scope));
      if (runMatch && req.method === 'GET') {
        const run = store.run(runMatch[1], scope);
        if (!run) throw new AppError('Run not found.', 404);
        return json(res, 200, run);
      }
      if (req.method === 'GET' && files[url.pathname]) {
        const [file, mime] = files[url.pathname];
        res.writeHead(200, { 'content-type': mime + '; charset=utf-8', 'cache-control': 'no-store' });
        res.end(await readFile(join(root, 'public', file)));
        return;
      }
      throw new AppError('Not found.', 404);
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : 'Unexpected server error.' });
      else res.end();
    }
  });
  // A failed second start on an occupied port must not interrupt the live server's runs.
  server.once('listening', () => store.recoverInterruptedRuns());
  server.on('close', () => store.close());
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = engine.drain().then(() => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }));
    return shutdownPromise;
  }
  return { server, store, engine, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.loadEnvFile(join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await loadRuntimeSecrets(process.env); }
  catch (error) { console.error(error.message); process.exit(1); }
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const { server, store, engine, shutdown } = createApp();
  let shuttingDown = false;
  const stop = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Finishing accepted evaluations before shutdown.');
    const deadline = setTimeout(() => {
      console.error('Shutdown deadline reached. Unfinished runs will be marked interrupted on restart.');
      process.exit(1);
    }, 180000);
    shutdown().then(() => { clearTimeout(deadline); process.exitCode = 0; }, () => process.exit(1));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  if (process.platform !== 'win32') {
    process.on('SIGUSR2', () => { void engine.drain(); });
    process.on('SIGCONT', () => { if (!shuttingDown) engine.resume(); });
  }
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Stop the previous server or set PORT in .env.` : error.message);
    if (!server.listening) store.close();
    process.exitCode = 1;
  });
  server.listen(port, host, () => console.log(`TestCraft Evals · http://${host}:${port} · SQLite persistence enabled`));
}
