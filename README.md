# TestCraft Evals

A local evaluation framework for TestCraft test-idea and automation-code generation. Define a dataset, generate outputs through TestCraft v1, and inspect grading evidence.

Target repository: [TestCraft-App/evals-framework](https://github.com/TestCraft-App/evals-framework). The original local folder remains `playwright-code-generator` so existing terminals and project links keep working. The package is now `testcraft-evals-framework`.

## Start locally

Requires **Node.js 22.13 or newer**, including its built-in SQLite support. No separate database server or production dependencies.

```powershell
npm install
# Only if you do not already have a .env file:
Copy-Item .env.example .env
npm start
```

Open [TestCraft Evals](http://127.0.0.1:3000). If port 3000 is occupied, stop the previous server with Ctrl+C in its terminal or choose another `PORT` in `.env`. Restart after editing backend code or `.env`; `npm run dev` watches code changes.

## Workshop flow

1. Select **New evaluation**, then Generate ideas or Generate code.
2. On the left, choose the output source, framework, language, grading method, and threshold. Model grade also exposes an editable judge model and criteria, one per line.
3. Add the name, input/test intent, HTML context, and expected output. TestCraft code generation needs the original page URL. Pasted output needs what the extension actually generated.
4. **Create evaluation** saves a row in SQLite. It does not call a model.
5. Select cases and choose **Run selected**. Runs shows progress, actual versus expected output, scores, criterion-level evidence, and timestamps. **Open in new tab** opens the saved run in a separate browser tab.
6. Click a case name to inspect its settings and save a revised copy. Earlier cases and run snapshots are preserved.

**Load example** fills an unsaved, synthetic login example using pasted output and Contains. Save and run it to exercise the local flow without credentials or network calls. Scores are calculated from actual text, not canned scenario results.

## How it contacts the LLM

```text
Evaluation run
  ├─ Generate: TestCraft v1 API → TestCraft's configured LLM
  │            OR paste output copied from the extension
  │            OR optional independent backend LLM adapter
  └─ Grade: Exact match / Contains locally
            OR Model grade → OPENAI_BASE_URL → judge model
                  ↓
           SQLite: output + score + evidence
```

### TestCraft v1 integration (default source)

The backend calls the API used by [test-craft-app-v1](https://github.com/TestCraft-App/test-craft-app-v1), using the contract in [test-craft-api-v1](https://github.com/TestCraft-App/test-craft-api-v1). It does **not** automate the installed extension or require changing it.

| Evaluation | POST route | Payload |
| --- | --- | --- |
| Generate ideas | `/api/generate-ideas` | `sourceCode`, `stream: true`, optional `model` |
| Generate code | `/api/automate-tests` | Above + `baseUrl`, `framework`, `language`, `pom` |
| Code from selected ideas | `/api/automate-tests-ideas` | Above + `ideas` (one input line per idea) |

The adapter consumes streamed `choices[].delta.content`, including fragmented UTF-8, and requires a successful completion marker. Truncated, failed, or malformed responses are errors.

**v1 limitation:** ideas and direct-code routes consume HTML, not a separate free-text instruction. Input / test intent remains evaluation context for the judge. Enable **Use input as selected test ideas** to send input lines to code generation. Framework and language are generation parameters for code and saved metadata for ideas.

Configure `TESTCRAFT_BASE_URL` for your deployed or local API. With `TESTCRAFT_OPENAI_API_KEY` blank, generation depends on that API's own credentials. If set, this separate key is explicitly sent to TestCraft as `openAiApiKey`. Leave Generation model blank to use TestCraft's default.

### Model grade

Set `OPENAI_API_KEY` in the backend `.env` and restart. `OPENAI_BASE_URL` defaults to `https://api.openai.com/v1`. `JUDGE_MODEL` defaults to `gpt-4o-mini` and is overridable per evaluation. The model/provider must support Chat Completions **strict JSON-schema Structured Outputs**.

The judge receives task, HTML, expected output, actual output, and criteria. It returns a score from 0–100, evidence, and a reason per criterion. The backend validates IDs, completeness, scores, and evidence; it calculates the equally weighted mean, rounded to an integer. Passing means meeting the saved threshold.

This follows the [official Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs). A judge score is not proof of runtime behavior; repeated runs can vary. Instructions treat supplied content as untrusted, but prompt-injection resistance is not guaranteed.

### Other sources and methods

- **Paste from TestCraft:** grade actual output copied from the extension without generating again.
- **Backend LLM adapter:** direct OpenAI-compatible generation with this project's own prompt. It is explicitly **not the TestCraft v1 prompt**; do not present it as evaluating the extension's generator.
- **Exact match:** 100 or 0; normalizes CRLF and trims outer whitespace. Case, punctuation, and internal whitespace remain significant.
- **Contains:** one case-sensitive expected fragment per line, deduplicated. Score is the percentage found, rounded to an integer. This measures text presence, not semantic correctness.

Expected output and criteria are **never supplied to the generator**. `OPENAI_API_KEY` is never implicitly forwarded to TestCraft. Keys stay outside browser responses and saved evaluations.

## Persistence and boundaries

- SQLite stores cases and snapshots in `data/evals.sqlite`; override with `TESTCRAFT_EVALS_DB`. Stop the server before backing up the complete `data` directory.
- Runs preserve inputs, parameters, output, scores, evidence, events, and errors. A restart marks unfinished runs Interrupted without silently repeating paid calls.
- Up to 50 cases per run, two cases processed concurrently, at most 100 queued/active cases. Duplicate simultaneous runs of a case are rejected. No automatic provider retries.
- HTML is escaped text. **Generated code is not executed.** Passing an evaluation does not mean a Playwright/Cypress/Selenium test ran or passed.
- This is a **single local workshop workspace**, bound to `127.0.0.1`, without authentication or participant isolation. Do not expose it publicly as-is. Hosting needs access controls, quotas, and deployment-specific storage/job processing.
- Saved HTML/input/output are plaintext and may contain sensitive data. API/judge runs transmit relevant content to the configured providers. Use synthetic fixtures and remove secrets before saving.
- `.env`, `data`, dependencies, and test artifacts are ignored by Git.
- Original prototype modules (`src/generator.mjs`, `src/runner.mjs`, `src/evaluator.mjs`, `src/scenarios.mjs`, `public/demo-app.html`) remain historical reference only. No active route imports or serves them.

## Tests

```powershell
npm test
npx playwright install chromium
npm run test:e2e
```

Backend tests cover persistence, interrupted recovery, validation, computed scores, TestCraft payload/stream contracts, judge schema validation, and generator/judge separation. Browser tests cover save/reload, selection/batches, results in another tab, and missing judge configuration.

Tests use temporary databases and mocked LLM responses; **they never consume model credits**. A live TestCraft + judge smoke test still needs working provider configuration.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/api/config` | Non-secret configuration |
| GET / POST | `/api/evaluations` | List or create cases |
| GET | `/api/evaluations/:id` | Retrieve a case |
| POST | `/api/runs` | Start batch: `{ "evaluationIds": ["…"] }` |
| GET | `/api/runs` | Recent run summaries |
| GET | `/api/runs/:id` | Snapshot, progress, output, score, and evidence |

The UI polls active runs; generation streaming is consumed by the backend. No frontend API keys, destructive reset route, or automatic fallback scores.

## References

- [TestCraft extension](https://home.testcraft.app/)
- [v1 extension API client](https://github.com/TestCraft-App/test-craft-app-v1/blob/dev/scripts/result/common.js)
- [v1 backend repository](https://github.com/TestCraft-App/test-craft-api-v1)
- [Dashboard visual reference](https://testcraft-app.github.io/api-automation-agent/evaluations/dashboard.html)
- [Updated workshop brief](docs/workshop-brief.md)
