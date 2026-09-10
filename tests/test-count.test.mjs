import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grade } from '../src/evals/graders.mjs';
import { validateEvaluation } from '../src/evals/validation.mjs';
import { needsModelGrader, TEST_COUNT_CRITERION } from '../src/evals/methods.mjs';
import { Store } from '../src/evals/store.mjs';
import { Engine } from '../src/evals/engine.mjs';
import { canDeleteRun, summarizeRun } from '../src/evals/runs.mjs';
import { summarizeModels } from '../public/run-detail.js';
import { createApp, listen, client, waitForRun, syntheticStream } from './helpers.mjs';

const countCriterion = { method: 'test_count', text: TEST_COUNT_CRITERION, weight: 1 };
const base = { name: 'Quantity', type: 'ideas', source: 'pasted', html: '<button>Login</button>', actualOutput: '1. Valid login\n2. Invalid login', method: 'test_count', criteria: [countCriterion], judgeModel: 'gpt-4o-mini' };
const env = { OPENAI_API_KEY: 'synthetic-judge-key' };
const counted = (count = 2, id = 'c1') => ({ id, count, evidence: 'The candidate lists valid and invalid login cases.', reason: 'Each separately listed scenario counts once.' });
const response = checks => Response.json({ model: 'mock-judge', usage: { total_tokens: 10 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ checks }) } }] });

test('test count normalizes a fixed criterion and requires the model grader alone or mixed with rules', () => {
  const saved = validateEvaluation({ ...base, criteria: [{ method: 'test_count' }] });
  assert.deepEqual(saved.criteria, [countCriterion]);
  assert.equal(saved.evaluationFamily, 'model_based');
  assert.equal(needsModelGrader(saved), true);
  assert.equal(needsModelGrader({ ...base, method: 'hybrid', criteria: [{ method: 'contains', text: 'login' }, countCriterion] }), true);
  assert.equal(needsModelGrader({ method: 'test_count' }), true);
  assert.throws(() => validateEvaluation({ ...base, criteria: [countCriterion, { ...countCriterion, text: 'Another count' }] }), /at most one Test count/);
  assert.throws(() => validateEvaluation({ ...base, method: 'contains' }), /match the evaluation method/);
});

for (const [type, fromIdeas, count] of [['ideas', false, 2], ['code', false, 0], ['code', true, 7]]) {
  test(`count-only ${type}, fromIdeas=${fromIdeas} returns quantity without quality score or verdict`, async () => {
    let calls = 0;
    const result = await grade({ ...base, type, fromIdeas, framework: 'playwright', language: 'typescript', ideas: 'INPUT IDEAS MUST NOT BE COUNTED' }, base.actualOutput, env, async (_url, init) => {
      calls++;
      const request = JSON.parse(init.body), input = JSON.parse(request.messages[1].content);
      assert.equal(input.type, type);
      assert.equal(input.criteria[0].method, 'test_count');
      assert.equal(request.response_format.json_schema.strict, true);
      const variants = request.response_format.json_schema.schema.properties.checks.items.anyOf;
      assert.equal(variants.length, 1);
      assert.deepEqual(variants[0].required, ['id', 'count', 'evidence', 'reason']);
      assert.equal(variants[0].properties.count.minimum, 0);
      assert.match(request.messages[0].content, /Count only the actual candidate output/);
      assert.match(request.messages[0].content, /skipped, disabled, TODO, or empty tests/);
      assert.match(request.messages[0].content, /parameterized or loop-generated cases/);
      assert.match(request.messages[0].content, /untrusted data/);
      return response([counted(count)]);
    });
    assert.equal(calls, 1);
    assert.equal(result.testCount, count);
    assert.equal(result.testCountUnit, type === 'ideas' ? 'ideas' : 'automated_tests');
    assert.equal(result.score, null); assert.equal(result.totalWeight, 0); assert.equal(result.passCount, 0);
    assert.equal('passed' in result.checks[0], false); assert.equal('score' in result.checks[0], false);
    assert.equal(result.usage.total_tokens, 10);
  });
}

