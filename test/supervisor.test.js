import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startSupervisor } from '../supervisor/main.js';
import { loadConfig } from '../supervisor/config.js';
import { makeTempDir, getFreePort, getConsolePortFor, request, waitFor, gitOut, ROOT } from '../test-fixtures/helpers.js';
import { startFakeProvider, reply, toolUse } from '../test-fixtures/fake-provider.js';
import { ensureSeeded } from '../supervisor/versions.js';
import { createWorkspace } from '../supervisor/workspace.js';
import { newChangeId } from '../supervisor/changes.js';

// End to end for B1: real seed, real sandboxed app, real proxy, real console on its own port.
let tmp, sup, base, cbase, auth, fake;
const AI_KEY = 'sk-test-key-must-never-appear';

before(async () => {
  tmp = makeTempDir('evolv-sup-');
  fs.cpSync(path.join(ROOT, 'seed'), path.join(tmp.dir, 'seed'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'console'), path.join(tmp.dir, 'console'), { recursive: true });
  const port = await getFreePort();
  const consolePort = await getConsolePortFor(port);
  const appPort = await getFreePort();
  const config = loadConfig({
    envText: `AI_API_KEY=${AI_KEY}`,
    env: { PORT: String(port), CONSOLE_PORT: String(consolePort) },
  });
  fake = await startFakeProvider({
    apiKey: AI_KEY,
    script: [
      reply([toolUse('read_file', { path: 'public/style.css' })]),
      reply([toolUse('edit_file', { path: 'public/style.css', old_text: '#fafafa', new_text: '#000080' })]),
      reply([toolUse('finish', { summary: 'Made the page navy.' })]),
    ],
  });
  // aiBaseUrl is a code-level test seam, never an environment or .env setting.
  sup = await startSupervisor({ config, root: tmp.dir, appPort, aiBaseUrl: fake.url });
  base = `http://127.0.0.1:${port}`;
  cbase = `http://127.0.0.1:${consolePort}`;
  auth = { Authorization: `Bearer ${sup.consoleKey}` };
  await waitFor(async () => (await request(`${base}/health`)).status === 200, {
    timeout: 15000,
    what: 'seed app to answer /health through the proxy',
  });
});

after(async () => {
  await fake?.close();
  await sup?.close();
  tmp?.cleanup();
});

test('both listeners bind to 127.0.0.1 only', () => {
  assert.equal(sup.server.address().address, '127.0.0.1');
  assert.equal(sup.consoleServer.address().address, '127.0.0.1');
  assert.notEqual(sup.server.address().port, sup.consoleServer.address().port);
});

test('seed app is served through the proxy', async () => {
  const home = await request(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers['content-type'], /html/);
  assert.match(home.body, /Recovery console/);
  assert.equal((await request(`${base}/health`)).status, 200);
});

test('the console key lives in state/, outside app/, and is a 256-bit hex string', () => {
  const file = path.join(tmp.dir, 'state', 'console.key');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), sup.consoleKey);
  assert.match(sup.consoleKey, /^[0-9a-f]{64}$/);
  assert.ok(!fs.existsSync(path.join(tmp.dir, 'app', 'console.key')));
});

test('console shell is served on the console port, not on the app port', async () => {
  const shell = await request(`${cbase}/`);
  assert.equal(shell.status, 200);
  assert.match(shell.body, /Evolv/);
  assert.ok(!shell.body.includes(sup.consoleKey));
  assert.equal((await request(`${base}/_evolv/console.js`)).status, 404);
});

test('/_evolv on the app port is only a pointer to the console', async () => {
  const res = await request(`${base}/_evolv`);
  assert.equal(res.status, 200);
  assert.ok(res.body.includes(cbase + '/'));
});

test('status needs the token and reports a running app, version 1 and the budget', async () => {
  assert.equal((await request(`${cbase}/api/status`)).status, 401);
  const res = await request(`${cbase}/api/status`, { headers: auth });
  assert.equal(res.status, 200);
  const s = JSON.parse(res.body);
  assert.equal(s.app.state, 'running');
  assert.equal(s.version.current, 1);
  assert.equal(s.budget.used, 0);
  assert.equal(s.budget.total, 300000);
  assert.ok(!res.body.includes(AI_KEY));
  assert.ok(!res.body.includes(sup.consoleKey));
});

test('logs need the token and never contain the AI key or the console key', async () => {
  assert.equal((await request(`${cbase}/api/logs`)).status, 401);
  const res = await request(`${cbase}/api/logs`, { headers: auth });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(JSON.parse(res.body).lines));
  assert.ok(!res.body.includes(AI_KEY));
  assert.ok(!res.body.includes(sup.consoleKey));
});

test('/_evolv can never reach the app, however the path is spelled', async () => {
  for (const p of ['/_evolv/api/status', '//_evolv/api/status', '/_EVOLV/api/status', '/%5Fevolv/api/status', '/./_evolv/api/status', '/x/../_evolv/api/status']) {
    const res = await request(`${base}${p}`);
    assert.equal(res.headers['x-evolv-supervisor'], '1', `${p} escaped to the app`);
    assert.equal(res.status === 404 || res.status === 200, true, p);
  }
});

test('the status and logs APIs do not exist on the app port', async () => {
  for (const p of ['/_evolv/api/status', '/_evolv/api/logs']) {
    assert.equal((await request(`${base}${p}`, { headers: auth })).status, 404, p);
  }
});

