// The tool loop, driven by the fake provider (a real HTTP server) and the real tools and ledger.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent, AgentError, buildSystemPrompt } from '../supervisor/agent.js';
import { createTools } from '../supervisor/tools.js';
import { Ledger } from '../supervisor/budget.js';
import { AnthropicProvider } from '../supervisor/providers/anthropic.js';
import { startFakeProvider, reply, toolUse, textBlock, httpError } from '../test-fixtures/fake-provider.js';
import { makeTempDir, ROOT, waitFor } from '../test-fixtures/helpers.js';

const KEY = 'sk-agent-test-key';
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function setup({ script, totalBudget = 1_000_000, changeLimit = 500_000, used = 0 } = {}) {
  const tmp = makeTempDir('evolv-agent-');
  const ws = path.join(tmp.dir, 'ws');
  fs.cpSync(path.join(ROOT, 'seed'), ws, { recursive: true });
  const fake = await startFakeProvider({ apiKey: KEY, script });
  const provider = new AnthropicProvider({ apiKey: KEY, model: 'claude-test', baseUrl: fake.url, retryDelayMs: 1 });
  const ledger = new Ledger({ file: path.join(tmp.dir, 'state', 'usage.json'), totalBudget, changeLimit });
  if (used) ledger.record('earlier', { inputTokens: used, outputTokens: 0 });
  const events = [];
  cleanups.push(async () => {
    await fake.close();
    tmp.cleanup();
  });
  return {
    fake, provider, ledger, ws, events, tools: createTools({ root: ws }),
    run(over = {}) {
      return runAgent({
        provider, tools: this.tools, ledger, changeId: 'chg1', request: 'Make the page background navy',
        maxSteps: 40, timeoutMs: 60_000, onEvent: (e) => events.push(e), ...over,
      });
    },
  };
}

const read = (env, rel) => fs.readFileSync(path.join(env.ws, ...rel.split('/')), 'utf8');
const lastToolResults = (fake) => fake.requests.at(-1).body.messages.at(-1).content;

