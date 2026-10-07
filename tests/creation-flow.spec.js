import { workshopSuites } from '../src/evals/workshop.mjs';
import { test, expect, openRunCreator, createSelectedRun } from './browser-fixtures.mjs';

// Template loaders are admin actions in the shared TestCraft workspace.
test.use({ initialWorkspace: 'main' });

const workshopCount = workshopSuites.reduce((sum, suite) => sum + suite.evaluations.length, 0);

test.beforeEach(async ({ page }) => {
  await page.route('**/api/models', route => route.fulfill({ json: { source: 'testcraft', warning: null, models: [{ id: 'gpt-4o-mini', label: 'GPT-4o mini', graderCompatible: true }] } }));
  await page.goto('/');
  await expect(page.locator('#workspace')).toBeVisible();
});

async function save(page) {
  const pending = page.waitForResponse(r => r.url().endsWith('/api/workspaces/main/evaluations') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Create evaluation', exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(201);
  return { payload: response.request().postDataJSON(), saved: await response.json() };
}
async function auth(page) {
  const session = await (await page.request.get('/api/session')).json();
  return { origin: new URL(page.url()).origin, 'x-csrf-token': session.csrfToken };
}

test('Load example and manual creation submit the same input-only contract and generate only on Run', async ({ page, generationCalls }) => {
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Load example', exact: true }).click();
  await expect(page.locator('#source, #model, #judge-model')).toHaveCount(0);
  await expect(page.locator('#actual-output, #actual-field, #source option[value="pasted"]')).toHaveCount(0);
  const inputs = {};
  for (const id of ['name', 'html']) inputs[id] = await page.locator('#' + id).inputValue();
  await page.getByRole('button', { name: 'Next', exact: false }).click();
  const loaded = await save(page);
  expect(loaded.payload).not.toHaveProperty('actualOutput');
  expect(loaded.payload).not.toHaveProperty('expectedOutput');
  expect(loaded.saved.source).toBe('testcraft_api');
  expect(loaded.saved.actualOutput).toBe('');
  expect(generationCalls).toHaveLength(0);
  await page.getByRole('button', { name: 'New evaluation', exact: false }).click();
  for (const [id, value] of Object.entries(inputs)) await page.locator('#' + id).fill(id === 'name' ? value + ' manual' : value);
  await page.getByRole('button', { name: 'Next', exact: false }).click();
  await page.locator('#method').selectOption('rule_based');
  for (const criterion of loaded.payload.criteria) {
    await page.getByLabel('New criterion', { exact: true }).fill(criterion.text);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
  }
  const manual = await save(page);
  expect({ ...manual.payload, name: loaded.payload.name }).toEqual(loaded.payload);
  expect(generationCalls).toHaveLength(0);
  await openRunCreator(page);
  await page.getByRole('checkbox', { name: 'Select ' + inputs.name, exact: true }).check();
  await createSelectedRun(page);
  await expect(page.locator('.result-score')).toContainText('1.00');
  expect(generationCalls).toHaveLength(1);
  expect(generationCalls[0].url).toBe('https://openai-api-proxy-dev-rtu664353a-uc.a.run.app/api/generate-ideas');
  expect(generationCalls[0].body.sourceCode).toBe(inputs.html);
  expect(generationCalls[0].body).not.toHaveProperty('criteria');
  expect(generationCalls[0].body).not.toHaveProperty('actualOutput');
  await expect(page.locator('.detail-eval-row')).toContainText('Graded');
});

test('workshop templates have no supplied output and use the same editor and generation path', async ({ page, generationCalls, browserApp }) => {
  browserApp.engine.env.OPENAI_API_KEY = 'mock-judge-key';
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Load Full Suite', exact: true }).click();
  await expect(page.locator('#evaluation-rows tr')).toHaveCount(workshopCount);
  const entries = (await (await page.request.get('/api/workspaces/main/evaluations')).json()).evaluations;
  expect(entries.every(e => e.source === 'testcraft_api' && e.actualOutput === '' && e.latest === null)).toBe(true);
  expect(generationCalls).toHaveLength(0);
  const example = entries.find(e => e.name.startsWith('IDEAS-1 '));
  await page.getByRole('button', { name: example.name, exact: true }).click();
  await expect(page.locator('#source, #model, #judge-model')).toHaveCount(0);
  await expect(page.locator('#actual-output, #actual-field')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await openRunCreator(page);
  await page.getByRole('checkbox', { name: 'Select ' + example.name, exact: true }).check();
  await createSelectedRun(page);
  await expect(page.locator('.detail-eval-row .badge').first()).toHaveText(/^Graded$/);
  expect(generationCalls).toHaveLength(1);
  expect(generationCalls[0].body.sourceCode).toBe(example.html);
  await page.locator('.detail-expand').click();
  await page.getByText('Inspect generated output', { exact: true }).click();
  await expect(page.locator('.saved-output')).toContainText('Generated ideas:');
});

test('editing an older pasted case switches to generation on save and preserves its saved snapshot', async ({ page, generationCalls, browserApp }) => {
  const headers = await auth(page);
  const legacy = { name: 'Older pasted example', type: 'ideas', source: 'pasted', method: 'contains', html: '<button>Login</button>', actualOutput: 'OLD SUPPLIED RESPONSE', criteria: ['OLD'], judgeModel: '' };
  const saved = await (await page.request.post('/api/workspaces/main/evaluations', { headers, data: legacy })).json();
  const run = { id: 'historical-pasted', status: 'completed', createdAt: '2025-01-01T00:00:00Z', items: [{ id: 'old-item', evaluationId: saved.id, evaluation: saved, status: 'passed', score: 100, output: legacy.actualOutput, checks: [], events: [] }] };
  browserApp.store.saveRun(run, { ownerId: browserApp.store.db.prepare("SELECT id FROM workspaces WHERE kind='main'").get().id, workshopId: 'browser-tests' });
  await page.reload();
  await page.getByRole('button', { name: legacy.name, exact: true }).click();
  await expect(page.locator('#actual-output, #actual-field')).toHaveCount(0);
  await expect(page.locator('#evaluation-dialog')).not.toContainText(legacy.actualOutput);
  await expect(page.locator('#source-hint, #input')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await (await page.request.get('/api/workspaces/main/evaluations/' + saved.id)).json()).source).toBe('pasted');
  await page.getByRole('button', { name: legacy.name, exact: true }).click();
  await page.getByRole('button', { name: 'Next', exact: false }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#evaluation-dialog')).not.toBeVisible();
  const updated = await (await page.request.get('/api/workspaces/main/evaluations/' + saved.id)).json();
  expect(updated.source).toBe('testcraft_api'); expect(updated.actualOutput).toBe('');
  const snapshot = await (await page.request.get('/api/workspaces/main/runs/' + run.id)).json();
  expect(snapshot.items[0].evaluation.source).toBe('pasted');
  expect(snapshot.items[0].evaluation.actualOutput).toBe(legacy.actualOutput);
  expect(generationCalls).toHaveLength(0);
});
