// Test-only regression fixtures for historical pasted runs. Never import these
// answers into the app's runtime workshop dataset or creation form.
// All HTML and outputs are synthetic, simplified examples
// inspired by SauceDemo, never captured TestCraft responses or live page HTML.
// The page URL is context only; these fixtures are not an executable application.
const pageUrl = 'https://www.saucedemo.com/';
const html = `<!doctype html>
<!-- Synthetic, simplified fixture inspired by SauceDemo; not live HTML.
     Templates illustrate alternate states, not a working login implementation. -->
<html lang="en">
  <head><title>Synthetic SauceDemo workshop fixture</title></head>
  <body>
    <form aria-label="Login">
      <label for="user-name">Username</label>
      <input id="user-name" name="username" type="text">
      <label for="password">Password</label>
      <input id="password" name="password" type="password">
      <button type="submit">Login</button>
    </form>
    <template data-workshop-state="success" data-example-path="/inventory.html">
      <h1>Products</h1>
    </template>
    <template data-workshop-state="invalid-password">
      <p role="alert">Invalid credentials (synthetic).</p>
    </template>
    <template data-workshop-state="missing-password">
      <p role="alert">Password is required (synthetic).</p>
    </template>
  </body>
</html>`;

const ideasTask = 'Synthetic, simplified SauceDemo-inspired task: propose successful login, invalid password, and missing password scenarios, each with actions and an expected result. The illustrated success state uses /inventory.html and a Products heading; the other templates specify error text. Treat these as workshop assumptions, not verified live behavior.';
const codeTask = 'Synthetic, simplified SauceDemo-inspired task: write Playwright TypeScript tests for successful login, invalid password, and missing password. Use the supplied controls and illustrated alternate states. Assume workshop_user / workshop_password succeeds; wrong_password is invalid. These are fictional credentials. Assert the success URL and Products heading, or the appropriate visible error. The HTML has no runtime; this exercise reviews code as text and does not run it against the page URL.';

const completeIdeas = `Synthetic, simplified example inspired by SauceDemo; not captured TestCraft output.
1. With valid credentials (workshop_user / workshop_password), fill Username and Password and click Login; expect /inventory.html and a visible Products heading.
2. With an invalid password (wrong_password), fill both fields and click Login; expect a visible alert reading "Invalid credentials (synthetic).".
3. With a missing password, fill Username, leave Password empty and click Login; expect a visible alert reading "Password is required (synthetic).".`;

const incompleteIdeas = `Synthetic, simplified example inspired by SauceDemo; not captured TestCraft output.
1. With valid credentials (workshop_user / workshop_password), fill Username and Password and click Login; expect /inventory.html and a visible Products heading.`;

const weakCode = `// Synthetic, simplified example inspired by SauceDemo; not captured TestCraft output.
// Checklist words only: getByRole toHaveURL toBeVisible
import { test, expect } from '@playwright/test';

test('login placeholder', async ({ page }) => {
  await page.goto('https://www.saucedemo.com/');
  expect(true).toBe(true);
});`;

const strongCode = `// Synthetic, simplified example inspired by SauceDemo; not captured TestCraft output.
// Fictional credentials and alternate states; this code has not been executed.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('https://www.saucedemo.com/');
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill('workshop_user');
});

test('successful login', async ({ page }) => {
  await page.getByLabel('Password', { exact: true }).fill('workshop_password');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page).toHaveURL('https://www.saucedemo.com/inventory.html');
  await expect(page.getByRole('heading', { name: 'Products', exact: true })).toBeVisible();
});

test('invalid password', async ({ page }) => {
  await page.getByLabel('Password', { exact: true }).fill('wrong_password');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText('Invalid credentials (synthetic).');
});

test('missing password', async ({ page }) => {
  await page.getByLabel('Password', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Login', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText('Password is required (synthetic).');
});`;

const semanticCriterion = 'The code implements all three requested login scenarios with executable field entry and submission, and meaningful awaited assertions for the illustrated success URL and heading or the appropriate visible error. Selectors must be supported by the supplied synthetic fixture. Comments listing API names, navigation alone, and assertions on constants do not establish these behaviors. Assess the code as an artifact; do not claim it ran or that the live site matches the fixture.';

