import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, listen, client, runConfig, syntheticStream, catalogResponse } from './helpers.mjs';

const base = '/api/evaluation-requests', main = '/api/workspaces/main';
const definition = { name: 'Contribution', type: 'ideas', method: 'contains', html: '<button>Login</button>', criteria: [{ method: 'contains', text: 'valid', weight: 1 }] };
async function data(response, status = 200) { assert.equal(response.status, status, await response.clone().text()); return response.json(); }
async function setup(options = {}) {
  const app = await listen(createApp({ dbPath: ':memory:', ...options }));
  const admin = await client(app, { githubId: 1 }), person = await client(app, { githubId: 1001 }), other = await client(app, { githubId: 1002 });
  const evaluation = await data(await person.post('/api/evaluations', definition), 201);
  return { app, admin, person, other, evaluation };
}
const submit = (person, ids, description = 'Please include these cases.') => person.post(base, { evaluationIds: ids, description }).then(response => data(response, 201));
const review = (admin, request, action, comment) => admin.post(base + '/' + request.id + '/review', { version: request.version, action, ...(comment ? { comment } : {}) });

test('requests isolate accounts, validate submissions, and preserve session and origin checks', async () => {
  const { app, admin, person, other, evaluation } = await setup();
  try {
    for (const body of [null, [], {}, { evaluationIds: [], description: 'x' }, { evaluationIds: [evaluation.id, evaluation.id], description: 'x' }, { evaluationIds: [evaluation.id], description: ' ' }, { evaluationIds: [evaluation.id], description: 'x'.repeat(2001) }, { evaluationIds: [evaluation.id], description: 'x', ownerId: person.scope.ownerId }]) assert.equal((await person.post(base, body)).status, 400);
    assert.equal((await other.post(base, { evaluationIds: [evaluation.id], description: 'x' })).status, 404);
    assert.equal((await admin.post(base, { evaluationIds: [evaluation.id], description: 'x' })).status, 403);
    for (const headers of [{ origin: 'https://evil.invalid' }, { 'x-csrf-token': '' }, { 'x-csrf-token': admin.info.csrfToken }]) assert.equal((await person.request(base, { method: 'POST', headers, body: JSON.stringify({ evaluationIds: [evaluation.id], description: 'x' }) })).status, 403);
    const request = await submit(person, [evaluation.id]);
    assert.equal((await person.get(base)).requests.length, 1);
    assert.equal((await admin.get(base)).requests.length, 1);
    assert.deepEqual((await other.get(base)).requests, []);
    assert.equal((await other.request(base + '/' + request.id)).status, 404);
    assert.equal((await review(person, request, 'approve')).status, 403);
    assert.equal((await admin.request('/api/evaluations/' + evaluation.id)).status, 404);
    assert.equal((await admin.request('/api/workspaces/' + person.scope.ownerId + '/evaluations')).status, 404);
    assert.equal((await fetch(person.url + base)).status, 401);
    assert.equal((await admin.get(base + '/summary')).count, 1);
  } finally { await app.shutdown(); }
});

test('resubmission preserves snapshots/history, supports changed sets, and acknowledges only displayed feedback', async () => {
  const { app, admin, person, evaluation } = await setup();
  try {
    let request = await submit(person, [evaluation.id]);
    assert.equal((await review(admin, request, 'request_changes')).status, 400);
    request = await data(await review(admin, request, 'request_changes', 'Improve the coverage.'));
    assert.equal((await person.get(base + '/summary')).count, 1);
    assert.equal((await admin.get(base + '/summary')).count, 0);
    assert.equal((await review(admin, request, 'approve')).status, 409);
    const replacement = await data(await person.post('/api/evaluations', { ...definition, name: 'Revised' }), 201);
    await person.request('/api/evaluations/' + evaluation.id, { method: 'DELETE' });
    assert.equal((await person.post(base + '/' + request.id + '/resubmit', { version: request.version, evaluationIds: [evaluation.id], description: 'Revision' })).status, 404);
    const next = await data(await person.post(base + '/' + request.id + '/resubmit', { version: request.version, evaluationIds: [replacement.id], description: 'Revision' }));
    assert.equal(next.submissions.length, 2); assert.equal(next.submissions[0].evaluations[0].evaluation.name, 'Contribution');
    assert.equal(next.submissions[1].evaluations[0].evaluation.name, 'Revised');
    assert.equal((await review(admin, request, 'reject', 'Stale')).status, 409);
    const rejected = await data(await review(admin, next, 'reject', 'Not suitable.'));
    assert.equal(rejected.status, 'rejected');
    await data(await person.post(base + '/' + request.id + '/read', { version: request.feedbackVersion }));
    assert.equal((await person.get(base + '/summary')).count, 1);
    await data(await person.post(base + '/' + request.id + '/read', { version: rejected.feedbackVersion }));
    assert.equal((await person.get(base + '/summary')).count, 0);
    assert.equal((await person.post(base + '/' + request.id + '/read', { version: 999 })).status, 400);
    assert.equal((await person.post(base + '/' + request.id + '/resubmit', { version: rejected.version, evaluationIds: [replacement.id], description: 'Again' })).status, 409);
    assert.deepEqual(rejected.events.map(event => event.action), ['submitted', 'request_changes', 'resubmitted', 'reject']);
  } finally { await app.shutdown(); }
});

