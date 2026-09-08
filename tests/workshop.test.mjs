import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as workshop from '../src/evals/workshop.mjs';
import { validateEvaluation, PASS_THRESHOLD } from '../src/evals/validation.mjs';
import { grade } from '../src/evals/graders.mjs';
import { needsModelGrader } from '../src/evals/methods.mjs';

const { workshopSuite } = workshop;
const [complete, incomplete, trap, judgedTrap, forbidden, strongHybrid, weakHybrid, exact] = workshopSuite.evaluations;
const criterionMethods = ['contains', 'not_contains', 'exact_match', 'model_grade'];
const payloadFields = ['name', 'type', 'framework', 'language', 'source', 'method', 'model', 'judgeModel', 'pageUrl', 'pom', 'fromIdeas', 'ideas', 'input', 'html', 'actualOutput', 'criteria'].sort();

async function gradeLocally(payload, output = payload.actualOutput) {
  const evaluation = validateEvaluation(payload);
  assert.ok(evaluation.criteria.every(criterion => criterion.method !== 'model_grade'));
  let calls = 0;
  const result = await grade(evaluation, output, {}, async () => {
    calls++;
    throw new Error('Workshop deterministic tests must not call a provider');
  });
  assert.equal(calls, 0);
  assert.equal(result.judgeModel, null);
  return result;
}

test('workshop exports only a bounded plain-data suite, with no completed-run records', () => {
  assert.deepEqual(Object.keys(workshop), ['workshopSuite']);
  assert.equal(Object.getPrototypeOf(workshopSuite), Object.prototype);
  assert.deepEqual(Object.keys(workshopSuite).sort(), ['evaluations', 'name']);
  assert.equal(workshopSuite.name, 'SauceDemo · Workshop');
  assert.equal(workshopSuite.evaluations.length, 8);
  assert.equal(new Set(workshopSuite.evaluations.map(evaluation => evaluation.name)).size, 8);
  assert.deepEqual(JSON.parse(JSON.stringify(workshopSuite)), workshopSuite);
  assert.ok(Buffer.byteLength(JSON.stringify(workshopSuite), 'utf8') < 60000);

  for (const evaluation of workshopSuite.evaluations) {
    assert.equal(Object.getPrototypeOf(evaluation), Object.prototype);
    assert.deepEqual(Object.keys(evaluation).sort(), payloadFields);
    assert.ok(evaluation.name.length <= 140);
    assert.ok(evaluation.input.length > 0 && evaluation.input.length <= 1200);
    assert.ok(evaluation.html.length > 0 && evaluation.html.length <= 2000);
    assert.ok(evaluation.actualOutput.length > 0 && evaluation.actualOutput.length <= 3000);
    assert.ok(evaluation.criteria.length >= 1 && evaluation.criteria.length <= 3);
    assert.ok(evaluation.criteria.reduce((sum, criterion) => sum + criterion.text.length, 0) <= 2000);
    assert.ok(evaluation.pageUrl.length <= 2000);
    assert.match(evaluation.input, /synthetic.*simplified/i);
    assert.match(evaluation.html, /<!-- Synthetic, simplified fixture inspired by SauceDemo; not live HTML\./);
    assert.match(evaluation.actualOutput, /synthetic/i);
    if (evaluation !== exact) assert.match(evaluation.actualOutput, /not captured TestCraft output/);
    assert.equal(evaluation.source, 'pasted');
    assert.equal(evaluation.model, '');
    assert.equal(evaluation.pom, false);
    assert.equal(evaluation.fromIdeas, false);
    assert.equal(evaluation.ideas, '');
    const needsJudge = evaluation.criteria.some(criterion => criterion.method === 'model_grade');
    assert.equal(evaluation.judgeModel, needsJudge ? 'gpt-4o-mini' : '');
    for (const criterion of evaluation.criteria) {
      assert.equal(Object.getPrototypeOf(criterion), Object.prototype);
      assert.deepEqual(Object.keys(criterion).sort(), ['method', 'text', 'weight']);
      assert.ok(criterionMethods.includes(criterion.method));
      assert.ok(criterion.text.trim().length > 0);
      assert.ok(Number.isFinite(criterion.weight) && criterion.weight > 0 && criterion.weight <= 100);
      if (evaluation.method !== 'hybrid') assert.equal(criterion.method, evaluation.method);
    }
  }
});

