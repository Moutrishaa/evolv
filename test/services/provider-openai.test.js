// The OpenAI-compatible adapter, tested against a local fake Chat Completions server.
// It must speak the same interface as the Anthropic adapter, work with any AI_BASE_URL (Groq,
// OpenAI, local servers), turn malformed tool arguments into tool errors, and never leak the key.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider } from '../../supervisor/services/providers/openai.js';
import { ProviderError } from '../../supervisor/services/providers/anthropic.js';
import { normalizeBaseUrl } from '../../supervisor/services/providers/base-url.js';
import { estimateTokens } from '../../supervisor/models/ledger.js';
import { startFakeOpenAI, chatReply, call, apiError, toolUseFailed } from '../../test-fixtures/fakes/fake-openai.js';

const KEY = 'sk-openai-test-secret-123';
let fake;
before(async () => {
  fake = await startFakeOpenAI({ apiKey: KEY, basePath: '/v1' });
});
after(() => fake.close());

const make = (o = {}) => new OpenAIProvider({ apiKey: KEY, model: 'test-model', baseUrl: fake.url, retryDelayMs: 1, ...o });
const fresh = (script) => {
  fake.requests.length = 0;
  fake.setScript(script);
};
const TOOLS = [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
const ask = (p, extra = {}) => p.complete({ system: 'SYSTEM TEXT', messages: [{ role: 'user', content: 'hello' }], tools: TOOLS, ...extra });
const textOnly = (text = 'ok') => chatReply({ content: text });

// ---------- the request ----------
test('sends a Chat Completions request to {base}/chat/completions with a Bearer key', async () => {
  fresh([textOnly()]);
  await ask(make());
  assert.equal(fake.requests.length, 1);
  const r = fake.requests[0];
  assert.equal(r.method, 'POST');
  assert.equal(r.url, '/v1/chat/completions');
  assert.equal(r.headers.authorization, `Bearer ${KEY}`);
  assert.match(r.headers['content-type'], /application\/json/);
  assert.equal(r.body.model, 'test-model');
  assert.deepEqual(r.body.messages.slice(0, 2), [{ role: 'system', content: 'SYSTEM TEXT' }, { role: 'user', content: 'hello' }]);
  assert.ok(Number.isInteger(r.body.max_tokens) && r.body.max_tokens > 0);
  assert.equal(r.body.max_completion_tokens, undefined);
  assert.notEqual(r.body.stream, true);
  assert.equal('tool_choice' in r.body, false, 'tool_choice is left to the server default, for the widest compatibility');
});

test('tool definitions are mapped to the function-calling format', async () => {
  fresh([textOnly()]);
  await ask(make());
  assert.deepEqual(fake.requests[0].body.tools, [
    { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: TOOLS[0].input_schema } },
  ]);
  fresh([textOnly()]);
  await make().complete({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [] });
  assert.equal('tools' in fake.requests[0].body, false, 'no empty tools list is sent');
});

test('a whole conversation is mapped: assistant tool calls, one tool message per result, in order', async () => {
  fresh([textOnly()]);
  const messages = [
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: [
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } },
      { type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'b' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 't1', content: 'one', is_error: false },
      { type: 'tool_result', tool_use_id: 't2', content: 'Error: Not found: b', is_error: true },
    ] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'finish', input: { summary: 'Done.' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'Finished.', is_error: false }] },
    { role: 'assistant', content: [{ type: 'text', text: '(no reply)' }] },
    { role: 'user', content: 'You did not call a tool.' },
  ];
  await make().complete({ system: 'S', messages, tools: TOOLS });
  assert.deepEqual(fake.requests[0].body.messages, [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: 'Looking.', tool_calls: [
      { id: 't1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
      { id: 't2', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"}' } },
    ] },
    { role: 'tool', tool_call_id: 't1', content: 'one' },
    { role: 'tool', tool_call_id: 't2', content: 'Error: Not found: b' },
    { role: 'assistant', content: null, tool_calls: [{ id: 't3', type: 'function', function: { name: 'finish', arguments: '{"summary":"Done."}' } }] },
    { role: 'tool', tool_call_id: 't3', content: 'Finished.' },
    { role: 'assistant', content: '(no reply)' },
    { role: 'user', content: 'You did not call a tool.' },
  ]);
});

test('tool results given as text blocks are flattened to a string', async () => {
  fresh([textOnly()]);
  await make().complete({
    system: 'S',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }] }] },
    ],
    tools: TOOLS,
  });
  assert.equal(fake.requests[0].body.messages.at(-1).content, 'part one part two');
});

test('works with any base URL: a path prefix, a trailing slash, a port, no prefix at all', async () => {
  fresh([textOnly('a')]);
  assert.equal((await ask(make({ baseUrl: `${fake.url}/` }))).content[0].text, 'a');
  assert.equal(fake.requests[0].url, '/v1/chat/completions');
  const bare = await startFakeOpenAI({ apiKey: KEY, basePath: '', script: [textOnly('bare')] });
  const deep = await startFakeOpenAI({ apiKey: KEY, basePath: '/openai/v1', script: [textOnly('deep')] });
  try {
    assert.equal((await ask(make({ baseUrl: bare.url }))).content[0].text, 'bare');
    assert.equal(bare.requests[0].url, '/chat/completions');
    assert.equal((await ask(make({ baseUrl: deep.url }))).content[0].text, 'deep');
    assert.equal(deep.requests[0].url, '/openai/v1/chat/completions');
  } finally {
    await bare.close();
    await deep.close();
  }
});

