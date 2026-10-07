# TestCraft Evals

An evaluation framework for TestCraft test-idea and automation-code generation. Define a dataset, generate outputs through TestCraft v1, and inspect grading evidence.

Target repository: [TestCraft-App/evals-framework](https://github.com/TestCraft-App/evals-framework). The original local folder remains `playwright-code-generator` so existing terminals and project links keep working. The package is now `testcraft-evals-framework`.

## Start locally

The evaluation library's **Actions → Clear workspace** reviews every suite by name, evaluation counts (including unfiled items), and run history before permanently deleting them from the selected writable workspace. Filters do not limit the reset. Cancel keeps everything; active runs block clearing, and changes since the review require reopening the confirmation. The session remains unchanged. **Load Full Suite** can then restore the templates.

`GET /api/workspace` returns the scoped summary and its revision. `DELETE /api/workspace` accepts `{ "revision": "<reviewed revision>" }` with the usual session, origin, and CSRF requirements. It atomically removes suites, evaluations, and runs; stale reviews and active runs return 409.

Requires **Node.js 22.13 or newer**, including its built-in SQLite support. Production uses Node.js 24 and the official AWS Secrets Manager SDK; no separate database server is needed.

```powershell
npm install
# Only if you do not already have a .env file:
Copy-Item .env.example .env
npm start
```

Open [TestCraft Evals](http://127.0.0.1:3000). If port 3000 is occupied, stop the previous server with Ctrl+C in its terminal or choose another `PORT` in `.env`. Restart after editing backend code or `.env`; `npm run dev` watches code changes.

## GitHub accounts and workspaces

Sign in with GitHub to create an account. Any GitHub user can join as a collaborator; `ADMIN_GITHUB_IDS` is the operator-managed list of numeric GitHub IDs that receive admin access. Usernames may change without losing account data. No passwords, emails, repository permissions, or GitHub tokens are stored.

Register a GitHub OAuth App for each environment. Set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Use the callback `APP_ORIGIN/api/auth/github/callback`; for local development use `http://127.0.0.1:3000/api/auth/github/callback` and open that same hostname. Set `ADMIN_GITHUB_IDS=12345,67890` using immutable account IDs from GitHub's user API, not usernames. Missing OAuth configuration leaves sign-in unavailable, with no anonymous fallback. Admin changes take effect after restart. There is no role-management UI.

The workspace switcher defaults to **TestCraft**. Every account also has **My workspace**, persistent across browsers and devices after signing in again. URLs such as `/#main/evaluations` and `/#personal/runs/<id>` let separate tabs retain independent workspaces.

| Capability | Admin | Collaborator |
| --- | --- | --- |
| Read TestCraft definitions and official runs | Yes | Yes |
| Manage TestCraft definitions, imports, and history | Yes | No |
| Run TestCraft evaluations | Save official results in TestCraft | Save private results in My workspace |
| Manage and run personal definitions | Yes | Yes |
| Read another account's personal data | No | No |
| Run credentials | Configured server keys | User-entered OpenAI key |

Actions retains the example/Basic/Full template loaders. Collaborators do not see Actions in TestCraft; switch to My workspace to load templates. Admins retain Actions in both workspaces. The access message aligns with the center of the workspace dropdown. Clearing is available only in writable workspaces and retains its revision/active-run checks. Copying the live main suite and requests to promote personal evaluations are follow-up work.

The header user menu shows your GitHub username and role, the **Extension** link (opens in a new tab), and **Sign out**. Collaborators also have **API key**, which opens a password-field dialog: **Save key** first validates the key through a server-side authenticated model-list request, then applies it to this tab and Create Run. Rejected keys, unavailable checks, and missing model-list permissions show an error and leave the dialog open; a failed replacement preserves the previous validated key. During the check, Save is disabled; Cancel or Escape discards the pending result. This check generates no output and confirms authentication, not quota, selected-model permissions, or TestCraft availability. In Create Run, collaborators without a validated tab key see a warning and a disabled **Create Run** button. **Set API key** opens the same dialog while preserving the run draft; there is no key input in Create Run. **Cancel** or Escape discards edits, and **Clear key** removes it from future requests. Collaborators enter one OpenAI key for both TestCraft generation and OpenAI grading. It stays only in tab memory and accepted server jobs, is never stored in browser storage or SQLite, and must be entered again after refreshing. Clearing it or signing out prevents reuse in new requests; already accepted runs continue. Admin generation and grading retain their separate configured keys. No collaborator request falls back to admin credentials.

The server stores hashed session tokens in `account_sessions`; cookies remain HttpOnly and SameSite=Strict (Secure on HTTPS). Sessions expire after `WORKSHOP_SESSION_HOURS` (24 by default, 1–168 allowed). Logout revokes the current session. Expiry or clearing cookies requires login again and does not delete workspace data. OAuth uses PKCE and a separate browser-bound, single-use ten-minute SameSite=Lax correlation cookie. GitHub tokens are discarded after identity verification. Protected mutations still require exact Origin and session-bound `X-CSRF-Token`.

`POST /api/auth/github/start {}` returns the authorization URL; `GET /api/auth/github/callback` completes login; `POST /api/auth/logout {}` revokes the session. Login starts are limited to 20 per remote address and 100 globally per minute, persisted across restarts; forwarded addresses are not trusted. OAuth failures return to sign-in without exposing provider details. GitHub login transactions expire on server restart. External document navigation is allowed only for the dashboard and OAuth callback; cross-site API requests remain blocked.

`GET /api/session` returns identity, role, accessible workspaces, expiry, and CSRF token; it never creates an anonymous session. `GET /api/workspaces` returns capabilities. Resource APIs are scoped under `/api/workspaces/main/…` or `/api/workspaces/personal/…`, with unqualified resource routes retained as authenticated personal aliases. Aliases are resolved server-side and never grant arbitrary ownership. `POST …/runs` accepts `openAiApiKey` for collaborators; the response and saved run omit it. The server records `createdBy`, `sourceWorkspace`, and `resultWorkspace`. Source references/revisions and snapshots survive edits and deletion, and private runs do not affect official latest results. Reruns review the current source definitions before new paid work.

Additive tables preserve all existing anonymous data and snapshots as archived scopes. Old cookies cannot authenticate, and no visitor claims those records. New workspaces start empty. Back up SQLite before rollout; retain the existing single-process deployment and graceful draining.

### Provider budgets

Manage spending through the configured API keys and provider-side budgets. The app does not enforce a model-call allowance. The obsolete `WORKSHOP_MAX_MODEL_CALLS` setting is ignored. `WORKSHOP_ID` scopes private sessions and saved data.

The workspace bar above Evaluations and Runs identifies the active workspace: teal **TestCraft · Shared**, or blue **My workspace · Private**, with distinct icons and explicit permission text. Shared visibility is separate from editing permissions: collaborators see the read-only notice and private run destination in TestCraft, while admins can manage it. Use the labeled Workspace dropdown to switch; on mobile it sits below the identity. The bar also appears on run detail and follows automatic switches to private results. The Evaluations tab opens directly on the evaluation library, without summary cards.

The header uses the extension's checkmark logo and Sora wordmark, with a blue-to-purple gradient adapted for the white dashboard header. Logo and font assets are served locally from `public/assets/` and included in the Docker image; the Sora font's SIL Open Font License is bundled alongside it. The Evals label remains visible, stacking below TestCraft on narrow screens.

### AWS deployment requirements (not deployed by this change)

The [AWS deployment guide](docs/aws-deployment.md) describes the initial setup, required IAM permissions, GitHub variables and operational checks. The Docker image, deployment scripts and GitHub Actions workflow are prepared; cloud provisioning and pipeline activation are separate steps. `AWS_DEPLOY_ENABLED` must remain unset until the approved infrastructure is ready. Local data and `.env` are never packaged into the image.

Use a single Node process/instance with a persistent SQLite volume, backups, and HTTPS termination. Set `HOST=0.0.0.0`, `NODE_ENV=production`, and **`APP_ORIGIN=https://your-exact-workshop-domain`**; the server refuses remote configuration without an explicit origin. HTTPS configuration sets a Secure, host-only `__Host-` session cookie, even behind a TLS-terminating proxy. The app does not trust forwarded host/protocol headers to make security decisions. Restrict direct access to the backend port at the network layer.

Set LLM secrets in the backend runtime only. Keep the database outside an ephemeral deployment filesystem. GET `/api/session` is a public read-only session endpoint; authentication uses the GitHub OAuth endpoints; `/api/config` requires a session. The current queue/restart recovery is **single-process only**, not designed for horizontal replicas or zero-downtime overlapping workers. Add shared job processing and a suitable database before scaling that way. Application isolation and provider budgets do not replace infrastructure hardening or a live provider rehearsal.

In AWS mode, set `AWS_SECRET_ARN` and `AWS_REGION`. At startup the backend reads `AWSCURRENT` using the instance role. The JSON secret may contain only `OPENAI_API_KEY`, `TESTCRAFT_OPENAI_API_KEY`, and `GITHUB_CLIENT_SECRET`; malformed/unavailable secrets stop startup without printing their contents. Missing keys clear any stale local value. Rotation takes effect after a restart. Neither the secret values nor permanent AWS credentials belong in GitHub variables, Docker build arguments or the browser.

GET `/healthz` checks database access without creating a session or contacting a model. It returns only readiness, whether the engine is idle, and a validated release identifier, with `Cache-Control: no-store`. On Linux, `SIGUSR2` pauses new runs while already accepted jobs finish; `SIGCONT` reopens admission if an update is cancelled. `SIGTERM`/`SIGINT` wait for accepted work before closing SQLite, with a three-minute emergency shutdown deadline. The deployment script drains first and cancels/resumes if it takes more than ten minutes, instead of force-stopping a busy queue. Updating the one instance still causes a short interruption; it is not zero-downtime hosting.

## Workshop flow

1. Open the app; sign in with GitHub and choose My workspace. Select **New evaluation**. Step 1 shows Eval name, then Suite and TestCraft endpoint, followed by the applicable parameters and input. Models and environment are selected when creating a run.
2. Fill **Eval name**, choose a **Suite** and **TestCraft endpoint**, then supply the visible parameters. Generate ideas needs HTML; Automate tests also needs Framework, Language, and Page URL, with optional Page Object Model. Automate test ideas additionally needs Selected test ideas. Inactive fields are hidden and omitted when saving. There is no Test description or supplied-output field.
3. Choose **Next** to open **Evaluation criteria**. Choose a per-criterion **Method**: Rule-based (Contains, Not Contains, Exact match) or Model-graded. Use the shaded **Add criterion** panel and choose **Add** to the right of the text. **Added criteria** shows numbered cards with two rows: the method badge and optional rule description above, then the editable criterion text. Added criteria show a single line with an ellipsis when the text overflows; hover over truncated text for the full tooltip. Focus or tap the field to edit the full text in a two-line wrapping editor, with vertical scrolling for longer content. Truncation affects only the preview; saved text and exact-match line breaks remain intact. Rule cards include a compact editable rule dropdown; changes cannot create duplicate criteria or a second Exact match. Each card has Remove. For rule-based criteria, an optional **Description** field sits beside Method; it describes the rule in Run Detail. Added rule descriptions remain editable above the criterion text in the list. Switching Method preserves existing criteria. Different rules remain Rule-based; combining rules and model criteria displays Hybrid. Every criterion saved through the modal has weight 1. At most 20 criteria, 8,000 combined characters, and one Exact match criterion are allowed. Back preserves the draft. Saving includes pending criterion text.
4. **Create evaluation** saves a row in SQLite. It does not call a model.
5. Open **Runs → Create Run**. Choose an environment and one or more generation models from the multi-select dropdown, optionally enter a description below the model selectors, and select 1–50 evaluations using name or ID search and Suite/Endpoint/Method filters. The selection table shows Eval ID, Evaluation name, Suite, Endpoint, and Method. Choose a grader model when any selected criteria need model grading. Selections persist across filters; Select all affects only visible rows. **Create Run** generates and grades a fresh response for every selected evaluation/model pair. The footer shows only the calculation, such as **0 evals × 1 models = 0 results**, without a separate selected count or maximum-limit labels. Existing selection and server capacity limits still apply; a run can contain at most 100 pairs. The grader remains a single dropdown shared by all selected models. The run opens on its own detail page with an evaluation results table. Expand rows to read concise criterion results, then open **Inspect generated output** to review the saved response. **Back to runs** or the **Runs** tab opens the run table.
6. Click a case name to edit it. **Save** updates the same case and increments its revision. The edit modal offers an icon-only Delete action beside Close, with no Duplicate or Save as new action. **Duplicate** in the table immediately creates a separate row with a `(copy)` suffix and selects its name for inline editing. Save the name with Enter, the check icon inside the field, or by clicking outside; Escape keeps the existing copy name. The copy opens only when you later click its name or Edit icon. Earlier runs keep immutable snapshots, and old results are not shown as results of a newer revision. A stale Save returns a conflict and preserves the draft instead of overwriting another tab's changes.
7. Use the **Rerun** icon beside delete in the **Runs** table to open Create Run with that run's environment, models, description, and available evaluations selected. Review or adjust the draft, then choose **Create Run** to generate fresh outputs using the latest saved definitions; historical evidence stays unchanged. Missing evaluations are flagged, and unavailable models require a new selection. Opening or cancelling the draft makes no model calls.
8. To tidy up, use a finished run's delete icon in the **Runs** table or **Delete run** on its detail page, then confirm. This permanently removes only that run's snapshots, outputs, scores, and evidence; the saved evaluations remain runnable. Cancel leaves everything unchanged. Queued/running runs cannot be deleted. Deleting history never refunds model calls.

New **Create Run** drafts default to the **Dev** environment and default both generation and grading to **GPT-6 Luna** (`gpt-6-luna`) when present in the environment's catalog, or the existing **GPT-5.6 Luna** (`gpt-5.6-luna`) entry. If neither is available, generation requires a selection and grading falls back to the configured `JUDGE_MODEL` when available. Rerun drafts prefer the previous run's models.

**Runs table:** names use `Run · YYYY-MM-DD HH:mm:ss` in your browser's timezone. Search by name or run ID, filter by status and generation model, and click metadata headers to sort (newest first by default). The table covers all saved runs in your workspace. Models come from saved generation metadata, never the model grader; unspecified TestCraft models show **API default**, missing historical generation metadata shows **Unknown**, and pasted-only runs show **—**. Click a row or activate its name link to open full-page detail. Filters and sorting persist while navigating within the workspace. Start new runs with **Create Run**. Open saved results from Runs; the evaluation library no longer includes View run links.

All dashboard scores display from **0.00 to 1.00**, including evaluation scores and summary cards. Red means below 0.50, yellow means 0.50 to below 0.80, and green means 0.80 or above, using unrounded values. Run scores average available numeric evaluation scores, including zero; missing scores are excluded. **X of Y scored** identifies partial coverage, and **—** means no score is available. **Complete** means execution finished, even if some evaluations failed grading or had execution errors; execution errors have a separate count. Queued/running runs show **In progress**, and restart recovery shows **Interrupted**. Active runs update automatically on the table and detail page; there is no manual Refresh runs action.

GET `/api/runs` returns all workspace run summaries, retaining `id`, `createdAt`, `status`, `finishedAt`, `total`, `passed`, `failed`, and `errors`, and adding `models: string[]`, `score: number | null`, `scoredCount: number`, and `canDelete: boolean`. Status values remain `queued`, `running`, `completed`, and `interrupted`; the UI supplies display labels. Summaries derive from saved snapshots without rewriting evidence. Detail responses also include optional `description` and `settings` for new runs; historical payloads remain readable. Evaluation/run associations and the evaluation API’s latest result remain for historical evidence and active-run deletion safeguards. API and persisted scores remain on the original 0–100 scale; normalization is display-only. New run evaluation snapshots add `suiteName`, preserving the name at creation without changing saved definitions.

**Run detail:** a Model summary table sits below the run header and above the result filters/table. It lists each generation model, model-graded evals, rule-based evals, hybrid evals, total evals, and total score. The three method counts classify whole evaluations by their actual criterion families and do not overlap; counts include pending and failed evaluations. Total score is the unweighted mean of numeric evaluation scores for that model, displayed from 0.00 to 1.00 with X/Y scored coverage. Errors without scores and pending evaluations are excluded from the average; a zero score is included. The summary always covers the whole run, regardless of result filters, and updates during execution. Historical runs derive groups from saved generation metadata; pasted output has a separate Supplied output row.

**Run results:** columns are Eval ID, Eval name, Suite, Model, Eval method, Status, Score, and Criteria met. Long evaluation names truncate with the full name available on hover and to assistive technology. Eval method groups results as **rule-based**, **model-graded**, or **hybrid**; specific rules such as Contains remain in the expanded criterion results. Rule results show their saved description above the literal check; older criteria without a description retain the “Description not added yet” placeholder. All columns sort, with filters for Suite, Model, these method groups, and the three score bands. Missing scores stay outside score bands. Passed and failed evaluations both show **Graded**; execution errors show **Error**, and unfinished work shows **In progress** or **Interrupted**. Rows start collapsed and multiple rows can remain open. Criterion reasons stay compact; full text remains available to assistive technology and on hover. Output is a separate disclosure below the criteria. Filters, sorting, expansions, and focus survive live updates; controls remain per run until the page reloads or workspace changes. New snapshots retain suite names; older runs resolve their suite within the current workspace, displaying **Unavailable suite** if it was removed.

**Run configuration:** Prod resolves to `https://api.testcraft.app`; Dev to `https://openai-api-proxy-dev-rtu664353a-uc.a.run.app`; Local to `http://127.0.0.1:8080`. There is no automatic alternate-URL fallback. Local is enabled only when the backend is bound to loopback, is not in production mode, and has no public APP_ORIGIN. Server validation enforces the same restriction; caller-supplied URLs are never used.

POST `/api/runs` requires `evaluationIds` (1–50 distinct private IDs), `environment` (`prod`, `dev`, or `local`), and `generationModels` (a nonempty array of distinct catalog model IDs, maximum 200). The product of evaluation count and model count must not exceed 100. The historical `generationModel` string is still accepted when `generationModels` is omitted; when both are supplied, the array takes precedence. Optional `description` is trimmed and limited to 2,000 characters; `graderModel` is required if any selected criterion needs model grading and otherwise ignored. The selected models must belong to the environment’s successful/cached catalog, and the same catalog models are selectable for generation and grading. Missing settings return 400. An unavailable catalog with no cache returns 503 before starting a run.

The run stores `description` and `settings: { environment, testcraftBaseUrl, generationModels, graderModel }`. There is one uniquely identified result item per evaluation/model pair. Effective evaluation snapshots use the run’s TestCraft source and that pair’s generation model, while saved definitions and old run snapshots remain unchanged. Concurrent runs can use different environments without changing global configuration. Environment selection changes generation and catalog requests only; grading still uses OPENAI_BASE_URL and OPENAI_API_KEY. Catalog requests send no credentials and do not invoke models. The detail header shows environment and grader; each row shows its generation model. The description remains saved in the API but is not displayed in the compact detail view.

**Load example** fills the ordinary form with synthetic login HTML, parameters, and Contains criteria. Its source is TestCraft v1 API, with no supplied answer. Saving makes no model call; Run needs working TestCraft generation and consumes one generation attempt per selected model. Opening or saving an evaluation does not fetch models. Literal criteria are teaching examples, not a guaranteed score.

**Evaluation library:** columns are Eval ID, Eval name, Suite, Endpoint (the selected TestCraft route), Method (rule-based, model-graded, or hybrid), and Created, followed by accessible Edit, Duplicate, and Delete icons aligned at the right edge. **Actions**, beside **New evaluation**, contains **Load example**, **Load Basic Suite**, and **Load Full Suite**. Endpoint, Method, and Created use equal compact widths, reserving more room for evaluation and suite names; truncated names are available on hover. Click any data header to sort in either direction; newest first is the default. Filter saved definitions by Suite, Endpoint, and Method, with Suite immediately after search. The method filter offers rule-based, model-graded, and hybrid groups. Status filtering belongs to Runs; evaluation visibility does not depend on run results. The separate suite toolbar and sort dropdown are removed.

**Evaluation references:** Every evaluation has a server-assigned, read-only `reference` such as `EVAL-1`, shown as **Eval ID** in the library, Create Run, and Run Detail. Each private workspace has its own increasing sequence; include workspace context when sharing references. Search by reference in the library or run selector and sort numerically in the library or Run Detail. Editing and moving cases retain references; duplication assigns a new reference. Deletion and workspace clearing never reuse numbers.

Evaluation tables use a compact Eval ID column. Long cell values, including suite and model names, stay on one line with an ellipsis; hover to read the full value. Expanded criteria and generated output retain their detailed layout.

**Suites** are private, flat folders. The evaluation modal offers a Suite dropdown and **Suite actions** for Create, Rename, and Delete. Create/Rename use an inline name editor; Delete uses inline confirmation and is available only for empty suites. Suite actions save immediately, independently of the evaluation draft. The server rejects nonempty deletion with 409 and leaves all members unchanged. **None** means no suite is assigned and is not a deletable suite. **Delete evaluation** requires confirmation and removes only its definition; historical run snapshots remain saved. Active runs block evaluation deletion.

**Load Basic Suite** imports **12 evaluations in six suites**, two representatives of each Full suite, with 2–9 concise criteria per evaluation. It covers login/registration ideas, direct login code, selected login/cart ideas, Cypress JavaScript and Playwright Python, sparse context/form scoping, and user-content prompt injection, including a mandatory Login Validator setup attack with two criteria against configuration exfiltration and secret exposure. Model criteria check one objective each; mixed rubrics add a plain-code rule, and a rule-only Playwright case checks formatting, fixed sleeps, skipped tests, and focused tests. These literal checks do not establish code correctness. Running all Basic cases uses 12 generation and 11 judge attempts per selected generation model. Loading either collection makes no provider calls. Basic seeds (`workshop-basic-v1-*`) are independent of Full seeds, so both may coexist and repeated loads preserve edits.

Both **Load Basic Suite** and **Load Full Suite** assign Eval IDs from the same workspace sequence, continuing after any existing evaluations. In an empty workspace, loading Basic first assigns `EVAL-1` through `EVAL-12`; loading Full next assigns `EVAL-13` through `EVAL-168`. Loading Full first uses `EVAL-1` through `EVAL-156`, with Basic continuing from `EVAL-157`. Reloading either collection preserves its IDs. IDs appear in the import response, evaluation library, run selector, and run results; they are assigned on import rather than hard-coded in the shared templates.

**Load Full Suite** imports **six suites and 156 input-only evaluations**, with **13–19 criteria, each checking one property**: ideas generation (14), direct code (21), selected ideas to code (21), framework/language compatibility (60), adversarial grounding/selectors (16), and prompt injection (24). No provider calls or runs are created by loading. All cases use synthetic HTML and reserved `.invalid` page URLs; no responses or grades are preloaded. Each case uses one generation and one judge attempt per selected generation model when explicitly run; all model criteria share that judge call. Running the whole collection in separate batches would use **156 generation + 156 grading = 312** attempts per selected generation model. The original 56 generation cases are partitioned into numbered rubric parts to respect the 20-criterion limit. Parts retain identical generation inputs but produce separate responses when run. Select batches of at most 50 evaluations; the 60-evaluation compatibility suite needs multiple batches. See the [suite design and workshop guide](docs/workshop-exercises.md).

The six stable `workshop-v3-*` seeds import alongside earlier `workshop-v1` and `workshop-v2-live` suites. The collection imports atomically; repeated loads reuse each suite without overwriting participant edits, restoring deleted evaluations, or moving evaluations back to their original suite. The loader shows all evaluations so every imported suite is discoverable. Old evaluations and runs remain untouched. The form has no pasted-source option; new runs apply TestCraft generation even to legacy pasted or LLM-adapter evaluations, adding a generation attempt for every selected evaluation/model pair. Missing TestCraft inputs must be filled in before the run can start. Cancel makes no change. Historical run snapshots always keep their original output.

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
| Automate tests | `/api/automate-tests` | Above + `baseUrl`, `framework`, `language`, `pom` |
| Automate test ideas | `/api/automate-tests-ideas` | Above + `ideas` (one selected-idea line per idea) |

The adapter consumes streamed `choices[].delta.content`, including fragmented UTF-8, and requires a successful completion marker. Truncated, failed, or malformed responses are errors.

The three endpoint choices map to the existing `type` and `fromIdeas` fields: Generate ideas (`ideas`, false), Automate tests (`code`, false), and Automate test ideas (`code`, true). The selected ideas are sent only to `/api/automate-tests-ideas`. The legacy optional `input` field remains supported by the API but is no longer collected by the modal.

Select Prod, Dev, or Local in Create Run to choose the TestCraft destination. `TESTCRAFT_BASE_URL` is retained for legacy internal adapter calls only and does not override new run environments. With `TESTCRAFT_OPENAI_API_KEY` blank, generation depends on that API's own credentials. If set, this separate key is explicitly sent to TestCraft as `openAiApiKey`. Choose one or more generation models from the selected environment’s multi-select dropdown. Each selected model generates its own output for every selected evaluation.

### Test count (quantity)

In **Evaluation criteria → Method**, choose **Test count** and press **Add**. This third option sits alongside Rule-based and Model-graded. Its fixed description cannot be edited, and each evaluation allows at most one count criterion within the existing 20-criterion limit. It can be the only criterion or accompany quality criteria. Existing evaluations and workshop imports do not enable counting automatically.

**Generate ideas** counts separately proposed scenarios, including repeated entries; steps, assertions, headings, and setup are not additional ideas. Both **Automate tests** and **Automate test ideas** count implemented automated cases in the output, not the supplied ideas. Suite wrappers, hooks, helpers, page objects, comments, skipped, disabled, TODO, and empty tests are excluded. Parameterized/loop-generated cases expand only when their concrete data is statically visible; otherwise the definition counts once and the grader explains the limitation. This is a model estimate of quantity, not unique coverage or proof that code works; nothing is executed.

Counting requires the selected run grader and `OPENAI_API_KEY`, sharing **one judge call per output** with model-graded quality criteria. Adding it to rule-only evaluations introduces one judge call. A count of zero is valid. Counts do not affect quality score weights, criteria-met totals, or pass/fail. Count-only results show **Counted**, with no quality score or verdict. An invalid count or quality response makes the whole result an error, retaining generated output without a partial score, fabricated zero, or automatic retry.

Run Detail adds a sortable **Test count** column immediately beside Score when any evaluation enables counting. Values include units, such as `12 ideas` or `8 automated tests`; unavailable values show `—` and sort last. Expanded criteria show counting evidence and reason. Model summary totals stay across the whole run when filtering, separate ideas from automated tests, and show measured/enabled output counts. Successful measurements remain included when quality criteria fail; pending and unavailable measurements are excluded.

The API accepts `method: "test_count"` and a criterion `{ "method": "test_count" }`, normalizing its fixed text and default weight of 1. Mixed criterion methods use `method: "hybrid"`; counting belongs to the model-based family. New grading version 4 snapshots add optional `testCount` and `testCountUnit` (`ideas` or `automated_tests`). Count checks contain `id`, `method`, `criterion`, `weight`, `source`, `count`, `unit`, `evidence`, `reason`, and `evidenceSource: "model_explanation"`, without `passed` or `score`. Counts must be nonnegative safe integers with nonempty evidence and reason. Count-only items use status `counted` and `score: null`; their runs still complete and can be deleted normally. Stored JSON accommodates these fields without a database migration or historical evidence rewrite.

### Model-based → LLM as a judge

Previously labeled **Model grade**, this is the same rubric-based evaluator (`method: "model_grade"` remains compatible). Model-based is a family, not a competing method alongside LLM-as-a-judge. Here that family is implemented by a language model scoring one response against independent criteria. Our initial three choices mixed two specific text rules with one model-based implementation; they were not meant as an exhaustive classification of eval techniques. See the official [LLM-as-a-judge guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices#llm-as-a-judge-and-model-graders).

Set `OPENAI_API_KEY` in the backend `.env` and restart. `OPENAI_BASE_URL` defaults to `https://api.openai.com/v1`. `JUDGE_MODEL` defaults to `gpt-4o-mini` and is preselected in Create Run only if that environment’s catalog includes it. The chosen grader applies to the entire run. The model/provider must support Chat Completions **strict JSON-schema Structured Outputs**.

The model grader receives optional description, HTML, page URL as context (not fetched), the actual output as numbered lines, and only the model-based criteria. It receives framework/language only for code. It does not need a reference response. The strict response contains a boolean `passed`, evidence, and a reason for each ID—not a numeric score. The backend checks exact IDs, booleans, complete coverage, and nonempty explanations.

For **Pass**, the model returns 1–40 source line numbers (bounded by the actual line count), not copied code. The backend validates the references, extracts the original text, and stores it with `L1: …` labels. Stored checks include `evidenceLines` and `evidenceSource: "output_lines"`; only line endings normalize, and whitespace within each source line is preserved. Out-of-range references or exclusively blank lines are provider errors. This guarantees where the saved excerpt came from, not that the judge chose relevant lines or reasoned correctly.

For **Fail**, the model must describe the missing or contradicted behavior in nonempty evidence text and explain its verdict in `reason`. The JSON schema enforces those text requirements, including when no relevant behavior exists. Saved failed checks label their evidence source as `model_explanation`. Invalid provider responses produce field-specific errors without exposing the rejected content; no score is fabricated and no paid request is automatically retried. Existing run snapshots are unchanged.

All model criteria, including Test count, share **one** model call; rules run locally. The modal and workshop templates use equal weights of 1, so the score is the fraction of passed quality criteria, excluding Test count. The backend retains weighted API compatibility (`100 × sum(passed quality weights) / sum(all quality weights)`, weights 0.01–100). With no quality criteria the score is null. Overall Pass uses the fixed **0.80** displayed threshold (80 internally); rounding does not affect the decision. Inspect individual verdicts even when the aggregate passes.

The app preloads catalogs for enabled environments at startup through our **GET `/api/models?environment=prod|dev|local`** proxy for TestCraft's [GET `/api/models`](https://github.com/TestCraft-App/test-craft-api-v1/blob/dev/app/api.py). Opening Create Run or switching environments reuses those lists; reload the page to refresh them. The server caches successful catalogs for five minutes and concurrent requests share one fetch, with an eight-second timeout. Neither the grader key nor a generation key is sent to the catalog, including in query strings. Caches and in-flight requests are isolated by environment. If unavailable, show that environment’s last successful catalog with a warning and Retry; without a successful catalog, creation is blocked. Retry requests the catalog again. Configured models absent from the catalog are not injected. The grader selector stays enabled before evaluations are selected, but is required only for model-based criteria. This catalog does **not** verify model access or quota for your grader account.

Both model selectors use the selected environment’s TestCraft catalog, with no separate hard-coded grader allowlist. The current catalog contains `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`. All three are available for either role. TestCraft’s `model_selection_enabled` flag concerns its extension; it does not disable our selectors. Grading still requests strict JSON-schema output and validates each returned verdict and its evidence. Provider failures are reported as errors without retries or fabricated scores.

This follows the [official Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs). A judge score is not proof of runtime behavior; repeated runs can vary. Instructions treat supplied content as untrusted, but prompt-injection resistance is not guaranteed.

### Other sources and methods

- **Legacy pasted records:** retained by the backend for existing definitions and historical runs, not offered in the creation UI, Load example, or the new workshop suite.
- **Legacy backend LLM adapter:** retained for internal compatibility and historical evidence. Newly created runs use TestCraft even when a saved definition previously selected this adapter.
- **Exact match:** exactly one criterion containing the full text to match; 100 or 0. Normalizes CRLF and trims outer whitespace. Case, punctuation, and internal whitespace remain significant.
- **Contains:** each criterion is a case-sensitive required text fragment, not a semantic instruction. Presence passes, absence fails. This measures text presence, not semantic correctness.
- **Does not contain:** each criterion is a case-sensitive forbidden fragment, such as `waitForTimeout` or `TODO`. Absence passes; presence fails. Comments count as text too, and differently written equivalents are not detected. This is not a parser, safety guarantee, or proof that the code works.
- **Hybrid:** combine these rules and model-graded criteria in one definition. Each keeps its method, weight, evidence, and verdict. A mixed-method API record containing only rules displays Rule-based and uses no model grader or grading calls. Generation usage is independent.

These three text operations belong to **Rule-based** evaluation: the same output and criteria always produce the same grade, with no grader-model call. This says nothing about determinism of the upstream TestCraft generation. The terminology aligns with the distinction between [string checks and model graders](https://developers.openai.com/api/docs/guides/graders). The app implements its own graders; it is not delegating them to OpenAI's Evals API.

The workshop collection uses semantic criteria for coverage, grounded selectors, and meaningful assertions, plus a plain-code formatting rule for code outputs. Duplicate a case and add literal rules when demonstrating inexpensive, repeatable checks. Judge results still need human review. Exact match is useful for fixed labels, but is deliberately described as a poor default for freely generated code. No regex execution, arbitrary grading scripts, generated-code execution, human-review workflow, embeddings or pairwise comparison has been added.

Criteria are **never supplied to the generator**. `OPENAI_API_KEY` is never implicitly forwarded to TestCraft. Keys stay outside browser responses and saved evaluations.

The non-secret method catalog is returned in `/api/config`. The backend derives `evaluationFamily` from the validated `method`; client-supplied family overrides are ignored. Earlier cases/runs without the extra family field still display correctly, and unknown method IDs are rejected rather than silently sent to a paid judge.

New schema version 3 definitions store `criteria: [{ text, method, weight, description? }]`: 1–20 nonempty criteria, up to 8,000 text characters total, with distinct method/text pairs. Rule criteria accept an optional trimmed `description` (up to 2,000 characters), omitted when blank; model criteria omit it. Descriptions are display metadata and are not sent to TestCraft or the model grader. New rule checks include the saved description, while historical run snapshots remain unchanged. Uniform methods require matching criterion methods; Hybrid permits mixing. Exact match as the overall method requires one criterion. Legacy `string[]` creation payloads normalize to objects with weight 1. Historical scalar/reference definitions remain readable and rerun through the compatible normalizer. Existing results are never rewritten; their numeric checks are labeled historical in the UI. Reruns use the current binary grading version and global policy.

Library API: `GET/POST /api/suites`, `GET/PUT/DELETE /api/suites/:id`, `PUT/PATCH/DELETE /api/evaluations/:id`, `POST /api/evaluations/:id/duplicate`, and `POST /api/workshop-suite {}` (Full) or `POST /api/basic-workshop-suite {}` (Basic). Evaluation PUT expects the complete creation payload plus the current `revision`. PATCH accepts only `{ name, revision }`, preserving every other stored field, including legacy definitions. A stale name edit returns 409; the inline editor keeps the typed name on failures and does not create another copy. The new row stays visible while naming it even when filters would exclude it; normal filtering and sorting resume after saving. Suite PUT expects `{ name, revision }`; a stale revision returns 409. All IDs are scoped to the selected authorized workspace. Workshop import returns `{ suite, suites, evaluations }`, with `suite` retaining the first-suite compatibility alias and `evaluations` containing members of all six suites. Import is atomic and idempotent per seed; moving or deleting every member allows that empty suite to be deleted and reimported without changing the other suites. A load returns 201 if any suite was created, otherwise 200. Nonempty suite DELETE returns 409. Existing method IDs remain unchanged: mixed concrete methods use `hybrid` in the payload, while the UI derives the displayed family from the actual criteria.

## Persistence and boundaries

- SQLite stores cases and snapshots in `data/evals.sqlite`; override with `TESTCRAFT_EVALS_DB`. Stop the server before backing up the complete `data` directory.
- Runs preserve inputs, parameters, output, scores, evidence, events, and errors. A restart marks unfinished runs Interrupted without silently repeating paid calls.
- Up to 50 distinct evaluations and 100 evaluation/model pairs per run, two pairs processed concurrently across all runs, at most 100 queued/active pairs. Oversized requests and requests that exceed remaining queue capacity are rejected in full before execution. Independent runs may use the same evaluation simultaneously, with identical or different models and environments; each retains its own settings, snapshot, output, and grade. Additional work waits in the shared queue. No automatic provider retries.
- HTML is escaped text. **Generated code is not executed.** Passing an evaluation does not mean a Playwright/Cypress/Selenium test ran or passed.
- Personal workspaces are isolated by server-authenticated accounts, including suite CRUD and evaluation mutations. The additive database migration preserves any pre-session records as unowned; they are not automatically exposed to the first participant. Global data cleanup is an explicit operator action, never a public API route.
- Saved HTML/input/output are plaintext and may contain sensitive data. API/judge runs transmit relevant content to the configured providers. Use synthetic fixtures and remove secrets before saving.
- `.env`, `data`, dependencies, and test artifacts are ignored by Git.
- Original prototype modules (`src/generator.mjs`, `src/runner.mjs`, `src/evaluator.mjs`, `src/scenarios.mjs`, `public/demo-app.html`) remain historical reference only. No active route imports or serves them.

## Tests

```powershell
npm test
npx playwright install chromium
npm run test:e2e
```

Backend tests cover GitHub accounts, workspace permissions and ownership, cookie/CSRF/origin controls, rate limits, unrestricted model calls, provider failures, restart recovery, legacy migration, criteria arrays, the fixed policy, computed scores, catalog failure/secrecy, TestCraft streams, judge schema validation, and generator/judge separation. Run-deletion tests cover ownership, active-run protection, persistence after restart, latest-result recalculation, and repeat runs. Browser tests use mocked GitHub account sessions in an isolated test workshop and cover the two-step form, disabled parameters, criteria editing, dropdown loading/failure, save/reload, selection/batches, direct run links, expandable criteria/output, detail filtering/sorting, normalized scores, missing grader configuration, and deletion confirmation/cancellation/errors.

Tests use temporary databases and mocked LLM responses; **they never consume model credits**. Creation-flow tests check that manual/example payloads match, templates contain no answers, loading makes no generation calls, and Run uses the real adapter with injected provider responses. Historical pasted-answer fixtures live only in `tests/fixtures`, outside the Docker runtime. A live TestCraft + judge smoke test still needs working provider configuration.

## API

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/healthz` | Public readiness check; no sessions, secrets or model calls |
| GET | `/api/session` | Current session + CSRF token, or anonymous bootstrap status; no writes |
| POST | `/api/session` | Send `{}` to create an anonymous-session cookie or reuse the current valid session |
| GET | `/api/config` | Non-secret configuration |
| POST | `/api/api-key/validate` | Collaborator key check: `{ openAiApiKey }` → `{ valid: true }`; session/origin/CSRF protected; no key persistence or model generation |
| GET | `/api/models` | TestCraft model catalog with grader compatibility and explicit fallback status |
| GET / POST | `/api/evaluations` | List or create cases |
| GET | `/api/evaluations/:id` | Retrieve a case |
| POST | `/api/runs` | Start batch: `{ "evaluationIds": ["…"] }` |
| GET | `/api/runs` | Recent run summaries |
| GET | `/api/runs/:id` | Snapshot, progress, output, score, and evidence |
| DELETE | `/api/runs/:id` | Permanently delete an owned completed/interrupted run; returns `{ "deletedId": "…" }`, 404 if unavailable, 409 if still active |

Existing definitions and historical run-only evaluations receive references in creation-date order (UUID breaks ties; run date is used when the original creation date is unavailable). Historical records without an evaluation UUID display **—**. Evaluation API responses and new run evaluation snapshots include `reference`; historical run responses resolve it without rewriting saved evidence. UUIDs remain the API routing and selection identifiers. No configuration changes are required.

The UI polls active runs; generation streaming is consumed by the backend. No frontend API keys, destructive reset route, or automatic fallback scores.

Except for `/api/session`, all API routes require the cookie. Protected mutations (POST and DELETE) also require `Origin: <APP_ORIGIN or local origin>` and `X-CSRF-Token` from the session response. POSTs require `Content-Type: application/json`; DELETE needs no body. The browser handles these automatically. Never put session tokens or LLM keys in URLs.

## References

- [TestCraft extension](https://home.testcraft.app/)
- [v1 extension API client](https://github.com/TestCraft-App/test-craft-app-v1/blob/dev/scripts/result/common.js)
- [v1 backend repository](https://github.com/TestCraft-App/test-craft-api-v1)
- [Dashboard visual reference](https://testcraft-app.github.io/api-automation-agent/evaluations/dashboard.html)
- [Updated workshop brief](docs/workshop-brief.md)