test('a change succeeds end to end: look, edit, finish', async () => {
  const env = await setup({
    script: [
      reply([toolUse('list_files', {}, 't1')]),
      reply([toolUse('read_file', { path: 'public/style.css' }, 't2')]),
      reply([toolUse('edit_file', { path: 'public/style.css', old_text: '#fafafa', new_text: '#000080' }, 't3')]),
      reply([toolUse('finish', { summary: 'Made the page background navy blue.' }, 't4')]),
    ],
  });
  const result = await env.run();
  assert.equal(result.summary, 'Made the page background navy blue.');
  assert.equal(result.steps, 4);
  assert.match(read(env, 'public/style.css'), /#000080/);
  assert.equal(env.fake.requests.length, 4);
  assert.equal(env.ledger.changeUsed('chg1'), 4 * 150);
  assert.equal(env.ledger.used(), 600);
});

test('tool events carry timing and token numbers for the model call that produced them', async () => {
  const env = await setup({
    script: [
      reply([toolUse('read_file', { path: 'public/style.css' })]),
      reply([toolUse('finish', { summary: 'Done.' })]),
    ],
  });
  await env.run();
  const tools = env.events.filter((e) => e.type === 'tool');
  assert.equal(tools.length, 2);
  for (const e of tools) {
    assert.ok(Number.isInteger(e.modelMs) && e.modelMs >= 0, 'modelMs is a whole number of milliseconds');
    assert.equal(e.inputTokens, 100);
    assert.equal(e.outputTokens, 50);
  }
  assert.ok(!JSON.stringify(env.events).includes(KEY));
});

test('progress events name the step and the tool and file, in order, with no file contents', async () => {
  const env = await setup({
    script: [
      reply([toolUse('read_file', { path: 'public/style.css' })]),
      reply([toolUse('edit_file', { path: 'public/style.css', old_text: '#fafafa', new_text: '#000080' })]),
      reply([toolUse('finish', { summary: 'Done.' })]),
    ],
  });
  await env.run();
  assert.deepEqual(env.events.map((e) => [e.type, e.step ?? e.name, e.file ?? null]), [
    ['step', 1, null], ['tool', 'read_file', 'public/style.css'],
    ['step', 2, null], ['tool', 'edit_file', 'public/style.css'],
    ['step', 3, null], ['tool', 'finish', null],
  ]);
  const text = JSON.stringify(env.events);
  assert.ok(!text.includes('#fafafa') && !text.includes('#000080') && !text.includes(KEY));
});

test('tool results are sent back in the next request, matched by id', async () => {
  const env = await setup({
    script: [reply([toolUse('read_file', { path: 'evolv.json' }, 'toolu_X')]), reply([toolUse('finish', { summary: 'ok' })])],
  });
  await env.run();
  const back = env.fake.requests[1].body.messages;
  assert.equal(back[0].role, 'user');
  assert.equal(back[1].role, 'assistant');
  assert.equal(back[1].content[0].id, 'toolu_X');
  assert.equal(back[2].role, 'user');
  assert.equal(back[2].content[0].type, 'tool_result');
  assert.equal(back[2].content[0].tool_use_id, 'toolu_X');
  assert.equal(back[2].content[0].is_error, false);
  assert.match(back[2].content[0].content, /smoke/);
});

test('a tool error goes back to the agent as an error result and the loop carries on', async () => {
  const env = await setup({
    script: [
      reply([toolUse('edit_file', { path: 'public/style.css', old_text: 'does-not-exist', new_text: 'x' }, 'bad')]),
      reply([toolUse('finish', { summary: 'Recovered.' })]),
    ],
  });
  const result = await env.run();
  assert.equal(result.summary, 'Recovered.');
  const r = env.fake.requests[1].body.messages.at(-1).content[0];
  assert.equal(r.tool_use_id, 'bad');
  assert.equal(r.is_error, true);
  assert.match(r.content, /not found/i);
});

test('several tool calls in one reply run in order; later calls after finish are not run', async () => {
  const env = await setup({
    script: [
      reply([
        toolUse('write_file', { path: 'one.txt', content: '1' }),
        toolUse('write_file', { path: 'two.txt', content: '2' }),
        toolUse('finish', { summary: 'Wrote two files.' }),
        toolUse('write_file', { path: 'three.txt', content: '3' }),
      ]),
    ],
  });
  const result = await env.run();
  assert.equal(result.summary, 'Wrote two files.');
  assert.ok(fs.existsSync(path.join(env.ws, 'one.txt')) && fs.existsSync(path.join(env.ws, 'two.txt')));
  assert.equal(fs.existsSync(path.join(env.ws, 'three.txt')), false);
  assert.equal(env.fake.requests.length, 1);
});

test('a bad finish (empty summary) is an error result, then a good finish works', async () => {
  const env = await setup({
    script: [reply([toolUse('finish', { summary: '' }, 'f1')]), reply([toolUse('finish', { summary: 'Now fine.' })])],
  });
  assert.equal((await env.run()).summary, 'Now fine.');
  assert.equal(lastToolResults(env.fake)[0].is_error, true);
});

test('a reply with no tool call is nudged to use tools, and counts as a step', async () => {
  const env = await setup({
    script: [reply([textBlock('I will think about it.')], { stop: 'end_turn' }), reply([toolUse('finish', { summary: 'ok' })])],
  });
  const result = await env.run();
  assert.equal(result.steps, 2);
  const nudge = env.fake.requests[1].body.messages.at(-1);
  assert.equal(nudge.role, 'user');
  assert.match(typeof nudge.content === 'string' ? nudge.content : JSON.stringify(nudge.content), /finish/i);
});

test('the system prompt carries the PRD rules', () => {
  const p = buildSystemPrompt();
  for (const needle of [
    /only what the request needs/i, /server\.js/, /process\.env\.PORT/, /\/health/, /evolv\.json/, /smoke/,
    /built-in/i, /DATA_DIR/, /chat widget/i, /Recovery console/, /one sentence/i, /finish/,
  ]) assert.match(p, needle);
  assert.ok(!/[^\x00-\x7f]/.test(p), 'keep the prompt plain ASCII');
});

test('the request goes in the first user message; the API key is never in anything sent', async () => {
  const env = await setup({ script: [reply([toolUse('finish', { summary: 'ok' })])] });
  await env.run({ request: 'Add a notes page' });
  const first = env.fake.requests[0].body;
  assert.match(JSON.stringify(first.messages[0]), /Add a notes page/);
  assert.equal(first.system, buildSystemPrompt());
  assert.deepEqual(first.tools.map((t) => t.name).sort(), ['delete_file', 'edit_file', 'finish', 'list_files', 'read_file', 'search', 'write_file']);
  for (const r of env.fake.requests) assert.ok(!r.raw.includes(KEY));
});

// ---------- limits ----------
test('the step limit stops a loop that never finishes', async () => {
  const env = await setup({ script: [reply([toolUse('list_files', {})])] });
  await assert.rejects(() => env.run({ maxSteps: 5 }), (e) => e instanceof AgentError && e.code === 'agent_limit' && /5 steps/.test(e.message));
  assert.equal(env.fake.requests.length, 5);
});

test('the per-change token limit stops the loop at the next step', async () => {
  const env = await setup({ script: [reply([toolUse('list_files', {})], { input: 500, output: 100 })], changeLimit: 1000 });
  await assert.rejects(() => env.run(), (e) => e.code === 'agent_limit' && /token/i.test(e.message));
  assert.equal(env.fake.requests.length, 2, '1200 tokens >= 1000 after the second call, so no third call');
  assert.equal(env.ledger.changeUsed('chg1'), 1200);
});

test('the total budget stops a running change at its next step', async () => {
  const env = await setup({ script: [reply([toolUse('list_files', {})], { input: 500, output: 100 })], totalBudget: 1000 });
  await assert.rejects(() => env.run(), (e) => e.code === 'budget_exhausted');
  assert.equal(env.fake.requests.length, 2);
});

test('an already-spent budget stops before ANY AI call', async () => {
  const env = await setup({ script: [reply([toolUse('finish', { summary: 'x' })])], totalBudget: 1000, used: 1000 });
  await assert.rejects(() => env.run(), (e) => e.code === 'budget_exhausted');
  assert.equal(env.fake.requests.length, 0);
});

test('a damaged ledger stops the loop before any AI call', async () => {
  const env = await setup({ script: [reply([toolUse('finish', { summary: 'x' })])] });
  fs.mkdirSync(path.dirname(env.ledger.file), { recursive: true });
  fs.writeFileSync(env.ledger.file, 'garbage');
  const broken = new Ledger({ file: env.ledger.file, totalBudget: 1000, changeLimit: 500 });
  await assert.rejects(() => env.run({ ledger: broken }), (e) => e.code === 'ledger_unreadable');
  assert.equal(env.fake.requests.length, 0);
});

test('the time limit aborts a slow call; the unknown cost is estimated, rounded up', async () => {
  const env = await setup({ script: [reply([toolUse('list_files', {})], { delayMs: 5000 })] });
  const t0 = Date.now();
  await assert.rejects(() => env.run({ timeoutMs: 300 }), (e) => e.code === 'agent_limit' && /minutes|time/i.test(e.message));
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(env.ledger.changeUsed('chg1'), Math.ceil(env.fake.requests[0].raw.length / 4));
});

// ---------- cancel ----------
test('cancelling during an AI call stops it and counts the estimated input, rounded up', async () => {
  const env = await setup({ script: [reply([toolUse('list_files', {})], { delayMs: 5000 })] });
  const ctl = new AbortController();
  const p = env.run({ signal: ctl.signal });
  const caught = p.catch((e) => e);
  await waitFor(() => env.fake.requests.length === 1);
  ctl.abort();
  const err = await caught;
  assert.ok(err instanceof AgentError);
  assert.equal(err.code, 'cancelled');
  assert.equal(env.ledger.changeUsed('chg1'), Math.ceil(env.fake.requests[0].raw.length / 4));
});

test('cancelling between steps stops before the next AI call', async () => {
  const ctl = new AbortController();
  const env = await setup({ script: [reply([toolUse('list_files', {})])] });
  const p = env.run({ signal: ctl.signal, onEvent: (e) => e.type === 'tool' && ctl.abort() });
  await assert.rejects(p, (e) => e.code === 'cancelled');
  assert.equal(env.fake.requests.length, 1);
});

test('cancelling before the start makes no AI call at all', async () => {
  const env = await setup({ script: [reply([toolUse('finish', { summary: 'x' })])] });
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(() => env.run({ signal: ctl.signal }), (e) => e.code === 'cancelled');
  assert.equal(env.fake.requests.length, 0);
});

// ---------- provider trouble ----------
test('a provider failure ends the change as provider_error, records nothing, and hides the key', async () => {
  const env = await setup({ script: [httpError(529, 'overloaded')] });
  await assert.rejects(() => env.run(), (e) => {
    assert.equal(e.code, 'provider_error');
    assert.ok(!e.message.includes(KEY));
    return true;
  });
  assert.equal(env.ledger.used(), 0);
});

test('a rejected key surfaces as provider_error and the key never appears in the message', async () => {
  const env = await setup({ script: [reply([toolUse('finish', { summary: 'x' })])] });
  const bad = new AnthropicProvider({ apiKey: KEY + 'ZZZ', model: 'm', baseUrl: env.fake.url, retryDelayMs: 1 });
  await assert.rejects(() => env.run({ provider: bad }), (e) => e.code === 'provider_error' && !e.message.includes('ZZZ') && !e.message.includes(KEY));
});

// ---------- tool calls whose arguments could not be read (OpenAI-compatible providers) ----------
const stubProvider = (replies) => {
  const sent = [];
  return {
    sent,
    assertReady() {},
    async complete({ messages }) {
      sent.push(JSON.parse(JSON.stringify(messages)));
      const content = replies[Math.min(sent.length - 1, replies.length - 1)];
      return { content, stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 }, estimated: false };
    },
  };
};
const BAD = 'The arguments for "edit_file" were not valid JSON, so the tool was not run. Send the arguments as one JSON object.';

