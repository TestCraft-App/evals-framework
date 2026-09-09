import { test, expect, openRunCreator, createSelectedRun } from './browser-fixtures.mjs';

const rules = { name: 'Alpha rules', type: 'ideas', html: '<button>Login</button>', method: 'contains', criteria: ['valid credentials'] };
test('catalogs preload once at startup and modal spacing stays compact with an always-enabled grader', async ({ page }) => {
  const reads = [];
  page.on('request', request => { if (request.url().includes('/api/models?')) reads.push(new URL(request.url()).searchParams.get('environment')); });
  await seed(page);
  expect(reads.slice().sort()).toEqual(['dev', 'local', 'prod']);
  await openRunCreator(page);
  await expect(page.locator('#create-grader-model')).toBeEnabled();
  await expect(page.locator('#create-selected-count')).toContainText('0 selected');
  await expect(page.locator('#run-models-status')).toBeHidden();
  const heading = await page.locator('#create-run-form .dialog-heading').boundingBox();
  const parameters = await page.locator('.run-settings').boundingBox();
  const descriptionLabel = await page.locator('#run-description').locator('..').boundingBox();
  const description = await page.locator('#run-description').boundingBox();
  const filters = await page.locator('.run-eval-filters').boundingBox();
  expect(parameters.y - heading.y - heading.height).toBeLessThanOrEqual(20);
  expect(descriptionLabel.y - parameters.y - parameters.height).toBeLessThanOrEqual(20);
  expect(description.height).toBeLessThanOrEqual(42);
  expect(filters.y - description.y - description.height).toBeGreaterThanOrEqual(20);
  for (const environment of ['dev', 'local', 'prod']) {
    await page.locator('#create-environment').selectOption(environment);
    await expect(page.locator('#create-grader-model')).toBeEnabled();
  }
  await page.locator('#cancel-create-run').click(); await page.locator('#create-run').click();
  await expect(page.locator('#create-generation-model option')).toHaveCount(4);
  expect(reads).toHaveLength(3);
  await page.screenshot({ path: test.info().outputPath('compact-create-run.png'), fullPage: true });
});
test('TestCraft models are selectable for both roles and parameters precede description without extra helper text', async ({ page }) => {
  const models = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
  await seed(page);
  await page.route('**/api/models?environment=prod', route => route.fulfill({ json: { models: models.map(id => ({ id, label: id })), warning: null } }));
  await page.reload(); await expect(page.locator('#workspace')).toBeVisible();
  await page.getByRole('tab', { name: /^Runs/ }).click(); await page.locator('#create-run').click();
  await page.getByRole('checkbox', { name: 'Select Beta model', exact: true }).check();
  await expect(page.locator('#create-grader-model')).toBeEnabled();
  for (const id of ['create-generation-model', 'create-grader-model']) {
    await expect(page.locator('#' + id + ' option')).toHaveCount(4);
    for (const model of models) { await page.locator('#' + id).selectOption(model); await expect(page.locator('#' + id)).toHaveValue(model); }
    await expect(page.locator('#' + id + ' option:disabled')).toHaveCount(0);
  }
  await expect(page.locator('#run-grader-hint')).toHaveCount(0);
  await expect(page.locator('#run-models-status')).toBeHidden();
  await expect(page.locator('#create-run-dialog')).not.toContainText('Models without verified');
  await expect(page.locator('#create-run-dialog')).not.toContainText('Applies to all model-based criteria');
  const parameters = await page.locator('.run-settings').boundingBox(), description = await page.locator('#run-description').boundingBox();
  expect(description.y).toBeGreaterThan(parameters.y + parameters.height);
});
async function seed(page, count = 3) {
  await page.goto('/'); await expect(page.locator('#workspace')).toBeVisible();
  const session = await (await page.request.get('/api/session')).json();
  const headers = { origin: new URL(page.url()).origin, 'x-csrf-token': session.csrfToken };
  const definitions = count === 3 ? [rules, { ...rules, name: 'Beta model', method: 'model_grade' }, { ...rules, name: 'Gamma code', type: 'code', framework: 'playwright', language: 'typescript', pageUrl: 'https://example.com' }] : Array.from({ length: count }, (_, i) => ({ ...rules, name: 'Eval ' + i }));
  const saved = [];
  for (const data of definitions) {
    const response = await page.request.post('/api/evaluations', { headers, data }); expect(response.status()).toBe(201); saved.push(await response.json());
  }
  return saved;
}
test('run modal selects across filters, requires a conditional grader and creates a persisted Dev run', async ({ page, generationCalls }) => {
  const saved = await seed(page); await openRunCreator(page);
  await expect(page.locator('#create-eval-rows tr')).toHaveCount(3);
  await expect(page.locator('#create-environment')).toHaveValue('prod');
  await expect(page.locator('#create-grader-model')).toBeEnabled();
  await expect(page.locator('#run-grader-hint')).toHaveCount(0);
  await page.locator('#create-eval-search').fill('Alpha'); await page.locator('#create-select-all').check();
  await page.locator('#create-eval-search').fill('Beta'); await page.locator('#create-select-all').check();
  await expect(page.locator('#create-selected-count')).toHaveText('2 selected · maximum 50');
  await expect(page.locator('#create-grader-model')).toBeEnabled(); await expect(page.locator('#create-grader-model')).toHaveValue('gpt-4o-mini');
  await page.locator('#create-grader-model').selectOption(''); await expect(page.locator('#submit-create-run')).toBeDisabled();
  await page.locator('#create-select-all').uncheck();
  await expect(page.locator('#create-selected-count')).toHaveText('1 selected · maximum 50'); await expect(page.locator('#create-grader-model')).toBeEnabled();
  await page.locator('#create-eval-search').clear(); await page.locator('#create-eval-type').selectOption('code');
  await expect(page.locator('#create-eval-rows')).toContainText('Gamma code'); await page.locator('#create-eval-method').selectOption('model_based');
  await expect(page.locator('#create-eval-empty')).toBeVisible();
  await page.locator('#run-description').fill('Dev check <script>inert</script>');
  await page.locator('#create-environment').selectOption('dev');
  await expect(page.locator('#create-generation-model')).toBeEnabled();
  await page.locator('#create-generation-model').selectOption('gpt-4o');
  await createSelectedRun(page);
  await expect(page.locator('.result-score')).toContainText('1.00'); await expect(page.locator('.run-top')).toContainText('Env: Dev');
  await expect(page.locator('.run-top')).not.toContainText('Dev check <script>inert</script>');
  await expect(page.locator('.run-top script')).toHaveCount(0);
  const run = await (await page.request.get('/api/runs/' + new URL(page.url()).hash.split('/')[1])).json();
  expect(run.items.map(item => item.evaluationId)).toEqual([saved[0].id]); expect(run.settings.environment).toBe('dev'); expect(run.settings.generationModel).toBe('gpt-4o');
  expect(generationCalls).toHaveLength(1); expect(generationCalls[0].url).toContain('openai-api-proxy-dev'); expect(generationCalls[0].body.model).toBe('gpt-4o');
});

