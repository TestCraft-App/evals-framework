import { test, expect, openRunCreator, createSelectedRun } from './browser-fixtures.mjs';
import { client } from './helpers.mjs';

const definition = { name: 'Official login case', type: 'ideas', method: 'contains', html: '<button>Login</button>', criteria: [{ method: 'contains', text: 'valid credentials', description: 'Look for a successful login.', weight: 1 }] };
test.use({ githubId: 1001, initialWorkspace: 'main' });

async function seedMain(app) {
  const admin = await client(app, { githubId: 1 });
  return (await admin.post('/api/workspaces/main/evaluations', definition)).json();
}

async function openKeySettings(page) {
  await page.getByRole('button', { name: 'User menu', exact: true }).click();
  await page.getByRole('button', { name: 'API key', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'OpenAI API key', exact: true })).toBeVisible();
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
  await expect(page.locator('#submit-create-run')).toBeDisabled();
  await expect(page.locator('#run-api-key, #run-key-field')).toHaveCount(0);
  await expect(page.locator('#run-key-warning')).toContainText('Set and validate your API key');
  expect(generationCalls).toHaveLength(0);
  await page.locator('#set-run-api-key').click();
  await page.locator('#personal-api-key').fill('invalid-key');
  await page.locator('#save-api-key').click();
  await expect(page.locator('#api-key-error')).toContainText('API key was rejected');
  await expect(page.locator('#api-key-dialog')).toBeVisible();
  await expect(page.locator('#personal-api-key')).toHaveValue('invalid-key');
  await expect(page.locator('#user-menu')).toBeVisible();
  await expect(page.locator('#submit-create-run')).toBeDisabled();
  await page.locator('#personal-api-key').fill('synthetic-collaborator-key');
  await page.locator('#save-api-key').click();
  await expect(page.locator('#api-key-dialog')).toBeHidden();
  await expect(page.locator('#run-key-warning')).toBeHidden();
  await expect(page.getByRole('checkbox', { name: 'Select ' + definition.name, exact: true })).toBeChecked();
  await expect(page.locator('#submit-create-run')).toBeEnabled();
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
  await expect(page.locator('#run-key-warning')).toBeHidden();
  await expect(page.locator('#submit-create-run')).toBeEnabled();
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
  await openKeySettings(page);
  await page.locator('#personal-api-key').fill('temporary-key');
  await page.getByRole('button', { name: 'Save key', exact: true }).click();
  await page.locator('#user-menu-toggle').click();
  await page.locator('#logout').click();
  await expect(page.locator('#github-login')).toBeVisible();
  await expect(page.locator('#workspace')).toBeHidden();
  await expect(page.locator('#personal-api-key')).toHaveValue('');
  await expect(page.locator('#run-api-key')).toHaveCount(0);
  await expect(page.locator('#user-menu')).toBeHidden();
  await expect(page.locator('#user-menu-panel')).toBeHidden();
  await expect(page.locator('#private-badge')).toBeEmpty();
  expect((await (await page.request.get('/api/session')).json()).authenticated).toBe(false);
});

test('a key saved from the user menu is used by runs and stays out of storage', async ({ page, context, browserApp, generationCalls }) => {
  await seedMain(browserApp);
  await page.goto('/');
  await openKeySettings(page);
  await expect(page.locator('#personal-api-key')).toBeFocused();
  await expect(page.locator('#personal-api-key')).toHaveAttribute('type', 'password');
  await expect(page.locator('#clear-api-key')).toBeDisabled();
  await page.locator('#personal-api-key').fill('  synthetic-menu-key  ');
  await page.getByRole('button', { name: 'Save key', exact: true }).click();
  await expect(page.locator('#api-key-dialog')).toBeHidden();
  await expect(page.locator('#personal-api-key')).toHaveValue('');
  await expect(page.locator('#user-menu-toggle')).toBeFocused();
  expect(generationCalls).toHaveLength(0);
  const other = await context.newPage();
  await other.goto('/'); await openKeySettings(other);
  await expect(other.locator('#personal-api-key')).toHaveValue('');
  await other.close();
  await page.locator('#workspace-switcher').selectOption('personal');
  await expect(page.locator('#workspace')).toBeVisible();
  await openKeySettings(page);
  await expect(page.locator('#personal-api-key')).toHaveValue('synthetic-menu-key');
  await page.locator('#cancel-api-key').click();
  await page.locator('#workspace-switcher').selectOption('main');
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(1);
  await openRunCreator(page);
  await expect(page.locator('#run-key-warning')).toBeHidden();
  await page.getByRole('checkbox', { name: 'Select ' + definition.name, exact: true }).check();
  await createSelectedRun(page);
  await expect(page.locator('.result-score')).toContainText('1.00');
  expect(generationCalls[0].body.openAiApiKey).toBe('synthetic-menu-key');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('synthetic-menu-key');
  expect(JSON.stringify(browserApp.store.db.prepare('SELECT data FROM runs').all())).not.toContain('synthetic-menu-key');
  await page.reload(); await expect(page.locator('#workspace')).toBeVisible();
  await openKeySettings(page);
  await expect(page.locator('#personal-api-key')).toHaveValue('');
  await expect(page.locator('#clear-api-key')).toBeDisabled();
});

