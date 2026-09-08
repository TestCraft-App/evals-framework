import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as workshop from '../src/evals/workshop.mjs';
import { validateEvaluation, PASS_THRESHOLD } from '../src/evals/validation.mjs';
import { needsModelGrader } from '../src/evals/methods.mjs';
import { Engine } from '../src/evals/engine.mjs';
import { Store } from '../src/evals/store.mjs';

const { workshopSuite } = workshop;
const scope = { ownerId: 'workshop-test-participant', workshopId: 'workshop-test' };
const payloadFields = ['name', 'type', 'framework', 'language', 'source', 'method', 'model', 'judgeModel', 'pageUrl', 'pom', 'fromIdeas', 'ideas', 'input', 'html', 'criteria'].sort();
const callsPerCase = [1, 1, 1, 2, 1, 2, 2, 1];
const testcraftBaseUrl = 'https://testcraft.invalid';
const judgeBaseUrl = 'https://judge.invalid/v1';

// Provider responses exist only in tests, never in the runtime workshop dataset.
// This mock implements one scenario; assertions below inspect actual run results,
// not scores attached to template names.
const mockCode = [
  '// Mock streamed response · café',
  "import { test, expect } from '@playwright/test';",
  "test('login', async ({ page }) => {",
  "  await page.goto('https://www.saucedemo.com');",
  "  await page.getByLabel('Username').fill('workshop_user');",
  "  await page.getByLabel('Password').fill('workshop_password');",
  "  await page.getByRole('button', { name: 'Login' }).click();",
  "  await expect(page).toHaveURL('https://www.saucedemo.com/inventory.html');",
  '});',
].join('\n');
const mockIdeas = [
  'Mock streamed response · café',
  'Fill Username and Password with workshop_user / workshop_password, submit Login; expect /inventory.html and a visible Products heading.',
  'Use workshop_user / wrong_password, submit Login; expect a visible Invalid credentials (synthetic). alert.',
  'Fill Username with workshop_user, leave Password empty, submit Login; expect a visible Password is required (synthetic). alert.',
].join('\n');

function sse(output, complete = true) {
  const frame = content => 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n';
  const middle = Math.floor(output.length / 2);
  const bytes = new TextEncoder().encode(frame(output.slice(0, middle)) + frame(output.slice(middle)) + (complete ? 'data: [DONE]\n\n' : ''));
  // Exercise the real stream reader with frame boundaries and a split UTF-8 code point.
  const accent = bytes.indexOf(0xc3);
  const split = accent >= 0 ? accent + 1 : Math.floor(bytes.length / 2);
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, split));
      controller.enqueue(bytes.slice(split));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

function harness(t, { limit = 200, output, verdict, complete = true, env = {} } = {}) {
  const unintendedFetch = t.mock.method(globalThis, 'fetch', () => assert.fail('No real network is allowed in workshop tests.'));
  const store = new Store(':memory:');
  const requests = [];
  const engine = new Engine(store, {
    TESTCRAFT_BASE_URL: testcraftBaseUrl, OPENAI_BASE_URL: judgeBaseUrl,
    OPENAI_API_KEY: 'mock-judge-key', ...env,
  }, async (url, options) => {
    const request = { url: String(url), options, body: JSON.parse(options.body) };
    requests.push(request);
    if (request.url.startsWith(testcraftBaseUrl + '/api/')) {
      request.output = typeof output === 'function' ? output(request, requests.length) : output ?? (request.url.endsWith('/generate-ideas') ? mockIdeas : mockCode);
      return sse(request.output, complete);
    }
    assert.equal(request.url, judgeBaseUrl + '/chat/completions');
    const context = JSON.parse(request.body.messages.find(message => message.role === 'user').content);
    request.verdicts = context.criteria.map((criterion, index) => {
      if (verdict) return { id: criterion.id, ...verdict(context, index) };
      const passed = context.type === 'ideas' || (context.criteria.length > 1 && index === 0);
      return passed
        ? { id: criterion.id, passed: true, evidence: context.type === 'ideas' ? [2, 3, 4] : [5, 6, 7], reason: 'The cited lines demonstrate the described actions.' }
        : { id: criterion.id, passed: false, evidence: 'The output omits the required heading or negative-scenario assertions.', reason: 'The complete criterion is not demonstrated by this output.' };
    });
    return Response.json({ model: 'gpt-4o-mini', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ checks: request.verdicts }) } }] });
  }, limit);
  t.after(async () => {
    await engine.drain();
    store.close();
    assert.equal(unintendedFetch.mock.callCount(), 0);
  });
  return { store, engine, requests };
}

