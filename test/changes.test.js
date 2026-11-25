// The change lifecycle: admit, stage, agent, verify, promote, discard.
// (Real verifier, real git promotion; the live app PROCESS is a stub here, the real one is in
// safe-promotion.test.js.)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ChangeRunner, ChangeError, validateRequest, newChangeId } from '../supervisor/changes.js';
import { Ledger } from '../supervisor/budget.js';
import { AnthropicProvider } from '../supervisor/providers/anthropic.js';
import { verifyWorkspace } from '../supervisor/verify.js';
import { promote, listVersions } from '../supervisor/versions.js';
import { startFakeProvider, reply, toolUse, httpError } from '../test-fixtures/fake-provider.js';
import { CRASH_ON_START } from '../test-fixtures/apps.js';
import { makeSeededApp, gitOut, waitFor, sleep } from '../test-fixtures/helpers.js';

const KEY = 'sk-changes-test-key';
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const NAVY = [
  reply([toolUse('read_file', { path: 'public/style.css' })]),
  reply([toolUse('edit_file', { path: 'public/style.css', old_text: '#fafafa', new_text: '#000080' })]),
  reply([toolUse('finish', { summary: 'Made the page background navy blue.' })]),
];
const WRITE_SERVER = (code, summary = 'Changed the server.') => [reply([toolUse('write_file', { path: 'server.js', content: code }), toolUse('finish', { summary })])];

async function setup({ script = NAVY, apiKey = KEY, totalBudget = 1_000_000, changeLimit = 500_000, maxSteps = 40, timeoutMs = 60_000, healthy = true, promoteDelayMs = 0 } = {}) {
  const app = await makeSeededApp();
  const fake = await startFakeProvider({ apiKey: KEY, script });
  const provider = new AnthropicProvider({ apiKey, model: 'm', baseUrl: fake.url, retryDelayMs: 1 });
  const ledger = new Ledger({ file: path.join(app.stateDir, 'usage.json'), totalBudget, changeLimit });
  const events = [];
  const control = { calls: [], stop: async () => control.calls.push('stop'), start: async () => control.calls.push('start'), waitHealthy: async () => healthy };
  const runner = new ChangeRunner({
    appDir: app.appDir, workspacesDir: app.workspacesDir, provider, ledger, maxSteps, timeoutMs,
    onEvent: (e) => events.push({ ...e, _activeId: runner.activeId, _workspaces: fs.readdirSync(app.workspacesDir).length }),
    verify: (ws, o) => verifyWorkspace({ dir: ws.dir, timeoutMs: 6000, settleMs: 200, consolePort: 3002, ...o }),
    promote: async (a) => {
      if (promoteDelayMs) await sleep(promoteDelayMs);
      return promote({ appDir: app.appDir, app: control, healthTimeoutMs: 500, ...a });
    },
  });
  cleanups.push(async () => {
    await fake.close();
    app.cleanup();
  });
  const liveClean = async () => (await gitOut(app.appDir, ['status', '--porcelain'])).trim() === '';
  const workspaces = () => fs.readdirSync(app.workspacesDir);
  const liveCss = () => fs.readFileSync(path.join(app.appDir, 'public', 'style.css'), 'utf8');
  return { app, fake, provider, ledger, runner, events, control, liveClean, workspaces, liveCss, versions: () => listVersions(app.appDir) };
}

// ---------- validation ----------
test('validateRequest accepts 1 to 4,000 characters and trims', () => {
  assert.equal(validateRequest('  make it blue \n'), 'make it blue');
  assert.equal(validateRequest('x').length, 1);
  assert.equal(validateRequest('y'.repeat(4000)).length, 4000);
  assert.equal(validateRequest('line one\nline two\ttabbed'), 'line one\nline two\ttabbed');
});