test('the output limit field is max_tokens by default and configurable by constructor option only', async () => {
  fresh([textOnly(), textOnly()]);
  await ask(make({ maxTokens: 1234 }));
  assert.equal(fake.requests[0].body.max_tokens, 1234);
  await ask(make({ maxTokens: 777, maxTokensField: 'max_completion_tokens' }));
  assert.equal(fake.requests[1].body.max_completion_tokens, 777);
  assert.equal('max_tokens' in fake.requests[1].body, false);
});

// ---------- reading the reply ----------
test('a plain text reply', async () => {
  fresh([chatReply({ content: 'All done.', usage: { prompt_tokens: 321, completion_tokens: 45, total_tokens: 366 } })]);
  const out = await ask(make());
  assert.deepEqual(out.content, [{ type: 'text', text: 'All done.' }]);
  assert.equal(out.stopReason, 'end_turn');
  assert.deepEqual(out.usage, { inputTokens: 321, outputTokens: 45 });
  assert.equal(out.estimated, false);
});

test('tool_calls: the JSON-string arguments are parsed, in order, after any text', async () => {
  fresh([chatReply({ content: 'Looking.', toolCalls: [call('read_file', { path: 'a.txt' }, 'c1'), call('list_files', {}, 'c2')] })]);
  const out = await ask(make());
  assert.deepEqual(out.content, [
    { type: 'text', text: 'Looking.' },
    { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.txt' } },
    { type: 'tool_use', id: 'c2', name: 'list_files', input: {} },
  ]);
  assert.equal(out.stopReason, 'tool_use');
});

test('null content, content given as parts, and reasoning fields are handled', async () => {
  fresh([
    chatReply({ content: null, toolCalls: [call('read_file', { path: 'a' }, 'c1')] }),
    chatReply({ content: [{ type: 'text', text: 'part one ' }, { type: 'text', text: 'part two' }] }),
    chatReply({ content: 'visible', message: { reasoning_content: 'secret chain of thought', refusal: null } }),
  ]);
  assert.deepEqual((await ask(make())).content.map((b) => b.type), ['tool_use']);
  assert.deepEqual((await ask(make())).content, [{ type: 'text', text: 'part one part two' }]);
  assert.deepEqual((await ask(make())).content, [{ type: 'text', text: 'visible' }]);
});

test('arguments that are already an object, empty, or whitespace are accepted', async () => {
  fresh([
    chatReply({ toolCalls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: { path: 'obj' } } }] }),
    chatReply({ toolCalls: [call('list_files', '', 'c2'), call('list_files', '   ', 'c3'), { id: 'c4', type: 'function', function: { name: 'list_files' } }] }),
  ]);
  assert.deepEqual((await ask(make())).content[0].input, { path: 'obj' });
  const out = await ask(make());
  assert.deepEqual(out.content.map((b) => [b.id, b.input, b.inputError]), [['c2', {}, undefined], ['c3', {}, undefined], ['c4', {}, undefined]]);
});

test('missing or duplicate tool call ids get unique ids that are used consistently when sent back', async () => {
  fresh([
    chatReply({ toolCalls: [
      { type: 'function', function: { name: 'list_files', arguments: '{}' } },
      { id: 'dup', type: 'function', function: { name: 'list_files', arguments: '{}' } },
      { id: 'dup', type: 'function', function: { name: 'list_files', arguments: '{}' } },
      { id: '', type: 'function', function: { name: 'list_files', arguments: '{}' } },
    ] }),
    textOnly(),
  ]);
  const out = await ask(make());
  const ids = out.content.map((b) => b.id);
  assert.equal(new Set(ids).size, 4, `ids must be unique: ${ids}`);
  assert.ok(ids.every((id) => typeof id === 'string' && id.length > 0));
  assert.equal(ids[1], 'dup', 'a real id is kept');
  // Send it all back as the agent loop would, and check the very same ids go out.
  await make().complete({
    system: 'S',
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: out.content },
      { role: 'user', content: ids.map((id) => ({ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false })) },
    ],
    tools: TOOLS,
  });
  const sent = fake.requests[1].body.messages;
  assert.deepEqual(sent.find((m) => m.role === 'assistant').tool_calls.map((c) => c.id), ids);
  assert.deepEqual(sent.filter((m) => m.role === 'tool').map((m) => m.tool_call_id), ids);
});

test('calls that are not functions, or have no name, are ignored', async () => {
  fresh([chatReply({ toolCalls: [{ id: 'a', type: 'retrieval' }, { id: 'b', type: 'function', function: {} }, { id: 'c', type: 'function', function: { name: '' } }, call('read_file', { path: 'ok' }, 'd')] })]);
  const out = await ask(make());
  assert.deepEqual(out.content.map((b) => b.id), ['d']);
});