test('every complete workshop payload validates against the canonical version 3 contract', () => {
  const before = JSON.stringify(workshopSuite);
  assert.equal(PASS_THRESHOLD, 80);
  for (const evaluation of workshopSuite.evaluations) {
    const canonical = validateEvaluation(evaluation);
    assert.equal(canonical.schemaVersion, 3, evaluation.name);
    assert.equal(canonical.threshold, 80, evaluation.name);
    for (const field of payloadFields) assert.deepEqual(canonical[field], evaluation[field], `${evaluation.name}: ${field}`);
  }
  assert.equal(JSON.stringify(workshopSuite), before, 'Validation must not mutate the shared teaching data');
});

test('pasted suite reserves only one judge call for each model or hybrid case', () => {
  const calls = workshopSuite.evaluations.map(evaluation => Number(evaluation.source !== 'pasted') + Number(needsModelGrader(evaluation)));
  assert.deepEqual(calls, [0, 0, 0, 1, 0, 1, 1, 0]);
  assert.equal(calls.reduce((sum, count) => sum + count, 0), 3);
});

for (const [fixture, expectedScore, expectedChecks, expectedPassed] of [
  [complete, 100, [100, 100, 100], true],
  [incomplete, 100 / 3, [100, 0, 0], false],
  [trap, 100, [100, 100, 100], true],
  [forbidden, 100, [100, 100], true],
  [exact, 100, [100], true],
]) {
  test(`${fixture.name}: deterministic checks and policy result need no keys`, async () => {
    const result = await gradeLocally(fixture);
    assert.ok(Math.abs(result.score - expectedScore) < 1e-9, `Expected ${expectedScore}, got ${result.score}`);
    assert.equal(result.score >= PASS_THRESHOLD, expectedPassed);
    assert.deepEqual(result.checks.map(check => check.score), expectedChecks);
    assert.deepEqual(result.checks.map(check => check.passed), expectedChecks.map(score => score === 100));
    assert.deepEqual(result.checks.map(check => check.criterion), fixture.criteria.map(criterion => criterion.text));
    for (const check of result.checks) {
      assert.ok(typeof check.evidence === 'string' && check.evidence.trim().length > 0);
      assert.ok(typeof check.reason === 'string' && check.reason.trim().length > 0);
    }
    assert.deepEqual(await gradeLocally(fixture), result, 'Regrading identical pasted text repeats the same local result');
  });
}

test('baseline isolates coverage; modifying one literal criterion changes only its check', async () => {
  assert.deepEqual(complete.criteria, incomplete.criteria);
  assert.equal(complete.input, incomplete.input);
  assert.equal(complete.html, incomplete.html);
  const revised = {
    ...complete,
    criteria: complete.criteria.map((criterion, index) => index === 2 ? { ...criterion, text: 'empty password' } : { ...criterion }),
  };
  const result = await gradeLocally(revised);
  assert.ok(Math.abs(result.score - 200 / 3) < 1e-9);
  assert.deepEqual(result.checks.map(check => check.score), [100, 100, 0]);
  assert.equal(complete.criteria[2].text, 'missing password');
});

