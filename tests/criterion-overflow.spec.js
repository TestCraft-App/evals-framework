import { test, expect } from './browser-fixtures.mjs';

const longText = 'After invalid credentials are submitted, the visible error identifies the rejected login without exposing the entered password. '.repeat(3).trim();

for (const width of [1280, 390]) test(`added criteria truncate safely and remain editable at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  await page.locator('#new-button').click();
  await page.locator('#name').fill('Criterion overflow');
  await page.locator('#html').fill('<button>Login</button>');
  await page.locator('#save-evaluation').click();
  for (const [method, text] of [['model_based', longText], ['rule_based', 'x'.repeat(300)], ['model_based', 'Short.']]) {
    await page.locator('#method').selectOption(method);
    await page.locator('#criterion-draft').fill(text);
    await page.locator('#add-criterion').click();
  }
  const fields = page.locator('#criteria-list [data-criterion]');
  const previews = page.locator('.criterion-text-preview');
  for (const index of [0, 1]) {
    await expect(fields.nth(index)).toHaveAttribute('title', index === 0 ? longText : 'x'.repeat(300));
    await expect(previews.nth(index)).toHaveCSS('text-overflow', 'ellipsis');
    await expect(fields.nth(index)).toHaveCSS('overflow-x', 'hidden');
    await expect(fields.nth(index)).toHaveCSS('overflow-y', 'hidden');
    expect((await fields.nth(index).boundingBox()).height).toBe(38);
    expect(await previews.nth(index).evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  }
  await expect(fields.nth(2)).not.toHaveAttribute('title');
  await expect(previews.nth(2)).toHaveText('Short.');
  await page.screenshot({ path: test.info().outputPath('criteria-ellipsis.png') });
  if (width === 1280) {
    const medium = 'A moderately long criterion for the current field.';
    await fields.nth(2).fill(medium); await page.locator('#criterion-draft').focus();
    await expect(fields.nth(2)).not.toHaveAttribute('title');
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(fields.nth(2)).toHaveAttribute('title', medium);
    await page.setViewportSize({ width, height: 900 });
    await expect(fields.nth(2)).not.toHaveAttribute('title');
    await fields.nth(2).fill('Short.'); await page.locator('#criterion-draft').focus();
  }

  // Keyboard focus reveals the editor; even unbroken text wraps without an x scrollbar.
  await fields.nth(0).focus();
  await expect(previews.nth(0)).toBeHidden();
  await expect(fields.nth(0)).toHaveValue(longText);
  expect((await fields.nth(0).boundingBox()).height).toBe(62);
  await fields.nth(1).focus();
  expect(await fields.nth(1).evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await expect(fields.nth(1)).toHaveCSS('overflow-y', 'auto');

  const revised = 'Updated criterion ' + '<script>window.criterionExecuted=true</script> "quoted" '.repeat(4);
  await fields.nth(0).fill(revised);
  await page.locator('#criterion-draft').focus();
  await expect(fields.nth(0)).toHaveAttribute('title', revised);
  await expect(previews.nth(0)).toHaveText(revised);
  await expect(page.locator('.criterion-text-preview script')).toHaveCount(0);
  expect(await page.evaluate(() => window.criterionExecuted)).toBeUndefined();
  await fields.nth(1).fill('Brief.');
  await page.locator('#criterion-draft').focus();
  await expect(fields.nth(1)).not.toHaveAttribute('title');
  expect((await fields.nth(0).boundingBox()).height).toBe(38);
  expect(await page.locator('#evaluation-dialog').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);

  const pending = page.waitForResponse(response => response.url().endsWith('/api/evaluations') && response.request().method() === 'POST');
  await page.locator('#save-evaluation').click();
  const saved = await (await pending).json();
  expect(saved.criteria.map(criterion => criterion.text)).toEqual([revised.trim(), 'Brief.', 'Short.']);
  await page.getByRole('button', { name: 'Criterion overflow', exact: true }).click();
  await page.locator('#save-evaluation').click();
  await expect(fields.nth(0)).toHaveValue(revised.trim());
  await expect(fields.nth(0)).toHaveAttribute('title', revised.trim());
});

test('multiline exact-match text survives previewing and editing', async ({ page }) => {
  await page.goto('/'); await page.locator('#new-button').click();
  await page.locator('#name').fill('Multiline literal'); await page.locator('#html').fill('<button>Save</button>');
  await page.locator('#save-evaluation').click();
  await page.locator('#method').selectOption('rule_based'); await page.locator('#criterion-rule').selectOption('exact_match');
  const text = 'First line\nSecond line with  two spaces';
  await page.locator('#criterion-draft').fill(text); await page.locator('#add-criterion').click();
  const field = page.locator('#criterion-0');
  await expect(page.locator('.criterion-text-preview')).toHaveText('First line ↵ Second line with  two spaces');
  await field.focus(); await expect(field).toHaveValue(text);
  await field.press('ControlOrMeta+End'); await field.press('Enter'); await field.pressSequentially('Third line');
  const pending = page.waitForResponse(response => response.url().endsWith('/api/evaluations') && response.request().method() === 'POST');
  await page.locator('#save-evaluation').click();
  expect((await (await pending).json()).criteria[0].text).toBe(text + '\nThird line');
});
