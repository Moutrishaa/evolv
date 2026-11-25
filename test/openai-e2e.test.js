// A real supervisor, real sandboxed app and real HTTP routes, with an OpenAI-compatible fake
// server as the AI. Proves the adapter is a drop-in for the whole pipeline, that errors reach
// the user in plain words, and that the key never leaves the supervisor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSupervisor } from '../supervisor/main.js';
import { loadConfig } from '../supervisor/config.js';
import { startEnv, openaiChangeScript, AI_KEY } from '../test-fixtures/env.js';
import { chatReply, call, apiError } from '../test-fixtures/fake-openai.js';
import { startPoller } from '../test-fixtures/net.js';
import { makeTempDir, getFreePort, getConsolePortFor, request, gitOut, ROOT } from '../test-fixtures/helpers.js';

const NAVY_CSS = fs.readFileSync(path.join(ROOT, 'seed', 'public', 'style.css'), 'utf8').replace('#fafafa', '#000080');
const openai = (opts = {}) => startEnv({ provider: 'openai', ...opts });

/** Every place the key could leak to: console API, app pages, event streams, and files on disk. */
async function assertKeyNowhere(env, events, key = AI_KEY) {
  const texts = [
    JSON.stringify(await env.status()),
    (await request(`${env.cbase}/api/logs`, { headers: env.auth })).body,
    (await request(`${env.base}/`)).body,
    (await request(`${env.base}/_evolv`)).body,
    (await request(`${env.cbase}/`)).body,
    JSON.stringify(events ?? []),
  ];
  for (const t of texts) assert.ok(!t.includes(key), 'the key reached a browser-facing response');
  const scan = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) scan(full);
      else assert.ok(!fs.readFileSync(full).includes(key), `the key was written to ${full}`);
    }
  };
  scan(path.join(env.root, 'state'));
  scan(env.appDir);
  for (const r of env.fake.requests) {
    assert.ok(!r.raw.includes(key) && !r.url.includes(key), 'the key was sent anywhere but the Authorization header');
  }
}

test('a change goes live through the OpenAI-compatible adapter, and Status shows the provider, model and host', async () => {
  const env = await openai({ script: openaiChangeScript({ 'public/style.css': NAVY_CSS }, 'Made the page background navy.') });
  try {
    const { events, last } = await env.runChange('Change the background to dark navy');
    assert.equal(last.type, 'done', JSON.stringify(last));
    assert.equal(last.data.version, 2);
    assert.match((await request(`${env.base}/style.css`)).body, /#000080/);

    // What was actually sent to the (fake) provider.
    const req = env.fake.requests[0];
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, `Bearer ${AI_KEY}`);
    assert.equal(req.body.model, 'test-model-x');
    assert.equal(req.body.messages[0].role, 'system');
    assert.deepEqual(req.body.tools.map((t) => t.function.name).sort(), ['delete_file', 'edit_file', 'finish', 'list_files', 'read_file', 'search', 'write_file']);
    assert.ok(req.body.tools.every((t) => t.type === 'function' && t.function.parameters.type === 'object'));

    const status = await env.status();
    assert.deepEqual(status.ai, { provider: 'openai', model: 'test-model-x', host: `127.0.0.1:${new URL(env.fake.url).port}` });
    assert.ok(status.budget.used > 0, 'usage from prompt_tokens and completion_tokens is counted');
    await assertKeyNowhere(env, events);
  } finally {
    await env.close();
  }
});

test('Status tells the same story for the Anthropic provider (host and model, no key)', async () => {
  const env = await startEnv({ script: [] });
  try {
    const status = await env.status();
    assert.equal(status.ai.provider, 'anthropic');
    assert.ok(status.ai.model && status.ai.host);
    assert.ok(!JSON.stringify(status.ai).includes(AI_KEY));
  } finally {
    await env.close();
  }
});

