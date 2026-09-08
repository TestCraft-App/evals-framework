import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createApp, listen, close, client, waitForRun, testScope } from './helpers.mjs';
import { Store } from '../src/evals/store.mjs';

const evaluation = { name: 'Private login ideas', type: 'ideas', source: 'pasted', method: 'contains', html: '<button>Login</button>', actualOutput: 'valid user; invalid password', criteria: ['valid user', 'invalid password'] };
const generated = { ...evaluation, source: 'testcraft_api', actualOutput: '' };
const stream = () => new Response('data: {"choices":[{"delta":{"content":"valid user; invalid password"},"finish_reason":"stop"}]}\n\n', { headers: { 'content-type': 'text/event-stream' } });
const save = async (participant, data = evaluation) => {
  const response = await participant.post('/api/evaluations', data);
  assert.equal(response.status, 201); return response.json();
};
const start = async (participant, ids) => {
  const response = await participant.post('/api/runs', { evaluationIds: ids });
  assert.equal(response.status, 202, await response.clone().text()); return response.json();
};

test('anonymous bootstrap needs no code, but private APIs still require the browser session', async () => {
  let calls = 0;
  const app = await listen(createApp({ dbPath: ':memory:', env: { OPENAI_API_KEY: 'never-public' }, fetchImpl: async () => { calls++; return stream(); } }));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const initial = await fetch(url + '/api/session');
    assert.deepEqual(await initial.json(), { authenticated: false, accessMode: 'anonymous' });
    assert.equal(initial.headers.get('set-cookie'), null, 'GET must not create sessions');
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
    for (const path of ['/api/config', '/api/models', '/api/evaluations', '/api/evaluations/unknown', '/api/runs', '/api/runs/unknown']) assert.equal((await fetch(url + path)).status, 401);
    const participant = await client(app);
    assert.equal(participant.info.authenticated, true); assert.ok(participant.rawCookie);
    assert.deepEqual((await participant.get('/api/evaluations')).evaluations, []);
    assert.equal(JSON.stringify(await participant.get('/api/config')).includes('never-public'), false);
    assert.equal(calls, 0); assert.equal((await fetch(url + '/')).status, 200);
  } finally { await close(app); }
});

test('each browser gets an opaque HttpOnly session, while the same cookie keeps its private workspace', async () => {
  const app = await listen(createApp({ dbPath: ':memory:' }));
  try {
    const a = await client(app), b = await client(app), reload = await client(app, { cookie: a.cookie });
    assert.notEqual(a.info.workspaceId, b.info.workspaceId);
    assert.notEqual(a.cookie, b.cookie); assert.equal(a.info.workspaceId, reload.info.workspaceId);
    assert.match(a.rawCookie, /HttpOnly; SameSite=Strict; Max-Age=86400/);
    assert.match(a.cookie, /^testcraft_session=[A-Za-z0-9_-]{43}$/);
    assert.equal(a.rawCookie.includes('Secure'), false, 'HTTP is restricted to loopback development');
    const stored = app.store.db.prepare('SELECT * FROM sessions WHERE owner_id=?').get(a.info.workspaceId);
    const token = a.cookie.split('=')[1];
    assert.equal(stored.token_hash, createHash('sha256').update(token).digest('hex'));
    assert.equal(JSON.stringify(stored).includes(token), false);
    assert.equal(JSON.stringify(a.info).includes(token), false);
    assert.notEqual(a.info.csrfToken, b.info.csrfToken);
    const rejoin = await a.post('/api/session', {});
    assert.equal((await rejoin.json()).workspaceId, a.info.workspaceId);
    assert.equal(rejoin.headers.get('set-cookie'), null);
  } finally { await close(app); }
});

