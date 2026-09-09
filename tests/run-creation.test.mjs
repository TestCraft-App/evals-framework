import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { createModelCatalog } from '../src/evals/models.mjs';
import { environments, localAvailable } from '../src/evals/run-config.mjs';
import { listen, client, waitForRun, syntheticStream } from './helpers.mjs';

const definition = { name: 'Synthetic login', type: 'ideas', html: '<button>Login</button>', method: 'contains', criteria: ['login'] };
const settings = { environment: 'prod', generationModel: 'gpt-4o-mini', graderModel: 'gpt-4o' };
const catalog = () => Response.json({ models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'].map(id => ({ id, label: id })) });
const post = (person, body) => person.request('/api/runs', { method: 'POST', body: JSON.stringify(body) });
const save = async (person, data = {}) => (await person.post('/api/evaluations', { ...definition, ...data })).json();

test('run suite names are private snapshots unaffected by later renames or deletion', async () => {
  const app = await listen(createApp({ dbPath: ':memory:', env: {}, fetchImpl: async url => url.endsWith('/api/models') ? catalog() : syntheticStream('login') }));
  try {
    const person = await client(app), other = await client(app);
    const suite = app.store.createSuite({ name: 'Original suite' }, person.scope);
    const evaluation = await save(person, { suiteId: suite.id });
    const response = await post(person, { ...settings, evaluationIds: [evaluation.id] });
    assert.equal(response.status, 202);
    const run = await waitForRun(person, (await response.json()).id);
    assert.equal(run.items[0].evaluation.suiteName, 'Original suite');
    assert.equal(app.store.evaluation(evaluation.id, person.scope).suiteName, undefined);
    assert.equal((await other.request('/api/runs/' + run.id)).status, 404);
    assert.equal((await post(other, { ...settings, evaluationIds: [evaluation.id] })).status, 404);
    app.store.updateSuite(suite.id, { name: 'Renamed suite', revision: suite.revision }, person.scope);
    app.store.deleteSuite(suite.id, person.scope);
    assert.deepEqual(await person.get('/api/runs/' + run.id), run);
    const unfiled = await post(person, { ...settings, evaluationIds: [evaluation.id] });
    assert.equal((await waitForRun(person, (await unfiled.json()).id)).items[0].evaluation.suiteName, 'Unfiled');
  } finally { await app.shutdown(); }
});

test('all three current TestCraft models can generate and grade with validated evidence', async () => {
  const models = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'], graded = [];
  const app = await listen(createApp({ dbPath: ':memory:', env: { OPENAI_API_KEY: 'test-only' }, fetchImpl: async (url, init) => {
    if (url.endsWith('/api/models')) return Response.json({ models: models.map(id => ({ id, label: id })) });
    if (url.startsWith(environments.prod)) { assert.ok(models.includes(JSON.parse(init.body).model)); return syntheticStream('login'); }
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(init.body); graded.push(body.model); assert.equal(body.response_format.json_schema.strict, true);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ checks: [{ id: 'c1', passed: true, reason: 'Login present', evidence: [1] }] }) } }] });
  } }));
  try {
    const person = await client(app), evaluation = await save(person, { method: 'model_grade' });
    const available = await person.get('/api/models?environment=prod');
    assert.deepEqual(available.models.map(model => model.id), models); assert.ok(available.models.every(model => model.graderCompatible));
    for (const model of models) {
      const response = await post(person, { environment: 'prod', evaluationIds: [evaluation.id], generationModel: model, graderModel: model });
      assert.equal(response.status, 202);
      const run = await waitForRun(person, (await response.json()).id);
      assert.equal(run.items[0].score, 100); assert.equal(run.items[0].evaluation.judgeModel, model);
    }
    assert.deepEqual(graded, models); assert.equal((await person.get('/api/session')).budget.used, 6);
  } finally { await app.shutdown(); }
});

test('new run contract rejects missing/forged settings, unavailable models and missing TestCraft inputs before reserving calls', async () => {
  const calls = [];
  const app = await listen(createApp({ dbPath: ':memory:', env: {}, fetchImpl: async url => { calls.push(url); if (url.endsWith('/api/models')) return catalog(); throw new Error('No generation expected'); } }));
  try {
    const person = await client(app), saved = await save(person), ids = { evaluationIds: [saved.id] };
    for (const body of [ids, { ...ids, ...settings, environment: 'https://attacker.invalid' }, { ...ids, ...settings, generationModel: '' }, { ...ids, ...settings, generationModel: 'missing' }, { ...ids, ...settings, description: 'x'.repeat(2001) }]) assert.equal((await post(person, body)).status, 400);
    const modelEval = await save(person, { method: 'model_grade' });
    assert.equal(modelEval.judgeModel, '');
    for (const graderModel of ['', 'missing']) assert.equal((await post(person, { ...settings, evaluationIds: [modelEval.id], graderModel })).status, 400);
    const oldCode = await save(person, { source: 'pasted', actualOutput: 'old', type: 'code', framework: 'playwright', language: 'typescript' });
    const rejected = await post(person, { ...settings, evaluationIds: [oldCode.id] });
    assert.equal(rejected.status, 400); assert.match((await rejected.json()).error, /Synthetic login.*Page URL/);
    assert.ok(calls.every(url => url.endsWith('/api/models'))); assert.equal(app.store.runs(person.scope).length, 0);
    assert.equal(app.store.budget('workshop', 200).used, 0); assert.equal(app.store.budget('workshop', 200).reserved, 0);
  } finally { await app.shutdown(); }
});

