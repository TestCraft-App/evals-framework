import { test, expect, selectGenerationModels } from './browser-fixtures.mjs';
import { client } from './helpers.mjs';

test.use({ githubId: 1001, initialWorkspace: 'personal' });
const base = '/api/evaluation-requests';
const definition = { name: 'Login contribution', type: 'ideas', method: 'contains', html: '<button>Login</button>', criteria: [{ method: 'contains', text: 'valid credentials', weight: 1 }] };
async function seed(app, name = definition.name) {
  const person = await client(app, { githubId: 1001 });
  const evaluation = await (await person.post('/api/evaluations', { ...definition, name })).json();
  return { person, evaluation };
}
async function adminPage(browser, baseURL) {
  const context = await browser.newContext();
  const start = await context.request.post(baseURL + '/api/auth/github/start', { data: {}, headers: { origin: baseURL } });
  const authorization = new URL((await start.json()).authorizeUrl);
  await context.request.get(baseURL + '/api/auth/github/callback?' + new URLSearchParams({ state: authorization.searchParams.get('state'), code: '1' }));
  const page = await context.newPage(); await page.goto(baseURL + '/#requests');
  return { page, context };
}
async function submit(person, ids) { return (await person.post(base, { evaluationIds: ids, description: 'Please include these evaluations.' })).json(); }
async function openRequests(page) { await page.locator('#user-menu-toggle').click(); await page.locator('#open-requests').click(); }

