# Evolv: rules for Claude Code

Read `docs/MVP_PRD.md` first (the scope for this build). `docs/PRD.md` is the full background.

## Hard rules
- Node built-ins only. No npm dependencies. No build step. No frameworks.
- JavaScript ES modules with JSDoc types.
- Never weaken the app sandbox, the path guard, the token check, or the 127.0.0.1 binding to make a test or error go away. If one of these blocks you, stop and tell me.
- The AI agent inside Evolv must never be able to edit `supervisor/`, `console/`, `.env`, or git history.
- Never print, log or commit the API key. `.env` stays git-ignored.
- Run git only with `execFile`, never through a shell.
- Develop on Windows: use `path` utilities, no hard-coded separators, and test process kill and restart.
- Before using Node permission-model flags, check the real flag names with `node --help` for the installed version.

## Working method
- Build only the step I name (B1, B2, B3, B4). Do not start the next one.
- Before writing code, show a short plan listing each file you will create. Wait for my OK.
- Write tests for dangerous parts (path guard, sandbox) before the code they test.
- After each step run `node --test` and report the real result, including failures. Do not say "done" unless the tests ran and passed.
- Keep changes small. If a requirement seems impossible or contradicts the PRD, ask instead of guessing.