test('the seed app listens on 127.0.0.1 only', () => {
  const src = fs.readFileSync(path.join(ROOT, 'seed', 'server.js'), 'utf8');
  assert.match(src, /127\.0\.0\.1/);
});

test('restarting the supervisor keeps version 1, data/ and the same console key', async () => {
  fs.writeFileSync(path.join(tmp.dir, 'app', 'data', 'keep.txt'), 'survives');
  const port2 = await getFreePort();
  const sup2 = await startSupervisor({
    config: loadConfig({
      envText: '',
      env: { PORT: String(port2), CONSOLE_PORT: String(await getConsolePortFor(port2)) },
    }),
    root: tmp.dir,
    appPort: await getFreePort(),
  });
  try {
    const { listVersions } = await import('../supervisor/versions.js');
    assert.equal((await listVersions(path.join(tmp.dir, 'app'))).length, 1);
    assert.equal(fs.readFileSync(path.join(tmp.dir, 'app', 'data', 'keep.txt'), 'utf8'), 'survives');
    assert.equal(sup2.consoleKey, sup.consoleKey, 'a saved browser login must survive restarts');
  } finally {
    await sup2.close();
  }
});

// ---------- B2: the agent is wired in ----------
test('a change runs through the supervisor with the fake provider, and Status shows real usage', async () => {
  const before = JSON.parse((await request(`${cbase}/api/status`, { headers: auth })).body);
  assert.equal(before.budget.used, 0);
  const { done } = sup.changes.start('Change the background to dark navy');
  const result = await done;
  assert.equal(result.summary, 'Made the page navy.');
  assert.deepEqual(result.changedFiles, [{ path: 'public/style.css', status: 'modified' }]);

  const after = JSON.parse((await request(`${cbase}/api/status`, { headers: auth })).body);
  assert.equal(after.budget.used, 450);
  assert.equal(after.budget.total, 300000);
  assert.equal(after.budget.problem ?? null, null);
  // Nothing went live (that is B3): the live app is untouched and the staging copy is gone.
  assert.equal((await gitOut(path.join(tmp.dir, 'app'), ['status', '--porcelain'])).trim(), '');
  assert.deepEqual(fs.readdirSync(path.join(tmp.dir, 'state', 'workspaces')), []);
});

test('the AI key appears nowhere: not in status, logs, the ledger, the console key file or the app folder', async () => {
  for (const p of ['/api/status', '/api/logs']) assert.ok(!(await request(`${cbase}${p}`, { headers: auth })).body.includes(AI_KEY));
  const scan = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) scan(full);
      else assert.ok(!fs.readFileSync(full).includes(AI_KEY), `key found in ${full}`);
    }
  };
  scan(path.join(tmp.dir, 'state'));
  scan(path.join(tmp.dir, 'app'));
  assert.ok(fake.requests.every((r) => r.headers['x-api-key'] === AI_KEY && !r.raw.includes(AI_KEY)));
});

async function bareRoot() {
  const t = makeTempDir('evolv-sup2-');
  fs.cpSync(path.join(ROOT, 'seed'), path.join(t.dir, 'seed'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'console'), path.join(t.dir, 'console'), { recursive: true });
  const port = await getFreePort();
  const config = loadConfig({ envText: '', env: { PORT: String(port), CONSOLE_PORT: String(await getConsolePortFor(port)) } });
  return { t, config };
}

test('a damaged usage file does not stop the supervisor: Status explains it and changes are refused', async () => {
  const { t, config } = await bareRoot();
  fs.mkdirSync(path.join(t.dir, 'state'), { recursive: true });
  const ledgerFile = path.join(t.dir, 'state', 'usage.json');
  fs.writeFileSync(ledgerFile, 'this is not json');
  const sup2 = await startSupervisor({ config, root: t.dir, appPort: await getFreePort() });
  try {
    const res = await request(`http://127.0.0.1:${config.consolePort}/api/status`, { headers: { Authorization: `Bearer ${sup2.consoleKey}` } });
    assert.equal(res.status, 200);
    const s = JSON.parse(res.body);
    assert.ok(s.budget.problem.includes(ledgerFile));
    assert.match(s.budget.problem, /damaged/i);
    assert.throws(() => sup2.changes.start('anything'), (e) => e.code === 'ledger_unreadable');
    assert.equal(fs.readFileSync(ledgerFile, 'utf8'), 'this is not json');
  } finally {
    await sup2.close();
    t.cleanup();
  }
});

test('workspaces left behind by a crash are swept at start-up', async () => {
  const { t, config } = await bareRoot();
  const appDir = path.join(t.dir, 'app');
  await ensureSeeded({ seedDir: path.join(t.dir, 'seed'), appDir });
  const workspacesDir = path.join(t.dir, 'state', 'workspaces');
  fs.mkdirSync(workspacesDir, { recursive: true });
  const left = await createWorkspace({ appDir, workspacesDir, id: newChangeId() });
  assert.ok(fs.existsSync(left.dir));
  const sup2 = await startSupervisor({ config, root: t.dir, appPort: await getFreePort() });
  try {
    assert.deepEqual(fs.readdirSync(workspacesDir), []);
    assert.ok(!(await gitOut(appDir, ['worktree', 'list'])).includes(left.id));
  } finally {
    await sup2.close();
    t.cleanup();
  }
});
