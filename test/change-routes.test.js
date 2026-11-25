// POST /changes, POST /changes/:id/cancel and GET /changes/:id/events: validation, limits,
// error shapes, and what a hostile app page can and cannot do with them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createChangeRoutes } from '../supervisor/change-routes.js';
import { createAppApi, createFrontHandler } from '../supervisor/api.js';
import { EventHub } from '../supervisor/events.js';
import { ChangeError } from '../supervisor/changes.js';
import { startEnv, changeScript, AI_KEY } from '../test-fixtures/env.js';
import { readSse } from '../test-fixtures/net.js';
import { reply, toolUse } from '../test-fixtures/fake-provider.js';
import { request, getFreePort, getConsolePortFor, waitFor, sleep } from '../test-fixtures/helpers.js';

const JSON_HDR = (origin) => ({ 'Content-Type': 'application/json', Origin: origin });
const post = (env, urlPath, body, { origin = env.base, headers = {}, raw } = {}) =>
  request(`${env.base}${urlPath}`, { method: 'POST', headers: { ...JSON_HDR(origin), ...headers }, body: raw ?? JSON.stringify(body) });
const errorOf = (res) => JSON.parse(res.body).error;

// A slow-but-valid change keeps the runner busy long enough to poke at it.
const SLOW = [reply([toolUse('write_file', { path: 'a.txt', content: 'x' }), toolUse('finish', { summary: 'Slow.' })], { delayMs: 2500 })];

test('POST /changes on the app origin: 202 and an unguessable id; the same on the console origin with a token', async () => {
  const env = await startEnv({ script: changeScript({ 'public/extra.txt': 'hi' }, 'Added a file.') });
  try {
    const a = await post(env, '/_evolv/api/changes', { request: 'Add a file' });
    assert.equal(a.status, 202);
    const { id } = JSON.parse(a.body);
    assert.match(id, /^[A-Za-z0-9_-]{22}$/);
    await readSse(`${env.base}/_evolv/api/changes/${id}/events`, { until: (e) => e.type === 'done' || e.type === 'failed' });

    env.fake.setScript(() => changeScript({ 'public/extra2.txt': 'hi' }, 'Added another.')[0]);
    const c = await request(`${env.cbase}/api/changes`, { method: 'POST', headers: { ...JSON_HDR(env.cbase), ...env.auth }, body: JSON.stringify({ request: 'Add another file' }) });
    assert.equal(c.status, 202);
    const id2 = JSON.parse(c.body).id;
    assert.notEqual(id2, id);
    const sse = await readSse(`${env.cbase}/api/changes/${id2}/events`, { headers: env.auth, until: (e) => e.type === 'done' || e.type === 'failed' });
    assert.equal(sse.events.at(-1).type, 'done');
    // The console origin refuses the same call without its token.
    assert.equal((await request(`${env.cbase}/api/changes`, { method: 'POST', headers: JSON_HDR(env.cbase), body: '{"request":"x"}' })).status, 401);
  } finally {
    await env.close();
  }
});

