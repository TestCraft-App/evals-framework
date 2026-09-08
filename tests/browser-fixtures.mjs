import { test as base, expect } from '@playwright/test';
import { once } from 'node:events';
import { createApp } from '../server.mjs';

// Each test gets real HTTP/session/database behavior with its own app instance.
// This avoids sharing rate-limit state or weakening production's session limits.
export const test = base.extend({
  generationOutput: ['Generated ideas: valid credentials; invalid email; empty password.', { option: true }],
  generationCalls: async ({}, use) => { await use([]); },
  baseURL: async ({ generationOutput, generationCalls }, use) => {
    const app = createApp({
      dbPath: ':memory:',
      env: { NODE_ENV: 'test', WORKSHOP_ID: 'browser-tests', WORKSHOP_MAX_MODEL_CALLS: '200', OPENAI_API_KEY: '', TESTCRAFT_OPENAI_API_KEY: '' },
      fetchImpl: async (url, options) => {
        if (!['/api/generate-ideas', '/api/automate-tests', '/api/automate-tests-ideas'].some(path => url === 'https://api.testcraft.app' + path)) throw new Error('Browser tests must not contact real providers.');
        generationCalls.push({ url, body: JSON.parse(options.body) });
        return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: generationOutput }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    try { await use(`http://127.0.0.1:${app.server.address().port}`); }
    finally { await app.shutdown(); }
  },
});
export { expect };