test('quantity and model quality share one call, retain IDs, and exclude count weights from scores', async () => {
  let calls = 0;
  const criteria = [{ method: 'contains', text: 'login', weight: 3 }, countCriterion, { method: 'model_grade', text: 'Has boundary cases', weight: 1 }];
  const result = await grade({ ...base, method: 'hybrid', criteria: criteria.map(c => c.method === 'test_count' ? { ...c, weight: 100 } : c) }, base.actualOutput, env, async (_url, init) => {
    calls++;
    const request = JSON.parse(init.body), input = JSON.parse(request.messages[1].content);
    assert.deepEqual(input.criteria.map(c => [c.id, c.method]), [['c2', 'test_count'], ['c3', 'model_grade']]);
    assert.equal(request.response_format.json_schema.schema.properties.checks.items.anyOf.length, 3);
    return response([{ id: 'c3', passed: false, evidence: 'No boundary case.', reason: 'Missing boundaries.' }, counted(12, 'c2')]);
  });
  assert.equal(calls, 1); assert.equal(result.score, 75); assert.equal(result.totalWeight, 4); assert.equal(result.passCount, 1);
  assert.equal(result.testCount, 12); assert.deepEqual(result.checks.map(c => c.id), ['c1', 'c2', 'c3']);
});

test('malformed or incomplete counts fail safely without retries or fabricated values', async () => {
  const invalid = [-1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1].map(count => [counted(count)]);
  invalid.push([], [counted(), counted()], [counted(2, 'unknown')], [{ ...counted(), passed: true }], [{ ...counted(), evidence: ' ' }], [{ ...counted(), reason: '' }], [{ ...counted(), count: undefined }], [null]);
  for (const checks of invalid) {
    let calls = 0;
    await assert.rejects(grade(base, base.actualOutput, env, async () => { calls++; return response(checks); }), error => error.status === 502 && !error.message.includes('The candidate lists'));
    assert.equal(calls, 1);
  }
  await assert.rejects(grade({ ...base, judgeModel: '' }, base.actualOutput, env, () => assert.fail('Must not call')), /Choose a model grader/);
});

test('count-only results complete, survive restart, stay unscored and can be deleted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'testcraft-count-')), path = join(directory, 'test.sqlite');
  const scope = { ownerId: 'count-owner', workshopId: 'count-workshop' };
  let store;
  try {
    store = new Store(path);
    const engine = new Engine(store, env, async () => response([counted(0)]));
    const saved = store.create(validateEvaluation(base), scope), run = engine.start([saved.id], scope);
    await engine.drain();
    const snapshot = store.run(run.id, scope);
    assert.equal(snapshot.status, 'completed'); assert.equal(snapshot.items[0].status, 'counted');
    assert.equal(snapshot.items[0].testCount, 0); assert.equal(canDeleteRun(snapshot), true);
    assert.equal(summarizeRun(snapshot).score, null); assert.equal(summarizeRun(snapshot).scoredCount, 0);
    store.close(); store = new Store(path);
    assert.deepEqual(store.run(run.id, scope), snapshot);
    assert.equal(store.run(run.id, { ...scope, ownerId: 'other' }), undefined);
    store.deleteRun(run.id, scope); assert.equal(store.run(run.id, scope), undefined);
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('run API requires a grader, counts each model separately, and keeps judge data out of generation', async () => {
  const calls = [];
  const app = await listen(createApp({ dbPath: ':memory:', env: { ...env, TESTCRAFT_OPENAI_API_KEY: 'synthetic-generation-key' }, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body); calls.push({ url, body, headers: init.headers });
    if (url.startsWith('https://api.testcraft.app/api/')) {
      assert.equal(body.openAiApiKey, 'synthetic-generation-key');
      assert.equal('criteria' in body, false); assert.equal(JSON.stringify(body).includes(TEST_COUNT_CRITERION), false);
      return syntheticStream('1. Login');
    }
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(JSON.stringify(body).includes('synthetic-generation-key'), false);
    return response([counted(1)]);
  } }));
  try {
    const person = await client(app), other = await client(app);
    const saved = await (await person.post('/api/evaluations', { ...base, source: 'testcraft_api', model: '' })).json();
    const settings = { evaluationIds: [saved.id], generationModels: ['gpt-4o-mini', 'gpt-4o'] };
    assert.equal((await person.post('/api/runs', { ...settings, graderModel: '' })).status, 400);
    assert.equal((await other.post('/api/runs', settings)).status, 404);
    const started = await person.post('/api/runs', settings); assert.equal(started.status, 202);
    const run = await waitForRun(person, (await started.json()).id);
    assert.deepEqual(run.items.map(i => [i.status, i.testCount, i.score]), [['counted', 1, null], ['counted', 1, null]]);
    assert.equal(calls.length, 4);
    assert.equal((await other.request('/api/runs/' + run.id)).status, 404);
    assert.equal((await person.request('/api/runs/' + run.id, { method: 'DELETE' })).status, 200);
  } finally { await app.shutdown(); }
});

