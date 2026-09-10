import { test, expect } from './browser-fixtures.mjs';

async function seed(page, app, status = 'completed') {
  await page.goto('/'); await expect(page.locator('#workspace')).toBeVisible();
  const session = await (await page.request.get('/api/session')).json(), scope = { ownerId: session.workspaceId, workshopId: 'browser-tests' };
  const suite = app.store.createSuite({ name: 'Current suite' }, scope);
  const evaluation = { id: 'evaluation', name: 'Base', source: 'testcraft_api', type: 'ideas', method: 'contains', criteria: ['login', 'logout'], html: '<button>Login</button>', model: 'gpt-4o-mini' };
  const cases = [
    ['b', 'Beta', 49.99, 'passed', { suiteName: 'Saved suite', model: 'gpt-4o', method: 'model_grade' }],
    ['a', 'Alpha', 50, 'failed', { suiteId: suite.id }],
    ['c', 'Gamma', 79.99, 'failed', { suiteId: 'missing', method: 'hybrid', criteria: [{ text: 'login', method: 'contains' }, { text: 'logout', method: 'model_grade' }] }],
    ['d', 'Delta', 80, 'passed', { suiteName: 'Saved suite' }],
    ['e', 'Epsilon', 0, 'failed', { method: 'not_contains' }],
    ['f', 'Zeta', null, status === 'running' ? 'grading' : 'error', { source: 'pasted', suiteName: 'Unfiled' }],
  ];
  const run = { id: 'detail-example', createdAt: '2026-09-08T12:00:00Z', status, description: 'Hidden description', settings: { environment: 'dev', generationModel: 'gpt-4o-mini', graderModel: 'gpt-4o' }, items: cases.map(([id, name, score, itemStatus, extra], index) => ({
    id, evaluationId: evaluation.id, evaluation: { ...evaluation, name, ...extra }, status: itemStatus, score,
    output: '<script>window.untrustedOutput = true</script>\n<button>Login</button>',
    checks: score === null ? [] : ['login', 'logout'].map((criterion, i) => ({ id: 'c' + i, criterion, method: extra.method === 'model_grade' ? 'model_grade' : extra.method === 'hybrid' && i === 1 ? 'model_grade' : extra.method || 'contains', passed: index === 3 || index === 0 || (index !== 4 && i === 0), reason: 'The response includes the required behavior. ' + 'A long historical explanation. '.repeat(15), evidence: 'PRIVATE EVIDENCE', weight: 2 })),
    ...(score === null && status !== 'running' ? { error: 'Synthetic grading failure.' } : {}), events: [],
  })) };
  app.store.saveRun(run, scope); await page.goto('/#runs/' + run.id);
  await expect(page.locator('.detail-eval-row')).toHaveCount(6);
  return { run, scope };
}
const ids = page => page.locator('.detail-eval-row').evaluateAll(rows => rows.map(row => row.dataset.detailItem));

