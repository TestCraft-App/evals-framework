import { test as base, expect } from '@playwright/test';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { workshopSuite } from './fixtures/pasted-grader-cases.mjs';

const evidence = 'The code has no field entry or submission for any of the requested login scenarios.';
const reason = 'Navigation and an assertion on true do not verify a login outcome.';
const test = base.extend({
  graderReply: [{ id: 'c1', passed: false, evidence, reason }, { option: true }],
  baseURL: async ({ graderReply }, use) => {
    const app = createApp({
      dbPath: ':memory:',
      env: { NODE_ENV: 'test', WORKSHOP_ID: 'grader-browser-tests', WORKSHOP_MAX_MODEL_CALLS: '1', OPENAI_API_KEY: 'browser-test-only' },
      fetchImpl: async (url, options) => {
        if (url !== 'https://api.openai.com/v1/chat/completions') throw new Error('Unexpected provider request');
        const request = JSON.parse(options.body);
        if (!request.response_format?.json_schema.strict) throw new Error('Expected strict grading');
        return Response.json({ model: 'mock-judge', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ checks: [graderReply] }) } }] });
      },
    });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    try { await use(`http://127.0.0.1:${app.server.address().port}`); }
    finally { await app.shutdown(); }
  },
});

async function runExample(page, caseNumber = '04') {
  await page.goto('/');
  await expect(page.locator('#workspace')).toBeVisible();
  const session = await (await page.request.get('/api/session')).json();
  const headers = { origin: new URL(page.url()).origin, 'x-csrf-token': session.csrfToken };
  const example = workshopSuite.evaluations.find(item => item.name.startsWith(caseNumber));
  const created = await page.request.post('/api/evaluations', { headers, data: example });
  expect(created.status()).toBe(201);
  await page.reload();
  await page.getByRole('checkbox', { name: 'Select ' + example.name, exact: true }).check();
  await page.getByRole('button', { name: 'Run selected', exact: false }).click();
  await expect(page.locator('.result-body .badge').first()).toHaveText(/^(Passed|Failed|Error)$/);
}

test('a justified model Fail displays its evidence and remains distinct from a grading error', async ({ page }) => {
  await runExample(page);
  await expect(page.locator('.result-body .badge').first()).toHaveText('Failed');
  await expect(page.locator('.result-score')).toContainText('0 / 100');
  await expect(page.locator('.check .badge')).toHaveText('Fail');
  await expect(page.locator('.check blockquote')).toHaveText(evidence);
  await expect(page.locator('.check')).toContainText(reason);
  await expect(page.locator('#run-detail [role="alert"]')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.check blockquote')).toHaveText(evidence);
  const session = await (await page.request.get('/api/session')).json();
  expect(session.budget.used).toBe(1);
});

test.describe('provider violates the nonempty-evidence contract', () => {
  test.use({ graderReply: { id: 'c1', passed: false, evidence: '', reason: 'PRIVATE_REJECTED_PROVIDER_TEXT' } });
  test('shows a persisted field-specific error, no numeric grade, and no automatic extra call', async ({ page }) => {
    await runExample(page);
    await expect(page.locator('.result-body .badge').first()).toHaveText('Error');
    await expect(page.locator('#run-detail [role="alert"]')).toContainText('empty evidence for criterion c1');
    await expect(page.locator('.result-score')).toHaveText('—');
    await expect(page.locator('.check')).toHaveCount(0);
    await expect(page.locator('#run-detail')).not.toContainText('PRIVATE_REJECTED_PROVIDER_TEXT');
    await page.reload();
    await expect(page.locator('#run-detail [role="alert"]')).toContainText('empty evidence for criterion c1');
    const session = await (await page.request.get('/api/session')).json();
    expect(session.budget.used).toBe(1);
    expect(session.budget.reserved).toBe(0);
  });
});

test.describe('passing source-line citations', () => {
  const strong = workshopSuite.evaluations.find(item => item.name.startsWith('06'));
  const outputLines = strong.actualOutput.split('\n');
  const line = outputLines.findIndex(text => text.includes('toHaveURL')) + 1;
  test.use({ graderReply: { id: 'c3', passed: true, evidence: [line], reason: 'Mocked positive verdict for source-extraction UI coverage.' } });
  test('displays the original source text and persists its line references', async ({ page }) => {
    expect(line).toBeGreaterThan(0);
    await runExample(page, '06');
    await expect(page.locator('.result-score')).toContainText('100');
    await expect(page.locator('.check').last().locator('blockquote')).toHaveText(`L${line}: ${outputLines[line - 1]}`);
    await page.reload();
    await expect(page.locator('.check').last().locator('blockquote')).toHaveText(`L${line}: ${outputLines[line - 1]}`);
    const runId = new URL(page.url()).hash.split('/')[1];
    const run = await (await page.request.get('/api/runs/' + runId)).json();
    expect(run.items[0].checks[2].evidenceLines).toEqual([line]);
    expect(run.items[0].checks[2].evidenceSource).toBe('output_lines');
  });
});
