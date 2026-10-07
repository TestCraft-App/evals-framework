# TestCraft Evals · Workshop brief

## Current direction

TestCraft's browser extension is the application being evaluated. This project saves evaluation datasets, calls the extension's v1 backend, and grades generated ideas or automation code. The previous generator/simulated-runner concept is superseded. No simulated browser run is used as evidence.

## Participant flow

Open the workshop URL directly or follow a shared link from another site or phone app in your browser. External links can load the public dashboard, where users sign in with GitHub and choose TestCraft or My workspace. Cross-site API access remains blocked.

For a ready-made starting point, collaborators first select **My workspace**; Actions is hidden from them in TestCraft. Use **Actions → Load Basic Suite**: 12 evaluations, two per Full suite, with concise atomic model criteria and local rules. **Load Full Suite** loads the existing 156-evaluation collection. Both loads preserve edits on repeat use and make no provider calls. Run the Basic collection together to check endpoint output quality with 12 generation and 11 judge attempts.

1. Inspect a UI with TestCraft and obtain its selected HTML.
2. Open New evaluation. Step 1: choose the TestCraft endpoint and parameters, then provide a name, optional test description, HTML, and page URL. Framework/language apply only to code.
3. Choose Next. Step 2: choose the evaluation family and concrete method. Rule-based offers Contains, Does not contain and Exact match; Model-based offers LLM as a judge. Choose models later in Create Run. Add literal fragments for rules or observable quality criteria for the judge. Each method preserves its own draft while editing. No separate reference-response field or configurable percentage is required.
4. Save the case; repeat to build a dataset. In Evaluations, search saved definitions and filter by Suite, Endpoint, or Method. Status filtering is available in Runs.
5. Open **Runs → Create Run**. Choose an environment (Dev is the default; Prod and Local are also available) and a generation model, add an optional description below the selectors, then select evaluations using search and Suite/Endpoint/Method filters. Choose a grader if needed. The footer shows only the evals × models = results calculation; existing capacity limits still apply. Create Run generates through TestCraft and applies the grader. Local is available only on a loopback development server.
6. On the run's full-page detail, filter by Suite, Model, Eval method, or score range, and sort any column. The Eval method column and filter use rule-based, model-graded, and hybrid. Expand an evaluation to read its specific rule checks, criterion verdicts, and concise reasons; open **Inspect generated output** beneath them to review the saved response. **Back to runs** opens the table: search by date-based name or ID, filter status/model, and sort using column headers. Scores display from 0.00 to 1.00 and average available evaluation scores; partial coverage is labeled. Red is below 0.50, yellow is 0.50 to below 0.80, and green is 0.80 or above. Criteria met counts passing verdicts independently of weighted scores. Active runs update automatically. Model selections apply to the whole run. Both selectors offer the same TestCraft catalog models. Catalog failures offer an environment-specific cached list or Retry; no successful catalog means creation is blocked.
7. Use the **Rerun** icon beside delete in the Runs table to review a draft with the previous environment, models, description, and available evaluations selected. Missing evaluations are flagged. Choose **Create Run** to generate fresh output using the latest saved definitions and compare historical snapshots without overwriting evidence. Opening or cancelling the draft makes no model calls. Fresh Create Run drafts prefer **GPT-6 Luna** for both generation and grading, then the existing **GPT-5.6 Luna** catalog entry. If neither is available, choose a generation model, and the grader uses the configured default if available.
8. Optional cleanup: use a finished run's delete icon in the table or **Delete run** in detail, then confirm. This permanently removes that run's evidence, not its evaluations, and does not restore used model calls. Active runs are protected. Keep runs you still want to compare during the workshop.

## Exercises

- **Rule-based baseline:** Load example supplies synthetic HTML and three Contains checks. Create a run with TestCraft generation; revise a criterion and compare the next run’s score.
- **Text match versus quality:** a candidate can include required words but still be poor. Compare Rule-based → Contains to Model-based → LLM as a judge with an explicit quality rubric. Model-based is the family; LLM-as-a-judge is the implementation used here.
- **Forbidden fragments:** use Does not contain with `waitForTimeout` and `TODO`; inspect the individual checks. Show that comments also match and different spellings may escape a literal check. The overall score is an average, not a guarantee that every criterion passed.
- **Ideas coverage:** grade positive, negative, and boundary coverage of a login form. v1's ideas route consumes HTML; the separate intent is judge context.
- **Code quality:** assess grounded selectors, meaningful assertions, and waiting in a selected framework/language. These are artifact checks, not runtime results.
- **Code from ideas:** select Automate test ideas and enter one idea per line in its dedicated field.
- **Error versus failure:** missing credentials or a failed provider call means Error and no score, not a failed quality check.
- **Prompt injection:** use synthetic hostile HTML/output to study judge robustness. Never use real secrets or execute the generated code.

## Rubric example

Select Model-graded and use **Add**, to the right of the text field, for each item. All criteria have equal weight; the backend stores objects with text, method, and weight. Example criterion texts:

```json
[
  "The output covers successful login with concrete expected behavior.",
  "The output covers invalid credentials and missing password cases.",
  "The output references only controls supported by the supplied HTML.",
  "Each generated test includes meaningful assertions, not only navigation."
]
```

Choose criteria for the generation type. The judge is not ground truth: compare evidence to human review and repeat runs to study variability.

## Setup and boundaries

Use synthetic HTML fixtures, clear criteria, a working TestCraft API, and separate grader credentials supporting strict JSON-schema output. The dropdown loads TestCraft's public catalog through the backend; this does not verify access with your grader account. Verify a live generation and grader run with the workshop accounts before presenting; automated tests use mocks and cannot verify quota or availability. All new runs use a shared 0.80 displayed passing threshold (80 internally), hidden from the form, to keep the exercise focused on the evaluation criteria.

Participants sign in with GitHub. Any GitHub account can join as a collaborator and view TestCraft's shared library and official runs. Collaborators manage their own My workspace and use the header user menu → **API key** to open a dialog and save their OpenAI key for generation and grading. **Save key** checks authentication through the OpenAI model list without generating output. Invalid keys or unavailable checks leave the dialog open with an error. Cancel or Escape discards edits; **Clear key** prevents reuse for new runs. Create Run has no key field: collaborators need a validated tab key, or see a warning and disabled Create Run. Its **Set API key** button opens the same dialog without losing selections. The check does not guarantee quota, model permissions, or TestCraft availability. The same menu shows the username, **Extension** link, and **Sign out**. Runs of the shared library are also saved privately. Keys stay in tab/job memory and must be entered again after refreshing. Signing in on another device restores the same personal workspace. Sessions expire after 24 hours by default; re-login preserves data. Admins are configured through numeric GitHub IDs and use server credentials.

Configure GitHub OAuth client credentials and an admin allowlist before the workshop. Manage spending through API keys and provider-side budgets; the app does not enforce a call limit. Every new run generates through TestCraft, including legacy pasted definitions; historical evidence remains unchanged.

AWS hosting still needs HTTPS, APP_ORIGIN, runtime secrets, one Node process and durable SQLite storage. Rehearse with two independent browser profiles and real provider credentials before the event. Generated-code execution, sandboxed browsers, extension UI automation, automatic DOM extraction, live-suite copying, promotion requests, and infrastructure provisioning are not included in the current implementation.
