# AGENTS.md

## Scope

These instructions apply to the entire repository. This project is a small Node.js ESM application for defining TestCraft evaluations, generating outputs through configured providers, grading them, and inspecting persisted evidence.

## Repository map

- `server.mjs`: HTTP entry point and `createApp()` composition root. It serves the API and the static dashboard.
- `src/evals/`: active backend domain code: validation, methods, providers, graders, execution, sessions, persistence, and workshop fixtures.
- `src/runtime/`: startup-only secret loading.
- `public/`: dependency-free browser UI (`index.html`, `app.js`, and `styles.css`); there is no frontend build step.
- `tests/*.test.mjs`: Node test-runner unit and integration coverage.
- `tests/*.spec.js`: Playwright browser coverage. The fixtures start isolated in-memory servers and mock provider traffic.
- `scripts/aws/`, `Dockerfile`, and `.github/workflows/ci-deploy.yml`: production packaging and AWS deployment.
- `docs/`: workshop and deployment documentation.
- `src/generator.mjs`, `src/runner.mjs`, `src/evaluator.mjs`, `src/scenarios.mjs`, and `public/demo-app.html`: historical prototype references, not active runtime code.

## Setup and commands

Use Node.js 22.13 or newer; CI and production use Node.js 24.

```powershell
npm ci
Copy-Item .env.example .env  # only when local configuration is absent
npm run dev                  # watch-mode local server
npm start                    # normal local server
npm test                     # all Node tests
npx playwright install chromium
npm run test:e2e             # all browser tests
```

For focused validation:

```powershell
node --test tests/backend.test.mjs
npx playwright test tests/creation-flow.spec.js
```

There is no configured lint, format, type-check, or compile command. Do not claim one was run. Treat the SQLite experimental warning from supported Node versions as expected unless behavior fails.

## Implementation conventions

- Keep the code ESM and use `node:` prefixes for built-in modules.
- Follow the existing compact JavaScript style: single quotes in active backend code, semicolons, small functions, and early validation. Avoid unrelated reformatting.
- Put domain behavior in `src/evals/`; keep `server.mjs` focused on HTTP/session wiring and lifecycle management.
- Keep `createApp()` dependency-injectable (`env`, database path, and fetch implementation) so tests can remain isolated and deterministic.
- Validate and normalize untrusted input at the server boundary. Return safe `AppError` messages; never expose raw provider responses, secrets, stack traces, or internal database details to clients.
- Preserve backward compatibility for stored evaluations and historical run snapshots. Prefer additive SQLite migrations, and never silently rewrite evidence or replay paid calls after restart.
- Keep frontend rendering safe. Escape persisted or generated text before inserting HTML, and preserve the current cookie + CSRF request flow for mutations.
- When changing an API payload, persisted schema, environment variable, or user-visible workflow, update the relevant README, `.env.example`, and docs in the same change.
- Do not edit generated/local state: `.env`, `data/`, `node_modules/`, `playwright-report/`, `test-results/`, or `.aws-deploy/`.

## Security and provider boundaries

- Browser workspaces must remain isolated by server-issued, HttpOnly, SameSite=Strict session cookies. Do not accept caller-selected owner/workshop identifiers.
- Preserve exact-origin and session-bound CSRF enforcement on authenticated mutations. Never place API keys or session tokens in URLs or browser-visible configuration.
- Keep generator and grader credentials separate. `TESTCRAFT_OPENAI_API_KEY` may go only to TestCraft; `OPENAI_API_KEY` may go only to `OPENAI_BASE_URL` and server-side AWS secret loading.
- Generation must not receive expected outputs, grading criteria, or judge-only context.
- Charge and reserve the shared model-call allowance around actual attempts exactly as documented. Do not add hidden retries, fallback grades, or unmetered provider calls.
- Generated test code is data: this application does not execute it. Do not introduce code execution without an explicit design and security review.
- Use synthetic test data. Automated tests must mock TestCraft/OpenAI requests and must never consume live model credits.

## Testing expectations

- Treat every request to review a failing test, including a CI/pipeline failure, as a request to investigate and fix the failure. Assess whether it exposes a product bug or a test that needs updating, then fix the product or update the test according to the intended behavior and available evidence.
- If the cause or intended behavior is uncertain, never modify, weaken, skip, or delete a test merely to make it pass. Continue investigating and ask for clarification when needed.
- Before completing a failing-test review, run the focused test that covers the reported failure and confirm it passes. If it cannot be run or still fails, report the blocker or remaining failure and do not claim the review is complete.
- Add or update a Node test for backend, persistence, validation, provider, grader, session, or deployment behavior.
- Add or update a Playwright spec for observable dashboard behavior. Reuse `tests/browser-fixtures.mjs`; each test should retain isolated in-memory state and mocked network responses.
- Cover failure paths and invariants, especially ownership, origin/CSRF controls, model-call accounting, restart recovery, schema compatibility, and safe error messages.
- Run the narrowest relevant test while iterating. Before handoff, run `npm test`; also run `npm run test:e2e` for changes to `public/`, HTTP/browser flows, or their fixtures.
- Tests should not depend on a developer's `.env`, persistent `data/evals.sqlite`, network availability, test ordering, fixed ports, or wall-clock delays when an injected dependency is practical.

## Deployment changes

- Keep Docker runtime inputs limited to active server files; do not package `.env`, local data, test fixtures, or permanent AWS credentials.
- Treat provisioning and release scripts as production-sensitive. Preserve destination/account validation, immutable release identities, least-privilege IAM, graceful draining, and data backups.
- For deployment-related changes, run `npm test` and the relevant shell syntax checks in an environment with Bash. Build and smoke-test the Docker image when Docker is available.
- Do not provision, deploy, tear down infrastructure, enable `AWS_DEPLOY_ENABLED`, rotate secrets, or change live resources unless the user explicitly requests it.