for (const width of [1280, 390]) {
  test(`API key dialog cancels drafts, saves and clears the tab key at ${width}px`, async ({ page, generationCalls }) => {
    await page.setViewportSize({ width, height: 780 });
    await page.goto('/');
    await expect(page.locator('#key-settings')).toHaveCount(0);
    await openKeySettings(page);
    await page.locator('#personal-api-key').fill('cancelled-key');
    await page.locator('#cancel-api-key').click();
    await openKeySettings(page);
    await expect(page.locator('#personal-api-key')).toHaveValue('');
    await page.locator('#personal-api-key').fill('synthetic-dialog-key');
    await page.locator('#personal-api-key').press('Enter');
    await expect(page.locator('#api-key-dialog')).toBeHidden();
    await openKeySettings(page);
    await expect(page.locator('#personal-api-key')).toHaveValue('synthetic-dialog-key');
    await page.locator('#personal-api-key').fill('discard-on-escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('#api-key-dialog')).toBeHidden();
    await expect(page.locator('#user-menu-toggle')).toBeFocused();
    await openKeySettings(page);
    await expect(page.locator('#personal-api-key')).toHaveValue('synthetic-dialog-key');
    await page.screenshot({ path: test.info().outputPath('api-key-dialog.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(2);
    await page.locator('#clear-api-key').click();
    await expect(page.locator('#api-key-dialog')).toBeHidden();
    await openRunCreator(page);
    await expect(page.locator('#run-key-warning')).toBeVisible();
    await expect(page.locator('#submit-create-run')).toBeDisabled();
    await page.locator('#cancel-create-run').click();
    await openKeySettings(page);
    await expect(page.locator('#personal-api-key')).toHaveValue('');
    await expect(page.locator('#clear-api-key')).toBeDisabled();
    await page.locator('#close-api-key').click();
    await expect(page.locator('body')).not.toHaveClass(/modal-open/);
    expect(generationCalls).toHaveLength(0);
  });
}

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

test('unavailable key checks keep the dialog open and preserve the previously validated key', async ({ page }) => {
  await page.goto('/'); await openKeySettings(page);
  await page.locator('#personal-api-key').fill('original-key'); await page.locator('#save-api-key').click();
  await expect(page.locator('#api-key-dialog')).toBeHidden();
  await page.route('**/api/api-key/validate', route => route.fulfill({ status: 503, json: { error: 'OpenAI is rate limiting the key check. Please try again shortly.' } }));
  await openKeySettings(page);
  await page.locator('#personal-api-key').fill('replacement-key'); await page.locator('#save-api-key').click();
  await expect(page.locator('#api-key-error')).toContainText('rate limiting');
  await expect(page.locator('#api-key-dialog')).toBeVisible();
  await expect(page.locator('#personal-api-key')).toHaveValue('replacement-key');
  await expect(page.locator('#personal-api-key')).toBeEnabled();
  await expect(page.locator('#save-api-key')).toBeEnabled();
  await page.locator('#cancel-api-key').click(); await openKeySettings(page);
  await expect(page.locator('#personal-api-key')).toHaveValue('original-key');
  await expect(page.locator('#api-key-error')).toBeEmpty();
  await page.unroute('**/api/api-key/validate');
  await page.locator('#personal-api-key').fill(''); await page.locator('#save-api-key').click();
  await expect(page.locator('#api-key-error')).toContainText('Enter a valid OpenAI API key');
  await page.locator('#personal-api-key').fill('replacement-key'); await page.locator('#save-api-key').click();
  await expect(page.locator('#api-key-dialog')).toBeHidden();
  await openKeySettings(page); await expect(page.locator('#personal-api-key')).toHaveValue('replacement-key');
});

test('cancelled validation cannot overwrite a newer saved key and checking prevents duplicate submits', async ({ page }) => {
  await page.goto('/');
  let release, started, held = false, requests = 0;
  const gate = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { started = resolve; });
  await page.route('**/api/api-key/validate', async route => {
    requests++;
    if (held) return route.continue();
    held = true; const response = await route.fetch(); started(); await gate; await route.fulfill({ response });
  });
  try {
    await openKeySettings(page); await page.locator('#personal-api-key').fill('cancelled-key');
    await page.locator('#save-api-key').click(); await pending;
    await expect(page.locator('#save-api-key')).toBeDisabled();
    await expect(page.locator('#personal-api-key')).toBeDisabled();
    await expect(page.locator('#api-key-progress')).toBeVisible();
    await page.locator('#api-key-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    expect(requests).toBe(1);
    await page.keyboard.press('Escape'); await expect(page.locator('#api-key-dialog')).toBeHidden();
    await openKeySettings(page); await expect(page.locator('#personal-api-key')).toHaveValue('');
    await page.locator('#personal-api-key').fill('newer-key'); await page.locator('#save-api-key').click();
    await expect(page.locator('#api-key-dialog')).toBeHidden();
    const returned = page.waitForResponse('**/api/api-key/validate'); release(); await returned;
    await openKeySettings(page); await expect(page.locator('#personal-api-key')).toHaveValue('newer-key');
    expect(requests).toBe(2);
  } finally { release(); }
});

test.describe('admin', () => {
  test.use({ githubId: 1 });
  test('admins manage TestCraft and their personal space separately', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#new-button')).toBeVisible();
    await page.locator('#library-actions-toggle').click();
    await page.getByRole('button', { name: 'Load Basic Suite', exact: true }).click();
    await expect(page.locator('#evaluation-rows tr')).toHaveCount(12);
    await page.locator('#user-menu-toggle').click();
    await expect(page.locator('#private-badge')).toContainText('user-1 · admin');
    await expect(page.locator('#open-api-key')).toBeHidden();
    await page.keyboard.press('Escape');
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
    await expect(page.locator('#user-menu-name')).toHaveText('user-1001');
    await page.locator('#user-menu-toggle').click();
    await expect(page.locator('#private-badge')).toContainText('user-1001 · collaborator');
    const cookies = await page.context().cookies();
    expect(cookies.find(c => c.name === 'testcraft_session')).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
    expect(cookies.find(c => c.name === 'testcraft_oauth')).toBeUndefined();
  });
});
