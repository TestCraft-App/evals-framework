import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, listen, client, waitForRun, syntheticStream, testScope } from './helpers.mjs';
import { Store } from '../src/evals/store.mjs';
import { summarizeModels } from '../public/run-detail.js';

const definition = { name: 'Login rules', type: 'ideas', html: '<button>Login</button>', method: 'contains', criteria: ['login'] };
const generationModels = ['gpt-4o-mini', 'gpt-4o'];

test('each selected model generates and grades every evaluation with independent evidence and one shared grader', async () => {
  const generations = [], judges = [];
  const app = await listen(createApp({ dbPath: ':memory:', env: { OPENAI_API_KEY: 'judge-secret', TESTCRAFT_OPENAI_API_KEY: 'generator-secret' }, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/chat/completions')) {
      judges.push(body); assert.equal(init.headers.authorization, 'Bearer judge-secret');
      assert.equal(init.body.includes('generator-secret'), false);
      const criteria = JSON.parse(body.messages[1].content).criteria;
      return Response.json({ choices: [{ message: { content: JSON.stringify({ checks: criteria.map(c => ({ id: c.id, passed: true, reason: 'Supported', evidence: [1] })) }) } }] });
    }
    generations.push(body); assert.equal(body.openAiApiKey, 'generator-secret');
    for (const privateText of ['judge-secret', 'judge-only rubric', 'expectedOutput', 'criteria']) assert.equal(init.body.includes(privateText), false);
    return syntheticStream(body.model === generationModels[0] ? 'login' : 'logout');
  } }));
  try {
    const person = await client(app), other = await client(app), saved = [];
    for (const data of [definition, { ...definition, name: 'Model', method: 'model_grade', criteria: ['judge-only rubric'] }, { ...definition, name: 'Hybrid', method: 'hybrid', criteria: [{ text: 'login', method: 'contains' }, { text: 'judge-only rubric', method: 'model_grade' }] }]) saved.push(await (await person.post('/api/evaluations', data)).json());
    const body = { evaluationIds: saved.map(e => e.id), generationModels, graderModel: 'o3-mini' };
    assert.equal((await other.post('/api/runs', body)).status, 404);
    const response = await person.post('/api/runs', body); assert.equal(response.status, 202);
    const run = await waitForRun(person, (await response.json()).id);
    assert.deepEqual(run.settings.generationModels, generationModels);
    assert.equal(run.settings.graderModel, 'o3-mini'); assert.equal(run.items.length, 6);
    assert.equal(new Set(run.items.map(item => item.id)).size, 6);
    assert.deepEqual(run.items.map(item => item.score), [100, 100, 100, 0, 100, 50]);
    for (const model of generationModels) {
      const items = run.items.filter(item => item.evaluation.model === model);
      assert.deepEqual(items.map(item => item.evaluationId), saved.map(e => e.id));
      assert.ok(items.every(item => item.generationModel === model && item.evaluation.judgeModel === 'o3-mini'));
      assert.ok(items.every(item => item.output === (model === generationModels[0] ? 'login' : 'logout')));
    }
    assert.equal(generations.length, 6); assert.equal(judges.length, 4);
    assert.ok(judges.every(body => body.model === 'o3-mini'));
    assert.deepEqual(summarizeModels(run).map(group => [group.model, group.model_based, group.rule_based, group.hybrid, group.total, group.scoredCount, group.score]), [
      ['gpt-4o-mini', 1, 1, 1, 3, 3, 100], ['gpt-4o', 1, 1, 1, 3, 3, 50],
    ]);
    assert.deepEqual((await person.get('/api/runs')).runs[0].models, ['gpt-4o', 'gpt-4o-mini']);
    assert.equal((await other.request('/api/runs/' + run.id)).status, 404);
    for (const evaluation of saved) assert.deepEqual(app.store.evaluation(evaluation.id, person.scope), evaluation);
  } finally { await app.shutdown(); }
});

test('invalid or unavailable model lists reject the whole run before generation', async () => {
  let calls = 0;
  const app = await listen(createApp({ dbPath: ':memory:', env: {}, fetchImpl: async () => { calls++; return syntheticStream('login'); } }));
  try {
    const person = await client(app), saved = await (await person.post('/api/evaluations', definition)).json();
    for (const models of [null, [], 'gpt-4o', {}, [''], [7], ['../model'], ['gpt-4o', 'gpt-4o'], ['gpt-4o', 'missing'], Array.from({ length: 201 }, (_, i) => 'model-' + i)]) {
      const response = await person.post('/api/runs', { evaluationIds: [saved.id], generationModels: models });
      assert.equal(response.status, 400, JSON.stringify(models));
    }
    assert.equal(calls, 0); assert.deepEqual(app.store.runs(person.scope), []);
    const legacy = await person.post('/api/runs', { evaluationIds: [saved.id], generationModel: 'gpt-4o' });
    assert.equal(legacy.status, 202);
    assert.deepEqual((await waitForRun(person, (await legacy.json()).id)).settings.generationModels, ['gpt-4o']);
  } finally { await app.shutdown(); }
});

