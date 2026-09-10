import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, listen, client, syntheticStream, waitForRun, runConfig } from './helpers.mjs';
import { environments } from '../src/evals/run-config.mjs';

const definition = { name: 'Concurrent login', type: 'ideas', html: '<button>Login</button>', method: 'model_grade', criteria: ['login'] };
const deferred = () => Promise.withResolvers();

for (const differentSettings of [false, true]) test(`overlapping runs of one evaluation keep independent evidence with ${differentSettings ? 'different' : 'identical'} settings`, async () => {
  const gates = Array.from({ length: 3 }, deferred), started = Array.from({ length: 3 }, deferred), calls = [], judges = [];
  const app = await listen(createApp({ dbPath: ':memory:', env: { OPENAI_API_KEY: 'mock-judge' }, fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.endsWith('/chat/completions')) {
      judges.push(body);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ checks: [{ id: 'c1', passed: true, reason: 'Login present', evidence: [1] }] }) } }] });
    }
    const index = calls.length;
    calls.push({ url, body }); started[index].resolve(); await gates[index].promise;
    if (index === 1) return new Response('private provider failure', { status: 503 });
    return syntheticStream(`login output ${index}`);
  } }));
  try {
    const person = await client(app), other = await client(app);
    const saved = await (await person.post('/api/evaluations', definition)).json();
    const configs = [runConfig, differentSettings ? { environment: 'dev', generationModel: 'gpt-4o', graderModel: 'gpt-4o' } : runConfig];
    configs.push(configs[1]);
    const runs = [];
    for (const [index, config] of configs.entries()) {
      const response = await person.post('/api/runs', { ...config, evaluationIds: [saved.id], description: `Attempt ${index}` });
      assert.equal(response.status, 202);
      runs.push(await response.json());
      if (index < 2) await started[index].promise;
    }
    assert.equal(new Set(runs.map(run => run.id)).size, 3);
    assert.equal(new Set(runs.map(run => run.items[0].id)).size, 3);
    assert.equal(app.engine.active, 2); assert.equal(app.engine.queue.length, 1); assert.equal(calls.length, 2);
    assert.equal((await person.get('/api/runs/' + runs[2].id)).status, 'queued');
    for (const run of runs) assert.equal((await other.request('/api/runs/' + run.id)).status, 404);
    assert.equal((await other.post('/api/runs', { evaluationIds: [saved.id] })).status, 404);
    assert.equal((await person.post('/api/runs', { evaluationIds: [saved.id, saved.id] })).status, 400);

    // Finish the second attempt first; its failure must free a slot without altering the first.
    gates[1].resolve(); await started[2].promise;
    const failed = await waitForRun(person, runs[1].id);
    assert.equal(failed.items[0].status, 'error'); assert.equal(JSON.stringify(failed).includes('private provider failure'), false);
    assert.equal((await person.get('/api/runs/' + runs[0].id)).items[0].status, 'generating');
    assert.equal((await person.request('/api/evaluations/' + saved.id, { method: 'DELETE' })).status, 409);

    gates[2].resolve(); const third = await waitForRun(person, runs[2].id);
    assert.equal(third.items[0].output, 'login output 2'); assert.equal(third.items[0].score, 100);
    assert.equal((await person.request('/api/evaluations/' + saved.id, { method: 'DELETE' })).status, 409);
    const draining = app.engine.drain(); assert.equal(app.engine.idle, false);
    gates[0].resolve(); await draining;
    const first = await person.get('/api/runs/' + runs[0].id);
    assert.equal(first.status, 'completed'); assert.equal(first.items[0].output, 'login output 0'); assert.equal(first.items[0].score, 100);
    assert.deepEqual(await person.get('/api/runs/' + runs[1].id), failed);
    assert.deepEqual(await person.get('/api/runs/' + runs[2].id), third);
    assert.deepEqual(app.store.evaluation(saved.id, person.scope), saved);
    for (const [index, run] of [first, failed, third].entries()) {
      assert.equal(run.description, `Attempt ${index}`);
      assert.equal(run.settings.environment, configs[index].environment);
      assert.equal(run.items[0].evaluation.model, configs[index].generationModel);
      assert.equal(run.items[0].evaluation.judgeModel, configs[index].graderModel);
      assert.equal(calls[index].url, environments[configs[index].environment] + '/api/generate-ideas');
      assert.equal(calls[index].body.model, configs[index].generationModel);
    }
    assert.equal(calls.length, 3); assert.deepEqual(judges.map(body => body.model), [configs[2].graderModel, configs[0].graderModel]);
    assert.equal((await person.request('/api/evaluations/' + saved.id, { method: 'DELETE' })).status, 200);
  } finally { for (const gate of gates) gate.resolve(); await app.shutdown(); }
});

test('repeated evaluations still respect shared queue capacity and drain every accepted run', async () => {
  const gate = deferred(), started = deferred(); let calls = 0;
  const app = await listen(createApp({ dbPath: ':memory:', env: {}, fetchImpl: async () => {
    calls++; if (calls === 2) started.resolve(); await gate.promise; return syntheticStream('login');
  } }));
  try {
    const person = await client(app);
    const saved = await (await person.post('/api/evaluations', { ...definition, method: 'contains' })).json();
    const runs = Array.from({ length: 100 }, () => app.engine.start([saved.id], person.scope));
    await started.promise;
    assert.equal(app.engine.active, 2); assert.equal(app.engine.queue.length, 98);
    assert.throws(() => app.engine.start([saved.id], person.scope), { status: 429 });
    assert.equal(app.store.runs(person.scope).length, 100); assert.equal(calls, 2);
    const draining = app.engine.drain();
    assert.throws(() => app.engine.start([saved.id], person.scope), { status: 503 });
    gate.resolve(); await draining;
    assert.equal(calls, 100); assert.equal(app.engine.idle, true);
    for (const run of runs) assert.equal(app.store.run(run.id, person.scope).items[0].score, 100);
  } finally { gate.resolve(); await app.shutdown(); }
});
