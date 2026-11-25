// Runs the real console/console.js against a stub browser to check how it handles the key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from '../test-fixtures/helpers.js';

const KEY = 'ab'.repeat(32);
const source = fs.readFileSync(path.join(ROOT, 'console', 'console.js'), 'utf8');

function run({ hash = '', stored = null, status = 200 } = {}) {
  const store = new Map(stored ? [['evolv_console_key', stored]] : []);
  const fetches = [];
  const replaced = [];
  const el = () => ({
    addEventListener() {}, append() {}, replaceChildren() {}, setAttribute() {},
    hidden: false, textContent: '', dataset: {}, scrollTop: 0, clientHeight: 0, scrollHeight: 0,
  });
  const sandbox = {
    document: { getElementById: el, querySelectorAll: () => [], createElement: el },
    location: { hash, pathname: '/', search: '' },
    history: { replaceState: (...a) => replaced.push(a) },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    fetch: async (url, opts) => {
      fetches.push({ url, opts });
      return { ok: status === 200, status, json: async () => ({ app: {}, version: {}, budget: {}, lines: [] }) };
    },
    setInterval: () => 0,
    console,
  };
  vm.runInNewContext(source, sandbox);
  return { store, fetches, replaced };
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
