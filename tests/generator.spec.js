import { test, expect, openRunCreator, createSelectedRun } from './browser-fixtures.mjs';

// Template loaders are admin actions in the shared TestCraft workspace.
test.use({ initialWorkspace: 'main' });
let pageErrors;
const catalog = { models: [
  { id: 'gpt-4o-mini', label: 'GPT-4o mini', graderCompatible: true },
  { id: 'gpt-4o', label: 'GPT-4o', graderCompatible: true },
  { id: 'gpt-4-turbo', label: 'GPT-4 Turbo', graderCompatible: false },
], source: 'testcraft', warning: null };
test.beforeEach(async ({ page }) => {
  pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
  await page.route('**/api/models', route => route.fulfill({ json: catalog }));
  await page.goto('/');
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#access-code, #access-form')).toHaveCount(0);
});
test.afterEach(() => expect(pageErrors).toEqual([]));

test('create, persist, select and run an evaluation in the results tab', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Backend connected', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Load example' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Eval name', { exact: true }).fill('UI login coverage');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Create evaluation', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'UI login coverage', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'UI login coverage', exact: true })).toBeVisible();
  await openRunCreator(page);
  await page.getByRole('checkbox', { name: 'Select UI login coverage', exact: true }).check();
  await createSelectedRun(page);
  await expect(page.getByRole('tab', { name: /^Runs/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.result-score')).toContainText('1.00');
  await expect(page.locator('.detail-eval-row .badge').first()).toHaveText('Graded');
  await page.locator('.detail-expand').click();
  await expect(page.locator('.criterion-result')).toHaveCount(3);
  await expect(page.getByRole('link', { name: 'Open in new tab' })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.result-score')).toContainText('1.00');
  await page.getByRole('tab', { name: /^Evaluations/ }).click();
  await expect(page.locator('#evaluations-panel').getByRole('combobox', { name: 'Status', exact: true })).toHaveCount(0);
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(1);
  await page.getByRole('tab', { name: /^Runs/ }).click();
  await expect(page.locator('#run-list .score')).toHaveText('1.00');
});

test('finished runs can be deleted with confirmation while evaluations stay runnable', async ({ page }) => {
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Load example' }).click();
  await page.getByLabel('Eval name', { exact: true }).fill('Keep this evaluation');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Create evaluation', exact: true }).click();
  await openRunCreator(page);
  await page.getByRole('checkbox', { name: 'Select Keep this evaluation', exact: true }).check();
  await createSelectedRun(page);
  await expect(page.locator('.result-score')).toContainText('1.00');
  const savedRunUrl = page.url();
  const deleteButton = page.locator('#run-detail').getByRole('button', { name: 'Delete run', exact: true });
  const confirmation = page.getByRole('alertdialog', { name: 'Delete this run?' });
  await deleteButton.click();
  await expect(confirmation).toContainText('This cannot be undone');
  await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(page.locator('#run-list [data-run-link]')).toHaveCount(1);
  await expect(deleteButton).toBeFocused();
  await deleteButton.click();
  await confirmation.getByRole('button', { name: 'Delete run', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(page.locator('#runs-count')).toHaveText('0');
  await expect(page.locator('#empty-runs')).toContainText('Your runs will appear here.');
  await expect(page.locator('#run-detail-page')).toBeHidden();
  await expect(page.locator('.result-score')).toHaveCount(0);
  await page.goto(savedRunUrl);
  await expect(page).toHaveURL(/#main\/runs$/);
  await expect(page.locator('#empty-runs')).toContainText('Your runs will appear here.');
  await page.getByRole('tab', { name: /^Evaluations/ }).click();
  await expect(page.locator('#evaluation-rows')).toContainText('Keep this evaluation');
  await expect(page.locator('#evaluations-panel').getByRole('combobox', { name: 'Status', exact: true })).toHaveCount(0);
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(1);
  await openRunCreator(page);
  await page.getByRole('checkbox', { name: 'Select Keep this evaluation', exact: true }).check();
  await createSelectedRun(page);
  await expect(page.locator('.result-score')).toContainText('1.00');
});

test('failed deletion keeps the run and lets the user retry or cancel', async ({ page }) => {
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Load example' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Create evaluation', exact: true }).click();
  await openRunCreator(page);
  await page.getByRole('checkbox', { name: 'Select all visible evaluations' }).check();
  await createSelectedRun(page);
  await expect(page.locator('.result-score')).toContainText('1.00');
  await page.route('**/api/workspaces/main/runs/*', route => route.request().method() === 'DELETE' ? route.fulfill({ status: 503, json: { error: 'Temporary deletion failure. Try again.' } }) : route.continue());
  await page.locator('#run-detail').getByRole('button', { name: 'Delete run', exact: true }).click();
  const confirmation = page.getByRole('alertdialog');
  await confirmation.getByRole('button', { name: 'Delete run', exact: true }).click();
  await expect(page.locator('#delete-run-error')).toContainText('Temporary deletion failure');
  await expect(confirmation.getByRole('button', { name: 'Delete run', exact: true })).toBeEnabled();
  await expect(page.locator('#runs-count')).toHaveText('1');
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('.result-score')).toContainText('1.00');
  await expect(page.locator('body')).not.toHaveClass('modal-open');
});

test('batch selection grades each case independently and preserves HTML as inert text', async ({ page }) => {
  const base = { name: 'Batch good', type: 'code', source: 'pasted', framework: 'playwright', language: 'typescript', method: 'contains', input: 'Test login', html: '<button onclick="alert(1)">Login</button><script>throw new Error("must not run")</script>', actualOutput: 'expect(page.getByRole("button")).toBeVisible()', criteria: ['valid credentials', 'invalid email'], model: '', judgeModel: '', pageUrl: 'https://example.com/login' };
  const session = await (await page.request.get('/api/session')).json();
  const headers = { origin: new URL(page.url()).origin, 'x-csrf-token': session.csrfToken };
  expect((await page.request.post('/api/workspaces/main/evaluations', { headers, data: base })).status()).toBe(201);
  expect((await page.request.post('/api/workspaces/main/evaluations', { headers, data: { ...base, name: 'Batch weak', criteria: ['valid credentials', 'getByRole'], actualOutput: 'expect(true)' } })).status()).toBe(201);
  await page.goto('/');
  await page.getByRole('searchbox').fill('Batch');
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(2);
  await openRunCreator(page);
  await page.getByRole('checkbox', { name: 'Select all visible evaluations' }).check();
  await createSelectedRun(page);
  await expect(page.locator('.run-top .badge')).toHaveText('Complete');
  await expect(page.locator('.detail-eval-row')).toHaveCount(2);
  const weak = page.locator('.detail-eval-row').filter({ hasText: 'Batch weak' });
  await weak.locator('.detail-expand').click();
  await expect(weak.locator('.result-score')).toHaveText('0.50');
  await expect(page.getByText('Contains: “getByRole” — Not met', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /^Evaluations/ }).click();
  await expect(page.locator('#evaluations-panel .filters select')).toHaveCount(3);
  await expect(page.locator('#evaluations-panel').getByRole('combobox', { name: 'Status', exact: true })).toHaveCount(0);
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(2);
  await expect(page.locator('#evaluation-rows')).toContainText('Batch good');
  await expect(page.locator('#evaluation-rows')).toContainText('Batch weak');
  await page.getByRole('tab', { name: /^Runs/ }).click();
  await page.locator('#run-status').selectOption('completed');
  await expect(page.locator('#run-list tr')).toHaveCount(1);
  await page.locator('#run-status').selectOption('interrupted');
  await expect(page.locator('#run-list tr')).toHaveCount(0);
});

test('LLM as a judge has quality criteria and reports missing configuration honestly', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Load example' }).click();
  await page.getByLabel('Eval name', { exact: true }).fill('Judge configuration');
  await expect(page.locator('#framework')).toBeHidden();
  await page.getByLabel('TestCraft endpoint').selectOption('code');
  await page.getByRole('dialog').getByRole('combobox', { name: 'Framework', exact: true }).selectOption('cypress');
  await expect(page.locator('#language option[value=python]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.locator('#method').selectOption('model_based');
  await expect(page.locator('#judge-model')).toHaveCount(0);
  await expect(page.locator('#criteria-list li')).toHaveCount(3);
  await page.getByLabel('New criterion', { exact: true }).fill('The output includes a negative login test.');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Create evaluation', exact: true }).click();
  await openRunCreator(page);
  await page.getByRole('checkbox', { name: 'Select Judge configuration', exact: true }).check();
  await createSelectedRun(page);
  await page.locator('.detail-expand').click();
  await expect(page.locator('.criterion-panel .error-banner')).toContainText('OPENAI_API_KEY');
  await expect(page.locator('.result-score')).toHaveText('—');
  await expect(page.locator('.detail-eval-row .badge').first()).toHaveText('Error');
});

test('wizard validates each step, preserves edits on Back, and saves typed criteria without a reference', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New evaluation' }).click();
  await expect(page.locator('#framework')).toBeHidden();
  await expect(page.locator('#language')).toBeHidden();
  await expect(page.getByLabel('Page Object Model', { exact: true })).toBeDisabled();
  await expect(page.locator('#expected-output, #threshold')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#step-1')).toBeVisible();
  await expect(page.getByLabel('Eval name', { exact: true })).toBeFocused();
  await page.getByLabel('Eval name', { exact: true }).fill('Two-step contract');
  await page.locator('#html').fill('<form><button>Login</button></form>');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#step-2')).toBeVisible();
  await expect(page.locator('#judge-model')).toHaveCount(0);
  await page.getByRole('button', { name: 'Create evaluation', exact: true }).click();
  await expect(page.locator('#form-error')).toContainText('Add at least one');
  await page.getByLabel('New criterion', { exact: true }).fill('Covers negative login scenarios.');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('New criterion', { exact: true }).fill('Temporary criterion');
  await page.getByLabel('New criterion', { exact: true }).press('Enter');
  await expect(page.locator('#criteria-list li')).toHaveCount(2);
  await page.getByRole('button', { name: 'Remove criterion 2' }).click();
  await page.getByLabel('Criterion 1', { exact: true }).fill('Uses only controls from the HTML.');
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByLabel('Eval name', { exact: true })).toHaveValue('Two-step contract');
  await expect(page.locator('#input')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByLabel('Criterion 1', { exact: true })).toHaveValue('Uses only controls from the HTML.');
  await expect(page.locator('#judge-model')).toHaveCount(0);
  const savedResponse = page.waitForResponse(res => res.url().endsWith('/api/workspaces/main/evaluations') && res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create evaluation', exact: true }).click();
  const response = await savedResponse, payload = response.request().postDataJSON(), saved = await response.json();
  expect(payload.criteria).toEqual([{ text: 'Uses only controls from the HTML.', method: 'model_grade', weight: 1 }]);
  expect(payload).not.toHaveProperty('threshold'); expect(payload).not.toHaveProperty('expectedOutput');
  expect(payload).not.toHaveProperty('framework'); expect(payload).not.toHaveProperty('language');
  expect(saved.threshold).toBe(80); expect(saved.input).toBe(''); expect(saved.judgeModel).toBe('');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('code parameters and selected ideas validate only for their endpoints', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'New evaluation' }).click();
  await page.getByLabel('Eval name', { exact: true }).fill('Code parameters');
  await page.locator('#html').fill('<button>Login</button>');
  await page.getByLabel('TestCraft endpoint').selectOption('code');
  await page.getByRole('dialog').getByRole('combobox', { name: 'Framework', exact: true }).selectOption('cypress');
  await expect(page.locator('#language option[value=python]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#page-url')).toBeFocused();
  await page.locator('#page-url').fill('https://www.saucedemo.com/');
  await page.getByLabel('TestCraft endpoint').selectOption('code_ideas');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#ideas')).toBeFocused();
  await page.locator('#ideas').fill('Log in with valid credentials.');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByLabel('TestCraft endpoint').selectOption('ideas');
  await expect(page.locator('#ideas')).toBeHidden();
  await expect(page.locator('#from-ideas')).toHaveCount(0);
  await page.getByLabel('TestCraft endpoint').selectOption('code_ideas');
  await expect(page.getByRole('dialog').getByRole('combobox', { name: 'Framework', exact: true })).toHaveValue('cypress');
  await expect(page.locator('#ideas')).toHaveValue('Log in with valid credentials.');
});

test('evaluation creation does not depend on the model catalog', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/models*', route => { calls++; return route.fulfill({ status: 503, json: { error: 'Unavailable' } }); });
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Load example' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.locator('#method').selectOption('model_based');
  await page.getByLabel('New criterion', { exact: true }).fill('Negative scenarios specify their expected behavior.');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.locator('#save-evaluation').click();
  await expect(page.locator('#evaluation-dialog')).toBeHidden();
  expect(calls).toBe(0);
});

test('exact match joins existing criteria and remains limited to one target', async ({ page }) => {
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Load example' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('combobox', { name: 'Criteria rule', exact: true }).selectOption('exact_match');
  await expect(page.locator('#criteria-list li')).toHaveCount(3);
  await page.getByLabel('New criterion', { exact: true }).fill('The complete response\nwith a second line');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('#criteria-list li')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Criteria rule', exact: true }).selectOption('contains');
  await expect(page.getByRole('button', { name: 'Add', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Criterion 4', { exact: true })).toHaveValue('The complete response\nwith a second line');
  await page.getByRole('button', { name: 'Create evaluation', exact: true }).click();
  await expect(page.locator('#evaluation-dialog')).toBeHidden();
  await expect(page.locator('#evaluation-rows')).toContainText('rule-based');
});

test('method switching preserves existing criteria and the pending text', async ({ page }) => {
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Load example' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.locator('#method').selectOption('model_based');
  await page.getByLabel('New criterion', { exact: true }).fill('The negative tests state the expected error.');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('New criterion', { exact: true }).fill('Unfinished rubric criterion');
  await page.locator('#method').selectOption('rule_based');
  await expect(page.locator('#criteria-list li')).toHaveCount(4);
  await expect(page.locator('#criteria-list .badge')).toHaveText(['Rule-based', 'Rule-based', 'Rule-based', 'Model-graded']);
  await page.locator('#method').selectOption('model_based');
  await expect(page.getByLabel('New criterion', { exact: true })).toHaveValue('Unfinished rubric criterion');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'New evaluation' }).click();
  await expect(page.locator('#criteria-list li')).toHaveCount(0);
});

test('Does not contain saves a rule-based case and runs without a model grader', async ({ page }) => {
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Load example' }).click();
  await page.getByLabel('Eval name', { exact: true }).fill('No placeholder code');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('dialog').getByRole('combobox', { name: 'Criteria rule', exact: true }).selectOption('not_contains');
  await expect(page.locator('#judge-model')).toHaveCount(0);
  await page.getByLabel('New criterion', { exact: true }).fill('TODO');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Create evaluation', exact: true }).click();
  await openRunCreator(page);
  await page.getByRole('checkbox', { name: 'Select No placeholder code', exact: true }).check();
  await createSelectedRun(page);
  await expect(page.locator('.result-score')).toContainText('1.00');
  await expect(page.locator('.detail-eval-row')).toContainText('rule-based');
  await page.locator('.detail-expand').click();
  await expect(page.getByText('Does not contain: “TODO” — Met', { exact: true })).toBeVisible();
});

for (const viewport of [{ width: 1280, height: 650 }, { width: 390, height: 700 }]) {
  test(`modal keeps a single scroll area and accessible actions at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport); await page.goto('/');
    await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Load example' }).click();
    await page.locator('#html').fill('<form>\n' + '<button>Login</button>\n'.repeat(70) + '</form>');
    for (const step of [1, 2]) {
      if (step === 2) await page.getByRole('button', { name: 'Next' }).click();
      const layout = await page.getByRole('dialog').evaluate(dialog => {
        const scroll = document.getElementById('wizard-body'), actions = document.querySelector('.wizard-actions').getBoundingClientRect();
        return {
          dialogOverflowY: dialog.scrollHeight - dialog.clientHeight,
          dialogOverflowX: dialog.scrollWidth - dialog.clientWidth,
          bodyLocked: getComputedStyle(document.body).overflow === 'hidden',
          onlyScrollOwner: getComputedStyle(scroll).overflowY === 'auto',
          nestedTextareaScroll: [...dialog.querySelectorAll('textarea')].some(el => el.getClientRects().length && el.scrollHeight > el.clientHeight + 2),
          actionsVisible: actions.bottom <= innerHeight && actions.top >= 0,
        };
      });
      expect(layout.dialogOverflowY).toBeLessThanOrEqual(2); expect(layout.dialogOverflowX).toBeLessThanOrEqual(2);
      expect(layout.bodyLocked).toBe(true); expect(layout.onlyScrollOwner).toBe(true);
      expect(layout.nestedTextareaScroll).toBe(false); expect(layout.actionsVisible).toBe(true);
    }
    await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.locator('body')).not.toHaveClass('modal-open');
  });
}