test('detail table has concise metadata, normalized score boundaries and combined filters', async ({ page, browserApp }) => {
  await page.route('**/api/models?environment=dev', route => route.fulfill({ json: { models: [{ id: 'gpt-4o', label: 'GPT 4o' }, { id: 'gpt-4o-mini', label: 'gpt-4o-mini' }] } }));
  await seed(page, browserApp);
  await expect(page.locator('.detail-table th')).toHaveText(['Eval ID ↕', 'Eval name ↕', 'Suite ↕', 'Model ↕', 'Eval method ↕', 'Status ↕', 'Score ↕', 'Criteria met ↕']);
  await expect(page.locator('.run-context')).toHaveText('Env: Dev · Grader: GPT 4o');
  await expect(page.locator('.run-top')).not.toContainText('Hidden description');
  const summary = page.getByRole('table', { name: 'Model summary', exact: true });
  await expect(page.locator('.model-summary')).not.toContainText('Counts include all evals in the run.');
  await expect(page.locator('#model-summary-help')).toHaveCount(0);
  await expect(summary.locator('thead th')).toHaveText(['Model', 'Model-graded evals', 'Rule-based evals', 'Hybrid evals', 'Total evals', 'Total score']);
  await expect(summary.locator('tbody th')).toHaveText(['gpt-4o-mini', 'GPT 4o', 'Supplied output']);
  await expect(summary.locator('tbody tr').first().locator('td')).toHaveText(['0', '3', '1', '4', '0.52 4/4 scored']);
  const headerBox = await page.locator('.run-top').boundingBox(), summaryBox = await page.locator('.model-summary').boundingBox(), filtersBox = await page.locator('.detail-filters').boundingBox();
  expect(summaryBox.y).toBeGreaterThanOrEqual(headerBox.y + headerBox.height);
  expect(summaryBox.y + summaryBox.height).toBeLessThanOrEqual(filtersBox.y);
  await expect(page.locator('.result-score')).toHaveText(['0.50', '0.50', '0.80', '0.80', '0.00', '—']);
  for (const [id, color] of [['b', 'low'], ['a', 'medium'], ['c', 'medium'], ['d', 'high'], ['e', 'low'], ['f', 'missing']]) await expect(page.locator('[data-detail-item="' + id + '"] .result-score span')).toHaveClass('score-' + color);
  await expect(page.locator('.criteria-met')).toHaveText(['2/2', '1/2', '1/2', '2/2', '0/2', '—/2']);
  for (const [range, expected] of [['low', ['b', 'e']], ['medium', ['a', 'c']], ['high', ['d']]]) { await page.locator('#detail-filter-score').selectOption(range); expect(await ids(page)).toEqual(expected); }
  await page.locator('#detail-filter-score').selectOption('');
  await page.locator('#detail-filter-suite').selectOption('Saved suite');
  await page.locator('#detail-filter-model').selectOption('GPT 4o');
  await expect(page.locator('#detail-filter-method option')).toHaveText(['All methods', 'hybrid', 'model-graded', 'rule-based']);
  await page.locator('#detail-filter-method').selectOption('model-graded');
  expect(await ids(page)).toEqual(['b']); await expect(page.locator('.detail-count')).toHaveText('1 of 6 evaluations');
  await page.locator('#detail-filter-score').selectOption('high');
  await expect(page.locator('.detail-empty')).toHaveText('No evaluations match these filters.');
  await expect(summary.locator('tbody tr')).toHaveCount(3);
  await expect(summary.locator('tbody tr').first().locator('td')).toHaveText(['0', '3', '1', '4', '0.52 4/4 scored']);
});

test('all columns sort both ways with stable ties and missing numeric values last', async ({ page, browserApp }) => {
  await seed(page, browserApp);
  const ascending = { name: ['a', 'b', 'd', 'e', 'c', 'f'], suite: ['a', 'e', 'f', 'b', 'd', 'c'], model: ['b', 'a', 'c', 'd', 'e', 'f'], method: ['c', 'b', 'a', 'd', 'e', 'f'], status: ['f', 'b', 'a', 'c', 'd', 'e'], score: ['e', 'b', 'a', 'c', 'd', 'f'], met: ['e', 'a', 'c', 'b', 'd', 'f'] };
  const descending = { name: ['f', 'c', 'e', 'd', 'b', 'a'], suite: ['c', 'b', 'd', 'e', 'f', 'a'], model: ['a', 'c', 'd', 'e', 'b', 'f'], method: ['a', 'd', 'e', 'f', 'b', 'c'], status: ['b', 'a', 'c', 'd', 'e', 'f'], score: ['d', 'c', 'a', 'b', 'e', 'f'], met: ['b', 'd', 'a', 'c', 'e', 'f'] };
  for (const key of Object.keys(ascending)) {
    await page.locator('#detail-sort-' + key).click(); expect(await ids(page), key + ' ascending').toEqual(ascending[key]);
    await expect(page.locator('#detail-sort-' + key).locator('..')).toHaveAttribute('aria-sort', 'ascending');
    await page.locator('#detail-sort-' + key).click(); expect(await ids(page), key + ' descending').toEqual(descending[key]);
    await expect(page.locator('#detail-sort-' + key).locator('..')).toHaveAttribute('aria-sort', 'descending');
  }
});