test('validation: bad content type, bad JSON, bad shape, bad size - all refused before any AI call', async () => {
  const env = await startEnv({ script: SLOW });
  try {
    const cases = [
      ['no content type', { raw: '{"request":"x"}', headers: { 'Content-Type': undefined } }, 415, 'invalid_request'],
      ['text/plain', { raw: '{"request":"x"}', headers: { 'Content-Type': 'text/plain' } }, 415, 'invalid_request'],
      ['a form post', { raw: 'request=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }, 415, 'invalid_request'],
      ['broken JSON', { raw: '{ nope' }, 400, 'invalid_request'],
      ['an array', { raw: '[]' }, 400, 'invalid_request'],
      ['a string', { raw: '"x"' }, 400, 'invalid_request'],
      ['null', { raw: 'null' }, 400, 'invalid_request'],
      ['no request field', { raw: '{}' }, 400, 'invalid_request'],
      ['request not text', { raw: '{"request":5}' }, 400, 'invalid_request'],
      ['empty request', { raw: '{"request":"   "}' }, 400, 'invalid_request'],
      ['4001 characters', { raw: JSON.stringify({ request: 'y'.repeat(4001) }) }, 400, 'invalid_request'],
      ['a control character', { raw: JSON.stringify({ request: 'a\u0007b' }) }, 400, 'invalid_request'],
      ['a body over 16 KB', { raw: JSON.stringify({ request: 'z'.repeat(20000) }) }, 413, 'invalid_request'],
    ];
    for (const [label, opts, status, code] of cases) {
      const headers = { ...JSON_HDR(env.base), ...(opts.headers ?? {}) };
      for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
      const res = await request(`${env.base}/_evolv/api/changes`, { method: 'POST', headers, body: opts.raw });
      assert.equal(res.status, status, `${label}: ${res.body.slice(0, 100)}`);
      const err = errorOf(res);
      assert.equal(err.code, code, label);
      assert.equal(typeof err.message, 'string', label);
    }
    assert.equal(env.fake.requests.length, 0, 'no AI call for any refused request');
    assert.deepEqual(env.workspaces(), []);
    // exactly 4,000 characters is fine
    assert.equal((await post(env, '/_evolv/api/changes', { request: 'y'.repeat(4000) })).status, 202);
  } finally {
    await env.close();
  }
});

test('submit and cancel still need the exact Origin (no cross-site posting)', async () => {
  const env = await startEnv({ script: SLOW });
  try {
    for (const origin of ['http://evil.example', env.cbase, 'null']) {
      assert.equal((await post(env, '/_evolv/api/changes', { request: 'x' }, { origin })).status, 403, origin);
    }
    const noOrigin = await request(`${env.base}/_evolv/api/changes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"request":"x"}' });
    assert.equal(noOrigin.status, 403);
    assert.equal(env.fake.requests.length, 0);
    assert.equal((await post(env, '/_evolv/api/changes/aaaaaaaaaaaaaaaaaaaaaa/cancel', {}, { origin: 'http://evil.example' })).status, 403);
  } finally {
    await env.close();
  }
});

test('busy (409), budget (429) and a damaged ledger (503) come back as plain JSON errors', async () => {
  const env = await startEnv({ script: SLOW, tokenBudget: 1000 });
  try {
    const first = await post(env, '/_evolv/api/changes', { request: 'first' });
    assert.equal(first.status, 202);
    const busy = await post(env, '/_evolv/api/changes', { request: 'second' });
    assert.equal(busy.status, 409);
    assert.equal(errorOf(busy).code, 'busy');
    assert.match(errorOf(busy).message, /already running/i);
    const { id } = JSON.parse(first.body);
    await readSse(`${env.base}/_evolv/api/changes/${id}/events`, { until: (e) => e.type === 'done' || e.type === 'failed' });

    env.sup.ledger.record('spent', { inputTokens: 5000, outputTokens: 0 });
    const calls = env.fake.requests.length;
    const budget = await post(env, '/_evolv/api/changes', { request: 'third' });
    assert.equal(budget.status, 429);
    assert.equal(errorOf(budget).code, 'budget_exhausted');
    assert.match(errorOf(budget).message, /budget is spent/i);
    assert.equal(env.fake.requests.length, calls, 'refused before any AI call');
  } finally {
    await env.close();
  }

  const damaged = await startEnv({
    script: SLOW,
    prepare: (root) => {
      fs.mkdirSync(path.join(root, 'state'), { recursive: true });
      fs.writeFileSync(path.join(root, 'state', 'usage.json'), 'garbage');
    },
  });
  try {
    const res = await post(damaged, '/_evolv/api/changes', { request: 'x' });
    assert.equal(res.status, 503);
    assert.equal(errorOf(res).code, 'ledger_unreadable');
    assert.ok(errorOf(res).message.includes(path.join(damaged.root, 'state', 'usage.json')), 'names the file');
    assert.equal(damaged.fake.requests.length, 0);
  } finally {
    await damaged.close();
  }
});

test('events: available the instant a change is accepted, with the right headers and nothing secret', async () => {
  const env = await startEnv({ script: changeScript({ 'public/extra.txt': 'hi' }, 'Added a file.') });
  try {
    const { id } = JSON.parse((await post(env, '/_evolv/api/changes', { request: 'Add a file' })).body);
    const sse = await readSse(`${env.base}/_evolv/api/changes/${id}/events`, { until: (e) => e.type === 'done' || e.type === 'failed' });
    assert.equal(sse.status, 200, 'never a 404 right after the id is handed out');
    const h = sse.headers;
    assert.match(h['content-type'], /^text\/event-stream/);
    assert.equal(h['cache-control'], 'no-store');
    assert.equal(h['x-content-type-options'], 'nosniff');
    assert.equal(h['x-evolv-supervisor'], '1');
    assert.ok(!Object.keys(h).some((k) => k.startsWith('access-control-')), 'no CORS');
    assert.equal(sse.events[0].type, 'accepted');
    assert.ok(!JSON.stringify(sse.events).includes(AI_KEY) && !JSON.stringify(sse.events).includes(env.root));
    // replay for a finished change works too
    const again = await readSse(`${env.base}/_evolv/api/changes/${id}/events`);
    assert.deepEqual(again.events.map((e) => e.type), sse.events.map((e) => e.type));
  } finally {
    await env.close();
  }
});

test('events: unknown and malformed ids are 404; no other way to list or read changes exists', async () => {
  const env = await startEnv({ script: SLOW });
  try {
    for (const id of ['aaaaaaaaaaaaaaaaaaaaaa', 'short', '..', 'a%2Fb', 'x'.repeat(70)]) {
      const res = await readSse(`${env.base}/_evolv/api/changes/${id}/events`);
      assert.equal(res.status, 404, id);
    }
    for (const [method, p] of [['GET', '/changes'], ['GET', '/changes/aaaaaaaaaaaaaaaaaaaaaa'], ['DELETE', '/changes/aaaaaaaaaaaaaaaaaaaaaa'], ['POST', '/changes/aaaaaaaaaaaaaaaaaaaaaa/events'], ['GET', '/changes/aaaaaaaaaaaaaaaaaaaaaa/cancel'], ['PUT', '/changes']]) {
      const res = await request(`${env.base}/_evolv/api${p}`, { method, headers: JSON_HDR(env.base), body: method === 'GET' ? undefined : '{}' });
      assert.equal(res.status, 404, `${method} ${p}`);
    }
  } finally {
    await env.close();
  }
});

test('events: a hostile page cannot hold more than 5 streams on one change (429)', async () => {
  const env = await startEnv({ script: SLOW });
  try {
    const { id } = JSON.parse((await post(env, '/_evolv/api/changes', { request: 'x' })).body);
    const url = `${env.base}/_evolv/api/changes/${id}/events`;
    const open = Array.from({ length: 5 }, () => readSse(url, { timeout: 6000 }).catch(() => null));
    await sleep(300);
    const sixth = await readSse(url);
    assert.equal(sixth.status, 429);
    assert.equal(errorOf(sixth).code, 'rate_limited');
    await Promise.all(open);
  } finally {
    await env.close();
  }
});

test('cancel: unknown and finished changes are 404, a running one is 200 once', async () => {
  const env = await startEnv({ script: [reply([toolUse('list_files', {})], { delayMs: 8000 })] });
  try {
    const cancelUrl = (id) => `/_evolv/api/changes/${id}/cancel`;
    assert.equal((await post(env, cancelUrl('aaaaaaaaaaaaaaaaaaaaaa'), {})).status, 404);
    assert.equal((await post(env, cancelUrl('short'), {})).status, 404);
    const { id } = JSON.parse((await post(env, '/_evolv/api/changes', { request: 'x' })).body);
    await waitFor(() => env.fake.requests.length === 1);
    assert.equal((await post(env, cancelUrl(id), {})).status, 200);
    await readSse(`${env.base}/_evolv/api/changes/${id}/events`, { until: (e) => e.type === 'failed' });
    assert.equal((await post(env, cancelUrl(id), {})).status, 404, 'already finished');
  } finally {
    await env.close();
  }
});

test('route table on the app port: undo, restore, reset, history, status and logs still do not exist', async () => {
  const env = await startEnv({ script: SLOW });
  try {
    for (const [method, p] of [['POST', '/reset'], ['POST', '/versions/undo'], ['POST', '/versions/2/restore'], ['GET', '/versions'], ['GET', '/status'], ['GET', '/logs'], ['GET', '/versions/1/diff']]) {
      const res = await request(`${env.base}/_evolv/api${p}`, { method, headers: { ...JSON_HDR(env.base), ...env.auth }, body: method === 'GET' ? undefined : '{}' });
      assert.equal(res.status, 404, `${method} ${p}`);
    }
  } finally {
    await env.close();
  }
});

// ---------- the handlers on their own, with a stub runner ----------
test('cancel in the promote phase is 409 too_late; the handlers map runner state to the right errors', async () => {
  const hub = new EventHub();
  const runner = {
    activeId: 'A'.repeat(22),
    phase: 'promote',
    cancelled: [],
    start: () => {
      throw new ChangeError('busy', 'Another change is already running.');
    },
    cancel(id) {
      this.cancelled.push(id);
      return true;
    },
  };
  const port = await getFreePort();
  const appApi = createAppApi({ port, consolePort: await getConsolePortFor(port), routes: createChangeRoutes({ runner, hub }) });
  const server = http.createServer(createFrontHandler({ appApi, proxy: { handle: (q, r) => r.end('app') } }));
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const cancel = (id) => request(`${base}/_evolv/api/changes/${id}/cancel`, { method: 'POST', headers: JSON_HDR(base), body: '{}' });

  const late = await cancel('A'.repeat(22));
  assert.equal(late.status, 409);
  assert.equal(errorOf(late).code, 'too_late');
  assert.match(errorOf(late).message, /too late|already being applied/i);
  assert.deepEqual(runner.cancelled, [], 'the runner must not be told to cancel');

  assert.equal((await cancel('B'.repeat(22))).status, 404, 'not the active change');
  runner.phase = 'verify';
  assert.equal((await cancel('A'.repeat(22))).status, 200);
  assert.deepEqual(runner.cancelled, ['A'.repeat(22)]);
  assert.equal(errorOf(await request(`${base}/_evolv/api/changes`, { method: 'POST', headers: JSON_HDR(base), body: '{"request":"x"}' })).code, 'busy');
});