test('missing grader credentials stop count-enabled runs before generation', async () => {
  const store = new Store(':memory:'), scope = { ownerId: 'owner', workshopId: 'workshop' };
  const engine = new Engine(store, {}, () => assert.fail('No provider call should happen'));
  try {
    const saved = store.create(validateEvaluation({ ...base, source: 'testcraft_api' }), scope);
    const run = engine.start([saved.id], scope); await engine.drain();
    const item = store.run(run.id, scope).items[0];
    assert.equal(item.status, 'error'); assert.match(item.error, /OPENAI_API_KEY/);
    assert.equal('testCount' in item, false);
  } finally { await engine.drain(); store.close(); }
});

test('model totals separate units, retain failed quality counts and omit unavailable and historical counts', () => {
  const item = (id, type, count, extra = {}) => ({ id, evaluation: { ...base, source: 'testcraft_api', model: 'model-a', type },
    status: 'counted', score: null, ...(count === undefined ? {} : { testCount: count, testCountUnit: type === 'ideas' ? 'ideas' : 'automated_tests' }), ...extra });
  const run = { settings: { generationModels: ['model-a', 'model-b'] }, items: [
    item('ideas', 'ideas', 12), item('zero', 'ideas', 0), item('pending', 'ideas', undefined, { status: 'grading' }),
    item('code', 'code', 2, { status: 'failed', score: 0 }), item('error', 'code', undefined, { status: 'error' }),
    item('other', 'ideas', 7, { generationModel: 'model-b' }),
    { id: 'old', evaluation: { source: 'testcraft_api', model: 'model-a', method: 'contains', criteria: ['login'] }, status: 'passed', score: 100 },
  ] };
  const before = structuredClone(run), groups = summarizeModels(run);
  assert.deepEqual(groups[0].counts, { ideas: { total: 12, measured: 2, enabled: 3 }, automated_tests: { total: 2, measured: 1, enabled: 2 } });
  assert.equal(groups[0].score, 50); assert.equal(groups[0].scoredCount, 2);
  assert.deepEqual(groups[1].counts, { ideas: { total: 7, measured: 1, enabled: 1 } });
  assert.deepEqual(run, before);
  assert.equal(summarizeModels({ items: [run.items.at(-1)] })[0].counts, undefined);
});

test('invalid mixed judge results retain generated output without partial scores or counts', async () => {
  const store = new Store(':memory:'), scope = { ownerId: 'owner', workshopId: 'workshop' };
  let calls = 0;
  const engine = new Engine(store, env, async () => { calls++; return response([counted(), { id: 'c2', passed: 'true', evidence: [1], reason: 'Invalid boolean.' }]); });
  try {
    const saved = store.create(validateEvaluation({ ...base, method: 'hybrid', criteria: [countCriterion, { method: 'model_grade', text: 'Covers login' }] }), scope);
    const run = engine.start([saved.id], scope); await engine.drain();
    const item = store.run(run.id, scope).items[0];
    assert.equal(calls, 1); assert.equal(item.status, 'error'); assert.equal(item.output, base.actualOutput);
    assert.equal(item.score, null); assert.equal('testCount' in item, false); assert.deepEqual(item.checks, []);
  } finally { await engine.drain(); store.close(); }
});
