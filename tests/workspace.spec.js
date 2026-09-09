import { test, expect } from './browser-fixtures.mjs';

async function review(page) {
  await page.locator('#library-actions-toggle').click();
  await page.locator('#clear-workspace-button').click();
  await expect(page.locator('#clear-workspace-dialog')).toBeVisible();
}
for (const width of [1280, 390]) test(`clear workspace reviews all contents and supports cancel and reload at ${width}px`, async ({ page, browserApp, generationCalls }) => {
  await page.setViewportSize({ width, height: 850 });
  await page.goto('/');
  await expect(page.locator('#workspace')).toBeVisible();
  const info = await (await page.request.get('/api/session')).json();
  const scope = { ownerId: info.workspaceId, workshopId: 'browser-tests' };
  browserApp.store.createSuite({ name: '<img src=x onerror=alert(1)> Empty suite' }, scope);
  browserApp.store.create({ name: 'Unfiled', type: 'ideas', source: 'pasted', method: 'contains', criteria: ['valid'], actualOutput: 'valid' }, scope);
  browserApp.store.saveRun({ id: 'history', status: 'completed', createdAt: new Date().toISOString(), items: [] }, scope);
  await page.reload();
  await review(page);
  await expect(page.locator('#clear-workspace-summary')).toContainText('1 suites, 1 evaluations (1 unfiled), and 1 runs');
  await expect(page.locator('#clear-workspace-suites')).toContainText('<img src=x onerror=alert(1)> Empty suite');
  await expect(page.locator('#clear-workspace-suites img')).toHaveCount(0);
  await expect(page.locator('#cancel-clear-workspace')).toBeFocused();
  await page.locator('#cancel-clear-workspace').click();
  expect(browserApp.store.evaluations(scope)).toHaveLength(1);
  await review(page);
  browserApp.store.createSuite({ name: 'Another tab' }, scope);
  await page.locator('#confirm-clear-workspace').click();
  await expect(page.locator('#clear-workspace-error')).toContainText('workspace changed');
  await page.locator('#cancel-clear-workspace').click();
  await review(page);
  await page.locator('#confirm-clear-workspace').click();
  await expect(page.locator('#clear-workspace-dialog')).toBeHidden();
  await expect(page.locator('#eval-count')).toHaveText('0');
  expect(browserApp.store.runs(scope)).toHaveLength(0);
  expect(browserApp.store.suites(scope)).toHaveLength(0);
  await review(page);
  await expect(page.locator('#confirm-clear-workspace')).toBeDisabled();
  await page.locator('#cancel-clear-workspace').click();
  await page.locator('#library-actions-toggle').click();
  await page.locator('#workshop-button').click();
  await expect(page.locator('#eval-count')).toHaveText('156');
  expect(generationCalls).toHaveLength(0);
});

test('active runs prevent workspace reset', async ({ page, browserApp }) => {
  await page.goto('/'); await expect(page.locator('#workspace')).toBeVisible();
  const info = await (await page.request.get('/api/session')).json();
  browserApp.store.saveRun({ id: 'queued', status: 'queued', createdAt: new Date().toISOString(), items: [] }, { ownerId: info.workspaceId, workshopId: 'browser-tests' });
  await review(page);
  await expect(page.locator('#clear-workspace-error')).toContainText('Wait for active runs');
  await expect(page.locator('#confirm-clear-workspace')).toBeDisabled();
});
