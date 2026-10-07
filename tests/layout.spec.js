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
  for (const width of [1280, 390]) test(`workspace bar distinguishes visibility and access at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 780 }); await page.goto('/');
    for (const workspace of ['main', 'personal']) {
      await page.getByLabel('Workspace', { exact: true }).selectOption(workspace);
      await expect(page.locator('#workspace')).toBeVisible();
      const personal = workspace === 'personal';
      await expect(page.locator('.workspace-controls')).toHaveAttribute('data-workspace', workspace);
      await expect(page.locator('#workspace-name')).toHaveText(personal ? 'My workspace' : 'TestCraft');
      await expect(page.locator('#workspace-visibility')).toHaveText(personal ? 'Private' : 'Shared');
      await expect(page.locator('.workspace-controls')).toHaveCSS('background-color', personal ? 'rgb(239, 245, 255)' : 'rgb(237, 248, 245)');
      await expect(page.locator('.workspace-controls')).toHaveCSS('border-left-color', personal ? 'rgb(49, 94, 168)' : 'rgb(20, 125, 115)');
      await expect(page.locator('.workspace-icon')).toHaveAttribute('aria-hidden', 'true');
      await expect(page.locator(personal ? '#workspace-personal-icon' : '#workspace-shared-icon')).toBeVisible();
      await expect(page.locator(personal ? '#workspace-shared-icon' : '#workspace-personal-icon')).toBeHidden();
      await expect(page.locator('#workspace-announcement')).toHaveAttribute('aria-live', 'polite');
      await expect(page.locator('#workspace-announcement')).toHaveAttribute('aria-atomic', 'true');
      await expect(page.locator('#workspace-announcement')).toHaveText(personal ? 'My workspace · Private' : 'TestCraft · Shared');
      const contrasts = await page.locator('.workspace-controls').evaluate(bar => {
        const luminance = color => {
          const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
            const channel = value / 255;
            return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
          });
          return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
        };
        return [...bar.querySelectorAll('#workspace-name, #workspace-visibility, #workspace-access, label, select')].map(element => {
          let background = element;
          while (getComputedStyle(background).backgroundColor === 'rgba(0, 0, 0, 0)') background = background.parentElement;
          const foreground = luminance(getComputedStyle(element).color), surface = luminance(getComputedStyle(background).backgroundColor);
          return (Math.max(foreground, surface) + .05) / (Math.min(foreground, surface) + .05);
        });
      });
      for (const contrast of contrasts) expect(contrast).toBeGreaterThanOrEqual(4.5);
      const readonly = githubId === 1001 && workspace === 'main';
      await expect(page.locator('#workspace-access')).toHaveText(readonly ? 'Read-only library · your runs are saved in My workspace.' : 'You can manage this workspace.');
      if (readonly) await expect(page.locator('.library-actions')).toBeHidden();
      else await expect(page.locator('.library-actions')).toBeVisible();
      const select = await page.locator('#workspace-switcher').boundingBox(), message = await page.locator('#workspace-access').boundingBox();
      const identity = await page.locator('.workspace-identity').boundingBox(), title = await page.locator('.workspace-title').boundingBox();
      expect(message.y).toBeGreaterThanOrEqual(title.y + title.height);
      if (width > 700) {
        expect(select.x).toBeGreaterThan(identity.x + identity.width);
      } else {
        expect(select.y).toBeGreaterThan(identity.y + identity.height);
        expect(select.x).toBe(identity.x);
      }
      await page.locator('#workspace-switcher').focus();
      await expect(page.locator('#workspace-switcher')).toBeFocused();
      await expect(page.locator('#workspace-switcher')).toHaveCSS('outline-style', 'solid');
      await page.keyboard.press('Tab');
      await expect(page.locator('#evaluations-tab')).toBeFocused();
      await page.getByRole('tab', { name: /^Runs/ }).click();
      await expect(page.locator('.workspace-controls')).toBeVisible();
      await expect(page.locator('#workspace-name')).toHaveText(personal ? 'My workspace' : 'TestCraft');
      await page.getByRole('tab', { name: /^Evaluations/ }).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(2);
      await page.screenshot({ path: test.info().outputPath(workspace + '-workspace-controls.png'), fullPage: true });
    }
  });
});

test('native workspace dropdown supports keyboard switching', async ({ page }) => {
  await page.goto('/#main/evaluations');
  await expect(page.locator('#workspace')).toBeVisible();
  await page.locator('#workspace-switcher').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page).toHaveURL(/#personal\/evaluations$/);
  await expect(page.locator('#workspace-name')).toHaveText('My workspace');
  await expect(page.locator('#workspace-visibility')).toHaveText('Private');
});
