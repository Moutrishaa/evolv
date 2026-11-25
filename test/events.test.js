// The progress-event hub behind the SSE endpoint. App pages are untrusted, so it enforces
// strict limits and never carries secrets or real paths.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventHub } from '../supervisor/events.js';
import { readSse } from '../test-fixtures/net.js';
import { getFreePort, sleep } from '../test-fixtures/helpers.js';

const ID = (n) => String(n).padStart(22, 'a'); // 22-char ids
const servers = [];
afterEach(async () => {
  while (servers.length) {
    const s = servers.pop();
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

/** A tiny HTTP front for a hub, so streams are tested over real sockets. */
async function serve(hub) {
  const port = await getFreePort();
  const server = http.createServer((req, res) => {
    const id = req.url.slice(1);
    const verdict = hub.check(id);
    if (verdict !== 'ok') {
      res.writeHead(verdict === 'unknown' ? 404 : 429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ verdict }));
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    hub.subscribe(id, res, req);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${port}`;
}

const ev = (changeId, type, data = {}) => ({ type, changeId, ...data });

test('events are numbered in order and a late subscriber gets the whole history', async () => {
  const hub = new EventHub();
  hub.publish(ev(ID(1), 'accepted'));
  hub.publish(ev(ID(1), 'step', { step: 1 }));
  hub.publish(ev(ID(1), 'done', { version: 2 }));
  const base = await serve(hub);
  const r = await readSse(`${base}/${ID(1)}`);
  assert.deepEqual(r.events.map((e) => [e.id, e.type]), [[1, 'accepted'], [2, 'step'], [3, 'done']]);
  assert.deepEqual(r.events[1].data, { step: 1 }, 'the payload has no changeId or type fields');
  assert.equal(r.ended, true, 'a finished change closes its stream');
});

test('a live subscriber follows new events and is closed by done or failed', async () => {
  for (const terminal of ['done', 'failed']) {
    const hub = new EventHub();
    hub.publish(ev(ID(2), 'accepted'));
    const base = await serve(hub);
    const reading = readSse(`${base}/${ID(2)}`);
    await sleep(60);
    hub.publish(ev(ID(2), 'step', { step: 1 }));
    hub.publish(ev(ID(2), terminal, {}));
    const r = await reading;
    assert.deepEqual(r.events.map((e) => e.type), ['accepted', 'step', terminal]);
    assert.equal(r.ended, true);
  }
});

test('Last-Event-ID resumes after a dropped connection without repeats', async () => {
  const hub = new EventHub();
  for (let i = 1; i <= 5; i++) hub.publish(ev(ID(3), 'step', { step: i }));
  hub.publish(ev(ID(3), 'done'));
  const base = await serve(hub);
  const r = await readSse(`${base}/${ID(3)}`, { headers: { 'Last-Event-ID': '4' } });
  assert.deepEqual(r.events.map((e) => e.id), [5, 6]);
  const bad = await readSse(`${base}/${ID(3)}`, { headers: { 'Last-Event-ID': 'nonsense' } });
  assert.equal(bad.events.length, 6, 'a bad Last-Event-ID means "from the start"');
});

test('unknown change ids are unknown (404 material); known ones are found', () => {
  const hub = new EventHub();
  assert.equal(hub.has(ID(9)), false);
  assert.equal(hub.check(ID(9)), 'unknown');
  hub.publish(ev(ID(9), 'accepted'));
  assert.equal(hub.has(ID(9)), true);
  assert.equal(hub.check(ID(9)), 'ok');
});

test('only the last N changes are kept; running ones are never evicted', () => {
  const hub = new EventHub({ maxChanges: 3 });
  hub.publish(ev(ID(100), 'accepted')); // still running
  for (let i = 1; i <= 5; i++) {
    hub.publish(ev(ID(i), 'accepted'));
    hub.publish(ev(ID(i), 'done'));
  }
  assert.equal(hub.has(ID(100)), true, 'a running change must stay');
  assert.equal(hub.has(ID(1)), false);
  assert.equal(hub.has(ID(2)), false);
  assert.equal(hub.has(ID(5)), true);
});

test('finished changes expire after the retention time', () => {
  let now = 1_000_000;
  const hub = new EventHub({ ttlMs: 15 * 60 * 1000, now: () => now });
  hub.publish(ev(ID(1), 'accepted'));
  hub.publish(ev(ID(1), 'done'));
  hub.publish(ev(ID(2), 'accepted')); // running
  now += 14 * 60 * 1000;
  assert.equal(hub.has(ID(1)), true);
  now += 2 * 60 * 1000;
  assert.equal(hub.has(ID(1)), false);
  assert.equal(hub.has(ID(2)), true);
});

test('connection caps: per change and in total (429 material)', async () => {
  const hub = new EventHub({ maxPerChange: 2, maxTotal: 3 });
  hub.publish(ev(ID(1), 'accepted'));
  hub.publish(ev(ID(2), 'accepted'));
  const base = await serve(hub);
  const open = [];
  for (let i = 0; i < 2; i++) open.push(readSse(`${base}/${ID(1)}`, { timeout: 4000 }).catch(() => null));
  await sleep(150);
  assert.equal(hub.check(ID(1)), 'too_many', 'third viewer of one change is refused');
  assert.equal((await readSse(`${base}/${ID(1)}`)).status, 429);
  open.push(readSse(`${base}/${ID(2)}`, { timeout: 4000 }).catch(() => null));
  await sleep(150);
  assert.equal(hub.check(ID(2)), 'too_many', 'the total cap is reached');
  hub.publish(ev(ID(1), 'done'));
  hub.publish(ev(ID(2), 'done'));
  await Promise.all(open);
  await sleep(50);
  assert.equal(hub.check(ID(2)), 'ok', 'slots are freed when streams close');
});

test('a closed connection frees its slot and its timer', async () => {
  const hub = new EventHub({ maxPerChange: 1, heartbeatMs: 20 });
  hub.publish(ev(ID(1), 'accepted'));
  const base = await serve(hub);
  const r = await readSse(`${base}/${ID(1)}`, { until: (e) => e.type === 'accepted' });
  assert.equal(r.events.length, 1);
  await sleep(80);
  assert.equal(hub.check(ID(1)), 'ok');
  assert.equal(hub.connections(), 0);
});

test('heartbeat comments keep an idle stream alive', async () => {
  const hub = new EventHub({ heartbeatMs: 40 });
  hub.publish(ev(ID(1), 'accepted'));
  const base = await serve(hub);
  const reading = readSse(`${base}/${ID(1)}`, { timeout: 4000 });
  await sleep(250);
  hub.publish(ev(ID(1), 'done'));
  const r = await reading;
  assert.ok(r.comments >= 3, `expected heartbeats, got ${r.comments}`);
});

test('payloads are sanitised: real paths hidden, control characters stripped, size capped', async () => {
  const hub = new EventHub({ scrubPaths: ['C:\\Users\\me\\evolv', 'C:/Users/me/evolv'] });
  hub.publish(ev(ID(1), 'failed', {
    message: 'died in C:\\Users\\me\\evolv\\state\\workspaces\\x and C:/Users/me/evolv/app',
    output: '\u001b[31mred\u001b[0m\u0000 text\u0007 ' + 'y'.repeat(50000),
    nested: { path: 'C:\\Users\\me\\evolv\\a' },
  }));
  const base = await serve(hub);
  const r = await readSse(`${base}/${ID(1)}`);
  const text = JSON.stringify(r.events[0].data);
  assert.ok(!text.includes('Users') && !text.includes('me\\\\evolv'), 'paths must be hidden');
  assert.ok(text.includes('<app>'));
  assert.ok(!/[\u0000-\u0008\u001b]/.test(r.events[0].data.output));
  assert.ok(r.events[0].data.output.length <= 8200);
  assert.ok(r.events[0].data.nested.path.includes('<app>'));
});

test('payload text is escaped as JSON, so it cannot break out of an SSE field', async () => {
  const hub = new EventHub();
  hub.publish(ev(ID(1), 'failed', { message: 'line1\n\nid: 999\nevent: done\ndata: {"forged":true}' }));
  const base = await serve(hub);
  const r = await readSse(`${base}/${ID(1)}`);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].type, 'failed');
  assert.equal(r.events[0].id, 1);
});

test('the event log per change is bounded', () => {
  const hub = new EventHub({ maxEvents: 50 });
  hub.publish(ev(ID(1), 'accepted'));
  for (let i = 0; i < 500; i++) hub.publish(ev(ID(1), 'step', { step: i }));
  hub.publish(ev(ID(1), 'done'));
  const log = hub.history(ID(1));
  assert.ok(log.length <= 50);
  assert.equal(log.at(-1).type, 'done', 'the terminal event is never dropped');
  assert.equal(log[0].type, 'accepted', 'the first event is kept');
});

test('events for a finished change are ignored (no resurrection)', () => {
  const hub = new EventHub();
  hub.publish(ev(ID(1), 'accepted'));
  hub.publish(ev(ID(1), 'done'));
  hub.publish(ev(ID(1), 'step', { step: 9 }));
  assert.deepEqual(hub.history(ID(1)).map((e) => e.type), ['accepted', 'done']);
});
