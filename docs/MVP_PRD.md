# Evolv MVP: Product Requirements (v0.2)

> v0.2: console moved to its own origin (port 3002) with a bearer-token header and no cookies; app origin limited to submit, cancel and progress (SEC-9, SEC-12, SEC-13, sections 4, 10, 11, 13).

Source: the full Evolv PRD v1.0 (docs/PRD.md). This file is the trimmed first build. If the two disagree, this file wins for the MVP. Anything not listed here is out of scope until the MVP is accepted.

## 1. What the MVP proves

A user types a request in a chat box. An AI (Claude) edits the app's own source code in a staging copy. The copy is checked automatically. Only if it passes does it go live as a new saved version. The user can always undo, and a fixed recovery console always works, even if the AI breaks the app.

## 2. Scope

**In the MVP**
- Supervisor with two origins (see section 4): the app origin on port 3000 (reverse proxy plus a tiny submit/cancel/progress API) and the console origin on port 3002 (recovery console plus the full JSON API).
- App process on port 3001: sandboxed, AI-written, restarted on crash.
- Seed app: a minimal home page, `/health`, and a chat widget.
- Agent loop with 7 tools: list_files, read_file, search, write_file, edit_file, delete_file, finish.
- Staging workspace (git worktree), verifier, version store (git), promote and discard.
- Live progress over Server-Sent Events, and cancel.
- Versions: list, diff, undo, restore, factory reset.
- Console on its own origin (`http://127.0.0.1:3002`): Chat, History, Status, Logs, Danger zone. Port 3000 `/_evolv` is only a pointer page to it.
- Token ledger, total budget, per-change cap, "used / budget" display.
- Two providers: the Anthropic Messages API (default) and, added after B3, any OpenAI-compatible Chat Completions server (OpenAI, Groq, local servers) through `AI_PROVIDER=openai` and `AI_BASE_URL`. See section 16.
- Persistent `data/` folder that survives code changes.

**Cut from the MVP (build later)**
- Review mode (approve before promote).
- The automatic repair attempt after a failed verification.
- Follow-up context (last 5 summaries sent to the agent).
- ~~The OpenAI-compatible adapter (Groq, Gemini, local models).~~ Built after B3: see section 16. Gemini's compatibility endpoint is untested.
- The accessibility pass.
- Request-wait during version swap (a brief error during the swap is acceptable).
- Packaging and docs polish.

**Never in v1:** multiple users, accounts, network hosting, the AI editing the supervisor or console, npm installs, shell commands, binary assets.

## 3. Tech stack and constraints

- Node.js (installed: v26.13.1; the PRD targets 24 LTS), JavaScript ES modules, JSDoc types.
- No runtime dependencies. Built-ins only: `http`, `fetch`, `child_process`, `fs`, `crypto`, `node:test`.
- System `git` through `execFile` only, never through a shell.
- Plain HTML, CSS and JS for the console and seed app. No build step, no framework.
- Windows is the development machine. Use `path` utilities everywhere, never hard-code `/` or `\`, and test process kill and restart on Windows.

## 4. Architecture (changed from the full PRD: two origins)

```
Browser (app pages)   -> 127.0.0.1:3000  SUPERVISOR, APP ORIGIN
   /_evolv/api/changes...  -> submit, cancel, read progress ONLY
   /_evolv                 -> pointer page linking to the console origin
   everything else         -> proxy -> 127.0.0.1:3001 APP (sandboxed)

