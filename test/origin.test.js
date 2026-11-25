// Two origins: app pages live on the app port, the console lives on its own port.
// App pages may only submit and cancel changes (and read progress). They must never reach
// undo, restore or reset. This file plays the part of a hostile app page.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createConsoleApi, createAppApi, createFrontHandler } from '../supervisor/api.js';
import { createProxy } from '../supervisor/proxy.js';
import { ensureConsoleKey } from '../supervisor/auth.js';
import { makeTempDir, getFreePort, request } from '../test-fixtures/helpers.js';

// Destructive routes exist ONLY here, on the console API, with counters. If any hostile
// request reaches one, the counter moves and the test fails.
const calls = { reset: 0, undo: 0, restore: 0, status: 0, submit: 0, cancel: 0, events: 0 };
let tmp, key, appPort, consolePort, upstream, servers = [];
let appBase, consoleBase;
const ID = 'AbCdEfGhIjKlMnOpQrStUv'; // 22 chars, like a real unguessable id

before(async () => {
  tmp = makeTempDir('evolv-origin-');
  const consoleDir = path.join(tmp.dir, 'console');
  fs.mkdirSync(consoleDir);
  for (const f of ['index.html', 'console.js', 'console.css']) fs.writeFileSync(path.join(consoleDir, f), 'x');
  key = ensureConsoleKey(path.join(tmp.dir, 'state'));
  appPort = await getFreePort();
  consolePort = await getFreePort();
  appBase = `http://127.0.0.1:${appPort}`;
  consoleBase = `http://127.0.0.1:${consolePort}`;

  const consoleApi = createConsoleApi({
    port: consolePort,
    consoleDir,
    key,
    routes: {
      'POST /reset': () => (calls.reset++, { status: 200, body: { ok: true } }),
      'POST /versions/undo': () => (calls.undo++, { status: 200, body: { ok: true } }),
      'POST /versions/:id/restore': () => (calls.restore++, { status: 200, body: { ok: true } }),
      'GET /status': () => (calls.status++, { status: 200, body: { ok: true } }),
      'GET /logs': () => ({ status: 200, body: { lines: [] } }),
      'GET /versions': () => ({ status: 200, body: [] }),
    },
  });

  // The ONLY routes an app page may use. Handlers are test doubles for B2's real ones.
  const appApi = createAppApi({
    port: appPort,
    consolePort,
    routes: {
      'POST /changes': () => (calls.submit++, { status: 202, body: { id: ID } }),
      'POST /changes/:id/cancel': () => (calls.cancel++, { status: 200, body: { cancelled: true } }),
      'GET /changes/:id/events': () => (calls.events++, { status: 200, body: { events: [] } }),
    },
  });

  upstream = http.createServer((req, res) => res.end('APP PAGE ' + req.url));
  const upstreamPort = await getFreePort();
  await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r));
  const proxy = createProxy({ getPort: () => upstreamPort });

  const appServer = http.createServer(createFrontHandler({ appApi, proxy }));
  const consoleServer = http.createServer((req, res) => consoleApi.handle(req, res));
  await new Promise((r) => appServer.listen(appPort, '127.0.0.1', r));
  await new Promise((r) => consoleServer.listen(consolePort, '127.0.0.1', r));
  servers = [appServer, consoleServer, upstream];
});

after(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  tmp.cleanup();
});

/** A request exactly as a browser sends it from a page served by the app origin. */
function asAppPage(url, { method = 'POST', extra = {}, body = '{}' } = {}) {
  const u = new URL(url);
  return request(url, {
    method,
    body: method === 'GET' ? undefined : body,
    headers: {
      Origin: appBase,
      Referer: `${appBase}/some-page`,
      Cookie: 'evolv_session=guess; session=guess',
      'Sec-Fetch-Site': u.port === String(appPort) ? 'same-origin' : 'same-site',
      ...extra,
    },
  });
}

