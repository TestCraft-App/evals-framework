import { test, expect } from './browser-fixtures.mjs';

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 780 }]) {
  test(`header shows account identity while keeping session internals private at ${viewport.width}px`, async ({ page }) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.clock.install();
    await page.setViewportSize(viewport); await page.goto('/');
    await expect(page.locator('#workspace')).toBeVisible();
    await expect(page.locator('#user-menu-name')).toHaveText('user-1');
    await expect(page.locator('#user-menu-panel')).toBeHidden();
    await page.locator('#user-menu-toggle').focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#user-menu-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#private-badge')).toContainText('user-1 · admin');
    await expect(page.locator('#extension-link')).toBeFocused();
    await expect(page.locator('#logout')).toBeVisible();
    await expect(page.locator('#open-api-key')).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Workspace', exact: true })).toHaveCount(0);
    await expect(page.locator('.stats')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Evaluation library' })).toBeVisible();
    await expect(page.locator('#model-allowance')).toHaveCount(0);
    await expect(page.locator('.page-heading .eyebrow, .page-heading .subtitle, .session-strip, .workflow-tip')).toHaveCount(0);
    await expect(page.locator('.app-header').getByRole('link', { name: 'Extension' })).toHaveAttribute('href', 'https://home.testcraft.app/');
    await expect(page.locator('#extension-link')).toHaveAttribute('target', '_blank');
    await expect(page.locator('#extension-link')).toHaveAttribute('rel', 'noreferrer');
    await page.screenshot({ path: test.info().outputPath('user-menu.png'), fullPage: true });
    expect(await page.locator('#user-menu-panel').evaluate(el => el.getBoundingClientRect().right <= innerWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#user-menu-panel')).toBeHidden();
    await expect(page.locator('#user-menu-toggle')).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(page.locator('#extension-link')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#logout')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#user-menu-panel')).toBeHidden();
    await page.locator('#user-menu-toggle').click();
    await page.getByRole('heading', { name: 'Evaluation library' }).click();
    await expect(page.locator('#user-menu-toggle')).toHaveAttribute('aria-expanded', 'false');
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

for (const githubId of [1, 1001]) test.describe(`workspace controls for ${githubId === 1 ? 'admins' : 'collaborators'}`, () => {
  test.use({ githubId, initialWorkspace: 'main' });
  for (const width of [1280, 390]) test(`access text aligns with the dropdown at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 780 }); await page.goto('/');
    for (const workspace of ['main', 'personal']) {
      await page.getByLabel('Workspace', { exact: true }).selectOption(workspace);
      await expect(page.locator('#workspace')).toBeVisible();
      const readonly = githubId === 1001 && workspace === 'main';
      await expect(page.locator('#workspace-access')).toHaveText(readonly ? 'Read-only library · your runs are saved in My workspace.' : 'You can manage this workspace.');
      if (readonly) await expect(page.locator('.library-actions')).toBeHidden();
      else await expect(page.locator('.library-actions')).toBeVisible();
      const select = await page.locator('#workspace-switcher').boundingBox(), message = await page.locator('#workspace-access').boundingBox();
      if (width > 700) {
        expect(Math.abs(select.y + select.height / 2 - message.y - message.height / 2)).toBeLessThan(1);
        expect(message.x).toBeGreaterThan(select.x + select.width);
      } else {
        expect(message.y).toBeGreaterThan(select.y + select.height);
        expect(message.x).toBe(select.x);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(2);
      await page.screenshot({ path: test.info().outputPath(workspace + '-workspace-controls.png'), fullPage: true });
    }
  });
});
