import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRun } from '../src/evals/runs.mjs';
import { createApp, listen, client } from './helpers.mjs';

const snapshot = (items, status = 'completed') => ({ id: 'saved-run', createdAt: '2026-09-08T12:00:00Z', status, items });

test('run summaries average numeric scores including zero without changing evidence', () => {
  const run = snapshot([{ status: 'passed', score: 100 }, { status: 'failed', score: 0 }, { status: 'error', score: null }, { status: 'error' }]);
  const before = structuredClone(run), summary = summarizeRun(run);
  assert.equal(summary.score, 50); assert.equal(summary.scoredCount, 2);
  assert.equal(summary.total, 4); assert.equal(summary.errors, 2); assert.equal(summary.passed, 1); assert.equal(summary.failed, 1);
  assert.equal(summary.canDelete, true); assert.deepEqual(run, before);
  assert.equal(summarizeRun(snapshot([{ score: null }, { score: '100' }])).score, null);
  assert.equal(summarizeRun(snapshot([])).score, null);
});

test('generation model summaries use saved metadata, support legacy inputs and exclude judges', () => {
  const run = snapshot([
    { generationModel: 'actual', evaluation: { model: 'requested', judgeModel: 'judge' } },
    { evaluation: { source: 'llm', model: 'requested' } },
    { evaluation: { source: 'testcraft_api' } },
    { generationModel: 'actual' }, {},
    { evaluation: { source: 'pasted', model: 'unused' } },
  ]);
  assert.deepEqual(summarizeRun(run).models, ['API default', 'Unknown', 'actual', 'requested']);
  assert.deepEqual(summarizeRun(snapshot([{ evaluation: { source: 'pasted' } }])).models, []);
});

test('summary deletion eligibility matches active and terminal run invariants', () => {
  for (const status of ['queued', 'running']) assert.equal(summarizeRun(snapshot([{ status: 'passed' }], status)).canDelete, false);
  for (const status of ['completed', 'interrupted']) {
    assert.equal(summarizeRun(snapshot([{ status: 'error' }], status)).canDelete, true);
    assert.equal(summarizeRun(snapshot([{ status: 'grading' }], status)).canDelete, false);
  }
});

test('run list exposes all private summaries beyond 100 without changing detail payloads', async () => {
  const app = await listen(createApp({ dbPath: ':memory:', fetchImpl: () => { throw new Error('No provider calls expected'); } }));
  try {
    const owner = await client(app), other = await client(app);
    for (let i = 0; i < 105; i++) app.store.saveRun({ ...snapshot([{ status: 'passed', score: 75, evaluation: { source: 'testcraft_api', model: 'model-a' } }]), id: 'run-' + i }, owner.scope);
    const { runs } = await owner.get('/api/runs');
    assert.equal(runs.length, 105);
    assert.equal(runs[0].score, 75); assert.equal(runs[0].scoredCount, 1); assert.equal(runs[0].canDelete, true);
    assert.deepEqual(runs[0].models, ['model-a']);
    assert.deepEqual(await owner.get('/api/runs/run-0'), app.store.run('run-0', owner.scope));
    assert.deepEqual((await other.get('/api/runs')).runs, []);
    assert.equal((await other.request('/api/runs/run-0')).status, 404);
  } finally { await app.shutdown(); }
});
