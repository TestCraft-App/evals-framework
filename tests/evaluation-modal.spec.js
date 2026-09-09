import { test, expect, openRunCreator, createSelectedRun } from './browser-fixtures.mjs';

test.beforeEach(async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#workspace')).toBeVisible();
});
async function newEvaluation(page, name = 'Synthetic evaluation') {
  await page.locator('#new-button').click();
  await page.locator('#name').fill(name); await page.locator('#html').fill('<button>Login</button>');
}
async function add(page, method, text) {
  await page.locator('#method').selectOption(method === 'model_grade' ? 'model_based' : 'rule_based');
  if (method !== 'model_grade') await page.locator('#criterion-rule').selectOption(method);
  await page.locator('#criterion-draft').fill(text); await page.locator('#add-criterion').click();
}
async function save(page, button = 'save-evaluation', verb = 'POST') {
  const pending = page.waitForResponse(r => /\/api\/evaluations(?:\/[^/]+)?$/.test(r.url()) && r.request().method() === verb);
  await page.locator('#' + button).click(); const response = await pending;
  expect(response.ok()).toBe(true); await expect(page.locator('#evaluation-dialog')).toBeHidden();
  return { saved: await response.json(), payload: response.request().postDataJSON() };
}
async function suiteAction(page, kind) {
  await page.locator('#suite-actions').click(); await page.locator('#' + kind + '-suite').click();
}
async function createSuite(page, name) {
  await suiteAction(page, 'create'); await page.locator('#suite-name').fill(name);
  await page.locator('#save-suite').click(); await expect(page.locator('#suite-editor')).toBeHidden();
  return page.locator('#evaluation-suite').inputValue();
}

for (const [endpoint, path] of [['ideas', 'generate-ideas'], ['code', 'automate-tests'], ['code_ideas', 'automate-tests-ideas']]) {
  test(`${endpoint} saves applicable inputs and sends the correct generation payload`, async ({ page, generationCalls }) => {
    await newEvaluation(page, endpoint);
    await expect(page.locator('#type option')).toHaveText(['Generate ideas', 'Automate tests', 'Automate test ideas']);
    await page.locator('#type').selectOption('code_ideas');
    await page.locator('#framework').selectOption('cypress'); await page.locator('#language').selectOption('javascript');
    await page.locator('#page-url').fill('https://example.com/login'); await page.locator('#pom').check();
    await page.locator('#ideas').fill('Valid login\nInvalid login');
    await page.locator('#type').selectOption(endpoint);
    if (endpoint === 'ideas') await expect(page.locator('#code-parameters')).toBeHidden();
    if (endpoint !== 'code_ideas') await expect(page.locator('#ideas-field')).toBeHidden();
    await page.locator('#save-evaluation').click(); await add(page, 'contains', 'valid credentials');
    const { saved, payload } = await save(page);
    expect(payload).not.toHaveProperty('input'); expect(saved.fromIdeas).toBe(endpoint === 'code_ideas');
    if (endpoint === 'ideas') for (const field of ['framework', 'language', 'pageUrl', 'pom', 'ideas']) expect(payload).not.toHaveProperty(field);
    else { expect(saved.framework).toBe('cypress'); expect(saved.language).toBe('javascript'); expect(saved.pom).toBe(true); }
    if (endpoint === 'code') expect(payload).not.toHaveProperty('ideas');
    expect(generationCalls).toHaveLength(0);
    await page.locator('#filter-type').selectOption(endpoint); await expect(page.locator('#evaluation-rows tr')).toHaveCount(1);
    await openRunCreator(page); await page.locator('#create-eval-type').selectOption(endpoint);
    await page.getByRole('checkbox', { name: 'Select ' + endpoint, exact: true }).check(); await createSelectedRun(page);
    await expect(page.locator('.result-score')).toHaveText('1.00'); expect(generationCalls).toHaveLength(1);
    expect(generationCalls[0].url).toBe('https://api.testcraft.app/api/' + path);
    expect(generationCalls[0].body).toEqual({ sourceCode: '<button>Login</button>', stream: true, model: 'gpt-4o-mini',
      ...(endpoint !== 'ideas' ? { baseUrl: 'https://example.com/login', framework: 'cypress', language: 'javascript', pom: true } : {}),
      ...(endpoint === 'code_ideas' ? { ideas: ['Valid login', 'Invalid login'] } : {}),
    });
  });
}

