# SauceDemo workshop: generate, evaluate, inspect evidence

One hour, seven people. Goal: distinguish literal checks from quality judgments, inspect variable LLM responses, and improve criteria using evidence.

## One creation and execution flow

**Load example**, **Load workshop suite**, and **New evaluation** use the same input-only flow: HTML and parameters → save definition → Create Run generates through TestCraft → grade the response → inspect the saved run. There is no output-paste field or preloaded answer. Loading or saving makes no model calls or completed runs. Model catalogs preload for enabled environments when the app opens and are reused in Create Run. Reload the page to refresh the lists, or use Retry after a catalog failure. The grader can be selected immediately and is required only for model-based criteria.

Load the suite **SauceDemo · TestCraft workshop**, then open **Runs → Create Run**. Choose an environment and models, select cases, and create the run. Use **Duplicate** or **Save as new** to make evaluation variants. Every rerun generates a fresh response; it does not regrade the previous output.

The supplied HTML is **synthetic, simplified SauceDemo-inspired input**, not captured live HTML or a working login implementation. Credentials, messages, and alternate states are fictional workshop assumptions. The page URL is context; the evaluator does not visit it. Generated code is inspected as text, never executed. No score proves that a test passes on the live site.

## One-hour agenda

| Minutes | Activity |
| --- | --- |
| 0–5 | Identify controls and fictional states in the HTML; agree what a useful login test should demonstrate. |
| 5–15 | Load the suite, run 01 and 02, and compare literal checks with human review of the actual generated ideas. |
| 15–25 | Run 03 and 05. Look for checks satisfied by comments or incidental words, and behaviors that literal checks cannot establish. |
| 25–40 | Run 04, 06, and 07. Expand each evaluation to read model verdicts and concise reasons; inspect generated output and discuss disagreements. |
| 40–55 | Capture relevant HTML from SauceDemo using the approved extension workflow. Create a manual case with that HTML, URL, parameters, and criteria. Run twice and compare outputs and evidence. |
| 55–60 | Share one improved criterion, one misleading score or limitation, and one remaining uncertainty. |

## Eight input-only templates

No template has a promised Pass, Fail, or score. Contains and Does not contain are case-sensitive text checks; semantically equivalent wording can change their results.

| Case | What to inspect | Model-call attempts per run |
| --- | --- | --- |
| 01 · Ideas · login controls | Do literal Username, Password, and Login fragments occur? Does their presence establish useful coverage? | 1 generation |
| 02 · Ideas · error states | Are the illustrated error messages present? Inspect whether matching words actually describe negative scenarios. | 1 generation |
| 03 · Code · Playwright structure | Imports, navigation, and assertion tokens are structural hints, not proof of implemented login behavior. | 1 generation |
| 04 · Code · behavior review | Review executable actions, HTML-grounded selectors, and meaningful awaited assertions against the judge's evidence. | 1 generation + 1 judge |
| 05 · Code · waiting and placeholders | Check absence of `waitForTimeout` and `TODO`. Comments count, alternate spellings escape the rules, and absence is not correctness. | 1 generation |
| 06 · Code · selected login scenarios | Send three explicit login ideas to code generation; combine structural rules with a higher-weight semantic criterion. | 1 generation + 1 judge |
| 07 · Ideas · grounded coverage | Combine a forbidden-fragment rule with semantic review of scenario coverage and unsupported invented features. | 1 generation + 1 judge |
| 08 · Code · page object structure | Enable Page Object Model and selected ideas; inspect class/test/assertion fragments and whether the design is genuinely useful. | 1 generation |

Descriptions are **grader context**, not extra instructions sent to TestCraft. The ideas and direct-code routes receive HTML and applicable generation settings. **Generate code from selected ideas** additionally sends the selected ideas. Changing a description or criterion does not direct generation; changing HTML or selected ideas does. Criteria and expected judgments never go to the generator.

## Interpret results carefully

Every criterion returns Pass or Fail with evidence and a reason. The backend calculates `100 × sum(passed weights) / sum(all weights)`. Weights default to 1; **Custom weights** allows 0.01–100. Dashboard scores divide that stored value by 100 and display two decimals; overall Pass uses the fixed 0.80 displayed threshold without rounding the decision. Red is below 0.50, yellow is 0.50 to below 0.80, and green is 0.80 or above. Inspect individual checks even when the overall result passes.

For a weight exercise, take an observed run with mixed verdicts and calculate how different weights would change its aggregate using those same verdicts. Then save a variant and run it. That new run generates a new response, so any score difference cannot be attributed to weights alone. The app does not currently offer isolated regrading of a frozen output in the UI.

In Run Detail, use Suite, Model, Eval method, and score filters, sort any column, and expand multiple evaluations to compare concise criterion results. **Criteria met** counts passing criteria, independently of the weighted score. Rule descriptions currently display a placeholder; their actual rule result appears underneath. Open **Inspect generated output** below the criteria to see the saved response.

For model Pass verdicts, saved API evidence such as `L12: …` comes from original output lines selected by the judge and extracted by the backend. The compact page shows the criterion reason instead of evidence excerpts. Verify that those lines actually support the criterion; valid citations do not guarantee correct judgments. For Fail, the evidence explains missing or contradicted behavior. Invalid provider responses produce **Error**, not fabricated Fail scores.

Repeated runs probe the whole generation-and-grading pipeline: both output and judge decisions can vary. Compare the actual responses before attributing a difference to the grader. Rule-based grading is deterministic for identical output and criteria, but TestCraft generation is not. Two matching results do not prove future determinism.

## Configuration and usage

All eight cases need working TestCraft API generation. In **Runs → Create Run**, choose an explicit generation model from the selected environment’s catalog. Cases 04, 06, and 07 also need backend `OPENAI_API_KEY` and access to the grader chosen from the same TestCraft model catalog for the run. All model criteria within one case share one judge call. The grader key is never implicitly forwarded to TestCraft.

One full suite uses **8 generation + 3 judge = 11 app model-call attempts**; seven participants running it once use **77**. Reruns add calls. These request counts are not dollar estimates. Manage budgets through API keys. Missing configuration prevents dispatch; provider errors may still incur charges. If generation is unavailable, review the inputs and criteria without inventing responses or results.

## Existing workshop data

The input-only suite uses seed `workshop-v2-live`. Loading it imports a new suite alongside an older `workshop-v1` import, preserving old cases, participant edits, and run snapshots. Subsequent loads reuse the new suite. The editor no longer offers pasted output; new runs always generate fresh TestCraft output, including for old pasted cases. Both model selections now belong to the run, not to the evaluation editor. Cancel leaves it untouched; historical runs always retain their original snapshots.

Developer reference: `src/evals/workshop.mjs` exports only input definitions; `POST /api/workshop-suite {}` imports them into the current private workspace. Network-free tests validate all three TestCraft request routes, streamed output, rule/model/hybrid grading, budget accounting, reruns, errors, and import preservation. Canned answers used for historical grader regression live only in `tests/fixtures`, never in the runtime workshop module.
