# Evolv: how it works, start to end

Written from the code as it is today (not from the PRD). Where the PRD plans something that is not built yet, it says so.

## 1. The big picture

Evolv is a small web app that **edits its own source code when you ask in plain English**. Three separate parts run at once:

```
 Browser
   |  http://127.0.0.1:3000                     http://127.0.0.1:3002
   v                                            v
+------------------------------------------------------------------+
| SUPERVISOR  (supervisor/main.js, trusted, holds the API key)      |
|                                                                  |
|  App port 3000                    Console port 3002              |
|   /_evolv/api/*  -> 3 routes      /api/*  -> bearer token needed |
|   everything else -> proxy        /  -> recovery console UI      |
+--------|-------------------------------------|-------------------+
         | proxy                               | (never proxies to the app)
         v
+--------------------+       +---------------------------------+
| APP (sandboxed)    |       | AI PROVIDER (Groq / OpenAI /    |
| app/server.js      |       | Anthropic) over HTTPS           |
| port 3001          |       +---------------------------------+
| Node --permission  |            ^
+--------------------+            | only the supervisor talks to it
```

| Part | Port | Who can reach it | Job |
|---|---|---|---|
| Supervisor, app face | 3000 | Browser | Serves your app (by proxy) and exactly three change routes |
| Supervisor, console face | 3002 | Browser with a token | Recovery console: status, logs, plus the same three change routes |
| App | 3001 | Supervisor only | The actual website. Runs sandboxed |

Ports come from `.env`: `PORT` (3000), app = `PORT + 1`, `CONSOLE_PORT` (default `PORT + 2`). Everything binds to `127.0.0.1` only.

**Why two ports:** a browser treats each port as a separate origin. App pages (which the AI can rewrite) can never call the console's full API, because the console is on a different origin and needs a secret token.

## 2. Startup (`npm start` -> `supervisor/main.js`)

1. `config/config.js` reads `.env` and validates it. Bad values stop the start with a clear message.
2. `middleware/auth.js` creates or loads the console key at `state/console.key` (256-bit random). It is outside `app/`, so the sandboxed app cannot read it.
3. `models/versions.js` seeds `app/` from `seed/` on first run. `app/` is its own git repository, so every saved version is a commit.
4. `models/workspace.js` sweeps leftover staging folders from a crash.
5. `models/ledger.js` loads the token ledger `state/usage.json`. A damaged file blocks new changes but does not stop the supervisor.
6. The AI provider is chosen: `AI_PROVIDER=openai` gives `providers/openai.js` (also used for Groq), otherwise `providers/anthropic.js`.
7. Both HTTP servers start (app face on 3000, console face on 3002), then `models/app-process.js` starts the sandboxed app on 3001.
8. The terminal prints the app URL, the AI provider and model (never the key), and the signed-in console link. `npm run console` (`console-link.js`) opens that link again.

## 3. Every endpoint

### App origin, port 3000

| Request | What happens |
|---|---|
| `GET /health`, `GET /`, any page | Proxied to the app on 3001 (`controllers/proxy.controller.js`). If the app is down, a "The app isn't responding" page links to the console. |
| `GET /_evolv` | A pointer page linking to the console. |
| `POST /_evolv/api/changes` | Submit a change. Body `{"request": "..."}`. Answers `202 {id}`. |
| `POST /_evolv/api/changes/:id/cancel` | Cancel the running change. |
| `GET /_evolv/api/changes/:id/events` | Progress as Server-Sent Events (SSE). |
| anything else under `/_evolv` | 404. Undo, restore, history, status and logs do **not** exist on this port. |

### Console origin, port 3002

| Request | Auth | What happens |
|---|---|---|
| `GET /`, `/console.js`, `/console.css` | none | The console page (only these 3 files can be served). |
| `GET /api/status` | Bearer token | App state, pid, uptime, restarts, current version, token usage, provider and model, Node version. |
| `GET /api/logs` | Bearer token | Recent app output lines. |
| `POST /api/changes`, `/changes/:id/cancel`, `GET /changes/:id/events` | Bearer token | Same three change routes as the app port. |

Undo, restore and reset are described in the PRD but **are not built yet**. The console has no such routes today.

### Checks on every request (`middleware/http.js`, `routes/`)

- `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`. This blocks DNS-rebinding.
- `OPTIONS` (CORS preflight) is refused, so another site cannot call the API with custom headers.
- `Origin` must match exactly for writes.
- Bodies must be `application/json` and at most 16 KB.
- Console `/api/*` needs `Authorization: Bearer <key>`, compared in constant time (`middleware/auth.js`). There are no cookies.
- Change ids are 128-bit random, so a page cannot guess another change to watch or cancel.

## 4. A change from start to end ("Add an about page")

