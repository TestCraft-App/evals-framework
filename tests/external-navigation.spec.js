import { test, expect } from './browser-fixtures.mjs';

test('an external link opens the dashboard and restores the signed-in personal workspace', async ({ page, baseURL, browserApp }) => {
  let navigationHeaders;
  browserApp.server.on('request', request => {
    if (request.url === '/') navigationHeaders = request.headers;
  });
  await page.route('https://external.example/', route => route.fulfill({
    contentType: 'text/html', body: `<a href="${baseURL}/#personal/evaluations">Open evaluations</a>`,
  }));
  await page.goto('https://external.example/');
  const navigation = page.waitForResponse(response => response.url() === baseURL + '/' && response.request().isNavigationRequest());
  await page.getByRole('link', { name: 'Open evaluations' }).click();
  const response = await navigation;
  expect(navigationHeaders['sec-fetch-site']).toBe('cross-site');
  expect(response.status()).toBe(200);
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page).toHaveURL(baseURL + '/#personal/evaluations');
  const session = await (await page.request.get('/api/session')).json();
  expect(session.authenticated).toBe(true);
});
