import { test, expect, openRunCreator, createSelectedRun } from './browser-fixtures.mjs';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/models', route => route.fulfill({ json: { source: 'testcraft', warning: null, models: [{ id: 'gpt-4o-mini', label: 'GPT-4o mini', graderCompatible: true }] } }));
  await page.goto('/');
  await expect(page.locator('#workspace')).toBeVisible();
});

async function example(page, name) {
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
  await expect(page.locator('#evaluation-rows .badge.not_run')).toHaveText('Not run');
  const updated = (await (await page.request.get('/api/evaluations/' + original.id)).json());
  expect(updated.revision).toBe(2); expect(updated.createdAt).toBe(original.createdAt);
  await page.goto(runUrl);
  await expect(page.locator('.detail-eval-row')).toContainText('Editable login');
  await expect(page.locator('.result-score')).toContainText('1.00');
  await page.locator('.detail-expand').click();
  await expect(page.locator('.criterion-verdict[aria-label="Pass"]')).toHaveCount(3);
});

test('Duplicate and Save as new create independent cases', async ({ page }) => {
  await example(page, 'Original');
  await page.getByRole('button', { name: 'Duplicate Original', exact: true }).click();
  await expect(page.getByLabel('Eval name', { exact: true })).toHaveValue(/Original/);
  await expect(page.locator('#eval-count')).toHaveText('2');
  await page.getByLabel('Eval name', { exact: true }).fill('Third variant');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Save as new', exact: true }).click();
  await expect(page.locator('#evaluation-dialog')).not.toBeVisible();
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(3);
  const { evaluations } = await (await page.request.get('/api/evaluations')).json();
  expect(new Set(evaluations.map(e => e.id)).size).toBe(3);
  expect(evaluations.every(e => e.revision === 1 && e.latest === null)).toBe(true);
});

test('stale Save preserves the draft and offers Save as new', async ({ page }) => {
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
  await page.getByRole('button', { name: 'Save as new', exact: true }).click();
  await expect(page.locator('#eval-count')).toHaveText('2');
});

test('suites organize cases; deleting a folder moves them to Unfiled', async ({ page }) => {
  await page.getByRole('button', { name: 'New suite' }).click();
  await page.getByLabel('Suite name', { exact: true }).fill('Login rules');
  await page.getByRole('button', { name: 'Save suite', exact: true }).click();
  await expect(page.locator('#suite-dialog')).not.toBeVisible();
  await expect(page.locator('#filter-suite')).not.toHaveValue('');
  await example(page, 'Inside suite');
  await page.reload();
  await page.locator('#filter-suite').selectOption({ label: 'Login rules' });
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Rename suite', exact: true }).click();
  await page.getByLabel('Suite name', { exact: true }).fill('Authentication');
  await page.getByRole('button', { name: 'Save suite', exact: true }).click();
  await expect(page.locator('#suite-dialog')).not.toBeVisible();
  await page.getByRole('button', { name: 'Delete suite', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete suite?' });
  await expect(dialog).toContainText('evaluations move to Unfiled');
  await dialog.getByRole('button', { name: 'Delete suite', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.locator('#filter-suite').selectOption('__unfiled');
  await expect(page.locator('#evaluation-rows')).toContainText('Inside suite');
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

test('hybrid rules with custom weights calculate Pass/Fail without a grader call', async ({ page }) => {
  await page.getByRole('button', { name: 'Load example', exact: true }).click();
  await page.getByLabel('Eval name', { exact: true }).fill('Weighted hybrid');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('combobox', { name: 'Evaluation family', exact: true }).selectOption('hybrid');
  await expect(page.locator('#criteria-list li')).toHaveCount(3);
  await page.getByRole('combobox', { name: 'New criterion method', exact: true }).selectOption('not_contains');
  await page.getByLabel('New criterion', { exact: true }).fill('valid credentials');
  await page.getByRole('button', { name: 'Add criteria' }).click();
  await page.getByRole('checkbox', { name: 'Custom weights' }).check();
  await page.getByLabel('Weight for criterion 4', { exact: true }).fill('3');
  await expect(page.locator('#judge-model')).toHaveCount(0);
  await expect(page.locator('#grading-cost')).toContainText('0 model calls');
  await page.getByRole('button', { name: 'Create evaluation', exact: true }).click();
  await expect(page.locator('#evaluation-dialog')).not.toBeVisible();
  await openRunCreator(page);
  await page.getByRole('checkbox', { name: 'Select Weighted hybrid', exact: true }).check();
  await createSelectedRun(page);
  await expect(page.locator('.result-score')).toContainText('0.50');
  await page.locator('.detail-expand').click();
  await expect(page.locator('.criterion-verdict[aria-label="Pass"]')).toHaveCount(3);
  await expect(page.locator('.criterion-verdict[aria-label="Fail"]')).toHaveCount(1);
  await expect(page.locator('.criteria-met')).toHaveText('3/4');
  await expect(page.locator('#run-detail')).not.toContainText('weight');
  const session = await (await page.request.get('/api/session')).json();
  expect(session).not.toHaveProperty('budget');
});

test('hybrid model criteria enable the model dropdown and retain method-specific text', async ({ page }) => {
  await page.getByRole('button', { name: 'Load example', exact: true }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('combobox', { name: 'Evaluation family', exact: true }).selectOption('hybrid');
  await page.getByRole('combobox', { name: 'New criterion method', exact: true }).selectOption('model_grade');
  await page.getByLabel('New criterion', { exact: true }).fill('The negative test states the expected error.');
  await page.getByRole('button', { name: 'Add criteria' }).click();
  await expect(page.locator('#judge-model')).toHaveCount(0);
  await expect(page.locator('#grading-cost')).toContainText('1 model call');
  await page.getByRole('combobox', { name: 'Method for criterion 4', exact: true }).selectOption('contains');
  await expect(page.locator('#judge-model')).toHaveCount(0);
  await expect(page.getByLabel('Criterion 4', { exact: true })).toHaveValue('The negative test states the expected error.');
});

test('workshop suite loads once without spending model calls', async ({ page }) => {
  await page.getByRole('button', { name: 'Load workshop suite', exact: true }).click();
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(8);
  await page.getByRole('button', { name: 'Load workshop suite', exact: true }).click();
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(8);
  const session = await (await page.request.get('/api/session')).json();
  expect(session).not.toHaveProperty('budget');
  await page.reload();
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(8);
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 780 }]) {
  test(`hybrid editor stays compact with weights and edit actions at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await example(page, 'Compact editor');
    await page.getByRole('button', { name: 'Compact editor', exact: true }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('combobox', { name: 'Evaluation family', exact: true }).selectOption('hybrid');
    await page.getByRole('checkbox', { name: 'Custom weights' }).check();
    await page.getByLabel('Criterion 2', { exact: true }).fill('A longer requirement that wraps cleanly without adding its own scroll area to the editor.');
    await page.getByLabel('Weight for criterion 2', { exact: true }).fill('2');
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
    expect(layout.nestedScroll).toBe(false); expect(layout.actionsVisible).toBe(true);
    if (viewport.width > 700) expect(layout.rowHeights[0]).toBeLessThanOrEqual(50);
    await page.screenshot({ path: test.info().outputPath('hybrid-editor.png') });
  });
}