test('malformed tool arguments are a tool error and the change still succeeds', async () => {
  const good = openaiChangeScript({ 'public/style.css': NAVY_CSS }, 'Made the page navy.')[0];
  const env = await openai({
    script: (body, n) => (n === 0 ? chatReply({ toolCalls: [call('read_file', '{"path": "public/style.css"', 'bad1')] }) : good),
  });
  try {
    const { last } = await env.runChange('Make it navy');
    assert.equal(last.type, 'done', JSON.stringify(last));
    const second = env.fake.requests[1].body.messages;
    const assistant = second.find((m) => m.role === 'assistant');
    assert.equal(assistant.tool_calls[0].function.arguments, '{}', 'the malformed text is not sent back');
    const toolMsg = second.find((m) => m.role === 'tool');
    assert.equal(toolMsg.tool_call_id, 'bad1');
    assert.match(toolMsg.content, /^Error: .*read_file.*not valid JSON/);
    assert.match((await request(`${env.base}/style.css`)).body, /#000080/);
  } finally {
    await env.close();
  }
});

test('a persistent rate limit fails the change in plain words; the live app is untouched; nothing is spent', async () => {
  const env = await openai({ script: [apiError(429, 'Rate limit reached for tokens per minute', { headers: { 'retry-after': '0' } })] });
  try {
    const pid = env.sup.app.status().pid;
    const poller = startPoller(`${env.base}/`, { intervalMs: 20 });
    const { events, last } = await env.runChange('Make it navy');
    const polled = await poller.stop();
    assert.equal(last.type, 'failed');
    assert.equal(last.data.code, 'provider_error');
    assert.match(last.data.message, /rate-limit/i);
    assert.match(last.data.message, /your app was not changed/i);
    assert.equal(env.fake.requests.length, 3, '1 try + 2 retries');
    assert.deepEqual(polled.failures, []);
    assert.equal(env.sup.app.status().pid, pid);
    assert.equal((await env.versions()).length, 1);
    assert.deepEqual(env.workspaces(), []);
    assert.equal((await env.status()).budget.used, 0, 'a refused call costs nothing');
    await assertKeyNowhere(env, events);
  } finally {
    await env.close();
  }
});

test('a rejected key is explained without ever showing a key, including the one the server echoes back', async () => {
  const wrong = 'sk-wrong-key-must-not-leak-zzz';
  const env = await openai({ envText: `AI_API_KEY=${wrong}\n`, script: openaiChangeScript({ 'a.txt': 'x' }) });
  try {
    const { events, last } = await env.runChange('Make a file');
    assert.equal(last.type, 'failed');
    assert.equal(last.data.code, 'provider_error');
    assert.match(last.data.message, /rejected the API key/i);
    assert.match(last.data.message, /AI_API_KEY/);
    assert.equal(env.fake.requests.length, 1);
    await assertKeyNowhere(env, events, wrong);
    await assertKeyNowhere(env, events, AI_KEY);
  } finally {
    await env.close();
  }
});

test('with no key and a remote address, a change is refused before anything is sent; nothing else is affected', async () => {
  const tmp = makeTempDir('evolv-nokey-');
  fs.cpSync(path.join(ROOT, 'seed'), path.join(tmp.dir, 'seed'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'console'), path.join(tmp.dir, 'console'), { recursive: true });
  const port = await getFreePort();
  const config = loadConfig({
    envText: 'AI_PROVIDER=openai\nAI_MODEL=llama-3.3-70b-versatile\nAI_BASE_URL=https://api.groq.com/openai/v1\n',
    env: { PORT: String(port), CONSOLE_PORT: String(await getConsolePortFor(port)) },
  });
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (...a) => (calls.push(String(a[0])), realFetch(...a));
  const sup = await startSupervisor({ config, root: tmp.dir, appPort: await getFreePort(), verifySettleMs: 200 });
  try {
    assert.throws(() => sup.changes.start('anything'), (e) => e.code === 'provider_error' && /AI_API_KEY/.test(e.message));
    assert.deepEqual(calls, [], 'nothing was sent anywhere');
    assert.deepEqual(sup.ai, { provider: 'openai', model: 'llama-3.3-70b-versatile', host: 'api.groq.com' });
    assert.equal((await gitOut(path.join(tmp.dir, 'app'), ['status', '--porcelain'])).trim(), '');
  } finally {
    globalThis.fetch = realFetch;
    await sup.close();
    tmp.cleanup();
  }
});

test('the app origin never reveals which provider is in use', async () => {
  const env = await openai({ script: [] });
  try {
    for (const p of ['/_evolv', '/_evolv/api/status', '/_evolv/api/ai', '/']) {
      const body = (await request(`${env.base}${p}`)).body;
      assert.ok(!/test-model-x|127\.0\.0\.1:\d+\/v1|openai/i.test(body.replace(/Recovery console|127\.0\.0\.1:\d+\/#?/g, '')), p);
    }
  } finally {
    await env.close();
  }
});
