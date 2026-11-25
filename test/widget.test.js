// Runs the real seed/public/chat.js against a stub browser to check what a user would see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from '../test-fixtures/helpers.js';

const source = fs.readFileSync(path.join(ROOT, 'seed', 'public', 'chat.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'seed', 'public', 'index.html'), 'utf8');
const tick = () => new Promise((r) => setImmediate(r));

function makeElement() {
  const listeners = {};
  return {
    hidden: false, disabled: false, textContent: '', value: '', children: [],
    attributes: {},
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    replaceChildren(...c) { this.children = c; this.textContent = ''; },
    append(...c) { this.children.push(...c); },
    focus() {},
    fire(type, ev = {}) { for (const fn of listeners[type] ?? []) fn({ preventDefault() {}, ...ev }); },
  };
}

class FakeEventSource {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.closed = false;
    this.listeners = {};
    this.readyState = 1;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  close() { this.closed = true; this.readyState = 2; }
  emit(type, data) { for (const fn of this.listeners[type] ?? []) fn({ data: JSON.stringify(data), lastEventId: '1' }); }
  fail() { for (const fn of this.listeners.error ?? []) fn({}); }
}

function load({ fetchImpl, withEventSource = true } = {}) {
  FakeEventSource.instances = [];
  const ids = ['chat-toggle', 'chat-panel', 'chat-form', 'chat-input', 'chat-log', 'chat-cancel', 'chat-output', 'chat-send'];
  const els = Object.fromEntries(ids.map((id) => [id, makeElement()]));
  const fetches = [];
  const timers = [];
  const reloads = [];
  const sandbox = {
    document: { getElementById: (id) => els[id] ?? null, createElement: () => makeElement() },
    fetch: async (url, opts) => {
      fetches.push({ url, opts });
      return fetchImpl(url, opts);
    },
    EventSource: withEventSource ? FakeEventSource : undefined,
    location: { reload: () => reloads.push(1) },
    setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimeout: () => {},
    console,
  };
  vm.runInNewContext(source, sandbox);
  return { els, fetches, timers, reloads, es: () => FakeEventSource.instances.at(-1) };
}

const ok = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const submit = async (w, text = 'Make it navy') => {
  w.els['chat-input'].value = text;
  w.els['chat-form'].fire('submit');
  await tick();
};
const ID = 'AbCdEfGhIjKlMnOpQrStUv';

test('the widget markup has what the script needs, and keeps the recovery link', () => {
  for (const id of ['chat-toggle', 'chat-panel', 'chat-form', 'chat-input', 'chat-log', 'chat-cancel', 'chat-output', 'chat-send']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /href="\/_evolv"/);
  assert.match(html, /maxlength="4000"/);
  assert.match(html, /aria-live/);
});

test('submit posts the request as JSON to /_evolv/api/changes, same origin, no credentials tricks', async () => {
  const w = load({ fetchImpl: async () => ok(202, { id: ID }) });
  await submit(w, '  Make it navy  ');
  assert.equal(w.fetches.length, 1);
  assert.equal(w.fetches[0].url, '/_evolv/api/changes');
  assert.equal(w.fetches[0].opts.method, 'POST');
  assert.equal(w.fetches[0].opts.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(w.fetches[0].opts.body), { request: 'Make it navy' });
  assert.notEqual(w.fetches[0].opts.credentials, 'include');
  assert.equal(w.es().url, `/_evolv/api/changes/${ID}/events`);
});

test('while a change runs the form is locked and Cancel is shown', async () => {
  const w = load({ fetchImpl: async () => ok(202, { id: ID }) });
  await submit(w);
  assert.equal(w.els['chat-send'].disabled, true);
  assert.equal(w.els['chat-input'].disabled, true);
  assert.equal(w.els['chat-cancel'].hidden, false);
  w.els['chat-input'].value = 'second';
  w.els['chat-form'].fire('submit');
  await tick();
  assert.equal(w.fetches.length, 1, 'no second submit while one is running');
});

test('an empty request is not sent', async () => {
  const w = load({ fetchImpl: async () => ok(202, { id: ID }) });
  await submit(w, '   ');
  assert.equal(w.fetches.length, 0);
  assert.match(w.els['chat-log'].textContent, /describe|type|what/i);
});

test('progress is shown in plain words for steps, tools and checks', async () => {
  const w = load({ fetchImpl: async () => ok(202, { id: ID }) });
  await submit(w);
  const es = w.es();
  es.emit('step', { step: 2 });
  assert.match(w.els['chat-log'].textContent, /working/i);
  es.emit('tool', { name: 'read_file', file: 'public/style.css' });
  assert.match(w.els['chat-log'].textContent, /reading/i);
  assert.match(w.els['chat-log'].textContent, /style\.css/);
  es.emit('tool', { name: 'edit_file', file: 'public/index.html' });
  assert.match(w.els['chat-log'].textContent, /editing/i);
  es.emit('verify', { check: 'start', label: 'Starting your app', status: 'running' });
  assert.match(w.els['chat-log'].textContent, /starting your app|checking/i);
  es.emit('promoting', {});
  assert.match(w.els['chat-log'].textContent, /live|applying|putting/i);
});

test('done shows the summary and reloads the page', async () => {
  const w = load({ fetchImpl: async () => ok(202, { id: ID }) });
  await submit(w);
  const es = w.es();
  es.emit('done', { version: 2, summary: 'Made the page navy.', files: ['public/style.css'], tokens: 450 });
  assert.match(w.els['chat-log'].textContent, /Made the page navy\./);
  assert.match(w.els['chat-log'].textContent, /reload/i);
  assert.equal(es.closed, true);
  assert.equal(w.reloads.length, 0, 'not instantly: the user gets to read it');
  assert.equal(w.timers.length, 1);
  assert.ok(w.timers[0].ms >= 500 && w.timers[0].ms <= 5000);
  w.timers[0].fn();
  assert.equal(w.reloads.length, 1);
});

test('failed says the app is unchanged and shows the check output safely', async () => {
  const w = load({ fetchImpl: async () => ok(202, { id: ID }) });
  await submit(w);
  const es = w.es();
  const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  es.emit('failed', { code: 'verify_failed', message: 'The change did not pass the automatic checks, so your app was not changed. The app crashed.', output: `Error: boom ${evil}` });
  assert.match(w.els['chat-log'].textContent, /not changed/i);
  assert.equal(w.els['chat-output'].hidden, false);
  assert.ok(w.els['chat-output'].textContent.includes(evil), 'shown as text, not interpreted');
  assert.equal(w.els['chat-send'].disabled, false, 'the user can try again');
  assert.equal(w.els['chat-cancel'].hidden, true);
  assert.equal(w.reloads.length, 0);
  assert.equal(w.timers.length, 0);
  assert.equal(es.closed, true);
});

test('a rolled-back version is explained in the server\'s own plain words', async () => {
  const w = load({ fetchImpl: async () => ok(202, { id: ID }) });
  await submit(w);
  w.es().emit('failed', { code: 'swap_failed', message: 'The new version did not start properly, so Evolv put your previous version (version 1) back. Nothing was lost.' });
  assert.match(w.els['chat-log'].textContent, /previous version/);
  assert.match(w.els['chat-log'].textContent, /Nothing was lost/);
});

test('refusals show the server\'s plain message and unlock the form', async () => {
  for (const [status, code, message] of [
    [409, 'busy', 'Another change is already running. Wait for it to finish, or cancel it.'],
    [429, 'budget_exhausted', 'The token budget is spent (1000 of 1000 tokens used).'],
    [400, 'invalid_request', 'The request is empty. Describe the change you want.'],
    [503, 'ledger_unreadable', 'The usage record is damaged and cannot be read.'],
  ]) {
    const w = load({ fetchImpl: async () => ok(status, { error: { code, message } }) });
    await submit(w);
    assert.ok(w.els['chat-log'].textContent.includes(message), code);
    assert.equal(w.els['chat-send'].disabled, false, code);
    assert.equal(FakeEventSource.instances.length, 0, 'no stream for a refused change');
  }
});

test('a network failure or an unreadable error gives a plain message, never a crash', async () => {
  let w = load({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  await submit(w);
  assert.match(w.els['chat-log'].textContent, /could not reach|try again/i);
  assert.equal(w.els['chat-send'].disabled, false);
  w = load({ fetchImpl: async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } }) });
  await submit(w);
  assert.match(w.els['chat-log'].textContent, /500|went wrong/i);
  assert.equal(w.els['chat-send'].disabled, false);
});

test('Cancel posts to the cancel route and says so; too late is explained', async () => {
  let cancelStatus = 200;
  const w = load({
    fetchImpl: async (url) => (String(url).endsWith('/cancel') ? ok(cancelStatus, cancelStatus === 200 ? { cancelled: true } : { error: { code: 'too_late', message: 'It is too late to cancel: the change is already being applied.' } }) : ok(202, { id: ID })),
  });
  await submit(w);
  w.els['chat-cancel'].fire('click');
  await tick();
  const call = w.fetches.at(-1);
  assert.equal(call.url, `/_evolv/api/changes/${ID}/cancel`);
  assert.equal(call.opts.method, 'POST');
  assert.match(w.els['chat-log'].textContent, /cancel/i);

  const w2 = load({ fetchImpl: async (url) => (String(url).endsWith('/cancel') ? ok(409, { error: { code: 'too_late', message: 'It is too late to cancel: the change is already being applied.' } }) : ok(202, { id: ID })) });
  await submit(w2);
  w2.els['chat-cancel'].fire('click');
  await tick();
  assert.match(w2.els['chat-log'].textContent, /too late/i);
});

test('a lost stream gets a clear message instead of hanging forever', async () => {
  const w = load({ fetchImpl: async () => ok(202, { id: ID }) });
  await submit(w);
  const es = w.es();
  es.readyState = 2; // the browser gave up reconnecting
  es.fail();
  assert.match(w.els['chat-log'].textContent, /lost|connection/i);
  assert.match(w.els['chat-log'].textContent, /reload/i);
  assert.equal(w.els['chat-send'].disabled, false);
});

test('without EventSource the widget still explains itself', async () => {
  const w = load({ fetchImpl: async () => ok(202, { id: ID }), withEventSource: false });
  await submit(w);
  assert.match(w.els['chat-log'].textContent, /browser|progress|reload/i);
});

test('server text is only ever written as text, never as markup', () => {
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(source));
  assert.ok(!/document\.cookie|localStorage|sessionStorage/.test(source));
});
