import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/evals/store.mjs';
import { validateEvaluation } from '../src/evals/validation.mjs';
import { createApp, listen, client, testScope } from './helpers.mjs';

const definition = { name: 'Synthetic case', type: 'ideas', method: 'contains', html: '<button>Login</button>', criteria: ['valid user'] };
const remove = (person, body, options = {}) => person.request('/api/evaluations', { method: 'DELETE', body: JSON.stringify(body), ...options });
const snapshot = (evaluation, status, itemStatus) => ({ id: 'synthetic-run', createdAt: '2026-01-01T00:00:00.000Z', status, items: [{ evaluationId: evaluation.id, evaluation, status: itemStatus, output: 'valid user', score: 100 }] });

test('bulk deletion validates IDs and enforces ownership, authentication, origin and CSRF atomically', async () => {
  const app = await listen(createApp({ dbPath: ':memory:', fetchImpl: async () => assert.fail('Deletion must not contact providers.') }));
  try {
    const person = await client(app), other = await client(app);
    const first = await (await person.post('/api/evaluations', definition)).json();
    const second = await (await person.post('/api/evaluations', { ...definition, name: 'Second case' })).json();
    const foreign = await (await other.post('/api/evaluations', definition)).json();
    for (const body of [null, [], {}, { evaluationIds: [] }, { evaluationIds: first.id }, { evaluationIds: [null] }, { evaluationIds: [1] }, { evaluationIds: [''] }, { evaluationIds: ['bad/id'] }, { evaluationIds: [first.id, first.id] }, { evaluationIds: [first.id], ownerId: other.scope.ownerId }]) {
      assert.equal((await remove(person, body)).status, 400);
    }
    for (const id of ['missing-id', foreign.id]) assert.equal((await remove(person, { evaluationIds: [first.id, id] })).status, 404);
    const body = { evaluationIds: [first.id, second.id] };
    for (const headers of [{ origin: 'https://foreign.invalid' }, { 'x-csrf-token': '' }, { 'x-csrf-token': other.info.csrfToken }]) {
      assert.equal((await remove(person, body, { headers })).status, 403);
    }
    const anonymous = await fetch(person.url + '/api/evaluations', { method: 'DELETE', headers: { origin: person.url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(anonymous.status, 401);
    assert.equal(app.store.evaluations(person.scope).length, 2);
    const response = await remove(person, body);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { deletedIds: body.evaluationIds });
    assert.equal(app.store.evaluations(person.scope).length, 0);
    assert.deepEqual(app.store.evaluation(foreign.id, other.scope), foreign);
  } finally { await app.shutdown(); }
});

test('active runs block every selected deletion through the bulk endpoint', async () => {
  const app = await listen(createApp({ dbPath: ':memory:' }));
  try {
    const person = await client(app);
    const free = await (await person.post('/api/evaluations', definition)).json();
    const active = await (await person.post('/api/evaluations', { ...definition, name: 'Active case' })).json();
    for (const [status, itemStatus] of [['queued', 'queued'], ['running', 'passed'], ['completed', 'generating'], ['interrupted', 'grading']]) {
      const run = snapshot(active, status, itemStatus); app.store.saveRun(run, person.scope);
      const response = await remove(person, { evaluationIds: [free.id, active.id] });
      assert.equal(response.status, 409); assert.match((await response.json()).error, /active run/);
      assert.deepEqual(app.store.evaluation(free.id, person.scope), free);
      assert.deepEqual(app.store.evaluation(active.id, person.scope), active);
      assert.deepEqual(app.store.run(run.id, person.scope), run);
    }
  } finally { await app.shutdown(); }
});

test('bulk deletion preserves suites, run snapshots and reference sequences after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'evals-bulk-delete-')), path = join(directory, 'evals.sqlite');
  let store = new Store(path);
  try {
    const suite = store.createSuite({ name: 'Keep suite' }, testScope);
    const first = store.create({ ...validateEvaluation(definition), suiteId: suite.id }, testScope);
    const second = store.create(validateEvaluation(definition), testScope);
    const retained = store.create(validateEvaluation(definition), testScope);
    const run = snapshot(first, 'completed', 'passed'); store.saveRun(run, testScope);
    store.deleteEvaluations({ evaluationIds: [first.id, second.id] }, testScope);
    store.close(); store = new Store(path);
    assert.deepEqual(store.evaluations(testScope), [retained]);
    assert.deepEqual(store.suite(suite.id, testScope), suite);
    assert.deepEqual(store.run(run.id, testScope), run);
    assert.equal(store.create(validateEvaluation(definition), testScope).reference, 'EVAL-4');
    assert.throws(() => store.deleteEvaluations({ evaluationIds: [retained.id, first.id] }, testScope), { status: 404 });
    assert.deepEqual(store.evaluation(retained.id, testScope), retained);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});