test('finish reasons map onto the same stop reasons as the Anthropic adapter', async () => {
  fresh([chatReply({ content: 'a', finish: 'stop' }), chatReply({ content: 'b', finish: 'length' }), chatReply({ content: 'c', finish: 'content_filter' }), chatReply({ toolCalls: [call('list_files', {})] })]);
  assert.deepEqual([(await ask(make())).stopReason, (await ask(make())).stopReason, (await ask(make())).stopReason, (await ask(make())).stopReason], ['end_turn', 'max_tokens', 'content_filter', 'tool_use']);
});

// ---------- malformed arguments are a TOOL error, never a crash ----------
const MALFORMED = [
  ['truncated JSON', '{"path": "a.txt"'],
  ['plain text', 'read the file please'],
  ['a trailing comma', '{"path": "a",}'],
  ['an array', '[1, 2]'],
  ['a string', '"just text"'],
  ['a number', '42'],
  ['null', 'null'],
  ['single quotes', "{'path': 'a'}"],
];

for (const [label, args] of MALFORMED) {
  test(`malformed arguments (${label}) become an inputError, with the call itself kept`, async () => {
    fresh([chatReply({ toolCalls: [call('read_file', args, 'bad1'), call('list_files', {}, 'good1')] })]);
    const out = await ask(make());
    assert.equal(out.content.length, 2, 'the other call is unaffected');
    const bad = out.content[0];
    assert.equal(bad.type, 'tool_use');
    assert.equal(bad.id, 'bad1');
    assert.equal(bad.name, 'read_file');
    assert.deepEqual(bad.input, {});
    assert.equal(typeof bad.inputError, 'string');
    assert.match(bad.inputError, /read_file/);
    assert.match(bad.inputError, /JSON/);
    assert.ok(bad.inputError.length < 300);
    assert.equal(out.content[1].inputError, undefined);
  });
}

test('a huge malformed argument string is never echoed back into the message', async () => {
  fresh([chatReply({ toolCalls: [call('read_file', 'x'.repeat(5000), 'bad1')] })]);
  const bad = (await ask(make())).content[0];
  assert.ok(bad.inputError.length < 300);
  assert.ok(!bad.inputError.includes('xxxxxxxxxx'));
});

test('truncated arguments from a reply that hit the output limit say so', async () => {
  fresh([chatReply({ toolCalls: [call('write_file', '{"path":"a.txt","content":"unfinished', 'cut')], finish: 'length' })]);
  const bad = (await ask(make())).content[0];
  assert.match(bad.inputError, /cut off|output limit/i);
  assert.match(bad.inputError, /write_file/);
});

test('the history that goes back never contains the malformed text: arguments are valid JSON', async () => {
  fresh([chatReply({ toolCalls: [call('read_file', '{"path": "a.txt"', 'bad1')] }), textOnly()]);
  const out = await ask(make());
  await make().complete({
    system: 'S',
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: out.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'bad1', content: `Error: ${out.content[0].inputError}`, is_error: true }] },
    ],
    tools: TOOLS,
  });
  const sent = fake.requests[1].body.messages;
  const args = sent.find((m) => m.role === 'assistant').tool_calls[0].function.arguments;
  assert.equal(args, '{}', 'strict servers reject invalid JSON in the history, so it is replaced');
  assert.match(sent.find((m) => m.role === 'tool').content, /^Error: .*read_file/);
});

// ---------- usage ----------
test('usage: prompt_tokens and completion_tokens; cached tokens are not added twice', async () => {
  fresh([chatReply({ content: 'x', usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens_details: { reasoning_tokens: 150 } } })]);
  const out = await ask(make());
  assert.deepEqual(out.usage, { inputTokens: 1000, outputTokens: 200 });
  assert.equal(out.estimated, false);
});

test('zero tokens is a real answer, not "missing"', async () => {
  fresh([chatReply({ content: 'x', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })]);
  const out = await ask(make());
  assert.deepEqual(out.usage, { inputTokens: 0, outputTokens: 0 });
  assert.equal(out.estimated, false);
});

for (const [label, usage] of [['absent', undefined], ['null', null], ['only a total', { total_tokens: 99 }], ['not numbers', { prompt_tokens: 'many', completion_tokens: 'few' }], ['negative', { prompt_tokens: -5, completion_tokens: 3 }]]) {
  test(`usage ${label}: estimated, rounded up, and flagged`, async () => {
    fresh([chatReply({ content: 'x'.repeat(10), usage })]);
    const out = await ask(make());
    assert.equal(out.estimated, true);
    assert.equal(out.usage.inputTokens, estimateTokens(fake.requests[0].raw));
    assert.equal(out.usage.outputTokens, estimateTokens(JSON.stringify({ role: 'assistant', content: 'x'.repeat(10) })));
    assert.ok(out.usage.inputTokens > 0 && out.usage.outputTokens > 0);
  });
}

// ---------- errors are all provider_error ----------
const failure = async (script, o = {}) => {
  fresh(script);
  return ask(make(o)).then(() => assert.fail('expected a provider error'), (e) => e);
};