function expectedGeneration(evaluation) {
  if (evaluation.type === 'ideas') return { path: '/api/generate-ideas', body: { sourceCode: evaluation.html, stream: true } };
  return {
    path: evaluation.fromIdeas ? '/api/automate-tests-ideas' : '/api/automate-tests',
    body: {
      sourceCode: evaluation.html, stream: true, baseUrl: evaluation.pageUrl,
      framework: 'playwright', language: 'typescript', pom: evaluation.pom,
      ...(evaluation.fromIdeas ? { ideas: evaluation.ideas.split('\n') } : {}),
    },
  };
}

function assertInputDefinition(evaluation) {
  assert.equal(evaluation.actualOutput ?? '', '', 'Saved API definitions contain no generated answer');
  for (const field of ['output', 'score', 'checks', 'results', 'runs', 'status']) assert.equal(Object.hasOwn(evaluation, field), false, field);
}

test('runtime workshop exports eight input-only templates with no completed outputs or promised results', () => {
  assert.deepEqual(Object.keys(workshop), ['workshopSuite']);
  assert.deepEqual(Object.keys(workshopSuite).sort(), ['evaluations', 'name']);
  assert.equal(workshopSuite.name, 'SauceDemo · TestCraft workshop');
  assert.equal(workshopSuite.evaluations.length, 8);
  assert.equal(new Set(workshopSuite.evaluations.map(evaluation => evaluation.name)).size, 8);
  assert.deepEqual(JSON.parse(JSON.stringify(workshopSuite)), workshopSuite);
  assert.ok(Buffer.byteLength(JSON.stringify(workshopSuite), 'utf8') < 60000);
  for (const evaluation of workshopSuite.evaluations) {
    assert.deepEqual(Object.keys(evaluation).sort(), payloadFields);
    assert.equal(Object.getPrototypeOf(evaluation), Object.prototype);
    assert.equal(evaluation.source, 'testcraft_api');
    assert.equal(evaluation.model, '');
    assert.equal(evaluation.pageUrl, 'https://www.saucedemo.com');
    assert.match(evaluation.input, /synthetic, simplified/i);
    assert.match(evaluation.input, /description is not sent to TestCraft/i);
    assert.match(evaluation.html, /<!-- Synthetic, simplified fixture inspired by SauceDemo; not live HTML\./);
    assert.match(evaluation.html, /workshop_user \/ workshop_password/);
    assert.match(evaluation.html, /wrong_password/);
    assert.match(evaluation.html, /data-workshop-state="missing-password"/);
    assert.doesNotMatch(evaluation.name, /weak|strong|candidate|complete|incomplete|false positive|fixed label|\d+\/100/i);
    assert.ok(evaluation.name.length <= 140 && evaluation.input.length <= 1200 && evaluation.html.length <= 3000);
    assertInputDefinition(evaluation);
    assert.equal(Object.hasOwn(evaluation, 'actualOutput'), false);
    assert.ok(evaluation.criteria.length >= 1 && evaluation.criteria.length <= 3);
    assert.equal(evaluation.judgeModel, needsModelGrader(evaluation) ? 'gpt-4o-mini' : '');
    assert.equal(Boolean(evaluation.ideas), evaluation.fromIdeas);
    if (evaluation.fromIdeas) {
      assert.equal(evaluation.type, 'code');
      assert.equal(evaluation.ideas.split('\n').length, 3);
      assert.ok(evaluation.ideas.split('\n').every(idea => idea.startsWith('Test ')));
    }
    for (const criterion of evaluation.criteria) {
      assert.deepEqual(Object.keys(criterion).sort(), ['method', 'text', 'weight']);
      assert.ok(['contains', 'not_contains', 'model_grade'].includes(criterion.method));
      assert.ok(criterion.text.trim() && Number.isFinite(criterion.weight) && criterion.weight > 0);
      if (evaluation.method !== 'hybrid') assert.equal(criterion.method, evaluation.method);
    }
  }
  assert.deepEqual(new Set(workshopSuite.evaluations.map(evaluation => expectedGeneration(evaluation).path)),
    new Set(['/api/generate-ideas', '/api/automate-tests', '/api/automate-tests-ideas']));
  assert.ok(workshopSuite.evaluations.some(evaluation => evaluation.pom));
});