test('ownership is enforced for lists, details, runs, batches, snapshots and forged client owner fields', async () => {
  const app = await listen(createApp({ dbPath: ':memory:' }));
  try {
    const a = await client(app), b = await client(app);
    const item = await save(a, { ...evaluation, ownerId: b.info.workspaceId, workshopId: 'forged', id: 'chosen-id' });
    assert.equal('ownerId' in item, false); assert.notEqual(item.id, 'chosen-id');
    assert.equal((await a.get('/api/evaluations')).evaluations.length, 1);
    assert.deepEqual((await b.get('/api/evaluations')).evaluations, []);
    assert.equal((await b.request('/api/evaluations/' + item.id)).status, 404);
    const ownB = await save(b, { ...evaluation, name: 'B only' });
    const invalidBatch = await b.post('/api/runs', { evaluationIds: [ownB.id, item.id], ownerId: a.info.workspaceId });
    assert.equal(invalidBatch.status, 404);
    assert.deepEqual((await b.get('/api/runs')).runs, []);
    assert.equal(app.store.budget('workshop', 200).reserved, 0);
    const run = await start(a, [item.id]); await waitForRun(a, run.id);
    assert.equal((await b.request('/api/runs/' + run.id)).status, 404);
    assert.deepEqual((await b.get('/api/runs')).runs, []);
    assert.equal((await a.get('/api/runs/' + run.id)).items[0].evaluation.html, evaluation.html);
    assert.equal((await b.get('/api/evaluations')).evaluations[0].latest, null);
    assert.throws(() => app.store.evaluations(), /workspace scope/);
    assert.throws(() => app.store.evaluation(item.id), /workspace scope/);
    assert.throws(() => app.store.saveRun(run, b.scope), /workspace mismatch/);
    assert.equal((await b.request('/api/runs/' + run.id)).status, 404);
  } finally { await close(app); }
});

test('all authenticated mutations require the matching Origin and CSRF token', async () => {
  const app = await listen(createApp({ dbPath: ':memory:' }));
  try {
    const a = await client(app), b = await client(app);
    for (const headers of [{ 'x-csrf-token': '' }, { 'x-csrf-token': b.info.csrfToken }, { origin: '' }, { origin: 'null' }, { origin: 'https://unrelated.invalid' }, { origin: a.url.replace('http:', 'https:') }, { 'sec-fetch-site': 'cross-site' }]) {
      const response = await a.request('/api/evaluations', { method: 'POST', headers, body: JSON.stringify(evaluation) });
      assert.equal(response.status, 403);
    }
    const noOriginJoin = await fetch(a.url + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noOriginJoin.status, 403);
    assert.deepEqual((await a.get('/api/evaluations')).evaluations, []);
    assert.equal((await save(a)).name, evaluation.name);
  } finally { await close(app); }
});

test('forged, duplicated and expired cookies cannot read another workspace; tokens in URLs are ignored', async () => {
  const app = await listen(createApp({ dbPath: ':memory:' }));
  try {
    const a = await client(app); await save(a);
    for (const cookie of ['', 'testcraft_session=forged', 'testcraft_session=' + 'a'.repeat(43), a.cookie + '; ' + a.cookie, 'testcraft_session=%ZZ']) {
      assert.equal((await a.request('/api/evaluations', { headers: { cookie } })).status, 401);
    }
    assert.equal((await fetch(a.url + '/api/evaluations?session=' + a.cookie.split('=')[1])).status, 401);
    app.store.db.prepare('UPDATE sessions SET expires_at=? WHERE owner_id=?').run(Date.now() - 1, a.info.workspaceId);
    assert.equal((await a.request('/api/evaluations')).status, 401);
    const fresh = await client(app);
    assert.notEqual(fresh.info.workspaceId, a.info.workspaceId);
    assert.deepEqual((await fresh.get('/api/evaluations')).evaluations, []);
  } finally { await close(app); }
});