test('401 and 403: the key was rejected, no retry, and the key never appears in the error', async () => {
  for (const status of [401, 403]) {
    fresh([apiError(status, 'nope')]);
    const err = await ask(make()).catch((e) => e);
    assert.ok(err instanceof ProviderError);
    assert.equal(err.code, 'provider_error');
    assert.match(err.message, new RegExp(`rejected the API key.*${status}|${status}.*rejected the API key`, 'i'));
    assert.match(err.message, /AI_API_KEY/);
    for (const text of [err.message, String(err), err.stack ?? '', JSON.stringify(err, Object.getOwnPropertyNames(err))]) {
      assert.ok(!text.includes('WRONG') && !text.includes(KEY), 'the key leaked into an error');
    }
    assert.equal(fake.requests.length, 1, 'no retry');
  }
  // the fake's 401 (a wrong key, echoed by the server) must not leak either
  fake.requests.length = 0;
  const err = await ask(make({ apiKey: 'sk-some-other-key-777' })).catch((e) => e);
  assert.ok(!JSON.stringify(err, Object.getOwnPropertyNames(err)).includes('sk-some-other-key-777'));
});

test('404 points at the model and the base URL', async () => {
  const err = await failure([apiError(404, 'The model `nope` does not exist', { code: 'model_not_found' })]);
  assert.equal(err.code, 'provider_error');
  assert.match(err.message, /AI_MODEL/);
  assert.match(err.message, /AI_BASE_URL/);
  assert.equal(fake.requests.length, 1);
});

test('429 is retried (honouring Retry-After) and can then succeed', async () => {
  fresh([apiError(429, 'Rate limit reached', { headers: { 'retry-after': '0' } }), textOnly('done')]);
  const out = await ask(make());
  assert.equal(out.content[0].text, 'done');
  assert.equal(fake.requests.length, 2);
});

test('a 429 that persists ends as a plain provider_error, after the retries, with a wait hint', async () => {
  const err = await failure([apiError(429, 'Rate limit reached for tokens per minute', { headers: { 'retry-after': '0' } })]);
  assert.equal(err.code, 'provider_error');
  assert.match(err.message, /rate-limit/i);
  assert.equal(fake.requests.length, 6, '1 try + 5 retries: a per-minute limit needs patience');
  const hinted = await failure([apiError(429, 'slow down', { headers: { 'retry-after': '37' } })], { rateLimitRetries: 0 });
  assert.match(hinted.message, /about 37 seconds/);
  assert.equal(fake.requests.length, 1);
});

test('429 for an account with no credit is not retried and says so', async () => {
  const err = await failure([apiError(429, 'You exceeded your current quota', { code: 'insufficient_quota', type: 'insufficient_quota' })]);
  assert.match(err.message, /quota|credit/i);
  assert.equal(fake.requests.length, 1);
});

test('5xx is retried twice, then reported as busy or unavailable', async () => {
  for (const status of [500, 502, 503]) {
    const err = await failure([apiError(status, 'upstream trouble')]);
    assert.equal(err.code, 'provider_error');
    assert.match(err.message, /busy|unavailable/i);
    assert.match(err.message, new RegExp(String(status)));
    assert.equal(fake.requests.length, 3);
  }
});

test('400 and 422 show the server\'s message (key scrubbed) and are not retried', async () => {
  const err = await failure([apiError(400, "This model's maximum context length is 8192 tokens. However, you requested 9000.", { code: 'context_length_exceeded' })]);
  assert.match(err.message, /400/);
  assert.match(err.message, /maximum context length/);
  assert.equal(fake.requests.length, 1);
  const leaky = await failure([apiError(422, `Bad request for key ${KEY} please check`)]);
  assert.match(leaky.message, /422/);
  assert.ok(!leaky.message.includes(KEY));
  assert.match(leaky.message, /\[hidden\]/);
});

test('a non-JSON error page is never echoed', async () => {
  const err = await failure([{ status: 502, rawBody: '<html><body><h1>Bad Gateway</h1><script>alert(1)</script></body></html>' }]);
  assert.ok(!/<html|<script|alert/.test(err.message));
  assert.match(err.message, /502/);
  const four = await failure([{ status: 400, rawBody: 'plain text from a proxy' }]);
  assert.match(four.message, /400/);
});

test('a 200 that carries an error, an empty choices list, or garbage is a provider_error', async () => {
  const e1 = await failure([{ status: 200, body: { error: { message: 'The server is overloaded', type: 'server_error' } } }]);
  assert.equal(e1.code, 'provider_error');
  assert.match(e1.message, /overloaded/);
  const e2 = await failure([{ status: 200, body: { choices: [] } }]);
  assert.match(e2.message, /could not be understood/i);
  const e3 = await failure([{ status: 200, body: 'not an object' }]);
  assert.match(e3.message, /could not be understood/i);
  const e4 = await failure([{ status: 200, rawBody: 'not json at all', contentType: 'text/plain' }]);
  assert.match(e4.message, /could not be understood/i);
  const e5 = await failure([{ status: 200, body: { choices: [{ finish_reason: 'stop' }] } }]);
  assert.match(e5.message, /could not be understood/i);
});

test('a dropped connection is retried, then reported', async () => {
  const err = await failure([{ destroy: true }]);
  assert.equal(err.code, 'provider_error');
  assert.match(err.message, /could not reach/i);
  assert.equal(fake.requests.length, 3);
});

