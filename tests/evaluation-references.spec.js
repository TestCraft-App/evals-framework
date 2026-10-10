import { test, expect, openRunCreator, createSelectedRun } from './browser-fixtures.mjs';

test('short references are searchable and consistent across the library, selector and saved results', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#workspace')).toBeVisible();
  const saved = await page.evaluate(async () => {
    const session = await (await fetch('/api/session')).json(), records = [];
    for (let index = 1; index <= 10; index++) {
      const response = await fetch('/api/workspaces/personal/evaluations', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': session.csrfToken }, body: JSON.stringify({ name: 'Case ' + index, type: 'ideas', method: 'contains', html: '<button>Login</button>', criteria: ['valid credentials'] }) });
      if (!response.ok) throw new Error('Could not seed reference case');
      records.push(await response.json());
    }
    return records;
  });
  await page.reload();
  const references = saved.map(evaluation => evaluation.reference);
  expect(references).toEqual(Array.from({ length: 10 }, (_, index) => 'EVAL-' + (index + 1)));
  await page.locator('[data-eval-sort="reference"]').click();
  await expect(page.locator('#evaluation-rows .evaluation-id')).toHaveText(references);
  await page.locator('[data-eval-sort="reference"]').click();
  await expect(page.locator('#evaluation-rows .evaluation-id')).toHaveText([...references].reverse());
  await page.locator('#search').fill('eval-2');
  await expect(page.locator('#evaluation-rows .evaluation-id')).toHaveText(['EVAL-2']);
  await expect(page.locator('#evaluation-rows .eval-name')).toHaveText('Case 2');
  const libraryId = page.locator('#evaluation-rows .evaluation-id');
  expect((await libraryId.boundingBox()).width).toBeCloseTo(80, 0);
  expect(await libraryId.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(libraryId).toHaveAttribute('title', 'EVAL-2');
  await openRunCreator(page);
  await page.locator('#create-eval-search').fill('eval-2');
  await expect(page.locator('#create-eval-rows .evaluation-id')).toHaveText(['EVAL-2']);
  expect((await page.locator('#create-eval-rows .evaluation-id').boundingBox()).width).toBeCloseTo(80, 0);
  await page.getByRole('checkbox', { name: 'Select Case 2', exact: true }).check();
  await page.locator('#create-eval-search').fill('EVAL-10');
  await page.getByRole('checkbox', { name: 'Select Case 10', exact: true }).check();
  await createSelectedRun(page);
  await expect(page.locator('.detail-eval-row')).toHaveCount(2);
  await page.locator('#detail-sort-reference').click();
  await expect(page.locator('.detail-eval-row .evaluation-id')).toHaveText(['EVAL-2', 'EVAL-10']);
  await page.locator('#detail-sort-reference').click();
  await expect(page.locator('.detail-eval-row .evaluation-id')).toHaveText(['EVAL-10', 'EVAL-2']);
  await page.locator('.detail-expand').first().click();
  await expect(page.locator('.detail-expansion:not([hidden]) > td')).toHaveAttribute('colspan', '8');
  await expect(page.locator('.detail-expansion:not([hidden])')).toContainText('Criteria');
  await page.reload();
  await expect(page.locator('.detail-eval-row .evaluation-id')).toHaveText(['EVAL-2', 'EVAL-10']);
  await page.setViewportSize({ width: 390, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(2);
  // The model summary places results below the fold on small screens.
  await page.locator('.detail-eval-row').first().scrollIntoViewIfNeeded();
  expect(await page.locator('.detail-table-scroll').evaluate(element => element.scrollLeft)).toBe(0);
  await expect(page.locator('.detail-eval-row .evaluation-id').first()).toBeInViewport();
  await page.screenshot({ path: test.info().outputPath('references-mobile.png'), fullPage: true });
});

test('historical results resolve deleted evaluation references and show a dash when identity is absent', async ({ page, browserApp }) => {
  await page.goto('/'); await expect(page.locator('#workspace')).toBeVisible();
  const session = await (await page.request.get('/api/session')).json(), scope = { ownerId: session.workspaceId, workshopId: 'browser-tests' };
  const evaluation = browserApp.store.create({ name: 'Historical case', type: 'ideas', method: 'contains', criteria: ['Login'], html: '<button>Login</button>' }, scope);
  const { reference, ...snapshot } = evaluation;
  browserApp.store.saveRun({ id: 'historical-references', createdAt: '2026-01-01', status: 'completed', items: [
    { id: 'known', evaluationId: evaluation.id, evaluation: snapshot, status: 'passed', score: 100, checks: [], output: 'Saved response' },
    { id: 'unknown', evaluation: { name: 'Missing identity' }, status: 'error', checks: [] },
  ] }, scope);
  browserApp.store.deleteEvaluation(evaluation.id, scope);
  await page.goto('/#personal/runs/historical-references');
  await expect(page.locator('.detail-eval-row .evaluation-id')).toHaveText([reference, '—']);
  await page.locator('#detail-sort-reference').click();
  await page.locator('#detail-sort-reference').click();
  await expect(page.locator('.detail-eval-row .evaluation-id')).toHaveText([reference, '—']);
  await page.locator('#expand-known').click();
  await page.locator('#output-toggle-known').click();
  await expect(page.locator('#criteria-known .saved-output')).toHaveText('Saved response');
  expect(JSON.parse(browserApp.store.db.prepare('SELECT data FROM runs WHERE id=?').get('historical-references').data).items[0].evaluation.reference).toBeUndefined();
});
