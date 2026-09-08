# SauceDemo workshop: evaluate the output, then question the score

One hour, seven people: three pairs plus a facilitator. Swap drivers halfway through. Aim: explain why generated tests can vary, distinguish literal checks from quality judgments, and improve one criterion using evidence.

All eight supplied outputs and the HTML are **synthetic, simplified examples inspired by SauceDemo**. None is captured TestCraft output or live HTML. Credentials, messages, and alternate-state templates are fictional teaching assumptions. The page URL is context; graders do not visit it. Evaluation inspects text, not browser execution, and cannot establish that tests pass on the real site.

Choose **Load workshop suite** to load the eight definitions. Select cases, choose **Run selected**, and inspect output, checks, evidence, and score in Runs. Use **Duplicate**, edit one thing, and save; or edit an original and choose **Save as new**. Name each variant and retain both runs for comparison. Loading alone makes no model calls and creates no completed runs.

| Minutes | Activity |
| --- | --- |
| 0–5 | Agree what a useful login test proves; identify the synthetic fixture's controls and alternate states. |
| 5–15 | Run 01 and 02; predict their literal checks, then inspect the computed results. |
| 15–25 | Investigate 03's false positive; try the forbidden-fragment and fixed-label exercises. |
| 25–40 | Compare 04, 06, and 07 with human review; repeat a judge run if configured. Without a key, review the rubric and try the weight exercise below. |
| 40–55 | Copy HTML and two outputs from an approved real extension workflow; save separate pasted evaluations and compare them. Without extension access, compare the synthetic variants and describe how a future live comparison would work. |
| 55–60 | Each pair shares one improved criterion, one misleading score, and one remaining uncertainty. |

| Case | Exercise and evidence to inspect | App model calls per run |
| --- | --- | --- |
| 01 · Complete ideas | Contains gives 100: all three phrases occur. Duplicate, change only `missing password` to `empty password`, and rerun: about 66.67. Meaning can survive a wording mismatch. | 0 |
| 02 · Incomplete ideas | Same task and criteria, fewer scenarios: about 33.33. Missing negative cases appear as failed checks. | 0 |
| 03 · Keyword false positive | Contains gives 100, although every required API name is only in a comment. Navigation and `expect(true).toBe(true)` establish no login behavior. The grader correctly finds tokens; a quality conclusion would be the false positive. | 0 |
| 04 · Same weak output, judge | Exactly 03's output, input, and HTML. Review the semantic criterion and actual judge evidence; no judge score or pass/fail is promised. Rerun unchanged to study possible judge variation. | 1 |
| 05 · Forbidden fragments | Gives 100. Duplicate and append `// TODO` to the output: 50. Lowercase `// todo` escapes this case-sensitive rule. Absence of these fragments does not establish correctness. | 0 |
| 06 / 07 · Hybrid pair | Identical task and criteria, stronger versus weak code. Both satisfy the literal checks; compare the judge's evidence about implemented behavior. Names describe teaching intent, not verified execution or guaranteed grades. | 1 each |
| 08 · Fixed label | Exact match gives 100. Add a period: 0. Outer whitespace and CRLF line endings normalize; case, punctuation, and internal whitespace matter. Useful for fixed labels, unsuitable as a general quality test for freely generated tests. | 0 |

Every criterion is `{ text, method, weight }`, with `method` one of `contains`, `not_contains`, `exact_match`, or `model_grade`. Weights default to 1; enable **Custom weights** to change them (0.01–100). The overall method matches its criteria, or is `hybrid` for mixed methods. Every criterion, including the judge's, returns Pass or Fail. The score is `100 × passed weight / total weight`, equivalently `sum(weight × criterionScore) / sum(weight)` with criterion scores 0 or 100. The backend compares the unrounded score with **80**; this fixed threshold is not a UI parameter. Display rounding cannot turn 79.6 into a pass.

For a credential-free weight experiment, duplicate 02 and assign weights 80, 10, 10 in its existing criterion order. Its checks remain 100, 0, 0, but the total becomes 80 and passes despite missing two scenarios. Change only the first weight to 70: the score becomes about 77.78 and fails. Discuss what the weights say about priorities. In 06/07, weights are 10, 10, 80: both literal checks together supply only 20 percentage points, so the semantic check determines whether the total crosses 80. Inspect the actual verdict; neither candidate has a promised judge result.

For real TestCraft outputs, use facilitator-approved extension access on the intended SauceDemo page. Select the relevant UI, copy the HTML supplied to TestCraft, generate ideas or code, and copy the actual output. In **New evaluation**, choose the matching TestCraft type, **Paste from TestCraft**, and, for code, the matching framework/language. Paste the HTML and output, enter the page URL and task context, then add criteria and save. Keep real captures separate from the labeled synthetic cases. Generate a second output with the same selection and settings; duplicate the evaluation, replace only its output, and run both. Extension generation has its own provider usage; pasting makes no app generation call.

Changing one criterion and rerunning tests the rubric. Repeating extension generation with fixed settings probes generator nondeterminism. Regrading identical pasted text probes judge variation; rule results stay identical. Neither two matching outputs nor two matching judge scores proves future determinism. Structured judge output constrains response shape, not judgment correctness or repeatability. Read the evidence together and record disagreements.

For model-based Pass verdicts, evidence labeled `L12: …` is extracted by the backend from the original output line selected by the judge. The model does not rewrite the quoted code. Check whether those lines actually support the criterion; a valid citation is not proof of a correct judgment. For Fail verdicts, evidence describes missing or contradicted behavior and the reason explains why it fails. Invalid or empty provider responses are grading errors, never substitute Fail scores; a manual rerun creates a new result and consumes another model-call attempt.

Rule-based pasted cases require no real keys. Cases 04, 06, and 07 use `gpt-4o-mini`, require the backend's `OPENAI_API_KEY`, and each consumes one paid judge-call attempt per run, not one per criterion. No additional generation API is needed for these fixtures. One full suite consumes three app model-call attempts; all seven people running it individually would consume 21, with reruns adding calls. This is a call allowance, not a dollar estimate. A scored **Failed** result means the rubric score is below 80. Missing credentials, quota issues, timeouts, or malformed provider responses are **Error** results without a valid grade; do not interpret them as poor test quality. If access is unavailable, continue the local exercises and human review without inventing judge results.

Developer reference: `src/evals/workshop.mjs` exports the fixture definitions. `POST /api/workshop-suite {}` imports them atomically into the caller's private suite. Repeating the import preserves existing edits. `npm test` includes network-free fixture validation and deterministic grading tests.