test('validateRequest rejects empty, too long, non-text and control characters (400)', () => {
  for (const bad of ['', '   ', '\n\t', 'y'.repeat(4001), null, undefined, 5, {}, [], 'a\0b', 'a\u0007b']) {
    assert.throws(() => validateRequest(bad), (e) => e instanceof ChangeError && e.code === 'invalid_request' && e.httpStatus === 400, JSON.stringify(bad)?.slice(0, 20));
  }
});

test('change ids are 128-bit random, URL-safe and unique', () => {
  const ids = new Set(Array.from({ length: 2000 }, newChangeId));
  assert.equal(ids.size, 2000);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{22}$/);
});

// ---------- the happy path: verified, promoted, discarded ----------
test('a change goes all the way: staged, edited, verified, promoted as version 2, workspace discarded', async () => {
  const env = await setup();
  assert.doesNotMatch(env.liveCss(), /#000080/);
  const { id, done } = env.runner.start('Change the background to dark navy');
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(env.runner.activeId, id);

  const result = await done;
  assert.equal(result.id, id);
  assert.equal(result.summary, 'Made the page background navy blue.');
  assert.deepEqual(result.changedFiles, [{ path: 'public/style.css', status: 'modified' }]);
  assert.match(result.diff, /^\+.*#000080/m);
  assert.deepEqual(result.usage, { tokens: 450, steps: 3 });
  assert.equal(result.version.id, 2);

  assert.match(env.liveCss(), /#000080/, 'the verified change is live');
  assert.ok(await env.liveClean());
  assert.deepEqual(env.workspaces(), []);
  assert.equal(env.runner.activeId, null);
  assert.equal(env.ledger.used(), 450);
  const [v2, v1] = await env.versions();
  assert.equal(v2.request, 'Change the background to dark navy');
  assert.equal(v2.summary, 'Made the page background navy blue.');
  assert.equal(v2.tokens, 450, 'the version records what it cost');
  assert.match(v1.summary, /seed/i);
  assert.deepEqual(env.control.calls, ['stop', 'start']);
});

test('events tell the story in order; done and failed arrive only after the runner is free and the workspace is gone', async () => {
  const env = await setup();
  const { id, done } = env.runner.start('Change the background');
  await done;
  const types = env.events.map((e) => e.type);
  assert.deepEqual(types.slice(0, 2), ['accepted', 'staged']);
  assert.equal(types.at(-1), 'done');
  assert.ok(types.indexOf('promoting') > types.lastIndexOf('verify'));
  assert.ok(env.events.every((e) => e.changeId === id));
  const passed = env.events.filter((e) => e.type === 'verify' && e.status === 'passed').map((e) => e.check);
  assert.deepEqual(passed, ['files', 'start', 'home', 'console_link', 'smoke', 'alive']);
  const last = env.events.at(-1);
  assert.equal(last._activeId, null, 'the lock is released before "done" is announced');
  assert.equal(last._workspaces, 0, 'the workspace is gone before "done" is announced');
  assert.equal(last.version, 2);
  assert.deepEqual(last.files, ['public/style.css']);
  assert.equal(last.tokens, 450);
  assert.ok(!JSON.stringify(env.events).includes(KEY) && !JSON.stringify(env.events).includes('#000080'));
});

test('the first event is sent synchronously, so a client can subscribe the instant it gets the id', async () => {
  const env = await setup();
  const { done } = env.runner.start('Change the background');
  assert.equal(env.events[0].type, 'accepted', 'no await has happened yet');
  await done;
});

// ---------- refusals happen BEFORE any AI call and before any staging ----------
test('an invalid request is refused with 400, nothing staged, no AI call', async () => {
  const env = await setup();
  assert.throws(() => env.runner.start(''), (e) => e.code === 'invalid_request' && e.httpStatus === 400);
  assert.equal(env.fake.requests.length, 0);
  assert.deepEqual(env.workspaces(), []);
  assert.equal(env.runner.activeId, null);
  assert.deepEqual(env.events, []);
});

test('a spent budget is refused with 429 BEFORE any AI call or staging', async () => {
  const env = await setup({ totalBudget: 100 });
  env.ledger.record('earlier', { inputTokens: 100, outputTokens: 0 });
  assert.throws(() => env.runner.start('anything'), (e) => e.code === 'budget_exhausted' && e.httpStatus === 429 && /100/.test(e.message));
  assert.equal(env.fake.requests.length, 0);
  assert.deepEqual(env.workspaces(), []);
  assert.equal(env.runner.activeId, null);
});

test('a damaged usage file is refused in plain words, naming the file', async () => {
  const env = await setup();
  fs.writeFileSync(env.ledger.file, 'garbage');
  const broken = new Ledger({ file: env.ledger.file, totalBudget: 1000, changeLimit: 500 });
  const runner = new ChangeRunner({ appDir: env.app.appDir, workspacesDir: env.app.workspacesDir, provider: env.provider, ledger: broken, maxSteps: 5, timeoutMs: 1000 });
  assert.throws(() => runner.start('anything'), (e) => e.code === 'ledger_unreadable' && e.httpStatus === 503 && e.message.includes(env.ledger.file) && /damaged/i.test(e.message));
  assert.equal(env.fake.requests.length, 0);
  assert.deepEqual(env.workspaces(), []);
});

test('no API key is refused before any AI call or staging', async () => {
  const env = await setup({ apiKey: '' });
  assert.throws(() => env.runner.start('anything'), (e) => e.code === 'provider_error' && /AI_API_KEY/.test(e.message));
  assert.equal(env.fake.requests.length, 0);
  assert.deepEqual(env.workspaces(), []);
});

// ---------- one at a time ----------
test('a second change while one runs is busy (409), and a later one is fine', async () => {
  // A different file each time, so every change really changes something.
  const env = await setup({ script: (body, n) => reply([toolUse('write_file', { path: `file${n}.txt`, content: 'x' }), toolUse('finish', { summary: 'Slow one.' })], { delayMs: 400 }) });
  const a = env.runner.start('first');
  assert.throws(() => env.runner.start('second'), (e) => e instanceof ChangeError && e.code === 'busy' && e.httpStatus === 409);
  await a.done;
  assert.equal(env.fake.requests.length, 1, 'the refused change must not have called the AI');
  const c = env.runner.start('third');
  assert.equal((await c.done).summary, 'Slow one.');
});

test('busy also covers the verify and promote phases', async () => {
  const env = await setup({ promoteDelayMs: 600 });
  const a = env.runner.start('first');
  await waitFor(() => env.runner.phase === 'verify', { timeout: 15000 });
  assert.throws(() => env.runner.start('during verify'), (e) => e.code === 'busy');
  await waitFor(() => env.runner.phase === 'promote', { timeout: 15000 });
  assert.throws(() => env.runner.start('during promote'), (e) => e.code === 'busy');
  await a.done;
  assert.equal(env.runner.phase, null);
});

test('two starts in the same tick: exactly one is admitted', async () => {
  const env = await setup();
  const results = [0, 1].map(() => {
    try {
      return env.runner.start('go');
    } catch (e) {
      return e;
    }
  });
  assert.equal(results.filter((r) => r instanceof ChangeError && r.code === 'busy').length, 1);
  await results.find((r) => !(r instanceof Error)).done;
});

// ---------- failures: the live app is NEVER touched, the workspace is discarded, the runner is freed ----------
async function assertFailed(env, started, code, { versions = 1 } = {}) {
  const err = await started.done.then(() => null, (e) => e);
  assert.ok(err, 'the change should have failed');
  assert.equal(err.code, code, err.message);
  assert.ok(await env.liveClean(), 'the live app must be untouched');
  assert.doesNotMatch(env.liveCss(), /#000080/);
  assert.deepEqual(env.workspaces(), [], 'the workspace must be discarded');
  assert.equal(env.runner.activeId, null, 'the runner must be free again');
  assert.equal(env.runner.phase, null);
  assert.equal((await env.versions()).length, versions);
  assert.deepEqual(env.control.calls, [], 'the live app must not even have been stopped');
  const last = env.events.at(-1);
  assert.equal(last.type, 'failed');
  assert.equal(last.code, code);
  assert.equal(last._activeId, null);
  return err;
}

test('a change that crashes on start fails verification; the live app is never touched', async () => {
  const env = await setup({ script: WRITE_SERVER(CRASH_ON_START, 'Rewrote the server.') });
  const err = await assertFailed(env, env.runner.start('rewrite the server'), 'verify_failed');
  assert.equal(err.httpStatus, 422);
  assert.match(err.message, /did not pass the automatic checks/i);
  assert.match(err.message, /your app was not changed/i);
  assert.match(err.output, /boom: this app cannot start/);
  const failed = env.events.at(-1);
  assert.match(failed.message, /not changed/i);
  assert.match(failed.output, /boom/);
  assert.equal(failed.checks.find((c) => !c.ok).name, 'start');
  assert.ok(!JSON.stringify(failed).includes(env.app.root), 'no real paths in what is sent to the browser');
});

test('a change that removes the recovery link fails the fifth check', async () => {
  const env = await setup({
    script: [reply([toolUse('write_file', { path: 'public/index.html', content: '<!doctype html><h1>No way back</h1>' }), toolUse('finish', { summary: 'Simplified the home page.' })])],
  });
  const err = await assertFailed(env, env.runner.start('simplify the home page'), 'verify_failed');
  assert.match(err.message, /recovery console/i);
  assert.match(err.message, /\/_evolv/);
});

test('a change that edits nothing is reported, not promoted', async () => {
  const env = await setup({ script: [reply([toolUse('finish', { summary: 'I did nothing.' })])] });
  const err = await assertFailed(env, env.runner.start('do nothing'), 'no_changes');
  assert.match(err.message, /nothing to apply|did not change anything/i);
  assert.match(err.message, /unchanged/i);
});

test('step limit: agent_limit, workspace discarded, live app untouched', async () => {
  const env = await setup({ script: [reply([toolUse('write_file', { path: 'a.txt', content: 'x' })])], maxSteps: 3 });
  await assertFailed(env, env.runner.start('loop forever'), 'agent_limit');
  assert.equal(env.fake.requests.length, 3);
});

test('provider failure: provider_error, workspace discarded', async () => {
  const env = await setup({ script: [httpError(529, 'overloaded')] });
  await assertFailed(env, env.runner.start('go'), 'provider_error');
});

test('timeout: agent_limit, workspace discarded', async () => {
  const env = await setup({ script: [reply([toolUse('list_files', {})], { delayMs: 5000 })], timeoutMs: 300 });
  await assertFailed(env, env.runner.start('go'), 'agent_limit');
});

test('the budget really stops a long change mid-way', async () => {
  const env = await setup({ script: [reply([toolUse('list_files', {})], { input: 300, output: 100 })], totalBudget: 1000 });
  await assertFailed(env, env.runner.start('go'), 'budget_exhausted');
  assert.equal(env.fake.requests.length, 3, '400 + 400 + 400 = 1200 >= 1000 after the third call');
});

test('failures never leak the API key', async () => {
  const env = await setup({ apiKey: KEY + 'BAD', script: [reply([toolUse('finish', { summary: 'x' })])] });
  const started = env.runner.start('go');
  await assert.rejects(started.done, (e) => {
    for (const t of [e.message, String(e), e.stack ?? '']) assert.ok(!t.includes('BAD') && !t.includes(KEY));
    return e.code === 'provider_error';
  });
  assert.ok(!JSON.stringify(env.events).includes(KEY));
});

// ---------- cancel ----------
test('cancel during the agent: stops it, discards the workspace, frees the runner', async () => {
  const env = await setup({ script: [reply([toolUse('list_files', {})], { delayMs: 5000 })] });
  const started = env.runner.start('go');
  await waitFor(() => env.fake.requests.length === 1);
  assert.equal(env.runner.cancel('not-the-right-id'), false);
  assert.equal(env.runner.activeId, started.id);
  assert.equal(env.runner.phase, 'agent');
  assert.equal(env.runner.cancel(started.id), true);
  await assertFailed(env, started, 'cancelled');
  assert.equal(env.runner.cancel(started.id), false, 'nothing left to cancel');
  assert.equal(env.ledger.changeUsed(started.id), Math.ceil(env.fake.requests[0].raw.length / 4));
});

test('cancel during verification: the staged app is killed, the live app is untouched', async () => {
  const env = await setup({ script: WRITE_SERVER("setInterval(() => {}, 1000);\n", 'Rewrote the server.') });
  const started = env.runner.start('slow start');
  await waitFor(() => env.runner.phase === 'verify', { timeout: 15000 });
  const t0 = Date.now();
  assert.equal(env.runner.cancel(started.id), true);
  await assertFailed(env, started, 'cancelled');
  assert.ok(Date.now() - t0 < 4000, 'cancel must not wait for the verification timeout');
});

test('once promotion has begun it is too late to cancel, and the change completes', async () => {
  const env = await setup({ promoteDelayMs: 500 });
  const started = env.runner.start('go');
  await waitFor(() => env.runner.phase === 'promote', { timeout: 15000 });
  assert.equal(env.runner.cancel(started.id), false);
  const result = await started.done;
  assert.equal(result.version.id, 2);
  assert.match(env.liveCss(), /#000080/);
});

// ---------- automatic rollback ----------
test('a new version that does not come up healthy is rolled back, and the console gets a plain notice', async () => {
  const env = await setup({ healthy: false });
  assert.equal(env.runner.notice, null);
  const started = env.runner.start('make it navy');
  const err = await started.done.then(() => null, (e) => e);
  assert.equal(err.code, 'swap_failed');
  assert.equal(err.rolledBack, true);
  assert.match(err.message, /previous version/i);
  assert.doesNotMatch(env.liveCss(), /#000080/, 'the old files are back');
  assert.equal((await env.versions()).length, 1, 'the failed version is not in History');
  assert.equal(env.runner.activeId, null);
  assert.deepEqual(env.workspaces(), []);
  assert.equal(env.runner.notice.kind, 'rolled_back');
  assert.match(env.runner.notice.message, /previous version/i);
  assert.ok(env.runner.notice.at);
  const failed = env.events.at(-1);
  assert.equal(failed.type, 'failed');
  assert.equal(failed.code, 'swap_failed');
  assert.match(failed.message, /previous version/i);
});

test('the rollback notice is cleared by the next successful change', async () => {
  const env = await setup({ healthy: false });
  await env.runner.start('first').done.catch(() => {});
  assert.ok(env.runner.notice);
  // The fake provider indexes its script by total requests so far, so offset it.
  const offset = env.fake.requests.length;
  env.fake.setScript((body, n) => NAVY[Math.min(n - offset, NAVY.length - 1)]);
  env.control.waitHealthy = async () => true; // the app is healthy this time
  const second = await env.runner.start('second').done;
  assert.equal(second.version.id, 2);
  assert.equal(env.runner.notice, null);
});

// ---------- what the user reads when a change fails ----------
test('a failure message that does not end in a full stop gets one before "Your app was not changed."', async () => {
  const env = await setup({ script: [httpError(400, 'messages: text content blocks must be non-empty')] });
  const started = env.runner.start('go');
  await started.done.catch(() => {});
  const message = env.events.at(-1).message;
  assert.match(message, /non-empty\. Your app was not changed\.$/);
  assert.ok(!/non-empty Your/.test(message), 'two sentences must not run together');
});

test('a message that already ends in punctuation is not given a second one', async () => {
  const env = await setup({ script: [reply([toolUse('finish', { summary: 'I did nothing.' })])] });
  const started = env.runner.start('do nothing');
  await started.done.catch(() => {});
  const message = env.events.at(-1).message;
  assert.ok(!/\.\./.test(message) && !/\.\s*\./.test(message), message);
});
