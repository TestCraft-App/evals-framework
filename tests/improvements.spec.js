import { workshopSuites } from '../src/evals/workshop.mjs';
import { test, expect, openRunCreator, createSelectedRun } from './browser-fixtures.mjs';

const workshopCount = workshopSuites.reduce((sum, suite) => sum + suite.evaluations.length, 0);

test('Basic and Full actions load separate collections without generating output', async ({ page, generationCalls }) => {
  const ids = page.locator('#evaluation-rows .evaluation-id');
  const expectedIds = count => Array.from({ length: count }, (_, index) => 'EVAL-' + (index + 1)).sort();
  for (let load = 0; load < 2; load++) {
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
    await page.getByRole('button', { name: 'Load Basic Suite', exact: true }).click();
    await expect(page.locator('#evaluation-rows tr')).toHaveCount(12);
    expect((await ids.allTextContents()).sort()).toEqual(expectedIds(12));
  }
  const suites = (await (await page.request.get('/api/suites')).json()).suites;
  expect(suites).toHaveLength(6);
  await page.locator('#filter-suite').selectOption(suites[0].id);
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Load Full Suite', exact: true }).click();
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(workshopCount + 12);
  expect((await ids.allTextContents()).sort()).toEqual(expectedIds(workshopCount + 12));
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  const reloaded = page.waitForResponse(response => response.url().endsWith('/api/workshop-suite') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Load Full Suite', exact: true }).click();
  expect((await reloaded).status()).toBe(200);
  await page.reload();
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(workshopCount + 12);
  expect((await ids.allTextContents()).sort()).toEqual(expectedIds(workshopCount + 12));
  await openRunCreator(page);
  expect((await page.locator('#create-eval-rows .evaluation-id').allTextContents()).sort()).toEqual(expectedIds(workshopCount + 12));
  await page.locator('#cancel-create-run').click();
  expect(generationCalls).toHaveLength(0);
  expect((await (await page.request.get('/api/runs')).json()).runs).toHaveLength(0);
});

test.beforeEach(async ({ page }) => {
  await page.route('**/api/models', route => route.fulfill({ json: { source: 'testcraft', warning: null, models: [{ id: 'gpt-4o-mini', label: 'GPT-4o mini', graderCompatible: true }] } }));
  await page.goto('/');
  await expect(page.locator('#workspace')).toBeVisible();
});

async function example(page, name) {
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Load example', exact: true }).click();
  await page.getByLabel('Eval name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Create evaluation', exact: true }).click();
  await expect(page.locator('#evaluation-dialog')).not.toBeVisible();
}
async function auth(page) {
  const session = await (await page.request.get('/api/session')).json();
  return { origin: new URL(page.url()).origin, 'x-csrf-token': session.csrfToken };
}