test('public deployment needs an explicit origin and uses Secure host-only cookies without trusting forwarded headers', async () => {
  for (const env of [{ HOST: '0.0.0.0' }, { NODE_ENV: 'production' }, { APP_ORIGIN: 'http://workshop.example' }, { APP_ORIGIN: 'https://workshop.example/path' }, { WORKSHOP_MAX_MODEL_CALLS: '-1' }, { WORKSHOP_SESSION_HOURS: '0' }]) assert.throws(() => createApp({ dbPath: ':memory:', env }));
  const app = await listen(createApp({ dbPath: ':memory:', env: { HOST: '0.0.0.0', NODE_ENV: 'production', APP_ORIGIN: 'https://workshop.example' } }));
  try {
    const a = await client(app, { origin: 'https://workshop.example' });
    assert.match(a.rawCookie, /^__Host-testcraft_session=/); assert.match(a.rawCookie, /; Secure$/); assert.equal(a.rawCookie.includes('Domain='), false);
    assert.equal((await a.request('/api/evaluations', { method: 'POST', headers: { origin: 'https://attacker.example', 'x-forwarded-host': 'attacker.example', 'x-forwarded-proto': 'https' }, body: JSON.stringify(evaluation) })).status, 403);
  } finally { await close(app); }
});

test('new sessions are rate limited across restarts and spoofed addresses; existing sessions still work', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'testcraft-access-')), dbPath = join(dir, 'evals.sqlite');
  let app = await listen(createApp({ dbPath }));
  try {
    let url = `http://127.0.0.1:${app.server.address().port}`;
    let existingCookie;
    for (let count = 0; count < 20; count++) {
      const response = await fetch(url + '/api/session', { method: 'POST', headers: { origin: url, 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${count}` }, body: '{}' });
      assert.equal(response.status, 200); existingCookie = response.headers.get('set-cookie').split(';')[0];
    }
    await close(app); app = await listen(createApp({ dbPath })); url = `http://127.0.0.1:${app.server.address().port}`;
    const response = await fetch(url + '/api/session', { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 429);
    const existing = await client(app, { cookie: existingCookie });
    for (let count = 0; count < 3; count++) {
      const reused = await existing.post('/api/session', {});
      assert.equal(reused.status, 200); assert.equal(reused.headers.get('set-cookie'), null);
      assert.equal((await reused.json()).workspaceId, existing.info.workspaceId);
    }
  } finally { await close(app); await rm(dir, { recursive: true, force: true }); }
});

test('a shared allowance is reserved atomically across participants before any batch is dispatched', async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const app = await listen(createApp({ dbPath: ':memory:', env: { WORKSHOP_MAX_MODEL_CALLS: '1' }, fetchImpl: async () => { calls++; await gate; return stream(); } }));
  const accepted = [];
  try {
    const a = await client(app), b = await client(app);
    const ea = await save(a, generated), eb = await save(b, generated);
    const responses = await Promise.all([a.post('/api/runs', { evaluationIds: [ea.id] }), b.post('/api/runs', { evaluationIds: [eb.id] })]);
    assert.deepEqual(responses.map(r => r.status).sort(), [202, 429]);
    for (const [index, response] of responses.entries()) if (response.status === 202) accepted.push({ participant: [a, b][index], id: (await response.json()).id });
    release(); for (const run of accepted) await waitForRun(run.participant, run.id);
    assert.equal(calls, 1);
    assert.deepEqual((await a.get('/api/session')).budget, { limit: 1, used: 1, reserved: 0, remaining: 0, unit: 'model_calls' });
    assert.equal((await b.get('/api/session')).budget.remaining, 0);
    const newBrowser = await client(app); assert.equal(newBrowser.info.budget.remaining, 0);
    const offline = await save(newBrowser);
    const run = await start(newBrowser, [offline.id]); assert.equal((await waitForRun(newBrowser, run.id)).items[0].score, 100);
    assert.equal(calls, 1);
  } finally { release(); for (const run of accepted) await waitForRun(run.participant, run.id); await close(app); }
});

test('a generation plus model grade reserves two calls and never starts a partially affordable batch', async () => {
  let calls = 0;
  const app = await listen(createApp({ dbPath: ':memory:', env: { WORKSHOP_MAX_MODEL_CALLS: '1', OPENAI_API_KEY: 'test-only' }, fetchImpl: async () => { calls++; return stream(); } }));
  try {
    const a = await client(app);
    const two = await save(a, { ...generated, method: 'model_grade', judgeModel: 'gpt-4o-mini' });
    assert.equal((await a.post('/api/runs', { evaluationIds: [two.id] })).status, 429);
    const one = await save(a, generated), another = await save(a, generated);
    assert.equal((await a.post('/api/runs', { evaluationIds: [one.id, another.id] })).status, 429);
    assert.equal(calls, 0); assert.deepEqual((await a.get('/api/runs')).runs, []);
    assert.equal((await a.get('/api/session')).budget.remaining, 1);
  } finally { await close(app); }
});

test('all Rule-based methods run in private sessions with a zero model-call allowance', async () => {
  let calls = 0;
  const app = await listen(createApp({ dbPath: ':memory:', env: { WORKSHOP_MAX_MODEL_CALLS: '0' }, fetchImpl: async () => { calls++; throw new Error('No model calls expected'); } }));
  try {
    const a = await client(app);
    for (const [method, criteria] of [['contains', ['valid user']], ['exact_match', [evaluation.actualOutput]]]) {
      const saved = await save(a, { ...evaluation, method, criteria });
      const result = await waitForRun(a, (await start(a, [saved.id])).id);
      assert.equal(result.items[0].score, 100);
      assert.equal(result.items[0].evaluation.method, method);
    }
    assert.equal(calls, 0); assert.equal((await a.get('/api/session')).budget.used, 0);
    const b = await client(app); assert.deepEqual((await b.get('/api/runs')).runs, []);
  } finally { await close(app); }
});

test('failed or timed-out model attempts are charged, but unattempted grading reservations are released', async () => {
  for (const throws of [true, false]) {
    let calls = 0;
    const app = await listen(createApp({ dbPath: ':memory:', env: { WORKSHOP_MAX_MODEL_CALLS: '2', OPENAI_API_KEY: 'test-only' }, fetchImpl: async () => { calls++; if (throws) throw new Error('Simulated timeout'); return new Response('private-provider-error', { status: 500 }); } }));
    try {
      const a = await client(app), saved = await save(a, { ...generated, method: 'model_grade', judgeModel: 'gpt-4o-mini' });
      const run = await waitForRun(a, (await start(a, [saved.id])).id);
      assert.equal(run.items[0].status, 'error'); assert.equal(run.items[0].score, null); assert.equal(calls, 1);
      assert.deepEqual((await a.get('/api/session')).budget, { limit: 2, used: 1, reserved: 0, remaining: 1, unit: 'model_calls' });
    } finally { await close(app); }
  }
});

test('missing model credentials consume no calls and catalog lookups do not use the model allowance', async () => {
  let calls = 0;
  const app = await listen(createApp({ dbPath: ':memory:', env: { WORKSHOP_MAX_MODEL_CALLS: '2' }, fetchImpl: async () => { calls++; return Response.json({ models: [{ id: 'gpt-4o-mini', label: 'Test model' }] }); } }));
  try {
    const a = await client(app);
    for (const source of ['testcraft_api', 'llm']) {
      const saved = await save(a, { ...generated, source, model: 'gpt-4o-mini', method: 'model_grade', judgeModel: 'gpt-4o-mini' });
      const result = await waitForRun(a, (await start(a, [saved.id])).id);
      assert.equal(result.items[0].status, 'error'); assert.equal(calls, 0);
      assert.equal((await a.get('/api/session')).budget.remaining, 2);
    }
    await a.get('/api/models'); assert.equal(calls, 1);
    assert.equal((await a.get('/api/session')).budget.used, 0);
  } finally { await close(app); }
});

test('sessions, data, CSRF and allowance survive restart; obsolete access-code settings have no effect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'testcraft-persist-')), dbPath = join(dir, 'evals.sqlite');
  let app = await listen(createApp({ dbPath, fetchImpl: async () => stream() }));
  try {
    const a = await client(app), saved = await save(a, generated);
    const run = await waitForRun(a, (await start(a, [saved.id])).id); assert.equal(run.items[0].status, 'passed');
    await close(app); app = await listen(createApp({ dbPath }));
    const restored = await client(app, { cookie: a.cookie });
    assert.equal(restored.info.workspaceId, a.info.workspaceId);
    assert.equal((await restored.get('/api/evaluations')).evaluations[0].id, saved.id);
    assert.equal(restored.info.budget.used, 1);
    assert.equal(restored.info.csrfToken, a.info.csrfToken);
    await close(app); app = await listen(createApp({ dbPath, env: { WORKSHOP_ACCESS_CODE: 'different-test-code-2026' } }));
    const url = `http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await fetch(url + '/api/evaluations', { headers: { cookie: a.cookie } })).status, 200);
    const stillOwned = await client(app, { cookie: a.cookie });
    assert.equal(stillOwned.info.csrfToken, a.info.csrfToken);
    const fresh = await client(app);
    assert.equal(fresh.info.budget.used, 1); assert.deepEqual((await fresh.get('/api/evaluations')).evaluations, []);
  } finally { await close(app); await rm(dir, { recursive: true, force: true }); }
});

test('session creation rejects caller-chosen identifiers and cross-origin requests', async () => {
  const app = await listen(createApp({ dbPath: ':memory:' }));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  try {
    for (const body of [null, [], 'text', { code: 'obsolete-code' }, { ownerId: 'someone-else' }, { token: 'chosen-token' }]) {
      const res = await fetch(url + '/api/session', { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(res.status, 400); assert.equal(res.headers.get('set-cookie'), null);
    }
    const crossOrigin = await fetch(url + '/api/session', { method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(crossOrigin.status, 403);
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
  } finally { await close(app); }
});

test('interrupted recovery releases only unused reservations, without replaying or refunding an attempt', async () => {
  const store = new Store(':memory:');
  try {
    const run = { id: 'interrupted', status: 'running', createdAt: new Date().toISOString(), items: [{ id: 'item', evaluation: { ...generated, method: 'model_grade' }, status: 'grading', events: [], output: 'already received' }] };
    store.reserveRun(run, testScope, 2); store.consumeCall('item', 'workshop');
    assert.equal(store.budget('workshop', 2).reserved, 1);
    store.recoverInterruptedRuns();
    assert.equal(store.run(run.id, testScope).status, 'interrupted');
    assert.deepEqual(store.budget('workshop', 2), { limit: 2, used: 1, reserved: 0, remaining: 1, unit: 'model_calls' });
    assert.throws(() => store.consumeCall('item', 'workshop'), /No model-call allowance/);
  } finally { store.close(); }
});

test('the schema migration preserves unowned legacy data without giving it to the first participant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'testcraft-legacy-')), dbPath = join(dir, 'evals.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE evaluations (id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE runs (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  const data = JSON.stringify({ ...evaluation, id: 'legacy', createdAt: '2026-01-01' });
  db.prepare('INSERT INTO evaluations VALUES (?,?)').run('legacy', data);
  db.prepare('INSERT INTO runs VALUES (?,?)').run('legacy-run', JSON.stringify({ id: 'legacy-run', status: 'completed', items: [], createdAt: '2026-01-01' })); db.close();
  const app = await listen(createApp({ dbPath }));
  try {
    const a = await client(app);
    assert.deepEqual((await a.get('/api/evaluations')).evaluations, []);
    assert.deepEqual((await a.get('/api/runs')).runs, []);
    assert.equal((await a.request('/api/evaluations/legacy')).status, 404);
    assert.equal((await a.request('/api/runs/legacy-run')).status, 404);
    assert.equal(app.store.db.prepare('SELECT data FROM evaluations WHERE id=?').get('legacy').data, data);
  } finally { await close(app); await rm(dir, { recursive: true, force: true }); }
});
