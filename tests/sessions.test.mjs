import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
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

test('GitHub login is required before private APIs can be used', async () => {
  let calls = 0;
  const app = await listen(createApp({ dbPath: ':memory:', env: { OPENAI_API_KEY: 'never-public' }, fetchImpl: async () => { calls++; return stream(); } }));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const initial = await fetch(url + '/api/session');
    assert.deepEqual(await initial.json(), { authenticated: false, loginAvailable: true });
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

test('external dashboard navigation is allowed without weakening cross-site API protection', async () => {
  const app = await listen(createApp({ dbPath: ':memory:' }));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const navigation = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  // Node fetch overwrites Sec-Fetch-Mode; use HTTP to preserve browser metadata.
  const navigate = (path, headers) => new Promise((resolve, reject) => {
    httpRequest(url + path, { headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    }).on('error', reject).end();
  });
  try {
    const response = await navigate('/', navigation);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
    for (const headers of [
      { ...navigation, 'sec-fetch-mode': 'cors' },
      { ...navigation, 'sec-fetch-dest': 'iframe' },
      { 'sec-fetch-site': 'cross-site' },
      { ...navigation, origin: 'https://attacker.example' },
    ]) assert.equal((await navigate('/', headers)).status, 403);
    const participant = await client(app);
    for (const path of ['/api/session', '/api/evaluations', '/app.js', '/healthz']) {
      const blocked = await navigate(path, { ...navigation, cookie: participant.cookie });
      assert.equal(blocked.status, 403);
      assert.deepEqual(await blocked.json(), { error: 'Cross-site requests are not allowed.' });
    }
    for (const path of ['/', '/api/session', '/api/evaluations']) {
      const blocked = await participant.request(path, { method: 'POST', headers: navigation, body: '{}' });
      assert.equal(blocked.status, 403);
    }
  } finally { await close(app); }
});

test('different accounts get opaque HttpOnly sessions and isolated personal workspaces', async () => {
  const app = await listen(createApp({ dbPath: ':memory:' }));
  try {
    const a = await client(app), b = await client(app), reload = await client(app, { cookie: a.cookie });
    assert.notEqual(a.info.workspaceId, b.info.workspaceId);
    assert.notEqual(a.cookie, b.cookie); assert.equal(a.info.workspaceId, reload.info.workspaceId);
    assert.match(a.rawCookie, /HttpOnly; SameSite=Strict; Max-Age=86400/);
    assert.match(a.cookie, /^testcraft_session=[A-Za-z0-9_-]{43}$/);
    assert.equal(a.rawCookie.includes('Secure'), false, 'HTTP is restricted to loopback development');
    const stored = app.store.db.prepare('SELECT * FROM account_sessions WHERE user_id=?').get(a.info.user.id);
    const token = a.cookie.split('=')[1];
    assert.equal(stored.token_hash, createHash('sha256').update(token).digest('hex'));
    assert.equal(JSON.stringify(stored).includes(token), false);
    assert.equal(JSON.stringify(a.info).includes(token), false);
    assert.notEqual(a.info.csrfToken, b.info.csrfToken);
    const rejoin = await a.request('/api/session');
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
    const noOriginJoin = await fetch(a.url + '/api/auth/github/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noOriginJoin.status, 403);
    assert.deepEqual((await a.get('/api/evaluations')).evaluations, []);
    assert.equal((await save(a)).name, evaluation.name);
  } finally { await close(app); }
});

test('deleting finished runs removes only their snapshots and recomputes the latest evaluation result', async () => {
  const app = await listen(createApp({ dbPath: ':memory:' }));
  try {
    const a = await client(app), saved = await save(a);
    const first = await waitForRun(a, (await start(a, [saved.id])).id);
    const second = await waitForRun(a, (await start(a, [saved.id])).id);
    assert.equal((await a.get('/api/evaluations')).evaluations[0].latest.runId, second.id);
    const response = await a.request('/api/runs/' + second.id, { method: 'DELETE' });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { deletedId: second.id });
    assert.equal((await a.request('/api/runs/' + second.id)).status, 404);
    assert.equal(app.store.db.prepare('SELECT id FROM runs WHERE id=?').get(second.id), undefined);
    assert.deepEqual((await a.get('/api/runs')).runs.map(run => run.id), [first.id]);
    assert.equal((await a.get('/api/evaluations')).evaluations[0].latest.runId, first.id);
    assert.equal((await a.request('/api/runs/' + second.id, { method: 'DELETE' })).status, 404);
    assert.equal((await a.request('/api/runs/' + first.id, { method: 'DELETE' })).status, 200);
    assert.deepEqual((await a.get('/api/runs')).runs, []);
    const remaining = (await a.get('/api/evaluations')).evaluations;
    assert.equal(remaining.length, 1); assert.equal(remaining[0].id, saved.id); assert.equal(remaining[0].latest, null);

    const rerun = await waitForRun(a, (await start(a, [saved.id])).id);
    assert.equal(rerun.items[0].score, 100, 'saved evaluations can still be run after clearing history');
  } finally { await close(app); }
});

test('run deletion enforces session, ownership, workshop, Origin and CSRF before changing data', async () => {
  const app = await listen(createApp({ dbPath: ':memory:' }));
  try {
    const a = await client(app), b = await client(app), saved = await save(a);
    const run = await waitForRun(a, (await start(a, [saved.id])).id), path = '/api/runs/' + run.id;
    assert.equal((await fetch(a.url + path, { method: 'DELETE' })).status, 401);
    assert.equal((await b.request(path, { method: 'DELETE', body: JSON.stringify({ ownerId: a.info.workspaceId, workshopId: 'workshop' }) })).status, 404);
    assert.throws(() => app.store.deleteRun(run.id, { ...a.scope, workshopId: 'another-workshop' }), error => error.status === 404);
    assert.throws(() => app.store.deleteRun(run.id), /workspace scope/);
    for (const headers of [{ 'x-csrf-token': '' }, { 'x-csrf-token': b.info.csrfToken }, { origin: '' }, { origin: 'null' }, { origin: 'https://attacker.invalid' }, { 'sec-fetch-site': 'cross-site' }]) {
      assert.equal((await a.request(path, { method: 'DELETE', headers })).status, 403);
    }
    assert.equal((await a.request(path + '?delete=true')).status, 200, 'GET never deletes a run');
    assert.equal((await a.request('/api/runs', { method: 'DELETE' })).status, 404, 'there is no bulk-reset route');
    assert.deepEqual(await a.get(path), run);
    assert.equal((await a.get('/api/runs')).runs.length, 1);
    assert.equal((await a.request(path, { method: 'DELETE' })).status, 200);
    assert.equal((await b.request(path, { method: 'DELETE' })).status, 404);
  } finally { await close(app); }
});

test('queued and running runs cannot be deleted, but become deletable after completion', async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const app = await listen(createApp({ dbPath: ':memory:', fetchImpl: async () => { calls++; await gate; return stream(); } }));
  const accepted = [];
  let a;
  try {
    a = await client(app);
    const items = await Promise.all([save(a, generated), save(a, generated), save(a, generated)]);
    const running = await start(a, items.slice(0, 2).map(item => item.id)); accepted.push(running.id);
    const queued = await start(a, [items[2].id]); accepted.push(queued.id);
    assert.equal((await a.get('/api/runs/' + running.id)).status, 'running');
    assert.equal((await a.get('/api/runs/' + queued.id)).status, 'queued');
    assert.equal(calls, 2);
    for (const id of accepted) {
      const denied = await a.request('/api/runs/' + id, { method: 'DELETE' });
      assert.equal(denied.status, 409); assert.match((await denied.json()).error, /still active/);
    }

    assert.equal((await a.get('/api/runs')).runs.length, 2);
    release(); for (const id of accepted) await waitForRun(a, id);
    for (const id of accepted) assert.equal((await a.request('/api/runs/' + id, { method: 'DELETE' })).status, 200);
    accepted.length = 0;
    assert.deepEqual((await a.get('/api/runs')).runs, []);
    assert.equal(calls, 3);
  } finally { release(); for (const id of accepted) await waitForRun(a, id); await close(app); }
});

test('run deletion survives restart and allows reruns without affecting other participants', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'testcraft-run-delete-')), dbPath = join(dir, 'evals.sqlite');
  let calls = 0, app = await listen(createApp({ dbPath, env: { WORKSHOP_MAX_MODEL_CALLS: '2' }, fetchImpl: async () => { calls++; return stream(); } }));
  try {
    const a = await client(app), b = await client(app), saved = await save(a, generated), other = await save(b);
    const ownRun = await waitForRun(a, (await start(a, [saved.id])).id);
    const otherRun = await waitForRun(b, (await start(b, [other.id])).id);
    assert.equal((await a.request('/api/runs/' + ownRun.id, { method: 'DELETE' })).status, 200);
    assert.deepEqual(await b.get('/api/runs/' + otherRun.id), otherRun);
    await close(app); app = await listen(createApp({ dbPath, env: { WORKSHOP_MAX_MODEL_CALLS: '2' } }));
    const restored = await client(app, { cookie: a.cookie });
    assert.deepEqual((await restored.get('/api/runs')).runs, []);
    assert.equal((await restored.request('/api/runs/' + ownRun.id)).status, 404);
    assert.equal((await restored.get('/api/evaluations')).evaluations[0].id, saved.id);

    await waitForRun(restored, (await start(restored, [saved.id])).id);
    const restoredB = await client(app, { cookie: b.cookie });
    assert.equal((await restoredB.get('/api/runs')).runs[0].id, otherRun.id); assert.equal(calls, 2);
  } finally { await close(app); await rm(dir, { recursive: true, force: true }); }
});

