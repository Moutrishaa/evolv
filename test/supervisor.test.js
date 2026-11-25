import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSupervisor } from '../supervisor/main.js';
import { loadConfig } from '../supervisor/config.js';
import { makeTempDir, getFreePort, request, waitFor, ROOT } from '../test-fixtures/helpers.js';

// End to end for B1: real seed, real sandboxed app, real proxy, real console.
let tmp, sup, base;
const KEY = 'sk-test-key-must-never-appear';

before(async () => {
  tmp = makeTempDir('evolv-sup-');
  fs.cpSync(path.join(ROOT, 'seed'), path.join(tmp.dir, 'seed'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'console'), path.join(tmp.dir, 'console'), { recursive: true });
  const port = await getFreePort();
  const appPort = await getFreePort();
  const config = loadConfig({ envText: `AI_API_KEY=${KEY}`, env: { PORT: String(port) } });
  sup = await startSupervisor({ config, root: tmp.dir, appPort });
  base = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await request(`${base}/health`)).status === 200, {
    timeout: 15000,
    what: 'seed app to answer /health through the proxy',
  });
});

after(async () => {
  await sup?.close();
  tmp?.cleanup();
});

test('supervisor binds to 127.0.0.1 only', () => {
  assert.equal(sup.server.address().address, '127.0.0.1');
});

test('seed app is served through the proxy', async () => {
  const home = await request(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers['content-type'], /html/);
  assert.match(home.body, /Recovery console/);
  assert.equal((await request(`${base}/health`)).status, 200);
});

test('console page is served at /_evolv', async () => {
  const res = await request(`${base}/_evolv`);
  assert.equal(res.status, 200);
  assert.match(res.body, /Evolv/);
});

test('status reports a running app, version 1 and the budget', async () => {
  const res = await request(`${base}/_evolv/api/status`);
  assert.equal(res.status, 200);
  const s = JSON.parse(res.body);
  assert.equal(s.app.state, 'running');
  assert.equal(s.version.current, 1);
  assert.equal(s.budget.used, 0);
  assert.equal(s.budget.total, 300000);
  assert.ok(!res.body.includes(KEY));
});

test('logs endpoint returns lines and never the API key', async () => {
  const res = await request(`${base}/_evolv/api/logs`);
  assert.equal(res.status, 200);
  const j = JSON.parse(res.body);
  assert.ok(Array.isArray(j.lines));
  assert.ok(!res.body.includes(KEY));
});

test('/_evolv can never reach the app, however the path is spelled', async () => {
  for (const p of ['/_evolv/api/status', '//_evolv/api/status', '/_EVOLV/api/status', '/%5Fevolv/api/status', '/./_evolv/api/status', '/x/../_evolv/api/status']) {
    const res = await request(`${base}${p}`);
    assert.equal(res.headers['x-evolv-supervisor'], '1', `${p} escaped to the app`);
  }
});

test('the seed app listens on 127.0.0.1 only', () => {
  const src = fs.readFileSync(path.join(ROOT, 'seed', 'server.js'), 'utf8');
  assert.match(src, /127\.0\.0\.1/);
});

test('restarting the supervisor keeps version 1 and does not re-seed', async () => {
  fs.writeFileSync(path.join(tmp.dir, 'app', 'data', 'keep.txt'), 'survives');
  const port2 = await getFreePort();
  const sup2 = await startSupervisor({
    config: loadConfig({ envText: '', env: { PORT: String(port2) } }),
    root: tmp.dir,
    appPort: await getFreePort(),
  });
  try {
    const { listVersions } = await import('../supervisor/versions.js');
    assert.equal((await listVersions(path.join(tmp.dir, 'app'))).length, 1);
    assert.equal(fs.readFileSync(path.join(tmp.dir, 'app', 'data', 'keep.txt'), 'utf8'), 'survives');
  } finally {
    await sup2.close();
  }
});
