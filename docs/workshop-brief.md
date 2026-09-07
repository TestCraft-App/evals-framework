# TestCraft Evals · Workshop brief

## Current direction

TestCraft's browser extension is the application being evaluated. This project saves evaluation datasets, calls the extension's v1 backend, and grades generated ideas or automation code. The previous generator/simulated-runner concept is superseded. No simulated browser run is used as evidence.

## Participant flow

1. Inspect a UI with TestCraft and obtain its selected HTML.
2. Open New evaluation; choose generation type, language, framework, and method.
3. Define input/test intent and expected output before seeing a new generation. For Model grade, write observable criteria.
4. Save the case; repeat to build a dataset.
5. Select cases and run them. The backend generates through TestCraft and applies the grader.
6. Inspect actual versus expected output, scores, evidence, and errors in Runs or in a separate browser tab.
7. Save a revised copy or rerun a case; compare historical snapshots without overwriting evidence.

## Exercises

- **Credential-free baseline:** Load example uses synthetic pasted output and three Contains checks. Remove a phrase in a revised case and observe the computed score decrease.
- **Text match versus quality:** a candidate can include required words but still be poor. Compare Contains to an explicit Model grade rubric.
- **Ideas coverage:** grade positive, negative, and boundary coverage of a login form. v1's ideas route consumes HTML; the separate intent is judge context.
- **Code quality:** assess grounded selectors, meaningful assertions, and waiting in a selected framework/language. These are artifact checks, not runtime results.
- **Code from ideas:** enable the selected-ideas option and enter one idea per input line for the automate-tests-ideas endpoint.
- **Error versus failure:** missing credentials or a failed provider call means Error and no score, not a failed quality check.
- **Prompt injection:** use synthetic hostile HTML/output to study judge robustness. Never use real secrets or execute the generated code.

## Rubric example

One criterion per line; all criteria have equal weight:

```text
The output covers successful login with concrete expected behavior.
The output covers invalid email and missing password cases.
The output references only controls supported by the supplied HTML.
Each generated test includes meaningful assertions, not only navigation.
```

Choose criteria for the generation type. The judge is not ground truth: compare evidence to human review and repeat runs to study variability.

## Setup and boundaries

Use synthetic HTML fixtures, reference outputs, a working TestCraft API, and separate judge credentials supporting strict JSON-schema output. Verify a live generation and judge run with the workshop accounts before presenting; automated tests use mocks and cannot verify quota or availability.

One local installation is one shared SQLite workspace. Generated-code execution, sandboxed browsers, extension UI automation, automatic DOM extraction, participant accounts, hosting, and GitHub publishing are not included. Each requires separate scope and security decisions.
