import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, normalizeCriteria, PASS_THRESHOLD, validateEvaluation } from '../src/evals/validation.mjs';
import { criterionMethods, evaluationMethods, GRADING_VERSION, methods, needsModelGrader } from '../src/evals/methods.mjs';
import { grade } from '../src/evals/graders.mjs';
import { Engine } from '../src/evals/engine.mjs';
import { Store } from '../src/evals/store.mjs';
import { workshopSuite } from '../src/evals/workshop.mjs';

const base = { name: 'Binary rubric', type: 'ideas', source: 'pasted', method: 'contains', html: '<button>Login</button>',
  actualOutput: 'valid user; invalid password', criteria: ['valid user', 'invalid password'], judgeModel: 'gpt-4o-mini' };
const env = { OPENAI_API_KEY: 'test-only-no-real-requests' };
const criterion = (text, method = 'contains', weight = 1) => ({ text, method, weight });
const check = (id = 'c1', passed = true, evidence = [1]) => ({ id, passed, evidence, reason: 'The candidate demonstrates the requested behavior.' });
const modelCase = (criteria = [criterion('Describes a successful login', 'model_grade')]) => ({ ...base, method: 'model_grade', criteria });
const response = (checks, overrides = {}) => Response.json({ model: 'mock-judge', usage: { total_tokens: 12 },
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ checks }) } }], ...overrides });
const noFetch = async () => { assert.fail('Unexpected provider request'); };
const isAppError = status => error => error instanceof AppError && error.status === status;

function setupEngine(t, { limit = 2, environment = env, fetchImpl = noFetch } = {}) {
  const store = new Store(':memory:');
  const scope = { ownerId: 'grader-test-owner', workshopId: 'grader-test-workshop' };
  const calls = [];
  const engine = new Engine(store, environment, async (...args) => { calls.push(args); return fetchImpl(...args); }, limit);
  t.after(async () => { await engine.drain(); store.close(); });
  return { store, scope, engine, calls, budget: () => store.budget(scope.workshopId, limit) };
}

async function runCase(fixture, evaluation) {
  const saved = fixture.store.create(evaluation, fixture.scope);
  const run = fixture.engine.start([saved.id], fixture.scope);
  await fixture.engine.drain();
  fixture.engine.resume();
  return { saved, run: fixture.store.run(run.id, fixture.scope) };
}

test('v3 saves canonical criteria with decimal weights, fixed policy, and optional suite UUID', () => {
  const original = { ...base, threshold: 5, criteria: [' valid user ', criterion('invalid password', 'contains', 0.25)] };
  const before = structuredClone(original);
  const saved = validateEvaluation(original);
  assert.equal(saved.schemaVersion, 3);
  assert.equal(saved.threshold, PASS_THRESHOLD);
  assert.equal(saved.suiteId, '');
  assert.deepEqual(saved.criteria, [criterion('valid user'), criterion('invalid password', 'contains', 0.25)]);
  assert.deepEqual(original, before);
  assert.equal(validateEvaluation({ ...base, criteria: [{ text: 'valid user', method: 'contains' }] }).criteria[0].weight, 1);
  const suiteId = 'af596ea6-16c1-4e20-a06a-a9c3ba2b1359';
  assert.equal(validateEvaluation({ ...base, suiteId }).suiteId, suiteId);
  for (const suiteId of [null, 1, [], {}, 'not-a-uuid', 'af596ea6-16c1-0e20-a06a-a9c3ba2b1359']) {
    assert.throws(() => validateEvaluation({ ...base, suiteId }), isAppError(400));
  }
});

