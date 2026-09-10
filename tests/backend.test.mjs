import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createApp, client, waitForRun, testScope, syntheticStream } from './helpers.mjs';
import { Store } from '../src/evals/store.mjs';
import { validateEvaluation } from '../src/evals/validation.mjs';
import { generateOutput, readTestcraftStream, testcraftRequest } from '../src/evals/providers.mjs';
import { grade } from '../src/evals/graders.mjs';
import { createModelCatalog } from '../src/evals/models.mjs';
import { evaluationMethods, methods } from '../src/evals/methods.mjs';

test('method catalog distinguishes families from implementations and derives family on the server', () => {
  assert.deepEqual(methods, ['model_grade', 'contains', 'not_contains', 'exact_match', 'hybrid']);
  assert.equal(evaluationMethods.model_grade.family, 'model_based');
  assert.equal(evaluationMethods.model_grade.label, 'LLM as a judge');
  for (const method of ['contains', 'not_contains', 'exact_match']) {
    assert.equal(evaluationMethods[method].family, 'rule_based');
    assert.equal(evaluationMethods[method].deterministic, true);
    assert.equal(evaluationMethods[method].gradingCalls, 0);
    const saved = validateEvaluation({ ...base, method, criteria: ['required text'], evaluationFamily: 'model_based' });
    assert.equal(saved.evaluationFamily, 'rule_based'); assert.equal(saved.judgeModel, '');
  }
  assert.equal(validateEvaluation({ ...base, method: 'model_grade', evaluationFamily: 'rule_based' }).evaluationFamily, 'model_based');
  for (const method of ['rule_based', 'model_based', 'llm_as_a_judge', 'unknown', '__proto__']) assert.throws(() => validateEvaluation({ ...base, method }), /evaluation method/);
});

const base = {
  name: 'Login coverage', type: 'ideas', source: 'pasted', method: 'contains', framework: 'playwright', language: 'typescript',
  input: 'Suggest positive and negative login cases.', html: '<form><button>Sign in</button></form>',
  actualOutput: 'A valid user signs in. An invalid password shows an error.', criteria: ['valid user', 'invalid password'],
  model: 'generator-test', judgeModel: 'judge-test', pageUrl: 'https://example.com/login', pom: false, fromIdeas: false,
};

test('two-step payload needs no reference or description and fixes the policy at 80', () => {
  const saved = validateEvaluation({ ...base, input: undefined, framework: undefined, language: undefined, threshold: 1, expectedOutput: 'discard this legacy field', pom: true, fromIdeas: true });
  assert.equal(saved.input, ''); assert.equal(saved.threshold, 80); assert.equal(saved.schemaVersion, 3);
  assert.equal('expectedOutput' in saved, false);
  assert.equal(saved.framework, ''); assert.equal(saved.language, '');
  assert.equal(saved.fromIdeas, false); assert.equal(saved.pom, false);
  assert.equal(saved.model, ''); assert.equal(saved.judgeModel, '');
  assert.deepEqual(saved.criteria, ['valid user', 'invalid password'].map(text => ({ text, method: 'contains', weight: 1 })));
  assert.deepEqual(validateEvaluation({ ...base, criteria: [' one ', ' two '] }).criteria.map(c => c.text), ['one', 'two']);
  assert.equal(validateEvaluation({ ...base, threshold: 100 }).threshold, 80);
  assert.throws(() => validateEvaluation({ ...base, type: 'code', source: 'testcraft_api', pageUrl: '' }), /Page URL/);
  assert.throws(() => validateEvaluation({ ...base, pageUrl: 'javascript:alert(1)' }), /HTTP or HTTPS/);
  assert.throws(() => validateEvaluation({ ...base, type: 'code', source: 'testcraft_api', fromIdeas: true }), /Selected test ideas/);
});

