import { test, expect, openRunCreator, createSelectedRun } from './browser-fixtures.mjs';

async function start(page) {
  await page.goto('/'); await expect(page.locator('#workspace')).toBeVisible();
  await page.locator('#new-button').click(); await page.locator('#name').fill('Described rules');
  await page.locator('#html').fill('<button>Login</button>'); await page.locator('#save-evaluation').click();
}
async function addRule(page, rule, text, description = '') {
  await page.locator('#method').selectOption('rule_based'); await page.locator('#criterion-rule').selectOption(rule);
  await page.locator('#criterion-description').fill(description); await page.locator('#criterion-draft').fill(text);
  await page.locator('#add-criterion').click();
}

test('description belongs only to rule criteria and survives method changes and Back', async ({ page }) => {
  await start(page); await expect(page.locator('#criterion-description-field')).toBeHidden();
  await page.locator('#method').selectOption('rule_based'); await page.locator('#criterion-description').fill('Login coverage');
  await page.locator('#method').selectOption('model_based'); await expect(page.locator('#criterion-description')).toBeDisabled();
  await page.locator('#criterion-draft').fill('The output describes an observable result.'); await page.locator('#add-criterion').click();
  await expect(page.locator('#criteria-list [data-criterion-description]')).toHaveCount(0);
  await page.locator('#method').selectOption('rule_based'); await expect(page.locator('#criterion-description')).toHaveValue('Login coverage');
  await page.locator('#criterion-draft').fill('valid credentials'); await page.locator('#add-criterion').click();
  await expect(page.locator('#criterion-description')).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Description for criterion 2', exact: true })).toHaveValue('Login coverage');
  await page.getByRole('textbox', { name: 'Description for criterion 2', exact: true }).fill('Edited coverage');
  await page.locator('#back-step').click(); await page.locator('#save-evaluation').click();
  await expect(page.getByRole('textbox', { name: 'Description for criterion 2', exact: true })).toHaveValue('Edited coverage');
  const pending = page.waitForResponse(r => r.url().endsWith('/api/evaluations') && r.request().method() === 'POST');
  await page.locator('#save-evaluation').click(); const saved = await (await pending).json();
  expect(saved.criteria[0]).not.toHaveProperty('description'); expect(saved.criteria[1].description).toBe('Edited coverage');
});

test('saved descriptions reach Run Detail, remain inert, and persist through duplication without rewriting history', async ({ page, generationCalls }) => {
  await start(page);
  const descriptions = ['Login <script>window.descriptionExecuted=true</script>', 'No unfinished placeholders', 'Expected full response'];
  await addRule(page, 'contains', 'valid credentials', descriptions[0]);
  await addRule(page, 'not_contains', 'TODO', descriptions[1]);
  await addRule(page, 'exact_match', 'Generated ideas: valid credentials; invalid email; empty password.', descriptions[2]);
  await page.locator('#save-evaluation').click(); await expect(page.locator('#evaluation-dialog')).toBeHidden();
  await openRunCreator(page); await page.getByRole('checkbox', { name: 'Select Described rules', exact: true }).check();
  await createSelectedRun(page); await expect(page.locator('.result-score')).toHaveText('1.00');
  await page.locator('.detail-expand').click(); await expect(page.locator('.criterion-description')).toHaveText(descriptions);
  await expect(page.locator('.criterion-description script')).toHaveCount(0);
  expect(await page.evaluate(() => window.descriptionExecuted)).toBeUndefined();
  expect(generationCalls).toHaveLength(1);
  for (const description of descriptions) expect(JSON.stringify(generationCalls[0].body)).not.toContain(description);
  const runUrl = page.url(), run = await (await page.request.get('/api/runs/' + runUrl.split('/').at(-1))).json();
  expect(run.items[0].checks.map(c => c.description)).toEqual(descriptions);
  await page.getByRole('tab', { name: /^Evaluations/ }).click();
  await page.locator('#evaluation-rows').getByRole('button', { name: 'Described rules', exact: true }).click(); await page.locator('#save-evaluation').click();
  await page.getByRole('textbox', { name: 'Description for criterion 1', exact: true }).fill('Updated login description');
  await page.locator('#save-evaluation').click(); await expect(page.locator('#evaluation-dialog')).toBeHidden();
  await page.getByRole('button', { name: 'Duplicate Described rules', exact: true }).click();
  await page.locator('#duplicate-name').press('Escape');
  await page.getByRole('button', { name: 'Described rules (copy)', exact: true }).click(); await page.locator('#save-evaluation').click();
  await expect(page.getByRole('textbox', { name: 'Description for criterion 1', exact: true })).toHaveValue('Updated login description');
  await page.locator('#cancel-dialog').click(); await page.goto(runUrl); await page.locator('.detail-expand').click();
  await expect(page.locator('.criterion-description')).toHaveText(descriptions);
});

