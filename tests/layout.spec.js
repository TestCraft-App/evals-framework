import { test, expect } from './browser-fixtures.mjs';

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 780 }]) {
  test(`header and footer stay concise and session details remain accessible at ${viewport.width}px`, async ({ page }) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize(viewport); await page.goto('/');
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workspace');
    await expect(page.locator('#model-allowance')).toHaveText('200 / 200 calls left');
    await expect(page.locator('.page-heading .eyebrow, .page-heading .subtitle, .session-strip, .workflow-tip')).toHaveCount(0);
    await expect(page.locator('.app-header').getByRole('link', { name: 'Extension' })).toHaveAttribute('href', 'https://home.testcraft.app/');
    await expect(page.locator('.app-footer')).not.toContainText('Built for testing');
    await expect(page.locator('.app-footer').getByRole('link', { name: 'GitHub' })).toHaveAttribute('href', 'https://github.com/TestCraft-App/evals-framework');
    await expect(page.locator('#session-expiry')).not.toBeVisible();
    await page.screenshot({ path: test.info().outputPath('clean-workspace.png'), fullPage: true });
    const disclosure = page.locator('.workspace-details summary');
    await disclosure.focus(); await page.keyboard.press('Enter');
    await expect(page.locator('#session-expiry')).toBeVisible();
    await expect(page.locator('#workspace-id')).not.toBeEmpty();
    await expect(page.locator('.workspace-details')).toContainText('not a dollar limit');
    await expect(page.locator('.workspace-details')).toContainText('Generated code is not executed');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(2);
    await page.keyboard.press('Enter');
    await expect(page.locator('#session-expiry')).not.toBeVisible();
    await page.getByRole('tab', { name: /^Runs/ }).click();
    await expect(page.locator('#runs-panel')).toBeVisible();
    await page.locator('.app-header').getByRole('link', { name: 'TestCraft Evals' }).click();
    await expect(page.locator('#evaluations-panel')).toBeVisible();
    expect(errors).toEqual([]);
  });
}
