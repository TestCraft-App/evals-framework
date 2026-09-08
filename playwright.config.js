import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: '**/*.spec.js', workers: 1, timeout: 30000,
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure' },
});