test('criteria validate count, nonempty text, total length, weights, methods, and duplicates', () => {
  for (const criteria of [[], '', 'a\nb', [null], [[]], [3], [''], ['  '], ['a', ' a '], [{ text: 'a' }],
    [criterion('a', 'hybrid')], [criterion('a', '__proto__')], [criterion(7)], [criterion('a'.repeat(8001))],
    ['a'.repeat(4001), 'b'.repeat(4000)], Array.from({ length: 21 }, (_, i) => String(i)), Array(1)]) {
    assert.throws(() => validateEvaluation({ ...base, criteria }), isAppError(400));
  }
  for (const weight of [0, -1, 0.009, 100.01, NaN, Infinity, -Infinity, '1', true, null, {}]) {
    assert.throws(() => validateEvaluation({ ...base, criteria: [criterion('a', 'contains', weight)] }), isAppError(400));
  }
  for (const weight of [0.01, 0.12345, 1, 100]) assert.equal(validateEvaluation({ ...base, criteria: [criterion('a', 'contains', weight)] }).criteria[0].weight, weight);
  assert.equal(validateEvaluation({ ...base, criteria: ['a'.repeat(4000), 'b'.repeat(4000)] }).criteria.length, 2);
  assert.equal(validateEvaluation({ ...base, criteria: Array.from({ length: 20 }, (_, i) => String(i)) }).criteria.length, 20);
  assert.throws(() => validateEvaluation({ ...base, criteria: [criterion('a', 'not_contains')] }), /match the evaluation method/);
  assert.throws(() => validateEvaluation({ ...base, method: 'model_grade', criteria: [criterion('a')] }), /match the evaluation method/);
});

test('hybrid allows shared text across methods and multiple exact matches, with conditional judge requirements', () => {
  assert.ok(methods.includes('hybrid'));
  assert.deepEqual(criterionMethods, ['model_grade', 'contains', 'not_contains', 'exact_match']);
  assert.equal(evaluationMethods.hybrid.gradingCalls, null);
  const criteria = [criterion('a'), criterion('a', 'not_contains'), criterion('a', 'exact_match'), criterion('b', 'exact_match')];
  const rules = validateEvaluation({ ...base, method: 'hybrid', criteria, judgeModel: 'o1-mini' });
  assert.deepEqual(rules.criteria, criteria);
  assert.equal(rules.evaluationFamily, 'hybrid');
  assert.equal(rules.judgeModel, '');
  assert.equal(needsModelGrader(rules), false);
  assert.throws(() => validateEvaluation({ ...base, method: 'exact_match', criteria: ['a', 'b'] }), /exactly one/);
  assert.throws(() => validateEvaluation({ ...rules, criteria: [criterion('a'), criterion(' a ', 'contains', 2)] }), /distinct/);
  assert.throws(() => validateEvaluation({ ...rules, criteria: ['a'] }), /criterion method/);
  const mixed = { ...rules, criteria: [...criteria, criterion('a', 'model_grade')] };
  assert.equal(needsModelGrader(mixed), true);
  for (const judgeModel of [undefined, '', 'o1-mini', 'gpt-4-turbo']) assert.throws(() => validateEvaluation({ ...mixed, judgeModel }), isAppError(400));
  assert.equal(validateEvaluation({ ...mixed, judgeModel: 'gpt-4o-mini' }).judgeModel, 'gpt-4o-mini');
  assert.equal(needsModelGrader({ method: 'model_grade', criteria: 'legacy rubric' }), true);
  assert.equal(needsModelGrader({ ...base, judgeModel: 'gpt-4o-mini' }), false);
});

test('local binary checks compute a weighted mean and hybrid rules make zero judge calls', async () => {
  const evaluation = { ...base, method: 'hybrid', judgeModel: 'unsupported-and-unused', criteria: [
    criterion('valid user', 'contains', 2), criterion('invalid password', 'not_contains', 1),
    criterion(base.actualOutput, 'exact_match', 0.5), criterion('different', 'exact_match', 0.5),
  ] };
  const result = await grade(evaluation, base.actualOutput, {}, noFetch);
  assert.equal(result.score, 62.5);
  assert.equal(result.earnedWeight, 2.5);
  assert.equal(result.totalWeight, 4);
  assert.equal(result.passCount, 2);
  assert.equal(result.gradingVersion, GRADING_VERSION);
  assert.equal(result.judgeModel, null);
  assert.deepEqual(result.checks.map(({ id, passed, score, source, method, weight }) => ({ id, passed, score, source, method, weight })), [
    { id: 'c1', passed: true, score: 100, source: 'rule', method: 'contains', weight: 2 },
    { id: 'c2', passed: false, score: 0, source: 'rule', method: 'not_contains', weight: 1 },
    { id: 'c3', passed: true, score: 100, source: 'rule', method: 'exact_match', weight: 0.5 },
    { id: 'c4', passed: false, score: 0, source: 'rule', method: 'exact_match', weight: 0.5 },
  ]);
  const equal = await grade({ ...base, criteria: ['valid user', 'invalid password', 'missing'] }, base.actualOutput, {}, noFetch);
  assert.equal(equal.score, 66.666666666667);
  const exact = await grade({ ...base, method: 'exact_match', criteria: ['hello\nworld'] }, '  hello\r\nworld\n', {}, noFetch);
  assert.equal(exact.score, 100);
});

