// The Anthropic adapter, tested against the fake provider (a real local HTTP server).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AnthropicProvider, ProviderError } from '../supervisor/providers/anthropic.js';
import { estimateTokens } from '../supervisor/budget.js';
import { startFakeProvider, reply, toolUse, textBlock, httpError } from '../test-fixtures/fake-provider.js';

const KEY = 'sk-test-secret-key-123';
let fake;
before(async () => {
  fake = await startFakeProvider({ apiKey: KEY });
});
after(() => fake.close());

const make = (o = {}) =>
  new AnthropicProvider({ apiKey: KEY, model: 'claude-test', baseUrl: fake.url, retryDelayMs: 1, ...o });
const TOOLS = [{ name: 'list_files', description: 'List', input_schema: { type: 'object', properties: {} } }];
const call = (p, extra = {}) =>
  p.complete({ system: 'SYSTEM TEXT', messages: [{ role: 'user', content: 'hello' }], tools: TOOLS, ...extra });
const fresh = (script) => {
  fake.requests.length = 0;
  fake.setScript(script);
};

test('sends the documented Messages API request', async () => {
  fresh([reply([textBlock('hi')], { stop: 'end_turn' })]);
  await call(make());
  assert.equal(fake.requests.length, 1);
  const r = fake.requests[0];
  assert.equal(r.method, 'POST');
  assert.equal(r.url, '/v1/messages');
  assert.equal(r.headers['x-api-key'], KEY);
  assert.equal(r.headers['anthropic-version'], '2023-06-01');
  assert.match(r.headers['content-type'], /application\/json/);
  assert.equal(r.body.model, 'claude-test');
  assert.equal(r.body.system, 'SYSTEM TEXT');
  assert.ok(Number.isInteger(r.body.max_tokens) && r.body.max_tokens > 0);
  assert.deepEqual(r.body.tools, TOOLS);
  assert.deepEqual(r.body.messages, [{ role: 'user', content: 'hello' }]);
});

test('maps tool_use and text blocks, stop reason and usage', async () => {
  const use = toolUse('read_file', { path: 'server.js' }, 'toolu_abc');
  fresh([reply([textBlock('Looking.'), use], { input: 321, output: 45 })]);
  const out = await call(make());
  assert.deepEqual(out.content, [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'toolu_abc', name: 'read_file', input: { path: 'server.js' } }]);
  assert.equal(out.stopReason, 'tool_use');
  assert.deepEqual(out.usage, { inputTokens: 321, outputTokens: 45 });
  assert.equal(out.estimated, false);
});

test('unknown block types (such as thinking) are dropped', async () => {
  fresh([reply([{ type: 'thinking', thinking: 'secret chain of thought', signature: 'x' }, textBlock('ok')], { stop: 'end_turn' })]);
  const out = await call(make());
  assert.deepEqual(out.content, [{ type: 'text', text: 'ok' }]);
});

test('tool results go back exactly as tool_result blocks, errors flagged', async () => {
  fresh([reply([textBlock('ok')], { stop: 'end_turn' })]);
  const messages = [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: [toolUse('edit_file', { path: 'a' }, 'toolu_1'), toolUse('read_file', { path: 'b' }, 'toolu_2')] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Error: not found', is_error: true },
      { type: 'tool_result', tool_use_id: 'toolu_2', content: '    1\tx', is_error: false },
    ] },
  ];
  await make().complete({ system: 's', messages, tools: TOOLS });
  assert.deepEqual(fake.requests[0].body.messages, messages);
});

test('without a key it fails before any request, in plain words', async () => {
  fresh([reply([textBlock('x')], { stop: 'end_turn' })]);
  for (const apiKey of ['', undefined]) {
    await assert.rejects(() => call(make({ apiKey })), (e) => e instanceof ProviderError && e.code === 'provider_error' && /AI_API_KEY/.test(e.message));
  }
  assert.equal(fake.requests.length, 0);
});

test('a rejected key (401) is explained, and the key is NEVER in the error', async () => {
  fresh([reply([textBlock('x')], { stop: 'end_turn' })]);
  const wrong = make({ apiKey: KEY + '-wrong' });
  await assert.rejects(
    () => call(wrong),
    (e) => {
      assert.ok(e instanceof ProviderError);
      assert.equal(e.code, 'provider_error');
      assert.match(e.message, /rejected the API key|AI_API_KEY/i);
      for (const text of [e.message, String(e), e.stack ?? '', JSON.stringify(e, Object.getOwnPropertyNames(e))]) {
        assert.ok(!text.includes(KEY), 'the key leaked into an error');
        assert.ok(!text.includes('-wrong'), 'the key leaked into an error');
      }
      return true;
    },
  );
  assert.equal(fake.requests.length, 1, '401 must not be retried');
});