test('multiple rows expand with keyboard, concise reasons, saved output and preserved navigation state', async ({ page, browserApp }) => {
  await seed(page, browserApp);
  const model = page.locator('#expand-b'), rule = page.locator('#expand-a');
  await expect(model).toHaveAttribute('aria-expanded', 'false');
  await model.focus(); await page.keyboard.press('Enter'); await expect(model).toBeFocused();
  await rule.focus(); await page.keyboard.press('Space');
  await expect(model).toHaveAttribute('aria-expanded', 'true'); await expect(rule).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#criteria-b .criterion-description')).toHaveText(['login', 'logout']);
  await expect(page.locator('#criteria-a .criterion-description')).toHaveText(['Description not added yet', 'Description not added yet']);
  await expect(page.locator('#criteria-a .criterion-reason').last()).toHaveText('Contains: “logout” — Not met');
  await expect(page.locator('#criteria-b .criterion-reason').first()).toHaveAttribute('title', /A long historical explanation/);
  await page.locator('#output-toggle-b').click(); await expect(page.locator('#criteria-b .saved-output')).toBeVisible();
  await expect(page.locator('#criteria-b .saved-output')).toContainText('<script>window.untrustedOutput = true</script>');
  expect(await page.evaluate(() => window.untrustedOutput)).toBeUndefined();
  await expect(page.locator('#run-detail')).not.toContainText('PRIVATE EVIDENCE');
  await expect(page.locator('#run-detail')).not.toContainText('weight');
  await expect(page.getByText('Inspect saved input, HTML, and criteria', { exact: true })).toHaveCount(0);
  await page.locator('#detail-filter-suite').selectOption('Saved suite'); await page.locator('#detail-sort-name').click();
  await page.getByRole('link', { name: 'Back to runs' }).click(); await page.goBack();
  await expect(page.locator('#detail-filter-suite')).toHaveValue('Saved suite'); await expect(model).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#criteria-b details')).toHaveAttribute('open', '');
  await page.reload(); await expect(model).toHaveAttribute('aria-expanded', 'false'); await expect(page.locator('#detail-filter-suite')).toHaveValue('');
});

test('polling retains focus, filters, sort and output expansion while the final item completes', async ({ page, browserApp }) => {
  const { run, scope } = await seed(page, browserApp, 'running');
  const suppliedSummary = page.getByRole('table', { name: 'Model summary', exact: true }).getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Supplied output', exact: true }) });
  await expect(suppliedSummary.locator('.model-total-score')).toHaveText('— 0/1 scored');
  await page.locator('#expand-f').click(); await page.locator('#output-toggle-f').click();
  await expect(page.locator('#criteria-f')).toContainText('Waiting for grading results');
  await page.locator('#detail-filter-suite').selectOption('None'); await page.locator('#detail-sort-score').click();
  await page.locator('#output-toggle-f').focus();
  run.items[5].status = 'failed'; run.items[5].score = 50; run.items[5].checks = run.items[1].checks; run.status = 'completed';
  browserApp.store.saveRun(run, scope);
  await expect(page.locator('[data-detail-item="f"] .badge')).toHaveText('Graded');
  await expect(suppliedSummary.locator('.model-total-score')).toHaveText('0.50 1/1 scored');
  await expect(page.locator('#detail-filter-suite')).toHaveValue('None'); await expect(page.locator('#detail-sort-score').locator('..')).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.locator('#expand-f')).toHaveAttribute('aria-expanded', 'true'); await expect(page.locator('#criteria-f details')).toHaveAttribute('open', '');
  await expect(page.locator('#output-toggle-f')).toBeFocused();
});

test('legacy numeric grading, interrupted items and missing settings remain readable', async ({ page, browserApp }) => {
  const { run, scope } = await seed(page, browserApp);
  delete run.settings; run.status = 'interrupted';
  run.items[0].checks = [{ criterion: 'Old numeric rubric', score: 60, method: 'model_grade', reason: 'Legacy explanation.' }];
  run.items[5].error = 'Server restarted before this evaluation finished. Run it again.';
  browserApp.store.saveRun(run, scope); await page.reload();
  await expect(page.locator('.run-context')).toHaveText('Env: — · Grader: —');
  await expect(page.locator('[data-detail-item="b"] .criteria-met')).toHaveText('—/2');
  await page.locator('#expand-b').click(); await expect(page.locator('#criteria-b [role="img"]')).toHaveAttribute('aria-label', 'Historical score 0.60');
  await expect(page.locator('[data-detail-item="f"] .badge')).toHaveText('Interrupted'); await page.locator('#expand-f').click();
  await expect(page.locator('#criteria-f [role="alert"]')).toContainText('Server restarted');
});