test('hybrid sends only model criteria in one strict call and merges their original IDs and weights', async () => {
  let calls = 0;
  const evaluation = { ...base, method: 'hybrid', criteria: [criterion('local-only-fragment'), criterion('Describes a successful login', 'model_grade', 2),
    criterion('local-only-forbidden', 'not_contains', 0.5), criterion('Describes missing coverage', 'model_grade', 0.5)] };
  const before = structuredClone(evaluation);
  const result = await grade(evaluation, base.actualOutput, env, async (_url, options) => {
    calls++;
    const request = JSON.parse(options.body);
    assert.equal(request.store, false);
    assert.equal(request.response_format.json_schema.strict, true);
    const schema = request.response_format.json_schema.schema;
    assert.equal(schema.additionalProperties, false);
    const [passSchema, failSchema] = schema.properties.checks.items.anyOf;
    for (const branch of [passSchema, failSchema]) {
      assert.equal(branch.additionalProperties, false);
      assert.deepEqual(branch.required, ['id', 'passed', 'evidence', 'reason']);
      assert.equal('score' in branch.properties, false);
      assert.deepEqual(branch.properties.id.enum, ['c2', 'c4']);
    }
    assert.deepEqual(passSchema.properties.passed, { type: 'boolean', enum: [true] });
    assert.deepEqual(failSchema.properties.passed, { type: 'boolean', enum: [false] });
    assert.equal(passSchema.properties.evidence.type, 'array');
    assert.equal(passSchema.properties.evidence.minItems, 1);
    assert.equal(passSchema.properties.evidence.maxItems, 1);
    assert.deepEqual(passSchema.properties.evidence.items, { type: 'integer', minimum: 1, maximum: 1 });
    assert.equal(schema.properties.checks.minItems, 2);
    assert.equal(schema.properties.checks.maxItems, 2);
    for (const textSchema of [failSchema.properties.evidence, failSchema.properties.reason, passSchema.properties.reason]) {
      assert.equal(textSchema.type, 'string');
      assert.ok(textSchema.description.length > 0);
      const pattern = new RegExp(textSchema.pattern);
      for (const empty of ['', ' ', '\t\r\n', '\u00a0', '\u2003']) assert.equal(pattern.test(empty), false);
      for (const text of ['Missing assertion.', '\nEvidence on another line\n', 'Falta una aserción.']) assert.equal(pattern.test(text), true);
    }
    const input = JSON.parse(request.messages[1].content);
    assert.deepEqual(input.actualOutputLines, [{ line: 1, text: base.actualOutput }]);
    assert.equal('actualOutput' in input, false);
    assert.deepEqual(input.criteria, [{ id: 'c2', text: 'Describes a successful login' }, { id: 'c4', text: 'Describes missing coverage' }]);
    assert.equal(request.messages[1].content.includes('local-only'), false);
    assert.match(request.messages[0].content, /untrusted data/);
    assert.match(request.messages[0].content, /comments, keywords/);
    assert.match(request.messages[0].content, /Do not claim code was executed/);
    return response([check('c4', false, 'No boundary behavior appears in the output.'), check('c2')]);
  });
  assert.equal(calls, 1);
  assert.equal(result.score, 62.5);
  assert.equal(result.earnedWeight, 2.5);
  assert.equal(result.totalWeight, 4);
  assert.equal(result.passCount, 2);
  assert.equal(result.judgeModel, 'mock-judge');
  assert.deepEqual(result.usage, { total_tokens: 12 });
  assert.deepEqual(result.checks.map(c => c.id), ['c1', 'c2', 'c3', 'c4']);
  assert.deepEqual(result.checks.map(c => c.source), ['rule', 'model', 'rule', 'model']);
  assert.deepEqual(result.checks.map(c => c.passed), [false, true, true, false]);
  assert.deepEqual(evaluation, before);
});