```
chat widget        supervisor                         AI provider      git / sandbox
(seed/public/      (changes.js, agent.js ...)
 chat.js)
   |  POST /_evolv/api/changes {request}
   |------------------->  validate text (1-4000 chars)
   |                      busy? budget left? provider ready?
   |<---- 202 {id} ------ new change id, phase "accepted"
   |  GET .../:id/events  (SSE)
   |------------------->  "staged": git worktree of HEAD ------------------> staging copy
   |                      PHASE agent  (loop, up to AGENT_MAX_STEPS, 5 min)
   |                        ledger check -> POST /chat/completions ->
   |                        <- tool call (read_file ...) --------
   |                        run tool in staging copy only ------------------> files
   |   <- SSE: step, tool(name, file, modelMs, tokens)
   |                        ... repeat ... finish("one sentence")
   |                      any files changed? (else "no_changes")
   |                      PHASE verify (6 checks, section 6)
   |   <- SSE: verify {check, status}
   |                      PHASE promote (point of no return)
   |                        commit, stop app, fast-forward app/, start app,
   |                        wait for /health, else roll back
   |   <- SSE: done {version, summary, files, tokens, steps}
   |                      discard staging copy
```

### Step by step

1. **Submit.** The widget in `seed/public/chat.js` calls `POST /_evolv/api/changes`. `controllers/change.controller.js` hands the text to `ChangeRunner.start()` (`changes.js`).
2. **Admission.** It rejects, before any AI call, if the text is empty, over 4,000 characters or contains control characters. It also rejects if another change is running (`busy`, only one at a time), if the token budget is spent or the ledger is damaged, or if the provider has no key.
3. **Subscribe.** The widget opens `GET .../events` (SSE) and shows progress. `models/event-hub.js` (`EventHub`) keeps recent events per change and scrubs real file paths from everything it sends.
4. **Stage.** `models/workspace.js` runs `git worktree add --detach <state>/workspaces/<id> HEAD`. The agent works on this copy, never on the live app. Git is always run with `execFile`, never through a shell.
5. **Agent loop** (`services/agent.js`), per step:
   - `ledger.checkBeforeCall()` enforces the total budget and the per-change cap before spending anything.
   - `provider.complete()` sends the system prompt, the whole conversation and the tool list to the AI.
   - Tokens used are recorded in the ledger.
   - Each tool call goes through `services/tools.js` and runs inside the staging copy.
   - The result is added to the conversation and the loop repeats.
   - It ends when the model calls `finish`, or on a limit (steps, 5 minutes, token cap, cancel).
6. **Verify** (section 6). Any failure discards the staging copy and the live app is untouched.
7. **Promote** (`services/promote.js`): commit in the staging copy, stop the app, `git merge --ff-only` into `app/`, restart, wait for `/health`. If it is not healthy, roll back to the previous version automatically.
8. **Finish.** The runner is released, the staging copy is deleted, and only then are `done` or `failed` announced.

## 5. The AI call (`supervisor/services/providers/`)

| | OpenAI-compatible (`openai.js`, used for Groq) | Anthropic (`anthropic.js`) |
|---|---|---|
| URL | `<AI_BASE_URL>/chat/completions` | `https://api.anthropic.com/v1/messages` |
| Key header | `Authorization: Bearer <key>` | `x-api-key` |
| Body | model, max tokens (8192), messages, tools | model, max_tokens, system, tools, messages |
| Timeout | 120 s per request | 120 s per request |

Both providers keep the key in a private field and scrub it from every error text. The agent loop never sees it. `AI_BASE_URL` must be https, except for a server on this computer.

**Tools the AI may call** (`services/tools.js`): `list_files`, `read_file`, `search`, `write_file`, `edit_file`, `delete_file`, `finish`. Every path first passes `pathguard.js`. The guard allows only forward slashes and rejects `..`, absolute paths, drive letters, Windows tricks, symlinks, and `.git*`, `.env*`, `node_modules` and `data/`. The AI cannot reach `supervisor/`, `console/`, `.env` or git history at all, because its tools only see the staging copy of `app/`.

**Error handling:**

| Provider answer | What Evolv does |
|---|---|
| 401, 403 | Stops: "rejected the API key" |
| 404 | Stops: wrong model or address |
| 429 (rate limit) | Waits as long as `Retry-After` says (up to 5 retries, 60 s max each) and tells the user via a `waiting` event. No credit left stops immediately. |
| 5xx, network error | Retries (2 times), then stops |
| 400 "tool_use_failed" / "Parsing failed" (the model wrote a broken tool call) | Treated as a reply with no tool call. The model is told and retries. Stops after 3 in a row. |
| any other 400 | Stops with the provider's message |

## 6. Verification (`services/verify.js`)

Runs the staged app in its own sandbox on a free port and checks, in order:

1. `files`: the app files and `evolv.json` (including its "smoke" list) are valid.
2. `start`: the app starts and `/health` returns 200.
3. `home`: `GET /` returns HTTP 200 with an HTML page.
4. `console_link`: the home page still links to the recovery console (`/_evolv`, or the console address). Without it there is no way back.
5. `smoke`: every route listed in `evolv.json` ("smoke") answers with a status below 500. This is why the agent adds a new page's route there.
6. `alive`: it is still running after `settleMs` (2 s).

