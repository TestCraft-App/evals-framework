import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dataDir = mkdtempSync(join(tmpdir(), 'testcraft-e2e-'));
export default defineConfig({
  testDir: './tests', testMatch: '**/generator.spec.js', workers: 1, timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:3107', ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
  webServer: {
    command: 'node server.mjs', url: 'http://127.0.0.1:3107/api/config', reuseExistingServer: false,
    env: { PORT: '3107', HOST: '127.0.0.1', TESTCRAFT_EVALS_DB: join(dataDir, 'evals.sqlite'), OPENAI_API_KEY: '', TESTCRAFT_OPENAI_API_KEY: '' },
  },
});