test('Save updates a definition and preserves the earlier run snapshot', async ({ page }) => {
  await example(page, 'Editable login');
  const original = (await (await page.request.get('/api/evaluations')).json()).evaluations[0];
  await openRunCreator(page);
  await page.getByRole('checkbox', { name: 'Select Editable login', exact: true }).check();
  await createSelectedRun(page);
  await expect(page.locator('.result-score')).toContainText('1.00');
  const runUrl = page.url();
  await page.getByRole('tab', { name: /^Evaluations/ }).click();
  await page.locator('#evaluation-rows').getByRole('button', { name: 'Editable login', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Edit evaluation' })).toBeVisible();
  await page.getByLabel('Eval name', { exact: true }).fill('Updated login');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel('Criterion 1', { exact: true }).fill('missing new requirement');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#evaluation-dialog')).not.toBeVisible();
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(1);
  await expect(page.locator('#evaluation-rows')).toContainText('Updated login');
  await page.locator('#filter-status').selectOption('not_run');
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(1);
  const updated = (await (await page.request.get('/api/evaluations/' + original.id)).json());
  expect(updated.revision).toBe(2); expect(updated.createdAt).toBe(original.createdAt);
  await page.goto(runUrl);
  await expect(page.locator('.detail-eval-row')).toContainText('Editable login');
  await expect(page.locator('.result-score')).toContainText('1.00');
  await page.locator('.detail-expand').click();
  await expect(page.locator('.criterion-verdict[aria-label="Pass"]')).toHaveCount(3);
});

test('Duplicate creates an inline name editor and opens only after renaming', async ({ page }) => {
  await example(page, 'Original');
  const original = (await (await page.request.get('/api/evaluations')).json()).evaluations[0];
  await page.getByRole('button', { name: 'Duplicate Original', exact: true }).click();
  await expect(page.locator('#evaluation-dialog')).toBeHidden();
  await expect(page.locator('#duplicate-name')).toHaveValue('Original (copy)');
  await expect(page.locator('#duplicate-name')).toBeFocused();
  await expect(page.locator('#eval-count')).toHaveText('2');
  await page.locator('#duplicate-name').fill('Variant');
  await page.getByRole('button', { name: 'Save evaluation name', exact: true }).click();
  await expect(page.locator('#duplicate-name')).toHaveCount(0);
  await expect(page.locator('#evaluation-dialog')).toBeHidden();
  await page.getByRole('button', { name: 'Variant', exact: true }).click();
  await expect(page.locator('#name')).toHaveValue('Variant');
  await expect(page.locator('#duplicate-evaluation, #save-as-new')).toHaveCount(0);
  await expect(page.locator('.dialog-heading #delete-evaluation')).toBeVisible();
  await expect(page.locator('#delete-evaluation')).toHaveText('');
  await expect(page.locator('.dialog-footer #delete-evaluation')).toHaveCount(0);
  await page.locator('#delete-evaluation').click();
  await expect(page.getByRole('alertdialog', { name: 'Delete evaluation?' })).toBeVisible();
  await page.locator('#cancel-delete-library').click();
  await page.locator('#cancel-dialog').click();
  const { evaluations } = await (await page.request.get('/api/evaluations')).json();
  expect(evaluations).toHaveLength(2);
  expect(evaluations.find(e => e.id === original.id)).toEqual(original);
  const copy = evaluations.find(e => e.id !== original.id);
  expect(copy.name).toBe('Variant'); expect(copy.revision).toBe(2); expect(copy.criteria).toEqual(original.criteria);
});

test('stale Save preserves the draft without offering Save as new', async ({ page }) => {
  await example(page, 'Concurrent edits');
  const original = (await (await page.request.get('/api/evaluations')).json()).evaluations[0];
  await page.getByRole('button', { name: 'Concurrent edits', exact: true }).click();
  await page.getByLabel('Eval name', { exact: true }).fill('My draft');
  expect((await page.request.put('/api/evaluations/' + original.id, { headers: await auth(page), data: { ...original, name: 'Other tab change', revision: 1 } })).status()).toBe(200);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#form-error')).toContainText('Your draft is preserved');
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByLabel('Eval name', { exact: true })).toHaveValue('My draft');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#save-as-new')).toHaveCount(0);
  await page.locator('#cancel-dialog').click();
  await expect(page.locator('#eval-count')).toHaveText('1');
});

test('suite filter sits beside search and assignment stays in the evaluation form', async ({ page }) => {
  const response = await page.request.post('/api/suites', { headers: await auth(page), data: { name: 'Login rules' } });
  expect(response.ok()).toBe(true);
  await page.reload();
  await page.locator('#filter-suite').selectOption({ label: 'Login rules' });
  await example(page, 'Inside suite');
  await expect(page.locator('#evaluation-rows tr td').nth(2)).toHaveText('Login rules');
  await page.getByRole('button', { name: 'Edit Inside suite', exact: true }).click();
  await expect(page.locator('#evaluation-suite option:checked')).toHaveText('Login rules');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#filter-suite option[value=__unfiled]')).toHaveText('None');
  await page.locator('#filter-suite').selectOption('__unfiled');
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(0);
  await expect(page.locator('#empty-library')).toBeVisible();
  await page.locator('#filter-suite').selectOption('');
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(1);
  await expect(page.locator('.filters .search-field + label #filter-suite')).toHaveCount(1);
  await expect(page.locator('.suite-toolbar, #new-suite, #sort')).toHaveCount(0);
});

test('evaluation deletion requires confirmation and keeps run history', async ({ page }) => {
  await example(page, 'Delete definition');
  await openRunCreator(page);
  await page.getByRole('checkbox', { name: 'Select Delete definition', exact: true }).check();
  await createSelectedRun(page);
  await expect(page.locator('.result-score')).toContainText('1.00');
  const runUrl = page.url();
  await page.getByRole('tab', { name: /^Evaluations/ }).click();
  await page.getByRole('button', { name: 'Delete Delete definition', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete evaluation?' });
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#eval-count')).toHaveText('1');
  await page.getByRole('button', { name: 'Delete Delete definition', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete evaluation', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('#eval-count')).toHaveText('0');
  await page.goto(runUrl);
  await expect(page.locator('.detail-eval-row')).toContainText('Delete definition');
  await expect(page.locator('.result-score')).toContainText('1.00');
});

test('mixed rules use equal weights and run without a grader call', async ({ page }) => {
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Load example', exact: true }).click();
  await page.getByLabel('Eval name', { exact: true }).fill('Equal-weight rules');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#criteria-list li')).toHaveCount(3);
  await page.getByRole('combobox', { name: 'Criteria rule', exact: true }).selectOption('not_contains');
  await page.getByLabel('New criterion', { exact: true }).fill('valid credentials');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('#judge-model')).toHaveCount(0);
  await page.getByRole('button', { name: 'Create evaluation', exact: true }).click();
  await expect(page.locator('#evaluation-dialog')).not.toBeVisible();
  await openRunCreator(page);
  await page.getByRole('checkbox', { name: 'Select Equal-weight rules', exact: true }).check();
  await createSelectedRun(page);
  await expect(page.locator('.result-score')).toContainText('0.75');
  await page.locator('.detail-expand').click();
  await expect(page.locator('.criterion-verdict[aria-label="Pass"]')).toHaveCount(3);
  await expect(page.locator('.criterion-verdict[aria-label="Fail"]')).toHaveCount(1);
  await expect(page.locator('.criteria-met')).toHaveText('3/4');
  await expect(page.locator('.criterion-panel')).not.toContainText('weight');
  const session = await (await page.request.get('/api/session')).json();
  expect(session).not.toHaveProperty('budget');
});

test('model criteria retain their badge and text alongside rules', async ({ page }) => {
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Load example', exact: true }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.locator('#method').selectOption('model_based');
  await page.getByLabel('New criterion', { exact: true }).fill('The negative test states the expected error.');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('#judge-model')).toHaveCount(0);
  await expect(page.locator('#criteria-list .badge').last()).toHaveText('Model-graded');
  await expect(page.getByLabel('Criterion 4', { exact: true })).toHaveValue('The negative test states the expected error.');
});

test('workshop collection loads once, filters by suite, and makes no provider calls', async ({ page, generationCalls }) => {
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Load Full Suite', exact: true }).click();
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(workshopCount);
  const imported = (await (await page.request.get('/api/suites')).json()).suites;
  expect(imported).toHaveLength(workshopSuites.length);
  await page.locator('#filter-suite').selectOption(imported.find(suite => suite.seedKey === workshopSuites[3].seedKey).id);
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(workshopSuites[3].evaluations.length);
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Load Full Suite', exact: true }).click();
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(workshopCount);
  expect(generationCalls).toHaveLength(0);
  expect((await (await page.request.get('/api/runs')).json()).runs).toHaveLength(0);
  const session = await (await page.request.get('/api/session')).json();
  expect(session).not.toHaveProperty('budget');
  await page.reload();
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(workshopCount);
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 780 }]) {
  test(`criteria editor stays compact with badges and edit actions at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await example(page, 'Compact editor');
    await page.getByRole('button', { name: 'Compact editor', exact: true }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Criterion 2', { exact: true }).fill('A longer requirement remains on one row and scrolls inside its text field.');
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
    const layout = await page.locator('#evaluation-dialog').evaluate(dialog => {
      const footer = dialog.querySelector('.wizard-actions').getBoundingClientRect();
      return {
        overflowX: dialog.scrollWidth - dialog.clientWidth, overflowY: dialog.scrollHeight - dialog.clientHeight,
        nestedScroll: [...dialog.querySelectorAll('textarea')].some(el => el.getClientRects().length && el.scrollHeight > el.clientHeight + 2),
        actionsVisible: footer.top >= 0 && footer.bottom <= innerHeight,
        rowHeights: [...dialog.querySelectorAll('#criteria-list li')].map(row => row.getBoundingClientRect().height),
      };
    });
    expect(layout.overflowX).toBeLessThanOrEqual(2); expect(layout.overflowY).toBeLessThanOrEqual(2);
    expect(layout.actionsVisible).toBe(true);
    if (viewport.width > 700) expect(layout.rowHeights[0]).toBeLessThanOrEqual(100);
    await page.screenshot({ path: test.info().outputPath('hybrid-editor.png') });
  });
}


test('evaluation columns sort displayed values in both directions with icon-only actions', async ({ page }) => {
  const evaluations = [
    { id: 'a', name: 'Alpha <safe>', suiteId: 'z', type: 'ideas', method: 'contains', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'b', name: 'Beta', suiteId: 'a', type: 'code', method: 'model_grade', createdAt: '2026-01-02T00:00:00Z' },
    { id: 'c', name: 'Gamma', suiteId: null, type: 'ideas', method: 'hybrid', createdAt: '2026-01-03T00:00:00Z' },
  ];
  await page.route('**/api/evaluations', route => route.fulfill({ json: { evaluations } }));
  await page.route('**/api/suites', route => route.fulfill({ json: { suites: [{ id: 'z', name: 'Zulu' }, { id: 'a', name: 'Alpha' }] } }));
  await page.reload();
  const table = page.getByRole('table', { name: 'Evaluations', exact: true });
  await expect(table.locator('th')).toHaveText(['Eval ID', 'Eval name', 'Suite', 'Endpoint', 'Method', 'Created', 'Actions']);
  const rows = page.locator('#evaluation-rows tr');
  await expect(rows.locator('.eval-name')).toHaveText(['Gamma', 'Beta', 'Alpha <safe>']);
  for (const [key, order] of [['name', ['Alpha <safe>', 'Beta', 'Gamma']], ['suite', ['Beta', 'Gamma', 'Alpha <safe>']], ['type', ['Beta', 'Alpha <safe>', 'Gamma']], ['method', ['Gamma', 'Beta', 'Alpha <safe>']], ['createdAt', ['Gamma', 'Beta', 'Alpha <safe>']]]) {
    const button = page.locator('[data-eval-sort="' + key + '"]');
    await button.click();
    await expect(rows.locator('.eval-name')).toHaveText(order);
    await expect(button.locator('..')).toHaveAttribute('aria-sort', key === 'createdAt' ? 'descending' : 'ascending');
    await button.click();
    const reversed = key === 'type' ? ['Alpha <safe>', 'Gamma', 'Beta'] : [...order].reverse();
    await expect(rows.locator('.eval-name')).toHaveText(reversed);
    await expect(button.locator('..')).toHaveAttribute('aria-sort', key === 'createdAt' ? 'ascending' : 'descending');
  }
  await expect(page.locator('#evaluation-rows .row-actions button')).toHaveCount(9);
  for (const label of ['Edit', 'Duplicate', 'Delete']) {
    const action = table.getByRole('button', { name: label + ' Alpha <safe>', exact: true });
    await expect(action).toHaveText('');
    await expect(action.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  }
  await expect(table.locator('[data-run-link], safe')).toHaveCount(0);
  await expect(page.locator('#filter-method option')).toHaveText(['All methods', 'rule-based', 'model-graded', 'hybrid']);
  for (const [method, name] of [['rule_based', 'Alpha <safe>'], ['model_based', 'Beta'], ['hybrid', 'Gamma']]) {
    await page.locator('#filter-method').selectOption(method);
    await expect(rows.locator('.eval-name')).toHaveText([name]);
  }
  await page.locator('#filter-method').selectOption('');
  await page.locator('#search').fill('Alpha <safe>');
  await expect(rows).toHaveCount(1);
  await page.locator('#filter-suite').selectOption('a');
  await expect(rows).toHaveCount(0);
  await page.locator('#search').fill('');
  await expect(rows.locator('.eval-name')).toHaveText(['Beta']);
});


for (const width of [1440, 390]) test('library actions and field layout stay usable at ' + width + 'px', async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const toggle = page.getByRole('button', { name: 'Actions', exact: true });
  await expect(toggle.locator('svg')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('#example-button')).toBeHidden();
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const menuBox = await page.locator('#library-actions-menu').boundingBox();
  expect(menuBox.x).toBeGreaterThanOrEqual(0);
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(width);
  await page.keyboard.press('Tab');
  await expect(page.locator('#example-button')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
  await expect(page.locator('#library-actions-menu')).toBeHidden();
  await toggle.click();
  await page.getByRole('heading', { name: 'Evaluation library', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const name = 'Login form · negative test coverage (complete validation across all login scenarios)';
  await example(page, name);
  const button = page.locator('#evaluation-rows .eval-name');
  await expect(button).toHaveAttribute('title', name);
  const geometry = await button.evaluate(el => {
    const cell = el.closest('td'), style = getComputedStyle(cell);
    return { button: el.getBoundingClientRect().width, available: cell.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), client: el.clientWidth, scroll: el.scrollWidth };
  });
  expect(Math.abs(geometry.button - geometry.available)).toBeLessThan(2);
  const columns = await page.locator('.evaluations-table th').evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().width));
  expect(columns[0]).toBeCloseTo(80, 0);
  expect(columns[3]).toBeCloseTo(148, 0);
  expect(columns[4]).toBeCloseTo(columns[3], 0);
  expect(columns[5]).toBeCloseTo(columns[3], 0);
  if (width === 1440) {
    // The reference column shares the space previously reserved for the name.
    expect(geometry.button + columns[0]).toBeGreaterThan(470);
    expect(columns[2]).toBeGreaterThan(220);
  }
  const gap = await page.locator('#evaluation-rows .row-actions').evaluate(el => el.closest('td').getBoundingClientRect().right - el.lastElementChild.getBoundingClientRect().right);
  expect(gap).toBeCloseTo(24, 0);
  for (const field of await page.locator('#evaluations-panel .filters select').all()) {
    const sizing = await field.evaluate(el => {
      const s = getComputedStyle(el);
      return { height: el.clientHeight, font: parseFloat(s.fontSize), top: parseFloat(s.paddingTop), bottom: parseFloat(s.paddingBottom) };
    });
    expect(sizing.top).toBe(sizing.bottom);
    expect(sizing.height - sizing.top - sizing.bottom).toBeGreaterThan(sizing.font * 1.5);
  }
});