test('judge rejects numeric/string booleans, numeric scores, missing evidence/reasons, and extra schema fields', async t => {
  const valid = check();
  const malformed = [null, [], {}, { checks: null }, { checks: {} }, { checks: [valid], score: 100 },
    ...[1, 0, 'true', 'false', null].map(passed => ({ checks: [{ ...valid, passed }] })),
    { checks: [{ id: 'c1', score: 100, evidence: valid.evidence, reason: valid.reason }] },
    { checks: [{ ...valid, score: 100 }] }, { checks: [{ ...valid, criterion: 'injected' }] },
    { checks: [{ ...valid, evidence: '' }] }, { checks: [{ ...valid, evidence: '  ' }] }, { checks: [{ ...valid, evidence: null }] },
    { checks: [{ ...valid, reason: '' }] }, { checks: [{ ...valid, reason: 1 }] }, { checks: [{ ...valid, id: 1 }] },
    { checks: [null] }, { checks: [[]] },
    ...['id', 'passed', 'evidence', 'reason'].map(key => ({ checks: [Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key))] })),
  ];
  for (const [index, payload] of malformed.entries()) await t.test(`invalid payload ${index + 1}`, async () => {
    await assert.rejects(grade(modelCase(), base.actualOutput, env, async () => response([], {
      choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }],
    })), isAppError(502));
  });
});

test('judge requires exact ID coverage and rejects duplicate, missing, unknown, and extra checks', async () => {
  const evaluation = modelCase([criterion('Positive behavior', 'model_grade'), criterion('Negative behavior', 'model_grade')]);
  for (const checks of [[], [check()], [check(), check()], [check(), check('c3')], [check('c2'), check('c3')], [check(), check('c2'), check('c3')]]) {
    await assert.rejects(grade(evaluation, base.actualOutput, env, async () => response(checks)), /exactly once/);
  }
});

test('passing evidence is extracted from valid original lines, not copied or invented by the model', async () => {
  const output = '  valid user\r\n\r\ninvalid password  ';
  const evaluation = modelCase();
  const cited = await grade(evaluation, output, env, async () => response([check('c1', true, [3, 1, 1])]));
  assert.equal(cited.score, 100);
  assert.equal(cited.checks[0].evidence, 'L1:   valid user\nL3: invalid password  ');
  assert.deepEqual(cited.checks[0].evidenceLines, [1, 3]);
  assert.equal(cited.checks[0].evidenceSource, 'output_lines');
  for (const evidence of ['', 'valid user', 'Invented assertion', [], [0], [-1], [4], [1.5], ['1'], [null], {}, [1, 1, 1, 1]]) {
    await assert.rejects(grade(evaluation, output, env, async () => response([check('c1', true, evidence)])), /valid source line numbers/);
  }
  await assert.rejects(grade(evaluation, output, env, async () => response([check('c1', true, [2])])), /only blank lines/);
  const failed = await grade(evaluation, output, env, async () => response([check('c1', false, 'The required assertion is absent.')]));
  assert.equal(failed.score, 0);
  assert.equal(failed.passCount, 0);
  await assert.rejects(grade(evaluation, output, env, async () => response([check('c1', false, '')])), /empty evidence.*c1/);
});

test('weak workshop output receives a justified Fail, not an error, when behavior is absent', async t => {
  const evaluation = workshopSuite.evaluations.find(item => item.name.startsWith('04'));
  const evidence = 'There is no field entry, submission, or assertion of the required login outcomes.';
  const reason = 'Navigation and an assertion on a constant do not implement the requested scenarios.';
  const fixture = setupEngine(t, { limit: 1, fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    const input = JSON.parse(request.messages[1].content);
    assert.equal(input.actualOutputLines.map(line => line.text).join('\n'), evaluation.actualOutput);
    assert.match(request.messages[0].content, /absence.*evidence/i);
    assert.match(request.response_format.json_schema.schema.properties.checks.items.anyOf[1].properties.evidence.description, /failed/i);
    return response([{ id: 'c1', passed: false, evidence, reason }]);
  } });
  const { run } = await runCase(fixture, validateEvaluation(evaluation));
  assert.equal(run.items[0].status, 'failed');
  assert.equal(run.items[0].score, 0);
  assert.equal(run.items[0].checks[0].evidence, evidence);
  assert.equal(run.items[0].checks[0].reason, reason);
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.budget().used, 1);
});

