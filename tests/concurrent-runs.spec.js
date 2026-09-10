import { test, expect, openRunCreator, createSelectedRun } from './browser-fixtures.mjs';

test('Create Run reuses an active evaluation and shows separate running and completed results', async ({ page, browserApp, generationCalls }) => {
  const gate = Promise.withResolvers(), originalFetch = browserApp.engine.fetchImpl;
  browserApp.engine.fetchImpl = async (...args) => { await gate.promise; return originalFetch(...args); };
  try {
    await page.goto('/'); await expect(page.locator('#workspace')).toBeVisible();
    const session = await (await page.request.get('/api/session')).json();
    const response = await page.request.post('/api/evaluations', {
      headers: { origin: new URL(page.url()).origin, 'x-csrf-token': session.csrfToken },
      data: { name: 'Concurrent login', type: 'ideas', html: '<button>Login</button>', method: 'contains', criteria: ['valid credentials'] },
    });
    expect(response.status()).toBe(201);
    const runs = [];
    for (const index of [0, 1]) {
      await openRunCreator(page);
      await page.getByRole('checkbox', { name: 'Select Concurrent login', exact: true }).check();
      if (index) {
        await page.locator('#create-environment').selectOption('prod');
        await page.locator('#create-generation-model').selectOption('gpt-4o');
      }
      await createSelectedRun(page);
      await expect(page.locator('#run-detail-page')).toBeVisible();
      const id = new URL(page.url()).hash.split('/')[1];
      runs.push(id);
      await expect.poll(async () => (await (await page.request.get('/api/runs/' + id)).json()).status).toBe('running');
    }
    expect(runs[0]).not.toBe(runs[1]); expect(browserApp.engine.active).toBe(2);
    await page.getByRole('tab', { name: /^Runs/ }).click();
    for (const id of runs) await expect(page.locator('[data-run-row="' + id + '"]')).toContainText('In progress');
    gate.resolve();
    for (const id of runs) {
      const row = page.locator('[data-run-row="' + id + '"]');
      await expect(row).toContainText('Complete'); await expect(row).toContainText('1.00');
    }
    expect(generationCalls.map(call => call.body.model)).toEqual(['gpt-4o-mini', 'gpt-4o']);
    for (const [index, id] of runs.entries()) {
      await page.locator('[data-run-row="' + id + '"] a').click();
      await expect(page.locator('.run-top')).toContainText(index ? 'Env: Prod' : 'Env: Dev');
      await expect(page.locator('.result-score')).toContainText('1.00');
      await page.getByRole('tab', { name: /^Runs/ }).click();
    }
  } finally { gate.resolve(); }
});