test('expanded runs respect the 100-job shared queue and never partially accept an oversized run', async () => {
  const gate = Promise.withResolvers(), started = Promise.withResolvers(); let calls = 0;
  const app = await listen(createApp({ dbPath: ':memory:', env: {}, fetchImpl: async () => {
    calls++; if (calls === 2) started.resolve(); await gate.promise; return syntheticStream('login');
  } }));
  try {
    const person = await client(app), evaluationIds = [];
    for (let i = 0; i < 50; i++) evaluationIds.push((await (await person.post('/api/evaluations', { ...definition, name: 'Eval ' + i })).json()).id);
    const oversized = await person.post('/api/runs', { evaluationIds, generationModels: [...generationModels, 'o3-mini'] });
    assert.equal(oversized.status, 400); assert.match((await oversized.json()).error, /100 evaluation\/model combinations/);
    assert.equal(calls, 0); assert.equal(app.store.runs(person.scope).length, 0);
    const response = await person.post('/api/runs', { evaluationIds, generationModels }); assert.equal(response.status, 202);
    const run = await response.json(); await started.promise;
    assert.equal(run.items.length, 100); assert.equal(app.engine.active, 2); assert.equal(app.engine.queue.length, 98);
    assert.equal((await person.post('/api/runs', { evaluationIds: [evaluationIds[0]], generationModels })).status, 429);
    assert.equal(app.store.runs(person.scope).length, 1);
    gate.resolve(); await app.engine.drain();
    assert.equal(calls, 100); assert.ok(app.store.run(run.id, person.scope).items.every(item => item.score === 100));
  } finally { gate.resolve(); await app.shutdown(); }
});

test('a failed generation leaves other selected models running and preserves unscored results', async () => {
  let calls = 0;
  const app = await listen(createApp({ dbPath: ':memory:', env: {}, fetchImpl: async (_url, init) => {
    calls++;
    return JSON.parse(init.body).model === 'gpt-4o' ? new Response('private upstream detail', { status: 503 }) : syntheticStream('login');
  } }));
  try {
    const person = await client(app), saved = await (await person.post('/api/evaluations', definition)).json();
    const response = await person.post('/api/runs', { evaluationIds: [saved.id], generationModels });
    const run = await waitForRun(person, (await response.json()).id);
    assert.deepEqual(run.items.map(item => [item.status, item.score]), [['passed', 100], ['error', null]]);
    assert.equal(calls, 2); assert.equal(JSON.stringify(run).includes('private upstream detail'), false);
    assert.deepEqual(summarizeModels(run).map(group => [group.model, group.total, group.scoredCount, group.score]), [['gpt-4o-mini', 1, 1, 100], ['gpt-4o', 1, 0, null]]);
  } finally { await app.shutdown(); }
});

test('restart preserves multi-model settings and evidence without replaying unfinished pairs or rewriting legacy runs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'testcraft-multi-model-')), dbPath = join(directory, 'runs.sqlite');
  const store = new Store(dbPath);
  const legacy = { id: 'legacy', status: 'completed', settings: { generationModel: 'gpt-4o' }, items: [{ id: 'old', evaluation: definition, output: 'old output', score: 0, status: 'failed', events: [] }] };
  const run = { id: 'multi-model', status: 'running', settings: { generationModels, graderModel: 'o3-mini' }, items: generationModels.map((model, index) => ({ id: 'item-' + index, evaluation: { ...definition, source: 'testcraft_api', model }, output: 'saved ' + model, score: index ? null : 100, status: index ? 'grading' : 'passed', events: [] })) };
  store.saveRun(legacy, testScope); store.saveRun(run, testScope); store.close();
  let calls = 0;
  const app = await listen(createApp({ dbPath, env: {}, fetchImpl: async () => { calls++; throw new Error('No replay expected'); } }));
  try {
    const recovered = app.store.run(run.id, testScope);
    assert.equal(recovered.status, 'interrupted'); assert.deepEqual(recovered.settings, run.settings);
    assert.deepEqual(recovered.items[0], run.items[0]);
    assert.equal(recovered.items[1].status, 'error'); assert.equal(recovered.items[1].output, run.items[1].output);
    assert.deepEqual(app.store.run(legacy.id, testScope), legacy); assert.equal(calls, 0);
  } finally { await app.shutdown(); await rm(directory, { recursive: true, force: true }); }
});

test('model summary counts actual criterion families, zero scores, pending and historical supplied output', () => {
  const run = { settings: { generationModels: ['b', 'a'] }, items: [
    { evaluation: { model: 'a', method: 'hybrid', criteria: [{ method: 'contains' }] }, score: 0 },
    { evaluation: { model: 'a', method: 'model_grade', criteria: ['one', 'two', 'three'] }, score: 100 },
    { evaluation: { model: 'a', method: 'hybrid', criteria: [{ method: 'model_grade' }] }, score: null },
    { evaluation: { model: 'b', method: 'hybrid', criteria: [{ method: 'contains' }, { method: 'model_grade' }] }, score: null },
    { evaluation: { source: 'pasted', model: 'ignored', method: 'contains' }, score: 50 },
  ] };
  const before = structuredClone(run);
  assert.deepEqual(summarizeModels(run), [
    { model: 'b', model_based: 0, rule_based: 0, hybrid: 1, total: 1, scoredCount: 0, score: null },
    { model: 'a', model_based: 2, rule_based: 1, hybrid: 0, total: 3, scoredCount: 2, score: 50 },
    { model: '', model_based: 0, rule_based: 1, hybrid: 0, total: 1, scoredCount: 1, score: 50 },
  ]);
  assert.deepEqual(run, before); assert.deepEqual(summarizeModels({ items: [] }), []);
});