const DESTRUCTIVE = [
  ['POST', '/reset'],
  ['POST', '/versions/undo'],
  ['POST', `/versions/${ID}/restore`],
  ['POST', '/versions/2/restore'],
];
const snapshot = () => JSON.stringify(calls);

test('HOSTILE PAGE: reset, undo and restore are unreachable from the app port', async () => {
  const before = snapshot();
  const prefixes = ['/_evolv/api', '//_evolv/api', '/_EVOLV/api', '/%5Fevolv/api', '/x/../_evolv/api', '/_evolv/api/..', '/_evolv'];
  // Worst case for each request: the page even holds the real key.
  const credentials = [{}, { Authorization: `Bearer ${key}` }, { Authorization: `Bearer ${key}`, 'X-Evolv-Token': key }];
  for (const [method, p] of DESTRUCTIVE) {
    for (const prefix of prefixes) {
      for (const extra of credentials) {
        const res = await asAppPage(`${appBase}${prefix}${p}`, { method, extra });
        assert.ok(res.status >= 400, `${method} ${prefix}${p} returned ${res.status}`);
        assert.equal(res.headers['x-evolv-supervisor'], '1', `${prefix}${p} was forwarded to the app instead of being refused`);
      }
    }
  }
  assert.equal(snapshot(), before, 'a destructive handler was reached from the app port');
  assert.equal(calls.reset + calls.undo + calls.restore, 0);
});

test('HOSTILE PAGE: on the app port those routes do not exist at all (404, not 403)', async () => {
  for (const [method, p] of DESTRUCTIVE) {
    const res = await asAppPage(`${appBase}/_evolv/api${p}`, { method });
    assert.equal(res.status, 404, `${method} ${p}`);
  }
});

test('HOSTILE PAGE: calling the console port cross-origin fails without a token (401)', async () => {
  for (const [method, p] of DESTRUCTIVE) {
    const res = await asAppPage(`${consoleBase}/api${p}`, { method });
    assert.equal(res.status, 401, `${method} ${p}`);
  }
  assert.equal(calls.reset + calls.undo + calls.restore, 0);
});

test('HOSTILE PAGE: even holding the real token, the app Origin is refused by the console (403)', async () => {
  for (const [method, p] of DESTRUCTIVE) {
    const res = await asAppPage(`${consoleBase}/api${p}`, { method, extra: { Authorization: `Bearer ${key}` } });
    assert.equal(res.status, 403, `${method} ${p}`);
  }
  assert.equal(calls.reset + calls.undo + calls.restore, 0);
});

