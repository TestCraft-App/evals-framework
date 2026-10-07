import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp as rawApp } from '../server.mjs';
import { createApp, listen, client, waitForRun, runConfig, syntheticStream, close } from './helpers.mjs';

const definition = { name: 'Shared case', type: 'ideas', method: 'contains', html: '<button>Login</button>', criteria: ['valid user'] };
const main = '/api/workspaces/main';
const sha = value => createHash('sha256').update(value).digest('hex');
async function begin(url, headers = {}) {
  const response = await fetch(url + '/api/auth/github/start', { method: 'POST', headers: { origin: url, 'content-type': 'application/json', ...headers }, body: '{}' });
  const authorization = new URL((await response.json()).authorizeUrl);
  return { authorization, cookie: response.headers.get('set-cookie').split(';')[0] };
}
const callback = (url, login, extra = {}) => fetch(url + '/api/auth/github/callback?' + new URLSearchParams({ state: login.authorization.searchParams.get('state'), code: '1', ...extra }), { headers: { cookie: login.cookie }, redirect: 'manual' });

test('returning GitHub identity retains private data across sessions, expiry and logout', async () => {
  const app = await listen(createApp({ dbPath: ':memory:', env: { ADMIN_GITHUB_IDS: '1' } }));
  try {
    const first = await client(app, { githubId: 1001 });
    const saved = await (await first.post('/api/evaluations', definition)).json();
    const second = await client(app, { githubId: 1001 });
    assert.equal(second.info.workspaceId, first.info.workspaceId);
    assert.notEqual(first.cookie, second.cookie);
    assert.equal(second.info.user.role, 'collaborator');
    assert.equal((await second.get('/api/evaluations')).evaluations[0].id, saved.id);
    assert.equal((await first.post('/api/auth/logout', {})).status, 200);
    assert.equal((await first.request('/api/evaluations')).status, 401);
    assert.equal((await second.request('/api/evaluations')).status, 200);
    app.store.db.prepare('UPDATE account_sessions SET expires_at=0 WHERE user_id=?').run(second.info.user.id);
    assert.equal((await second.request('/api/evaluations')).status, 401);
    const returned = await client(app, { githubId: 1001 });
    assert.equal(returned.info.workspaceId, first.info.workspaceId);
    assert.equal((await returned.get('/api/evaluations')).evaluations[0].id, saved.id);
    assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  } finally { await close(app); }
});

test('OAuth expiry rejects the callback and successful re-login rotates the starting session', async t => {
  const app = await listen(createApp({ dbPath: ':memory:' }));
  try {
    const person = await client(app, { githubId: 1 });
    const expired = await begin(person.url);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.mock.timers.tick(600001);
    assert.equal((await callback(person.url, expired)).headers.get('location'), '/?login=failed');
    t.mock.timers.reset();
    const login = await begin(person.url, { cookie: person.cookie });
    assert.equal((await callback(person.url, login)).headers.get('location'), '/');
    assert.equal((await person.request('/api/evaluations')).status, 401);
  } finally { t.mock.timers.reset(); await close(app); }
});

