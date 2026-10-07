import { test, expect, openRunCreator, createSelectedRun } from './browser-fixtures.mjs';
import { client } from './helpers.mjs';

const definition = { name: 'Official login case', type: 'ideas', method: 'contains', html: '<button>Login</button>', criteria: [{ method: 'contains', text: 'valid credentials', description: 'Look for a successful login.', weight: 1 }] };
test.use({ githubId: 1001, initialWorkspace: 'main' });

async function seedMain(app) {
  const admin = await client(app, { githubId: 1 });
  return (await admin.post('/api/workspaces/main/evaluations', definition)).json();
}

test('collaborators inspect the main library and load examples only into their personal space', async ({ page, browserApp }) => {
  await seedMain(browserApp);
  await page.goto('/');
  await expect(page.locator('#workspace-switcher')).toHaveValue('main');
  await expect(page.locator('#new-button')).toBeHidden();
  await page.getByRole('button', { name: definition.name, exact: true }).click();
  await expect(page.locator('#inspect-evaluation')).toContainText('<button>Login</button>');
  await expect(page.locator('#inspect-evaluation')).toContainText('contains (weight 1): valid credentials');
  await expect(page.locator('#inspect-evaluation')).toContainText('Look for a successful login.');
  await expect(page.locator('#inspect-evaluation input')).toHaveCount(0);
  await page.locator('#close-inspect').click();
  await page.locator('#library-actions-toggle').click();
  await expect(page.locator('#clear-workspace-button')).toBeHidden();
  await page.getByRole('button', { name: 'Load Basic Suite into My workspace' }).click();
  await expect(page.locator('#workspace-switcher')).toHaveValue('personal');
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(12);
  await page.locator('#workspace-switcher').selectOption('main');
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(1);
});

test('main runs and reruns save privately, preserve their source, and never store collaborator keys', async ({ page, browserApp, generationCalls }) => {
  await seedMain(browserApp);
  await page.goto('/');
  await openRunCreator(page);
  await page.getByRole('checkbox', { name: 'Select ' + definition.name, exact: true }).check();
  await expect(page.locator('#run-destination')).toContainText('My workspace (private)');
  await page.locator('#submit-create-run').click();
  await expect(page.locator('#create-run-error')).toContainText('Enter your OpenAI API key');
  expect(generationCalls).toHaveLength(0);
  await page.locator('#run-api-key').fill('synthetic-collaborator-key');
  await createSelectedRun(page);
  await expect(page).toHaveURL(/#personal\/runs\//);
  await expect(page.locator('.result-score')).toContainText('1.00');
  await expect(page.locator('.run-provenance')).toContainText('Source: TestCraft');
  expect(generationCalls[0].body.openAiApiKey).toBe('synthetic-collaborator-key');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('synthetic-collaborator-key');
  const stored = browserApp.store.db.prepare('SELECT data FROM runs').all();
  expect(JSON.stringify(stored)).not.toContain('synthetic-collaborator-key');
  await page.getByRole('tab', { name: /^Runs/ }).click();
  await page.locator('[data-rerun]').click();
  await expect(page.locator('#create-eval-rows')).toContainText(definition.name);
  await expect(page.locator('#run-api-key')).toHaveValue('synthetic-collaborator-key');
  await page.locator('#cancel-create-run').click();
  await page.reload();
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#personal-api-key')).toHaveValue('');
  await page.locator('#workspace-switcher').selectOption('main');
  await page.getByRole('tab', { name: /^Runs/ }).click();
  await expect(page.locator('#run-list tr')).toHaveCount(0);
});

test('tabs retain independent workspaces and switching protects drafts and clears stale content', async ({ page, context, browserApp }) => {
  await seedMain(browserApp);
  await page.goto('/#personal/evaluations');
  const other = await context.newPage();
  await other.goto('/#main/evaluations');
  await expect(other.locator('#evaluation-rows tr')).toHaveCount(1);
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(0);
  await page.locator('#new-button').click();
  await page.locator('#name').fill('Unsaved personal case');
  page.once('dialog', dialog => dialog.dismiss());
  await page.evaluate(() => { location.hash = 'main/evaluations'; });
  await expect(page).toHaveURL(/#personal\/evaluations$/);
  await expect(page.locator('#name')).toHaveValue('Unsaved personal case');
  page.once('dialog', dialog => dialog.accept());
  await page.evaluate(() => { location.hash = 'main/evaluations'; });
  await expect(page.locator('#evaluation-dialog')).toBeHidden();
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(1);
  await other.close();
});

test('logout clears the key and exposes GitHub sign-in without an anonymous fallback', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#workspace')).toBeVisible();
  await page.locator('#key-settings summary').click();
  await page.locator('#personal-api-key').fill('temporary-key');
  await page.locator('#logout').click();
  await expect(page.locator('#github-login')).toBeVisible();
  await expect(page.locator('#workspace')).toBeHidden();
  await expect(page.locator('#personal-api-key')).toHaveValue('');
  expect((await (await page.request.get('/api/session')).json()).authenticated).toBe(false);
});

test('late main-library responses cannot overwrite a personal workspace after switching', async ({ page, browserApp }) => {
  await seedMain(browserApp);
  await page.goto('/');
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(1);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), requested = new Promise(resolve => { started = resolve; });
  await page.route('**/api/workspaces/main/evaluations', async route => {
    const response = await route.fetch(); started(); await gate; await route.fulfill({ response });
  });
  await page.getByRole('tab', { name: /^Runs/ }).click();
  await page.getByRole('tab', { name: /^Evaluations/ }).click();
  await requested;
  await page.locator('#workspace-switcher').selectOption('personal');
  await expect(page.locator('#workspace')).toBeVisible();
  const returned = page.waitForResponse('**/api/workspaces/main/evaluations'); release(); await returned;
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(0);
  await expect(page.locator('#workspace-switcher')).toHaveValue('personal');
});

test.describe('admin', () => {
  test.use({ githubId: 1 });
  test('admins manage TestCraft and their personal space separately', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#new-button')).toBeVisible();
    await page.locator('#library-actions-toggle').click();
    await page.getByRole('button', { name: 'Load Basic Suite', exact: true }).click();
    await expect(page.locator('#evaluation-rows tr')).toHaveCount(12);
    await expect(page.locator('#key-settings')).toBeHidden();
    await page.locator('#workspace-switcher').selectOption('personal');
    await expect(page.locator('#evaluation-rows tr')).toHaveCount(0);
    await expect(page.locator('#new-button')).toBeVisible();
  });
});

test.describe('sign-in', () => {
  test.use({ signedIn: false });
  test('GitHub redirect returns to an account workspace using the real callback and mocked GitHub', async ({ page }) => {
    await page.route('https://github.com/login/oauth/authorize?**', async route => {
      const authorization = new URL(route.request().url());
      const callback = new URL(authorization.searchParams.get('redirect_uri'));
      callback.search = new URLSearchParams({ code: '1001', state: authorization.searchParams.get('state') });
      await route.fulfill({ status: 302, headers: { location: callback.href } });
    });
    await page.goto('/');
    await expect(page.locator('#workspace')).toBeHidden();
    await page.locator('#github-login').click();
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(page.locator('#private-badge')).toContainText('user-1001 · collaborator');
    const cookies = await page.context().cookies();
    expect(cookies.find(c => c.name === 'testcraft_session')).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
    expect(cookies.find(c => c.name === 'testcraft_oauth')).toBeUndefined();
  });
});