test('invalid grader fields report safe, specific errors without retries, raw responses, or invented grades', async t => {
  const cases = [
    { field: 'evidence', value: '', message: /empty evidence.*c1/ },
    { field: 'evidence', value: ' \n\t ', message: /empty evidence.*c1/ },
    { field: 'evidence', value: null, message: /evidence.*c1.*text/ },
    { field: 'reason', value: '', message: /empty reason.*c1/ },
    { field: 'reason', value: 5, message: /reason.*c1.*text/ },
    { field: 'passed', value: 'false', message: /passed.*c1.*boolean/ },
    { field: 'id', value: 7, message: /check 1.*id.*text/ },
    { field: 'extra', value: 'PRIVATE_PROVIDER_CONTENT', message: /check 1.*exactly/ },
  ];
  for (const invalid of cases) await t.test(`${invalid.field}: ${JSON.stringify(invalid.value)}`, async t => {
    const fixture = setupEngine(t, { limit: 1, fetchImpl: async () => response([
      { id: 'c1', passed: false, evidence: 'PRIVATE_PROVIDER_CONTENT', reason: 'PRIVATE_PROVIDER_CONTENT', [invalid.field]: invalid.value },
    ]) });
    const { run } = await runCase(fixture, modelCase());
    const item = run.items[0];
    assert.equal(item.status, 'error');
    assert.equal(item.score, null);
    assert.deepEqual(item.checks, []);
    assert.match(item.error, invalid.message);
    assert.equal(JSON.stringify(run).includes('PRIVATE_PROVIDER_CONTENT'), false);
    assert.equal(fixture.calls.length, 1);
    assert.deepEqual(fixture.budget(), { limit: 1, used: 1, reserved: 0, remaining: 0, unit: 'model_calls' });
  });
});

test('invalid JSON, refusals, and incomplete judge responses are errors', async () => {
  for (const choice of [
    { finish_reason: 'stop', message: { content: '{bad-json' } },
    { finish_reason: 'length', message: { content: JSON.stringify({ checks: [check()] }) } },
    { finish_reason: 'content_filter', message: { content: JSON.stringify({ checks: [check()] }) } },
    { finish_reason: 'stop', message: { refusal: 'Refused', content: JSON.stringify({ checks: [check()] }) } },
  ]) await assert.rejects(grade(modelCase(), base.actualOutput, env, async () => response([], { choices: [choice] })), error => error instanceof AppError);
});

test('legacy scalar/reference definitions rerun as binary criteria without altering the definitions', async () => {
  const legacy = { ...base, schemaVersion: 1, criteria: 'Positive behavior\nNegative behavior', expectedOutput: 'valid user\r\ninvalid password\nvalid user\n' };
  const before = structuredClone(legacy);
  for (const method of ['contains', 'not_contains']) {
    const result = await grade({ ...legacy, method }, base.actualOutput, {}, noFetch);
    assert.equal(result.score, method === 'contains' ? 100 : 0);
    assert.deepEqual(result.checks.map(c => c.criterion), ['valid user', 'invalid password']);
    assert.ok(result.checks.every(c => c.weight === 1 && typeof c.passed === 'boolean'));
  }
  assert.equal((await grade({ ...legacy, method: 'exact_match' }, legacy.expectedOutput, {}, noFetch)).score, 100);
  const modeled = await grade({ ...legacy, method: 'model_grade' }, base.actualOutput, env, async (_url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    assert.equal(input.expectedOutput, legacy.expectedOutput);
    assert.deepEqual(input.criteria.map(c => c.text), ['Positive behavior', 'Negative behavior']);
    return response([check(), check('c2', false, 'Negative behavior is not demonstrated.')]);
  });
  assert.equal(modeled.score, 50);
  assert.deepEqual(legacy, before);
  assert.deepEqual(normalizeCriteria({ method: 'contains', criteria: 'fallback\nsecond' }), [criterion('fallback'), criterion('second')]);
  for (const evaluation of [{ method: 'contains', criteria: null }, { method: 'model_grade', criteria: {} },
    { method: 'contains', criteria: undefined, expectedOutput: 42 }, { method: '__proto__', criteria: ['a'] },
    { method: 'contains', criteria: [criterion('a', 'model_grade')] }]) await assert.rejects(grade(evaluation, base.actualOutput, {}, noFetch), isAppError(400));
});