test('criteria are distinct nonempty strings; exact match needs one literal target', () => {
  for (const criteria of ['', 'a\nb', [], [null], [''], ['  '], ['a', ' a '], [42], ['a'.repeat(8001)], ['a'.repeat(4001), 'b'.repeat(4000)], Array.from({ length: 21 }, (_, i) => 'c' + i)]) {
    assert.throws(() => validateEvaluation({ ...base, criteria }));
  }
  assert.throws(() => validateEvaluation({ ...base, method: 'exact_match' }), /exactly one/);
  assert.equal(validateEvaluation({ ...base, method: 'model_grade', judgeModel: '' }).judgeModel, '');
  assert.equal(validateEvaluation({ ...base, method: 'model_grade', judgeModel: 'gpt-5.6-sol' }).judgeModel, 'gpt-5.6-sol');
});

test('existing string-based evaluations still grade with their original reference', async () => {
  const legacy = { ...base, criteria: 'Positive coverage\nNegative coverage', expectedOutput: 'hello\r\nworld' };
  assert.equal((await grade({ ...legacy, method: 'exact_match' }, 'hello\nworld', {})).score, 100);
  assert.equal((await grade(legacy, 'hello', {})).score, 50);
  await grade({ ...legacy, method: 'model_grade' }, 'candidate', { OPENAI_API_KEY: 'test-only' }, async (_url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    assert.equal(input.expectedOutput, legacy.expectedOutput);
    assert.deepEqual(input.criteria.map(c => c.text), ['Positive coverage', 'Negative coverage']);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ checks: input.criteria.map(c => ({ id: c.id, passed: true, evidence: [1], reason: 'Evidence reviewed' })) }) } }] });
  });
});

test('TestCraft catalog uses GET without secrets, caches and coalesces requests, and makes catalog models available for grading', async () => {
  let clock = 0, calls = 0, unavailable = false;
  const getModels = createModelCatalog({ TESTCRAFT_BASE_URL: 'https://testcraft.example/', OPENAI_API_KEY: 'judge-private', TESTCRAFT_OPENAI_API_KEY: 'generation-private' }, async (url, options) => {
    calls++; assert.equal(url, 'https://testcraft.example/api/models'); assert.equal(options.method, 'GET');
    assert.equal(JSON.stringify(options).includes('private'), false); assert.equal(options.body, undefined);
    if (unavailable) throw new Error('provider-private-error');
    return Response.json({ models: [{ id: 'gpt-4o-mini', label: 'GPT-4o mini' }, { id: 'gpt-4o', label: 'GPT-4o' }, { id: 'gpt-4-turbo', label: 'GPT-4 Turbo' }, { id: 'unknown-new-model', label: 'Unverified model' }], default_model: 'gpt-4o-mini', model_selection_enabled: false });
  }, () => clock);
  const results = await Promise.all([getModels(), getModels(), getModels()]);
  assert.equal(calls, 1); assert.equal(results[0].source, 'testcraft'); assert.equal(results[0].warning, null);
  assert.deepEqual(results[0].models.map(m => m.graderCompatible), [true, true, true, true]);
  await getModels(); assert.equal(calls, 1);
  clock = 300001; unavailable = true;
  const stale = await getModels(); assert.equal(calls, 2); assert.match(stale.warning, /last catalog/);
  assert.deepEqual(stale.models, results[0].models); assert.equal(JSON.stringify(stale).includes('private'), false);
});