// ---------- redirects, keys, and where the key may go ----------
test('a redirect is never followed, so the key cannot be forwarded to another address', async () => {
  const elsewhere = await startFakeOpenAI({ apiKey: null, script: [textOnly('stolen')] });
  try {
    const err = await failure([{ status: 302, rawBody: '', headers: { location: `${elsewhere.origin}/chat/completions` } }]);
    assert.equal(err.code, 'provider_error');
    assert.match(err.message, /redirect/i);
    assert.match(err.message, /AI_BASE_URL/);
    assert.equal(elsewhere.requests.length, 0, 'the other server must never be contacted');
    assert.equal(fake.requests.length, 1, 'and it is not retried');
    assert.ok(!err.message.includes(KEY));
  } finally {
    await elsewhere.close();
  }
  let opts;
  const p = new OpenAIProvider({ apiKey: KEY, model: 'm', baseUrl: 'https://api.groq.com/openai/v1', fetchImpl: async (url, o) => ((opts = o), new Response(JSON.stringify({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 })) });
  await ask(p);
  assert.equal(opts.redirect, 'manual');
});

test('the key travels only in the Authorization header, to the configured address', async () => {
  fresh([textOnly()]);
  await ask(make());
  const r = fake.requests[0];
  assert.ok(!r.raw.includes(KEY), 'not in the body');
  assert.ok(!r.url.includes(KEY), 'not in the URL');
  for (const [k, v] of Object.entries(r.headers)) if (k !== 'authorization') assert.ok(!String(v).includes(KEY), k);
});

test('nothing is ever written to the console, even when everything fails', async () => {
  const seen = [];
  const originals = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    originals[m] = console[m];
    console[m] = (...a) => seen.push(a.join(' '));
  }
  try {
    await failure([apiError(401, 'x')]);
    await ask(make({ apiKey: `${KEY}-X` })).catch(() => {});
    await failure([apiError(500, 'x')]);
    await failure([{ destroy: true }]);
    await failure([apiError(400, `echo ${KEY}`)]);
  } finally {
    Object.assign(console, originals);
  }
  assert.deepEqual(seen, []);
});

test('the key is private: not visible on the object or in its JSON', () => {
  const p = make();
  assert.ok(!JSON.stringify(p).includes(KEY));
  assert.ok(!Object.keys(p).some((k) => /key|secret|token/i.test(k)));
  assert.ok(!Object.getOwnPropertyNames(p).map((n) => String(p[n])).join('|').includes(KEY));
});