test('engine keeps 79.6 below the fixed pass threshold and tags only new runs', async t => {
  const fixture = setupEngine(t, { limit: 0, environment: {} });
  const historical = { ...base, schemaVersion: 2, threshold: 1, criteria: ['valid user'], id: 'historical-evaluation' };
  const historicalRun = { id: 'historical-run', status: 'completed', createdAt: '2026-01-01', items: [{ evaluation: historical, score: 93, checks: [{ score: 93 }] }] };
  fixture.store.saveRun(historicalRun, fixture.scope);
  const storedBefore = fixture.store.db.prepare('SELECT data FROM runs WHERE id=?').get(historicalRun.id).data;
  const { run } = await runCase(fixture, { ...base, threshold: 1, criteria: [criterion('valid user', 'contains', 79.6), criterion('missing', 'contains', 20.4)] });
  assert.equal(run.items[0].score, 79.6);
  assert.equal(run.items[0].status, 'failed');
  assert.equal(run.items[0].evaluation.threshold, 80);
  assert.equal(run.gradingVersion, 3);
  assert.equal(run.items[0].gradingVersion, 3);
  const atThreshold = await runCase(fixture, { ...base, criteria: ['valid', 'user', 'invalid', 'password', 'missing'] });
  assert.equal(atThreshold.run.items[0].score, 80);
  assert.equal(atThreshold.run.items[0].status, 'passed');
  const legacy = await runCase(fixture, historical);
  assert.equal(legacy.run.items[0].gradingVersion, 3);
  assert.deepEqual(legacy.run.items[0].evaluation.criteria, ['valid user']);
  assert.equal(legacy.run.items[0].evaluation.schemaVersion, 2);
  assert.equal(fixture.store.evaluation(legacy.saved.id, fixture.scope).threshold, 1);
  assert.equal(fixture.store.db.prepare('SELECT data FROM runs WHERE id=?').get(historicalRun.id).data, storedBefore);
  assert.equal(fixture.calls.length, 0);
});

test('decimal weights pass at exactly 80 regardless of summation order, while a nearby lower score fails', async t => {
  const fixture = setupEngine(t, { limit: 0, environment: {} });
  for (const criteria of [
    ['valid', 'user', 'invalid', 'password', 'missing'].map(text => criterion(text, 'contains', 0.1)),
    [criterion('missing', 'contains', 0.015), criterion('valid', 'contains', 0.01), criterion('user', 'contains', 0.01), criterion('password', 'contains', 0.04)],
    [criterion('missing', 'contains', 0.0275), criterion('valid', 'contains', 0.01), criterion('user', 'contains', 0.06), criterion('password', 'contains', 0.04)],
  ]) {
    const forward = await runCase(fixture, { ...base, criteria });
    const reversed = await runCase(fixture, { ...base, criteria: [...criteria].reverse() });
    assert.equal(forward.run.items[0].score, 80);
    assert.equal(reversed.run.items[0].score, 80);
    assert.equal(forward.run.items[0].status, 'passed');
    assert.equal(reversed.run.items[0].status, 'passed');
  }
  const { run } = await runCase(fixture, { ...base, criteria: [criterion('missing', 'contains', 0.015000001), criterion('valid user', 'contains', 0.06)] });
  assert.ok(run.items[0].score < 80);
  assert.equal(run.items[0].status, 'failed');
  assert.equal(fixture.calls.length, 0);
});

test('hybrid rule-only runs use zero judge budget and ignore stale judge credentials', async t => {
  const fixture = setupEngine(t, { limit: 0, environment: {} });
  const { run } = await runCase(fixture, { ...base, method: 'hybrid', judgeModel: 'o1-mini', criteria: [criterion('valid user'), criterion('TODO', 'not_contains')] });
  assert.equal(run.items[0].status, 'passed');
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(fixture.budget(), { limit: 0, used: 0, reserved: 0, remaining: 0, unit: 'model_calls' });
});

