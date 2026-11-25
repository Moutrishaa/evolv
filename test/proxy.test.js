import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createProxy } from '../supervisor/proxy.js';
import { getFreePort, request } from '../test-fixtures/helpers.js';

let upstream, upstreamPort, front, frontPort, deadPort;

before(async () => {
  upstreamPort = await getFreePort();
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = req.url === '/teapot' ? 418 : 200;
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          cookie: req.headers.cookie ?? null,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
  });
  await new Promise((r) => upstream.listen(upstreamPort, '127.0.0.1', r));

  deadPort = await getFreePort();
  frontPort = await getFreePort();
  let current = upstreamPort;
  const proxy = createProxy({ getPort: () => current });
  front = http.createServer((req, res) => {
    if (req.url === '/__down') current = deadPort;
    if (req.url === '/__up') current = upstreamPort;
    proxy.handle(req, res);
  });
  await new Promise((r) => front.listen(frontPort, '127.0.0.1', r));
});

after(async () => {
  await new Promise((r) => front.close(r));
  await new Promise((r) => upstream.close(r));
});

const url = (p) => `http://127.0.0.1:${frontPort}${p}`;

test('forwards GET with path and query', async () => {
  const res = await request(url('/health?x=1'));
  assert.equal(res.status, 200);
  const j = JSON.parse(res.body);
  assert.equal(j.method, 'GET');
  assert.equal(j.url, '/health?x=1');
});

test('forwards POST bodies', async () => {
  const res = await request(url('/notes'), { method: 'POST', body: 'hello', headers: { 'Content-Length': '5' } });
  assert.equal(JSON.parse(res.body).body, 'hello');
});

test('passes through upstream status codes', async () => {
  assert.equal((await request(url('/teapot'))).status, 418);
});

test('returns a 502 page pointing at the recovery console when the app is down', async () => {
  await request(url('/__down'));
  const res = await request(url('/anything'));
  assert.equal(res.status, 502);
  assert.match(res.headers['content-type'], /html/);
  assert.match(res.body, /\/_evolv/);
  await request(url('/__up'));
});
