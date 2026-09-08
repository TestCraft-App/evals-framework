# TestCraft Evals

An evaluation framework for TestCraft test-idea and automation-code generation. Define a dataset, generate outputs through TestCraft v1, and inspect grading evidence.

Target repository: [TestCraft-App/evals-framework](https://github.com/TestCraft-App/evals-framework). The original local folder remains `playwright-code-generator` so existing terminals and project links keep working. The package is now `testcraft-evals-framework`.

## Start locally

Requires **Node.js 22.13 or newer**, including its built-in SQLite support. Production uses Node.js 24 and the official AWS Secrets Manager SDK; no separate database server is needed.

```powershell
npm install
# Only if you do not already have a .env file:
Copy-Item .env.example .env
npm start
```

Open [TestCraft Evals](http://127.0.0.1:3000). If port 3000 is occupied, stop the previous server with Ctrl+C in its terminal or choose another `PORT` in `.env`. Restart after editing backend code or `.env`; `npm run dev` watches code changes.

## Automatic private workspaces — no accounts or access code

Open the app URL and start working. The browser automatically creates or restores its session, with no registration, email, password or workshop code. No session secret needs to be configured. `WORKSHOP_ACCESS_CODE` is obsolete and has no effect if left in an older `.env` file.

Each browser gets a **different anonymous workspace**. The server stores a hash of a random 256-bit session token; the browser keeps the token in an HttpOnly, SameSite=Strict cookie, never localStorage. Every evaluation and run is scoped to that session in SQLite, including direct links and mixed batches. Knowing someone else's evaluation/run ID does not grant access; cross-workspace requests return 404. HTML, evidence, and run snapshots are private to their owning session through the app (the backend operator can still access the database).

- Reloads and new tabs in the **same browser profile and hostname** retain the workspace. Use one URL consistently: `localhost` and `127.0.0.1` have different cookies.
- Sessions expire after **24 hours**, configurable with `WORKSHOP_SESSION_HOURS` (1–168). The expiration is fixed, not extended on every visit, and is shown under Session details in the footer.
- Clearing cookies, using incognito, changing devices or letting a session expire automatically starts a new empty workspace; this is not cross-device account recovery. Existing records are not automatically deleted at expiry. Sessions issued before removal of the code remain scoped to their original owner until expiry.
- **Anyone with the app URL can enter and consume the shared allowance.** Data isolation does not restrict admission. There is no enforced seven-person maximum or organizer dashboard. For private admission, use deployment/network access controls separately.
- Restarting with the same workshop ID and database preserves sessions and usage. CSRF tokens are derived from each random session token, independently of any shared code. Revoke a session by removing its server-side session record, not by changing the obsolete code setting.
- Protected mutations require the exact Origin and a session-bound `X-CSRF-Token`. Session creation uses an empty JSON object plus the exact Origin. New sessions are limited to 20 per remote address and 100 globally per minute, persisted across restarts; reusing an existing valid cookie does not consume this limit. Forwarded IP headers are not trusted. Behind an AWS proxy, the per-address limit may be shared by all participants.
- The UI checks for an existing session, creates one only if needed, then verifies that the cookie was retained. Browsers supporting Web Locks serialize first-visit initialization across tabs. Blocked cookies or network failures show a retry message, not a creation loop. Expired sessions reconnect automatically; paid evaluation requests are never automatically replayed.

### Shared model-call allowance

`WORKSHOP_MAX_MODEL_CALLS` defaults to **200 for the whole workshop**, not per participant. `WORKSHOP_ID` defaults to `workshop` and scopes the persistent usage counter; changing it intentionally starts a different workshop. Opening a fresh session, clearing cookies or restarting does not reset the allowance.

| Operation | Calls counted |
| --- | --- |
| Save a case, load example/suite, view results, load the model catalog | 0 |
| Legacy pasted output + Rule-based method (backend compatibility only) | 0 |
| TestCraft / backend LLM generation + text grading | 1 |
| Legacy pasted output + LLM as a judge (backend compatibility only) | 1 |
| Generation + LLM as a judge | 2 |

The backend atomically reserves the entire batch before accepting it, including simultaneous requests from different participants. An unaffordable batch returns 429 without starting a partial run. Every outbound model request is counted **before dispatch**; failures/timeouts still count because the provider may have processed them. Unattempted calls are released after errors or restart recovery. No credentials / no dispatched request means no consumed calls. Offline text grading still works when the allowance is exhausted; setting the limit to 0 permits only those runs.

The UI displays remaining calls and reservations, refreshed after starting/finishing a run and approximately every 30 seconds. **This is not a dollar or token spending cap**, nor a limit on usage outside this app. Set appropriate provider-side restrictions and review input sizes/model choices before the workshop.

### AWS deployment requirements (not deployed by this change)

The [AWS deployment guide](docs/aws-deployment.md) describes the initial setup, required IAM permissions, GitHub variables and operational checks. The Docker image, deployment scripts and GitHub Actions workflow are prepared; cloud provisioning and pipeline activation are separate steps. `AWS_DEPLOY_ENABLED` must remain unset until the approved infrastructure is ready. Local data and `.env` are never packaged into the image.

Use a single Node process/instance with a persistent SQLite volume, backups, and HTTPS termination. Set `HOST=0.0.0.0`, `NODE_ENV=production`, and **`APP_ORIGIN=https://your-exact-workshop-domain`**; the server refuses remote configuration without an explicit origin. HTTPS configuration sets a Secure, host-only `__Host-` session cookie, even behind a TLS-terminating proxy. The app does not trust forwarded host/protocol headers to make security decisions. Restrict direct access to the backend port at the network layer.

Set LLM secrets in the backend runtime only. Keep the database outside an ephemeral deployment filesystem. GET `/api/session` is a public read-only health/session endpoint; POST creates or reuses an anonymous session; `/api/config` requires a session. The current queue/restart recovery is **single-process only**, not designed for horizontal replicas or zero-downtime overlapping workers. Add shared job processing and a suitable database before scaling that way. Application isolation and the call cap do not replace infrastructure hardening or a live provider rehearsal.

In AWS mode, set `AWS_SECRET_ARN` and `AWS_REGION`. At startup the backend reads `AWSCURRENT` using the instance role. The JSON secret may contain only `OPENAI_API_KEY` and `TESTCRAFT_OPENAI_API_KEY`; malformed/unavailable secrets stop startup without printing their contents. Missing keys clear any stale local value. Rotation takes effect after a restart. Neither the secret values nor permanent AWS credentials belong in GitHub variables, Docker build arguments or the browser.

GET `/healthz` checks database access without creating a session or contacting a model. It returns only readiness, whether the engine is idle, and a validated release identifier, with `Cache-Control: no-store`. On Linux, `SIGUSR2` pauses new runs while already accepted jobs finish; `SIGCONT` reopens admission if an update is cancelled. `SIGTERM`/`SIGINT` wait for accepted work before closing SQLite, with a three-minute emergency shutdown deadline. The deployment script drains first and cancels/resumes if it takes more than ten minutes, instead of force-stopping a busy queue. Updating the one instance still causes a short interruption; it is not zero-downtime hosting.

## Workshop flow

1. Open the app; your workspace starts automatically. Select **New evaluation**. Step 1 has a horizontal parameter bar: **TestCraft endpoint**, output source, framework, and language. Ideas disables framework/language; code enables them.
2. Fill **Eval name**, optional **Test description**, **HTML input**, and **Page URL**. TestCraft code generation requires the original page URL. There is no Expected output or TestCraft output field: responses are generated on Run, not supplied when creating a case.
3. Choose **Next**. Step 2 supports Rule-based → Contains / Does not contain / Exact match; Model-based → LLM as a judge; and **Hybrid** → a method per criterion. The grader dropdown is needed only when at least one criterion uses a model. Use **Add criteria** and optionally enable **Custom weights**. Every criterion returns Pass/Fail with evidence and a reason. Switching to Hybrid preserves the existing criteria and their methods; other method drafts remain separate. **Back** preserves both steps. One scroll area keeps the actions visible.
4. **Create evaluation** saves a row in SQLite. It does not call a model.
5. Select cases and choose **Run selected**. Each run generates a fresh response through the selected source, then grades it. The run opens on its own detail page with progress, criteria alongside actual output, scores, criterion-level evidence, and timestamps. **Open in new tab** opens the saved run in a separate browser tab. **Back to runs** or the **Runs** tab opens the run table.
6. Click a case name to edit it. **Save** updates the same case and increments its revision; **Save as new** saves the edited draft as a new case. **Duplicate** copies the saved definition without its run history. Earlier runs keep immutable snapshots, and old results are not shown as results of a newer revision. A stale Save returns a conflict instead of overwriting another tab's changes.
7. To tidy up, use a finished run's delete icon in the **Runs** table or **Delete run** on its detail page, then confirm. This permanently removes only that run's snapshots, outputs, scores, and evidence; the saved evaluations remain runnable. Cancel leaves everything unchanged. Queued/running runs cannot be deleted. The library shows the latest remaining run, or **Not run** if no history remains. Deleting history never refunds model calls.

**Runs table:** names use `Run · YYYY-MM-DD HH:mm:ss` in your browser's timezone. Search by name or run ID, filter by status and generation model, and click metadata headers to sort (newest first by default). The table covers all saved runs in your workspace. Models come from saved generation metadata, never the model grader; unspecified TestCraft models show **API default**, missing historical generation metadata shows **Unknown**, and pasted-only runs show **—**. Click a row or activate its name link to open full-page detail. Filters and sorting persist while navigating within the workspace. **Create Run** is a disabled placeholder; continue using **Run selected** in Evaluations.

Run scores average available numeric evaluation scores, including zero, out of 100; missing scores are excluded. **X of Y scored** identifies partial coverage, and **—** means no score is available. **Complete** means execution finished, even if some evaluations failed grading or had execution errors; execution errors have a separate count. Queued/running runs show **In progress**, and restart recovery shows **Interrupted**. Active runs update automatically on the table and detail page; there is no manual Refresh runs action.

GET `/api/runs` returns all workspace run summaries, retaining `id`, `createdAt`, `status`, `finishedAt`, `total`, `passed`, `failed`, and `errors`, and adding `models: string[]`, `score: number | null`, `scoredCount: number`, and `canDelete: boolean`. Status values remain `queued`, `running`, `completed`, and `interrupted`; the UI supplies display labels. Summaries derive from saved snapshots without rewriting evidence. The detail API and run-creation payload are unchanged.

**Load example** fills the ordinary form with synthetic login HTML, parameters, and Contains criteria. Its source is TestCraft v1 API, with no supplied answer. Saving makes no model call; Run needs working TestCraft generation and consumes one generation attempt. Opening the form attempts a read-only model catalog request. Literal criteria are teaching examples, not a guaranteed score.

**Suites** are private, flat folders: create or rename a suite, assign evaluations in the form, and filter the library by suite. Deleting a suite moves its evaluations to Unfiled; it does not delete cases or runs. **Delete evaluation** requires confirmation and removes only the saved definition, never historical run snapshots or usage. Active runs block evaluation deletion.

**Load workshop suite** imports eight input-only templates into **SauceDemo · TestCraft workshop**, without calling an LLM or creating runs. All use the same TestCraft generation flow as manual creation. Five grade with local rules; three add one model-grader call each. A full run uses **8 generation + 3 grading = 11** attempts. See [the one-hour workshop guide](docs/workshop-exercises.md). HTML is synthetic and simplified, not captured live SauceDemo HTML; no responses or grades are preloaded.

The new `workshop-v2-live` seed imports separately from the previous pasted-output suite. Repeated loads reuse this new suite without overwriting participant edits. Old evaluations and runs remain untouched. The form has no pasted-source option; opening an old pasted case warns that **Save** or **Save as new** switches the saved definition to generation, adding one model call per run. Cancel makes no change. Historical run snapshots always keep their original output.

## How it contacts the LLM

```text
Evaluation run
  ├─ Generate: TestCraft v1 API → TestCraft's configured LLM
  │            OR optional independent backend LLM adapter
  └─ Grade: Rule-based → local text checks
            OR Model-based → LLM as a judge → OPENAI_BASE_URL
            OR Hybrid → both, aggregated by criterion weight
                  ↓
           SQLite: output + score + evidence
```

### TestCraft v1 integration (default source)

The backend calls the API used by [test-craft-app-v1](https://github.com/TestCraft-App/test-craft-app-v1), using the contract in [test-craft-api-v1](https://github.com/TestCraft-App/test-craft-api-v1). It does **not** automate the installed extension or require changing it.

| Evaluation | POST route | Payload |
| --- | --- | --- |
| Generate ideas | `/api/generate-ideas` | `sourceCode`, `stream: true`, optional `model` |
| Generate code | `/api/automate-tests` | Above + `baseUrl`, `framework`, `language`, `pom` |
| Code from selected ideas | `/api/automate-tests-ideas` | Above + `ideas` (one selected-idea line per idea) |

The adapter consumes streamed `choices[].delta.content`, including fragmented UTF-8, and requires a successful completion marker. Truncated, failed, or malformed responses are errors.

**v1 limitation:** ideas and direct-code routes consume HTML, not a separate free-text instruction. The optional Test description (`input` in the stored/API payload) remains evaluator context. Enable **Generate code from selected ideas** to reveal a separate list of ideas sent to code generation. Inapplicable parameters are disabled and not saved as misleading metadata.

Configure `TESTCRAFT_BASE_URL` for your deployed or local API. With `TESTCRAFT_OPENAI_API_KEY` blank, generation depends on that API's own credentials. If set, this separate key is explicitly sent to TestCraft as `openAiApiKey`. Leave Generation model blank to use TestCraft's default.

### Model-based → LLM as a judge

Previously labeled **Model grade**, this is the same rubric-based evaluator (`method: "model_grade"` remains compatible). Model-based is a family, not a competing method alongside LLM-as-a-judge. Here that family is implemented by a language model scoring one response against independent criteria. Our initial three choices mixed two specific text rules with one model-based implementation; they were not meant as an exhaustive classification of eval techniques. See the official [LLM-as-a-judge guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices#llm-as-a-judge-and-model-graders).

Set `OPENAI_API_KEY` in the backend `.env` and restart. `OPENAI_BASE_URL` defaults to `https://api.openai.com/v1`. `JUDGE_MODEL` defaults to `gpt-4o-mini` and is overridable per evaluation. The model/provider must support Chat Completions **strict JSON-schema Structured Outputs**.

The model grader receives optional description, HTML, page URL as context (not fetched), the actual output as numbered lines, and only the model-based criteria. It receives framework/language only for code. It does not need a reference response. The strict response contains a boolean `passed`, evidence, and a reason for each ID—not a numeric score. The backend checks exact IDs, booleans, complete coverage, and nonempty explanations.

For **Pass**, the model returns 1–40 source line numbers (bounded by the actual line count), not copied code. The backend validates the references, extracts the original text, and displays it with `L1: …` labels. Stored checks include `evidenceLines` and `evidenceSource: "output_lines"`; only line endings normalize, and whitespace within each source line is preserved. Out-of-range references or exclusively blank lines are provider errors. This guarantees where the displayed excerpt came from, not that the judge chose relevant lines or reasoned correctly.

For **Fail**, the model must describe the missing or contradicted behavior in nonempty evidence text and explain its verdict in `reason`. The JSON schema enforces those text requirements, including when no relevant behavior exists. Saved failed checks label their evidence source as `model_explanation`. Invalid provider responses produce field-specific errors without exposing the rejected content; no score is fabricated and no paid request is automatically retried. Existing run snapshots are unchanged.

All model criteria share **one** model call. Rules run locally. The server calculates `100 × sum(passed weights) / sum(all weights)`, with every weight defaulting to 1. Optional weights range from 0.01 to 100. Overall Pass uses the fixed **80/100** policy; UI rounding must not change that decision. The threshold is not a form parameter and posted overrides are ignored. A rubric can still pass overall with individual failed criteria; choose weights deliberately and inspect each verdict.

The dropdown uses our **GET `/api/models`** proxy for TestCraft's [GET `/api/models`](https://github.com/TestCraft-App/test-craft-api-v1/blob/dev/app/api.py). Successful catalogs are cached for five minutes and concurrent requests share one fetch, with an eight-second timeout. Neither the grader key nor a generation key is sent to the catalog, including in query strings. If unavailable, show the last catalog or only the backend-configured model, with a warning and retry action. This catalog does **not** verify model access or quota for your grader account.

The verified TestCraft grading choices are `gpt-4o-mini`, `gpt-4o`, and `o3-mini`. `gpt-4-turbo` and `o1-mini` do not support the required Structured Outputs format and are disabled. Other catalog entries stay disabled until compatibility is verified, except an explicitly configured `JUDGE_MODEL` (the deployer is responsible for its compatibility). TestCraft's `model_selection_enabled` flag concerns its extension; it does not disable our independent grader.

This follows the [official Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs). A judge score is not proof of runtime behavior; repeated runs can vary. Instructions treat supplied content as untrusted, but prompt-injection resistance is not guaranteed.

### Other sources and methods

- **Legacy pasted records:** retained by the backend for existing definitions and historical runs, not offered in the creation UI, Load example, or the new workshop suite.
- **Backend LLM adapter:** direct OpenAI-compatible generation with this project's own prompt. It is explicitly **not the TestCraft v1 prompt**; do not present it as evaluating the extension's generator.
- **Exact match:** exactly one criterion containing the full text to match; 100 or 0. Normalizes CRLF and trims outer whitespace. Case, punctuation, and internal whitespace remain significant.
- **Contains:** each criterion is a case-sensitive required text fragment, not a semantic instruction. Presence passes, absence fails. This measures text presence, not semantic correctness.
- **Does not contain:** each criterion is a case-sensitive forbidden fragment, such as `waitForTimeout` or `TODO`. Absence passes; presence fails. Comments count as text too, and differently written equivalents are not detected. This is not a parser, safety guarantee, or proof that the code works.
- **Hybrid:** combine these rules and model-graded criteria in one definition. Each keeps its method, weight, evidence, and verdict. A Hybrid containing only rules uses no model grader or grading calls. Generation usage is independent.

These three text operations belong to **Rule-based** evaluation: the same output and criteria always produce the same grade, with no grader-model call. This says nothing about determinism of the upstream TestCraft generation. The terminology aligns with the distinction between [string checks and model graders](https://developers.openai.com/api/docs/guides/graders). The app implements its own graders; it is not delegating them to OpenAI's Evals API.

For the workshop, use literal rules to demonstrate inexpensive, repeatable checks, then use LLM as a judge for coverage, grounded selectors, and meaningful assertions. Judge results still need human review. Exact match is useful for fixed labels, but is deliberately described as a poor default for freely generated code. No regex execution, arbitrary grading scripts, generated-code execution, human-review workflow, embeddings or pairwise comparison has been added.

Criteria are **never supplied to the generator**. `OPENAI_API_KEY` is never implicitly forwarded to TestCraft. Keys stay outside browser responses and saved evaluations.

The non-secret method catalog is returned in `/api/config`. The backend derives `evaluationFamily` from the validated `method`; client-supplied family overrides are ignored. Earlier cases/runs without the extra family field still display correctly, and unknown method IDs are rejected rather than silently sent to a paid judge.

New schema version 3 definitions store `criteria: [{ text, method, weight }]`: 1–20 nonempty criteria, up to 8,000 text characters total, with distinct method/text pairs. Uniform methods require matching criterion methods; Hybrid permits mixing. Exact match as the overall method requires one criterion. Legacy `string[]` creation payloads normalize to objects with weight 1. Historical scalar/reference definitions remain readable and rerun through the compatible normalizer. Existing results are never rewritten; their numeric checks are labeled historical in the UI. Reruns use the current binary grading version and global policy.

Library API: `GET/POST /api/suites`, `GET/PUT/DELETE /api/suites/:id`, `PUT/DELETE /api/evaluations/:id`, `POST /api/evaluations/:id/duplicate`, and `POST /api/workshop-suite {}`. Evaluation PUT expects the complete creation payload plus the current `revision`. Suite PUT expects `{ name, revision }`; a stale revision returns 409. All IDs are scoped to the current session. Workshop import is atomic and idempotent for the existing seeded suite; deleting the suite allows a fresh import without touching the unfiled originals.

## Persistence and boundaries

- SQLite stores cases and snapshots in `data/evals.sqlite`; override with `TESTCRAFT_EVALS_DB`. Stop the server before backing up the complete `data` directory.
- Runs preserve inputs, parameters, output, scores, evidence, events, and errors. A restart marks unfinished runs Interrupted without silently repeating paid calls.
- Up to 50 cases per run, two cases processed concurrently, at most 100 queued/active cases. Duplicate simultaneous runs of a case are rejected. No automatic provider retries.
- HTML is escaped text. **Generated code is not executed.** Passing an evaluation does not mean a Playwright/Cypress/Selenium test ran or passed.
- Participant workspaces are isolated by server-owned sessions, including suite CRUD and evaluation mutations. The additive database migration preserves any pre-session records as unowned; they are not automatically exposed to the first participant. Global data cleanup is an explicit operator action, never a public API route.
- Saved HTML/input/output are plaintext and may contain sensitive data. API/judge runs transmit relevant content to the configured providers. Use synthetic fixtures and remove secrets before saving.
- `.env`, `data`, dependencies, and test artifacts are ignored by Git.
- Original prototype modules (`src/generator.mjs`, `src/runner.mjs`, `src/evaluator.mjs`, `src/scenarios.mjs`, `public/demo-app.html`) remain historical reference only. No active route imports or serves them.

## Tests

```powershell
npm test
npx playwright install chromium
npm run test:e2e
```

Backend tests cover automatic private sessions and ownership, cookie/CSRF/origin controls, rate limits, global atomic reservations, failed-call accounting, restart recovery, legacy migration, criteria arrays, the fixed policy, computed scores, catalog failure/secrecy, TestCraft streams, judge schema validation, and generator/judge separation. Run-deletion tests cover ownership, active-run protection, persistence after restart, latest-result recalculation, and unchanged call usage. Browser tests use automatic sessions in an isolated test workshop and cover the two-step form, disabled parameters, criteria editing, dropdown loading/failure, save/reload, selection/batches, results in another tab, missing grader configuration, and deletion confirmation/cancellation/errors.

Tests use temporary databases and mocked LLM responses; **they never consume model credits**. Creation-flow tests check that manual/example payloads match, templates contain no answers, loading makes no generation calls, and Run uses the real adapter with injected provider responses. Historical pasted-answer fixtures live only in `tests/fixtures`, outside the Docker runtime. A live TestCraft + judge smoke test still needs working provider configuration.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/healthz` | Public readiness check; no sessions, secrets or model calls |
| GET | `/api/session` | Current session + CSRF token + allowance, or anonymous bootstrap status; no writes |
| POST | `/api/session` | Send `{}` to create an anonymous-session cookie or reuse the current valid session |
| GET | `/api/config` | Non-secret configuration |
| GET | `/api/models` | TestCraft model catalog with grader compatibility and explicit fallback status |
| GET / POST | `/api/evaluations` | List or create cases |
| GET | `/api/evaluations/:id` | Retrieve a case |
| POST | `/api/runs` | Start batch: `{ "evaluationIds": ["…"] }` |
| GET | `/api/runs` | Recent run summaries |
| GET | `/api/runs/:id` | Snapshot, progress, output, score, and evidence |
| DELETE | `/api/runs/:id` | Permanently delete an owned completed/interrupted run; returns `{ "deletedId": "…" }`, 404 if unavailable, 409 if still active |

The UI polls active runs; generation streaming is consumed by the backend. No frontend API keys, destructive reset route, or automatic fallback scores.

Except for `/api/session`, all API routes require the cookie. Protected mutations (POST and DELETE) also require `Origin: <APP_ORIGIN or local origin>` and `X-CSRF-Token` from the session response. POSTs require `Content-Type: application/json`; DELETE needs no body. The browser handles these automatically. Never put session tokens or LLM keys in URLs.

## References

- [TestCraft extension](https://home.testcraft.app/)
- [v1 extension API client](https://github.com/TestCraft-App/test-craft-app-v1/blob/dev/scripts/result/common.js)
- [v1 backend repository](https://github.com/TestCraft-App/test-craft-api-v1)
- [Dashboard visual reference](https://testcraft-app.github.io/api-automation-agent/evaluations/dashboard.html)
- [Updated workshop brief](docs/workshop-brief.md)