test('templates validate without mutation and reserve eight generations plus three judges', () => {
  const before = JSON.stringify(workshopSuite);
  assert.equal(PASS_THRESHOLD, 80);
  for (const evaluation of workshopSuite.evaluations) {
    const canonical = validateEvaluation(evaluation);
    assert.equal(canonical.schemaVersion, 3);
    assert.equal(canonical.threshold, 80);
    assertInputDefinition(canonical);
    for (const field of payloadFields) assert.deepEqual(canonical[field], evaluation[field], evaluation.name + ': ' + field);
  }
  assert.equal(JSON.stringify(workshopSuite), before);
  assert.deepEqual(workshopSuite.evaluations.map(evaluation => 1 + Number(needsModelGrader(evaluation))), callsPerCase);
  assert.equal(workshopSuite.evaluations.filter(evaluation => !needsModelGrader(evaluation)).length, 5);
  assert.equal(callsPerCase.reduce((sum, calls) => sum + calls, 0), 11);
});

test('loading, importing, creating, and saving definitions make no provider calls or runs', async t => {
  const { store, engine, requests } = harness(t);
  const module = await import('../src/evals/workshop.mjs?input-only-contract');
  const imported = store.importWorkshop(module.workshopSuite, scope);
  const saved = store.create(validateEvaluation(workshopSuite.evaluations[0]), scope);
  const edited = store.updateEvaluation(saved.id, validateEvaluation({ ...saved, name: 'Participant edit' }), saved.revision, scope);
  assert.equal(edited.revision, 2);
  assert.equal(imported.suite.seedKey, 'workshop-v2-live');
  assert.equal(imported.evaluations.length, 8);
  assert.ok(store.evaluations(scope).every(evaluation => { assertInputDefinition(evaluation); return true; }));
  assert.deepEqual(store.runs(scope), []);
  assert.deepEqual(requests, []);
  assert.equal(engine.idle, true);
  assert.deepEqual(store.budget(scope.workshopId, 200), { limit: 200, used: 0, reserved: 0, remaining: 200, unit: 'model_calls' });
});

