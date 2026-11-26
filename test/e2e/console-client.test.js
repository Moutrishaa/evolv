// Runs the real console/console.js against a stub browser to check how it handles the key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from '../../test-fixtures/helpers/helpers.js';

const KEY = 'ab'.repeat(32);
const source = fs.readFileSync(path.join(ROOT, 'console', 'console.js'), 'utf8');

function run({ hash = '', stored = null, status = 200, statusBody = { app: {}, version: {}, budget: {}, lines: [] } } = {}) {
  const store = new Map(stored ? [['evolv_console_key', stored]] : []);
  const fetches = [];
  const replaced = [];
  const el = () => ({
    addEventListener() {}, append() {}, replaceChildren() {}, setAttribute() {},
    hidden: false, textContent: '', dataset: {}, scrollTop: 0, clientHeight: 0, scrollHeight: 0,
  });
  const created = []; // elements the page builds itself, with their click handlers
  const make = (tag) => {
    const listeners = {};
    const e = { ...el(), tag, disabled: false, addEventListener(type, fn) { (listeners[type] ??= []).push(fn); }, fire(type) { for (const fn of listeners[type] ?? []) fn({}); } };
    created.push(e);
    return e;
  };
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [], createElement: make },
    location: { hash, pathname: '/', search: '' },
    history: { replaceState: (...a) => replaced.push(a) },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    fetch: async (url, opts) => {
      fetches.push({ url, opts });
      return { ok: status === 200, status, json: async () => statusBody };
    },
    setInterval: () => 0,
    console,
  };
  vm.runInNewContext(source, sandbox);
  return { store, fetches, replaced, created };
}

test('reads the key from the URL fragment, saves it, and removes it from the address bar', async () => {
  const r = run({ hash: `#key=${KEY}` });
  assert.equal(r.store.get('evolv_console_key'), KEY);
  assert.equal(r.replaced.length, 1);
  assert.equal(r.replaced[0][2], '/', 'fragment must be cleared');
  await new Promise((res) => setImmediate(res));
  assert.equal(r.fetches[0].opts.headers.Authorization, `Bearer ${KEY}`);
});

test('uses a saved key on later visits', async () => {
  const r = run({ stored: KEY });
  await new Promise((res) => setImmediate(res));
  assert.equal(r.fetches[0].opts.headers.Authorization, `Bearer ${KEY}`);
});

test('never sends cookies or credentials, and never puts the key in a URL', async () => {
  const r = run({ stored: KEY });
  await new Promise((res) => setImmediate(res));
  for (const f of r.fetches) {
    assert.ok(!String(f.url).includes(KEY));
    assert.notEqual(f.opts.credentials, 'include');
  }
  assert.ok(!/document\.cookie/.test(source));
});

test('ignores a malformed fragment', () => {
  const r = run({ hash: '#key=not-a-real-key' });
  assert.equal(r.store.size, 0);
});

// ---------- Status shows where AI requests go ----------
async function statusRows(ai, extra = {}) {
  const rows = [];
  const el = () => ({
    addEventListener() {}, replaceChildren() { rows.length = 0; }, setAttribute() {},
    append(...c) { rows.push(...c.map((x) => x.textContent)); },
    hidden: false, textContent: '', dataset: {}, scrollTop: 0, clientHeight: 0, scrollHeight: 0,
  });
  const payload = { app: { state: 'running', pid: 1, port: 3001, uptimeMs: 0, restarts: 0 }, version: { current: 1, count: 1 }, budget: { used: 0, total: 10 }, notice: null, mode: 'normal', node: 'v26', ai, ...extra };
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [], createElement: el },
    location: { hash: '', pathname: '/', search: '' },
    history: { replaceState() {} },
    localStorage: { getItem: () => 'ab'.repeat(32), setItem() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => payload }),
    setInterval: () => 0,
    console,
  };
  vm.runInNewContext(source, sandbox);
  await new Promise((r) => setImmediate(r));
  const pairs = {};
  for (let i = 0; i + 1 < rows.length; i += 2) pairs[rows[i]] = rows[i + 1];
  return pairs;
}

test('Status names the AI provider and model, and shows the host requests go to', async () => {
  const rows = await statusRows({ provider: 'openai', model: 'llama-3.3-70b-versatile', host: 'api.groq.com' });
  assert.equal(rows['AI provider'], 'openai (model llama-3.3-70b-versatile)');
  assert.equal(rows['AI requests go to'], 'api.groq.com');
});

test('Status copes with a demo (no host) and with an older server that sends no ai block', async () => {
  const demo = await statusRows({ provider: 'demo (scripted)', model: null, host: null });
  assert.equal(demo['AI provider'], 'demo (scripted)');
  assert.equal('AI requests go to' in demo, false);
  const none = await statusRows(undefined);
  assert.equal('AI provider' in none, false);
  assert.equal(none['Current version'], 'v1');
});

const RUNNING_ID = 'AbCdEfGhIjKlMnOpQrStUv';
const settle = () => new Promise((res) => setImmediate(res));
const statusWith = (change) => ({ app: {}, version: {}, budget: {}, lines: [], change });

test('while a change runs, Status shows a Cancel button that posts to that change with the token', async () => {
  const r = run({ stored: KEY, statusBody: statusWith({ id: RUNNING_ID, phase: 'agent' }) });
  await settle();
  const button = r.created.find((e) => e.tag === 'button');
  assert.ok(button, 'a Cancel button is shown');
  assert.equal(button.disabled, false);
  button.fire('click');
  await settle();
  const post = r.fetches.find((f) => f.opts?.method === 'POST');
  assert.equal(post.url, `/api/changes/${RUNNING_ID}/cancel`);
  assert.equal(post.opts.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(post.opts.headers['Content-Type'], 'application/json');
  assert.notEqual(post.opts.credentials, 'include');
  assert.ok(!String(post.url).includes(KEY));
});

test('no Cancel button when nothing is running, and a disabled one once the change is being applied', async () => {
  const idle = run({ stored: KEY, statusBody: statusWith(null) });
  await settle();
  assert.equal(idle.created.filter((e) => e.tag === 'button').length, 0);
  const promoting = run({ stored: KEY, statusBody: statusWith({ id: RUNNING_ID, phase: 'promote' }) });
  await settle();
  const button = promoting.created.find((e) => e.tag === 'button');
  assert.ok(button);
  assert.equal(button.disabled, true, 'too late to cancel once promotion has begun');
});
