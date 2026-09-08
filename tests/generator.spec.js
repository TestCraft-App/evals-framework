import { test, expect } from '@playwright/test';
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
  await page.getByRole('button', { name: 'Load example' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Eval name', { exact: true }).fill('UI login coverage');
  await page.getByRole('button', { name: 'Next' }).click();
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

test('batch selection grades each case independently and preserves HTML as inert text', async ({ page }) => {
  const base = { name: 'Batch good', type: 'code', source: 'pasted', framework: 'playwright', language: 'typescript', method: 'contains', input: 'Test login', html: '<button onclick="alert(1)">Login</button><script>throw new Error("must not run")</script>', actualOutput: 'expect(page.getByRole("button")).toBeVisible()', criteria: ['expect', 'getByRole'], model: '', judgeModel: '', pageUrl: '' };
  const session = await (await page.request.get('/api/session')).json();
  const headers = { origin: 'http://127.0.0.1:3107', 'x-csrf-token': session.csrfToken };
  expect((await page.request.post('/api/evaluations', { headers, data: base })).status()).toBe(201);
  expect((await page.request.post('/api/evaluations', { headers, data: { ...base, name: 'Batch weak', actualOutput: 'expect(true)' } })).status()).toBe(201);
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

test('LLM as a judge has quality criteria and reports missing configuration honestly', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Load example' }).click();
  await page.getByLabel('Eval name', { exact: true }).fill('Judge configuration');
  await expect(page.getByRole('dialog').getByRole('combobox', { name: 'Framework', exact: true })).toBeDisabled();
  await page.getByLabel('TestCraft endpoint').selectOption('code');
  await page.getByRole('dialog').getByRole('combobox', { name: 'Framework', exact: true }).selectOption('cypress');
  await expect(page.locator('#language option[value=python]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('combobox', { name: 'Evaluation family', exact: true }).selectOption('model_based');
  await expect(page.getByRole('combobox', { name: 'Model grader' })).toBeEnabled();
  await expect(page.locator('#criteria-list li')).toHaveCount(0);
  await page.getByLabel('New criterion', { exact: true }).fill('The output includes a negative login test.');
  await page.getByRole('button', { name: 'Add criteria' }).click();
  await page.getByRole('button', { name: 'Create evaluation', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select Judge configuration', exact: true }).check();
  await page.getByRole('button', { name: 'Run selected', exact: false }).click();
  await expect(page.locator('.result-body .error-banner')).toContainText('OPENAI_API_KEY');
  await expect(page.locator('.result-score')).toHaveText('—');
  await expect(page.locator('.result-body .badge').first()).toHaveText('Error');
});

test('wizard validates each step, preserves edits on Back, and saves criteria as strings without a reference', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New evaluation' }).click();
  await expect(page.getByRole('dialog').getByRole('combobox', { name: 'Framework', exact: true })).toBeDisabled();
  await expect(page.getByRole('dialog').getByRole('combobox', { name: 'Language', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Page Object Model', { exact: true })).toBeDisabled();
  await expect(page.locator('#expected-output, #threshold')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#step-1')).toBeVisible();
  await expect(page.getByLabel('Eval name', { exact: true })).toBeFocused();
  await page.getByLabel('Eval name', { exact: true }).fill('Two-step contract');
  await page.locator('#html').fill('<form><button>Login</button></form>');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#step-2')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Model grader' })).toHaveValue('gpt-4o-mini');
  await expect(page.locator('#judge-model option[value="gpt-4-turbo"]')).toBeDisabled();
  await page.getByRole('combobox', { name: 'Model grader' }).selectOption('gpt-4o');
  await page.getByRole('button', { name: 'Create evaluation', exact: true }).click();
  await expect(page.locator('#form-error')).toContainText('Add at least one');
  await page.getByLabel('New criterion', { exact: true }).fill('Covers negative login scenarios.');
  await page.getByRole('button', { name: 'Add criteria' }).click();
  await page.getByLabel('New criterion', { exact: true }).fill('Temporary criterion');
  await page.getByLabel('New criterion', { exact: true }).press('Enter');
  await expect(page.locator('#criteria-list li')).toHaveCount(2);
  await page.getByRole('button', { name: 'Remove criterion 2' }).click();
  await page.getByLabel('Criterion 1', { exact: true }).fill('Uses only controls from the HTML.');
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByLabel('Eval name', { exact: true })).toHaveValue('Two-step contract');
  await expect(page.locator('#input')).toHaveValue('');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByLabel('Criterion 1', { exact: true })).toHaveValue('Uses only controls from the HTML.');
  await expect(page.getByRole('combobox', { name: 'Model grader' })).toHaveValue('gpt-4o');
  const savedResponse = page.waitForResponse(res => res.url().endsWith('/api/evaluations') && res.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create evaluation', exact: true }).click();
  const response = await savedResponse, payload = response.request().postDataJSON(), saved = await response.json();
  expect(payload.criteria).toEqual(['Uses only controls from the HTML.']);
  expect(payload).not.toHaveProperty('threshold'); expect(payload).not.toHaveProperty('expectedOutput');
  expect(payload).not.toHaveProperty('framework'); expect(payload).not.toHaveProperty('language');
  expect(saved.threshold).toBe(80); expect(saved.input).toBe(''); expect(saved.judgeModel).toBe('gpt-4o');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('code parameters and selected ideas validate independently of the optional description', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'New evaluation' }).click();
  await page.getByLabel('Eval name', { exact: true }).fill('Code parameters');
  await page.locator('#html').fill('<button>Login</button>');
  await page.getByLabel('TestCraft endpoint').selectOption('code');
  await page.getByRole('dialog').getByRole('combobox', { name: 'Framework', exact: true }).selectOption('cypress');
  await expect(page.locator('#language option[value=python]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#page-url')).toBeFocused();
  await page.locator('#page-url').fill('https://www.saucedemo.com/');
  await page.getByLabel('Generate code from selected ideas', { exact: true }).check();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#ideas')).toBeFocused();
  await page.locator('#ideas').fill('Log in with valid credentials.');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByLabel('TestCraft endpoint').selectOption('ideas');
  await expect(page.locator('#ideas')).toBeHidden();
  await expect(page.getByLabel('Generate code from selected ideas', { exact: true })).toBeDisabled();
  await page.getByLabel('TestCraft endpoint').selectOption('code');
  await expect(page.getByRole('dialog').getByRole('combobox', { name: 'Framework', exact: true })).toHaveValue('cypress');
  await expect(page.locator('#ideas')).toHaveValue('Log in with valid credentials.');
});

test('model catalog failure is explicit and Retry preserves the form', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/models', route => {
    attempts++;
    return route.fulfill({ json: attempts === 1 ? { models: [{ id: 'gpt-4o-mini', label: 'Backend configured', graderCompatible: true }], warning: 'TestCraft models are unavailable. Only the backend-configured model is listed.' } : catalog });
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Load example' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('combobox', { name: 'Evaluation family', exact: true }).selectOption('model_based');
  await page.getByLabel('New criterion', { exact: true }).fill('Negative scenarios specify their expected behavior.');
  await page.getByRole('button', { name: 'Add criteria' }).click();
  await expect(page.locator('#models-status')).toContainText('unavailable');
  await expect(page.getByRole('combobox', { name: 'Model grader' })).toHaveValue('gpt-4o-mini');
  await page.getByRole('button', { name: 'Retry loading models' }).click();
  await expect(page.locator('#models-status')).toContainText('TestCraft catalog');
  await expect(page.locator('#criteria-list li')).toHaveCount(1);
  await expect(page.getByRole('combobox', { name: 'Model grader' })).toBeEnabled();
});

test('exact match has its own single-target draft and preserves Contains criteria when switching back', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'Load example' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('dialog').getByRole('combobox', { name: 'Method', exact: true }).selectOption('exact_match');
  await expect(page.locator('#criteria-list li')).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Model grader' })).toBeDisabled();
  await page.getByRole('button', { name: 'Create evaluation', exact: true }).click();
  await expect(page.locator('#form-error')).toContainText('exactly one');
  await page.getByLabel('New criterion', { exact: true }).fill('The complete response');
  await page.getByRole('button', { name: 'Add criteria' }).click();
  await expect(page.locator('#criteria-list li')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Add criteria' })).toBeDisabled();
  await page.getByRole('dialog').getByRole('combobox', { name: 'Method', exact: true }).selectOption('contains');
  await expect(page.locator('#criteria-list li')).toHaveCount(3);
  await page.getByRole('dialog').getByRole('combobox', { name: 'Method', exact: true }).selectOption('exact_match');
  await expect(page.getByLabel('Criterion 1', { exact: true })).toHaveValue('The complete response');
  await page.getByRole('button', { name: 'Create evaluation', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('family switching restores rubric drafts and never turns them into literal checks', async ({ page }) => {
  await page.getByRole('button', { name: 'Load example' }).click();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.locator('#method-family')).toHaveValue('rule_based');
  await expect(page.locator('#grading-cost')).toContainText('0 model calls');
  await page.locator('#method-family').selectOption('model_based');
  await expect(page.locator('#method')).toHaveValue('model_grade');
  await expect(page.locator('#criteria-list li')).toHaveCount(0);
  await page.getByLabel('New criterion', { exact: true }).fill('The negative tests state the expected error.');
  await page.getByRole('button', { name: 'Add criteria' }).click();
  await page.getByLabel('New criterion', { exact: true }).fill('Unfinished rubric criterion');
  await page.locator('#method-family').selectOption('rule_based');
  await expect(page.locator('#criteria-list li')).toHaveCount(3);
  await expect(page.getByLabel('New criterion', { exact: true })).toHaveValue('');
  await page.locator('#method-family').selectOption('model_based');
  await expect(page.locator('#criteria-list li')).toHaveCount(1);
  await expect(page.getByLabel('New criterion', { exact: true })).toHaveValue('Unfinished rubric criterion');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'New evaluation' }).click();
  await expect(page.locator('#criteria-list li')).toHaveCount(0);
});

test('Does not contain saves a rule-based case and runs without a model grader', async ({ page }) => {
  await page.getByRole('button', { name: 'Load example' }).click();
  await page.getByLabel('Eval name', { exact: true }).fill('No placeholder code');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('dialog').getByRole('combobox', { name: 'Method', exact: true }).selectOption('not_contains');
  await expect(page.getByRole('combobox', { name: 'Model grader' })).toBeDisabled();
  await page.getByLabel('New criterion', { exact: true }).fill('TODO');
  await page.getByRole('button', { name: 'Add criteria' }).click();
  await page.getByRole('button', { name: 'Create evaluation', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select No placeholder code', exact: true }).check();
  await page.getByRole('button', { name: 'Run selected', exact: false }).click();
  await expect(page.locator('.result-score')).toContainText('100');
  await expect(page.locator('.result-title')).toContainText('Rule-based / Does not contain');
  await expect(page.getByText('Not found: TODO', { exact: true })).toBeVisible();
});

for (const viewport of [{ width: 1280, height: 650 }, { width: 390, height: 700 }]) {
  test(`modal keeps a single scroll area and accessible actions at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport); await page.goto('/');
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