for (const [index, fixture] of workshopSuite.evaluations.entries()) {
  test(fixture.name + ': Engine generates from real API payload then grades and stores only the run output', async t => {
    const { store, engine, requests } = harness(t);
    const saved = store.create(validateEvaluation(fixture), scope);
    const before = structuredClone(saved);
    const run = engine.start([saved.id], scope);
    assert.equal(store.budget(scope.workshopId, 200).reserved, callsPerCase[index]);
    assert.equal(requests.length, 0);
    assert.equal(store.run(run.id, scope).items[0].output, null);
    await engine.drain();
    const result = store.run(run.id, scope);
    assert.equal(result.status, 'completed');
    const item = result.items[0];
    assert.ok(['passed', 'failed'].includes(item.status), item.error);
    assert.equal(requests.length, callsPerCase[index]);
    const generation = requests[0], expected = expectedGeneration(saved);
    assert.equal(generation.url, testcraftBaseUrl + expected.path);
    assert.equal(generation.options.method, 'POST');
    assert.deepEqual(generation.options.headers, { 'content-type': 'application/json' });
    assert.deepEqual(generation.body, expected.body, 'Description, criteria, judge settings, and answers must not leak into generation');
    assert.equal(item.output, generation.output);
    assert.match(item.output, /café/, 'Fragmented SSE preserves UTF-8');
    assert.equal(item.outputSource, 'TestCraft v1 · ' + expected.path);
    assert.equal(item.generationModel, 'API default');
    assert.deepEqual(store.evaluation(saved.id, scope), before);
    assert.deepEqual(item.evaluation, before, 'The run snapshot also preserves the input-only definition');
    assertInputDefinition(item.evaluation);

    if (needsModelGrader(saved)) {
      const judge = requests[1];
      assert.equal(judge.url, judgeBaseUrl + '/chat/completions');
      assert.equal(judge.body.model, 'gpt-4o-mini');
      assert.equal(judge.body.store, false);
      assert.equal(judge.body.response_format.json_schema.strict, true);
      const branches = judge.body.response_format.json_schema.schema.properties.checks.items.anyOf;
      assert.equal(branches.find(branch => branch.properties.passed.enum[0]).properties.evidence.type, 'array');
      assert.equal(branches.find(branch => !branch.properties.passed.enum[0]).properties.evidence.type, 'string');
      const context = JSON.parse(judge.body.messages.find(message => message.role === 'user').content);
      assert.equal(context.task, saved.input);
      assert.equal(context.html, saved.html);
      assert.equal(context.pageUrl, saved.pageUrl);
      assert.deepEqual(context.actualOutputLines, item.output.split('\n').map((text, line) => ({ line: line + 1, text })));
      assert.deepEqual(context.criteria, saved.criteria.map((criterion, criterionIndex) => ({ ...criterion, id: 'c' + (criterionIndex + 1) }))
        .filter(criterion => criterion.method === 'model_grade').map(({ id, text }) => ({ id, text })));
      if (saved.type === 'code') assert.equal(context.ideas, saved.ideas);
      for (const verdict of judge.verdicts) {
        const check = item.checks.find(check => check.id === verdict.id);
        assert.equal(check.passed, verdict.passed);
        assert.equal(check.reason, verdict.reason);
        if (verdict.passed) {
          assert.equal(check.evidenceSource, 'output_lines');
          assert.deepEqual(check.evidenceLines, verdict.evidence);
          assert.equal(check.evidence, verdict.evidence.map(line => 'L' + line + ': ' + item.output.split('\n')[line - 1]).join('\n'));
        } else {
          assert.equal(check.evidenceSource, 'model_explanation');
          assert.equal(check.evidence, verdict.evidence);
        }
      }
    } else assert.equal(item.judgeModel, null);
    for (const check of item.checks.filter(check => check.source === 'rule')) {
      const present = item.output.includes(check.criterion);
      assert.equal(check.passed, check.method === 'not_contains' ? !present : present);
    }
    const earned = item.checks.filter(check => check.passed).reduce((sum, check) => sum + check.weight, 0);
    const total = saved.criteria.reduce((sum, criterion) => sum + criterion.weight, 0);
    assert.equal(item.score, Number((100 * earned / total).toFixed(12)));
    assert.equal(item.status, item.score >= PASS_THRESHOLD ? 'passed' : 'failed');
    assert.deepEqual(store.budget(scope.workshopId, 200), {
      limit: 200, used: callsPerCase[index], reserved: 0, remaining: 200 - callsPerCase[index], unit: 'model_calls',
    });
  });
}

test('changing grader context or criteria cannot change the upstream generation payload', async t => {
  const { store, engine, requests } = harness(t);
  const fixture = workshopSuite.evaluations[5];
  const original = store.create(validateEvaluation(fixture), scope);
  const revised = store.create(validateEvaluation({
    ...fixture, input: 'GRADER_CONTEXT_ONLY_SENTINEL',
    criteria: [{ text: 'MODEL_CRITERION_ONLY_SENTINEL', method: 'model_grade', weight: 1 }],
  }), scope);
  engine.start([original.id, revised.id], scope);
  await engine.drain();
  const generations = requests.filter(request => request.url.startsWith(testcraftBaseUrl));
  const judges = requests.filter(request => request.url.startsWith(judgeBaseUrl));
  assert.equal(generations.length, 2);
  assert.equal(judges.length, 2);
  assert.deepEqual(generations[0].body, generations[1].body);
  assert.doesNotMatch(JSON.stringify(generations), /GRADER_CONTEXT_ONLY_SENTINEL|MODEL_CRITERION_ONLY_SENTINEL/);
  assert.match(JSON.stringify(judges), /GRADER_CONTEXT_ONLY_SENTINEL/);
  assert.match(JSON.stringify(judges), /MODEL_CRITERION_ONLY_SENTINEL/);
});