test('forged, duplicated and expired cookies cannot read another workspace; tokens in URLs are ignored', async () => {
  const app = await listen(createApp({ dbPath: ':memory:' }));
  try {
    const a = await client(app); await save(a);
    for (const cookie of ['', 'testcraft_session=forged', 'testcraft_session=' + 'a'.repeat(43), a.cookie + '; ' + a.cookie, 'testcraft_session=%ZZ']) {
      assert.equal((await a.request('/api/evaluations', { headers: { cookie } })).status, 401);
    }
    assert.equal((await fetch(a.url + '/api/evaluations?session=' + a.cookie.split('=')[1])).status, 401);
    app.store.db.prepare('UPDATE account_sessions SET expires_at=? WHERE user_id=?').run(Date.now() - 1, a.info.user.id);
    assert.equal((await a.request('/api/evaluations')).status, 401);
    const fresh = await client(app);
    assert.notEqual(fresh.info.workspaceId, a.info.workspaceId);
    assert.deepEqual((await fresh.get('/api/evaluations')).evaluations, []);
  } finally { await close(app); }
});

test('public deployment needs an explicit origin and uses Secure host-only cookies without trusting forwarded headers', async () => {
  for (const env of [{ HOST: '0.0.0.0' }, { NODE_ENV: 'production' }, { APP_ORIGIN: 'http://workshop.example' }, { APP_ORIGIN: 'https://workshop.example/path' }, { WORKSHOP_SESSION_HOURS: '0' }]) assert.throws(() => createApp({ dbPath: ':memory:', env }));
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
    const signedIn = await client(app);
    const existingCookie = signedIn.cookie;
    for (let count = 1; count < 20; count++) {
      const response = await fetch(url + '/api/auth/github/start', { method: 'POST', headers: { origin: url, 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${count}` }, body: '{}' });
      assert.equal(response.status, 200);
    }
    await close(app); app = await listen(createApp({ dbPath })); url = `http://127.0.0.1:${app.server.address().port}`;
    const response = await fetch(url + '/api/auth/github/start', { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 429);
    const existing = await client(app, { cookie: existingCookie });
    for (let count = 0; count < 3; count++) {
      const reused = await existing.request('/api/session');
      assert.equal(reused.status, 200); assert.equal(reused.headers.get('set-cookie'), null);
      assert.equal((await reused.json()).workspaceId, existing.info.workspaceId);
    }
  } finally { await close(app); await rm(dir, { recursive: true, force: true }); }
});

test('obsolete call limits do not restrict concurrent participants or reruns', async () => {
  let release, calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const app = await listen(createApp({ dbPath: ':memory:', env: { WORKSHOP_MAX_MODEL_CALLS: '0' }, fetchImpl: async () => { calls++; await gate; return stream(); } }));
  const accepted = [];
  try {
    const a = await client(app), b = await client(app);
    const ea = await save(a, generated), eb = await save(b, generated);
    const responses = await Promise.all([a.post('/api/runs', { evaluationIds: [ea.id] }), b.post('/api/runs', { evaluationIds: [eb.id] })]);
    assert.deepEqual(responses.map(r => r.status).sort(), [202, 202]);
    for (const [index, response] of responses.entries()) if (response.status === 202) accepted.push({ participant: [a, b][index], id: (await response.json()).id });
    release(); for (const run of accepted) await waitForRun(run.participant, run.id);
    assert.equal(calls, 2);

    const newBrowser = await client(app);
    assert.equal('budget' in newBrowser.info, false);
    const offline = await save(newBrowser);
    await waitForRun(newBrowser, (await start(newBrowser, [offline.id])).id);
    assert.equal(calls, 3);
  } finally { release(); for (const run of accepted) await waitForRun(run.participant, run.id); await close(app); }
});

test('failed or timed-out generation does not retry or invoke the judge', async () => {
  for (const throws of [true, false]) {
    let calls = 0;
    const app = await listen(createApp({ dbPath: ':memory:', env: { WORKSHOP_MAX_MODEL_CALLS: '2', OPENAI_API_KEY: 'test-only' }, fetchImpl: async () => { calls++; if (throws) throw new Error('Simulated timeout'); return new Response('private-provider-error', { status: 500 }); } }));
    try {
      const a = await client(app), saved = await save(a, { ...generated, method: 'model_grade', judgeModel: 'gpt-4o-mini' });
      const run = await waitForRun(a, (await start(a, [saved.id])).id);
      assert.equal(run.items[0].status, 'error'); assert.equal(run.items[0].score, null); assert.equal(calls, 1);

    } finally { await close(app); }
  }
});

test('missing model credentials prevent dispatch', async () => {
  let calls = 0;
  const app = await listen(createApp({ dbPath: ':memory:', env: { WORKSHOP_MAX_MODEL_CALLS: '2' }, fetchImpl: async () => { calls++; return Response.json({ models: [{ id: 'gpt-4o-mini', label: 'Test model' }] }); } }));
  try {
    const a = await client(app);
    for (const source of ['testcraft_api', 'llm']) {
      const saved = await save(a, { ...generated, source, model: 'gpt-4o-mini', method: 'model_grade', judgeModel: 'gpt-4o-mini' });
      const result = await waitForRun(a, (await start(a, [saved.id])).id);
      assert.equal(result.items[0].status, 'error'); assert.equal(calls, 0);

    }
    assert.ok((await a.get('/api/models')).models.length); assert.equal(calls, 0);

  } finally { await close(app); }
});

test('sessions, data and CSRF survive restart; obsolete access-code settings have no effect', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'testcraft-persist-')), dbPath = join(dir, 'evals.sqlite');
  let app = await listen(createApp({ dbPath, fetchImpl: async () => stream() }));
  try {
    const a = await client(app), saved = await save(a, generated);
    const run = await waitForRun(a, (await start(a, [saved.id])).id); assert.equal(run.items[0].status, 'passed');
    await close(app); app = await listen(createApp({ dbPath }));
    const restored = await client(app, { cookie: a.cookie });
    assert.equal(restored.info.workspaceId, a.info.workspaceId);
    assert.equal((await restored.get('/api/evaluations')).evaluations[0].id, saved.id);

    assert.equal(restored.info.csrfToken, a.info.csrfToken);
    await close(app); app = await listen(createApp({ dbPath, env: { WORKSHOP_ACCESS_CODE: 'different-test-code-2026' } }));
    const url = `http://127.0.0.1:${app.server.address().port}`;
    assert.equal((await fetch(url + '/api/evaluations', { headers: { cookie: a.cookie } })).status, 200);
    const stillOwned = await client(app, { cookie: a.cookie });
    assert.equal(stillOwned.info.csrfToken, a.info.csrfToken);
    const fresh = await client(app);
     assert.deepEqual((await fresh.get('/api/evaluations')).evaluations, []);
  } finally { await close(app); await rm(dir, { recursive: true, force: true }); }
});

test('login initiation rejects caller-chosen identifiers and cross-origin requests', async () => {
  const app = await listen(createApp({ dbPath: ':memory:' }));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  try {
    for (const body of [null, [], 'text', { code: 'obsolete-code' }, { ownerId: 'someone-else' }, { token: 'chosen-token' }]) {
      const res = await fetch(url + '/api/auth/github/start', { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(res.status, 400); assert.equal(res.headers.get('set-cookie'), null);
    }
    const crossOrigin = await fetch(url + '/api/auth/github/start', { method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(crossOrigin.status, 403);
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 0);
  } finally { await close(app); }
});

test('interrupted recovery preserves evidence without replaying requests', async () => {
  const store = new Store(':memory:');
  try {
    const run = { id: 'interrupted', status: 'running', createdAt: new Date().toISOString(), items: [{ id: 'item', evaluation: { ...generated, method: 'model_grade' }, status: 'grading', events: [], output: 'already received' }] };
    store.saveRun(run, testScope);

    store.recoverInterruptedRuns();
    assert.equal(store.run(run.id, testScope).status, 'interrupted');

    assert.deepEqual(store.deleteRun(run.id, testScope), { deletedId: run.id });
    assert.equal(store.run(run.id, testScope), undefined);

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
    assert.equal((await a.request('/api/runs/legacy-run', { method: 'DELETE' })).status, 404);
    assert.ok(app.store.db.prepare('SELECT id FROM runs WHERE id=?').get('legacy-run'));
    assert.equal(app.store.db.prepare('SELECT data FROM evaluations WHERE id=?').get('legacy').data, data);
  } finally { await close(app); await rm(dir, { recursive: true, force: true }); }
});
