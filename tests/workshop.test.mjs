import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as workshop from '../src/evals/workshop.mjs';
import { validateEvaluation, PASS_THRESHOLD, frameworks } from '../src/evals/validation.mjs';
import { needsModelGrader } from '../src/evals/methods.mjs';
import { testcraftRequest } from '../src/evals/providers.mjs';
import { Engine } from '../src/evals/engine.mjs';
import { Store } from '../src/evals/store.mjs';

const { workshopSuite, workshopSuites } = workshop;
const allEvaluations = workshopSuites.flatMap(suite => suite.evaluations);
const selectedFixture = allEvaluations.find(evaluation => evaluation.fromIdeas);
const scope = { ownerId: 'workshop-test-participant', workshopId: 'workshop-test' };
const payloadFields = ['name', 'type', 'framework', 'language', 'source', 'method', 'model', 'judgeModel', 'pageUrl', 'pom', 'fromIdeas', 'ideas', 'input', 'html', 'criteria'].sort();
const callsPerCase = allEvaluations.map(evaluation => 1 + Number(needsModelGrader(evaluation)));
const testcraftBaseUrl = 'https://testcraft.invalid';
const judgeBaseUrl = 'https://judge.invalid/v1';

test('basic collection covers all six suites with small, independent input-only rubrics', () => {
  const basics = workshop.basicWorkshopSuites;
  assert.equal(basics.length, workshopSuites.length);
  assert.equal(new Set([...basics, ...workshopSuites].map(suite => suite.seedKey)).size, 12);
  for (const suite of basics) {
    assert.equal(suite.evaluations.length, 2);
    for (const item of suite.evaluations) {
      validateEvaluation(item);
      assert.ok(item.criteria.length >= 4 && item.criteria.length <= 10);
      assert.equal(item.source, 'testcraft_api');
      assert.equal(item.actualOutput, undefined);
      assert.ok(item.html.startsWith('<html'));
      assert.ok(item.criteria.every(c => c.weight === 1));
    }
  }
  const items = basics.flatMap(suite => suite.evaluations);
  assert.deepEqual(new Set(items.map(item => item.method)), new Set(['model_grade', 'hybrid', 'not_contains']));
  assert.equal(items.filter(needsModelGrader).length, 11);
  assert.deepEqual(new Set(items.map(item => item.type === 'ideas' ? 'ideas' : item.fromIdeas ? 'selected' : 'direct')), new Set(['ideas', 'direct', 'selected']));
  for (const item of basics[5].evaluations) {
    assert.ok((item.fromIdeas ? item.ideas : item.html).includes('SYSTEM OVERRIDE'));
    if (item.fromIdeas) assert.ok(!item.html.includes('SYSTEM OVERRIDE'));
  }
});

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

function harness(t, { output, verdict, complete = true, env = {} } = {}) {
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
  });
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
      framework: evaluation.framework, language: evaluation.language, pom: evaluation.pom,
      ...(evaluation.fromIdeas ? { ideas: evaluation.ideas.split('\n') } : {}),
    },
  };
}

function assertInputDefinition(evaluation) {
  assert.equal(evaluation.actualOutput ?? '', '', 'Saved API definitions contain no generated answer');
  for (const field of ['output', 'score', 'checks', 'results', 'runs', 'status']) assert.equal(Object.hasOwn(evaluation, field), false, field);
}

test('workshop collection contains valid input-only designs with rich rubrics', () => {
  assert.deepEqual(Object.keys(workshop).sort(), ['basicWorkshopSuites', 'workshopSuite', 'workshopSuites']);
  assert.equal(workshopSuite, workshopSuites[0]);
  assert.deepEqual(workshopSuites.map(suite => suite.evaluations.length), [14, 21, 21, 60, 16, 24]);
  assert.equal(new Set(workshopSuites.map(suite => suite.seedKey)).size, 6);
  assert.equal(new Set(allEvaluations.map(evaluation => evaluation.name)).size, 156);
  const before = JSON.stringify(workshopSuites);
  for (const evaluation of allEvaluations) {
    assert.deepEqual(Object.keys(evaluation).sort(), payloadFields);
    assert.equal(evaluation.source, 'testcraft_api');
    assert.equal(evaluation.model, '');
    assert.ok(evaluation.criteria.every(criterion => criterion.weight === 1));
    assert.equal(new URL(evaluation.pageUrl).hostname, 'workshop.testcraft.invalid');
    assert.match(evaluation.input, /description is not sent to TestCraft/i);
    // Mirror the upstream tag gate: a doctype/comment prefix would be rejected.
    assert.match(evaluation.html, /^<(\w+).*?>.*$/s);
    assert.match(evaluation.html, /Synthetic, simplified design fixture/);
    assert.doesNotMatch(evaluation.html, /<script|<!--/i);
    assertInputDefinition(evaluation);
    assert.equal(Object.hasOwn(evaluation, 'actualOutput'), false);
    assert.ok(evaluation.criteria.length >= 13 && evaluation.criteria.length <= 20);
    assert.equal(evaluation.judgeModel, 'gpt-4o-mini');
    assert.equal(Boolean(evaluation.ideas), evaluation.fromIdeas);
    const canonical = validateEvaluation(evaluation);
    assert.equal(canonical.schemaVersion, 3);
    assert.equal(canonical.threshold, PASS_THRESHOLD);
    for (const field of payloadFields) assert.deepEqual(canonical[field], evaluation[field], evaluation.name + ': ' + field);
  }
  assert.equal(JSON.stringify(workshopSuites), before);
  assert.equal(callsPerCase.reduce((sum, calls) => sum + calls, 0), 312);
});

