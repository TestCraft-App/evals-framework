# TestCraft Evals · Workshop brief

## Current direction

TestCraft's browser extension is the application being evaluated. This project saves evaluation datasets, calls the extension's v1 backend, and grades generated ideas or automation code. The previous generator/simulated-runner concept is superseded. No simulated browser run is used as evidence.

## Participant flow

1. Inspect a UI with TestCraft and obtain its selected HTML.
2. Open New evaluation. Step 1: choose the TestCraft endpoint and parameters, then provide a name, optional test description, HTML, and page URL. Framework/language apply only to code.
3. Choose Next. Step 2: select the evaluation method and, for Model grade, a model from the dropdown. Add observable criteria one by one before seeing a new generation. No reference response or configurable percentage is required.
4. Save the case; repeat to build a dataset.
5. Select cases and run them. The backend generates through TestCraft and applies the grader.
6. Inspect actual output against the criteria, scores, evidence, and errors in Runs or in a separate browser tab.
7. Save a revised copy or rerun a case; compare historical snapshots without overwriting evidence.

## Exercises

- **Credential-free baseline:** Load example uses synthetic pasted output and three Contains checks. Remove a phrase in a revised case and observe the computed score decrease.
- **Text match versus quality:** a candidate can include required words but still be poor. Compare Contains to an explicit Model grade rubric.
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

One local installation is one shared SQLite workspace. Generated-code execution, sandboxed browsers, extension UI automation, automatic DOM extraction, participant accounts, hosting, and GitHub publishing are not included. Each requires separate scope and security decisions.