test('approval copies submitted definitions atomically, preserves groups, and serializes concurrent reviews', async () => {
  const { app, admin, person, evaluation } = await setup();
  try {
    const sourceSuite = await data(await person.post('/api/suites', { name: 'My grouping' }), 201);
    const grouped = await data(await person.post('/api/evaluations', { ...definition, suiteId: sourceSuite.id }), 201);
    const request = await submit(person, [evaluation.id, grouped.id]);
    await person.request('/api/evaluations/' + grouped.id, { method: 'PUT', body: JSON.stringify({ ...grouped, name: 'Unsubmitted edit' }) });
    await person.request('/api/evaluations/' + evaluation.id, { method: 'DELETE' });
    const responses = await Promise.all([review(admin, request, 'approve'), review(admin, request, 'approve')]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    const shared = (await admin.get(main + '/evaluations')).evaluations;
    assert.equal(shared.length, 2); assert.ok(shared.every(e => e.name === 'Contribution' && e.revision === 1));
    assert.ok(shared.every(e => ![evaluation.id, grouped.id].includes(e.id)));
    assert.equal(new Set(shared.map(e => e.reference)).size, 2);
    assert.equal((await person.get('/api/evaluations')).evaluations[0].name, 'Unsubmitted edit');
    const sharedSuite = (await admin.get(main + '/suites')).suites[0];
    assert.equal(sharedSuite.name, sourceSuite.name);
    const another = await submit(person, [grouped.id]);
    await data(await review(admin, another, 'approve'));
    assert.equal((await admin.get(main + '/suites')).suites.length, 1);
    assert.equal((await admin.get(main + '/evaluations')).evaluations.length, 3);
    assert.equal((await person.get(base + '/' + request.id)).approvedEvaluations.length, 2);
    const failed = await submit(person, [grouped.id, (await data(await person.post('/api/evaluations', definition), 201)).id]);
    const insert = app.store.insertContribution.bind(app.store); let count = 0;
    app.store.insertContribution = (...args) => { if (++count === 2) throw new Error('Synthetic private database detail'); return insert(...args); };
    const response = await review(admin, failed, 'approve'); assert.equal(response.status, 500);
    assert.equal((await response.json()).error, 'Unexpected server error.');
    assert.equal((await admin.get(main + '/evaluations')).evaluations.length, 3);
    assert.equal((await admin.get(base + '/' + failed.id)).status, 'pending');
  } finally { await app.shutdown(); }
});

test('suite mapping reuses imported originals, keeps same-name personal groups separate, and recreates deleted destinations', async () => {
  const { app, admin, person } = await setup();
  try {
    const suite = await data(await admin.post(main + '/suites', { name: 'Shared' }), 201);
    await data(await admin.post(main + '/evaluations', { ...definition, suiteId: suite.id }), 201);
    const imported = await data(await person.post('/api/testcraft-suite', {}), 201);
    const request = await submit(person, [imported.evaluations[0].id]); await data(await review(admin, request, 'approve'));
    assert.equal((await admin.get(main + '/suites')).suites.length, 1);
    const ownSuite = await data(await person.post('/api/suites', { name: 'Shared' }), 201);
    const own = await data(await person.post('/api/evaluations', { ...definition, suiteId: ownSuite.id }), 201);
    await data(await review(admin, await submit(person, [own.id]), 'approve'));
    assert.equal((await admin.get(main + '/suites')).suites.length, 2);
    const summary = await admin.get(main + '/workspace');
    await data(await admin.request(main + '/workspace', { method: 'DELETE', body: JSON.stringify({ revision: summary.revision }) }));
    await data(await review(admin, await submit(person, [own.id]), 'approve'));
    assert.equal((await admin.get(main + '/suites')).suites.length, 1);
    assert.equal((await person.get(base + '/' + request.id)).status, 'approved');
  } finally { await app.shutdown(); }
});

test('review runs use immutable snapshots, separate credentials and admin-only storage without gating approval', async () => {
  const calls = [];
  const { app, admin, person, other, evaluation } = await setup({ env: { OPENAI_API_KEY: 'judge-secret', TESTCRAFT_OPENAI_API_KEY: 'generator-secret' }, fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return syntheticStream(); } });
  try {
    const secondAdmin = await client(app, { githubId: 2 });
    const request = await submit(person, [evaluation.id]);
    await person.request('/api/evaluations/' + evaluation.id, { method: 'DELETE' });
    const runPath = base + '/' + request.id + '/runs';
    const body = { ...runConfig, evaluationIds: [evaluation.id], version: request.version, submission: request.submission };
    for (const user of [person, other]) { assert.equal((await user.get(runPath)).error, 'Administrator access is required.'); assert.equal((await user.post(runPath, body)).status, 403); }
    assert.equal((await admin.post(runPath, { ...body, openAiApiKey: 'injected' })).status, 400);
    const run = await data(await admin.post(runPath, body), 202);
    await app.engine.drain();
    const done = await admin.get(runPath + '/' + run.id);
    assert.equal(done.status, 'completed'); assert.equal(done.items[0].evaluation.name, 'Contribution');
    assert.equal(calls.length, 1); assert.equal(calls[0].body.openAiApiKey, 'generator-secret');
    assert.equal(JSON.stringify(done).includes('secret'), false);
    assert.equal((await secondAdmin.get(runPath + '/' + run.id)).id, run.id);
    for (const user of [person, other]) for (const method of ['GET', 'DELETE']) assert.equal((await user.request(runPath + '/' + run.id, { method })).status, 403);
    assert.equal((await admin.get('/api/runs')).runs.length, 0); assert.equal((await person.get(main + '/runs')).runs.length, 0);
    assert.equal((await person.request(main + '/runs/' + run.id)).status, 404);
    await data(await review(admin, request, 'approve'));
    assert.equal((await admin.post(runPath, body)).status, 409);
    await data(await admin.request(runPath + '/' + run.id, { method: 'DELETE' }));
    assert.equal((await admin.get(runPath)).runs.length, 0);
  } finally { await app.shutdown(); }
});