test('single and bulk requests preserve filtered selections, render safely, and appear in the admin queue', async ({ page, browser, browserApp, baseURL, generationCalls }) => {
  const { person, evaluation } = await seed(browserApp);
  const second = await seed(browserApp, 'Hidden second evaluation');
  await page.goto('/');
  const rowAction = page.getByRole('button', { name: 'Request inclusion for Login contribution', exact: true });
  await rowAction.click(); await expect(page.locator('#request-submit-list')).toContainText('Login contribution');
  await page.locator('#cancel-request').click(); await expect(rowAction).toBeFocused();
  expect((await person.get(base)).requests).toHaveLength(0);
  await page.locator('#library-select-all').check();
  await page.locator('#search').fill('Login');
  await page.getByRole('button', { name: 'Request inclusion (2)', exact: true }).click();
  await expect(page.locator('#request-submit-list')).toContainText(second.evaluation.name);
  await page.locator('#send-request').click(); await expect(page.locator('#request-dialog')).toBeVisible();
  const description = '<img src=x onerror="window.requestInjection=true"> Useful coverage';
  await page.locator('#request-submit-description').fill(description);
  await page.locator('#send-request').click();
  await expect(page.locator('#request-title')).toHaveText('Request from user-1001');
  await expect(page.getByRole('table', { name: 'Requested evaluations' }).locator('tbody tr')).toHaveCount(2);
  expect(await page.evaluate(() => window.requestInjection)).toBeUndefined();
  expect(generationCalls).toHaveLength(0);
  const request = (await person.get(base)).requests[0];
  expect(request.evaluationCount).toBe(2);
  const admin = await adminPage(browser, baseURL);
  try {
    await expect(admin.page.locator('#request-user-badge')).toHaveText('1');
    await expect(admin.page.getByRole('table', { name: 'Evaluation requests', exact: true })).toContainText(description);
    await admin.page.getByRole('link', { name: description, exact: true }).click();
    await admin.page.getByRole('button', { name: evaluation.name, exact: true }).click();
    await expect(admin.page.locator('#inspect-content')).toContainText('user-1001 · Submission 1');
    await expect(admin.page.locator('#inspect-content')).toContainText('<button>Login</button>');
    await admin.page.locator('#close-inspect').click();
    await admin.page.getByRole('button', { name: 'Approve all', exact: true }).click();
    await admin.page.locator('#cancel-request-decision').click();
    expect((await person.get(base + '/' + request.id)).status).toBe('pending');
    await admin.page.getByRole('link', { name: 'Back to requests' }).click();
    await admin.page.getByRole('button', { name: 'Request changes', exact: true }).click();
    await admin.page.locator('#confirm-request-decision').click(); await expect(admin.page.locator('#request-decision-dialog')).toBeVisible();
    await admin.page.locator('#request-comment').fill('Add more negative cases.'); await admin.page.locator('#confirm-request-decision').click();
    await expect(admin.page.getByRole('table', { name: 'Evaluation requests', exact: true })).toContainText('Changes requested');
    await expect(admin.page.locator('#request-user-badge')).toBeHidden();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.locator('#request-user-badge')).toHaveText('1');
    await page.reload();
    await page.getByRole('button', { name: 'Review history', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Review history', exact: true })).toContainText('Add more negative cases.');
    await page.getByRole('button', { name: 'Close review history' }).click();
    await expect(page.locator('#request-user-badge')).toBeHidden();
    await expect(page.locator('#create-review-run')).toHaveCount(0);
  } finally { await admin.context.close(); }
});

test('collaborators revise the set and description; approval publishes grouped copies and keeps earlier submissions', async ({ page, browser, browserApp, baseURL }) => {
  const { person, evaluation } = await seed(browserApp), adminApi = await client(browserApp, { githubId: 1 });
  const suite = await (await person.post('/api/suites', { name: 'Contributor group' })).json();
  const revised = await (await person.post('/api/evaluations', { ...definition, name: 'Revised case', suiteId: suite.id })).json();
  const request = await submit(person, [evaluation.id]);
  await adminApi.post(base + '/' + request.id + '/review', { version: 1, action: 'request_changes', comment: 'Replace this case.' });
  await person.request('/api/evaluations/' + evaluation.id, { method: 'DELETE' });
  await page.goto('/#requests/' + request.id);
  await page.getByRole('button', { name: 'Revise and resubmit' }).click();
  await expect(page.locator('#request-submit-list')).not.toContainText(evaluation.name);
  await page.locator('[data-submit-eval="' + revised.id + '"]').check();
  await page.locator('#request-submit-description').fill('Updated coverage');
  await page.locator('#send-request').click();
  await expect(page.locator('#request-submission')).toHaveValue('2');
  await page.locator('#request-submission').selectOption('1');
  await expect(page.locator('#request-evaluation-rows')).toContainText(evaluation.name);
  await page.locator('#request-submission').selectOption('2');
  await expect(page.locator('#request-evaluation-rows')).toContainText(revised.name);
  const admin = await adminPage(browser, baseURL);
  try {
    await admin.page.getByRole('link', { name: 'Updated coverage', exact: true }).click();
    await admin.page.locator('#request-submission').selectOption('1');
    await expect(admin.page.getByRole('button', { name: 'Approve all', exact: true })).toHaveCount(0);
    await expect(admin.page.locator('#requests-panel')).toContainText('Viewing an earlier submission');
    await admin.page.locator('#request-submission').selectOption('2');
    await admin.page.getByRole('link', { name: 'Back to requests' }).click();
    await admin.page.getByRole('button', { name: 'Approve all', exact: true }).click();
    await admin.page.locator('#confirm-request-decision').click();
    await expect(admin.page.getByRole('table', { name: 'Evaluation requests', exact: true })).toContainText('Approved');
    const published = (await adminApi.get('/api/workspaces/main/evaluations')).evaluations;
    expect(published).toHaveLength(1); expect(published[0].name).toBe(revised.name); expect(published[0].id).not.toBe(revised.id);
    expect((await adminApi.get('/api/workspaces/main/suites')).suites[0].name).toBe('Contributor group');
    await page.reload(); await expect(page.locator('#requests-panel')).toContainText('Added to TestCraft:');
    await expect(page.locator('#resubmit-request')).toHaveCount(0);
    await openRequests(page); await expect(page.locator('#requests-title')).toHaveText('My requests');
    await page.locator('#request-status').selectOption('rejected'); await expect(page.locator('#requests-panel')).toContainText('No requests to show.');
  } finally { await admin.context.close(); }
});

test('admins run submitted snapshots with reusable run UI and private evidence, rerun, and delete', async ({ browser, browserApp, baseURL, generationCalls }) => {
  const { person, evaluation } = await seed(browserApp), request = await submit(person, [evaluation.id]);
  await person.request('/api/evaluations/' + evaluation.id, { method: 'DELETE' });
  const admin = await adminPage(browser, baseURL);
  try {
    await admin.page.goto(baseURL + '/#requests/' + request.id);
    await admin.page.locator('#create-review-run').click();
    await expect(admin.page.locator('#run-destination')).toContainText('Results visible only to admins');
    await selectGenerationModels(admin.page, ['gpt-4o-mini']);
    await admin.page.locator('#submit-create-run').click();
    await expect(admin.page.locator('#review-run-provenance')).toContainText('Submission 1 · Admins only');
    await expect(admin.page.locator('#review-run-detail')).toContainText('Complete');
    expect(generationCalls).toHaveLength(1);
    await admin.page.getByRole('link', { name: '← Back to request', exact: true }).click();
    await expect(admin.page.getByRole('table', { name: 'Review runs', exact: true }).locator('tbody tr')).toHaveCount(1);
    await admin.page.getByRole('button', { name: 'Rerun', exact: true }).click();
    await admin.page.locator('#submit-create-run').click();
    await expect(admin.page.locator('#review-run-detail')).toContainText('Complete');
    expect(generationCalls).toHaveLength(2);
    await admin.page.getByRole('button', { name: 'Delete run', exact: true }).click();
    await admin.page.locator('#confirm-request-decision').click();
    await expect(admin.page.getByRole('table', { name: 'Review runs', exact: true }).locator('tbody tr')).toHaveCount(1);
    expect((await person.get('/api/workspaces/main/runs')).runs).toHaveLength(0);
  } finally { await admin.context.close(); }
});

test('stale decisions remain explicit and request drafts protect navigation', async ({ page, browser, browserApp, baseURL }) => {
  const { person, evaluation } = await seed(browserApp), request = await submit(person, [evaluation.id]);
  await page.goto('/');
  await page.getByRole('button', { name: 'Request inclusion for Login contribution' }).click();
  await page.locator('#request-submit-description').fill('Unsaved description');
  page.once('dialog', dialog => dialog.dismiss());
  await page.evaluate(() => { location.hash = 'requests'; });
  await expect(page).toHaveURL(/#personal\/evaluations$/);
  await expect(page.locator('#request-dialog')).toBeVisible();
  await page.locator('#cancel-request').click();
  const admin = await adminPage(browser, baseURL), adminApi = await client(browserApp, { githubId: 1 });
  try {
    await admin.page.getByRole('button', { name: 'Reject', exact: true }).click();
    await admin.page.locator('#request-comment').fill('A stale decision');
    await adminApi.post(base + '/' + request.id + '/review', { version: 1, action: 'request_changes', comment: 'Newer feedback' });
    await admin.page.locator('#confirm-request-decision').click();
    await expect(admin.page.locator('#request-decision-error')).toContainText('This request has changed');
    await expect(admin.page.locator('#request-comment')).toHaveValue('A stale decision');
    await admin.page.locator('#cancel-request-decision').click();
    await admin.page.reload();
    await expect(admin.page.getByRole('table', { name: 'Evaluation requests', exact: true })).toContainText('Changes requested');
  } finally { await admin.context.close(); }
});

test('mobile request controls and keyboard dialogs fit, filter snapshots, and reject with feedback', async ({ page, browser, browserApp, baseURL }) => {
  const { person, evaluation } = await seed(browserApp);
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.locator('#library-select-all').check();
  const submit = page.getByRole('button', { name: 'Request inclusion (1)', exact: true });
  await submit.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#request-submit-description')).toBeFocused();
  const box = await page.locator('#request-dialog').boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.locator('#request-submit-description').fill('Mobile submission'); await page.locator('#send-request').click();
  await expect(page.locator('#request-title')).toBeVisible();
  await page.locator('#request-search').fill('unmatched'); await expect(page.locator('#request-evaluation-rows tr')).toHaveCount(0);
  await page.locator('#request-search').fill('EVAL-1'); await expect(page.locator('#request-evaluation-rows tr')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const admin = await adminPage(browser, baseURL);
  try {
    await admin.page.setViewportSize({ width: 390, height: 844 });
    await admin.page.getByRole('button', { name: 'Reject', exact: true }).click();
    await expect(admin.page.locator('#request-comment')).toBeFocused();
    await admin.page.keyboard.press('Escape'); await expect(admin.page.getByRole('button', { name: 'Reject', exact: true })).toBeFocused();
    await admin.page.getByRole('button', { name: 'Reject', exact: true }).click();
    await admin.page.locator('#request-comment').fill('Needs a different scope.'); await admin.page.locator('#confirm-request-decision').click();
    await expect(admin.page.getByRole('table', { name: 'Evaluation requests', exact: true })).toContainText('Rejected');
    const requests = (await person.get(base)).requests; expect(requests[0].status).toBe('rejected');
    await page.reload(); await page.getByRole('button', { name: 'Review history', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Review history', exact: true })).toContainText('Needs a different scope.');
    await page.getByRole('button', { name: 'Close review history' }).click();
    await expect(page.locator('#resubmit-request')).toHaveCount(0);
    expect((await person.get('/api/evaluations')).evaluations[0].id).toBe(evaluation.id);
  } finally { await admin.context.close(); }
});

for (const width of [1280, 390]) test(`review history opens beside submission and preserves complete safe history at ${width}px`, async ({ page, browserApp }) => {
  const { person, evaluation } = await seed(browserApp), admin = await client(browserApp, { githubId: 1 });
  const request = await submit(person, [evaluation.id]);
  const comment = '<img src=x onerror="window.historyInjection=true"> Please revise.';
  await admin.post(base + '/' + request.id + '/review', { version: 1, action: 'request_changes', comment });
  await person.post(base + '/' + request.id + '/resubmit', { version: 2, evaluationIds: [evaluation.id], description: 'Updated submission' });
  await page.setViewportSize({ width, height: 844 }); await page.goto('/#requests/' + request.id);
  const opener = page.getByRole('button', { name: 'Review history', exact: true });
  await expect(page.locator('#request-title')).toHaveText('Request from user-1001');
  await expect(page.locator('#requests-panel > .muted, #requests-panel .table-card > .request-description, #requests-panel .request-history')).toHaveCount(0);
  await expect(page.locator('#submission-description')).toHaveText('Updated submission');
  await expect(page.locator('.request-submission-controls')).toContainText('Review history');
  await expect(page.locator('.request-submission-controls > label')).toHaveCount(0);
  await expect(page.locator('.request-submission-controls #request-submission')).toHaveValue('2');
  await expect(page.getByRole('combobox', { name: 'Submission', exact: true })).toHaveValue('2');
  await page.screenshot({ path: test.info().outputPath('request-detail.png'), fullPage: true });
  const dialog = page.getByRole('dialog', { name: 'Review history', exact: true });
  await expect(dialog).toBeHidden(); await opener.focus(); await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible(); await expect(page.getByRole('button', { name: 'Close review history' })).toBeFocused();
  await expect(dialog.locator('li')).toHaveCount(3);
  await expect(dialog).toContainText('Submitted · user-1001');
  await expect(dialog).toContainText('Changes requested · user-1');
  await expect(dialog).toContainText('Resubmitted · user-1001');
  await expect(dialog).toContainText('Submission 1'); await expect(dialog).toContainText('Submission 2');
  await expect(dialog).toContainText(comment); expect(await page.evaluate(() => window.historyInjection)).toBeUndefined();
  await expect(dialog.locator('img')).toHaveCount(0);
  const box = await dialog.boundingBox(); expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width);
  await page.screenshot({ path: test.info().outputPath('review-history-modal.png'), fullPage: true });
  await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); await expect(opener).toBeFocused();
  await page.locator('#request-submission').selectOption('1'); await opener.click();
  await expect(dialog.locator('li')).toHaveCount(3);
  await page.getByRole('button', { name: 'Close review history' }).click(); await expect(opener).toBeFocused();
  await opener.click(); await page.evaluate(() => { location.hash = 'requests'; });
  await expect(page.locator('#requests-title')).toBeVisible(); await expect(dialog).toBeHidden();
});