test('a call with an inputError is answered with an error result and the tool is NOT run', async () => {
  const env = await setup({ script: [reply([toolUse('finish', { summary: 'x' })])] });
  const target = path.join(env.ws, 'public', 'style.css');
  const before = fs.readFileSync(target, 'utf8');
  const stub = stubProvider([
    [{ type: 'tool_use', id: 'bad1', name: 'edit_file', input: { path: 'public/style.css', old_text: '#fafafa', new_text: '#000000' }, inputError: BAD }],
    [{ type: 'tool_use', id: 'f1', name: 'finish', input: { summary: 'Gave up.' } }],
  ]);
  const result = await env.run({ provider: stub });
  assert.equal(result.summary, 'Gave up.');
  assert.equal(fs.readFileSync(target, 'utf8'), before, 'the edit must not have run, even though its input looked valid');
  const back = stub.sent[1].at(-1).content[0];
  assert.equal(back.tool_use_id, 'bad1');
  assert.equal(back.is_error, true);
  assert.equal(back.content, `Error: ${BAD}`);
});

test('a bad call does not stop the good calls in the same reply, and progress is still reported', async () => {
  const env = await setup({ script: [reply([toolUse('finish', { summary: 'x' })])] });
  const stub = stubProvider([
    [
      { type: 'tool_use', id: 'bad1', name: 'write_file', input: {}, inputError: 'The arguments for "write_file" were not valid JSON, so the tool was not run.' },
      { type: 'tool_use', id: 'good1', name: 'write_file', input: { path: 'two.txt', content: '2' } },
    ],
    [{ type: 'tool_use', id: 'f1', name: 'finish', input: { summary: 'Done.' } }],
  ]);
  await env.run({ provider: stub });
  assert.equal(fs.existsSync(path.join(env.ws, 'two.txt')), true);
  const results = stub.sent[1].at(-1).content;
  assert.deepEqual(results.map((r) => [r.tool_use_id, r.is_error]), [['bad1', true], ['good1', false]]);
  assert.deepEqual(env.events.filter((e) => e.type === 'tool').map((e) => e.name), ['write_file', 'write_file', 'finish']);
});