test('rerunning the same saved input generates fresh output and derives new rule results', async t => {
  let generation = 0;
  const { store, engine, requests } = harness(t, { output: () => ++generation === 1 ? 'Username Password Login' : 'Username Login' });
  const saved = store.create(validateEvaluation(workshopSuite.evaluations[0]), scope);
  const first = engine.start([saved.id], scope);
  await engine.drain();
  const firstSnapshot = store.run(first.id, scope);
  engine.resume();
  const second = engine.start([saved.id], scope);
  await engine.drain();
  const secondSnapshot = store.run(second.id, scope);
  assert.equal(requests.length, 2);
  assert.notEqual(firstSnapshot.items[0].output, secondSnapshot.items[0].output);
  assert.deepEqual(firstSnapshot.items[0].checks.map(check => check.passed), [true, true, true]);
  assert.deepEqual(secondSnapshot.items[0].checks.map(check => check.passed), [true, false, true]);
  assert.notEqual(firstSnapshot.items[0].score, secondSnapshot.items[0].score);
  assert.deepEqual(store.run(first.id, scope), firstSnapshot);
  assert.deepEqual(store.evaluation(saved.id, scope), saved);
});

test('version 2 imports separately from v1 and repeated loads preserve participant edits and historical runs', t => {
  const { store, requests } = harness(t);
  const previousSuite = { ...store.createSuite({ name: 'Prior workshop import' }, scope), seedKey: 'workshop-v1' };
  store.db.prepare('UPDATE suites SET data=? WHERE id=?').run(JSON.stringify(previousSuite), previousSuite.id);
  const previous = store.create(validateEvaluation({
    ...workshopSuite.evaluations[0], suiteId: previousSuite.id, source: 'pasted', actualOutput: 'Retained historical answer',
  }), scope);
  const historicalRun = {
    id: 'historical-run', createdAt: '2026-01-01T00:00:00.000Z', status: 'completed',
    items: [{ id: 'historical-item', evaluationId: previous.id, evaluation: previous, status: 'failed', score: 0, output: previous.actualOutput, checks: [], events: [] }],
  };
  store.saveRun(historicalRun, scope);
  const imported = store.importWorkshop(workshopSuite, scope);
  assert.equal(imported.created, true);
  assert.equal(imported.suite.seedKey, 'workshop-v2-live');
  assert.notEqual(imported.suite.id, previousSuite.id);
  const participant = imported.evaluations[0];
  const edited = store.updateEvaluation(participant.id, validateEvaluation({ ...participant, name: 'Participant version' }), participant.revision, scope);
  const repeated = store.importWorkshop(workshopSuite, scope);
  assert.equal(repeated.created, false);
  assert.equal(repeated.suite.id, imported.suite.id);
  assert.equal(repeated.evaluations.length, 8);
  assert.deepEqual(store.evaluation(edited.id, scope), edited);
  assert.deepEqual(store.evaluation(previous.id, scope), previous);
  assert.deepEqual(store.suite(previousSuite.id, scope), previousSuite);
  assert.deepEqual(store.run(historicalRun.id, scope), historicalRun);
  const otherScope = { ...scope, ownerId: 'another-participant' };
  const separate = store.importWorkshop(workshopSuite, otherScope);
  assert.equal(separate.created, true);
  assert.notEqual(separate.suite.id, imported.suite.id);
  assert.equal(store.evaluation(edited.id, otherScope), undefined);
  assert.deepEqual(requests, []);
});

test('a full suite is reserved atomically for 11 calls, including one judge call for multiple criteria', async t => {
  const { store, engine, requests } = harness(t, { limit: 10 });
  const { evaluations } = store.importWorkshop(workshopSuite, scope);
  assert.throws(() => engine.start(evaluations.map(evaluation => evaluation.id), scope), { status: 429 });
  assert.equal(store.budget(scope.workshopId, 10).reserved, 0);
  assert.deepEqual(store.runs(scope), []);
  assert.deepEqual(requests, []);
  engine.limit = 11;
  const run = engine.start(evaluations.map(evaluation => evaluation.id), scope);
  assert.equal(store.budget(scope.workshopId, 11).reserved, 11);
  assert.deepEqual(run.items.map(item => store.db.prepare('SELECT remaining FROM model_reservations WHERE item_id=?').get(item.id).remaining), callsPerCase);
  await engine.drain();
  assert.ok(store.run(run.id, scope).items.every(item => ['passed', 'failed'].includes(item.status)));
  assert.equal(requests.filter(request => request.url.startsWith(testcraftBaseUrl)).length, 8);
  assert.equal(requests.filter(request => request.url.startsWith(judgeBaseUrl)).length, 3);
  assert.deepEqual(store.budget(scope.workshopId, 11), { limit: 11, used: 11, reserved: 0, remaining: 0, unit: 'model_calls' });
});

