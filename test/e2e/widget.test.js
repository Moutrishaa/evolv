// Runs the real seed/public/chat.js against a stub browser to check what a user would see.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from '../../test-fixtures/helpers/helpers.js';

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
  const ids = ['chat-chips', 'chat-panel', 'chat-form', 'chat-input', 'chat-log', 'chat-cancel', 'chat-output', 'chat-send'];
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
  for (const id of ['chat-chips', 'chat-panel', 'chat-form', 'chat-input', 'chat-log', 'chat-cancel', 'chat-output', 'chat-send']) {
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

test('a rate-limit wait is explained in plain words, keeps the form locked, and the next step replaces it', async () => {
  const w = load({ fetchImpl: async () => ok(202, { id: ID }) });
  await submit(w);
  w.es().emit('waiting', { seconds: 12, reason: 'rate_limit' });
  assert.match(w.els['chat-log'].textContent, /12 seconds/);
  assert.match(w.els['chat-log'].textContent, /busy|limit|slow/i);
  assert.equal(w.els['chat-send'].disabled, true);
  assert.equal(w.els['chat-cancel'].hidden, false, 'Cancel still works while waiting');
  w.es().emit('step', { step: 4 });
  assert.match(w.els['chat-log'].textContent, /working/i);
  assert.ok(!/12 seconds/.test(w.els['chat-log'].textContent));
});

test('other waits are explained too, and a missing or odd number of seconds never breaks it', async () => {
  const w = load({ fetchImpl: async () => ok(202, { id: ID }) });
  await submit(w);
  w.es().emit('waiting', { seconds: 3, reason: 'unavailable' });
  assert.match(w.els['chat-log'].textContent, /3 seconds/);
  assert.match(w.els['chat-log'].textContent, /unavailable|trouble|busy/i);
  w.es().emit('waiting', {});
  assert.match(w.els['chat-log'].textContent, /waiting|moment|busy/i);
  w.es().emit('waiting', { seconds: '<script>x</script>', reason: 'rate_limit' });
  assert.ok(!/<script>/.test(w.els['chat-log'].textContent), 'only a whole number is ever shown');
});

// ---------- the redesigned page: Manrope, the composer, the prompt chips ----------
const chipRequests = [...html.matchAll(/<button[^>]*class="chip"[^>]*data-request="([^"]*)"[^>]*>([^<]*)<\/button>/g)].map((m) => ({ request: m[1], label: m[2].trim() }));

test('the page has the six prompt chips with the spelling fixed, and nothing it cannot do', () => {
  assert.deepEqual(chipRequests.map((c) => c.label), [
    'Change the background to dark gradient background',
    'Add a notes page',
    'Split the screen into two columns',
    'Add a to-do list',
    'Change the heading font colour',
    'Turn the chat into a floating bubble in the bottom right',
  ]);
  assert.ok(!/gradiant/i.test(html + source));
  assert.match(html, /Meet Evolv/);
  assert.ok(!/Live Preview|<footer/i.test(html), 'the footer line is gone');
  // No Undo, token counter or microphone: they would need routes the app origin must never have.
  assert.ok(!/undo|tokens|microphone|webkitSpeech|SpeechRecognition/i.test(html + source));
  assert.match(fs.readFileSync(path.join(ROOT, 'seed', 'public', 'style.css'), 'utf8'), /Manrope/);
});

test('the dark-gradient chip carries the exact gradient and asks for white, high-contrast text', () => {
  const r = chipRequests[0].request;
  assert.ok(r.includes('radial-gradient(125% 125% at 50% 10%, #000 40%, #63e 100%)'));
  // Short, exact, one-line edits in :root are what a small model can match reliably.
  const css = fs.readFileSync(path.join(ROOT, 'seed', 'public', 'style.css'), 'utf8');
  for (const line of ['--page-bg: radial-gradient(125% 125% at 50% 10%, #fff 40%, #6366f1 100%);', '--ink: #111111;', '--muted: #7b7b86;', '--link: #4a14d9;']) {
    assert.equal(css.split(line).length, 2, `style.css has ${line} exactly once`);
    assert.ok(r.includes(line), `the request names ${line}`);
  }
  assert.match(r, /white/i);
  assert.match(r, /contrast/i);
  assert.match(r, /Recovery console/);
  assert.ok(r.length <= 4000);
  for (const c of chipRequests) assert.ok(!/[<>&"]/.test(c.request), `safe inside an attribute: ${c.label}`);
});

test('clicking a chip sends its request at once, like typing it and pressing Send', async () => {
  const w = load({ fetchImpl: async () => ok(202, { id: ID }) });
  w.els['chat-chips'].fire('click', { target: { closest: () => ({ dataset: { request: chipRequests[0].request } }) } });
  await tick();
  assert.equal(w.fetches.length, 1);
  assert.equal(w.fetches[0].url, '/_evolv/api/changes');
  assert.deepEqual(JSON.parse(w.fetches[0].opts.body), { request: chipRequests[0].request });
  assert.equal(w.els['chat-send'].disabled, true);
  // A second click while a change is running does nothing.
  w.els['chat-chips'].fire('click', { target: { closest: () => ({ dataset: { request: 'Add a notes page' } }) } });
  await tick();
  assert.equal(w.fetches.length, 1);
  // A click that is not on a chip does nothing.
  const w2 = load({ fetchImpl: async () => ok(202, { id: ID }) });
  w2.els['chat-chips'].fire('click', { target: { closest: () => null } });
  await tick();
  assert.equal(w2.fetches.length, 0);
});

test('the composer is 750px wide (never wider than the screen)', () => {
  const css = fs.readFileSync(path.join(ROOT, 'seed', 'public', 'style.css'), 'utf8');
  assert.match(css, /#chat-panel\s*\{[^}]*width:\s*min\(750px,\s*100%\)/);
});

test('"another change is already running" points to the Recovery Console, which can cancel it', async () => {
  const message = 'Another change is already running. Wait for it to finish, or cancel it.';
  const w = load({ fetchImpl: async () => ok(409, { error: { code: 'busy', message } }) });
  await submit(w);
  const log = w.els['chat-log'];
  assert.ok(log.textContent.includes(message));
  assert.match(log.textContent, /Recovery Console/);
  const link = log.children.find((c) => c.href);
  assert.ok(link, 'a link is shown');
  assert.equal(link.href, '/_evolv');
  assert.match(link.textContent, /Recovery Console/);
  assert.equal(w.els['chat-send'].disabled, false);
  // Other refusals get no console link.
  const w2 = load({ fetchImpl: async () => ok(400, { error: { code: 'invalid_request', message: 'The request is empty.' } }) });
  await submit(w2);
  assert.equal(w2.els['chat-log'].children.length, 0);
});

test('a daily-limit wait says so, in plain words', async () => {
  const w = load({ fetchImpl: async () => ok(202, { id: ID }) });
  await submit(w);
  w.es().emit('waiting', { seconds: 30, reason: 'daily_limit' });
  assert.match(w.els['chat-log'].textContent, /daily/i);
  assert.match(w.els['chat-log'].textContent, /30 seconds/);
});

test('the page background is the indigo gradient, and the old pastel glow and base colour are gone', () => {
  const css = fs.readFileSync(path.join(ROOT, 'seed', 'public', 'style.css'), 'utf8');
  assert.ok(css.includes('radial-gradient(125% 125% at 50% 10%, #fff 40%, #6366f1 100%)'));
  assert.match(css, /body\s*\{[^}]*background:\s*var\(--page-bg\)/);
  assert.ok(!/fafafa|--pastel|rgba\(255, 214, 236/.test(css), 'no leftover background colours');
  assert.equal(css.split('radial-gradient(').length, 2, 'exactly one gradient is used for the page');
});
