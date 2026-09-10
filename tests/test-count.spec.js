import { test, expect, openRunCreator, createSelectedRun, selectGenerationModels } from './browser-fixtures.mjs';

async function createEvaluation(page, type = 'ideas', quality = false) {
  await page.goto('/'); await expect(page.locator('#workspace')).toBeVisible();
  await page.getByRole('button', { name: 'New evaluation', exact: false }).click();
  await page.locator('#name').fill('Quantity comparison');
  await page.locator('#html').fill('<button>Login</button>');
  await page.locator('#type').selectOption(type);
  if (type !== 'ideas') await page.locator('#page-url').fill('https://example.com/login');
  if (type === 'code_ideas') await page.locator('#ideas').fill('Login with a valid user');
  await page.getByRole('button', { name: 'Next', exact: false }).click();
  if (quality) {
    await page.locator('#method').selectOption('rule_based');
    await page.locator('#criterion-draft').fill('valid credentials');
    await page.locator('#add-criterion').click();
  }
  await page.locator('#method').selectOption('test_count');
  await expect(page.locator('#test-count-hint')).toContainText('does not affect the quality score');
  await expect(page.locator('#test-count-hint')).toContainText(type === 'ideas' ? 'separately proposed test ideas' : 'implemented automated tests');
  await expect(page.locator('#criterion-draft')).toBeHidden();
  await page.locator('#add-criterion').click();
  await expect(page.locator('#add-criterion')).toBeDisabled();
  await expect(page.locator('#criteria-list .badge').last()).toHaveText('Test count');
  const saving = page.waitForResponse(r => r.url().endsWith('/api/evaluations') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create evaluation', exact: true }).click();
  expect((await saving).status()).toBe(201);
}

for (const type of ['ideas', 'code', 'code_ideas']) {
  test(`${type} count-only creation, model comparison, persisted results and deletion`, async ({ page, browserApp, generationCalls }) => {
    browserApp.engine.env.OPENAI_API_KEY = 'synthetic-key';
    await createEvaluation(page, type);
    await page.getByRole('button', { name: 'Quantity comparison', exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: false }).click();
    await expect(page.locator('#method')).toHaveValue('test_count');
    await expect(page.locator('#criterion-0')).toHaveAttribute('readonly', '');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await openRunCreator(page); await selectGenerationModels(page, ['gpt-4o-mini', 'gpt-4o']);
    await page.getByRole('checkbox', { name: 'Select Quantity comparison', exact: true }).check();
    await page.locator('#create-grader-model').selectOption('');
    await expect(page.locator('#submit-create-run')).toBeDisabled();
    await page.locator('#create-grader-model').selectOption('gpt-4o-mini');
    await createSelectedRun(page);
    const unit = type === 'ideas' ? 'ideas' : 'automated tests';
    await expect(page.locator('.result-test-count')).toHaveText(['3 ' + unit, '3 ' + unit]);
    await expect(page.locator('.result-score')).toHaveText(['—', '—']);
    await expect(page.locator('.criteria-met')).toHaveText(['—', '—']);
    await expect(page.locator('.detail-eval-row .badge')).toHaveText(['Counted', 'Counted']);
    await expect(page.locator('.model-test-count')).toHaveText(['3 ' + unit + '1/1 counted', '3 ' + unit + '1/1 counted']);
    expect(generationCalls).toHaveLength(2);
    await page.locator('.detail-expand').first().click();
    await expect(page.locator('.criterion-description').first()).toHaveText('Test count: 3 ' + unit);
    await expect(page.locator('.count-evidence').first()).toContainText('<script>');
    expect(await page.evaluate(() => window.countInjection)).toBeUndefined();
    await page.reload(); await expect(page.locator('.result-test-count')).toHaveText(['3 ' + unit, '3 ' + unit]);
    await expect(page.locator('#detail-delete-run')).toBeEnabled();
    await page.locator('#detail-delete-run').click();
    await page.locator('#confirm-delete-run').click();
    await expect(page).toHaveURL(/#runs$/);
  });
}

test.describe('zero quantities', () => {
  test.use({ judgeCount: 0 });
  test('mixed criteria keep quality scores and criteria met independent of zero count', async ({ page, browserApp }) => {
    browserApp.engine.env.OPENAI_API_KEY = 'synthetic-key';
    await createEvaluation(page, 'ideas', true);
    await openRunCreator(page);
    await page.getByRole('checkbox', { name: 'Select Quantity comparison', exact: true }).check();
    await page.locator('#create-grader-model').selectOption('gpt-4o-mini');
    await createSelectedRun(page);
    await expect(page.locator('.result-test-count')).toHaveText('0 ideas');
    await expect(page.locator('.result-score')).toHaveText('1.00');
    await expect(page.locator('.criteria-met')).toHaveText('1/1');
    await expect(page.locator('.model-test-count')).toHaveText('0 ideas1/1 counted');
  });
});

test('count criterion survives duplication and can be removed without changing the original', async ({ page, generationCalls }) => {
  await createEvaluation(page, 'ideas', true);
  await page.getByRole('button', { name: 'Duplicate Quantity comparison', exact: true }).click();
  await expect(page.locator('#duplicate-name')).toBeFocused();
  await page.locator('#duplicate-name').press('Escape');
  await page.getByRole('button', { name: 'Quantity comparison (copy)', exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: false }).click();
  await expect(page.locator('#criteria-list .badge').last()).toHaveText('Test count');
  await page.locator('#method').selectOption('test_count');
  await expect(page.locator('#add-criterion')).toBeDisabled();
  await page.getByRole('button', { name: 'Remove criterion 2', exact: true }).click();
  await expect(page.locator('#add-criterion')).toBeEnabled();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#evaluation-dialog')).toBeHidden();
  const records = (await (await page.request.get('/api/evaluations')).json()).evaluations;
  expect(records.find(e => e.name === 'Quantity comparison').criteria.map(c => c.method)).toEqual(['contains', 'test_count']);
  expect(records.find(e => e.name === 'Quantity comparison (copy)').criteria.map(c => c.method)).toEqual(['contains']);
  expect(generationCalls).toHaveLength(0);
});

test('counts sort numerically and model totals retain units and state through polling', async ({ page, browserApp }) => {
  await page.goto('/'); await expect(page.locator('#workspace')).toBeVisible();
  const session = await (await page.request.get('/api/session')).json(), scope = { ownerId: session.workspaceId, workshopId: 'browser-tests' };
  const makeItem = (id, type, count) => ({ id, evaluationId: id, evaluation: { id, name: id, type, source: 'testcraft_api', model: 'gpt-4o-mini', method: 'test_count', criteria: [{ method: 'test_count', text: 'Count test ideas or automated tests in the output.', weight: 1 }] },
    status: count === undefined ? 'grading' : 'counted', score: null, output: 'Synthetic output',
    ...(count === undefined ? {} : { testCount: count, testCountUnit: type === 'ideas' ? 'ideas' : 'automated_tests' }),
    checks: count === undefined ? [] : [{ id: 'c1', method: 'test_count', count, unit: type === 'ideas' ? 'ideas' : 'automated_tests', evidence: 'Synthetic cases.', reason: 'Static count.' }] });
  const run = { id: 'count-polling', createdAt: '2026-09-10T12:00:00Z', status: 'running', settings: { environment: 'prod', generationModels: ['gpt-4o-mini'], graderModel: 'gpt-4o-mini' }, items: [makeItem('ideas', 'ideas', 12), makeItem('code', 'code', 2), makeItem('pending', 'ideas', undefined)] };
  browserApp.store.saveRun(run, scope); await page.goto('/#runs/' + run.id);
  await expect(page.locator('.model-count-total')).toHaveText(['12 ideas', '2 automated tests']);
  await expect(page.locator('.detail-table th')).toHaveText(['Eval ID ↕', 'Eval name ↕', 'Suite ↕', 'Model ↕', 'Eval method ↕', 'Status ↕', 'Score ↕', 'Test count ↕', 'Criteria met ↕']);
  const ids = () => page.locator('.detail-eval-row').evaluateAll(rows => rows.map(row => row.dataset.detailItem));
  await page.locator('#detail-sort-count').click(); expect(await ids()).toEqual(['code', 'ideas', 'pending']);
  await page.locator('#detail-sort-count').click(); expect(await ids()).toEqual(['ideas', 'code', 'pending']);
  await page.locator('#detail-filter-score').selectOption('high');
  await expect(page.locator('.detail-eval-row')).toHaveCount(0);
  await expect(page.locator('.model-count-total')).toHaveText(['12 ideas', '2 automated tests']);
  await page.locator('#detail-filter-score').selectOption('');
  await page.locator('#detail-filter-model').selectOption('gpt-4o-mini');
  await page.locator('#expand-pending').click(); await page.locator('#output-toggle-pending').click();
  await page.locator('#output-toggle-pending').focus();
  run.items[2] = makeItem('pending', 'ideas', 0); run.status = 'completed'; browserApp.store.saveRun(run, scope);
  await expect(page.locator('[data-detail-item="pending"] .result-test-count')).toHaveText('0 ideas');
  await expect(page.locator('.model-test-count')).toHaveText('12 ideas2/2 counted2 automated tests1/1 counted');
  expect(await ids()).toEqual(['ideas', 'code', 'pending']);
  await expect(page.locator('#detail-filter-model')).toHaveValue('gpt-4o-mini');
  await expect(page.locator('#detail-sort-count').locator('..')).toHaveAttribute('aria-sort', 'descending');
  await expect(page.locator('#expand-pending')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#criteria-pending details')).toHaveAttribute('open', '');
  await expect(page.locator('#output-toggle-pending')).toBeFocused();
});

test.describe('invalid quantities', () => {
  test.use({ judgeCount: -1 });
  test('a rejected count stays unavailable rather than zero', async ({ page, browserApp }) => {
    browserApp.engine.env.OPENAI_API_KEY = 'synthetic-key';
    await createEvaluation(page);
    await openRunCreator(page);
    await page.getByRole('checkbox', { name: 'Select Quantity comparison', exact: true }).check();
    await page.locator('#create-grader-model').selectOption('gpt-4o-mini');
    await createSelectedRun(page);
    await expect(page.locator('.detail-eval-row .badge')).toHaveText('Error');
    await expect(page.locator('.result-test-count')).toHaveText('—');
    await expect(page.locator('.model-test-count')).toHaveText('— ideas0/1 counted');
    await page.locator('.detail-expand').click();
    await expect(page.locator('#run-detail .error-banner')).toContainText('nonnegative safe integer');
  });
});
