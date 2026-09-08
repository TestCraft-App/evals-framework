import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './src/evals/store.mjs';
import { Engine } from './src/evals/engine.mjs';
import { AppError, validateEvaluation } from './src/evals/validation.mjs';
import { publicConfig } from './src/evals/providers.mjs';
import { createModelCatalog } from './src/evals/models.mjs';
import { createSessions } from './src/evals/sessions.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));

export function createApp({ env = process.env, dbPath = env.TESTCRAFT_EVALS_DB || join(root, 'data', 'evals.sqlite'), fetchImpl = fetch } = {}) {
  const store = new Store(dbPath);
  let sessions;
  try { sessions = createSessions(store, env); } catch (error) { store.close(); throw error; }
  const engine = new Engine(store, env, fetchImpl, sessions.limit);
  const getModels = createModelCatalog(env, fetchImpl);
  const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
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
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url, 'http://localhost');
      sessions.checkOrigin(req, req.method === 'POST');
      if (req.method === 'POST' && !req.headers['content-type']?.startsWith('application/json')) throw new AppError('Use application/json.', 415);
      if (url.pathname === '/api/session') {
        if (req.method === 'GET') return json(res, 200, sessions.describe(sessions.read(req)));
        if (req.method === 'POST') return json(res, 200, sessions.ensure(req, res, await readBody(req, 2048)));
      }
      const scope = url.pathname.startsWith('/api/') ? sessions.requireSession(req) : null;
      if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, publicConfig(env));
      if (req.method === 'GET' && url.pathname === '/api/models') return json(res, 200, await getModels());
      if (url.pathname === '/api/evaluations') {
        if (req.method === 'GET') {
          const runs = store.runs(scope);
          const evaluations = store.evaluations(scope).map(evaluation => {
            const latestRun = runs.find(run => run.items.some(item => item.evaluationId === evaluation.id));
            const latestItem = latestRun?.items.find(item => item.evaluationId === evaluation.id);
            return { ...evaluation, latest: latestItem ? { status: latestItem.status, score: latestItem.score, runId: latestRun.id, createdAt: latestRun.createdAt } : null };
          });
          return json(res, 200, { evaluations });
        }
        if (req.method === 'POST') return json(res, 201, store.create(validateEvaluation(await readBody(req)), scope));
      }
      const evaluationMatch = url.pathname.match(/^\/api\/evaluations\/([a-z0-9-]+)$/i);
      if (evaluationMatch && req.method === 'GET') {
        const evaluation = store.evaluation(evaluationMatch[1], scope);
        if (!evaluation) throw new AppError('Evaluation not found.', 404);
        return json(res, 200, evaluation);
      }
      if (url.pathname === '/api/runs') {
        if (req.method === 'POST') return json(res, 202, engine.start((await readBody(req))?.evaluationIds, scope));
        if (req.method === 'GET') return json(res, 200, { runs: store.runs(scope).slice(0, 100).map(run => ({
          id: run.id, createdAt: run.createdAt, status: run.status, finishedAt: run.finishedAt,
          total: run.items.length, passed: run.items.filter(item => item.status === 'passed').length,
          failed: run.items.filter(item => item.status === 'failed').length, errors: run.items.filter(item => item.status === 'error').length,
        })) });
      }
      const runMatch = url.pathname.match(/^\/api\/runs\/([a-z0-9-]+)$/i);
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
  return { server, store, engine };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.loadEnvFile(join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const { server, store } = createApp();
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Stop the previous server or set PORT in .env.` : error.message);
    if (!server.listening) store.close();
    process.exitCode = 1;
  });
  server.listen(port, host, () => console.log(`TestCraft Evals · http://${host}:${port} · SQLite persistence enabled`));
}
