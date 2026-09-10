import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Store } from '../src/evals/store.mjs';
import { basicWorkshopSuites, workshopSuites } from '../src/evals/workshop.mjs';
import { createApp, listen, client, testScope, waitForRun } from './helpers.mjs';

const definition = { name: 'Reference case', type: 'ideas', method: 'contains', html: '<button>Login</button>', criteria: ['valid user'] };

for (const basicFirst of [true, false]) test(`Basic and Full imports retain IDs after existing evaluations and restart (${basicFirst ? 'Basic' : 'Full'} first)`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'testcraft-suite-references-')), path = join(dir, 'evals.sqlite');
  let store = new Store(path);
  try {
    assert.equal(store.create(definition, testScope).reference, 'EVAL-1');
    const collections = basicFirst ? [basicWorkshopSuites, workshopSuites] : [workshopSuites, basicWorkshopSuites];
    const imported = collections.flatMap(collection => store.importWorkshop(collection, testScope).evaluations);
    assert.equal(imported.length, 168);
    assert.deepEqual(imported.map(item => item.reference), Array.from({ length: 168 }, (_, index) => 'EVAL-' + (index + 2)));
    const references = new Map(imported.map(item => [item.id, item.reference]));
    store.close(); store = new Store(path);
    for (const collection of collections) {
      const repeated = store.importWorkshop(collection, testScope);
      assert.equal(repeated.created, false);
      for (const item of repeated.evaluations) {
        assert.equal(item.reference, references.get(item.id));
        assert.equal(store.evaluation(item.id, testScope).reference, item.reference);
      }
    }
    assert.equal(store.create(definition, testScope).reference, 'EVAL-170');
    assert.deepEqual(store.runs(testScope), []);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('references survive edits, suite moves, deletion and clearing, while copies and workspaces get fresh sequences', () => {
  const store = new Store(':memory:');
  try {
    const saved = store.create({ ...definition, reference: 'EVAL-999' }, testScope);
    assert.equal(saved.reference, 'EVAL-1');
    const suite = store.createSuite({ name: 'Moved' }, testScope);
    const edited = store.updateEvaluation(saved.id, { ...definition, suiteId: suite.id, reference: 'EVAL-999' }, 1, testScope);
    assert.equal(edited.reference, saved.reference);
    assert.equal(store.renameEvaluation(saved.id, { name: 'Renamed', revision: 2 }, testScope).reference, saved.reference);
    const copy = store.duplicateEvaluation(saved.id, {}, testScope);
    assert.equal(copy.reference, 'EVAL-2');
    for (const scope of [{ ...testScope, ownerId: 'another-owner' }, { ...testScope, workshopId: 'another-workshop' }]) {
      assert.equal(store.create(definition, scope).reference, 'EVAL-1');
      assert.equal(store.evaluation(saved.id, scope), undefined);
    }
    store.deleteEvaluation(copy.id, testScope);
    assert.equal(store.create(definition, testScope).reference, 'EVAL-3');
    store.clearWorkspace({ revision: store.workspaceSummary(testScope).revision }, testScope);
    assert.equal(store.create(definition, testScope).reference, 'EVAL-4');
  } finally { store.close(); }
});

test('migration orders definitions and historical-only cases, preserves evidence and is stable across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'testcraft-references-')), path = join(dir, 'evals.sqlite');
  let store = new Store(path);
  try {
    const insert = store.db.prepare('INSERT INTO evaluations(id,data,owner_id,workshop_id) VALUES(?,?,?,?)');
    for (const [id, createdAt] of [['b', '2026-02-01'], ['a', '2026-02-01']]) insert.run(id, JSON.stringify({ ...definition, id, createdAt }), testScope.ownerId, testScope.workshopId);
    insert.run('unowned', JSON.stringify({ ...definition, id: 'unowned', createdAt: '2020-01-01' }), null, null);
    const run = { id: 'history', status: 'completed', createdAt: '2026-03-01', items: [
      { id: 'result-deleted', evaluationId: 'deleted', evaluation: { id: 'deleted', createdAt: '2026-01-01' }, output: 'Original evidence' },
      { id: 'result-a', evaluationId: 'a', evaluation: { id: 'a', createdAt: '2026-02-01' } },
      { id: 'snapshot-only', evaluation: { id: 'snapshot-only' } },
      { id: 'missing-uuid', evaluation: { name: 'Unknown' } },
    ] };
    store.saveRun(run, testScope);
    const raw = store.db.prepare('SELECT data FROM runs').get().data;
    store.close(); store = new Store(path);
    assert.equal(store.evaluation('a', testScope).reference, 'EVAL-2');
    assert.equal(store.evaluation('b', testScope).reference, 'EVAL-3');
    const history = store.run('history', testScope);
    assert.deepEqual(history.items.map(item => item.evaluation.reference), ['EVAL-1', 'EVAL-2', 'EVAL-4', undefined]);
    assert.equal(store.db.prepare('SELECT data FROM runs').get().data, raw);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM evaluation_references').get().count, 4);
    store.deleteEvaluation('a', testScope);
    assert.equal(store.run('history', testScope).items[1].evaluation.reference, 'EVAL-2');
    store.close(); store = new Store(path);
    assert.equal(store.create(definition, testScope).reference, 'EVAL-5');
    assert.deepEqual(store.run('history', testScope), history);
    assert.equal(store.db.prepare('SELECT data FROM runs').get().data, raw);
    assert.deepEqual(store.runs({ ...testScope, ownerId: 'stranger' }), []);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('concurrent store connections allocate distinct references and rollbacks do not reserve numbers', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'testcraft-reference-writers-')), path = join(dir, 'evals.sqlite');
  const store = new Store(path), workers = [];
  try {
    for (let i = 0; i < 2; i++) {
      const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
        import(workerData.module).then(({ Store }) => {
          const store = new Store(workerData.path);
          parentPort.once('message', () => {
            try { parentPort.postMessage(Array.from({ length: 10 }, () => store.create(workerData.definition, workerData.scope).reference)); }
            finally { store.close(); }
          });
          parentPort.postMessage('ready');
        });`, { eval: true, workerData: { module: new URL('../src/evals/store.mjs', import.meta.url).href, path, definition, scope: testScope } });
      workers.push(worker);
      await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
    }
    const results = workers.map(worker => new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); }));
    workers.forEach(worker => worker.postMessage('start'));
    const references = (await Promise.all(results)).flat();
    assert.deepEqual(references.sort((a, b) => Number(a.slice(5)) - Number(b.slice(5))), Array.from({ length: 20 }, (_, i) => 'EVAL-' + (i + 1)));
    store.db.exec("CREATE TRIGGER reject_eval BEFORE INSERT ON evaluations BEGIN SELECT RAISE(ABORT, 'Synthetic failure'); END");
    assert.throws(() => store.create(definition, testScope), /Synthetic failure/);
    store.db.exec('DROP TRIGGER reject_eval');
    assert.equal(store.create(definition, testScope).reference, 'EVAL-21');
  } finally { await Promise.all(workers.map(worker => worker.terminate())); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('API references are read-only and new run snapshots retain them', async () => {
  const app = await listen(createApp({ dbPath: ':memory:' }));
  try {
    const person = await client(app);
    const response = await person.post('/api/evaluations', { ...definition, reference: 'EVAL-999' });
    assert.equal(response.status, 201);
    const saved = await response.json();
    assert.equal(saved.reference, 'EVAL-1');
    const edited = await person.request('/api/evaluations/' + saved.id, { method: 'PUT', body: JSON.stringify({ ...definition, reference: 'EVAL-999', revision: 1 }) });
    assert.equal(edited.status, 200);
    assert.equal((await edited.json()).reference, saved.reference);
    const started = await person.post('/api/runs', { evaluationIds: [saved.id] });
    assert.equal(started.status, 202);
    const run = await waitForRun(person, (await started.json()).id);
    assert.equal(run.items[0].evaluation.reference, saved.reference);
    assert.equal(JSON.parse(app.store.db.prepare('SELECT data FROM runs WHERE id=?').get(run.id).data).items[0].evaluation.reference, saved.reference);
    assert.equal((await person.get('/api/evaluations')).evaluations[0].reference, saved.reference);
  } finally { await app.shutdown(); }
});