test('OAuth uses browser binding and PKCE, consumes state once, and safely handles denial and provider failures', async () => {
  let verifier, profileCalls = 0;
  const app = await listen(rawApp({ dbPath: ':memory:', env: { GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret' }, fetchImpl: async (url, init) => {
    if (url.endsWith('/access_token')) { verifier = new URLSearchParams(init.body).get('code_verifier'); return Response.json({ access_token: 'private-token' }); }
    profileCalls++; return Response.json({ id: 9, login: 'example', name: '<script>name</script>' });
  } }));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const login = await begin(url);
    assert.equal(login.authorization.searchParams.get('scope'), '');
    assert.equal(login.authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(login.authorization.searchParams.get('redirect_uri'), url + '/api/auth/github/callback');
    const response = await callback(url, login);
    assert.equal(response.headers.get('location'), '/');
    assert.equal(createHash('sha256').update(verifier).digest('base64url'), login.authorization.searchParams.get('code_challenge'));
    assert.equal((await callback(url, login)).headers.get('location'), '/?login=failed');
    const other = await begin(url);
    assert.equal((await callback(url, { ...other, cookie: 'testcraft_oauth=wrong' })).headers.get('location'), '/?login=failed');
    assert.equal((await callback(url, await begin(url), { error: 'access_denied' })).headers.get('location'), '/?login=failed');
    assert.equal(profileCalls, 1);
    const serialized = JSON.stringify(app.store.db.prepare('SELECT * FROM users').all());
    assert.equal(serialized.includes('private-token'), false);
    assert.equal((await fetch(url + '/api/session', { method: 'POST', headers: { origin: url, 'content-type': 'application/json' }, body: '{}' })).status, 401);
  } finally { await close(app); }
  const missing = await listen(rawApp({ dbPath: ':memory:', env: {}, fetchImpl: () => assert.fail('No provider calls') }));
  try {
    const base = `http://127.0.0.1:${missing.server.address().port}`;
    assert.deepEqual(await (await fetch(base + '/api/session')).json(), { authenticated: false, loginAvailable: false });
    assert.equal((await fetch(base + '/api/auth/github/start', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' })).status, 503);
  } finally { await close(missing); }
  const failing = await listen(rawApp({ dbPath: ':memory:', env: { GITHUB_CLIENT_ID: 'client', GITHUB_CLIENT_SECRET: 'secret' }, fetchImpl: async () => { throw new Error('private-token'); } }));
  try {
    const base = `http://127.0.0.1:${failing.server.address().port}`, response = await callback(base, await begin(base));
    assert.equal(response.headers.get('location'), '/?login=failed');
    assert.equal((await response.text()).includes('private-token'), false);
  } finally { await close(failing); }
});

test('workspace permissions cover every mutation and never grant admins access to other personal spaces', async () => {
  const app = await listen(createApp({ dbPath: ':memory:', env: { ADMIN_GITHUB_IDS: '1' } }));
  try {
    const admin = await client(app, { githubId: 1 }), collaborator = await client(app, { githubId: 1001 });
    const suite = await (await admin.post(main + '/suites', { name: 'Official' })).json();
    const evaluation = await (await admin.post(main + '/evaluations', { ...definition, suiteId: suite.id })).json();
    assert.equal((await collaborator.get(main + '/evaluations')).evaluations[0].id, evaluation.id);
    for (const [method, path, body] of [
      ['POST', '/evaluations', definition], ['PUT', '/evaluations/' + evaluation.id, { ...evaluation, revision: 1 }],
      ['PATCH', '/evaluations/' + evaluation.id, { name: 'changed', revision: 1 }], ['DELETE', '/evaluations/' + evaluation.id, {}],
      ['DELETE', '/evaluations', { evaluationIds: [evaluation.id] }],
      ['POST', '/evaluations/' + evaluation.id + '/duplicate', {}], ['POST', '/suites', { name: 'blocked' }],
      ['PUT', '/suites/' + suite.id, { name: 'changed', revision: 1 }], ['DELETE', '/suites/' + suite.id, {}],
      ['POST', '/workshop-suite', {}], ['POST', '/basic-workshop-suite', {}], ['DELETE', '/workspace', {}], ['DELETE', '/runs/unknown', {}],
    ]) assert.equal((await collaborator.request(main + path, { method, body: JSON.stringify(body) })).status, 403, method + path);
    const own = await (await collaborator.post('/api/evaluations', { ...definition, ownerId: admin.scope.ownerId })).json();
    assert.equal((await admin.request('/api/evaluations/' + own.id)).status, 404);
    assert.equal((await admin.request('/api/workspaces/' + collaborator.scope.ownerId + '/evaluations')).status, 404);
    assert.equal((await collaborator.post('/api/evaluations', { ...definition, suiteId: suite.id })).status, 404);
    assert.equal((await collaborator.post(main + '/runs', { ...runConfig, evaluationIds: [evaluation.id] })).status, 400);
    assert.equal((await collaborator.post(main + '/runs', { ...runConfig, evaluationIds: [own.id], openAiApiKey: 'personal' })).status, 404);
  } finally { await app.shutdown(); }
});

test('loading TestCraft copies current suites and unfiled definitions privately without history or provider calls', async () => {
  const app = await listen(createApp({ dbPath: ':memory:', env: { ADMIN_GITHUB_IDS: '1' }, fetchImpl: async () => { throw new Error('Import must not call providers.'); } }));
  try {
    const admin = await client(app, { githubId: 1 }), collaborator = await client(app, { githubId: 1001 }), other = await client(app, { githubId: 1002 });
    const suite = await (await admin.post(main + '/suites', { name: 'Current published suite' })).json();
    const empty = await (await admin.post(main + '/suites', { name: 'Empty published suite' })).json();
    const source = await (await admin.post(main + '/evaluations', { ...definition, name: 'Current published case', suiteId: suite.id })).json();
    const unfiled = await (await admin.post(main + '/evaluations', { ...definition, name: 'Unfiled published case' })).json();
    const mainScope = { ownerId: app.store.db.prepare("SELECT id FROM workspaces WHERE kind='main'").get().id, workshopId: 'workshop' };
    app.store.saveRun({ id: 'official-history', status: 'completed', createdAt: '2025-01-01T00:00:00Z', items: [{ evaluationId: source.id, evaluation: source, status: 'passed', score: 1, events: [] }] }, mainScope);
    const mainBefore = app.store.workspaceSummary(mainScope);
    const own = await (await collaborator.post('/api/evaluations', { ...definition, name: 'Private original' })).json();
    for (const user of [admin, collaborator]) {
      const response = await user.post('/api/workspaces/personal/testcraft-suite', {});
      assert.equal(response.status, 201);
      const imported = await response.json();
      assert.equal(imported.suites.length, 2);
      assert.equal(imported.evaluations.length, 2);
      const copy = imported.evaluations.find(item => item.sourceEvaluationId === source.id);
      const copiedSuite = imported.suites.find(item => item.sourceSuiteId === suite.id);
      assert.notEqual(copy.id, source.id);
      assert.notEqual(copiedSuite.id, suite.id);
      assert.equal(copy.suiteId, copiedSuite.id);
      assert.equal(copy.name, source.name);
      assert.equal(copy.revision, 1);
      assert.deepEqual(copy.criteria, source.criteria);
      assert.equal(imported.evaluations.find(item => item.sourceEvaluationId === unfiled.id).suiteId, '');
      assert.ok(imported.suites.some(item => item.sourceSuiteId === empty.id));
      assert.deepEqual((await user.get('/api/runs')).runs, []);
      assert.equal((await user.request(main + '/evaluations/' + copy.id)).status, 404);
    }
    assert.deepEqual(app.store.workspaceSummary(mainScope), mainBefore);
    assert.equal((await collaborator.get('/api/evaluations')).evaluations.find(item => item.id === own.id).name, own.name);
    assert.deepEqual((await other.get('/api/evaluations')).evaluations, []);
    assert.deepEqual((await other.get('/api/suites')).suites, []);
  } finally { await app.shutdown(); }
});

test('TestCraft reloads preserve private edits, add published cases, and restore deleted copies', async () => {
  const app = await listen(createApp({ dbPath: ':memory:', env: { ADMIN_GITHUB_IDS: '1' } }));
  try {
    const admin = await client(app, { githubId: 1 }), user = await client(app, { githubId: 1001 });
    const suite = await (await admin.post(main + '/suites', { name: 'Published' })).json();
    const source = await (await admin.post(main + '/evaluations', { ...definition, suiteId: suite.id })).json();
    const first = await (await user.post('/api/testcraft-suite', {})).json();
    const copy = first.evaluations[0], copiedSuite = first.suites[0];
    const edited = await (await user.request('/api/evaluations/' + copy.id, { method: 'PUT', body: JSON.stringify({ ...copy, name: 'Private edit' }) })).json();
    assert.equal(edited.name, 'Private edit');
    assert.equal((await user.request('/api/suites/' + copiedSuite.id, { method: 'PUT', body: JSON.stringify({ name: 'Private suite', revision: 1 }) })).status, 200);
    assert.equal((await admin.request(main + '/evaluations/' + source.id, { method: 'PUT', body: JSON.stringify({ ...source, name: 'Updated published case' }) })).status, 200);
    const repeat = await user.post('/api/testcraft-suite', {});
    assert.equal(repeat.status, 200);
    assert.deepEqual((await repeat.json()).evaluations, [edited]);
    assert.equal((await user.get('/api/suites')).suites[0].name, 'Private suite');
    const duplicate = await (await user.post('/api/evaluations/' + copy.id + '/duplicate', { name: 'Private variant' })).json();
    assert.equal(duplicate.sourceEvaluationId, undefined);
    const newCase = await (await admin.post(main + '/evaluations', { ...definition, name: 'New published case', suiteId: suite.id })).json();
    assert.equal((await user.post('/api/testcraft-suite', {})).status, 201);
    const cases = (await user.get('/api/evaluations')).evaluations;
    assert.equal(cases.length, 3);
    assert.equal(cases.find(item => item.sourceEvaluationId === newCase.id).suiteId, copiedSuite.id);
    assert.equal((await user.request('/api/evaluations/' + copy.id, { method: 'DELETE' })).status, 200);
    const restored = (await (await user.post('/api/testcraft-suite', {})).json()).evaluations.find(item => item.sourceEvaluationId === source.id);
    assert.equal(restored.name, 'Updated published case');
    assert.notEqual(restored.id, copy.id);
    assert.notEqual(restored.reference, copy.reference);
    assert.equal((await user.get('/api/evaluations')).evaluations.length, 3);
  } finally { await app.shutdown(); }
});

test('TestCraft loading rejects empty sources, caller scopes, shared targets and invalid CSRF/origins', async () => {
  const app = await listen(createApp({ dbPath: ':memory:', env: { ADMIN_GITHUB_IDS: '1' } }));
  try {
    const admin = await client(app, { githubId: 1 }), user = await client(app, { githubId: 1001 });
    const empty = await user.post('/api/testcraft-suite', {});
    assert.equal(empty.status, 409);
    assert.deepEqual(await empty.json(), { error: 'The TestCraft workspace has no suites or evaluations to load.' });
    for (const body of [null, [], { ownerId: admin.scope.ownerId }, { workshopId: 'another' }, { sourceWorkspace: 'personal' }]) assert.equal((await user.post('/api/testcraft-suite', body)).status, 400);
    assert.equal((await admin.post(main + '/testcraft-suite', {})).status, 400);
    assert.equal((await user.post(main + '/testcraft-suite', {})).status, 403);
    assert.equal((await user.request('/api/workspaces/' + admin.scope.ownerId + '/testcraft-suite', { method: 'POST', body: '{}' })).status, 404);
    for (const headers of [{ 'x-csrf-token': '' }, { 'x-csrf-token': admin.info.csrfToken }, { origin: 'https://untrusted.example' }]) {
      assert.equal((await user.request('/api/testcraft-suite', { method: 'POST', body: '{}', headers })).status, 403);
    }
    assert.equal((await fetch(user.url + '/api/testcraft-suite', { method: 'POST', headers: { origin: user.url, 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.deepEqual((await user.get('/api/evaluations')).evaluations, []);
    assert.deepEqual((await user.get('/api/suites')).suites, []);
  } finally { await app.shutdown(); }
});

test('private main-suite runs retain source evidence and isolate concurrent generation and grading keys', async () => {
  const calls = [];
  const app = await listen(createApp({ dbPath: ':memory:', env: { ADMIN_GITHUB_IDS: '1', OPENAI_API_KEY: 'admin-judge', TESTCRAFT_OPENAI_API_KEY: 'admin-generation' }, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body, authorization: init.headers.authorization || init.headers.Authorization });
    if (!url.includes('chat/completions')) return syntheticStream();
    const context = JSON.parse(body.messages.find(message => message.role === 'user').content);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ checks: context.criteria.map(c => ({ id: c.id, passed: false, evidence: 'valid user', reason: 'Synthetic verdict' })) }) } }] });
  } }));
  try {
    const admin = await client(app, { githubId: 1 }), a = await client(app, { githubId: 1001 }), b = await client(app, { githubId: 1002 });
    const evaluation = await (await admin.post(main + '/evaluations', { ...definition, method: 'model_grade' })).json();
    const personal = await (await a.post('/api/evaluations', definition)).json();
    assert.equal(evaluation.reference, personal.reference);
    const responses = await Promise.all([a.post(main + '/runs', { ...runConfig, evaluationIds: [evaluation.id], openAiApiKey: 'key-a' }), b.post(main + '/runs', { ...runConfig, evaluationIds: [evaluation.id], openAiApiKey: 'key-b' }), admin.post(main + '/runs', { ...runConfig, evaluationIds: [evaluation.id], openAiApiKey: 'ignored' })]);
    assert.deepEqual(responses.map(r => r.status), [202, 202, 202]);
    const [ra, rb, official] = await Promise.all(responses.map(r => r.json()));
    const completed = await Promise.all([waitForRun(a, ra.id), waitForRun(b, rb.id), waitForRun({ get: path => admin.get(main + path.slice(4)) }, official.id)]);
    assert.ok(completed.every(run => run.items[0].status !== 'error'));
    assert.deepEqual(calls.filter(c => !c.url.includes('chat/completions')).map(c => c.body.openAiApiKey).sort(), ['admin-generation', 'key-a', 'key-b']);
    assert.deepEqual(calls.filter(c => c.url.includes('chat/completions')).map(c => c.authorization).sort(), ['Bearer admin-judge', 'Bearer key-a', 'Bearer key-b']);
    assert.equal((await a.request('/api/runs/' + rb.id)).status, 404);
    assert.equal((await admin.request('/api/runs/' + ra.id)).status, 404);
    assert.equal((await a.get(main + '/runs')).runs.length, 1);
    assert.equal((await a.get(main + '/runs')).runs[0].canDelete, false);
    assert.equal((await a.get(main + '/evaluations')).evaluations[0].latest.runId, official.id);
    assert.equal((await a.get('/api/evaluations')).evaluations[0].latest, null);
    assert.equal(completed[0].sourceWorkspace.name, 'TestCraft');
    assert.equal(completed[0].resultWorkspace.alias, 'personal');
    assert.equal(completed[0].createdBy.id, a.info.user.id);
    assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM evaluation_references WHERE owner_id=?').get(a.scope.ownerId).n, 1);
    const evidence = JSON.stringify(completed[0]);
    await admin.request(main + '/evaluations/' + evaluation.id, { method: 'DELETE' });
    assert.equal(JSON.stringify(await a.get('/api/runs/' + ra.id)), evidence);
    const persisted = JSON.stringify(app.store.db.prepare('SELECT data FROM runs').all());
    for (const secret of ['key-a', 'key-b', 'admin-judge', 'admin-generation', 'ignored']) assert.equal(persisted.includes(secret), false);
    assert.equal(app.engine.env.OPENAI_API_KEY, 'admin-judge');
  } finally { await app.shutdown(); }
});