test('concurrent environments use distinct catalogs, generation URLs and immutable run settings', async () => {
  const calls = [], env = { OPENAI_API_KEY: 'judge-secret', TESTCRAFT_OPENAI_API_KEY: 'generation-secret', TESTCRAFT_BASE_URL: 'https://unused.invalid' };
  const app = await listen(createApp({ dbPath: ':memory:', env, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/models')) return catalog();
    return syntheticStream('login');
  } }));
  try {
    const person = await client(app);
    const first = await save(person, { source: 'pasted', actualOutput: 'old response' }), second = await save(person, { source: 'llm', model: 'old-model' });
    const oldRun = { id: 'historical', status: 'completed', createdAt: '2025-01-01', items: [{ evaluation: first, status: 'passed', score: 100 }] };
    app.store.saveRun(oldRun, person.scope);
    const responses = await Promise.all([post(person, { ...settings, description: '  Production check  ', evaluationIds: [first.id] }), post(person, { ...settings, environment: 'dev', generationModel: 'gpt-4o', evaluationIds: [second.id] })]);
    for (const response of responses) assert.equal(response.status, 202);
    const completed = await Promise.all(responses.map(async response => waitForRun(person, (await response.json()).id)));
    assert.equal(completed[0].description, 'Production check');
    for (const [index, run] of completed.entries()) {
      const environment = index ? 'dev' : 'prod';
      assert.equal(run.settings.testcraftBaseUrl, environments[environment]); assert.equal(run.settings.environment, environment);
      assert.equal(run.items[0].evaluation.source, 'testcraft_api'); assert.equal(run.items[0].evaluation.actualOutput, '');
      assert.equal(run.items[0].evaluation.model, index ? 'gpt-4o' : 'gpt-4o-mini'); assert.equal(run.items[0].score, 100);
      assert.equal(run.settings.graderModel, ''); assert.equal(JSON.stringify(run).includes('secret'), false);
    }
    assert.deepEqual(app.store.evaluation(first.id, person.scope), first); assert.deepEqual(app.store.evaluation(second.id, person.scope), second);
    assert.deepEqual(app.store.run(oldRun.id, person.scope), oldRun); assert.equal(env.TESTCRAFT_BASE_URL, 'https://unused.invalid');
    for (const { url, init } of calls) {
      assert.ok(url.startsWith(environments.prod) || url.startsWith(environments.dev));
      if (url.endsWith('/api/models')) assert.equal(JSON.stringify(init).includes('secret'), false);
      else { assert.equal(JSON.parse(init.body).openAiApiKey, 'generation-secret'); assert.equal(init.body.includes('judge-secret'), false); }
    }
    assert.equal((await person.get('/api/session')).budget.used, 2);
  } finally { await app.shutdown(); }
});

test('run grader applies across model criteria and keeps grading on the separate OpenAI connection', async () => {
  const calls = [];
  const app = await listen(createApp({ dbPath: ':memory:', env: { OPENAI_API_KEY: 'judge-secret', OPENAI_BASE_URL: 'https://judge.example/v1' }, fetchImpl: async (url, init) => {
    calls.push(url);
    if (url.endsWith('/api/models')) return catalog();
    if (url.startsWith(environments.dev)) return syntheticStream('login');
    assert.equal(url, 'https://judge.example/v1/chat/completions');
    const body = JSON.parse(init.body); assert.equal(body.model, 'gpt-4o'); assert.equal(init.headers.authorization, 'Bearer judge-secret');
    const criteria = JSON.parse(body.messages[1].content).criteria;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ checks: criteria.map(c => ({ id: c.id, passed: true, reason: 'Supported', evidence: [1] })) }) } }] });
  } }));
  try {
    const person = await client(app), first = await save(person, { method: 'model_grade' }), second = await save(person, { name: 'Hybrid', method: 'hybrid', criteria: [{ text: 'login', method: 'model_grade', weight: 1 }, { text: 'login', method: 'contains', weight: 1 }] });
    const response = await post(person, { ...settings, environment: 'dev', evaluationIds: [first.id, second.id] });
    assert.equal(response.status, 202);
    const run = await waitForRun(person, (await response.json()).id);
    assert.ok(run.items.every(item => item.score === 100 && item.evaluation.judgeModel === 'gpt-4o'));
    assert.equal(calls.filter(url => url.endsWith('/chat/completions')).length, 2);
    assert.equal((await person.get('/api/session')).budget.used, 4);
  } finally { await app.shutdown(); }
});