test('the base URL and key are never read from the environment', async () => {
  process.env.AI_BASE_URL = 'https://evil.example/v1';
  process.env.OPENAI_BASE_URL = 'https://evil.example/v1';
  process.env.OPENAI_API_KEY = 'sk-from-the-environment';
  try {
    let seen;
    const p = new OpenAIProvider({ apiKey: KEY, model: 'm', fetchImpl: async (url, o) => ((seen = { url: String(url), auth: o.headers.Authorization }), new Response(JSON.stringify({ choices: [{ message: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 })) });
    await ask(p);
    assert.equal(seen.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(seen.auth, `Bearer ${KEY}`);
  } finally {
    delete process.env.AI_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
  }
});

// ---------- readiness: a key is required unless the server is on this computer ----------
test('without a key, a remote server is refused before any request, in plain words', async () => {
  let called = false;
  const p = new OpenAIProvider({ apiKey: '', model: 'm', baseUrl: 'https://api.groq.com/openai/v1', fetchImpl: async () => ((called = true), new Response('{}')) });
  assert.throws(() => p.assertReady(), (e) => e instanceof ProviderError && e.code === 'provider_error' && /AI_API_KEY/.test(e.message));
  await assert.rejects(ask(p), (e) => /AI_API_KEY/.test(e.message));
  assert.equal(called, false);
});

test('without a key, a server on this computer is fine, and no Authorization header is sent', async () => {
  const local = await startFakeOpenAI({ apiKey: null, script: [textOnly('local')] });
  try {
    const p = new OpenAIProvider({ apiKey: '', model: 'm', baseUrl: local.url, retryDelayMs: 1 });
    assert.doesNotThrow(() => p.assertReady());
    assert.equal((await ask(p)).content[0].text, 'local');
    assert.equal(local.requests[0].headers.authorization, undefined);
  } finally {
    await local.close();
  }
});

test('with a key, a server on this computer gets it (some local servers want one)', async () => {
  const local = await startFakeOpenAI({ apiKey: 'local-secret', script: [textOnly('ok')] });
  try {
    const p = new OpenAIProvider({ apiKey: 'local-secret', model: 'm', baseUrl: local.url, retryDelayMs: 1 });
    await ask(p);
    assert.equal(local.requests[0].headers.authorization, 'Bearer local-secret');
  } finally {
    await local.close();
  }
});

test('the constructor refuses addresses the config would refuse (defence in depth)', () => {
  for (const baseUrl of ['http://api.groq.com/openai/v1', 'ftp://x/v1', 'https://user:pw@api.groq.com/v1', 'https://api.groq.com/v1?x=1', 'not a url', 'http://localhost.evil.com/v1']) {
    assert.throws(() => new OpenAIProvider({ apiKey: KEY, model: 'm', baseUrl }), /AI_BASE_URL/, baseUrl);
  }
  assert.doesNotThrow(() => new OpenAIProvider({ apiKey: KEY, model: 'm', baseUrl: 'http://localhost:11434/v1' }));
  assert.doesNotThrow(() => new OpenAIProvider({ apiKey: KEY, model: 'm' }));
});

test('the provider reports where requests go and which model, without the key', () => {
  const p = new OpenAIProvider({ apiKey: KEY, model: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1' });
  assert.equal(p.host, 'api.groq.com');
  assert.deepEqual(p.describe(), { provider: 'openai', model: 'llama-3.3-70b-versatile', host: 'api.groq.com' });
  assert.ok(!JSON.stringify(p.describe()).includes(KEY));
  assert.equal(new OpenAIProvider({ apiKey: KEY, model: 'm', baseUrl: 'http://localhost:11434/v1' }).host, 'localhost:11434');
});

// ---------- cancel and timeout ----------
test('cancelling mid-call throws an abort that carries a rounded-up input estimate', async () => {
  fresh([chatReply({ content: 'slow', delayMs: 3000 })]);
  const ctl = new AbortController();
  const pending = ask(make(), { signal: ctl.signal });
  while (fake.requests.length < 1) await new Promise((r) => setTimeout(r, 5));
  ctl.abort();
  await assert.rejects(pending, (e) => {
    assert.equal(e.aborted, true);
    assert.equal(e.estimatedInputTokens, Math.ceil(fake.requests[0].raw.length / 4));
    return true;
  });
});

test('an already-cancelled signal aborts before any request, still with an estimate', async () => {
  fresh([textOnly()]);
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(ask(make(), { signal: ctl.signal }), (e) => e.aborted === true && e.estimatedInputTokens > 0);
  assert.equal(fake.requests.length, 0);
});

test('a slow server times out with a plain message and an estimate', async () => {
  fresh([chatReply({ content: 'slow', delayMs: 3000 })]);
  await assert.rejects(ask(make({ requestTimeoutMs: 100, retries: 0 })), (e) => e instanceof ProviderError && /too long|timed out/i.test(e.message) && e.estimatedInputTokens > 0);
});

// ---------- same interface as the Anthropic adapter ----------
test('it is a drop-in: the same methods and the same result shape', async () => {
  const { AnthropicProvider } = await import('../../supervisor/services/providers/anthropic.js');
  const a = new AnthropicProvider({ apiKey: KEY, model: 'm' });
  const o = make();
  for (const method of ['assertReady', 'complete']) assert.equal(typeof o[method], typeof a[method], method);
  fresh([textOnly()]);
  assert.deepEqual(Object.keys(await ask(o)).sort(), ['content', 'estimated', 'stopReason', 'usage']);
});

// ---------- the base-URL rules shared with the config ----------
test('normalizeBaseUrl: accepts the good, refuses the unsafe, never echoes credentials', () => {
  assert.deepEqual(normalizeBaseUrl('https://api.groq.com/openai/v1/'), { url: 'https://api.groq.com/openai/v1', host: 'api.groq.com', loopback: false });
  assert.equal(normalizeBaseUrl(' https://api.openai.com/v1 ').url, 'https://api.openai.com/v1');
  for (const ok of ['http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://[::1]:8080/v1']) assert.equal(normalizeBaseUrl(ok).loopback, true, ok);
  for (const bad of ['http://api.groq.com/v1', 'http://192.168.1.5:11434/v1', 'http://localhost.evil.com/v1', 'http://127.0.0.1.evil.com/v1', 'ftp://x', 'file:///etc/passwd', 'javascript:alert(1)', 'api.groq.com/v1', '', '   ', 'https://', 'https://api.groq.com/v1?key=abc', 'https://api.groq.com/v1#x', 'https://api.groq.com/openai/v1/chat/completions', 5, null]) {
    assert.throws(() => normalizeBaseUrl(bad), /AI_BASE_URL/, String(bad));
  }
  assert.throws(() => normalizeBaseUrl('https://user:topsecretpw@api.groq.com/v1'), (e) => /AI_BASE_URL/.test(e.message) && !/topsecretpw|user/.test(e.message));
  assert.throws(() => normalizeBaseUrl('https://api.groq.com/v1?key=sk-abc123'), (e) => !/sk-abc123/.test(e.message));
});

// ---------- the provider refusing the MODEL's own malformed tool call (Groq: 400 tool_use_failed) ----------
const FAILED_TEXT = '<function=edit_file>{"path": "public/index.html", "old_text": "<h1>';

test('a 400 "tool_use_failed" is a recoverable result, not an error: the loop can tell the model and carry on', async () => {
  fresh([toolUseFailed(FAILED_TEXT)]);
  const out = await ask(make());
  assert.equal(fake.requests.length, 1, 'the adapter does not retry: the agent loop retries with a hint');
  assert.deepEqual(out.content.map((b) => b.type), ['text']);
  assert.match(out.content[0].text, /not valid JSON/i);
  assert.match(out.content[0].text, /again/i);
  assert.equal(out.stopReason, 'end_turn');
  assert.equal(out.toolFormatFailure, true);
  assert.equal(out.estimated, true);
  // Real tokens were spent on the failed generation, so the cost is estimated, rounded up.
  assert.equal(out.usage.inputTokens, estimateTokens(fake.requests[0].raw));
  assert.equal(out.usage.outputTokens, estimateTokens(FAILED_TEXT));
  assert.ok(!out.content[0].text.includes('<function='), 'the raw failed text is not echoed back to the model');
});

test('it is recognised by its message too, and without failed_generation the output cost is zero', async () => {
  fresh([apiError(400, 'Failed to parse tool call arguments as JSON', { type: 'invalid_request_error' })]);
  const out = await ask(make());
  assert.equal(out.toolFormatFailure, true);
  assert.equal(out.usage.outputTokens, 0);
});

const PARSING_FAILED = "Parsing failed. The model generated output that could not be parsed. Please adjust your prompt. See 'failed_generation' for more details.";

test('the newer "Parsing failed" 400 is recoverable too, with or without an error code', async () => {
  for (const code of [undefined, 'json_validate_failed', 'tool_use_failed']) {
    fresh([apiError(400, PARSING_FAILED, { code, type: 'invalid_request_error', failedGeneration: FAILED_TEXT })]);
    const out = await ask(make());
    assert.equal(out.toolFormatFailure, true, String(code));
    assert.equal(out.usage.outputTokens, estimateTokens(FAILED_TEXT));
  }
  fresh([apiError(400, PARSING_FAILED, { type: 'invalid_request_error' })]); // recognised by its message alone
  assert.equal((await ask(make())).toolFormatFailure, true);
});

// ---------- the provider's DAILY limit: say so, and do not wait for hours ----------
const DAILY = 'Rate limit reached for model `m` in organization `org_x` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 199648, Requested 424. Please try again in 31.104s.';

test('a daily-limit 429 is announced as a daily limit, retried twice, then reported plainly', async () => {
  fresh([apiError(429, DAILY, { code: 'rate_limit_exceeded', headers: { 'retry-after': '0.01' } })]);
  const waits = [];
  const err = await ask(make({ retryDelayMs: 1 }), { onWait: (w) => waits.push(w) }).catch((e) => e);
  assert.ok(err instanceof ProviderError);
  assert.match(err.message, /daily/i);
  assert.match(err.message, /another|different|upgrade|tomorrow|later/i, 'it says what to do');
  assert.deepEqual(waits.map((w) => w.reason), ['daily_limit', 'daily_limit']);
  assert.equal(fake.requests.length, 3, 'the first try plus two retries, not five');
  assert.ok(!err.message.includes(KEY));
});

test('a daily limit that will take a long time to clear is reported at once, without waiting', async () => {
  fresh([apiError(429, DAILY.replace('31.104s', '2h5m3s'), { code: 'rate_limit_exceeded', headers: { 'retry-after': '7503' } })]);
  const waits = [];
  const { value: err, ms } = await timed(() => ask(make({ retryDelayMs: 1 }), { onWait: (w) => waits.push(w) }).catch((e) => e));
  assert.ok(err instanceof ProviderError);
  assert.match(err.message, /daily/i);
  assert.equal(waits.length, 0);
  assert.equal(fake.requests.length, 1);
  assert.ok(ms < 1000);
});

test('a huge failed_generation is costed but capped, and never echoed or leaked', async () => {
  fresh([toolUseFailed(`${KEY} ${'x'.repeat(400000)}`)]);
  const out = await ask(make());
  assert.ok(out.usage.outputTokens > 0 && out.usage.outputTokens <= 8192, `cost was ${out.usage.outputTokens}`);
  assert.ok(!JSON.stringify(out).includes(KEY));
});

test('every other 400 is still a plain provider_error (only the tool-format failure is recoverable)', async () => {
  for (const [message, code] of [["This model's maximum context length is 8192 tokens.", 'context_length_exceeded'], ['Invalid value for tools[0].function.parameters', 'invalid_request_error'], ['Failed to parse the request body', undefined]]) {
    const err = await failure([apiError(400, message, { code })]);
    assert.equal(err.code, 'provider_error', message);
    assert.match(err.message, /HTTP 400/);
  }
});

// ---------- rate limits: wait as long as the provider asks, grow the wait, and say so ----------
const timed = async (fn) => {
  const t0 = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - t0 };
};

test('a 429 waits for Retry-After in full (not a fixed 10 seconds), including fractions', async () => {
  fresh([apiError(429, 'slow down', { headers: { 'retry-after': '0.3' } }), textOnly('done')]);
  const { value, ms } = await timed(() => ask(make({ retryDelayMs: 1 })));
  assert.equal(value.content[0].text, 'done');
  assert.ok(ms >= 290, `waited only ${ms} ms`);
  assert.equal(fake.requests.length, 2);
});

test('the wait is capped by maxRetryWaitMs (default one minute)', async () => {
  fresh([apiError(429, 'x', { headers: { 'retry-after': '9999' } }), textOnly('done')]);
  const { ms } = await timed(() => ask(make({ maxRetryWaitMs: 120, retryDelayMs: 1 })));
  assert.ok(ms >= 110 && ms < 2000, `waited ${ms} ms`);
});

test('the wait grows when Retry-After is small or missing (so a rolling per-minute limit can clear)', async () => {
  // retryDelayMs 20 -> waits of 80, 160 and 320 ms before the fourth try
  fresh([apiError(429, 'x'), apiError(429, 'x', { headers: { 'retry-after': '0' } }), apiError(429, 'x'), textOnly('ok')]);
  const { value, ms } = await timed(() => ask(make({ retryDelayMs: 20 })));
  assert.equal(value.content[0].text, 'ok');
  assert.equal(fake.requests.length, 4);
  assert.ok(ms >= 540, `the waits added up to only ${ms} ms`);
});

test('onWait is told about every wait: whole seconds rounded up, and why', async () => {
  fresh([apiError(429, 'x', { headers: { 'retry-after': '0.3' } }), apiError(503, 'x'), textOnly('ok')]);
  const waits = [];
  await ask(make({ retryDelayMs: 1 }), { onWait: (w) => waits.push(w) });
  assert.deepEqual(waits.map((w) => w.reason), ['rate_limit', 'unavailable']);
  assert.equal(waits[0].seconds, 1, '0.3 seconds is announced as 1');
  assert.ok(waits.every((w) => Number.isInteger(w.seconds) && w.seconds >= 1));
});

test('onWait is not called when there is no further try, and it is optional', async () => {
  const waits = [];
  await failure([apiError(429, 'x', { headers: { 'retry-after': '0' } })], { rateLimitRetries: 2 }).then(() => {});
  fresh([apiError(429, 'x', { headers: { 'retry-after': '0' } })]);
  await ask(make({ rateLimitRetries: 2 }), { onWait: (w) => waits.push(w) }).catch(() => {});
  assert.equal(waits.length, 2, 'two retries, two waits, none after the last failure');
  fresh([apiError(429, 'x', { headers: { 'retry-after': '0' } }), textOnly('fine')]);
  assert.equal((await ask(make())).content[0].text, 'fine');
});

test('a long wait can be cancelled at once, still counting the estimated input', async () => {
  fresh([apiError(429, 'x', { headers: { 'retry-after': '30' } })]);
  const ctl = new AbortController();
  const t0 = Date.now();
  const pending = ask(make({ maxRetryWaitMs: 30000 }), { signal: ctl.signal });
  while (fake.requests.length < 1) await new Promise((r) => setTimeout(r, 5));
  setTimeout(() => ctl.abort(), 100);
  await assert.rejects(pending, (e) => e.aborted === true && e.estimatedInputTokens > 0);
  assert.ok(Date.now() - t0 < 2500, 'cancel must not wait out the 30 seconds');
  assert.equal(fake.requests.length, 1);
});

test('5xx and dropped connections keep their two quick retries (only rate limits get the long patience)', async () => {
  const err = await failure([apiError(503, 'x')]);
  assert.match(err.message, /busy|unavailable/i);
  assert.equal(fake.requests.length, 3);
});

// ---------- providers with extra fields (Gemini) ----------
// Gemini 3 puts a "thought signature" on each tool call (under extra_content) and answers 400 if it
// is not sent back with the history. Any extra_content is kept and returned untouched, so such providers work.
const SIGNED = { google: { thought_signature: 'SIG-abc123==' } };

test('extra_content on a tool call is kept, and sent back unchanged with the history', async () => {
  fresh([chatReply({ toolCalls: [{ ...call('read_file', { path: 'a' }, 'c1'), extra_content: SIGNED }, call('list_files', {}, 'c2')] })]);
  const out = await ask(make());
  assert.deepEqual(out.content[0].extraContent, SIGNED);
  assert.equal('extraContent' in out.content[1], false, 'calls without it get nothing added');

  fresh([textOnly()]);
  await make().complete({
    system: 's',
    tools: TOOLS,
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: out.content },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'x' }, { type: 'tool_result', tool_use_id: 'c2', content: 'y' }] },
    ],
  });
  const sent = fake.requests[0].body.messages.find((m) => m.role === 'assistant').tool_calls;
  assert.deepEqual(sent[0].extra_content, SIGNED);
  assert.equal('extra_content' in sent[1], false);
});