test('hybrid generation plus one judge call reserves two calls and closes the allowance', async t => {
  const fixture = setupEngine(t, { limit: 2, fetchImpl: async (_url, options) => JSON.parse(options.body).response_format
    ? response([check('c2'), check('c3', false, 'No boundary scenario appears.')])
    : response([], { choices: [{ finish_reason: 'stop', message: { content: base.actualOutput } }] }) });
  const evaluation = validateEvaluation({ ...base, source: 'llm', model: 'mock-generator', method: 'hybrid', criteria: [
    criterion('valid user'), criterion('Positive behavior', 'model_grade'), criterion('Boundary behavior', 'model_grade'),
  ] });
  const saved = fixture.store.create(evaluation, fixture.scope);
  const run = fixture.engine.start([saved.id], fixture.scope);
  assert.equal(fixture.budget().reserved, 2);
  assert.equal(fixture.calls.length, 0);
  await fixture.engine.drain(); fixture.engine.resume();
  assert.equal(fixture.store.run(run.id, fixture.scope).items[0].status, 'failed');
  assert.equal(fixture.calls.length, 2);
  assert.deepEqual(fixture.budget(), { limit: 2, used: 2, reserved: 0, remaining: 0, unit: 'model_calls' });
  assert.throws(() => fixture.engine.start([saved.id], fixture.scope), isAppError(429));
  assert.equal(fixture.calls.length, 2);
});

test('hybrid batch budget rejects unaffordable runs before any model attempt', t => {
  const fixture = setupEngine(t, { limit: 1 });
  const evaluation = validateEvaluation({ ...base, source: 'llm', model: 'mock-generator', method: 'hybrid', criteria: [criterion('Positive behavior', 'model_grade')] });
  const saved = fixture.store.create(evaluation, fixture.scope);
  assert.throws(() => fixture.engine.start([saved.id], fixture.scope), isAppError(429));
  assert.deepEqual(fixture.store.runs(fixture.scope), []);
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.budget().remaining, 1);
});

test('hybrid judge preflight prevents paid generation when credentials, model, or criteria are invalid', async t => {
  for (const invalid of [{ environment: {}, judgeModel: 'gpt-4o-mini', pattern: /OPENAI_API_KEY/ },
    { environment: env, judgeModel: 'o1-mini', pattern: /structured grading/ },
    { environment: env, judgeModel: '', pattern: /model grader/ },
    { environment: env, judgeModel: 'gpt-4o-mini', weight: 0, pattern: /weight/ }]) {
    await t.test(invalid.pattern.source, async t => {
      const fixture = setupEngine(t, { environment: invalid.environment });
      const { run } = await runCase(fixture, { ...base, source: 'llm', model: 'mock-generator', method: 'hybrid', judgeModel: invalid.judgeModel,
        criteria: [criterion('Positive behavior', 'model_grade', invalid.weight ?? 1)] });
      assert.equal(run.items[0].status, 'error');
      assert.equal(run.items[0].score, null);
      assert.match(run.items[0].error, invalid.pattern);
      assert.equal(fixture.calls.length, 0);
      assert.deepEqual(fixture.budget(), { limit: 2, used: 0, reserved: 0, remaining: 2, unit: 'model_calls' });
    });
  }
});

test('out-of-range judge evidence errors the run, charges one attempt, and releases reservations', async t => {
  const fixture = setupEngine(t, { limit: 1, fetchImpl: async () => response([check('c2', true, [999])]) });
  const { run } = await runCase(fixture, validateEvaluation({ ...base, method: 'hybrid', criteria: [criterion('valid user'), criterion('Positive behavior', 'model_grade')] }));
  assert.equal(run.items[0].status, 'error');
  assert.equal(run.items[0].score, null);
  assert.deepEqual(run.items[0].checks, []);
  assert.match(run.items[0].error, /valid source line numbers/);
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(fixture.budget(), { limit: 1, used: 1, reserved: 0, remaining: 0, unit: 'model_calls' });
});