test('review run creation rejects a decision made during asynchronous model loading', async () => {
  let entered, release;
  const loading = new Promise(resolve => { entered = resolve; }), catalog = new Promise(resolve => { release = resolve; });
  const { createOAuthApp } = await import('./helpers.mjs');
  const race = await listen(createOAuthApp({ dbPath: ':memory:', fetchImpl: async url => { if (url.endsWith('/api/models')) { entered(); await catalog; return catalogResponse(); } throw new Error('Unexpected provider call'); } }));
  try {
    const admin = await client(race, { githubId: 1 }), person = await client(race, { githubId: 1001 });
    const evaluation = await data(await person.post('/api/evaluations', definition), 201), request = await submit(person, [evaluation.id]);
    const pending = admin.post(base + '/' + request.id + '/runs', { ...runConfig, version: request.version, submission: 1, evaluationIds: [evaluation.id] });
    await loading; await data(await review(admin, request, 'request_changes', 'Revise')); release();
    assert.equal((await pending).status, 409);
    assert.equal((await admin.get(base + '/' + request.id + '/runs')).runs.length, 0);
  } finally { release(); await race.shutdown(); }
});

test('active review runs retain their version through resubmission and separate judge-only context and credentials', async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), generation = new Promise(resolve => { release = resolve; });
  const calls = [];
  const { app, admin, person, evaluation } = await setup({ env: { OPENAI_API_KEY: 'review-judge', TESTCRAFT_OPENAI_API_KEY: 'review-generator' }, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body, authorization: init.headers.authorization });
    if (url.endsWith('/chat/completions')) {
      const context = JSON.parse(body.messages.find(message => message.role === 'user').content);
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ checks: context.criteria.map(c => ({ id: c.id, passed: true, evidence: 'valid credentials', reason: 'Synthetic matching output.' })) }) } }] });
    }
    entered(); await generation; return syntheticStream('valid credentials');
  } });
  try {
    const saved = await data(await person.request('/api/evaluations/' + evaluation.id, { method: 'PUT', body: JSON.stringify({ ...evaluation, method: 'model_grade', criteria: [{ method: 'model_grade', text: 'Judge-only secret criterion', weight: 1 }] }) }));
    const request = await submit(person, [saved.id]), runs = base + '/' + request.id + '/runs';
    const run = await data(await admin.post(runs, { ...runConfig, version: 1, submission: 1, evaluationIds: [saved.id] }), 202);
    await started;
    assert.equal((await admin.request(runs + '/' + run.id, { method: 'DELETE' })).status, 409);
    const changes = await data(await review(admin, request, 'request_changes', 'Improve it'));
    await data(await person.request('/api/evaluations/' + saved.id, { method: 'PUT', body: JSON.stringify({ ...saved, html: '<form>New private revision</form>' }) }));
    await data(await person.post(base + '/' + request.id + '/resubmit', { version: changes.version, evaluationIds: [saved.id], description: 'New submission' }));
    release(); await app.engine.drain();
    const result = await admin.get(runs + '/' + run.id);
    assert.equal(result.status, 'completed'); assert.equal(result.request.submission, 1); assert.equal(result.items[0].evaluation.html, saved.html);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.openAiApiKey, 'review-generator');
    assert.equal(JSON.stringify(calls[0]).includes('Judge-only secret criterion'), false);
    assert.equal(calls[1].authorization, 'Bearer review-judge');
    assert.equal(JSON.stringify(calls[1]).includes('review-generator'), false);
    assert.equal(JSON.stringify(result).includes('review-judge'), false);
    assert.equal((await admin.post(runs, { ...runConfig, version: 3, submission: 1, evaluationIds: [saved.id] })).status, 409);
  } finally { release(); await app.shutdown(); }
});