test('suite actions preserve drafts, save immediately, and prevent nonempty deletion', async ({ page }) => {
  await newEvaluation(page); await page.locator('#suite-actions').click();
  await expect(page.locator('#rename-suite')).toBeDisabled(); await expect(page.locator('#delete-suite')).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(page.locator('#suite-actions')).toBeFocused();
  const id = await createSuite(page, 'Suite <safe>'); await expect(page.locator('#suite-actions')).toBeFocused();
  await suiteAction(page, 'rename'); await page.locator('#suite-name').fill('Renamed suite');
  await page.locator('#suite-name').press('Enter'); await expect(page.locator('#suite-editor')).toBeHidden();
  await expect(page.locator('#evaluation-suite')).toHaveValue(id);
  await expect(page.locator('#name')).toHaveValue('Synthetic evaluation'); await expect(page.locator('#html')).toHaveValue('<button>Login</button>');
  await page.locator('#save-evaluation').click(); await add(page, 'contains', 'Login');
  const { saved } = await save(page); expect(saved.suiteId).toBe(id);
  await page.getByRole('button', { name: saved.name, exact: true }).click(); await page.locator('#suite-actions').click();
  await expect(page.locator('#delete-suite')).toBeDisabled(); await expect(page.locator('#suite-delete-hint')).toBeVisible();
  await page.keyboard.press('Escape');
  const empty = await createSuite(page, 'Empty <suite>'); expect(empty).not.toBe(id);
  await suiteAction(page, 'delete'); await expect(page.locator('#suite-delete-confirmation')).toHaveText('Delete suite “Empty <suite>”?');
  await expect(page.locator('#cancel-suite')).toBeFocused(); await page.locator('#cancel-suite').click();
  await expect(page.locator('#evaluation-suite')).toHaveValue(empty);
  await suiteAction(page, 'delete'); await page.locator('#save-suite').click();
  await expect(page.locator('#suite-editor')).toBeHidden(); await expect(page.locator('#evaluation-suite')).toHaveValue('');
  await page.locator('#cancel-dialog').click();
  const records = (await (await page.request.get('/api/suites')).json()).suites;
  expect(records.map(s => s.name)).toEqual(['Renamed suite']);
});

test('suite failures, in-flight saves, and stale deletion keep the evaluation draft', async ({ page, browserApp }) => {
  await newEvaluation(page); await suiteAction(page, 'create'); await page.locator('#save-suite').click();
  await expect(page.locator('#suite-error')).toContainText('Enter a suite name');
  await page.locator('#suite-name').fill('Retry suite');
  await page.route('**/api/suites', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, json: { error: 'Temporary suite failure.' } }) : route.continue());
  await page.locator('#save-suite').click(); await expect(page.locator('#suite-error')).toContainText('Temporary suite failure');
  await expect(page.locator('#suite-name')).toHaveValue('Retry suite'); await page.unroute('**/api/suites');
  let release, started;
  const gate = new Promise(resolve => { release = resolve; }), request = new Promise(resolve => { started = resolve; });
  await page.route('**/api/suites', async route => { if (route.request().method() === 'POST') { started(); await gate; } await route.continue(); });
  await page.locator('#save-suite').click(); await request;
  await expect(page.locator('#save-suite')).toBeDisabled(); await expect(page.locator('#save-evaluation')).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(page.locator('#evaluation-dialog')).toBeVisible();
  release(); await expect(page.locator('#suite-editor')).toBeHidden(); await page.unroute('**/api/suites');
  const suiteId = await page.locator('#evaluation-suite').inputValue();
  await suiteAction(page, 'delete');
  const session = await (await page.request.get('/api/session')).json();
  const scope = { ownerId: session.workspaceId, workshopId: 'browser-tests' };
  const member = browserApp.store.create({ name: 'Concurrent member', suiteId, type: 'ideas', method: 'contains', html: '<b>Safe</b>', criteria: ['Safe'] }, scope);
  await page.locator('#save-suite').click(); await expect(page.locator('#suite-error')).toHaveText('Only empty suites can be deleted.');
  expect(browserApp.store.evaluation(member.id, scope)).toEqual(member);
  await expect(page.locator('#name')).toHaveValue('Synthetic evaluation'); await expect(page.locator('#html')).toHaveValue('<button>Login</button>');
  await page.locator('#cancel-suite').click(); await page.locator('#suite-actions').click();
  await expect(page.locator('#delete-suite')).toBeDisabled();
});