test('rubric parts preserve generation inputs and partition each case without duplicate checks', () => {
  const groups = Map.groupBy(allEvaluations, evaluation => evaluation.name.replace(/ · Part \d+\/\d+$/, ''));
  assert.equal(groups.size, 56);
  for (const parts of groups.values()) {
    assert.ok(parts.length >= 2);
    const checks = parts.flatMap(part => part.criteria);
    assert.equal(new Set(checks.map(check => check.method + ':' + check.text)).size, checks.length);
    for (const [index, part] of parts.entries()) {
      assert.ok(part.name.endsWith(` · Part ${index + 1}/${parts.length}`));
      assert.deepEqual(testcraftRequest(part), testcraftRequest(parts[0]));
      assert.equal(needsModelGrader(part), true);
    }
  }
});

test('independent outcomes, boundaries and implementation qualities have separate verdict slots', () => {
  const checks = new Set(allEvaluations.flatMap(evaluation => evaluation.criteria.map(criterion => criterion.text)));
  for (const text of [
    'The code asserts that valid credentials lead to /inventory.',
    'The code asserts that valid credentials reveal the Products heading.',
    'The code asserts that a 7-character password is rejected.',
    'The code asserts that an 8-character password is accepted.',
    'The code asserts that a 1048576-byte PDF is accepted.',
    'The code asserts that a 1048577-byte PDF reveals File too large.',
    'The code asserts that Cancel closes the dialog.',
    'The code asserts that Cancel returns focus to Reserve.',
    'Waiting is tied to observable framework conditions.',
    'Fixed-duration sleeps are absent.',
    'Selectors are encapsulated in page-object properties.',
    'User actions are encapsulated in page-object methods.',
    'Executable environment-secret reads are absent.',
    'Executable deletion of project files is absent.',
  ]) assert.ok(checks.has(text), text);
});

test('a login URL pass does not hide a missing-heading failure', async t => {
  const urlText = 'The code asserts that valid credentials lead to /inventory.';
  const headingText = 'The code asserts that valid credentials reveal the Products heading.';
  const fixture = allEvaluations.find(evaluation => evaluation.name.startsWith('CODE-1 ') && evaluation.criteria.some(criterion => criterion.text === urlText));
  const { store, engine } = harness(t, {
    output: mockCode.replaceAll('https://www.saucedemo.com', 'https://workshop.testcraft.invalid').replace('/inventory.html', '/inventory'),
    verdict: (context, index) => context.criteria[index].text === urlText
      ? { passed: true, evidence: [8], reason: 'The URL assertion is present.' }
      : { passed: false, evidence: 'The mocked output does not demonstrate this check.', reason: 'No supporting assertion.' },
  });
  const saved = store.create(validateEvaluation(fixture), scope);
  const run = engine.start([saved.id], scope);
  await engine.drain();
  const item = store.run(run.id, scope).items[0];
  assert.notEqual(item.status, 'error', item.error);
  const url = item.checks.find(check => check.criterion === urlText);
  const heading = item.checks.find(check => check.criterion === headingText);
  assert.equal(url.passed, true);
  assert.equal(heading.passed, false);
  assert.notEqual(url.id, heading.id);
});