test('restart updates admin roles, preserves source snapshots and leaves anonymous scopes archived', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'testcraft-accounts-')), dbPath = join(dir, 'db.sqlite');
  let app = await listen(createApp({ dbPath, env: { ADMIN_GITHUB_IDS: '1' } }));
  try {
    const admin = await client(app, { githubId: 1 });
    const person = await client(app, { githubId: 1001 });
    const shared = await (await admin.post(main + '/evaluations', definition)).json();
    const run = await (await person.post(main + '/runs', { ...runConfig, evaluationIds: [shared.id], openAiApiKey: 'ephemeral-key' })).json();
    const snapshot = await waitForRun(person, run.id);
    assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM evaluation_references WHERE owner_id=?').get(person.scope.ownerId).n, 0);
    await admin.request(main + '/evaluations/' + shared.id, { method: 'DELETE' });
    const legacy = app.store.create(definition, { ownerId: 'old-owner', workshopId: 'workshop' });
    app.store.db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?)').run(sha('a'.repeat(43)), 'old-owner', 'workshop', 'anonymous-v1', Date.now() + 60000);
    const pending = await begin(admin.url);
    await close(app);
    app = await listen(createApp({ dbPath, env: { ADMIN_GITHUB_IDS: '1001' } }));
    const oldAdmin = await client(app, { cookie: admin.cookie });
    assert.equal(oldAdmin.info.user.role, 'collaborator');
    assert.equal((await oldAdmin.post(main + '/evaluations', definition)).status, 403);
    assert.equal((await client(app, { githubId: 1001 })).info.user.role, 'admin');
    const restored = await client(app, { cookie: person.cookie });
    assert.deepEqual(await restored.get('/api/runs/' + run.id), snapshot);
    assert.equal(app.store.db.prepare('SELECT count(*) AS n FROM evaluation_references WHERE owner_id=?').get(person.scope.ownerId).n, 0);
    assert.equal((await callback(oldAdmin.url, pending)).headers.get('location'), '/?login=failed');
    assert.equal((await fetch(oldAdmin.url + '/api/evaluations', { headers: { cookie: 'testcraft_session=' + 'a'.repeat(43) } })).status, 401);
    assert.deepEqual((await oldAdmin.get('/api/evaluations')).evaluations, []);
    assert.deepEqual((await oldAdmin.get(main + '/evaluations')).evaluations, []);
    assert.equal(app.store.evaluation(legacy.id, { ownerId: 'old-owner', workshopId: 'workshop' }).name, definition.name);
  } finally { await close(app); await rm(dir, { recursive: true, force: true }); }
});