test('a finish call with an inputError does not finish the change', async () => {
  const env = await setup({ script: [reply([toolUse('finish', { summary: 'x' })])] });
  const stub = stubProvider([
    [{ type: 'tool_use', id: 'f0', name: 'finish', input: { summary: 'Sneaky.' }, inputError: 'The arguments for "finish" were not valid JSON, so the tool was not run.' }],
    [{ type: 'tool_use', id: 'f1', name: 'finish', input: { summary: 'Properly done.' } }],
  ]);
  const result = await env.run({ provider: stub });
  assert.equal(result.summary, 'Properly done.');
  assert.equal(result.steps, 2);
});

// ---------- the provider rejecting the model's own malformed tool call ----------
const formatFailure = () => ({
  content: [{ type: 'text', text: 'My last tool call was not valid JSON, so it was not run. I will call the tool again with valid JSON arguments.' }],
  stopReason: 'end_turn', usage: { inputTokens: 400, outputTokens: 30 }, estimated: true, toolFormatFailure: true,
});
const callOf = (name, input, id) => ({ content: [{ type: 'tool_use', id, name, input }], stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 }, estimated: false });
const scripted = (results) => {
  const sent = [];
  return { sent, assertReady() {}, async complete({ messages }) { sent.push(JSON.parse(JSON.stringify(messages))); return results[Math.min(sent.length - 1, results.length - 1)]; } };
};