test('seven private full-suite runs consume 77 shared app call attempts', async t => {
  const { store, engine, requests } = harness(t, { limit: 77 });
  const runs = [];
  for (let index = 0; index < 7; index++) {
    const participantScope = { ...scope, ownerId: 'participant-' + index };
    const { evaluations } = store.importWorkshop(workshopSuite, participantScope);
    runs.push({ scope: participantScope, run: engine.start(evaluations.map(evaluation => evaluation.id), participantScope) });
  }
  assert.equal(requests.length, 0);
  assert.equal(store.budget(scope.workshopId, 77).reserved, 77);
  await engine.drain();
  for (const participant of runs) assert.ok(store.run(participant.run.id, participant.scope).items.every(item => ['passed', 'failed'].includes(item.status)));
  assert.equal(requests.filter(request => request.url.startsWith(testcraftBaseUrl)).length, 56);
  assert.equal(requests.filter(request => request.url.startsWith(judgeBaseUrl)).length, 21);
  assert.deepEqual(store.budget(scope.workshopId, 77), { limit: 77, used: 77, reserved: 0, remaining: 0, unit: 'model_calls' });
});

test('incomplete generation is an error without a fallback answer or judge call; unused reservations release', async t => {
  const { store, engine, requests } = harness(t, { complete: false });
  const saved = store.create(validateEvaluation(workshopSuite.evaluations[5]), scope);
  const run = engine.start([saved.id], scope);
  assert.equal(store.budget(scope.workshopId, 200).reserved, 2);
  await engine.drain();
  const item = store.run(run.id, scope).items[0];
  assert.equal(item.status, 'error');
  assert.match(item.error, /without a complete output/);
  assert.equal(item.output, null);
  assert.equal(item.score, null);
  assert.deepEqual(item.checks, []);
  assert.equal(requests.length, 1);
  assert.equal(store.budget(scope.workshopId, 200).used, 1);
  assert.equal(store.budget(scope.workshopId, 200).reserved, 0);
  assert.deepEqual(store.evaluation(saved.id, scope), saved);
});

test('invalid judge Pass evidence keeps generated run output but produces no fabricated score', async t => {
  const { store, engine, requests } = harness(t, {
    verdict: () => ({ passed: true, evidence: [999], reason: 'Mock invalid source-line citation.' }),
  });
  const saved = store.create(validateEvaluation(workshopSuite.evaluations[5]), scope);
  const run = engine.start([saved.id], scope);
  await engine.drain();
  const item = store.run(run.id, scope).items[0];
  assert.equal(item.status, 'error');
  assert.match(item.error, /valid source line numbers/);
  assert.equal(item.output, mockCode);
  assert.equal(item.score, null);
  assert.deepEqual(item.checks, []);
  assert.equal(requests.length, 2);
  assert.equal(store.budget(scope.workshopId, 200).used, 2);
  assert.equal(store.budget(scope.workshopId, 200).reserved, 0);
  assertInputDefinition(store.evaluation(saved.id, scope));
});

test('missing judge configuration consumes no generation call and releases both reservations', async t => {
  const { store, engine, requests } = harness(t, { env: { OPENAI_API_KEY: '' } });
  const saved = store.create(validateEvaluation(workshopSuite.evaluations[3]), scope);
  const run = engine.start([saved.id], scope);
  assert.equal(store.budget(scope.workshopId, 200).reserved, 2);
  await engine.drain();
  const item = store.run(run.id, scope).items[0];
  assert.equal(item.status, 'error');
  assert.match(item.error, /OPENAI_API_KEY/);
  assert.equal(item.output, null);
  assert.equal(item.score, null);
  assert.deepEqual(requests, []);
  assert.equal(store.budget(scope.workshopId, 200).used, 0);
  assert.equal(store.budget(scope.workshopId, 200).reserved, 0);
});
