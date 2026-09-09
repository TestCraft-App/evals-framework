import { test, expect } from './browser-fixtures.mjs';

async function seed(page, app) {
  await page.goto('/');
  await expect(page.locator('#workspace')).toBeVisible();
  const session = await (await page.request.get('/api/session')).json();
  const scope = { ownerId: session.workspaceId, workshopId: 'browser-tests' };
  const evaluation = { id: 'eval-one', name: 'Saved criteria', type: 'ideas', source: 'testcraft_api', method: 'contains', criteria: ['login'], input: 'Synthetic login', html: '<button>Login</button>' };
  const item = (score, model, status = 'passed') => ({ id: 'item-' + model, evaluationId: evaluation.id, evaluation: { ...evaluation, model }, status, score, output: 'login', checks: [], events: [] });
  const runs = [
    { id: 'run-alpha', createdAt: '2026-09-06T12:00:00Z', status: 'completed', items: [item(100, 'alpha'), item(null, 'beta', 'error')] },
    { id: 'run-beta', createdAt: '2026-09-07T12:00:00Z', status: 'completed', items: [item(0, 'beta', 'failed')] },
    { id: 'run-active', createdAt: '2026-09-08T12:00:00Z', status: 'running', items: [item(null, 'alpha', 'generating')] },
    { id: 'run-interrupted', createdAt: '2026-09-05T12:00:00Z', status: 'interrupted', items: [item(null, '<script>unsafe</script>', 'error')] },
  ];
  for (const run of runs) app.store.saveRun(run, scope);
  await page.getByRole('tab', { name: /^Runs/ }).click();
  await expect(page.locator('#run-list tr')).toHaveCount(4);
  return { runs, scope };
}

test('run table metadata, combined filters, name/ID search and all header sorts', async ({ page, browserApp }) => {
  await seed(page, browserApp);
  await expect(page.locator('.runs-table th')).toHaveText(['Run name', 'Date', 'Models', 'Evals', 'Status', 'Score', 'Delete']);
  await expect(page.locator('#create-run')).toBeEnabled();
  await expect(page.locator('#refresh-runs, .run-history')).toHaveCount(0);
  await expect(page.locator('#run-detail-page')).toBeHidden();
  const alpha = page.locator('[data-run-row="run-alpha"]');
  await expect(alpha).toContainText('Run · 2026-09-06');
  await expect(alpha).toContainText('100 / 100'); await expect(alpha).toContainText('1 of 2 scored');
  await expect(alpha).toContainText('Complete'); await expect(alpha).toContainText('1 error');
  await expect(page.locator('[data-run-row="run-beta"]')).not.toContainText('error');
  await expect(page.locator('[data-run-row="run-active"] button')).toBeDisabled();
  await expect(page.locator('[data-run-row="run-interrupted"]')).toContainText('<script>unsafe</script>');
  await expect(page.locator('#run-list script')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('runs-desktop.png'), fullPage: true });
  await page.locator('#run-model').selectOption('beta');
  await page.locator('#run-status').selectOption('completed');
  await expect(page.locator('#filtered-runs-count')).toHaveText('2 of 4 runs');
  await page.locator('#run-search').fill('RUN-ALPHA'); await expect(page.locator('#run-list tr')).toHaveCount(1);
  await page.locator('#run-search').fill('2026-09-07'); await expect(page.locator('#run-list tr')).toHaveCount(1);
  await expect(page.locator('#run-list')).toContainText('0 / 100');
  await page.locator('#run-search').fill('absent'); await expect(page.locator('#empty-runs')).toContainText('No runs match');
  await page.locator('#run-search').clear(); await page.locator('#run-model').selectOption(''); await page.locator('#run-status').selectOption('');
  const ids = () => page.locator('#run-list tr').evaluateAll(rows => rows.map(row => row.dataset.runRow));
  for (const [key, first, last] of [['name', 'run-interrupted', 'run-active'], ['createdAt', 'run-active', 'run-interrupted'], ['models', 'run-interrupted', 'run-beta'], ['total', 'run-alpha', 'run-interrupted'], ['status', 'run-alpha', 'run-interrupted']]) {
    const header = page.locator('[data-run-sort="' + key + '"]');
    await header.click(); expect((await ids())[0]).toBe(first);
    await expect(header.locator('..')).toHaveAttribute('aria-sort', ['createdAt', 'total'].includes(key) ? 'descending' : 'ascending');
    await header.click();
    // Ties always use run ID ascending, independent of direction.
    if (key !== 'total') expect((await ids())[0]).toBe(last);
  }
  await page.locator('[data-run-sort="score"]').click(); expect(await ids()).toEqual(['run-alpha', 'run-beta', 'run-active', 'run-interrupted']);
  await page.locator('[data-run-sort="score"]').click(); expect(await ids()).toEqual(['run-beta', 'run-alpha', 'run-active', 'run-interrupted']);
});