Limits: `VERIFY_TIMEOUT_MS` (default 8000). Output shown to the user has real paths removed and is capped at 4,000 characters.

## 7. The sandbox (`models/app-process.js`)

The app runs as `node --permission --allow-fs-read=<app> --allow-fs-write=<app>/data --allow-net --max-old-space-size=256 server.js`.

- It can read its own folder and write only `data/`.
- It cannot start child processes, workers or native addons (those flags are deliberately not passed).
- Its environment is exactly `PORT`, `DATA_DIR`, `NODE_ENV`. The API key is never passed.
- On Windows the supervisor blanks the 11 variables that libuv would otherwise copy in (`USERNAME`, `PATH`, and so on). `SYSTEMROOT` is kept because Node's crypto crashes without it.
- Accepted risk: `--allow-net` is needed to listen on a port, and Node cannot restrict outbound traffic more finely.
- Crash handling: the app restarts after 500 ms, 1 s and 2 s. After 3 crashes inside 60 s it gives up and logs "use Undo or Restore in the console".

## 8. The token budget (`models/ledger.js`)

- `TOKEN_BUDGET`: total across all changes (`state/usage.json`).
- `CHANGE_TOKEN_LIMIT`: the cap for one change.
- Both are checked before each AI call and recorded after it. An interrupted call is counted at an estimate (characters divided by 4, rounded up).
- Each `tool` event now carries `modelMs`, `inputTokens` and `outputTokens`, so you can see how long each model call took.

## 9. Progress events (SSE)

The widget and console get these over `GET .../events`:

| Event | When |
|---|---|
| `accepted` | The change was admitted. |
| `staged` | The staging copy exists. |
| `step` | A new agent step starts. |
| `tool` | The model called a tool (name, file, `modelMs`, tokens). Never file contents. |
| `waiting` | The provider is rate-limiting. The wait is shown to the user. |
| `verify` | One check running, passed or failed. |
| `promoting` | The point of no return. Cancel is no longer possible. |
| `done` | Success: version, summary, files, tokens, steps. |
| `failed` | Failure: code and a plain message ending in "Your app was not changed." |

At most 5 streams per change and 20 in total are kept. A heartbeat is sent every 15 s, and history is kept for 15 minutes.

## 10. Files and who may touch them

| Path | Role | Can the AI edit it? |
|---|---|---|
| `supervisor/` | The trusted core | No |
| `console/` | Recovery UI | No |
| `.env`, `state/` | Secrets, ledger, console key | No |
| `app/` (from `seed/`) | The live app, a git repo | Only through a staged, verified change |
| `app/data/` | The app's runtime data | No (the app itself may write it) |
| `seed/` | The starting app | No |
| `test/`, `test-fixtures/` | Tests | No |

## 11. Where the time goes

A typical change takes 3 to 6 model calls (seconds each), then verify (about 3 to 6 s, mostly the app starting plus the 2 s settle), then promote (one restart). Fewer steps is the biggest lever. A model that calls tools correctly the first time helps most, because every broken tool call costs a full extra round trip.

## 12. Code layout (`supervisor/`)

MVC-style, with Node built-ins only. The AI agent can never edit any of it.

| Folder | Role | Files |
|---|---|---|
| `main.js`, `demo.js`, `console-link.js` | Entry points (start the servers, demo mode, open the console) | |
| `constants/` | Every fixed value: limits, patterns, HTTP headers, messages, provider defaults. Data only, no imports. | `limits.js`, `patterns.js`, `http.js`, `messages.js`, `changes.js`, `sandbox.js`, `storage.js`, `providers.js`, `demo.js`, `index.js` |
| `config/` | Reads and validates `.env` | `config.js` |
| `models/` | State and data: token ledger, git versions, staging workspaces, the sandboxed app process, progress events | `ledger.js`, `versions.js`, `workspace.js`, `app-process.js`, `event-hub.js` |
| `services/` | Business logic: the agent loop, change lifecycle, verification, promote, tools, AI providers | `agent.js`, `change-runner.js`, `verify.js`, `promote.js`, `tools.js`, `demo-provider.js`, `providers/` |
| `controllers/` | Request handlers | `change.controller.js`, `console.controller.js`, `proxy.controller.js` |
| `routes/` | Which URL goes where, per origin | `app.routes.js`, `console.routes.js`, `router.js` |
| `middleware/` | Host/Origin checks, body limits, security headers, bearer token | `http.js`, `auth.js` |
| `security/` | The path guard | `pathguard.js` |
| `views/` | HTML the supervisor returns (the pointer page, the "app is down" page) | `html.js` |

Tests live in `test/`, in folders that mirror these (`models/`, `services/`, `controllers/`, `routes/`, `security/`, `config/`, `constants/`, plus `e2e/`). Shared helpers are in `test-fixtures/` (`helpers/`, `fakes/`, `apps/`), outside `test/` on purpose: `node --test` runs every file inside a `test/` folder.