test('invalid or unavailable model catalogs return no selectable models with an explicit warning', async () => {
  for (const response of [new Response('private', { status: 401 }), Response.json({ models: [] }), Response.json({ models: [{ id: '<script>', label: 'bad' }] }), new Response('not json'), new Response('x'.repeat(64001))]) {
    const getModels = createModelCatalog({ JUDGE_MODEL: 'configured-grader' }, async () => response);
    const result = await getModels();
    assert.equal(result.source, 'unavailable'); assert.match(result.warning, /unavailable/);
    assert.deepEqual(result.models, []);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
});

test('local models API proxies the verified TestCraft catalog and exposes no secret', async () => {
  const app = createApp({ dbPath: ':memory:', env: { OPENAI_API_KEY: 'private-judge' }, fetchImpl: async () => Response.json({ models: [{ id: 'gpt-4o-mini', label: 'GPT-4o mini' }] }) });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  try {
    const participant = await client(app);
    const res = await participant.request('/api/models');
    assert.equal(res.status, 200); assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json(); assert.equal(body.models[0].id, 'gpt-4o-mini');
    assert.equal(JSON.stringify(body).includes('private-judge'), false);
    const config = await participant.get('/api/config');
    assert.deepEqual(config.evaluationMethods, evaluationMethods);
    assert.equal(JSON.stringify(config).includes('private-judge'), false);
  } finally { await new Promise(resolve => app.server.close(resolve)); }
});
test('reruns use the global policy without modifying saved legacy cases or historical evidence', async () => {
  const app = createApp({ dbPath: ':memory:', env: {} });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  try {
    const participant = await client(app), scope = participant.scope;
    const legacy = app.store.create({ ...base, criteria: 'Positive coverage\nNegative coverage', expectedOutput: 'valid user\ninvalid password', threshold: 20, actualOutput: 'valid user' }, scope);
    const oldRun = { id: 'historical-run', createdAt: '2025-01-01', status: 'completed', items: [{ evaluationId: legacy.id, evaluation: legacy, status: 'passed', score: 50, checks: [], events: [] }] };
    app.store.saveRun(oldRun, scope);
    const run = await waitForRun(participant, app.engine.start([legacy.id], scope).id);
    assert.equal(run.items[0].score, 50); assert.equal(run.items[0].status, 'failed');
    assert.equal(run.items[0].evaluation.threshold, 80);
    assert.equal(app.store.evaluation(legacy.id, scope).threshold, 20);
    assert.deepEqual(app.store.run(oldRun.id, scope), oldRun);
  } finally { await new Promise(resolve => app.server.close(resolve)); }
});

test('evaluations and real grading results survive server restart; batches keep independent snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'testcraft-backend-'));
  const dbPath = join(dir, 'evals.sqlite');
  let app;
  try {
    let generation = 0;
    app = createApp({ dbPath, env: {}, fetchImpl: async () => syntheticStream(generation++ ? 'valid user only' : 'valid user; invalid password') }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const participant = await client(app), { post, scope } = participant;
    assert.deepEqual((await participant.get('/api/evaluations')).evaluations, []);
    const first = await (await post('/api/evaluations', base)).json();
    const second = await (await post('/api/evaluations', { ...base, name: 'Missing negative test', actualOutput: 'valid user only' })).json();
    assert.equal((await post('/api/evaluations', { ...base, html: '', threshold: 110 })).status, 400);
    assert.equal((await post('/api/runs', { evaluationIds: [first.id, 'unknown'] })).status, 404);
    assert.equal((await post('/api/runs', { evaluationIds: [first.id, first.id] })).status, 400);
    const started = await (await post('/api/runs', { evaluationIds: [first.id, second.id] })).json();
    const result = await waitForRun(participant, started.id);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.items.map(item => [item.status, item.score]), [['passed',100],['failed',50]]);
    assert.equal(result.items[1].checks[1].evidence, 'Missing: invalid password');
    assert.equal(result.items[0].evaluation.html, base.html);
    assert.equal((await fetch(url + '/.env')).status, 404);
    const invalidOrigin = await fetch(url + '/api/evaluations', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://unrelated.invalid' }, body: JSON.stringify(base) });
    assert.equal(invalidOrigin.status, 403);
    await new Promise(resolve => app.server.close(resolve)); app = null;
    const reopened = new Store(dbPath);
    assert.equal(reopened.evaluations(scope).length, 2);
    assert.equal(reopened.run(result.id, scope).items[0].score, 100); reopened.close();
  } finally {
    if (app) await new Promise(resolve => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('unfinished runs are marked interrupted after a restart without repeating model calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'testcraft-restart-'));
  const dbPath = join(dir, 'evals.sqlite');
  let app;
  try {
    const store = new Store(dbPath);
    store.saveRun({ id: 'interrupted-run', status: 'running', items: [{ status: 'grading', output: 'already generated', score: null, events: [] }, { status: 'passed', score: 100, events: [] }], createdAt: '2026-01-01' }, testScope);
    store.close();
    let calls = 0;
    app = createApp({ dbPath, env: {}, fetchImpl: async () => { calls++; throw new Error('Must not replay'); } });
    assert.equal(app.store.run('interrupted-run', testScope).status, 'running', 'opening the DB alone must not interrupt another server');
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const recovered = app.store.run('interrupted-run', testScope);
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.items[0].status, 'error');
    assert.equal(recovered.items[0].output, 'already generated');
    assert.equal(recovered.items[0].score, null);
    assert.match(recovered.items[0].events[0].message, /Server restarted/);
    assert.equal(recovered.items[1].status, 'passed');
    assert.equal(recovered.items[1].score, 100);
    assert.equal(calls, 0);
  } finally {
    if (app) await new Promise(resolve => app.server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

test('exact and contains grading are computed from output, never scenario ids', async () => {
  assert.equal((await grade({ ...base, method: 'exact_match', criteria: ['hello\r\nworld'] }, 'hello\nworld', {})).score, 100);
  assert.equal((await grade({ ...base, method: 'exact_match', criteria: ['hello'] }, 'unrelated', {})).score, 0);
  assert.equal((await grade(base, 'invalid password', {})).score, 50);
  assert.throws(() => validateEvaluation({ ...base, type: 'code', framework: 'cypress', language: 'python' }), /combination/);
});

test('Does not contain scores absent fragments locally with explicit per-fragment evidence', async () => {
  const e = { ...base, method: 'not_contains', criteria: ['waitForTimeout', 'TODO'] };
  const noModel = async () => { throw new Error('Rule-based grading must not call a model'); };
  const good = await grade(e, 'await expect(button).toBeVisible();', {}, noModel);
  assert.equal(good.score, 100); assert.equal(good.judgeModel, null);
  assert.deepEqual(good.checks.map(c => c.score), [100, 100]);
  assert.equal(good.checks[0].evidence, 'Not found: waitForTimeout');
  const weak = await grade(e, '// TODO: implement assertions', {}, noModel);
  assert.equal(weak.score, 50); assert.equal(weak.checks[1].evidence, 'Forbidden fragment found: TODO');
  assert.match(weak.checks[1].reason, /does not prove/);
  assert.equal((await grade(e, 'waitForTimeout(3000); // TODO', {}, noModel)).score, 0);
  assert.equal((await grade(e, '// todo', {}, noModel)).score, 100, 'Matching is explicitly case-sensitive, not semantic');
  for (let i = 0; i < 3; i++) assert.deepEqual(await grade(e, '// TODO: implement assertions', {}, noModel), weak);
  const literal = await grade({ ...e, criteria: ['.*'] }, 'ordinary text', {}, noModel);
  assert.equal(literal.score, 100, 'Text is never interpreted as a regular expression or executable code');
});

test('an unknown grader never silently falls back to a paid model judge', async () => {
  let calls = 0;
  for (const method of ['unknown', 'rule_based', '__proto__']) await assert.rejects(grade({ ...base, method }, 'output', { OPENAI_API_KEY: 'test-only' }, async () => { calls++; }), /Invalid evaluation method/);
  assert.equal(calls, 0);
});

test('TestCraft v1 uses the verified payload and handles arbitrarily fragmented UTF-8 SSE', async () => {
  const evaluation = { ...base, type: 'code', source: 'testcraft_api', fromIdeas: true, ideas: 'Log in successfully\nReject an empty password' };
  const contract = testcraftRequest(evaluation);
  assert.equal(contract.path, '/api/automate-tests-ideas');
  assert.equal(contract.payload.sourceCode, evaluation.html);
  assert.deepEqual(contract.payload.ideas, ['Log in successfully', 'Reject an empty password']);
  assert.equal(contract.payload.expectedOutput, undefined);
  assert.equal(contract.payload.criteria, undefined);
  const streamText = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'Prueba ñ ✓' }, finish_reason: null }] }) + '\r\n\r\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n';
  const bytes = new TextEncoder().encode(streamText);
  const mockFetch = async (url, options) => {
    assert.equal(url, 'https://testcraft.example/api/automate-tests-ideas');
    const body = JSON.parse(options.body);
    assert.equal(body.openAiApiKey, undefined, 'judge key must not be forwarded');
    return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  };
  const actual = await generateOutput(evaluation, { TESTCRAFT_BASE_URL: 'https://testcraft.example', OPENAI_API_KEY: 'judge-only' }, mockFetch);
  assert.equal(actual.output, 'Prueba ñ ✓');
  assert.equal(testcraftRequest({ ...evaluation, fromIdeas: false }).path, '/api/automate-tests');
  assert.equal(testcraftRequest({ ...evaluation, type: 'ideas' }).path, '/api/generate-ideas');
  await assert.rejects(readTestcraftStream(new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')), /complete output/);
});

test('real judge request includes rubric and validates each verdict; missing credentials never produce fake grades', async () => {
  const evaluation = { ...base, method: 'model_grade' };
  let calls = 0;
  const mockFetch = async (url, options) => {
    calls++; assert.equal(url, 'https://llm.example/v1/chat/completions');
    const body = JSON.parse(options.body), input = JSON.parse(body.messages[1].content);
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal('expectedOutput' in input, false); assert.deepEqual(input.actualOutputLines, [{ line: 1, text: 'candidate' }]);
    assert.equal(input.criteria.length, 2);
    return Response.json({ model: 'judge-test', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ checks: [{ id: 'c1', passed: true, evidence: [1], reason: 'Covered' }, { id: 'c2', passed: false, evidence: 'No negative case', reason: 'Missing' }] }) } }] });
  };
  const result = await grade(evaluation, 'candidate', { OPENAI_API_KEY: 'test-only', OPENAI_BASE_URL: 'https://llm.example/v1' }, mockFetch);
  assert.equal(result.score, 50); assert.equal(calls, 1);
  await assert.rejects(grade(evaluation, 'candidate', {}, mockFetch), /OPENAI_API_KEY/);
  assert.equal(calls, 1);
  await assert.rejects(grade(evaluation, 'candidate', { OPENAI_API_KEY: 'test' }, async () => Response.json({ choices: [{ message: { content: '{"checks":[]}' } }] })), /each criterion/);
});

