import { test, expect } from '@playwright/test';
let pageErrors;
test.beforeEach(async ({ page }) => { pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message)); });
test.afterEach(() => expect(pageErrors).toEqual([]));

test('create, persist, select and run an evaluation in the results tab', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Backend connected', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Load example' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Evaluation name', { exact: true }).fill('UI login coverage');
  await page.getByRole('button', { name: 'Create evaluation', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'UI login coverage', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'UI login coverage', exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select UI login coverage', exact: true }).check();
  await page.getByRole('button', { name: 'Run selected', exact: false }).click();
  await expect(page.getByRole('tab', { name: /^Runs/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.result-score')).toContainText('100');
  await expect(page.locator('.result-body .badge').first()).toHaveText('Passed');
  await expect(page.locator('.check')).toHaveCount(3);
  const popupPromise = page.waitForEvent('popup');
  await page.getByRole('link', { name: 'Open in new tab' }).click();
  const popup = await popupPromise;
  await expect(popup.locator('.result-score')).toContainText('100');
  await popup.close();
});

test('batch selection grades each case independently and preserves HTML as inert text', async ({ page, request }) => {
  const base = { name: 'Batch good', type: 'code', source: 'pasted', framework: 'playwright', language: 'typescript', method: 'contains', threshold: 100, input: 'Test login', html: '<button onclick="alert(1)">Login</button><script>throw new Error("must not run")</script>', expectedOutput: 'expect\ngetByRole', actualOutput: 'expect(page.getByRole("button")).toBeVisible()', criteria: '', model: '', judgeModel: '', pageUrl: '' };
  expect((await request.post('/api/evaluations', { data: base })).status()).toBe(201);
  expect((await request.post('/api/evaluations', { data: { ...base, name: 'Batch weak', actualOutput: 'expect(true)' } })).status()).toBe(201);
  await page.goto('/');
  await page.getByRole('searchbox').fill('Batch');
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(2);
  await page.getByRole('checkbox', { name: 'Select all visible evaluations' }).check();
  await page.getByRole('button', { name: 'Run selected', exact: false }).click();
  await expect(page.locator('.run-top .badge')).toHaveText('Completed');
  await expect(page.locator('.run-item')).toHaveCount(2);
  await page.getByRole('button', { name: /Batch weak · Failed/ }).click();
  await expect(page.locator('.result-score')).toContainText('50');
  await expect(page.getByText('Missing: getByRole', { exact: true })).toBeVisible();
});

test('model grade has editable criteria and reports missing configuration honestly', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Load example' }).click();
  await page.getByLabel('Evaluation name', { exact: true }).fill('Judge configuration');
  await page.getByRole('dialog').getByRole('combobox', { name: 'Method', exact: true }).selectOption('model_grade');
  await expect(page.getByLabel('Evaluation criteria', { exact: false })).toBeVisible();
  await page.getByLabel('Evaluation criteria', { exact: false }).fill('The output includes a negative login test.');
  await page.getByRole('dialog').getByRole('combobox', { name: 'Framework', exact: true }).selectOption('cypress');
  await expect(page.locator('#language option[value=python]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Create evaluation', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select Judge configuration', exact: true }).check();
  await page.getByRole('button', { name: 'Run selected', exact: false }).click();
  await expect(page.locator('.result-body .error-banner')).toContainText('OPENAI_API_KEY');
  await expect(page.locator('.result-score')).toHaveText('—');
  await expect(page.locator('.result-body .badge').first()).toHaveText('Error');
});
