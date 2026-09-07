import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server.mjs';
import { Store } from '../src/evals/store.mjs';
import { validateEvaluation } from '../src/evals/validation.mjs';
import { generateOutput, readTestcraftStream, testcraftRequest } from '../src/evals/providers.mjs';
import { grade } from '../src/evals/graders.mjs';

const base = {
  name: 'Login coverage', type: 'ideas', source: 'pasted', method: 'contains', framework: 'playwright', language: 'typescript',
  input: 'Suggest positive and negative login cases.', html: '<form><button>Sign in</button></form>', expectedOutput: 'valid user\ninvalid password',
  actualOutput: 'A valid user signs in. An invalid password shows an error.', criteria: 'Positive coverage\nNegative coverage', threshold: 80,
  model: 'generator-test', judgeModel: 'judge-test', pageUrl: 'https://example.com/login', pom: false, fromIdeas: false,
};
async function waitForRun(url, id) {
  for (let count = 0; count < 100; count++) {
    const run = await (await fetch(`${url}/api/runs/${id}`)).json();
    if (!['running','queued'].includes(run.status)) return run;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Evaluation did not finish');
}

test('evaluations and real grading results survive server restart; batches keep independent snapshots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'testcraft-backend-'));
  const dbPath = join(dir, 'evals.sqlite');
  let app;
  try {
    app = createApp({ dbPath, env: {} }); app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const post = (path, body) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.deepEqual((await (await fetch(url + '/api/evaluations')).json()).evaluations, []);
    const first = await (await post('/api/evaluations', base)).json();
    const second = await (await post('/api/evaluations', { ...base, name: 'Missing negative test', actualOutput: 'valid user only' })).json();
    assert.equal((await post('/api/evaluations', { ...base, html: '', threshold: 110 })).status, 400);
    assert.equal((await post('/api/runs', { evaluationIds: [first.id, 'unknown'] })).status, 404);
    assert.equal((await post('/api/runs', { evaluationIds: [first.id, first.id] })).status, 400);
    const started = await (await post('/api/runs', { evaluationIds: [first.id, second.id] })).json();
    const result = await waitForRun(url, started.id);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.items.map(item => [item.status, item.score]), [['passed',100],['failed',50]]);
    assert.equal(result.items[1].checks[1].evidence, 'Missing: invalid password');
    assert.equal(result.items[0].evaluation.html, base.html);
    assert.equal((await fetch(url + '/.env')).status, 404);
    const invalidOrigin = await fetch(url + '/api/evaluations', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://unrelated.invalid' }, body: JSON.stringify(base) });
    assert.equal(invalidOrigin.status, 403);
    await new Promise(resolve => app.server.close(resolve)); app = null;
    const reopened = new Store(dbPath);
    assert.equal(reopened.evaluations().length, 2);
    assert.equal(reopened.run(result.id).items[0].score, 100); reopened.close();
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
    store.saveRun({ id: 'interrupted-run', status: 'running', items: [{ status: 'grading', output: 'already generated', score: null, events: [] }, { status: 'passed', score: 100, events: [] }], createdAt: '2026-01-01' });
    store.close();
    let calls = 0;
    app = createApp({ dbPath, env: {}, fetchImpl: async () => { calls++; throw new Error('Must not replay'); } });
    assert.equal(app.store.run('interrupted-run').status, 'running', 'opening the DB alone must not interrupt another server');
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    const recovered = app.store.run('interrupted-run');
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
  assert.equal((await grade({ ...base, method: 'exact_match', expectedOutput: 'hello\r\nworld' }, 'hello\nworld', {})).score, 100);
  assert.equal((await grade({ ...base, method: 'exact_match' }, 'unrelated', {})).score, 0);
  assert.equal((await grade(base, 'invalid password', {})).score, 50);
  assert.throws(() => validateEvaluation({ ...base, framework: 'cypress', language: 'python' }), /combination/);
});

test('TestCraft v1 uses the verified payload and handles arbitrarily fragmented UTF-8 SSE', async () => {
  const evaluation = { ...base, type: 'code', source: 'testcraft_api', fromIdeas: true };
  const contract = testcraftRequest(evaluation);
  assert.equal(contract.path, '/api/automate-tests-ideas');
  assert.equal(contract.payload.sourceCode, evaluation.html);
  assert.deepEqual(contract.payload.ideas, [evaluation.input]);
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

test('real judge request includes rubric and validates each score; missing credentials never produce fake grades', async () => {
  const evaluation = { ...base, method: 'model_grade' };
  let calls = 0;
  const mockFetch = async (url, options) => {
    calls++; assert.equal(url, 'https://llm.example/v1/chat/completions');
    const body = JSON.parse(options.body), input = JSON.parse(body.messages[1].content);
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(input.expectedOutput, evaluation.expectedOutput); assert.equal(input.actualOutput, 'candidate');
    assert.equal(input.criteria.length, 2);
    return Response.json({ model: 'judge-test', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ checks: [{ id: 'c1', score: 90, evidence: 'valid user', reason: 'Covered' }, { id: 'c2', score: 30, evidence: 'No negative case', reason: 'Missing' }] }) } }] });
  };
  const result = await grade(evaluation, 'candidate', { OPENAI_API_KEY: 'test-only', OPENAI_BASE_URL: 'https://llm.example/v1' }, mockFetch);
  assert.equal(result.score, 60); assert.equal(calls, 1);
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