test('generator never receives expected output or grading criteria', async () => {
  const evaluation = { ...base, source: 'llm', type: 'code', method: 'model_grade' };
  await generateOutput(evaluation, { OPENAI_API_KEY: 'test-only' }, async (_url, options) => {
    const body = JSON.parse(options.body), input = JSON.parse(body.messages[1].content);
    assert.equal(input.expectedOutput, undefined); assert.equal(input.criteria, undefined);
    assert.equal(input.html, base.html); assert.equal(input.input, base.input);
    assert.match(body.messages[0].content, /playwright.*typescript/);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'generated code' } }] });
  });
});

test('API run integrates TestCraft generation with model grading, rejects duplicate selections and stores evidence', async () => {
  let releaseGeneration;
  const gate = new Promise(resolve => { releaseGeneration = resolve; });
  const calls = [];
  const mockFetch = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    if (url === 'https://api.testcraft.app/api/generate-ideas') {
      await gate;
      assert.equal(body.sourceCode, base.html);
      assert.equal(body.openAiApiKey, 'generation-key');
      assert.equal(body.expectedOutput, undefined);
      return new Response('data: {"choices":[{"delta":{"content":"valid user; invalid password"},"finish_reason":"stop"}]}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    assert.equal(url, 'https://judge.example/v1/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer judge-key');
    const input = JSON.parse(body.messages[1].content);
    assert.deepEqual(input.actualOutputLines, [{ line: 1, text: 'valid user; invalid password' }]);
    assert.equal('expectedOutput' in input, false);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ checks: input.criteria.map(c => ({ id: c.id, passed: true, evidence: [1], reason: 'Both behaviors covered.' })) }) }, finish_reason: 'stop' }] });
  };
  const app = createApp({ dbPath: ':memory:', env: { TESTCRAFT_BASE_URL: 'https://testcraft.example', TESTCRAFT_OPENAI_API_KEY: 'generation-key', OPENAI_BASE_URL: 'https://judge.example/v1', OPENAI_API_KEY: 'judge-key' }, fetchImpl: mockFetch });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const participant = await client(app), { post } = participant;
  let runId;
  try {
    const evaluation = await (await post('/api/evaluations', { ...base, source: 'testcraft_api', method: 'model_grade' })).json();
    assert.equal(calls.length, 0, 'saving must not call a model');
    const started = await (await post('/api/runs', { evaluationIds: [evaluation.id] })).json(); runId = started.id;
    assert.equal((await post('/api/runs', { evaluationIds: [evaluation.id, evaluation.id] })).status, 400);
    releaseGeneration();
    const run = await waitForRun(participant, runId);
    assert.equal(run.items[0].status, 'passed'); assert.equal(run.items[0].score, 100);
    assert.equal(run.items[0].checks.length, 2); assert.equal(calls.length, 2);
    assert.equal(run.items[0].output, 'valid user; invalid password');
    assert.equal(JSON.stringify(run).includes('judge-key'), false);
    assert.equal(JSON.stringify(run).includes('generation-key'), false);
  } finally {
    releaseGeneration();
    if (runId) await waitForRun(participant, runId);
    await new Promise(resolve => app.server.close(resolve));
  }
});

