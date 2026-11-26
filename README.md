# Evolv

A small web app that edits its own source code when you ask in plain English. Node built-ins only: no npm packages, no build step.

## Run it
1. Copy `.env.example` to `.env` and set `AI_PROVIDER`, `AI_MODEL`, `AI_API_KEY` (and `AI_BASE_URL` for an OpenAI-compatible provider such as Gemini or Groq).
2. `npm start` runs the app at http://127.0.0.1:3000. The recovery console link is printed in the terminal.

| Command | What it does |
|---|---|
| `npm start` | Start Evolv |
| `npm run console` | Open the recovery console already signed in |
| `npm run demo` | Run with a scripted fake AI (no key, nothing sent anywhere) |
| `npm test` | Run all tests (`node --test`) |

## Folder map
```
supervisor/      the trusted core (the AI agent can never edit it)
  constants/       every fixed value: limits, patterns, headers, messages
  config/          reads and validates .env
  models/          state: token ledger, git versions, workspaces, app process, events
  services/        logic: agent loop, change runner, verify, promote, tools, AI providers
  controllers/     request handlers
  routes/          which URL goes where, per origin
  middleware/      Host/Origin checks, body limits, security headers, bearer token
  security/        the path guard
  views/           HTML the supervisor returns
console/         the recovery console page (served on its own port)
seed/            the starting app the AI edits (copied to app/ on first run)
test/            tests, in folders that mirror supervisor/ (plus e2e/)
test-fixtures/   test helpers, fake AI servers, sample apps (outside test/ on purpose)
docs/            MVP_PRD.md, PRD, WORKFLOW.md (how it works, start to end)
app/ state/ demo-data/   created at runtime, git-ignored
```

See `docs/WORKFLOW.md` for how a change flows from request to live version.
