import { test as base, expect } from '@playwright/test';
import { once } from 'node:events';
import { createApp } from '../server.mjs';

// Each test gets real HTTP/session/database behavior with its own app instance.
// This avoids sharing rate-limit state or weakening production's session limits.
export const test = base.extend({
  generationOutput: ['Generated ideas: valid credentials; invalid email; empty password.', { option: true }],
  generationCalls: async ({}, use) => { await use([]); },
  browserApp: async ({ generationOutput, generationCalls }, use) => {
    const app = createApp({
      dbPath: ':memory:',
      env: { NODE_ENV: 'test', WORKSHOP_ID: 'browser-tests', OPENAI_API_KEY: '', TESTCRAFT_OPENAI_API_KEY: '' },
      fetchImpl: async (url, options) => {
        if (url.endsWith('/api/models')) return Response.json({ models: ['gpt-4o-mini', 'gpt-4o', 'o3-mini'].map(id => ({ id, label: id })) });
        if (url === 'https://api.openai.com/v1/chat/completions') {
          const body = JSON.parse(options.body);
          const context = JSON.parse(body.messages.find(message => message.role === 'user').content);
          const checks = context.criteria.map(criterion => ({ id: criterion.id, passed: false, evidence: 'Synthetic output does not demonstrate this criterion.', reason: 'Mocked judge verdict for browser flow coverage.' }));
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

export async function openRunCreator(page) {
  await page.getByRole('tab', { name: /^Runs/ }).click();
  await page.locator('#create-run').click();
  await page.locator('#create-generation-model').selectOption('gpt-4o-mini');
}
export async function createSelectedRun(page) {
  await page.locator('#submit-create-run').click();
  await expect(page.locator('#create-run-dialog')).toBeHidden();
}