test('comment-only keywords produce the deliberate false positive, not evidence of behavior', async () => {
  const withoutComments = trap.actualOutput.split('\n').filter(line => !line.trimStart().startsWith('//')).join('\n');
  for (const criterion of trap.criteria) {
    assert.ok(trap.actualOutput.includes(criterion.text));
    assert.equal(withoutComments.includes(criterion.text), false);
  }
  assert.match(withoutComments, /expect\(true\)\.toBe\(true\)/);
  assert.doesNotMatch(withoutComments, /\.fill\(|\.click\(/);
  const result = await gradeLocally(trap);
  assert.equal(result.score, 100, 'Contains detects tokens, not a correct login test');
  assert.deepEqual(result.checks.map(check => check.evidence), trap.criteria.map(criterion => criterion.text));
  const stripped = await gradeLocally(trap, withoutComments);
  assert.equal(stripped.score, 0);
  assert.deepEqual(stripped.checks.map(check => check.score), [0, 0, 0]);
});

test('judge comparison holds the weak output and its context identical without calling a judge', () => {
  for (const field of ['actualOutput', 'input', 'html', 'pageUrl', 'type', 'framework', 'language']) {
    assert.equal(judgedTrap[field], trap[field]);
    assert.equal(weakHybrid[field], trap[field]);
  }
  assert.equal(judgedTrap.method, 'model_grade');
  assert.equal(judgedTrap.criteria[0].text, weakHybrid.criteria[2].text);
  assert.match(judgedTrap.criteria[0].text, /Comments listing API names/);
  assert.match(judgedTrap.criteria[0].text, /assertions on constants/);
  assert.notEqual(strongHybrid.actualOutput, weakHybrid.actualOutput);
  assert.equal(strongHybrid.actualOutput, forbidden.actualOutput);
});

test('hybrid pair shares the weighted rubric; both outputs satisfy its local portion', async () => {
  assert.deepEqual(strongHybrid.criteria, weakHybrid.criteria);
  assert.equal(strongHybrid.input, weakHybrid.input);
  assert.equal(strongHybrid.html, weakHybrid.html);
  assert.deepEqual(strongHybrid.criteria.map(criterion => [criterion.method, criterion.weight]), [
    ['contains', 10], ['contains', 10], ['model_grade', 80],
  ]);
  for (const fixture of [strongHybrid, weakHybrid]) {
    const localOnly = { ...fixture, method: 'contains', judgeModel: '', criteria: fixture.criteria.filter(criterion => criterion.method === 'contains') };
    const result = await gradeLocally(localOnly);
    assert.equal(result.score, 100, 'Only the local subset is graded; this is not a hybrid or judge score');
    assert.deepEqual(result.checks.map(check => check.score), [100, 100]);
  }
});

test('forbidden fragments include comments and are case-sensitive', async () => {
  const commented = await gradeLocally(forbidden, forbidden.actualOutput + '\n// TODO');
  assert.equal(commented.score, 50);
  assert.deepEqual(commented.checks.map(check => check.score), [100, 0]);
  assert.match(commented.checks[1].evidence, /TODO/);
  assert.equal((await gradeLocally(forbidden, forbidden.actualOutput + '\n// todo')).score, 100);
  assert.equal((await gradeLocally(forbidden, forbidden.actualOutput + '\n// TODO waitForTimeout')).score, 0);
});

test('exact match is a fixed-label contract, not semantic equivalence', async () => {
  assert.equal(exact.criteria.length, 1);
  assert.equal((await gradeLocally(exact, '\r\n  ' + exact.actualOutput + '  \r\n')).score, 100);
  for (const variant of [exact.actualOutput + '.', exact.actualOutput.toLowerCase(), exact.actualOutput.replace('_', ' ')]) {
    assert.equal((await gradeLocally(exact, variant)).score, 0);
  }
  const multiline = { ...exact, actualOutput: exact.actualOutput + '\nLABEL', criteria: [{ ...exact.criteria[0], text: exact.actualOutput + '\nLABEL' }] };
  assert.equal((await gradeLocally(multiline, multiline.actualOutput.replaceAll('\n', '\r\n'))).score, 100);
});

test('weights can pass incomplete coverage at the fixed 80 policy without model calls', async () => {
  const reweighted = {
    ...incomplete,
    criteria: incomplete.criteria.map((criterion, index) => ({ ...criterion, weight: index === 0 ? 80 : 10 })),
  };
  const boundary = await gradeLocally(reweighted);
  assert.deepEqual(boundary.checks.map(check => check.score), [100, 0, 0]);
  assert.equal(boundary.score, 80);
  assert.equal(boundary.score >= PASS_THRESHOLD, true);
  const adjusted = { ...reweighted, criteria: reweighted.criteria.map((criterion, index) => ({ ...criterion, weight: index === 0 ? 70 : criterion.weight })) };
  const below = await gradeLocally(adjusted);
  assert.ok(Math.abs(below.score - 700 / 9) < 1e-9);
  assert.equal(below.score >= PASS_THRESHOLD, false);
  const nearBoundary = {
    ...incomplete,
    criteria: incomplete.criteria.map((criterion, index) => ({ ...criterion, weight: index === 0 ? 79.6 : 10.2 })),
  };
  const unrounded = await gradeLocally(nearBoundary);
  assert.ok(Math.abs(unrounded.score - 79.6) < 1e-9);
  assert.equal(unrounded.score >= PASS_THRESHOLD, false, 'Rounding to an integer must not turn 79.6 into a passing grade');
});
