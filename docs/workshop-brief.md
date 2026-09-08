# TestCraft Evals · Workshop brief

## Current direction

TestCraft's browser extension is the application being evaluated. This project saves evaluation datasets, calls the extension's v1 backend, and grades generated ideas or automation code. The previous generator/simulated-runner concept is superseded. No simulated browser run is used as evidence.

## Participant flow

1. Inspect a UI with TestCraft and obtain its selected HTML.
2. Open New evaluation. Step 1: choose the TestCraft endpoint and parameters, then provide a name, optional test description, HTML, and page URL. Framework/language apply only to code.
3. Choose Next. Step 2: choose the evaluation family and concrete method. Rule-based offers Contains, Does not contain and Exact match; Model-based offers LLM as a judge, with a model dropdown. Add literal fragments for rules or observable quality criteria for the judge. Each method preserves its own draft while editing. No separate reference-response field or configurable percentage is required.
4. Save the case; repeat to build a dataset.
5. Select cases and run them. The backend generates through TestCraft and applies the grader.
6. Inspect actual output against the criteria, scores, evidence, and errors on the run's full-page detail or in a separate browser tab. **Back to runs** opens the table: search by date-based name or ID, filter status/model, and sort using column headers. Scores average available evaluation scores; partial coverage is labeled. Active runs update automatically. **Create Run** is a disabled placeholder; use **Run selected** in Evaluations.
7. Save a revised copy or rerun a case; compare historical snapshots without overwriting evidence.
8. Optional cleanup: use a finished run's delete icon in the table or **Delete run** in detail, then confirm. This permanently removes that run's evidence, not its evaluations, and does not restore used model calls. Active runs are protected. Keep runs you still want to compare during the workshop.

## Exercises

- **Credential-free baseline:** Load example uses synthetic pasted output and three Contains checks. Remove a phrase in a revised case and observe the computed score decrease.
- **Text match versus quality:** a candidate can include required words but still be poor. Compare Rule-based → Contains to Model-based → LLM as a judge with an explicit quality rubric. Model-based is the family; LLM-as-a-judge is the implementation used here.
- **Forbidden fragments:** use Does not contain with `waitForTimeout` and `TODO`; inspect the individual checks. Show that comments also match and different spellings may escape a literal check. The overall score is an average, not a guarantee that every criterion passed.
- **Ideas coverage:** grade positive, negative, and boundary coverage of a login form. v1's ideas route consumes HTML; the separate intent is judge context.
- **Code quality:** assess grounded selectors, meaningful assertions, and waiting in a selected framework/language. These are artifact checks, not runtime results.
- **Code from ideas:** enable the selected-ideas option and enter one idea per line in its dedicated field for the automate-tests-ideas endpoint. The test description remains optional evaluator context.
- **Error versus failure:** missing credentials or a failed provider call means Error and no score, not a failed quality check.
- **Prompt injection:** use synthetic hostile HTML/output to study judge robustness. Never use real secrets or execute the generated code.

## Rubric example

Use Add criteria for each item; all criteria have equal weight. The backend stores a list of strings:

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

Use synthetic HTML fixtures, clear criteria, a working TestCraft API, and separate grader credentials supporting strict JSON-schema output. The dropdown loads TestCraft's public catalog through the backend; this does not verify access with your grader account. Verify a live generation and grader run with the workshop accounts before presenting; automated tests use mocks and cannot verify quota or availability. All new runs use a shared 80/100 policy, hidden from the form, to keep the exercise focused on the evaluation criteria.

Participants open the URL and automatically receive a private browser session, without accounts or an access code. Keep the same browser and hostname throughout the workshop; clearing cookies, changing devices or session expiry automatically starts a new empty workspace. The backend enforces ownership, and session cookies expire after 24 hours by default. Anyone with the URL can enter and consume the shared allowance, but cannot read another browser's evaluations or runs through the app.

No workshop access secret is required. The global allowance defaults to 200 model-call attempts: generation and model grading each count as one. Simultaneous batches reserve their calls before starting; restarting or opening another browser does not reset usage. This is not a dollar cap. Pasted output with any Rule-based method remains available without model calls.

AWS hosting still needs HTTPS, APP_ORIGIN, runtime secrets, one Node process and durable SQLite storage. Rehearse with two independent browser profiles and real provider credentials before the event. Generated-code execution, sandboxed browsers, extension UI automation, automatic DOM extraction, participant accounts/cross-device recovery, and hosting are not included in the current implementation.
