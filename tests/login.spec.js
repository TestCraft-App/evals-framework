import { test, expect } from './browser-fixtures.mjs';

test.use({ signedIn: false });

for (const viewport of [{ width: 1280, height: 800 }, { width: 375, height: 812 }, { width: 320, height: 568 }]) {
  test('sign-in card is centered and fits at ' + viewport.width + 'px', async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Welcome to TestCraft' })).toBeVisible();
    const button = page.getByRole('button', { name: 'Sign in with GitHub' });
    await expect(button).toBeVisible();
    await expect(page.locator('#workspace')).toBeHidden();
    await expect(page.locator('#session-note')).toBeVisible();
    await expect(page.locator('#session-error')).toBeHidden();
    const card = await page.locator('.login-card').boundingBox();
    const header = await page.locator('.app-header').boundingBox();
    const action = await button.boundingBox();
    expect(Math.abs(card.x + card.width / 2 - viewport.width / 2)).toBeLessThan(2);
    expect(Math.abs(card.y + card.height / 2 - (viewport.height + header.height) / 2)).toBeLessThan(2);
    expect(card.x).toBeGreaterThanOrEqual(16);
    expect(card.x + card.width).toBeLessThanOrEqual(viewport.width - 16);
    expect(card.y + card.height).toBeLessThanOrEqual(viewport.height);
    expect(action.height).toBeGreaterThanOrEqual(48);
    expect(Math.abs(action.x + action.width / 2 - viewport.width / 2)).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
  });
}

test('GitHub sign-in is keyboard accessible with a visible focus outline', async ({ page }) => {
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Sign in with GitHub' });
  await expect(button).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'TestCraft Evals', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(button).toBeFocused();
  expect(await button.evaluate(element => getComputedStyle(element).outlineStyle)).toBe('solid');
});

test('failed GitHub callbacks show an error inside the card and allow another attempt', async ({ page }) => {
  await page.goto('/?login=failed');
  await expect(page.locator('.login-card [role="alert"]')).toHaveText('GitHub login could not be completed. Please try again.');
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeEnabled();
});

test('unavailable GitHub login keeps the card and administrator guidance visible', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ json: { authenticated: false, loginAvailable: false } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to TestCraft' })).toBeVisible();
  await expect(page.locator('.login-card [role="alert"]')).toHaveText('GitHub login is not configured. Contact the app administrator.');
  await expect(page.locator('#github-login')).toBeHidden();
  await expect(page.locator('#workspace')).toBeHidden();
});

test('sign-in initiation shows progress and restores the button after an error', async ({ page }) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await page.route('**/api/auth/github/start', async route => {
    await pending;
    await route.fulfill({ status: 503, json: { error: 'GitHub sign-in is temporarily unavailable. Please try again.' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
  try {
    await expect(page.getByRole('button', { name: 'Connecting to GitHub…' })).toBeDisabled();
  } finally { release(); }
  await expect(page.locator('#session-error')).toHaveText('GitHub sign-in is temporarily unavailable. Please try again.');
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeEnabled();
});

test('connection failures offer a retry that restores the sign-in card', async ({ page }) => {
  let attempts = 0;
  await page.route('**/api/session', route => ++attempts === 1
    ? route.fulfill({ status: 503, json: { error: 'The app is temporarily unavailable.' } })
    : route.continue());
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Let’s try that again' })).toBeVisible();
  await expect(page.locator('#session-error')).toHaveText('The app is temporarily unavailable.');
  await expect(page.locator('#github-login')).toBeHidden();
  await page.getByRole('button', { name: 'Retry connection' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome to TestCraft' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeEnabled();
  await expect(page.locator('#retry-session')).toBeHidden();
  await expect(page.locator('#session-error')).toBeHidden();
});