test('only a plain object is accepted as extra_content (anything else is dropped, never forwarded)', async () => {
  for (const bad of ['text', 5, null, ['x'], true]) {
    fresh([chatReply({ toolCalls: [{ ...call('read_file', {}, 'c1'), extra_content: bad }] })]);
    const out = await ask(make());
    assert.equal('extraContent' in out.content[0], false, `dropped: ${JSON.stringify(bad)}`);
  }
});

test('the key is never sent inside extra_content or anywhere but the Authorization header', async () => {
  fresh([chatReply({ toolCalls: [{ ...call('read_file', {}, 'c1'), extra_content: SIGNED }] })]);
  await ask(make());
  assert.ok(!fake.requests[0].raw.includes(KEY));
});

test('an error body that is an array (Gemini) still shows its message, key scrubbed, and is not retried', async () => {
  const err = await failure([{ status: 400, body: [{ error: { code: 400, message: 'Function call is missing a thought_signature', status: 'INVALID_ARGUMENT' } }] }]);
  assert.match(err.message, /400/);
  assert.match(err.message, /missing a thought_signature/);
  assert.equal(fake.requests.length, 1);
  const leaky = await failure([{ status: 400, body: [{ error: { message: `bad key ${KEY}` } }] }]);
  assert.ok(!leaky.message.includes(KEY));
  assert.match(leaky.message, /\[hidden\]/);
});

test('an array-shaped tool-format failure is still recoverable', async () => {
  fresh([{ status: 400, body: [{ error: { message: 'Failed to parse tool call arguments as JSON', code: 'tool_use_failed' } }] }]);
  const out = await ask(make());
  assert.equal(out.toolFormatFailure, true);
});