for (const width of [1280, 390]) test(`rule description sits beside the narrower Method dropdown at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await start(page);
  await addRule(page, 'contains', 'valid credentials', 'Covers successful login');
  await page.locator('#criterion-description').fill('No placeholder code');
  const method = await page.locator('#method').boundingBox(), description = await page.locator('#criterion-description').boundingBox();
  const rule = await page.locator('#criterion-rule').boundingBox();
  expect(method.width).toBe(rule.width); expect(method.x).toBe(rule.x); expect(description.x).toBeGreaterThan(method.x + method.width);
  expect(description.y).toBeCloseTo(method.y, 0);
  const layout = await page.locator('#evaluation-dialog').evaluate(dialog => ({ overflow: dialog.scrollWidth - dialog.clientWidth, footer: dialog.querySelector('.wizard-actions').getBoundingClientRect().bottom <= innerHeight }));
  expect(layout.overflow).toBeLessThanOrEqual(2); expect(layout.footer).toBe(true);
  const savedDescription = page.locator('[data-criterion-description]');
  const savedText = await page.locator('[data-criterion]').boundingBox(), savedBox = await savedDescription.boundingBox();
  expect(savedBox.y + savedBox.height).toBeLessThanOrEqual(savedText.y); const badge = await page.locator('#criteria-list .badge').boundingBox();
  expect(savedBox.x).toBeGreaterThan(badge.x + badge.width);
  await expect(savedDescription).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
  await expect(page.locator('#criterion-composer-label')).toHaveText('Criteria');
  await page.screenshot({ path: test.info().outputPath('rule-description.png') });
  await page.locator('#method').selectOption('model_based'); await expect(page.locator('#criterion-description-field')).toBeHidden();
  await expect(page.locator('#criterion-composer-label')).toBeVisible();
  await page.locator('#criterion-draft').fill('An observable outcome'); await page.locator('#add-criterion').click();
  const modelCard = page.locator('#criteria-list li').last();
  const header = await modelCard.locator('.criterion-card-header').boundingBox(), body = await modelCard.locator('.criterion-card-body').boundingBox();
  expect(header.y + header.height).toBeLessThanOrEqual(body.y);
  await expect(modelCard.locator('.criterion-rule-pill')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('mixed-criteria-cards.png') });
});

test('numbered cards allow rule edits while rejecting duplicate and second exact matches', async ({ page }) => {
  await start(page);
  await addRule(page, 'contains', 'same text', 'First description');
  await addRule(page, 'not_contains', 'same text', 'Second description');
  await page.locator('#method').selectOption('model_based');
  await page.locator('#criterion-draft').fill('Describe an observable outcome'); await page.locator('#add-criterion').click();
  await expect(page.getByRole('region', { name: 'Add criterion', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Added criteria', exact: true })).toBeVisible();
  await expect(page.locator('.criterion-number')).toHaveText(['1.', '2.', '3.']);
  await expect(page.locator('#criteria-list .badge')).toHaveText(['Rule-based', 'Rule-based', 'Model-graded']);
  const first = page.getByRole('combobox', { name: 'Rule for criterion 1', exact: true });
  const second = page.getByRole('combobox', { name: 'Rule for criterion 2', exact: true });
  await second.selectOption('contains'); await expect(second).toHaveValue('not_contains');
  await expect(page.locator('#form-error')).toHaveText('This criterion is already in the list.');
  await first.selectOption('exact_match'); await second.selectOption('exact_match');
  await expect(second).toHaveValue('not_contains');
  await expect(page.locator('#form-error')).toHaveText('Use at most one Exact match criterion.');
  await page.locator('#back-step').click(); await page.locator('#save-evaluation').click();
  await expect(first).toHaveValue('exact_match');
  await page.getByRole('button', { name: 'Remove criterion 1', exact: true }).click();
  await expect(page.locator('.criterion-number')).toHaveText(['1.', '2.']);
  await page.getByRole('combobox', { name: 'Rule for criterion 1', exact: true }).selectOption('exact_match');
  const pending = page.waitForResponse(r => r.url().endsWith('/api/evaluations') && r.request().method() === 'POST');
  await page.locator('#save-evaluation').click(); const saved = await (await pending).json();
  expect(saved.criteria.map(c => c.method)).toEqual(['exact_match', 'model_grade']);
  expect(saved.criteria[0].description).toBe('Second description'); expect(saved.method).toBe('hybrid');
});