test('request migrations, read state and interrupted review evidence survive restart and workspace clearing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'request-tests-')), dbPath = join(dir, 'evals.sqlite');
  let fixture = await setup({ dbPath }), { app, person, admin, evaluation } = fixture;
  try {
    let request = await submit(person, [evaluation.id]); request = await data(await review(admin, request, 'request_changes', 'Revise'));
    await data(await person.post(base + '/' + request.id + '/read', { version: request.feedbackVersion }));
    const scope = { ownerId: 'request:' + request.id, workshopId: person.scope.workshopId };
    app.store.saveRun({ id: 'interrupted-review', sourceWorkspace: { alias: 'request' }, request: { id: request.id, submission: 1 }, status: 'running', items: [{ evaluationId: evaluation.id, evaluation, status: 'generating', events: [] }] }, scope);
    const summary = await person.get('/api/workspace'); await data(await person.request('/api/workspace', { method: 'DELETE', body: JSON.stringify({ revision: summary.revision }) }));
    await app.shutdown();
    app = await listen(createApp({ dbPath }));
    person = await client(app, { cookie: person.cookie }); admin = await client(app, { cookie: admin.cookie });
    assert.deepEqual(await person.get(base + '/' + request.id), request);
    assert.equal((await person.get(base + '/summary')).count, 0);
    assert.equal((await admin.get(base + '/' + request.id + '/runs/interrupted-review')).status, 'interrupted');
    assert.equal((await person.get('/api/evaluations')).evaluations.length, 0);
    await app.shutdown();
    app = await listen(createApp({ dbPath, env: { WORKSHOP_ID: 'another-workshop' } }));
    const outsider = await client(app, { githubId: 1 });
    assert.deepEqual((await outsider.get(base)).requests, []);
    assert.equal((await outsider.request(base + '/' + request.id)).status, 404);
    assert.equal((await outsider.request(base + '/' + request.id + '/runs/interrupted-review')).status, 404);
  } finally { await app.shutdown(); rmSync(dir, { recursive: true, force: true }); }
});