test('API run integrates TestCraft generation with model grading, rejects duplicates and stores evidence', async () => {
  let releaseGeneration;
  const gate = new Promise(resolve => { releaseGeneration = resolve; });
  const calls = [];
  const mockFetch = async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    if (url === 'https://testcraft.example/api/generate-ideas') {
      await gate;
      assert.equal(body.sourceCode, base.html);
      assert.equal(body.openAiApiKey, 'generation-key');
      assert.equal(body.expectedOutput, undefined);
      return new Response('data: {"choices":[{"delta":{"content":"valid user; invalid password"},"finish_reason":"stop"}]}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }
    assert.equal(url, 'https://judge.example/v1/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer judge-key');
    const input = JSON.parse(body.messages[1].content);
    assert.equal(input.actualOutput, 'valid user; invalid password');
    assert.equal(input.expectedOutput, base.expectedOutput);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ checks: input.criteria.map(c => ({ id: c.id, score: 90, evidence: 'valid user; invalid password', reason: 'Both behaviors covered.' })) }) }, finish_reason: 'stop' }] });
  };
  const app = createApp({ dbPath: ':memory:', env: { TESTCRAFT_BASE_URL: 'https://testcraft.example', TESTCRAFT_OPENAI_API_KEY: 'generation-key', OPENAI_BASE_URL: 'https://judge.example/v1', OPENAI_API_KEY: 'judge-key' }, fetchImpl: mockFetch });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, body) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let runId;
  try {
    const evaluation = await (await post('/api/evaluations', { ...base, source: 'testcraft_api', method: 'model_grade' })).json();
    assert.equal(calls.length, 0, 'saving must not call a model');
    const started = await (await post('/api/runs', { evaluationIds: [evaluation.id] })).json(); runId = started.id;
    assert.equal((await post('/api/runs', { evaluationIds: [evaluation.id] })).status, 409);
    releaseGeneration();
    const run = await waitForRun(url, runId);
    assert.equal(run.items[0].status, 'passed'); assert.equal(run.items[0].score, 90);
    assert.equal(run.items[0].checks.length, 2); assert.equal(calls.length, 2);
    assert.equal(run.items[0].output, 'valid user; invalid password');
    assert.equal(JSON.stringify(run).includes('judge-key'), false);
    assert.equal(JSON.stringify(run).includes('generation-key'), false);
  } finally {
    releaseGeneration();
    if (runId) await waitForRun(url, runId);
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
      const evaluation = app.store.create(validateEvaluation({ ...base, source: 'testcraft_api', method: missingJudge ? 'model_grade' : 'contains' }));
      const run = await waitForRun(url, app.engine.start([evaluation.id]).id);
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
      assert.equal((await fetch(url + '/api/runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body })).status, 400);
    }
    assert.equal((await fetch(url + '/api/evaluations', { method: 'POST', body: '{}' })).status, 415);
    const input = 'Prueba español ñ ✓ 😀';
    const bytes = Buffer.from(JSON.stringify({ ...base, input }));
    const response = await new Promise((resolve, reject) => {
      const req = httpRequest(url + '/api/evaluations', { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
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
