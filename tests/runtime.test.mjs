import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { createApp, listen, client, close, waitForRun } from './helpers.mjs';
import { loadRuntimeSecrets, parseSecrets } from '../src/runtime/secrets.mjs';

const arn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:evals/example-abcdef';
const savedCase = { name: 'Deployment test', type: 'ideas', source: 'testcraft_api', method: 'contains', html: '<button>Login</button>', criteria: ['login'] };

test('AWS credentials are loaded only when configured, validated atomically, and not merged with stale keys', async () => {
  const local = { OPENAI_API_KEY: 'local-only' };
  await loadRuntimeSecrets(local, () => assert.fail('Local mode must not contact AWS'));
  assert.equal(local.OPENAI_API_KEY, 'local-only');
  const env = { AWS_SECRET_ARN: arn, AWS_REGION: 'us-east-1', TESTCRAFT_OPENAI_API_KEY: 'stale' };
  await loadRuntimeSecrets(env, async request => {
    assert.deepEqual(request, { arn, region: 'us-east-1' });
    return '{"OPENAI_API_KEY":"server-only"}';
  });
  assert.equal(env.OPENAI_API_KEY, 'server-only');
  assert.equal(env.TESTCRAFT_OPENAI_API_KEY, '');
  assert.equal(env.GITHUB_CLIENT_SECRET, '');
  await loadRuntimeSecrets(env, async () => '{"OPENAI_API_KEY":"server-only","GITHUB_CLIENT_SECRET":"oauth-only"}');
  assert.equal(env.GITHUB_CLIENT_SECRET, 'oauth-only');
  await assert.rejects(loadRuntimeSecrets(env, async () => '{"OPENAI_API_KEY":"changed","APP_ORIGIN":"https://wrong.test"}'));
  assert.equal(env.OPENAI_API_KEY, 'server-only');
});

test('secret failures are fail-closed and never echo provider errors or secret contents', async () => {
  for (const value of [undefined, 'super-secret', 'null', '[]', '{"OPENAI_API_KEY":1}', '{"UNKNOWN":"secret"}', '{"OPENAI_API_KEY":"line\\nsecret"}', 'x'.repeat(16385)]) {
    assert.throws(() => parseSecrets(value), error => !error.message.includes('super-secret') && !error.message.includes('line'));
  }
  const env = { AWS_REGION: 'us-east-1', AWS_SECRET_ARN: arn };
  await assert.rejects(loadRuntimeSecrets(env, async () => { throw new Error('super-secret'); }), error => !error.message.includes('super-secret'));
  await assert.rejects(loadRuntimeSecrets({ ...env, AWS_REGION: 'eu-central-1' }, () => assert.fail('Wrong region must fail before AWS')));
});

test('health is read-only, private-data-free, uncacheable, and available without a browser session', async () => {
  const app = await listen(createApp({ dbPath: ':memory:', env: { APP_ORIGIN: 'https://workshop.example', APP_RELEASE: 'a'.repeat(40), OPENAI_API_KEY: 'never-public' } }));
  try {
    const res = await fetch(`http://127.0.0.1:${app.server.address().port}/healthz`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000');
    assert.deepEqual(await res.json(), { status: 'ok', idle: true, release: 'a'.repeat(40) });
    assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
  } finally { await close(app); }
});

test('drain rejects new paid work, finishes both active and queued items, and can be cancelled safely', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const app = await listen(createApp({ dbPath: ':memory:', fetchImpl: async () => {
    calls++; await gate;
    return new Response('data: {"choices":[{"delta":{"content":"login"},"finish_reason":"stop"}]}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } }));
  try {
    const person = await client(app);
    const cases = [];
    for (let i = 0; i < 4; i++) cases.push(await (await person.post('/api/evaluations', { ...savedCase, name: 'Case ' + i })).json());
    const run = await (await person.post('/api/runs', { evaluationIds: cases.slice(0, 3).map(c => c.id) })).json();
    for (let i = 0; i < 100 && calls < 2; i++) await tick();
    assert.equal(calls, 2);
    const drained = app.engine.drain();
    assert.equal(app.engine.idle, false);
    assert.equal((await person.request('/healthz')).status, 503);
    const rejected = await person.post('/api/runs', { evaluationIds: [cases[3].id] });
    assert.equal(rejected.status, 503);

    release(); await drained;
    assert.equal(app.engine.idle, true);
    assert.equal(calls, 3, 'No replay and no dropped queued requests');
    assert.equal((await waitForRun(person, run.id)).status, 'completed');

    assert.deepEqual(await (await person.request('/healthz')).json(), { status: 'draining', idle: true, release: 'local' });
    app.engine.resume();
    assert.equal((await person.request('/healthz')).status, 200);
    const resumed = await (await person.post('/api/runs', { evaluationIds: [cases[3].id] })).json();
    await waitForRun(person, resumed.id);
  } finally { release(); await app.engine.drain(); await close(app); }
});

test('graceful shutdown is idempotent and waits for the engine before closing SQLite', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const app = await listen(createApp({ dbPath: ':memory:', fetchImpl: async () => {
    await gate; return new Response('data: {"choices":[{"delta":{"content":"login"},"finish_reason":"stop"}]}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } }));
  const person = await client(app);
  const saved = await (await person.post('/api/evaluations', savedCase)).json();
  await person.post('/api/runs', { evaluationIds: [saved.id] });
  const shutdown = app.shutdown();
  assert.equal(app.shutdown(), shutdown);
  assert.equal((await person.post('/api/evaluations', savedCase)).status, 503);
  assert.equal(app.store.db.prepare('SELECT 1 AS n').get().n, 1);
  release(); await shutdown;
  assert.equal(app.server.listening, false);
  assert.throws(() => app.store.db.prepare('SELECT 1'));
});