test('criteria classify by family, reset weights on edit, and retain classification in Save as new', async ({ page }) => {
  await newEvaluation(page, 'Mixed rules'); await page.locator('#save-evaluation').click();
  await add(page, 'contains', 'valid credentials'); await add(page, 'not_contains', 'TODO');
  const { saved } = await save(page); expect(saved.method).toBe('hybrid');
  expect(saved.criteria.map(c => c.weight)).toEqual([1, 1]);
  await page.locator('#filter-method').selectOption('rule_based'); await expect(page.locator('#evaluation-rows tr')).toHaveCount(1);
  await openRunCreator(page); await page.locator('#create-eval-method').selectOption('rule_based');
  await expect(page.locator('#create-eval-rows')).toContainText('Mixed rules');
  await page.getByRole('checkbox', { name: 'Select Mixed rules', exact: true }).check(); await createSelectedRun(page);
  await expect(page.locator('.detail-eval-row')).toContainText('rule-based');
  await page.locator('#detail-filter-method').selectOption('rule-based'); await expect(page.locator('.detail-eval-row')).toHaveCount(1);
  const session = await (await page.request.get('/api/session')).json();
  const response = await page.request.put('/api/evaluations/' + saved.id, { headers: { origin: new URL(page.url()).origin, 'x-csrf-token': session.csrfToken }, data: { ...saved, criteria: saved.criteria.map(c => ({ ...c, weight: 9 })) } });
  expect(response.ok()).toBe(true); await page.goto('/');
  await page.getByRole('button', { name: saved.name, exact: true }).click(); await page.locator('#save-evaluation').click();
  await add(page, 'model_grade', 'Covers the login flow.');
  await expect(page.locator('#criteria-list .badge')).toHaveText(['Contains', 'Not Contains', 'Model-graded']);
  const copy = await save(page, 'save-as-new'); expect(copy.saved.id).not.toBe(saved.id);
  expect(copy.saved.criteria.map(c => c.weight)).toEqual([1, 1, 1]);
  await page.locator('#filter-method').selectOption('hybrid'); await expect(page.locator('#evaluation-rows tr')).toHaveCount(1);
  await page.getByRole('button', { name: copy.saved.name, exact: true }).click(); await page.locator('#save-evaluation').click();
  await page.getByRole('button', { name: 'Remove criterion 3', exact: true }).click(); await save(page, 'save-evaluation', 'PUT');
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(0);
});

test('criterion errors reject duplicates, empty edits, excess count and excess total text', async ({ page }) => {
  await newEvaluation(page); await page.locator('#save-evaluation').click();
  await add(page, 'contains', 'x'); await add(page, 'contains', 'x');
  await expect(page.locator('#form-error')).toContainText('already in the list');
  await page.locator('#criterion-draft').fill('a'.repeat(8000)); await page.locator('#add-criterion').click();
  await expect(page.locator('#form-error')).toContainText('8000'); await page.locator('#criterion-draft').fill('');
  await page.locator('#criterion-0').fill(''); await page.locator('#save-evaluation').click();
  await expect(page.locator('#criterion-0')).toBeFocused(); await page.locator('#criterion-0').fill('x');
  for (let i = 1; i < 20; i++) await add(page, 'contains', 'criterion ' + i);
  await expect(page.locator('#criteria-count')).toHaveText('20 criteria'); await expect(page.locator('#add-criterion')).toBeDisabled();
  await page.locator('#criterion-draft').fill('one too many'); await page.locator('#save-evaluation').click();
  await expect(page.locator('#form-error')).toContainText('at most 20');
  await page.locator('#criterion-draft').fill(''); await save(page);
});

for (const width of [1280, 390]) test(`modal hierarchy and single-row criteria at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await newEvaluation(page);
  await page.locator('#type').selectOption('code_ideas'); await page.locator('#page-url').fill('https://example.com');
  await page.locator('#ideas').fill('Valid login');
  const name = await page.locator('#name').boundingBox(), suite = await page.locator('#evaluation-suite').boundingBox(), endpoint = await page.locator('#type').boundingBox();
  expect(name.y).toBeLessThan(suite.y);
  if (width > 520) { expect(Math.abs(suite.y - endpoint.y)).toBeLessThan(2); expect(name.width).toBeGreaterThan(endpoint.width * 1.9); }
  else expect(endpoint.y).toBeGreaterThan(suite.y);
  await expect(page.locator('#input, #source-hint, #code-params-hint, #method-family, #use-weights, #score-formula')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('parameters.png') });
  await page.locator('#save-evaluation').click(); await add(page, 'contains', 'A long literal '.repeat(20));
  await add(page, 'model_grade', 'An observable quality '.repeat(20));
  const toolbar = await page.locator('.criteria-toolbar').boundingBox(), draft = await page.locator('#criterion-draft').boundingBox(), list = await page.locator('#criteria-list').boundingBox();
  expect(toolbar.y + toolbar.height).toBeLessThanOrEqual(draft.y); expect(draft.y + draft.height).toBeLessThan(list.y);
  expect(draft.height).toBeLessThanOrEqual(42);
  const geometry = await page.locator('#evaluation-dialog').evaluate(dialog => {
    const footer = dialog.querySelector('.wizard-actions').getBoundingClientRect();
    return { overflow: dialog.scrollWidth - dialog.clientWidth, footer: footer.bottom <= innerHeight, heights: [...dialog.querySelectorAll('#criteria-list textarea')].map(el => el.getBoundingClientRect().height) };
  });
  expect(geometry.overflow).toBeLessThanOrEqual(2); expect(geometry.footer).toBe(true); expect(geometry.heights).toEqual([38, 38]);
  await page.screenshot({ path: test.info().outputPath('criteria.png') });
});