test('catalog failure blocks creation, Retry preserves the draft, and another environment cannot reuse its models', async ({ page }) => {
  await seed(page); let failed = true;
  await page.route('**/api/models?environment=prod', route => route.fulfill({ json: failed ? { models: [], warning: 'Models unavailable. Retry.' } : { models: [{ id: 'gpt-4o-mini', label: 'Mini', graderCompatible: true }] } }));
  await page.route('**/api/models?environment=dev', route => route.fulfill({ json: { models: [], warning: 'Dev unavailable' } }));
  await page.reload(); await expect(page.locator('#workspace')).toBeVisible();
  await page.getByRole('tab', { name: /^Runs/ }).click(); await page.locator('#create-run').click();
  await page.locator('#run-description').fill('Keep this draft'); await page.getByRole('checkbox', { name: 'Select Alpha rules', exact: true }).check();
  await expect(page.locator('#run-models-status')).toContainText('unavailable'); await expect(page.locator('#submit-create-run')).toBeDisabled();
  failed = false; await page.locator('#retry-run-models').click(); await page.locator('#create-generation-model').selectOption('gpt-4o-mini');
  await expect(page.locator('#run-description')).toHaveValue('Keep this draft'); await expect(page.locator('#create-selected-count')).toContainText('1 selected');

  await page.locator('#create-environment').selectOption('dev'); await expect(page.locator('#run-models-status')).toHaveText('Dev unavailable');
  await expect(page.locator('#create-generation-model')).toHaveValue(''); await expect(page.locator('#submit-create-run')).toBeDisabled();
  await page.locator('#create-environment').selectOption('prod'); await expect(page.locator('#create-generation-model')).toBeEnabled();
  await expect(page.locator('#create-generation-model')).toHaveValue('');
});