test('row and keyboard navigation preserve filters, direct detail links and browser history', async ({ page, browserApp }) => {
  await seed(page, browserApp);
  await page.locator('#run-search').fill('run-alpha');
  await page.locator('[data-run-row="run-alpha"] td').nth(1).click();
  await expect(page).toHaveURL(/#runs\/run-alpha$/);
  await expect(page.locator('#runs-list-page')).toBeHidden(); await expect(page.locator('.result-score')).toContainText('100');
  await page.getByRole('link', { name: 'Back to runs' }).click();
  await expect(page.locator('#runs-list-page')).toBeVisible();
  await expect(page.locator('#run-search')).toHaveValue('run-alpha');
  await page.locator('[data-run-row="run-alpha"] a').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#run-detail-page')).toBeVisible();
  await page.reload(); await expect(page.locator('.result-score')).toContainText('100');
  await page.getByRole('tab', { name: /^Runs/ }).click(); await expect(page).toHaveURL(/#runs$/);
  await page.goBack(); await expect(page.locator('#run-detail-page')).toBeVisible();
  await page.goForward(); await expect(page.locator('#runs-list-page')).toBeVisible();
});

test('table deletion stays on list, supports cancellation and failure, then removes the row', async ({ page, browserApp }) => {
  await seed(page, browserApp);
  const button = page.locator('[data-run-row="run-alpha"] button');
  await button.click(); await expect(page).toHaveURL(/#runs$/);
  await page.locator('#cancel-delete-run').click(); await expect(button).toBeFocused();
  await page.route('**/api/runs/run-alpha', route => route.request().method() === 'DELETE' ? route.fulfill({ status: 503, json: { error: 'Temporary failure' } }) : route.continue());
  await button.click(); await page.locator('#confirm-delete-run').click();
  await expect(page.locator('#delete-run-error')).toHaveText('Temporary failure'); await expect(button).toHaveCount(1);
  await page.unroute('**/api/runs/run-alpha'); await page.locator('#confirm-delete-run').click();
  await expect(page.locator('#delete-run-dialog')).toBeHidden(); await expect(button).toHaveCount(0);
  await expect(page).toHaveURL(/#runs$/); await expect(page.locator('#filtered-runs-count')).toHaveText('3 of 3 runs');
});

test('visible active runs update automatically and stop polling after completion', async ({ page, browserApp }) => {
  const { runs, scope } = await seed(page, browserApp);
  const active = runs.find(run => run.id === 'run-active');
  active.status = 'completed'; active.items[0].status = 'passed'; active.items[0].score = 75;
  browserApp.store.saveRun(active, scope);
  await expect(page.locator('[data-run-row="run-active"]')).toContainText('75 / 100');
  await expect(page.locator('[data-run-row="run-active"] button')).toBeEnabled();
  await page.clock.install();
  let reads = 0; page.on('request', request => { if (request.url().endsWith('/api/runs')) reads++; });
  await page.clock.fastForward(5000); expect(reads).toBe(0);
});

test('successful detail deletion returns to the table even if the following read fails', async ({ page, browserApp }) => {
  await seed(page, browserApp);
  await page.locator('[data-run-row="run-alpha"] a').click();
  await expect(page.locator('.result-score')).toContainText('100');
  await page.route('**/api/runs', route => route.fulfill({ status: 503, json: { error: 'Temporary read failure' } }));
  await page.locator('#run-detail [data-delete-run]').click(); await page.locator('#confirm-delete-run').click();
  await expect(page.locator('#app-error')).toContainText('The run was removed');
  await expect(page.locator('#runs-list-page')).toBeVisible(); await expect(page.locator('#run-detail-page')).toBeHidden();
  await expect(page.locator('[data-run-row="run-alpha"]')).toHaveCount(0);
});

test('empty history and narrow table remain usable without page overflow', async ({ page, browserApp }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/#runs'); await expect(page.locator('#empty-runs')).toContainText('Your runs will appear here');
  await expect(page.locator('#filtered-runs-count')).toHaveText('0 of 0 runs');
  await seed(page, browserApp);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(2);
  const scroll = page.locator('#runs-list-page .table-scroll');
  expect(await scroll.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('runs-mobile.png'), fullPage: true });
});

test('an older table response cannot restore a deleted run', async ({ page, browserApp }) => {
  await seed(page, browserApp);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { started = resolve; });
  let held = false;
  await page.route('**/api/runs', async route => {
    if (held) return route.continue();
    held = true;
    const response = await route.fetch();
    started(); await gate;
    await route.fulfill({ response });
  });
  try {
    await pending;
    await page.locator('[data-run-row="run-alpha"] button').click();
    await page.locator('#confirm-delete-run').click();
    await expect(page.locator('[data-run-row="run-alpha"]')).toHaveCount(0);
    const returned = page.waitForResponse(response => response.url().endsWith('/api/runs'));
    release(); await returned;
    await expect(page.locator('#filtered-runs-count')).toHaveText('3 of 3 runs');
    await expect(page.locator('[data-run-row="run-alpha"]')).toHaveCount(0);
  } finally { release(); }
});

test('late detail responses do not reopen detail after returning to the table', async ({ page, browserApp }) => {
  await seed(page, browserApp);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { started = resolve; });
  await page.route('**/api/runs/run-alpha', async route => {
    const response = await route.fetch(); started(); await gate; await route.fulfill({ response });
  });
  try {
    await page.locator('[data-run-row="run-alpha"] a').click(); await pending;
    await page.getByRole('link', { name: 'Back to runs' }).click();
    await expect(page.locator('#runs-list-page')).toBeVisible();
    const returned = page.waitForResponse(response => response.url().endsWith('/api/runs/run-alpha'));
    release(); await returned;
    await expect(page.locator('#run-detail-page')).toBeHidden();
    await expect(page.locator('#run-list tr')).toHaveCount(4);
  } finally { release(); }
});