test('the key travels only in the x-api-key header', async () => {
  fresh([reply([textBlock('x')], { stop: 'end_turn' })]);
  await call(make());
  const r = fake.requests[0];
  assert.ok(!r.raw.includes(KEY));
  assert.ok(!r.url.includes(KEY));
  for (const [k, v] of Object.entries(r.headers)) if (k !== 'x-api-key') assert.ok(!String(v).includes(KEY), k);
});

test('429 is retried and then succeeds', async () => {
  fresh([httpError(429, 'slow down', { headers: { 'retry-after': '0' } }), reply([textBlock('done')], { stop: 'end_turn' })]);
  const out = await call(make());
  assert.equal(out.content[0].text, 'done');
  assert.equal(fake.requests.length, 2);
});

test('5xx and 529 are retried twice, then reported as a provider error', async () => {
  fresh([httpError(529, 'overloaded')]);
  await assert.rejects(() => call(make()), (e) => e instanceof ProviderError && /busy|unavailable/i.test(e.message) && /529/.test(e.message));
  assert.equal(fake.requests.length, 3, '1 try + 2 retries');
});

test('a 400 is not retried and shows the provider message', async () => {
  fresh([httpError(400, 'messages: text content blocks must be non-empty')]);
  await assert.rejects(() => call(make()), (e) => /400/.test(e.message) && /non-empty/.test(e.message));
  assert.equal(fake.requests.length, 1);
});

test('a dropped connection is retried, then reported', async () => {
  fresh([{ destroy: true }]);
  await assert.rejects(() => call(make()), (e) => e instanceof ProviderError);
  assert.equal(fake.requests.length, 3);
});

test('a reply that is not JSON is a provider error', async () => {
  fresh([{ status: 200, body: 'not an object' }]);
  await assert.rejects(() => call(make()), (e) => e instanceof ProviderError);
});

test('missing usage is estimated, rounded up, and flagged', async () => {
  const blocks = [textBlock('x'.repeat(10))];
  fresh([{ content: blocks, stop_reason: 'end_turn', usage: undefined }]);
  const out = await call(make());
  assert.equal(out.estimated, true);
  assert.equal(out.usage.inputTokens, estimateTokens(fake.requests[0].raw));
  assert.equal(out.usage.outputTokens, estimateTokens(JSON.stringify(blocks)));
  assert.ok(out.usage.inputTokens > 0 && out.usage.outputTokens > 0);
});

test('cancelling mid-call throws an abort that carries a rounded-up input estimate', async () => {
  fresh([reply([textBlock('slow')], { stop: 'end_turn', delayMs: 3000 })]);
  const ctl = new AbortController();
  const p = call(make(), { signal: ctl.signal });
  while (fake.requests.length < 1) await new Promise((r) => setTimeout(r, 5));
  ctl.abort();
  await assert.rejects(p, (e) => {
    assert.equal(e.aborted, true);
    assert.equal(e.estimatedInputTokens, Math.ceil(fake.requests[0].raw.length / 4));
    return true;
  });
});

test('an already-cancelled signal aborts before any request, still with an estimate', async () => {
  fresh([reply([textBlock('x')], { stop: 'end_turn' })]);
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(() => call(make(), { signal: ctl.signal }), (e) => e.aborted === true && e.estimatedInputTokens > 0);
  assert.equal(fake.requests.length, 0);
});

test('a slow provider times out with an estimate and a plain message', async () => {
  fresh([reply([textBlock('slow')], { stop: 'end_turn', delayMs: 3000 })]);
  await assert.rejects(
    () => call(make({ requestTimeoutMs: 100, retries: 0 })),
    (e) => e instanceof ProviderError && /too long|timed out/i.test(e.message) && e.estimatedInputTokens > 0,
  );
});

test('the base URL is a constructor option only, never read from the environment', async () => {
  process.env.AI_BASE_URL = 'http://evil.example';
  process.env.ANTHROPIC_BASE_URL = 'http://evil.example';
  try {
    let seen;
    const p = new AnthropicProvider({
      apiKey: KEY,
      model: 'm',
      fetchImpl: async (url) => {
        seen = String(url);
        return new Response(JSON.stringify({ content: [], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
      },
    });
    await call(p);
    assert.equal(seen, 'https://api.anthropic.com/v1/messages');
  } finally {
    delete process.env.AI_BASE_URL;
    delete process.env.ANTHROPIC_BASE_URL;
  }
});