Browser (console)     -> 127.0.0.1:3002  SUPERVISOR, CONSOLE ORIGIN
   /                       -> console UI (public shell, holds no secret)
   /api/*                  -> full API, bearer token + strict Origin required
   never proxies to the app

SUPERVISOR also holds: agent runner -> Anthropic API,
workspace (staging) -> verifier -> version store (git), process manager
```

Why two origins: app pages are AI-written and run in the browser. If the console lived on the same origin, app JavaScript could read console pages or call destructive routes with the browser's own credentials. A different port is a different origin, so the browser blocks that. Undo, restore, reset, history, status and logs are not served on port 3000 at all.

Project layout:

```
evolv/
  supervisor/  main.js agent.js tools.js workspace.js verify.js process.js versions.js budget.js
               config.js proxy.js api.js auth.js console-link.js pathguard.js changes.js
               providers/anthropic.js
  console/     index.html console.js console.css
  seed/        server.js evolv.json public/
  test/
  app/         created at runtime, own git repo, git-ignored
  state/       usage.json (token ledger), console.key and workspaces/ (staging copies), git-ignored,
               unreadable by the app sandbox
  .env.example
```

## 5. The change lifecycle

1. **Admit:** valid request (1 to 4,000 chars), no other change running, budget left. Otherwise refuse (busy = 409, budget = 429).
2. **Stage:** fresh git worktree from the current version.
3. **Agent edits:** tool loop in the workspace only. Limits: 40 steps, CHANGE_TOKEN_LIMIT tokens, 5 minutes.
4. **Verify:** start the staged app on a spare loopback port with the same sandbox and a **fresh, empty `data/`** (verification never sees real data, and its `data/` is discarded with the workspace). Pass only if all hold:
   - `server.js` exists and `evolv.json` is valid (checked before anything is started). Smoke routes must each start with a single `/`, contain no spaces, backslashes or control characters, be at most 200 characters, and number at most 50. A route can never make the verifier call another host.
   - GET /health returns 200 within VERIFY_TIMEOUT_MS. An app that exits right after starting fails at once.
   - GET / returns 200 and HTML.
   - **Recovery link (addition to the original four checks):** the home page contains a real link (an `<a href>`, not a comment, script or text) to the recovery console at the correct address: `/_evolv`, or exactly `http://127.0.0.1:CONSOLE_PORT/` or `http://localhost:CONSOLE_PORT/`. `/_evolv` is the stable address: the supervisor serves a pointer page there that links to the configured console origin. A change cannot remove or redirect the user's only way back.
   - Every route in `app/evolv.json` smoke list returns below 500 (a 404 is fine).
   - The process is still alive, and still answers /health, after a 2 second settle.
   The result is a pass or a failure with a plain-language reason, the per-check results, and the app's own output (colour codes and control characters removed, real paths replaced, capped at about 4,000 characters).
5. **Promote:** commit as a new version, swap the live app, tell the browser to reload. Precisely: refuse, touching nothing, if the live files were edited outside Evolv or the live version moved on since staging; commit in the workspace; stop the live app; fast-forward `app/` to the commit; start it; wait for /health. `data/` is never touched. Once promotion begins it cannot be cancelled (`too_late`). If the new version does not become healthy, it is rolled back automatically (see M-R3).

Any failure or cancel discards the workspace. The live app is untouched. No repair attempt in the MVP.

## 6. Requirements (all required for the MVP)

**Changes**
- M-C1 Submit a change from the in-app chat or the console.
- M-C2 One change at a time. Others get "busy", not queued.
- M-C3 Live progress: current step and file being read or edited.
- M-C4 Cancel a running change and discard its workspace.
- M-C5 On success show the summary, changed files and a diff link, then reload.
- M-C6 On failure show a plain-language reason, the verifier output, and that the app is unchanged.

**Versions**
- M-V1 Each accepted change is a version: id, time, request, summary, changed files, token cost. Stored in the version's git commit message as a single `Evolv-Meta: {json}` line (the summary is forced onto one line and the request is JSON-escaped, so neither can forge another metadata line).
- M-V2 Undo creates a new version equal to the one before the latest. History is never rewritten.
- M-V3 Restore creates a new version equal to any earlier one.
- M-V4 Undo and restore go through verification. If the target does not start, keep the live app and say so.
- M-V5 History lists versions newest first, with a diff for each.
- M-V6 Factory reset restores the seed, after confirmation, with an optional wipe of `data/`.

**Runtime and data**
- M-R1 First start creates the app from the seed and records version 1.
- M-R2 `data/` is the only place the app writes. It is not versioned and survives everything except an opted-in wipe.
- M-R3 Crash restart with backoff. After 3 crashes in 60 seconds, stop and let the console offer Undo and Restore.
  - **Addition (B3): automatic rollback of a failed promotion.** If a version that passed verification does not become healthy after the swap (for example it cannot cope with the live `data/`, which verification does not see), Evolv rolls back automatically: it stops the app, moves the branch back to the previous version, and starts that version again. That version never appears in History, because it never became a working version; this is the only place the version branch moves backward. `data/` is untouched. The change fails with code `swap_failed`, and the user is told in plain words (for example "The new version did not start properly, so Evolv put your previous version (version 1) back. Nothing was lost.") in the chat widget, in the console Status page as a Notice (kept until the next change succeeds), and in the Logs. If even the restored version cannot be confirmed healthy, the message says so and points to the recovery console.
- M-R4 Keep the last 500 log lines, viewable in the console.

**Usage**
- M-U1 Count input and output tokens on every AI call in a persistent ledger. Totals survive restarts.
- M-U2 Enforce TOKEN_BUDGET. When spent, refuse new changes before any AI call, and stop a running one at its next step.
- M-U3 Enforce CHANGE_TOKEN_LIMIT per change.
- M-U4 Show "used / budget" and each version's cost.

## 7. Agent tools

| Tool | Input | Rule |
|---|---|---|
| list_files | dir? | Excludes hidden and protected paths |
| read_file | path, from_line?, to_line? | Line numbers, max 2,000 lines |
| search | pattern, dir? | Max 100 matches. `pattern` is **literal text, not a regular expression** (see note below) |
| write_file | path, content | Max 200 KB |
| edit_file | path, old_text, new_text | old_text must occur exactly once, else return an error |
| delete_file | path | Cannot delete the entry point or evolv.json |
| finish | summary | One sentence for a non-developer; moves to verify |

A tool error goes back to the agent as a result. It never crashes the loop.

**Deliberate change from the full PRD: `search` is literal, not regex.** The agent chooses the pattern, and a catastrophic regular expression such as `(a+)+$` blocks Node's single thread. The supervisor would freeze, and the recovery console with it (verified: a regex-based search froze the test run until killed). Matching is plain, case-sensitive text, 1 to 200 characters. Search also skips hidden and protected paths, binary files and files over 1 MB.

**Path rules (one strict set on every OS, enforced by `supervisor/pathguard.js`):** forward slashes only; no `..`, absolute paths, drive letters or `:`; no trailing dot or space, reserved device names or 8.3 short names (`GIT~1`); no symlinks or junctions anywhere on the path. Protected and invisible, in any letter case: any name starting `.git` (so `.gitignore` and `.gitattributes` too), any name starting `.env`, `node_modules` at any depth, and `data/` at the app root. Protected paths are reported to the agent exactly like missing ones.

**Token accounting:** counts input plus output tokens from every call. A call interrupted by cancel or timeout has unknown real usage, so it is counted as an estimate of one token per 4 characters of the request, rounded up. A damaged `state/usage.json` blocks new changes with a plain-words message naming the file. It is never reset to zero silently.

System prompt must say: edit only what the request needs; the app contract (below); the chat widget must keep working and keep calling the supervisor API; the "Recovery console" link must stay; finish with a one-sentence summary.

## 8. App contract

- Entry point `app/server.js`, listens on `process.env.PORT`.
- `GET /health` returns 200.
- `app/evolv.json` holds `{ "smoke": ["/", ...] }`, kept up to date by the agent.
- Node built-ins only. Writes only to `data/`.

## 9. Security (all mandatory, none negotiable)

- SEC-1 Tools reach only the staging workspace. Normalise every path, resolve symlinks, reject absolute paths and `..`.
- SEC-2 Protected and invisible: `.git/`, `data/`, `node_modules/`, `.env*`, anything outside the app.
- SEC-3 Nothing can modify the supervisor, console, config or version history.
- SEC-4 App runs under Node's permission model: read its own folder only, write `data/` only, no process spawn, no native addons, no workers. Confirm the exact flag names for the installed Node version with `node --help` before use.
- SEC-5 App environment is only PORT, DATA_DIR, NODE_ENV. Never any key.
- SEC-6 Memory cap 256 MB (`--max-old-space-size`). CPU watchdog restarts the app if pinned at 100% for 30 seconds.
- SEC-7 App and verifier ports bind to 127.0.0.1 only.
- SEC-8 Supervisor binds to 127.0.0.1 only.
- SEC-9 Console authentication. No cookies anywhere. Every `/api/*` request on the console origin needs `Authorization: Bearer <console key>` and an Origin on the strict allow-list (`http://127.0.0.1:<console port>` or `http://localhost:<console port>`). Writes need the Origin header; reads may omit it but a present Origin must match. The key is 256 bits, stored in `state/console.key`, and is held only by the console page (arrives once in the URL fragment, kept in that origin's `localStorage`, sent only in the Authorization header). A custom header forces a CORS preflight, which the supervisor always refuses. Comparison is constant-time.
- SEC-12 Origin separation. Undo, restore, reset, history, diff, status and logs are served only on the console origin. The app origin serves only: submit a change, cancel a change, and read a change's progress (GET). Those three routes are the complete table, and any other `/_evolv` path on the app port returns 404. Change ids are 128-bit random and unguessable, carry no secrets, and the progress stream carries none either.
- SEC-13 Both origins check the Host header (DNS rebinding), refuse CORS preflights, and never send `Access-Control-*` headers. Console responses send `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff` and `Cross-Origin-Resource-Policy: same-origin`. A console lockout after failed logins is deliberately NOT implemented: the app process shares the loopback network and could use a lockout to disable the recovery console. The 256-bit key makes guessing infeasible instead.
- SEC-10 Validate and size-limit all inputs.
- SEC-11 The API key comes only from `.env`. Never logged, never sent to the browser, never in the agent's context. It is sent only to the configured AI address (see section 16 for how that address is constrained).
- Accepted risk: the sandbox does not block outbound network access. Node's `--allow-net` is all-or-nothing and is required for the app to listen on its port. Document it.
- Accepted MVP risk: app code can still submit and cancel change requests. Any page or server code in the app can call the app-origin submit and cancel routes, because the chat widget is itself app code. It cannot undo, restore or reset, and is limited by the single-change-at-a-time rule, TOKEN_BUDGET and CHANGE_TOKEN_LIMIT. Review mode (approve before promote), currently cut, is the real mitigation. A per-origin submit rate limit may be added later.
- Environment note (Windows): libuv copies 11 OS variables into every child process. The app is given them as empty strings, except `SYSTEMROOT`, which Node needs on Windows. No key or user value reaches the app.

## 10. API (JSON)

**App origin, port 3000, under `/_evolv/api`. App pages may use only these three:**
POST /changes, GET /changes/:id/events (SSE: accepted, staged, step, tool, verify, promoting, done, failed), POST /changes/:id/cancel.
Writes need the exact app Origin. `:id` must be a 22 to 64 character random id.

- `POST /changes` takes `Content-Type: application/json` and `{"request": "..."}` (1 to 4,000 characters, bodies over 16 KB refused). It answers `202 {"id"}` after admission checks (validation, one change at a time, budget, usable ledger, API key) and before any staging or AI call. The first event (`accepted`) exists before the id is returned, so a client can subscribe immediately.
- `POST /changes/:id/cancel` answers 200 `{"cancelled":true}`, 404 for an unknown or finished change, or 409 `too_late` once promotion has begun.
- `GET /changes/:id/events` is a Server-Sent Events stream: numbered events (`Last-Event-ID` resumes), a heartbeat comment every 15 seconds, closed after `done` or `failed`. It carries no secrets and no file contents. Verifier output appears only on `failed`, with real paths replaced by `<app>`, control characters removed and size capped. Limits, because app pages are untrusted: at most 5 streams per change and 20 in total (429 `rate_limited`); only the last 5 finished changes are kept, for 15 minutes; at most 500 events per change; a client that stops reading is disconnected. After a supervisor restart the history is gone (404), and the widget says the connection was lost.
- `done` carries `{version, summary, files, tokens, steps}` and is announced only after the runner is free and the workspace is gone, so the widget may start another change right after reloading. `failed` carries `{code, message, output?, checks?}`; every failure message says the app was not changed, or that the previous version was put back.

**Console origin, port 3002, under `/api`. Bearer token and console Origin required on every call:**
POST /changes, GET /changes/:id/events, POST /changes/:id/cancel, GET /versions, GET /versions/:id/diff, POST /versions/undo, POST /versions/:id/restore, POST /reset, GET /status, GET /logs.

Unauthenticated: 401 `unauthorized`. Wrong Origin or Host: 403 `forbidden`.

Errors: `{ error: { code, message } }` with codes busy, budget_exhausted, invalid_request, verify_failed, agent_limit, provider_error, cancelled, plus unauthorized, forbidden, not_found, internal_error, ledger_unreadable (503, a damaged usage file), swap_failed (500, a promoted version did not become healthy and was rolled back), no_changes (422, the agent finished without changing anything), too_late (409, cancel after promotion began) and rate_limited (429, too many progress streams). `verify_failed` is 422; `busy` and `cancelled` are 409.

## 11. Configuration (.env, never committed)

```
AI_PROVIDER=anthropic
AI_API_KEY=
AI_MODEL=claude-sonnet-5-5
TOKEN_BUDGET=300000
CHANGE_TOKEN_LIMIT=100000
AGENT_MAX_STEPS=40
VERIFY_TIMEOUT_MS=8000
PORT=3000
CONSOLE_PORT=3002
```

`CONSOLE_PORT` defaults to `PORT+2`. It must differ from `PORT` and from the app port (`PORT+1`).

## 12. Build plan (one at a time; commit after each green step)

- **B1 Foundation:** supervisor start-up, seed, version 1, sandboxed app process, proxy, console Status and Logs. Sandbox tests (hostile app) pass.
- **B2 Agent:** path guard and tools with unit tests, workspace staging, budget ledger, fake provider, Anthropic adapter, tool loop. A fake-provider change succeeds end to end. Until B3 there is no verify or promote: a finished change reports its summary, changed files, diff and token cost, then the staging copy is discarded and the live app is untouched. No HTTP routes and no chat-widget wiring yet; both arrive in B3.
- **B3 Safe promotion:** verifier, promote and discard, SSE progress, cancel, and the chat widget connected to POST /changes. The widget only appears in a freshly seeded `app/`; an existing `app/` keeps the widget it was seeded with.
- **B4 History:** undo, restore, reset, diff, console History and Chat pages.

## 13. Acceptance criteria

1. Fresh clone, `.env`, one start command: seed app at http://localhost:3000, and the recovery console on port 3002 opened with `npm run console`, showing version 1 in History.
2. "Change the background to dark navy and the text to white" goes live within 30 seconds as version 2 with a correct diff.
3. "Add a notes page where I can type and save notes" adds a route and page, writes to `data/`, and the notes survive a restart and a later change.
4. A change whose code crashes on start (forced with the fake provider) is reported as failed and the live app keeps serving the previous version with no downtime.
5. After a change that blanks the page but passes health checks, the console still works and Undo restores the previous look.
6. Restore to version 1 works and `data/` is intact.
7. Every sandbox test fails as expected: read `../.env`, write outside `data/`, spawn a process, call the API without a token.
7a. Hostile-page test: from the app origin, calls to reset, undo and restore fail (404 on port 3000; 401 or 403 on port 3002), with or without the real token, and the handlers never run. The hostile app process cannot read `state/console.key` and cannot call the console API.
8. With a tiny TOKEN_BUDGET, the next change is refused before any AI call and the UI says why.
9. The automated test suite passes.

## 14. Tests

- **Unit:** path guard (`..`, absolute, symlink, protected), each tool including edit_file with 0 and 2+ matches, budget ledger, request validation, adapter tool-call mapping.
- **Integration (fake provider = local HTTP server returning canned tool calls):** success, crash on start, smoke route 500, step limit, budget exhausted mid-change, cancel, undo, restore, reset.
- **Sandbox:** a hostile seed app attempts the four attacks above. All must fail.
- **End to end:** manual run with real Claude against criteria 2 and 3.

## 15. Dev-only demo mode (outside the MVP acceptance criteria)

`npm run demo` starts the normal supervisor with a scripted stand-in for the AI, so the widget, live progress, promotion, rejection and rollback can be tried in a browser without an API key. It exists for demonstration and manual testing only.

- **How it is selected.** Only by running the separate `supervisor/demo.js` entry point. It is not a `.env` setting or an environment variable, so it cannot be left on by accident, and `npm start` (`supervisor/main.js`) has no way to enable it. The AI-written app cannot read `supervisor/` or `.env`, cannot start a process, and the agent's path guard cannot see them, so neither can switch it on.
- **What is real.** The tools, path guard, sandbox, verifier, promotion, rollback, token ledger, SSE and every authentication, Origin and Host check are exactly the production code. Only the model is scripted, and its tool calls pass through the same guard as a real model's.
- **Isolation.** It uses its own `demo-data/` folder (git-ignored, safe to delete) for the app, state, console key and ledger, so the real `app/` and `state/` are never touched. It never builds the real provider, ignores any key in `.env` or the environment, and makes no network call.
- **Loud banner.** A red "DEMO MODE" banner appears on the console page (before sign-in), on the `/_evolv` pointer page, in Status (`mode: "demo"`) and in the terminal, plus a `[DEMO]` title prefix. It is deliberately not placed in app pages, which the AI can edit.
- **Scenarios,** chosen by a word in the request, checked in this order: `rollback`, `crash`, `nolink`, `slow`, `navy`, `page`; anything else gets a "nothing to apply" result. `navy` toggles the colours. `page` adds an About page. `crash` and `nolink` are rejected by the verifier. `rollback` passes verification and then fails on the demo's live `data/`, so it is rolled back. `slow` can be cancelled.

## 16. OpenAI-compatible provider (added after B3)

`AI_PROVIDER=openai` talks to any server that speaks OpenAI's Chat Completions API (`POST {AI_BASE_URL}/chat/completions`): OpenAI, Groq, and local servers such as Ollama. It has the same interface as the Anthropic adapter, so the agent loop, tools and every safety rule are unchanged.

**Settings (`.env`).**
- `AI_PROVIDER=openai`, `AI_MODEL` (required; the Claude default makes no sense here), `AI_API_KEY`.
- `AI_BASE_URL` (optional; default `https://api.openai.com/v1`).

**Where the key may go (this is why `AI_BASE_URL` is constrained).** `AI_BASE_URL` decides where the API key is sent. It is read only from `.env` (which the AI-written app and the agent can neither read nor write) and is validated at start-up and again by the adapter: `https` only, with `http` allowed only for `localhost`, `127.0.0.1` or `[::1]` (anywhere else it would send the key unencrypted); no login or password in the address; no `?` or `#` part; not the full `/chat/completions` address. A bad value is refused with a plain message that never echoes the value. `AI_BASE_URL` with `AI_PROVIDER=anthropic` is an error, so it can never redirect the Anthropic key. Redirects are never followed. The console Status page shows the provider, the model and the host requests go to (never the key), and the terminal prints the same line at start-up. This reverses the earlier rule that the base URL is code-only; `.env` is user-controlled, so it is accepted with these guards.

**The key.** Optional only when the base URL is on this computer; otherwise a change is refused before anything is sent. It is held privately, sent only in the `Authorization` header, scrubbed from every error text, and never logged or sent to the browser.

**Mapping.** Tool definitions become `{type:"function", function:{name, description, parameters}}`. `tool_calls[].function.arguments` arrives as a JSON string and is parsed. Arguments that cannot be read (malformed or cut-off JSON, not an object) do not stop the change: the call is returned with an `inputError`, the tool is NOT run, the model gets an error result explaining why, and the history sent back contains `{}` for that call so strict servers do not reject it. Each tool result is its own `tool` message, in order. Usage maps `prompt_tokens` to input and `completion_tokens` to output (cached tokens are already included, not added again); a reply with no usable usage is estimated, rounded up, and flagged. The output limit is sent as `max_tokens` (a constructor option can name it `max_completion_tokens` for models that require that).

**Errors, all `provider_error`.** 401/403: the key was rejected. 404: check `AI_MODEL` and `AI_BASE_URL`. 429: retried twice (honouring `Retry-After` up to 10 seconds), then a plain message with a wait hint; a 429 for an account with no credit (`insufficient_quota`) is not retried. 5xx and network errors: retried twice. Other 4xx: the server's message with the key scrubbed. Redirects, HTML error pages, an empty `choices`, and a 200 carrying an error are each reported plainly.
