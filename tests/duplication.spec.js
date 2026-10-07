import { test, expect } from './browser-fixtures.mjs';

test.beforeEach(async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#workspace')).toBeVisible();
  const session = await (await page.request.get('/api/session')).json();
  const headers = { origin: new URL(page.url()).origin, 'x-csrf-token': session.csrfToken };
  const response = await page.request.post('/api/workspaces/personal/evaluations', { headers, data: { name: 'Original', type: 'ideas', html: '<button>Login</button>', method: 'contains', criteria: ['Login'] } });
  expect(response.ok()).toBe(true); await page.reload();
});
async function duplicate(page, source = 'Original') {
  await page.getByRole('button', { name: 'Duplicate ' + source, exact: true }).click();
  await expect(page.locator('#duplicate-name')).toBeFocused();
  await expect(page.locator('#evaluation-dialog')).toBeHidden();
}

test('outside-click and Enter save names without opening the copy, while Escape keeps its default name', async ({ page, generationCalls }) => {
  await duplicate(page); await page.locator('#duplicate-name').fill('Outside saved');
  await page.getByRole('heading', { name: 'Evaluation library', exact: true }).click();
  await expect(page.locator('#duplicate-name')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Outside saved', exact: true })).toBeVisible();
  await duplicate(page); await page.locator('#duplicate-name').fill('Keyboard saved'); await page.locator('#duplicate-name').press('Enter');
  await expect(page.getByRole('button', { name: 'Keyboard saved', exact: true })).toBeFocused();
  await duplicate(page); await page.locator('#duplicate-name').fill('Discard this name'); await page.locator('#duplicate-name').press('Escape');
  await expect(page.getByRole('button', { name: 'Original (copy)', exact: true })).toBeVisible();
  await expect(page.locator('#evaluation-dialog')).toBeHidden();
  const records = (await (await page.request.get('/api/workspaces/personal/evaluations')).json()).evaluations;
  expect(records.map(e => e.name).sort()).toEqual(['Keyboard saved', 'Original', 'Original (copy)', 'Outside saved']);
  expect(generationCalls).toHaveLength(0);
});

test('invalid and failed name saves preserve the copy and typed name for retry', async ({ page }) => {
  await duplicate(page); await page.locator('#duplicate-name').fill('   ');
  await page.getByRole('button', { name: 'Save evaluation name', exact: true }).click();
  await expect(page.locator('#duplicate-name-error')).toContainText('Enter a name');
  await expect(page.locator('#duplicate-name')).toBeFocused();
  await page.route('**/api/workspaces/personal/evaluations/*', route => route.request().method() === 'PATCH' ? route.fulfill({ status: 503, json: { error: 'Temporary rename failure.' } }) : route.continue());
  await page.locator('#duplicate-name').fill('Retry <safe>'); await page.locator('#duplicate-name').press('Enter');
  await expect(page.locator('#duplicate-name-error')).toContainText('Temporary rename failure');
  await expect(page.locator('#duplicate-name')).toHaveValue('Retry <safe>');
  await expect(page.locator('#eval-count')).toHaveText('2');
  await page.unroute('**/api/workspaces/personal/evaluations/*'); await page.locator('#duplicate-name').press('Enter');
  await expect(page.getByRole('button', { name: 'Retry <safe>', exact: true })).toBeVisible();
  await expect(page.locator('#evaluation-rows safe')).toHaveCount(0);
  expect((await (await page.request.get('/api/workspaces/personal/evaluations')).json()).evaluations).toHaveLength(2);
});

test('clicking a table action finishes the inline name before opening or duplicating', async ({ page }) => {
  await duplicate(page);
  await page.getByRole('button', { name: 'Edit Original (copy)', exact: true }).click();
  await expect(page.locator('#name')).toHaveValue('Original (copy)'); await expect(page.locator('#evaluation-dialog')).toBeVisible();
  await page.locator('#cancel-dialog').click();
  await duplicate(page); await page.getByRole('button', { name: 'Duplicate Original', exact: true }).click();
  await expect(page.locator('#eval-count')).toHaveText('4');
  await expect(page.locator('#duplicate-name')).toBeFocused(); await expect(page.locator('#evaluation-dialog')).toBeHidden();
});

test('concurrent name changes produce a conflict and never overwrite the newer record', async ({ page }) => {
  await duplicate(page); await page.locator('#duplicate-name').fill('My draft');
  const session = await (await page.request.get('/api/session')).json(), records = (await (await page.request.get('/api/workspaces/personal/evaluations')).json()).evaluations;
  const copy = records.find(e => e.name === 'Original (copy)');
  const response = await page.request.patch('/api/workspaces/personal/evaluations/' + copy.id, { headers: { origin: new URL(page.url()).origin, 'x-csrf-token': session.csrfToken }, data: { name: 'Other tab name', revision: copy.revision } });
  expect(response.ok()).toBe(true); await page.locator('#duplicate-name').press('Enter');
  await expect(page.locator('#duplicate-name-error')).toContainText('Press Escape');
  await expect(page.locator('#duplicate-name')).toHaveValue('My draft');
  expect((await (await page.request.get('/api/workspaces/personal/evaluations/' + copy.id)).json()).name).toBe('Other tab name');
  await page.locator('#duplicate-name').press('Escape');
  await expect(page.getByRole('button', { name: 'Other tab name', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Other tab name', exact: true }).click();
  await expect(page.locator('#name')).toHaveValue('Other tab name');
});

test('pending duplicate and rename requests cannot create extra copies or save twice', async ({ page }) => {
  let releaseCopy, copyStarted, releaseName, nameStarted, copies = 0, renames = 0;
  const copyGate = new Promise(resolve => { releaseCopy = resolve; }), copyRequest = new Promise(resolve => { copyStarted = resolve; });
  const nameGate = new Promise(resolve => { releaseName = resolve; }), nameRequest = new Promise(resolve => { nameStarted = resolve; });
  await page.route('**/api/workspaces/personal/evaluations/**', async route => {
    if (route.request().url().endsWith('/duplicate')) { copies++; copyStarted(); await copyGate; }
    if (route.request().method() === 'PATCH') { renames++; nameStarted(); await nameGate; }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Duplicate Original', exact: true }).click(); await copyRequest;
  await expect(page.getByRole('button', { name: 'Duplicate Original', exact: true })).toBeDisabled();
  releaseCopy(); await expect(page.locator('#duplicate-name')).toBeFocused();
  await page.locator('#duplicate-name').fill('Once'); await page.getByRole('heading', { name: 'Evaluation library', exact: true }).click(); await nameRequest;
  await expect(page.locator('#duplicate-name')).toBeDisabled(); await expect(page.getByRole('button', { name: 'Save evaluation name', exact: true })).toBeDisabled();
  releaseName(); await expect(page.locator('#duplicate-name')).toHaveCount(0);
  expect(copies).toBe(1); expect(renames).toBe(1); await expect(page.locator('#eval-count')).toHaveText('2');
});

test('a failed duplication adds no row and retry creates one inline copy', async ({ page }) => {
  await page.route('**/api/workspaces/personal/evaluations/*/duplicate', route => route.fulfill({ status: 503, json: { error: 'Temporary copy failure.' } }));
  await page.getByRole('button', { name: 'Duplicate Original', exact: true }).click();
  await expect(page.locator('#app-error')).toHaveText('Temporary copy failure.'); await expect(page.locator('#eval-count')).toHaveText('1');
  await expect(page.locator('#duplicate-name')).toHaveCount(0); await page.unroute('**/api/workspaces/personal/evaluations/*/duplicate');
  await duplicate(page); await expect(page.locator('#eval-count')).toHaveText('2');
});

for (const width of [1280, 390]) test(`inline naming survives filters and sorting at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await duplicate(page); await page.locator('#duplicate-name').fill('Different name');
  // A library refresh must not replace an active draft or lose its selection.
  await page.evaluate(() => document.querySelector('[data-eval-sort="name"]').click());
  await expect(page.locator('#duplicate-name')).toHaveValue('Different name'); await expect(page.locator('#duplicate-name')).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('inline-copy.png') });
  await page.locator('#duplicate-name').press('Enter');
  await page.locator('#search').fill('Original');
  await duplicate(page); await page.locator('#duplicate-name').fill('Filtered out after save');
  await page.locator('#duplicate-name').press('Enter');
  await expect(page.locator('#duplicate-name')).toHaveCount(0);
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(1);
  await page.locator('#search').fill(''); await expect(page.getByRole('button', { name: 'Filtered out after save', exact: true })).toBeVisible();
});