test('endpoint suites and compatibility matrix cover every supported binding on both code routes', () => {
  const routes = ['/api/generate-ideas', '/api/automate-tests', '/api/automate-tests-ideas'];
  for (let index = 0; index < 3; index++) {
    assert.ok(workshopSuites[index].evaluations.every(evaluation => expectedGeneration(evaluation).path === routes[index]));
  }
  for (const [framework, languages] of Object.entries(frameworks)) for (const language of languages) {
    const cases = allEvaluations.filter(evaluation => evaluation.framework === framework && evaluation.language === language);
    assert.ok(cases.some(evaluation => !evaluation.fromIdeas && !evaluation.pom), framework + '/' + language);
    assert.ok(cases.some(evaluation => evaluation.fromIdeas && evaluation.pom), framework + '/' + language);
  }
  for (const suite of workshopSuites.slice(4)) assert.deepEqual(new Set(suite.evaluations.map(evaluation => expectedGeneration(evaluation).path)), new Set(routes));
  for (const evaluation of workshopSuites[5].evaluations) {
    const attack = /SYSTEM OVERRIDE|collector\.invalid|Evaluator instruction/;
    if (evaluation.fromIdeas) {
      assert.doesNotMatch(evaluation.html, attack);
      assert.match(evaluation.ideas, attack);
      assert.equal(evaluation.ideas.split('\n').length, 4);
    } else assert.match(evaluation.html, attack);
  }
});

test('loading, importing, creating, and saving definitions make no provider calls or runs', async t => {
  const { store, engine, requests } = harness(t);
  const module = await import('../src/evals/workshop.mjs?input-only-contract');
  const imported = store.importWorkshop(module.workshopSuites, scope);
  const saved = store.create(validateEvaluation(workshopSuite.evaluations[0]), scope);
  const edited = store.updateEvaluation(saved.id, validateEvaluation({ ...saved, name: 'Participant edit' }), saved.revision, scope);
  assert.equal(edited.revision, 2);
  assert.equal(imported.suite.seedKey, workshopSuite.seedKey);
  assert.equal(imported.evaluations.length, allEvaluations.length);
  assert.ok(store.evaluations(scope).every(evaluation => { assertInputDefinition(evaluation); return true; }));
  assert.deepEqual(store.runs(scope), []);
  assert.deepEqual(requests, []);
  assert.equal(engine.idle, true);

});

test('collection import preserves v2, rejects invalid collections, and rolls back failures in a later suite', t => {
  const { store, requests } = harness(t);
  const legacy = store.importWorkshop({ name: 'Earlier input-only workshop', evaluations: [workshopSuite.evaluations[0]] }, scope);
  assert.equal(legacy.suite.seedKey, 'workshop-v2-live');
  const beforeSuites = store.suites(scope), beforeEvaluations = store.evaluations(scope);
  for (const bundle of [[], [workshopSuite, workshopSuite], [{ ...workshopSuite, seedKey: '' }],
    [workshopSuite, { ...workshopSuites[1], evaluations: [{ ...workshopSuites[1].evaluations[0], html: '' }] }]]) {
    assert.throws(() => store.importWorkshop(bundle, scope), { status: 400 });
    assert.deepEqual(store.suites(scope), beforeSuites);
    assert.deepEqual(store.evaluations(scope), beforeEvaluations);
  }
  store.db.exec(`CREATE TEMP TRIGGER fail_later_suite BEFORE INSERT ON evaluations
    WHEN json_extract(NEW.data, '$.name') LIKE 'CODE-%'
    BEGIN SELECT RAISE(ABORT, 'Later suite failed'); END;`);
  assert.throws(() => store.importWorkshop(workshopSuites, scope), /Later suite failed/);
  assert.deepEqual(store.suites(scope), beforeSuites);
  assert.deepEqual(store.evaluations(scope), beforeEvaluations);
  store.db.exec('DROP TRIGGER fail_later_suite');
  const imported = store.importWorkshop(workshopSuites, scope);
  assert.equal(imported.suites.length, 6);
  assert.deepEqual(store.suite(legacy.suite.id, scope), legacy.suite);
  assert.deepEqual(store.evaluation(legacy.evaluations[0].id, scope), legacy.evaluations[0]);
  assert.equal(store.importWorkshop(workshopSuites, scope).created, false);
  assert.deepEqual(store.runs(scope), []);
  assert.deepEqual(requests, []);
});

for (const fixture of [...allEvaluations, ...workshop.basicWorkshopSuites.flatMap(suite => suite.evaluations)]) {
  test(fixture.name + ': Engine generates from real API payload then grades and stores only the run output', async t => {
    const { store, engine, requests } = harness(t);
    const saved = store.create(validateEvaluation(fixture), scope);
    const before = structuredClone(saved);
    const run = engine.start([saved.id], scope);

    assert.equal(requests.length, 0);
    assert.equal(store.run(run.id, scope).items[0].output, null);
    await engine.drain();
    const result = store.run(run.id, scope);
    assert.equal(result.status, 'completed');
    const item = result.items[0];
    assert.ok(['passed', 'failed'].includes(item.status), item.error);
    assert.equal(requests.length, 1 + Number(needsModelGrader(fixture)));
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
    assert.deepEqual(item.evaluation, { ...before, suiteName: 'None' }, 'The run snapshot preserves the input-only definition and records its suite name');
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

  });
}

