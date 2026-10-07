import { test as base, expect } from '@playwright/test';
import { once } from 'node:events';
import { createOAuthApp as createApp } from './helpers.mjs';

// Each test gets real HTTP/session/database behavior with its own app instance.
// This avoids sharing rate-limit state or weakening production's session limits.
export const test = base.extend({
  signedIn: [true, { option: true }],
  githubId: [1, { option: true }],
  initialWorkspace: ['personal', { option: true }],
  context: async ({ context, baseURL, signedIn, githubId, initialWorkspace }, use) => {
    if (signedIn) {
      const started = await context.request.post(baseURL + '/api/auth/github/start', { data: {}, headers: { origin: baseURL } });
      const authorization = new URL((await started.json()).authorizeUrl);
      await context.request.get(baseURL + '/api/auth/github/callback?' + new URLSearchParams({ state: authorization.searchParams.get('state'), code: String(githubId) }));
    }
    await context.addInitScript(workspace => { if (!location.hash) history.replaceState(null, '', '#' + workspace + '/evaluations'); }, initialWorkspace);
    await use(context);
  },
  generationOutput: ['Generated ideas: valid credentials; invalid email; empty password.', { option: true }],
  generationCalls: async ({}, use) => { await use([]); },
  judgeCount: [3, { option: true }],
  browserApp: async ({ generationOutput, generationCalls, judgeCount }, use) => {
    const app = createApp({
      dbPath: ':memory:',
      env: { NODE_ENV: 'test', WORKSHOP_ID: 'browser-tests', OPENAI_API_KEY: '', TESTCRAFT_OPENAI_API_KEY: '' },
      fetchImpl: async (url, options) => {
        if (url.endsWith('/api/models')) return Response.json({ models: ['gpt-4o-mini', 'gpt-4o', 'o3-mini'].map(id => ({ id, label: id })) });
        if (url === 'https://api.openai.com/v1/chat/completions') {
          const body = JSON.parse(options.body);
          const context = JSON.parse(body.messages.find(message => message.role === 'user').content);
          const checks = context.criteria.map(criterion => criterion.method === 'test_count'
            ? { id: criterion.id, count: judgeCount, evidence: '<script>window.countInjection = true</script> Synthetic counted cases.', reason: 'Mocked count of separately listed cases.' }
            : { id: criterion.id, passed: false, evidence: 'Synthetic output does not demonstrate this criterion.', reason: 'Mocked judge verdict for browser flow coverage.' });
          return Response.json({ model: body.model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ checks }) } }] });
        }
        if (!['https://api.testcraft.app', 'https://openai-api-proxy-dev-rtu664353a-uc.a.run.app', 'http://127.0.0.1:8080'].some(base => ['/api/generate-ideas', '/api/automate-tests', '/api/automate-tests-ideas'].some(path => url === base + path))) throw new Error('Browser tests must not contact real providers.');
        generationCalls.push({ url, body: JSON.parse(options.body) });
        return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: generationOutput }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    try { await use(app); }
    finally { await app.shutdown(); }
  },
  baseURL: async ({ browserApp }, use) => { await use(`http://127.0.0.1:${browserApp.server.address().port}`); },
});
export { expect };

export async function selectGenerationModels(page, models) {
  const toggle = page.locator('#generation-model-toggle');
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
  for (const model of models) await expect(page.locator('#generation-model-options input[value="' + model + '"]')).toBeVisible();
  for (const checkbox of await page.locator('#generation-model-options input').all()) await checkbox.setChecked(models.includes(await checkbox.inputValue()));
  await toggle.click();
}

export async function openRunCreator(page) {
  await page.getByRole('tab', { name: /^Runs/ }).click();
  await page.locator('#create-run').click();
  await selectGenerationModels(page, ['gpt-4o-mini']);
}
export async function createSelectedRun(page) {
  await page.locator('#submit-create-run').click();
  await expect(page.locator('#create-run-dialog')).toBeHidden();
}