test('late catalog responses cannot overwrite a newer environment and Local availability comes from the backend', async ({ page }) => {
  await seed(page);
  await page.route('**/api/config', async route => {
    const response = await route.fetch(), body = await response.json();
    body.environments.find(e => e.id === 'local').enabled = false; await route.fulfill({ json: body });
  });
  await page.route('**/api/models?environment=prod', route => route.fulfill({ json: { models: [], warning: 'Retry models' } }));
  await page.reload(); await expect(page.locator('#workspace')).toBeVisible();
  let started, release;
  const pending = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/models?environment=prod', async route => { started(); await gate; await route.fulfill({ json: { models: [{ id: 'prod-only', label: 'Prod only' }] } }); });
  try {
    await page.getByRole('tab', { name: /^Runs/ }).click(); await page.locator('#create-run').click(); await page.locator('#retry-run-models').click(); await pending;
    await expect(page.locator('#create-environment option[value="local"]')).toHaveJSProperty('disabled', true);
    await page.locator('#create-environment').selectOption('dev'); await page.locator('#create-generation-model').selectOption('gpt-4o');
    const returned = page.waitForResponse('**/api/models?environment=prod'); release(); await returned;
    await expect(page.locator('#create-environment')).toHaveValue('dev'); await expect(page.locator('#create-generation-model')).toHaveValue('gpt-4o');
    await expect(page.locator('#create-generation-model option[value="prod-only"]')).toHaveCount(0);
  } finally { release(); }
});

test('select-all enforces 50, filters retain selections, and failed submission preserves the modal', async ({ page }) => {
  await seed(page, 51); await openRunCreator(page);
  await page.locator('#create-select-all').click(); await expect(page.locator('#create-run-error')).toContainText('at most 50');
  await expect(page.locator('#create-selected-count')).toContainText('0 selected');
  await page.locator('#create-eval-search').fill('Eval 1'); await page.locator('#create-select-all').check();
  await expect(page.locator('#create-selected-count')).toContainText('11 selected');
  await page.locator('#create-eval-search').fill('Eval 2'); await page.locator('#create-select-all').check();
  await expect(page.locator('#create-selected-count')).toContainText('22 selected');
  let attempts = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/api/runs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts++; await gate; await route.fulfill({ status: 429, json: { error: 'Allowance exhausted' } });
  });
  try {
    await page.locator('#submit-create-run').click(); await expect(page.locator('#submit-create-run')).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(page.locator('#create-run-dialog')).toBeVisible();
    release(); await expect(page.locator('#create-run-error')).toHaveText('Allowance exhausted');
    await expect(page.locator('#create-selected-count')).toContainText('22 selected'); expect(attempts).toBe(1);
    await page.locator('#cancel-create-run').click(); await expect(page.locator('#create-run')).toBeFocused();
  } finally { release(); }
});

for (const width of [1280, 390]) test(`modal keeps actions visible and supports keyboard selection at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 }); await seed(page, 20); await openRunCreator(page);
  const checkbox = page.getByRole('checkbox', { name: 'Select Eval 0', exact: true });
  await checkbox.focus(); await page.keyboard.press('Space'); await expect(checkbox).toBeChecked(); await expect(checkbox).toBeFocused();
  await expect(page.locator('#submit-create-run')).toBeInViewport(); await expect(page.locator('#cancel-create-run')).toBeInViewport();
  expect(await page.locator('.create-run-body').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(2);
  await page.screenshot({ path: test.info().outputPath('create-run-' + width + '.png'), fullPage: true });
});