test('missing judge key prevents generation; provider failures remain errors without grades', async () => {
  for (const missingJudge of [true, false]) {
    let calls = 0;
    const app = createApp({ dbPath: ':memory:', env: {}, fetchImpl: async () => { calls++; return new Response('provider-private-error', { status: 429 }); } });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const url = `http://127.0.0.1:${app.server.address().port}`;
    try {
      const participant = await client(app);
      const evaluation = app.store.create(validateEvaluation({ ...base, source: 'testcraft_api', method: missingJudge ? 'model_grade' : 'contains' }), participant.scope);
      const run = await waitForRun(participant, app.engine.start([evaluation.id], participant.scope).id);
      assert.equal(run.items[0].status, 'error'); assert.equal(run.items[0].score, null);
      assert.equal(calls, missingJudge ? 0 : 1);
      assert.match(run.items[0].error, missingJudge ? /OPENAI_API_KEY/ : /HTTP 429/);
      assert.equal(JSON.stringify(run).includes('provider-private-error'), false);
    } finally { await new Promise(resolve => app.server.close(resolve)); }
  }
});

test('HTTP validates malformed bodies and preserves multibyte text across request chunks', async () => {
  const app = createApp({ dbPath: ':memory:', env: {} });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}`;
  try {
    for (const body of ['null', '{}', '{']) {
      const participant = await client(app);
      assert.equal((await participant.request('/api/runs', { method: 'POST', body })).status, 400);
    }
    const participant = await client(app);
    assert.equal((await participant.request('/api/evaluations', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status, 415);
    const input = 'Prueba español ñ ✓ 😀';
    const bytes = Buffer.from(JSON.stringify({ ...base, input }));
    const response = await new Promise((resolve, reject) => {
      const req = httpRequest(url + '/api/evaluations', { method: 'POST', headers: participant.headers }, res => {
        const chunks = [];
        res.on('data', data => chunks.push(data));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      let offset = 0;
      function writeByte() {
        if (offset === bytes.length) return req.end();
        req.write(bytes.subarray(offset, ++offset));
        setImmediate(writeByte);
      }
      writeByte();
    });
    assert.equal(response.status, 201); assert.equal(response.body.input, input);
  } finally { await new Promise(resolve => app.server.close(resolve)); }
});