test('errors retain saved output and historical empty runs have explicit empty states', async ({ page, browserApp }) => {
  const { run, scope } = await seed(page, browserApp);
  await page.locator('#expand-f').click(); await expect(page.locator('#criteria-f [role="alert"]')).toHaveText('Synthetic grading failure.');
  await page.locator('#output-toggle-f').click(); await expect(page.locator('#criteria-f .saved-output')).toContainText('<button>Login</button>');
  run.items[5].output = null; browserApp.store.saveRun(run, scope); await page.reload();
  await page.locator('#expand-f').click(); await page.locator('#output-toggle-f').click(); await expect(page.locator('#criteria-f .saved-output')).toHaveText('No output was saved.');
  run.items = []; browserApp.store.saveRun(run, scope); await page.reload();
  await expect(page.locator('.detail-empty')).toHaveText('No evaluations in this run.');
  await expect(page.locator('.detail-count')).toHaveText('0 of 0 evaluations');
});

for (const width of [1280, 390]) test('detail layout stays usable at ' + width + 'px', async ({ page, browserApp }, testInfo) => {
  await page.setViewportSize({ width, height: 850 });
  const { run, scope } = await seed(page, browserApp);
  const longName = 'Login form · negative test coverage ' + '(copy) '.repeat(14);
  const longSuite = 'TestCraft Basic · 04 Framework and language compatibility <safe>', longModel = 'A generation model with a very long display name <safe>';
  run.items[0].evaluation.suiteName = longSuite;
  run.items[0].generationModel = longModel;
  run.items[0].evaluation.name = longName; browserApp.store.saveRun(run, scope); await page.reload();
  await page.locator('#expand-b').click(); await page.locator('#expand-a').click();
  await expect(page.locator('#expand-b')).toHaveAttribute('title', longName);
  await expect(page.locator('#expand-b')).toHaveAccessibleName(longName.trim());
  await expect(page.getByRole('table', { name: 'Model summary', exact: true }).getByRole('rowheader', { name: longModel, exact: true })).toHaveText(longModel);
  const layout = await page.locator('[data-detail-item="b"]').evaluate(row => {
    const label = row.querySelector('.detail-name'), cells = [...row.cells].map(cell => cell.getBoundingClientRect());
    return { truncated: label.scrollWidth > label.clientWidth, ellipsis: getComputedStyle(label).textOverflow, nameRight: label.getBoundingClientRect().right, suiteLeft: cells[2].left, widths: cells.map(cell => cell.width) };
  });
  expect(layout.truncated).toBe(true); expect(layout.ellipsis).toBe('ellipsis'); expect(layout.nameRight).toBeLessThan(layout.suiteLeft);
  expect(layout.widths[0]).toBeCloseTo(80, 0);
  for (const [index, text] of [[2, longSuite], [3, longModel]]) {
    const cell = page.locator('[data-detail-item="b"] > td').nth(index);
    await expect(cell).toHaveText(text);
    await expect(cell).toHaveAttribute('title', text);
    await expect(cell).toHaveCSS('text-overflow', 'ellipsis');
    await expect(cell).toHaveCSS('overflow-x', 'hidden');
    await expect(cell).toHaveCSS('white-space', 'nowrap');
    expect(await cell.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  }
  expect(layout.widths[1]).toBeGreaterThan(layout.widths[2]);
  expect(Math.abs(layout.widths[3] - layout.widths[4])).toBeLessThan(1); expect(Math.abs(layout.widths[4] - layout.widths[5])).toBeLessThan(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  const reason = page.locator('#criteria-b .criterion-reason').first();
  expect(await reason.evaluate(el => getComputedStyle(el).whiteSpace)).toBe(width > 760 ? 'nowrap' : 'normal');
  await expect(page.locator('#detail-filter-score')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('run-detail-' + width + '.png'), fullPage: true });
});
