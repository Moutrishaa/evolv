import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createApi } from '../supervisor/api.js';
import { makeTempDir, getFreePort, request } from '../test-fixtures/helpers.js';

// The state-changing route exists ONLY in this test file, never in shipped code.
let tmp, server, port, base, cookie;

before(async () => {
  tmp = makeTempDir('evolv-token-');
  fs.writeFileSync(path.join(tmp.dir, 'index.html'), '<h1>console</h1>');
  fs.writeFileSync(path.join(tmp.dir, 'console.js'), '// js');
  fs.writeFileSync(path.join(tmp.dir, 'console.css'), '/* css */');
  fs.writeFileSync(path.join(tmp.dir, 'secret.txt'), 'nope');
  port = await getFreePort();
  base = `http://127.0.0.1:${port}`;
  const api = createApi({
    port,
    consoleDir: tmp.dir,
    routes: {
      'GET /ping': () => ({ status: 200, body: { pong: true } }),
      'POST /test-mutate': () => ({ status: 200, body: { mutated: true } }),
    },
  });
  server = http.createServer((req, res) => api.handle(req, res));
  await new Promise((r) => server.listen(port, '127.0.0.1', r));

  const res = await request(`${base}/_evolv/`);
  cookie = res.headers['set-cookie'][0].split(';')[0];
});

after(async () => {
  await new Promise((r) => server.close(r));
  tmp.cleanup();
});

const post = (headers) => request(`${base}/_evolv/api/test-mutate`, { method: 'POST', headers, body: '{}' });

test('console page sets an HttpOnly, SameSite=Strict session cookie', async () => {
  const res = await request(`${base}/_evolv/`);
  assert.equal(res.status, 200);
  const sc = res.headers['set-cookie'][0];
  assert.match(sc, /^evolv_session=/);
  assert.match(sc, /HttpOnly/i);
  assert.match(sc, /SameSite=Strict/i);
  assert.equal(res.headers['x-evolv-supervisor'], '1');
});

test('POST without a token is rejected with 403', async () => {
  const res = await post({ Origin: base });
  assert.equal(res.status, 403);
  assert.equal(JSON.parse(res.body).error.code, 'forbidden');
});

test('POST with a wrong token is rejected', async () => {
  const res = await post({ Origin: base, Cookie: 'evolv_session=not-the-token' });
  assert.equal(res.status, 403);
});

test('POST with a valid token but no Origin is rejected', async () => {
  const res = await post({ Cookie: cookie });
  assert.equal(res.status, 403);
});

test('POST with a valid token but a foreign Origin is rejected', async () => {
  const res = await post({ Cookie: cookie, Origin: 'http://evil.example' });
  assert.equal(res.status, 403);
});

test('POST with a valid token and matching Origin succeeds', async () => {
  const res = await post({ Cookie: cookie, Origin: base });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { mutated: true });
});

test('localhost origin on the same port is accepted too', async () => {
  const res = await post({ Cookie: cookie, Origin: `http://localhost:${port}` });
  assert.equal(res.status, 200);
});

test('GET routes do not need a token', async () => {
  const res = await request(`${base}/_evolv/api/ping`);
  assert.equal(res.status, 200);
});

test('a foreign Host header is rejected (DNS rebinding)', async () => {
  const res = await request(`${base}/_evolv/api/ping`, { headers: { Host: 'evil.example' } });
  assert.equal(res.status, 403);
});

test('unknown API route returns a JSON error', async () => {
  const res = await request(`${base}/_evolv/api/nope`);
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error.code, 'not_found');
});

test('console files are a fixed whitelist, no path traversal', async () => {
  for (const p of ['/_evolv/secret.txt', '/_evolv/..%2Fsecret.txt', '/_evolv/%2e%2e/secret.txt']) {
    const res = await request(`${base}${p}`);
    assert.equal(res.status, 404, p);
  }
});
