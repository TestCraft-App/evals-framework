import { test, expect } from './browser-fixtures.mjs';

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 780 }]) {
  test(`header shows account identity while keeping session internals private at ${viewport.width}px`, async ({ page }) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    await page.setViewportSize(viewport); await page.goto('/');
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(page.locator('#private-badge')).toBeVisible();
    await expect(page.locator('#private-badge')).toContainText('user-1 · admin');
    await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toHaveCount(0);
    await expect(page.locator('.stats')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Evaluation library' })).toBeVisible();
    await expect(page.locator('#model-allowance')).toHaveCount(0);
    await expect(page.locator('.page-heading .eyebrow, .page-heading .subtitle, .session-strip, .workflow-tip')).toHaveCount(0);
    await expect(page.locator('.app-header').getByRole('link', { name: 'Extension' })).toHaveAttribute('href', 'https://home.testcraft.app/');
    await expect(page.locator('.app-footer')).not.toContainText('Built for testing');
    await expect(page.locator('.app-footer').getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', 'https://github.com/TestCraft-App/evals-framework');
    await expect(page.locator('.workspace-details, #session-expiry, #workspace-id')).toHaveCount(0);
    await expect(page.locator('.app-footer')).not.toContainText('Session details');
    await expect(page.locator('#connection')).toContainText('Backend connected');
    await page.screenshot({ path: test.info().outputPath('clean-workspace.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(2);
    await page.getByRole('tab', { name: /^Runs/ }).click();
    await expect(page.locator('#runs-panel')).toBeVisible();
    await page.locator('.app-header').getByRole('link', { name: 'TestCraft Evals' }).click();
    await expect(page.locator('#evaluations-panel')).toBeVisible();
    const sessionRefresh = page.waitForResponse(response => response.url().endsWith('/api/session') && response.request().method() === 'GET');
    await page.clock.fastForward(30000);
    await sessionRefresh;
    await expect(page.locator('#app-error')).toBeHidden();
    expect(errors).toEqual([]);
  });
}
