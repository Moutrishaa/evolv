// The change lifecycle: admit, stage, run the agent, report, discard. (Verify and promote are B3.)
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ChangeRunner, ChangeError, validateRequest, newChangeId } from '../supervisor/changes.js';
import { Ledger } from '../supervisor/budget.js';
import { AnthropicProvider } from '../supervisor/providers/anthropic.js';
import { startFakeProvider, reply, toolUse, httpError } from '../test-fixtures/fake-provider.js';
import { makeSeededApp, gitOut, waitFor } from '../test-fixtures/helpers.js';

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

async function setup({ script = NAVY, apiKey = KEY, totalBudget = 1_000_000, changeLimit = 500_000, maxSteps = 40, timeoutMs = 60_000 } = {}) {
  const app = await makeSeededApp();
  const fake = await startFakeProvider({ apiKey: KEY, script });
  const provider = new AnthropicProvider({ apiKey, model: 'm', baseUrl: fake.url, retryDelayMs: 1 });
  const ledger = new Ledger({ file: path.join(app.stateDir, 'usage.json'), totalBudget, changeLimit });
  const events = [];
  const runner = new ChangeRunner({
    appDir: app.appDir, workspacesDir: app.workspacesDir, provider, ledger, maxSteps, timeoutMs,
    onEvent: (e) => events.push(e),
  });
  cleanups.push(async () => {
    await fake.close();
    app.cleanup();
  });
  const liveClean = async () => (await gitOut(app.appDir, ['status', '--porcelain'])).trim() === '';
  const workspaces = () => fs.readdirSync(app.workspacesDir);
  return { app, fake, provider, ledger, runner, events, liveClean, workspaces };
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

// ---------- the happy path ----------
test('a change runs end to end: staged, edited, reported, discarded, live app untouched', async () => {
  const env = await setup();
  const before = fs.readFileSync(path.join(env.app.appDir, 'public', 'style.css'), 'utf8');
  const { id, done } = env.runner.start('Change the background to dark navy');
  assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(env.runner.activeId, id);

  const result = await done;
  assert.equal(result.id, id);
  assert.equal(result.summary, 'Made the page background navy blue.');
  assert.deepEqual(result.changedFiles, [{ path: 'public/style.css', status: 'modified' }]);
  assert.match(result.diff, /^\+.*#000080/m);
  assert.deepEqual(result.usage, { tokens: 450, steps: 3 });

  // B2 ends here: nothing is promoted, the staging copy is gone, the live app is untouched.
  assert.equal(fs.readFileSync(path.join(env.app.appDir, 'public', 'style.css'), 'utf8'), before);
  assert.ok(await env.liveClean());
  assert.deepEqual(env.workspaces(), []);
  assert.equal(env.runner.activeId, null);
  assert.equal(env.ledger.used(), 450);
  assert.equal(env.ledger.changeUsed(id), 450);
});

test('events tell the story in order and carry no secrets or file contents', async () => {
  const env = await setup();
  const { id, done } = env.runner.start('Change the background');
  await done;
  const types = env.events.map((e) => e.type);
  assert.equal(types[0], 'staged');
  assert.deepEqual(types.filter((t) => t !== 'staged'), ['step', 'tool', 'step', 'tool', 'step', 'tool']);
  assert.ok(env.events.every((e) => e.changeId === id));
  assert.ok(!JSON.stringify(env.events).includes(KEY) && !JSON.stringify(env.events).includes('#000080'));
});

// ---------- refusals happen BEFORE any AI call and before any staging ----------
test('an invalid request is refused with 400, nothing staged, no AI call', async () => {
  const env = await setup();
  assert.throws(() => env.runner.start(''), (e) => e.code === 'invalid_request' && e.httpStatus === 400);
  assert.equal(env.fake.requests.length, 0);
  assert.deepEqual(env.workspaces(), []);
  assert.equal(env.runner.activeId, null);
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
  const env = await setup({ script: [reply([toolUse('finish', { summary: 'Slow one.' })], { delayMs: 400 })] });
  const a = env.runner.start('first');
  assert.throws(() => env.runner.start('second'), (e) => e instanceof ChangeError && e.code === 'busy' && e.httpStatus === 409);
  assert.equal(env.workspaces().length <= 1, true);
  await a.done;
  assert.equal(env.fake.requests.length, 1, 'the refused change must not have called the AI');
  const c = env.runner.start('third');
  assert.equal((await c.done).summary, 'Slow one.');
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
  const winner = results.find((r) => !(r instanceof Error));
  await winner.done;
});

// ---------- failures discard the workspace and free the runner ----------
async function assertFailed(env, started, code) {
  await assert.rejects(started.done, (e) => e.code === code);
  assert.ok(await env.liveClean(), 'the live app must be untouched');
  assert.deepEqual(env.workspaces(), [], 'the workspace must be discarded');
  assert.equal(env.runner.activeId, null, 'the runner must be free again');
}

test('step limit: reported as agent_limit, workspace discarded, live app untouched', async () => {
  const env = await setup({ script: [reply([toolUse('write_file', { path: 'a.txt', content: 'x' })])], maxSteps: 3 });
  await assertFailed(env, env.runner.start('loop forever'), 'agent_limit');
  assert.equal(env.fake.requests.length, 3);
});

test('provider failure: reported as provider_error, workspace discarded', async () => {
  const env = await setup({ script: [httpError(529, 'overloaded')] });
  await assertFailed(env, env.runner.start('go'), 'provider_error');
});

test('timeout: reported as agent_limit, workspace discarded', async () => {
  const env = await setup({ script: [reply([toolUse('list_files', {})], { delayMs: 5000 })], timeoutMs: 300 });
  await assertFailed(env, env.runner.start('go'), 'agent_limit');
});

test('cancel: stops the running change, discards the workspace, frees the runner', async () => {
  const env = await setup({ script: [reply([toolUse('list_files', {})], { delayMs: 5000 })] });
  const started = env.runner.start('go');
  await waitFor(() => env.fake.requests.length === 1);
  assert.equal(env.runner.cancel('not-the-right-id'), false);
  assert.equal(env.runner.activeId, started.id);
  assert.equal(env.runner.cancel(started.id), true);
  await assertFailed(env, started, 'cancelled');
  assert.equal(env.runner.cancel(started.id), false, 'nothing left to cancel');
  assert.equal(env.ledger.changeUsed(started.id), Math.ceil(env.fake.requests[0].raw.length / 4));
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

test('the budget really stops a long change mid-way', async () => {
  const env = await setup({ script: [reply([toolUse('list_files', {})], { input: 300, output: 100 })], totalBudget: 1000 });
  await assertFailed(env, env.runner.start('go'), 'budget_exhausted');
  assert.equal(env.fake.requests.length, 3, '400 + 400 + 400 = 1200 >= 1000 after the third call');
});
