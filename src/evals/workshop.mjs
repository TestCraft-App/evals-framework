// Input-only teaching templates. Run sends this HTML to TestCraft; responses and
// grading results belong to runs and are never preloaded in this runtime fixture.
const pageUrl = 'https://www.saucedemo.com';
const html = `<!doctype html>
<!-- Synthetic, simplified fixture inspired by SauceDemo; not live HTML.
     These templates illustrate alternate states, not a working application.
     Fictional workshop_user / workshop_password succeeds; wrong_password fails.
     A missing password illustrates the required-password error below. -->
<html lang="en">
  <head><title>Synthetic SauceDemo workshop fixture</title></head>
  <body>
    <form aria-label="Login">
      <label for="user-name">Username</label>
      <input id="user-name" name="username" data-test="username" type="text">
      <label for="password">Password</label>
      <input id="password" name="password" data-test="password" type="password">
      <button data-test="login-button" type="submit">Login</button>
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

// Descriptions are grader context, not TestCraft generator prompts. The v1
// routes receive HTML and code settings; only fromIdeas also sends selected ideas.
const ideasContext = 'Grader context for synthetic, simplified SauceDemo-inspired HTML: review generated login ideas for grounded actions, successful login, invalid password, and missing password coverage with observable expected results. Credentials and alternate states in the HTML are fictional workshop assumptions. This description is not sent to TestCraft; changing it does not direct generation.';
const codeContext = 'Grader context for synthetic, simplified SauceDemo-inspired HTML: review generated Playwright TypeScript code against the supplied controls and illustrated states. Fictional credentials and success/error behavior are specified in the HTML. Assess code as text; no generated test is executed and the page URL is not verified against this fixture. This description is not sent to TestCraft; HTML and, when enabled, selected ideas direct generation.';
const selectedIdeas = [
  'Test successful login with workshop_user / workshop_password: fill Username and Password, submit Login, and assert /inventory.html and a visible Products heading.',
  'Test an invalid password with workshop_user / wrong_password: submit Login and assert a visible alert with Invalid credentials (synthetic).',
  'Test a missing password: fill Username with workshop_user, leave Password empty, submit Login, and assert a visible alert with Password is required (synthetic).',
].join('\n');

// Validation supplies schemaVersion 3, the evaluation family, and the fixed
// passing threshold. These definitions follow the same save/run flow as manual input.
export const workshopSuite = {
  name: 'SauceDemo · TestCraft workshop',
  evaluations: [
    {
      name: '01 · Ideas · login controls',
      type: 'ideas', framework: '', language: '', source: 'testcraft_api', method: 'contains',
      model: '', judgeModel: '', pageUrl, pom: false, fromIdeas: false, ideas: '',
      input: ideasContext, html,
      criteria: [
        { text: 'Username', method: 'contains', weight: 1 },
        { text: 'Password', method: 'contains', weight: 1 },
        { text: 'Login', method: 'contains', weight: 1 },
      ],
    },
    {
      name: '02 · Ideas · error states',
      type: 'ideas', framework: '', language: '', source: 'testcraft_api', method: 'contains',
      model: '', judgeModel: '', pageUrl, pom: false, fromIdeas: false, ideas: '',
      input: ideasContext, html,
      criteria: [
        { text: 'Invalid credentials', method: 'contains', weight: 1 },
        { text: 'Password is required', method: 'contains', weight: 1 },
      ],
    },
    {
      name: '03 · Code · Playwright structure',
      type: 'code', framework: 'playwright', language: 'typescript', source: 'testcraft_api', method: 'contains',
      model: '', judgeModel: '', pageUrl, pom: false, fromIdeas: false, ideas: '',
      input: codeContext, html,
      criteria: [
        { text: '@playwright/test', method: 'contains', weight: 1 },
        { text: 'page.goto(', method: 'contains', weight: 1 },
        { text: 'expect(', method: 'contains', weight: 1 },
      ],
    },
    {
      name: '04 · Code · behavior review',
      type: 'code', framework: 'playwright', language: 'typescript', source: 'testcraft_api', method: 'model_grade',
      model: '', judgeModel: 'gpt-4o-mini', pageUrl, pom: false, fromIdeas: false, ideas: '',
      input: codeContext, html,
      criteria: [
        { text: 'Login tests contain executable field entry and submission using selectors supported by the supplied HTML. Comments, navigation alone, or invented controls do not establish the behavior.', method: 'model_grade', weight: 1 },
        { text: 'Implemented login scenarios contain meaningful awaited assertions for the illustrated success URL and Products heading or the relevant visible error. Assertions on constants and claims that the live site was tested do not establish these outcomes.', method: 'model_grade', weight: 1 },
      ],
    },
    {
      name: '05 · Code · waiting and placeholders',
      type: 'code', framework: 'playwright', language: 'typescript', source: 'testcraft_api', method: 'not_contains',
      model: '', judgeModel: '', pageUrl, pom: false, fromIdeas: false, ideas: '',
      input: codeContext, html,
      criteria: [
        { text: 'waitForTimeout', method: 'not_contains', weight: 1 },
        { text: 'TODO', method: 'not_contains', weight: 1 },
      ],
    },
    {
      name: '06 · Code · selected login scenarios',
      type: 'code', framework: 'playwright', language: 'typescript', source: 'testcraft_api', method: 'hybrid',
      model: '', judgeModel: 'gpt-4o-mini', pageUrl, pom: false, fromIdeas: true, ideas: selectedIdeas,
      input: codeContext, html,
      criteria: [
        { text: '@playwright/test', method: 'contains', weight: 10 },
        { text: 'waitForTimeout', method: 'not_contains', weight: 10 },
        { text: 'The code implements all three selected login ideas with executable field entry and submission, HTML-supported selectors, and meaningful awaited assertions for the success URL and heading or the appropriate visible error. Comments listing scenarios or API names are insufficient. Evaluate the artifact without claiming execution or verified live behavior.', method: 'model_grade', weight: 80 },
      ],
    },
    {
      name: '07 · Ideas · grounded coverage',
      type: 'ideas', framework: '', language: '', source: 'testcraft_api', method: 'hybrid',
      model: '', judgeModel: 'gpt-4o-mini', pageUrl, pom: false, fromIdeas: false, ideas: '',
      input: ideasContext, html,
      criteria: [
        { text: 'CAPTCHA', method: 'not_contains', weight: 20 },
        { text: 'The ideas cover successful login, an invalid password, and a missing password as distinct scenarios, each with concrete actions and an observable expected outcome grounded in the supplied HTML and its illustrated states. Do not treat invented controls or unsupported authentication features as existing behavior.', method: 'model_grade', weight: 80 },
      ],
    },
    {
      name: '08 · Code · page object structure',
      type: 'code', framework: 'playwright', language: 'typescript', source: 'testcraft_api', method: 'contains',
      model: '', judgeModel: '', pageUrl, pom: true, fromIdeas: true, ideas: selectedIdeas,
      input: `${codeContext} Page Object Model is enabled; literal structure checks are only a starting point for reviewing reuse and behavior.`, html,
      criteria: [
        { text: 'class', method: 'contains', weight: 1 },
        { text: '@playwright/test', method: 'contains', weight: 1 },
        { text: 'expect(', method: 'contains', weight: 1 },
      ],
    },
  ],
};