test('HOSTILE PAGE: a CORS preflight to the console grants nothing', async () => {
  const res = await request(`${consoleBase}/api/reset`, {
    method: 'OPTIONS',
    headers: { Origin: appBase, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' },
  });
  assert.equal(res.status, 403);
  assert.ok(!Object.keys(res.headers).some((h) => h.startsWith('access-control-')));
});

test('HOSTILE PAGE: fetching the console page yields no token to steal', async () => {
  for (const p of ['/', '/console.js', '/console.css']) {
    const res = await asAppPage(`${consoleBase}${p}`, { method: 'GET' });
    assert.ok(!res.body.includes(key), `${p} leaked the key`);
    assert.equal(res.headers['set-cookie'], undefined);
  }
});

test('HOSTILE PAGE: console read APIs (status, logs, versions) are not on the app port', async () => {
  for (const p of ['/status', '/logs', '/versions', '/versions/1/diff']) {
    const res = await asAppPage(`${appBase}/_evolv/api${p}`, { method: 'GET', extra: { Authorization: `Bearer ${key}` } });
    assert.equal(res.status, 404, p);
  }
  assert.equal(calls.status, 0);
});

test('app pages CAN submit, cancel and read progress (the only three routes)', async () => {
  const submit = await asAppPage(`${appBase}/_evolv/api/changes`);
  assert.equal(submit.status, 202);
  assert.equal(JSON.parse(submit.body).id, ID);
  assert.equal((await asAppPage(`${appBase}/_evolv/api/changes/${ID}/cancel`)).status, 200);
  assert.equal((await asAppPage(`${appBase}/_evolv/api/changes/${ID}/events`, { method: 'GET' })).status, 200);
  assert.deepEqual([calls.submit, calls.cancel, calls.events], [1, 1, 1]);
});

test('submit and cancel still need the exact app Origin (no cross-site POSTs)', async () => {
  for (const p of ['/changes', `/changes/${ID}/cancel`]) {
    for (const origin of ['http://evil.example', consoleBase, 'null', undefined]) {
      const extra = origin === undefined ? { Origin: undefined } : { Origin: origin };
      const headers = { ...extra };
      if (origin === undefined) delete headers.Origin;
      const res = await request(`${appBase}/_evolv/api${p}`, { method: 'POST', body: '{}', headers });
      assert.equal(res.status, 403, `${p} with Origin ${origin}`);
    }
  }
  assert.deepEqual([calls.submit, calls.cancel], [1, 1], 'no handler may run for a bad Origin');
});

test('change ids must look unguessable: short or odd ids are 404', async () => {
  for (const id of ['1', 'abc', '..', 'a%2Fb', 'x'.repeat(65)]) {
    const res = await asAppPage(`${appBase}/_evolv/api/changes/${id}/cancel`);
    assert.equal(res.status, 404, id);
  }
  assert.equal(calls.cancel, 1);
});

test('the route table on the app port is exactly submit, cancel, events', async () => {
  const probes = [
    ['GET', '/changes'], ['PUT', '/changes'], ['DELETE', `/changes/${ID}`], ['GET', `/changes/${ID}`],
    ['POST', `/changes/${ID}/events`], ['GET', `/changes/${ID}/cancel`], ['GET', '/versions'], ['POST', '/versions'],
    ['GET', '/status'], ['GET', '/logs'], ['POST', '/reset'], ['POST', '/login'],
  ];
  for (const [method, p] of probes) {
    const res = await asAppPage(`${appBase}/_evolv/api${p}`, { method });
    assert.equal(res.status, 404, `${method} ${p}`);
  }
  assert.deepEqual([calls.submit, calls.cancel, calls.events], [1, 1, 1]);
});

test('the console UI files are not served on the app port', async () => {
  for (const p of ['/_evolv/console.js', '/_evolv/console.css', '/_evolv/index.html']) {
    assert.equal((await asAppPage(`${appBase}${p}`, { method: 'GET' })).status, 404, p);
  }
});

test('/_evolv on the app port is a plain page that links to the console origin', async () => {
  for (const p of ['/_evolv', '/_evolv/']) {
    const res = await request(`${appBase}${p}`);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /html/);
    assert.ok(res.body.includes(`http://127.0.0.1:${consolePort}/`));
    assert.ok(!res.body.includes(key));
  }
});

test('a preflight or foreign Host on the app port is refused', async () => {
  const pre = await request(`${appBase}/_evolv/api/changes`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' },
  });
  assert.equal(pre.status, 403);
  assert.ok(!Object.keys(pre.headers).some((h) => h.startsWith('access-control-')));
  const rebind = await request(`${appBase}/_evolv/api/changes`, { method: 'POST', headers: { Host: 'evil.example', Origin: appBase } });
  assert.equal(rebind.status, 403);
});

test('ordinary app requests still reach the app through the proxy', async () => {
  const res = await request(`${appBase}/hello?x=1`);
  assert.equal(res.body, 'APP PAGE /hello?x=1');
});

test('the console port never proxies to the app', async () => {
  const res = await request(`${consoleBase}/hello`);
  assert.equal(res.status, 404);
  assert.ok(!res.body.includes('APP PAGE'));
});