test('Local availability uses actual server binding and production configuration, never a browser-selected host', async () => {
  for (const [env, address, enabled] of [[{}, '127.0.0.1', true], [{}, '::1', true], [{}, '0.0.0.0', false], [{ NODE_ENV: 'production' }, '127.0.0.1', false], [{ APP_ORIGIN: 'https://public.example' }, '127.0.0.1', false]]) assert.equal(localAvailable(env, { address }), enabled);
  const app = await listen(createApp({ dbPath: ':memory:', env: { NODE_ENV: 'production', APP_ORIGIN: 'https://public.example' }, fetchImpl: () => { throw new Error('No request expected'); } }));
  try {
    const person = await client(app, { origin: 'https://public.example' });
    assert.equal((await person.get('/api/config')).environments.find(e => e.id === 'local').enabled, false);
    assert.equal((await person.request('/api/models?environment=local')).status, 400);
    assert.equal((await post(person, { ...settings, environment: 'local', evaluationIds: ['unknown'] })).status, 400);
  } finally { await app.shutdown(); }
});

test('model catalogs have isolated caches and never invent a fallback when an environment is unavailable', async () => {
  let clock = 0, fail = false, calls = 0;
  const fetchImpl = async url => { calls++; if (fail || url.startsWith(environments.dev)) throw new Error('private provider error'); return catalog(); };
  const prod = createModelCatalog({ TESTCRAFT_BASE_URL: environments.prod }, fetchImpl, () => clock);
  const dev = createModelCatalog({ TESTCRAFT_BASE_URL: environments.dev }, fetchImpl, () => clock);
  const [a, b] = await Promise.all([prod(), prod()]); assert.equal(calls, 1); assert.deepEqual(a, b);
  const unavailable = await dev(); assert.deepEqual(unavailable.models, []); assert.equal(JSON.stringify(unavailable).includes('private'), false);
  clock = 300001; fail = true;
  const stale = await prod(); assert.deepEqual(stale.models, a.models); assert.match(stale.warning, /last catalog/);
});

test('catalog failure prevents creation without spending allowance and ownership is checked before catalog access', async () => {
  let calls = 0;
  const app = await listen(createApp({ dbPath: ':memory:', env: {}, fetchImpl: async () => { calls++; throw new Error('Unavailable'); } }));
  try {
    const person = await client(app), other = await client(app), saved = await save(person);
    assert.equal((await post(other, { ...settings, evaluationIds: [saved.id] })).status, 404); assert.equal(calls, 0);
    assert.equal((await post(person, { ...settings, evaluationIds: [saved.id] })).status, 503); assert.equal(calls, 1);
    assert.deepEqual((await person.get('/api/runs')).runs, []); assert.equal((await person.get('/api/session')).budget.used, 0);
  } finally { await app.shutdown(); }
});

test('loopback development runs use the Local catalog and generation destination', async () => {
  const calls = [];
  const app = await listen(createApp({ dbPath: ':memory:', env: {}, fetchImpl: async url => {
    calls.push(url); assert.ok(url.startsWith(environments.local));
    return url.endsWith('/api/models') ? catalog() : syntheticStream('login');
  } }));
  try {
    const person = await client(app), evaluation = await save(person);
    assert.equal((await person.get('/api/config')).environments.find(e => e.id === 'local').enabled, true);
    const response = await post(person, { ...settings, environment: 'local', evaluationIds: [evaluation.id] });
    assert.equal(response.status, 202);
    assert.equal((await waitForRun(person, (await response.json()).id)).items[0].score, 100);
    assert.deepEqual(calls, [environments.local + '/api/models', environments.local + '/api/generate-ideas']);
  } finally { await app.shutdown(); }
});

test('evaluation deletion during a catalog lookup is revalidated before acceptance', async () => {
  let started, release;
  const pending = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const app = await listen(createApp({ dbPath: ':memory:', env: {}, fetchImpl: async url => {
    assert.ok(url.endsWith('/api/models')); started(); await gate; return catalog();
  } }));
  try {
    const person = await client(app), evaluation = await save(person);
    const response = post(person, { ...settings, evaluationIds: [evaluation.id] });
    await pending;
    assert.equal((await person.request('/api/evaluations/' + evaluation.id, { method: 'DELETE' })).status, 200);
    release(); assert.equal((await response).status, 404);
    assert.deepEqual((await person.get('/api/runs')).runs, []); assert.equal((await person.get('/api/session')).budget.reserved, 0);
  } finally { release(); await app.shutdown(); }
});