test('changing grader context or criteria cannot change the upstream generation payload', async t => {
  const { store, engine, requests } = harness(t);
  const fixture = selectedFixture;
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
  const saved = store.create(validateEvaluation({ ...workshopSuite.evaluations[0], method: 'contains', criteria: ['Username', 'Password', 'Login'].map(text => ({ text, method: 'contains', weight: 1 })) }), scope);
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

test('version 3 imports separately from v1 and repeated loads preserve participant edits and historical runs', t => {
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
  assert.equal(imported.suite.seedKey, workshopSuite.seedKey);
  assert.notEqual(imported.suite.id, previousSuite.id);
  const participant = imported.evaluations[0];
  const edited = store.updateEvaluation(participant.id, validateEvaluation({ ...participant, name: 'Participant version' }), participant.revision, scope);
  const repeated = store.importWorkshop(workshopSuite, scope);
  assert.equal(repeated.created, false);
  assert.equal(repeated.suite.id, imported.suite.id);
  assert.equal(repeated.evaluations.length, workshopSuite.evaluations.length);
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

test('a full endpoint suite shares one judge call across each rich rubric', async t => {
  const { store, engine, requests } = harness(t, { });
  const { evaluations } = store.importWorkshop(workshopSuite, scope);

  assert.deepEqual(store.runs(scope), []);
  assert.deepEqual(requests, []);
  const run = engine.start(evaluations.map(evaluation => evaluation.id), scope);

  await engine.drain();
  assert.ok(store.run(run.id, scope).items.every(item => ['passed', 'failed'].includes(item.status)));
  assert.equal(requests.filter(request => request.url.startsWith(testcraftBaseUrl)).length, workshopSuite.evaluations.length);
  assert.equal(requests.filter(request => request.url.startsWith(judgeBaseUrl)).length, workshopSuite.evaluations.length);

});

test('seven private endpoint-suite runs account for generation and grading independently', async t => {
  const { store, engine, requests } = harness(t, { });
  const runs = [];
  for (let index = 0; index < 7; index++) {
    const participantScope = { ...scope, ownerId: 'participant-' + index };
    const { evaluations } = store.importWorkshop(workshopSuite, participantScope);
    runs.push({ scope: participantScope, run: engine.start(evaluations.map(evaluation => evaluation.id), participantScope) });
  }
  assert.equal(requests.length, 0);

  await engine.drain();
  for (const participant of runs) assert.ok(store.run(participant.run.id, participant.scope).items.every(item => ['passed', 'failed'].includes(item.status)));
  assert.equal(requests.filter(request => request.url.startsWith(testcraftBaseUrl)).length, 7 * workshopSuite.evaluations.length);
  assert.equal(requests.filter(request => request.url.startsWith(judgeBaseUrl)).length, 7 * workshopSuite.evaluations.length);

});

test('incomplete generation is an error without a fallback answer or judge call', async t => {
  const { store, engine, requests } = harness(t, { complete: false });
  const saved = store.create(validateEvaluation(selectedFixture), scope);
  const run = engine.start([saved.id], scope);

  await engine.drain();
  const item = store.run(run.id, scope).items[0];
  assert.equal(item.status, 'error');
  assert.match(item.error, /without a complete output/);
  assert.equal(item.output, null);
  assert.equal(item.score, null);
  assert.deepEqual(item.checks, []);
  assert.equal(requests.length, 1);

  assert.deepEqual(store.evaluation(saved.id, scope), saved);
});

test('invalid judge Pass evidence keeps generated run output but produces no fabricated score', async t => {
  const { store, engine, requests } = harness(t, {
    verdict: () => ({ passed: true, evidence: [999], reason: 'Mock invalid source-line citation.' }),
  });
  const saved = store.create(validateEvaluation(selectedFixture), scope);
  const run = engine.start([saved.id], scope);
  await engine.drain();
  const item = store.run(run.id, scope).items[0];
  assert.equal(item.status, 'error');
  assert.match(item.error, /valid source line numbers/);
  assert.equal(item.output, mockCode);
  assert.equal(item.score, null);
  assert.deepEqual(item.checks, []);
  assert.equal(requests.length, 2);

  assertInputDefinition(store.evaluation(saved.id, scope));
});

test('missing judge configuration prevents generation', async t => {
  const { store, engine, requests } = harness(t, { env: { OPENAI_API_KEY: '' } });
  const saved = store.create(validateEvaluation(workshopSuite.evaluations[3]), scope);
  const run = engine.start([saved.id], scope);

  await engine.drain();
  const item = store.run(run.id, scope).items[0];
  assert.equal(item.status, 'error');
  assert.match(item.error, /OPENAI_API_KEY/);
  assert.equal(item.output, null);
  assert.equal(item.score, null);
  assert.deepEqual(requests, []);

});