// Named, plain-data export for the server's suite loader. Validation supplies
// schemaVersion 3, the evaluation family, and the fixed passing threshold.
export const workshopSuite = {
  name: 'SauceDemo · Workshop',
  evaluations: [
    {
      name: '01 · Ideas baseline · complete coverage',
      type: 'ideas', framework: '', language: '', source: 'pasted', method: 'contains',
      model: '', judgeModel: '', pageUrl, pom: false, fromIdeas: false, ideas: '',
      input: ideasTask, html, actualOutput: completeIdeas,
      criteria: [
        { text: 'valid credentials', method: 'contains', weight: 1 },
        { text: 'invalid password', method: 'contains', weight: 1 },
        { text: 'missing password', method: 'contains', weight: 1 },
      ],
    },
    {
      name: '02 · Ideas baseline · incomplete coverage',
      type: 'ideas', framework: '', language: '', source: 'pasted', method: 'contains',
      model: '', judgeModel: '', pageUrl, pom: false, fromIdeas: false, ideas: '',
      input: ideasTask, html, actualOutput: incompleteIdeas,
      criteria: [
        { text: 'valid credentials', method: 'contains', weight: 1 },
        { text: 'invalid password', method: 'contains', weight: 1 },
        { text: 'missing password', method: 'contains', weight: 1 },
      ],
    },
    {
      name: '03 · Code · keyword false positive',
      type: 'code', framework: 'playwright', language: 'typescript', source: 'pasted', method: 'contains',
      model: '', judgeModel: '', pageUrl, pom: false, fromIdeas: false, ideas: '',
      input: codeTask, html, actualOutput: weakCode,
      criteria: [
        { text: 'getByRole', method: 'contains', weight: 1 },
        { text: 'toHaveURL', method: 'contains', weight: 1 },
        { text: 'toBeVisible', method: 'contains', weight: 1 },
      ],
    },
    {
      name: '04 · Code · judge the same weak output',
      type: 'code', framework: 'playwright', language: 'typescript', source: 'pasted', method: 'model_grade',
      model: '', judgeModel: 'gpt-4o-mini', pageUrl, pom: false, fromIdeas: false, ideas: '',
      input: codeTask, html, actualOutput: weakCode,
      criteria: [
        { text: semanticCriterion, method: 'model_grade', weight: 1 },
      ],
    },
    {
      name: '05 · Code · forbidden fragments',
      type: 'code', framework: 'playwright', language: 'typescript', source: 'pasted', method: 'not_contains',
      model: '', judgeModel: '', pageUrl, pom: false, fromIdeas: false, ideas: '',
      input: codeTask, html, actualOutput: strongCode,
      criteria: [
        { text: 'waitForTimeout', method: 'not_contains', weight: 1 },
        { text: 'TODO', method: 'not_contains', weight: 1 },
      ],
    },
    {
      name: '06 · Code · hybrid strong candidate',
      type: 'code', framework: 'playwright', language: 'typescript', source: 'pasted', method: 'hybrid',
      model: '', judgeModel: 'gpt-4o-mini', pageUrl, pom: false, fromIdeas: false, ideas: '',
      input: codeTask, html, actualOutput: strongCode,
      criteria: [
        { text: 'getByRole', method: 'contains', weight: 10 },
        { text: 'toBeVisible', method: 'contains', weight: 10 },
        { text: semanticCriterion, method: 'model_grade', weight: 80 },
      ],
    },
    {
      name: '07 · Code · hybrid weak candidate',
      type: 'code', framework: 'playwright', language: 'typescript', source: 'pasted', method: 'hybrid',
      model: '', judgeModel: 'gpt-4o-mini', pageUrl, pom: false, fromIdeas: false, ideas: '',
      input: codeTask, html, actualOutput: weakCode,
      criteria: [
        { text: 'getByRole', method: 'contains', weight: 10 },
        { text: 'toBeVisible', method: 'contains', weight: 10 },
        { text: semanticCriterion, method: 'model_grade', weight: 80 },
      ],
    },
    {
      name: '08 · Fixed label · exact match limits',
      type: 'ideas', framework: '', language: '', source: 'pasted', method: 'exact_match',
      model: '', judgeModel: '', pageUrl, pom: false, fromIdeas: false, ideas: '',
      input: 'Synthetic, simplified SauceDemo-inspired formatting exercise: return only the fixed workshop label SYNTHETIC_SAUCEDEMO_LOGIN. This invented label is not captured TestCraft output and is not a normal free-form test idea.',
      html, actualOutput: 'SYNTHETIC_SAUCEDEMO_LOGIN',
      criteria: [
        { text: 'SYNTHETIC_SAUCEDEMO_LOGIN', method: 'exact_match', weight: 1 },
      ],
    },
  ],
};
