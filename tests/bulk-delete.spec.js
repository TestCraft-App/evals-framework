import { test, expect } from './browser-fixtures.mjs';

async function seed(page, workspace = 'personal') {
  await page.goto('/#' + workspace + '/evaluations');
  await expect(page.locator('#workspace')).toBeVisible();
  const session = await (await page.request.get('/api/session')).json();
  const headers = { origin: new URL(page.url()).origin, 'x-csrf-token': session.csrfToken };
  const suiteResponse = await page.request.post('/api/workspaces/' + workspace + '/suites', { headers, data: { name: 'Synthetic suite' } });
  expect(suiteResponse.ok()).toBe(true);
  const suite = await suiteResponse.json(), records = [];
  for (const [index, name] of ['Alpha case', 'Beta case', '<img src=x onerror=window.bulkInjection=true>'].entries()) {
    const response = await page.request.post('/api/workspaces/' + workspace + '/evaluations', { headers, data: { name, type: 'ideas', method: 'contains', html: '<button>Login</button>', criteria: ['valid user'], suiteId: index < 2 ? suite.id : '' } });
    expect(response.ok()).toBe(true); records.push(await response.json());
  }
  await page.reload(); await expect(page.locator('#evaluation-rows tr')).toHaveCount(3);
  return { records, suite, scope: workspace === 'personal' ? { ownerId: session.workspaceId, workshopId: 'browser-tests' } : null };
}

