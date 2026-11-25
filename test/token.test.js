// Console API on its own port: header token (no cookies) + strict Origin + Host checks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createConsoleApi } from '../supervisor/api.js';
import { ensureConsoleKey } from '../supervisor/auth.js';
import { makeTempDir, getFreePort, request } from '../test-fixtures/helpers.js';

// The state-changing route exists ONLY in this test file, never in shipped code.
let tmp, server, port, base, key;

before(async () => {
  tmp = makeTempDir('evolv-token-');
  const consoleDir = path.join(tmp.dir, 'console');
  fs.mkdirSync(consoleDir);
  fs.writeFileSync(path.join(consoleDir, 'index.html'), '<h1>console</h1>');
  fs.writeFileSync(path.join(consoleDir, 'console.js'), '// js');
  fs.writeFileSync(path.join(consoleDir, 'console.css'), '/* css */');
  fs.writeFileSync(path.join(tmp.dir, 'secret.txt'), 'nope');
  key = ensureConsoleKey(path.join(tmp.dir, 'state'));
  port = await getFreePort();
  base = `http://127.0.0.1:${port}`;
  const api = createConsoleApi({
    port,
    consoleDir,
    key,
    routes: {
      'GET /ping': () => ({ status: 200, body: { pong: true } }),
      'POST /test-mutate': () => ({ status: 200, body: { mutated: true } }),
    },
  });
  server = http.createServer((req, res) => api.handle(req, res));
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
});

after(async () => {
  await new Promise((r) => server.close(r));
  tmp.cleanup();
});

const auth = (k = key) => ({ Authorization: `Bearer ${k}` });
const post = (headers) => request(`${base}/api/test-mutate`, { method: 'POST', headers, body: '{}' });

test('ensureConsoleKey makes a 256-bit key, keeps it, and repairs a corrupt file', () => {
  const dir = path.join(tmp.dir, 'state2');
  const k1 = ensureConsoleKey(dir);
  assert.match(k1, /^[0-9a-f]{64}$/);
  assert.equal(ensureConsoleKey(dir), k1, 'must be stable across restarts');
  fs.writeFileSync(path.join(dir, 'console.key'), 'garbage');
  const k2 = ensureConsoleKey(dir);
  assert.match(k2, /^[0-9a-f]{64}$/);
  assert.notEqual(k2, k1);
});

test('the console shell is public but contains no secret and sets no cookie', async () => {
  const res = await request(`${base}/`);
  assert.equal(res.status, 200);
  assert.ok(!res.body.includes(key));
  assert.equal(res.headers['set-cookie'], undefined);
});

test('console responses forbid framing and sniffing and grant no CORS', async () => {
  for (const p of ['/', '/api/ping', '/nope']) {
    const res = await request(`${base}${p}`, { headers: auth() });
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/, p);
    assert.equal(res.headers['x-frame-options'], 'DENY', p);
    assert.equal(res.headers['x-content-type-options'], 'nosniff', p);
    assert.equal(res.headers['cross-origin-resource-policy'], 'same-origin', p);
    assert.equal(res.headers['x-evolv-supervisor'], '1', p);
    assert.ok(!Object.keys(res.headers).some((h) => h.startsWith('access-control-')), `${p} sent CORS headers`);
  }
});

test('API without a token is rejected with 401', async () => {
  const res = await request(`${base}/api/ping`);
  assert.equal(res.status, 401);
  assert.equal(JSON.parse(res.body).error.code, 'unauthorized');
});

test('wrong, malformed, empty and wrong-length tokens are rejected', async () => {
  for (const h of [
    { Authorization: `Bearer ${'0'.repeat(64)}` },
    { Authorization: 'Bearer x' },
    { Authorization: 'Bearer ' },
    { Authorization: key }, // no scheme
    { Authorization: `Basic ${key}` },
  ]) {
    assert.equal((await request(`${base}/api/ping`, { headers: h })).status, 401, JSON.stringify(h));
  }
});

test('a cookie is never accepted as authentication', async () => {
  for (const c of [`evolv_session=${key}`, `token=${key}`, key]) {
    const res = await request(`${base}/api/ping`, { headers: { Cookie: c, Origin: base } });
    assert.equal(res.status, 401, c);
  }
});

test('a valid token works for reads and, with the console Origin, for writes', async () => {
  assert.equal((await request(`${base}/api/ping`, { headers: auth() })).status, 200);
  const ok = await post({ ...auth(), Origin: base });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.body), { mutated: true });
  assert.equal((await post({ ...auth(), Origin: `http://localhost:${port}` })).status, 200);
});

test('a valid token is not enough: writes need the exact console Origin', async () => {
  assert.equal((await post({ ...auth() })).status, 403, 'no Origin');
  assert.equal((await post({ ...auth(), Origin: 'http://evil.example' })).status, 403);
  assert.equal((await post({ ...auth(), Origin: 'http://127.0.0.1:3000' })).status, 403, 'the app origin');
  assert.equal((await post({ ...auth(), Origin: `${base}.evil.example` })).status, 403);
  assert.equal((await post({ ...auth(), Origin: 'null' })).status, 403);
});

test('a stolen token used with a foreign Origin is rejected even for reads', async () => {
  const res = await request(`${base}/api/ping`, { headers: { ...auth(), Origin: 'http://127.0.0.1:3000' } });
  assert.equal(res.status, 403);
});

test('POST with no token at all is 401 and the handler never runs', async () => {
  assert.equal((await post({ Origin: base })).status, 401);
});

test('CORS preflight is refused and grants nothing', async () => {
  const res = await request(`${base}/api/test-mutate`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://127.0.0.1:3000',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
  assert.equal(res.status, 403);
  assert.ok(!Object.keys(res.headers).some((h) => h.startsWith('access-control-')));
});

test('a foreign Host header is rejected (DNS rebinding)', async () => {
  const res = await request(`${base}/api/ping`, { headers: { ...auth(), Host: 'evil.example' } });
  assert.equal(res.status, 403);
  assert.equal((await request(`${base}/`, { headers: { Host: 'evil.example' } })).status, 403);
});

test('unknown API route returns a JSON 404 (after auth)', async () => {
  const res = await request(`${base}/api/nope`, { headers: auth() });
  assert.equal(res.status, 404);
  assert.equal(JSON.parse(res.body).error.code, 'not_found');
});

test('console files are a fixed whitelist, no path traversal', async () => {
  for (const p of ['/secret.txt', '/..%2Fsecret.txt', '/%2e%2e/secret.txt', '/../secret.txt']) {
    assert.equal((await request(`${base}${p}`)).status, 404, p);
  }
});