test('a rejected tool call is told to the model, costs its estimate, and the change carries on', async () => {
  const env = await setup({ script: [reply([toolUse('finish', { summary: 'x' })])] });
  const stub = scripted([formatFailure(), callOf('finish', { summary: 'Recovered.' }, 'f1')]);
  const result = await env.run({ provider: stub });
  assert.equal(result.summary, 'Recovered.');
  assert.equal(result.steps, 2);
  const second = stub.sent[1];
  assert.equal(second.at(-2).role, 'assistant');
  assert.match(JSON.stringify(second.at(-2).content), /not valid JSON/);
  assert.match(String(second.at(-1).content), /did not call a tool/i, 'the usual nudge follows');
  assert.equal(env.ledger.changeUsed('chg1'), 430 + 15, 'the failed attempt is paid for, estimate included');
});

test('three rejected tool calls in a row stop the change with a plain provider_error', async () => {
  const env = await setup({ script: [reply([toolUse('finish', { summary: 'x' })])] });
  const stub = scripted([formatFailure()]);
  await assert.rejects(
    () => env.run({ provider: stub }),
    (e) => e.code === 'provider_error' && /keeps producing/i.test(e.message) && /AI_MODEL/.test(e.message),
  );
  assert.equal(stub.sent.length, 3, 'it gives up after three, not after forty steps of paying for failures');
});

test('a success in between resets the count', async () => {
  const env = await setup({ script: [reply([toolUse('finish', { summary: 'x' })])] });
  const stub = scripted([formatFailure(), formatFailure(), callOf('list_files', {}, 'l1'), formatFailure(), formatFailure(), callOf('finish', { summary: 'Done.' }, 'f1')]);
  assert.equal((await env.run({ provider: stub })).summary, 'Done.');
});

// ---------- rate-limit waits, and economy ----------
test('a provider wait is announced as a "waiting" event and is not a step', async () => {
  const env = await setup({ script: [reply([toolUse('finish', { summary: 'x' })])] });
  const stub = {
    assertReady() {},
    async complete({ onWait }) {
      onWait?.({ seconds: 5, reason: 'rate_limit' });
      return callOf('finish', { summary: 'Done.' }, 'f1');
    },
  };
  const result = await env.run({ provider: stub });
  assert.deepEqual(env.events.filter((e) => e.type === 'waiting').map((e) => [e.seconds, e.reason]), [[5, 'rate_limit']]);
  assert.equal(result.steps, 1);
  assert.deepEqual(env.events.map((e) => e.type), ['step', 'waiting', 'tool']);
});

test('a provider that does not report waits still works (the hook is optional)', async () => {
  const env = await setup({ script: [reply([toolUse('finish', { summary: 'x' })])] });
  const result = await env.run({ provider: scripted([callOf('finish', { summary: 'Fine.' }, 'f1')]) });
  assert.equal(result.summary, 'Fine.');
});

test('the system prompt tells the model to spend few calls, because every call re-sends the conversation', () => {
  const p = buildSystemPrompt();
  assert.match(p, /economical/i);
  assert.match(p, /never read the same file twice/i);
  assert.match(p, /as soon as you can/i);
  assert.ok(!/[^\x00-\x7f]/.test(p), 'still plain ASCII');
});
