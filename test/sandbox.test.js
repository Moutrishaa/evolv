import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSandboxed, buildSandboxArgs, buildSandboxEnv, WINDOWS_LIBUV_VARS, WINDOWS_REQUIRED_VAR } from '../supervisor/process.js';
import { makeSandboxFixture, getFreePort, request, waitFor } from '../test-fixtures/helpers.js';

let fx;
let child;
let report;
let stderr = '';
const SECRET = 'sk-parent-process-secret';

before(async () => {
  fx = makeSandboxFixture();
  const port = await getFreePort();

  // The parent holds a fake key. The launcher must keep it away from the app.
  process.env.AI_API_KEY = SECRET;
  try {
    child = spawnSandboxed({ appDir: fx.appDir, dataDir: fx.dataDir, port });
  } finally {
    delete process.env.AI_API_KEY;
  }
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.on('data', () => {});

  const res = await waitFor(() => request(`http://127.0.0.1:${port}/report`), {
    timeout: 10000,
    what: `hostile app report (stderr: ${stderr})`,
  });
  assert.equal(res.status, 200);
  report = JSON.parse(res.body);
});

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => child.once('exit', r));
  }
  fx?.cleanup();
});

const attack = (name) => {
  const a = report.attacks.find((x) => x.name === name);
  assert.ok(a, `attack "${name}" missing from report`);
  return a;
};

// A block must come from the permission model, never from ENOENT or a typo.
function assertBlocked(name, allowed = ['ERR_ACCESS_DENIED']) {
  const a = attack(name);
  assert.equal(a.succeeded, false, `SANDBOX BREACH: "${name}" succeeded`);
  assert.ok(allowed.includes(a.code), `"${name}" failed for the wrong reason: ${a.code}`);
}

test('the app really runs under the permission model', () => {
  assert.equal(report.permissionModelOn, true);
});

test('control: the app CAN write inside data/', () => {
  assert.equal(report.control.succeeded, true);
  assert.equal(fs.readFileSync(path.join(fx.dataDir, 'ok.txt'), 'utf8'), 'allowed');
});

test('attack: read ../.env is blocked', () => assertBlocked('read ../.env'));
test('attack: read a file in supervisor/ is blocked', () => assertBlocked('read supervisor/ file'));
test('attack: read a Windows system path is blocked', () => assertBlocked('read Windows system path'));
test('attack: write outside data/ is blocked', () => {
  assertBlocked('write outside data/');
  assert.equal(fs.existsSync(path.join(fx.root, 'escaped.txt')), false);
});
test('attack: rewriting its own code outside data/ is blocked', () => {
  assertBlocked('write own code outside data/');
  assert.equal(fs.existsSync(path.join(fx.appDir, 'tampered.js')), false);
});
test('attack: spawning a process is blocked', () => assertBlocked('spawn a process'));
test('attack: starting a worker is blocked', () => assertBlocked('start a worker'));
// Node reports ERR_DLOPEN_DISABLED for addons under --permission. Still a permission-model block.
test('attack: loading a native addon is blocked', () =>
  assertBlocked('load a native addon', ['ERR_ACCESS_DENIED', 'ERR_DLOPEN_DISABLED']));

test('the app sees only PORT, DATA_DIR and NODE_ENV as real values (plus SYSTEMROOT on Windows)', () => {
  const expected = ['DATA_DIR', 'NODE_ENV', 'PORT'];
  if (process.platform === 'win32') expected.push(WINDOWS_REQUIRED_VAR); // Node crypto needs it on Windows
  assert.deepEqual(report.envNonEmptyKeys, expected.sort());
});

test('any other env key is a blanked Windows libuv variable, nothing else', () => {
  const extra = report.envKeys.filter((k) => !['DATA_DIR', 'NODE_ENV', 'PORT'].includes(k));
  for (const k of extra) {
    assert.ok(process.platform === 'win32' && WINDOWS_LIBUV_VARS.includes(k), `unexpected env key ${k}`);
  }
});

test('AI_API_KEY is invisible to the app', () => {
  assert.equal(report.aiKeyVisible, false);
  assert.ok(!JSON.stringify(report).includes(SECRET));
});

test('the canary .env was never read or leaked', () => {
  assert.ok(!JSON.stringify(report).includes('sk-canary'));
});

test('launcher args: permission model on, scoped fs access, no capability grants', () => {
  const args = buildSandboxArgs({ appDir: fx.appDir, dataDir: fx.dataDir, entry: 'server.js' });
  assert.ok(args.includes('--permission'));
  assert.ok(args.includes(`--allow-fs-read=${fx.appDir}`));
  assert.ok(args.includes(`--allow-fs-write=${fx.dataDir}`));
  assert.ok(args.includes('--max-old-space-size=256'));
  for (const bad of ['--allow-child-process', '--allow-worker', '--allow-addons', '--allow-wasi', '--allow-ffi', '--allow-fs-vfs']) {
    assert.ok(!args.some((a) => a.startsWith(bad)), `launcher must not pass ${bad}`);
  }
  // Exactly one read grant and one write grant, nothing broader.
  assert.equal(args.filter((a) => a.startsWith('--allow-fs-read')).length, 1);
  assert.equal(args.filter((a) => a.startsWith('--allow-fs-write')).length, 1);
});

test('buildSandboxEnv returns only PORT, DATA_DIR, NODE_ENV', () => {
  const env = buildSandboxEnv({ port: 3001, dataDir: 'x' });
  assert.deepEqual(Object.keys(env).sort(), ['DATA_DIR', 'NODE_ENV', 'PORT']);
  assert.equal(env.PORT, '3001');
});