test('selection persists through filters and tabs, select all affects visible rows, and confirmation deletes the entire selection', async ({ page, browserApp }) => {
  const { records, suite, scope } = await seed(page);
  const history = { id: 'saved-run', createdAt: '2026-01-01T00:00:00.000Z', status: 'completed', items: [{ evaluationId: records[0].id, evaluation: records[0], status: 'passed', output: 'valid user', score: 100 }] };
  browserApp.store.saveRun(history, scope);
  const all = page.getByRole('checkbox', { name: 'Select all visible evaluations', exact: true });
  await expect(page.locator('#delete-selected-evaluations')).toBeHidden();
  await page.getByRole('checkbox', { name: 'Select Alpha case', exact: true }).check();
  await expect(all).toHaveJSProperty('indeterminate', true);
  await expect(page.locator('#library-selected-count')).toHaveText('1 selected');
  await page.locator('#search').fill('Beta');
  await expect(all).not.toBeChecked(); await expect(all).toHaveJSProperty('indeterminate', false);
  await all.check();
  await expect(page.locator('#delete-selected-evaluations')).toHaveText('Delete selected (2)');
  await all.uncheck();
  await expect(page.locator('#library-selected-count')).toHaveText('1 selected');
  await page.locator('#search').fill('');
  await page.locator('#filter-suite').selectOption(suite.id);
  await all.check();
  await page.locator('[data-eval-sort="name"]').click();
  await expect(page.locator('#evaluation-rows input:checked')).toHaveCount(2);
  await page.getByRole('tab', { name: /^Runs/ }).click();
  await page.getByRole('tab', { name: /^Evaluations/ }).click();
  await expect(page.locator('#library-selected-count')).toHaveText('2 selected');
  await page.locator('#filter-suite').selectOption('__unfiled');
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(1);
  await expect(all).not.toBeChecked();
  await page.locator('#delete-selected-evaluations').click();
  const dialog = page.getByRole('alertdialog', { name: 'Delete selected evaluations?' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#delete-library-items li')).toHaveCount(2);
  await expect(dialog).toContainText('Alpha case'); await expect(dialog).toContainText('Beta case');
  await expect(dialog).toContainText('including any hidden by filters');
  await expect(page.locator('#cancel-delete-library')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#library-selected-count')).toHaveText('2 selected');
  await page.locator('#delete-selected-evaluations').click();
  await page.locator('#cancel-delete-library').click();
  expect(browserApp.store.evaluations(scope)).toHaveLength(3);
  await page.locator('#delete-selected-evaluations').click();
  await page.locator('#confirm-delete-library').click();
  await expect(dialog).toBeHidden(); await expect(page.locator('#eval-count')).toHaveText('1');
  await expect(page.locator('#delete-selected-evaluations')).toBeHidden();
  await expect(page.locator('#library-selected-count')).toBeEmpty();
  expect(browserApp.store.evaluations(scope)).toEqual([records[2]]);
  expect(browserApp.store.suite(suite.id, scope)).toEqual(suite);
  expect(browserApp.store.run(history.id, scope)).toEqual(history);
  await page.reload(); await expect(page.locator('#eval-count')).toHaveText('1');
});

test('failed deletion keeps all definitions and selection, escapes names, and can be retried', async ({ page, browserApp }) => {
  const { records, scope } = await seed(page);
  const active = { id: 'active-run', createdAt: '2026-01-01T00:00:00.000Z', status: 'running', items: [{ evaluationId: records[1].id, evaluation: records[1], status: 'generating' }] };
  browserApp.store.saveRun(active, scope);
  await page.locator('#library-select-all').check();
  await page.locator('#delete-selected-evaluations').click();
  await expect(page.locator('#delete-library-items li')).toHaveCount(3);
  await expect(page.locator('#delete-library-items')).toContainText(records[2].name);
  await expect(page.locator('#delete-library-items img')).toHaveCount(0);
  expect(await page.evaluate(() => window.bulkInjection)).toBeUndefined();
  await page.locator('#confirm-delete-library').click();
  await expect(page.locator('#delete-library-error')).toContainText('active run');
  await expect(page.locator('#delete-library-dialog')).toBeVisible();
  await expect(page.locator('#confirm-delete-library')).toBeEnabled();
  expect(browserApp.store.evaluations(scope)).toHaveLength(3);
  await expect(page.locator('#library-selected-count')).toHaveText('3 selected');
  browserApp.store.saveRun({ ...active, status: 'completed', items: active.items.map(item => ({ ...item, status: 'passed' })) }, scope);
  await page.locator('#confirm-delete-library').click();
  await expect(page.locator('#delete-library-dialog')).toBeHidden();
  await expect(page.locator('#eval-count')).toHaveText('0');
  await expect(page.locator('#library-select-all')).toBeDisabled();
});

test('clear selection and workspace switching reset selection and selected toolbar fits mobile', async ({ page }) => {
  await seed(page);
  await page.setViewportSize({ width: 390, height: 780 });
  await page.locator('#library-select-all').check();
  await expect(page.locator('#delete-selected-evaluations')).toBeVisible();
  expect(await page.locator('#evaluation-rows .eval-select-cell').evaluateAll(cells => cells.every(cell => cell.scrollWidth <= cell.clientWidth))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(2);
  const toolbar = await page.locator('#delete-selected-evaluations').boundingBox();
  expect(toolbar.x).toBeGreaterThanOrEqual(0); expect(toolbar.x + toolbar.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: test.info().outputPath('bulk-selection-mobile.png'), fullPage: true });
  await page.locator('#clear-library-selection').click();
  await expect(page.locator('#evaluation-rows input:checked')).toHaveCount(0);
  await expect(page.locator('#delete-selected-evaluations')).toBeHidden();
  await expect(page.locator('#library-select-all')).toBeFocused();
  await page.locator('#library-select-all').check();
  await page.locator('#workspace-switcher').selectOption('main');
  await expect(page.locator('#workspace-name')).toHaveText('TestCraft workspace');
  await expect(page.locator('#delete-selected-evaluations')).toBeHidden();
  await page.locator('#workspace-switcher').selectOption('personal');
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(3);
  await expect(page.locator('#evaluation-rows input:checked')).toHaveCount(0);
  await page.locator('#library-select-all').check();
  await page.reload(); await expect(page.locator('#evaluation-rows tr')).toHaveCount(3);
  await expect(page.locator('#delete-selected-evaluations')).toBeHidden();
});

test('administrators can select evaluations in the shared workspace', async ({ page }) => {
  await seed(page, 'main');
  await page.getByRole('checkbox', { name: 'Select Alpha case', exact: true }).check();
  await expect(page.locator('#delete-selected-evaluations')).toHaveText('Delete selected (1)');
  await page.locator('#delete-selected-evaluations').click();
  await expect(page.locator('#confirm-delete-library')).toHaveText('Delete 1 evaluation');
  await page.locator('#confirm-delete-library').click();
  await expect(page.locator('#eval-count')).toHaveText('2');
  await expect(page.locator('#toast')).toHaveText('1 evaluation deleted. Previous runs are unchanged.');
  await page.locator('#library-select-all').check();
  await expect(page.locator('#delete-selected-evaluations')).toHaveText('Delete selected (2)');
  await page.locator('#delete-selected-evaluations').click();
  await page.locator('#confirm-delete-library').click();
  await expect(page.locator('#eval-count')).toHaveText('0');
});

test.describe('collaborator selection permissions', () => {
  test.use({ githubId: 1001 });
  test('selection is available privately and hidden in the read-only shared library', async ({ page }) => {
    await seed(page);
    await page.locator('#library-select-all').check();
    await expect(page.locator('#delete-selected-evaluations')).toBeVisible();
    await page.locator('#workspace-switcher').selectOption('main');
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(page.locator('#library-select-all')).toBeHidden();
    await expect(page.locator('#delete-selected-evaluations')).toBeHidden();
    await expect(page.locator('#clear-library-selection')).toBeHidden();
    await expect(page.locator('#evaluation-rows [data-library-select]')).toHaveCount(0);
    await page.locator('#workspace-switcher').selectOption('personal');
    await expect(page.locator('#evaluation-rows tr')).toHaveCount(3);
    await expect(page.locator('#library-select-all')).toBeVisible();
    await expect(page.locator('#evaluation-rows input:checked')).toHaveCount(0);
  });
});
