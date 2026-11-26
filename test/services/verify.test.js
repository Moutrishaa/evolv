// The verifier starts AI-written code in the sandbox on a spare port and decides whether it may
// go live. Every way a change can be broken must fail HERE, never after the swap.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { verifyWorkspace } from '../../supervisor/services/verify.js';
import { writeApp, serverSource, LINK } from '../../test-fixtures/apps/apps.js';
import { makeTempDir, getFreePort, sleep } from '../../test-fixtures/helpers/helpers.js';

const CONSOLE_PORT = 3002;
const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function app(opts) {
  const tmp = makeTempDir('evolv-verify-');
  cleanups.push(tmp.cleanup);
  const dir = path.join(tmp.dir, 'ws');
  writeApp(dir, opts);
  return { dir, parent: tmp.dir };
}
const run = (dir, o = {}) => verifyWorkspace({ dir, timeoutMs: 3000, settleMs: 250, consolePort: CONSOLE_PORT, ...o });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const failedCheck = (r) => r.checks.find((c) => !c.ok);

test('a healthy app passes every check, in order', async () => {
  const { dir } = app();
  const r = await run(dir);
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(r.checks.map((c) => [c.name, c.ok]), [['files', true], ['start', true], ['home', true], ['console_link', true], ['smoke', true], ['alive', true]]);
});

test('the real seed app passes (it must, or every change would fail)', async () => {
  const tmp = makeTempDir('evolv-verify-seed-');
  cleanups.push(tmp.cleanup);
  const dir = path.join(tmp.dir, 'ws');
  fs.cpSync(new URL('../../seed', import.meta.url), dir, { recursive: true });
  const r = await run(dir);
  assert.equal(r.ok, true, r.message);
});

test('progress is reported check by check', async () => {
  const { dir } = app();
  const seen = [];
  await run(dir, { onCheck: (c) => seen.push(`${c.check}:${c.status}`) });
  assert.deepEqual(seen, ['files:running', 'files:passed', 'start:running', 'start:passed', 'home:running', 'home:passed', 'console_link:running', 'console_link:passed', 'smoke:running', 'smoke:passed', 'alive:running', 'alive:passed']);
});

// ---------- crash on start ----------
for (const [label, server, marker] of [
  ['throws on start', "throw new Error('boom on purpose');\n", 'boom on purpose'],
  ['has a syntax error', 'this is { not javascript\n', 'SyntaxError'],
  ['exits immediately', "console.log('goodbye'); process.exit(3);\n", 'goodbye'],
  ['imports a package that is not installed', "import 'express';\n", 'express'],
]) {
  test(`crash on start (${label}) fails fast with the app's own error text`, async () => {
    const { dir } = app({ server });
    const t0 = Date.now();
    const r = await run(dir);
    assert.equal(r.ok, false);
    assert.equal(failedCheck(r).name, 'start');
    assert.match(r.message, /did not start|stopped right after/i);
    assert.ok(r.output.includes(marker), `output should show "${marker}": ${r.output}`);
    assert.ok(Date.now() - t0 < 2500, 'a crash must not wait for the full timeout');
  });
}

test('an app that never listens fails at the timeout and is killed', async () => {
  const { dir } = app({ server: 'setInterval(() => {}, 1000);\n' });
  let pid;
  const t0 = Date.now();
  const r = await run(dir, { timeoutMs: 800, onSpawn: (s) => (pid = s.pid) });
  assert.equal(r.ok, false);
  assert.equal(failedCheck(r).name, 'start');
  assert.match(r.message, /did not answer on \/health within/i);
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(alive(pid), false);
});

test('/health returning 500 fails', async () => {
  const { dir } = app({ server: serverSource({ healthStatus: 500 }) });
  const r = await run(dir);
  assert.equal(failedCheck(r).name, 'start');
  assert.match(r.message, /500/);
});

test('the home page must be 200 HTML', async () => {
  let r = await run(app({ server: serverSource({ homeStatus: 404 }) }).dir);
  assert.equal(failedCheck(r).name, 'home');
  assert.match(r.message, /404/);
  r = await run(app({ server: serverSource({ homeType: 'application/json', home: '{}' }) }).dir);
  assert.equal(failedCheck(r).name, 'home');
  assert.match(r.message, /not HTML/i);
});

test('a smoke route returning 500 fails and names the route; a 404 is fine', async () => {
  const bad = app({ server: serverSource({ routes: { '/boom': [500, 'oops'] } }), smoke: ['/', '/boom'] });
  const r = await run(bad.dir);
  assert.equal(r.ok, false);
  assert.equal(failedCheck(r).name, 'smoke');
  assert.match(r.message, /\/boom/);
  assert.match(r.message, /500/);
  const fine = app({ smoke: ['/', '/missing'] });
  assert.equal((await run(fine.dir)).ok, true);
});

test('an app that dies during the settle period fails', async () => {
  const { dir } = app({ server: serverSource({ dieAfterMs: 120 }) });
  const r = await run(dir, { settleMs: 700 });
  assert.equal(r.ok, false);
  assert.equal(failedCheck(r).name, 'alive');
  assert.match(r.message, /stopped/i);
});

// ---------- the recovery link (fifth check) ----------
test('the home page must link to the recovery console at the correct address', async () => {
  const good = [
    `<a href="/_evolv">Recovery console</a>`,
    `<a href="/_evolv/">Recovery console</a>`,
    `<a class="x" href='/_evolv'>Recovery console</a>`,
    `<a href=/_evolv>Recovery console</a>`,
    `<A HREF="/_evolv">Recovery console</A>`,
    `<a href="http://127.0.0.1:${CONSOLE_PORT}/">Recovery console</a>`,
    `<a href="http://localhost:${CONSOLE_PORT}/">Recovery console</a>`,
    `<p>text</p><a href="/other">x</a> ${LINK}`,
  ];
  for (const home of good) {
    const r = await run(app({ server: serverSource({ home }) }).dir);
    assert.equal(r.ok, true, `${home} should pass: ${r.message}`);
  }
  const bad = [
    ['no link at all', '<h1>Hello</h1>'],
    ['the wrong port', `<a href="http://127.0.0.1:${CONSOLE_PORT + 1}/">Recovery console</a>`],
    ['another host', `<a href="http://evil.example:${CONSOLE_PORT}/">Recovery console</a>`],
    ['the wrong path', '<a href="/console">Recovery console</a>'],
    ['a look-alike path', '<a href="/_evolv-old">Recovery console</a>'],
    ['https instead of http', `<a href="https://127.0.0.1:${CONSOLE_PORT}/">Recovery console</a>`],
    ['text only, no href', 'Recovery console at /_evolv'],
    ['inside an HTML comment', '<!-- <a href="/_evolv">Recovery console</a> -->'],
    ['inside a script string', '<script>var s = \'<a href="/_evolv">x</a>\';</script>'],
    ['a different link element', '<link href="/_evolv" rel="x">'],
  ];
  for (const [label, home] of bad) {
    const r = await run(app({ server: serverSource({ home }) }).dir);
    assert.equal(r.ok, false, `${label} should fail`);
    assert.equal(failedCheck(r).name, 'console_link', label);
    assert.match(r.message, /recovery console/i, label);
    assert.match(r.message, /\/_evolv/, label);
  }
});

// ---------- evolv.json and files ----------
test('a broken evolv.json or missing entry point fails before anything is started', async () => {
  const cases = [
    ['evolv.json missing', { rawEvolv: null }],
    ['not JSON', { rawEvolv: '{ nope' }],
    ['smoke is not a list', { rawEvolv: '{"smoke":"/"}' }],
    ['no smoke key', { rawEvolv: '{}' }],
    ['a route that is not text', { rawEvolv: '{"smoke":[5]}' }],
    ['a route without a leading slash', { smoke: ['notes'] }],
    ['a protocol-relative route', { smoke: ['//evil.example/x'] }],
    ['an absolute URL', { smoke: ['http://evil.example/x'] }],
    ['a route with a space', { smoke: ['/a b'] }],
    ['a route with a backslash', { smoke: ['/a\\b'] }],
    ['an empty route', { smoke: [''] }],
    ['too many routes', { smoke: Array.from({ length: 51 }, (_, i) => `/r${i}`) }],
    ['a very long route', { smoke: ['/' + 'a'.repeat(300)] }],
    ['server.js missing', { server: null }],
  ];
  for (const [label, opts] of cases) {
    let spawned = false;
    const r = await run(app(opts).dir, { onSpawn: () => (spawned = true) });
    assert.equal(r.ok, false, label);
    assert.equal(failedCheck(r).name, 'files', label);
    assert.equal(spawned, false, `${label}: nothing may be started for an invalid app`);
  }
});

test('a smoke route can never make the verifier call another host', async () => {
  let hits = 0;
  const canary = http.createServer((req, res) => {
    hits++;
    res.end('hit');
  });
  await new Promise((r) => canary.listen(0, '127.0.0.1', r));
  cleanups.push(() => canary.close());
  const port = canary.address().port;
  for (const route of [`//127.0.0.1:${port}/x`, `http://127.0.0.1:${port}/x`, `/\\127.0.0.1:${port}/x`]) {
    await run(app({ smoke: ['/', route] }).dir);
  }
  assert.equal(hits, 0);
});

// ---------- data, sandbox, processes ----------
test('verification uses a fresh, empty data/ (never anyone\'s real data)', async () => {
  const top = "import fs from 'node:fs'; import path from 'node:path'; fs.writeFileSync(path.join(process.env.DATA_DIR, 'seen.json'), JSON.stringify(fs.readdirSync(process.env.DATA_DIR)));";
  const { dir } = app({ server: serverSource({ top }) });
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'stale.txt'), 'left over');
  const r = await run(dir);
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'seen.json'), 'utf8')), []);
});

test('the staged app runs in the same sandbox: attacks fail, no key, no side effects', async () => {
  const top = `
import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node:child_process';
const here = import.meta.dirname; const report = {};
const tryIt = (name, fn) => { try { fn(); report[name] = 'SUCCEEDED'; } catch (e) { report[name] = e.code ?? String(e); } };
tryIt('write outside', () => fs.writeFileSync(path.join(here, '..', 'pwned.txt'), 'x'));
tryIt('read outside', () => fs.readFileSync(path.join(here, '..', 'canary.txt'), 'utf8'));
tryIt('spawn', () => { const c = spawn(process.execPath, ['-v']); c.on('error', () => {}); });
report.env = Object.keys(process.env).filter((k) => process.env[k] !== '').sort();
report.key = process.env.AI_API_KEY ?? null;
fs.writeFileSync(path.join(process.env.DATA_DIR, 'report.json'), JSON.stringify(report));`;
  const { dir, parent } = app({ server: serverSource({ top }) });
  fs.writeFileSync(path.join(parent, 'canary.txt'), 'CANARY');
  process.env.AI_API_KEY = 'sk-should-not-reach-the-staged-app';
  let r;
  try {
    r = await run(dir);
  } finally {
    delete process.env.AI_API_KEY;
  }
  assert.equal(r.ok, true, r.message);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'report.json'), 'utf8'));
  assert.equal(report['write outside'], 'ERR_ACCESS_DENIED');
  assert.equal(report['read outside'], 'ERR_ACCESS_DENIED');
  assert.equal(report.spawn, 'ERR_ACCESS_DENIED');
  assert.equal(report.key, null);
  assert.deepEqual(report.env.filter((k) => !['DATA_DIR', 'NODE_ENV', 'PORT', 'SYSTEMROOT'].includes(k)), []);
  assert.equal(fs.existsSync(path.join(parent, 'pwned.txt')), false);
});

test('the staged app gets a spare loopback port, and the port is free again afterwards', async () => {
  const { dir } = app();
  let spawned;
  const r = await run(dir, { onSpawn: (s) => (spawned = s) });
  assert.equal(r.ok, true);
  assert.ok(Number.isInteger(spawned.port) && spawned.port > 1024);
  await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(spawned.port, '127.0.0.1', () => s.close(resolve));
  });
});

test('no process is left behind: after a pass, a failure, or a timeout', async () => {
  const pids = [];
  const onSpawn = (s) => pids.push(s.pid);
  await run(app().dir, { onSpawn });
  await run(app({ server: serverSource({ healthStatus: 500 }) }).dir, { onSpawn });
  await run(app({ server: 'setInterval(() => {}, 1000);\n' }).dir, { onSpawn, timeoutMs: 500 });
  assert.equal(pids.length, 3);
  await sleep(100);
  for (const pid of pids) assert.equal(alive(pid), false, `pid ${pid} is still running`);
});

test('cancelling mid-verification kills the staged app and stops at once', async () => {
  const { dir } = app({ server: serverSource({ listenDelayMs: 6000 }) });
  const ctl = new AbortController();
  let pid;
  const t0 = Date.now();
  const p = run(dir, { signal: ctl.signal, timeoutMs: 10000, onSpawn: (s) => ((pid = s.pid), setTimeout(() => ctl.abort(), 150)) });
  await assert.rejects(p, (e) => e.code === 'cancelled');
  assert.ok(Date.now() - t0 < 3000, 'cancel must not wait for the timeout');
  await sleep(100);
  assert.equal(alive(pid), false);
});

test('an already-cancelled signal starts nothing', async () => {
  const ctl = new AbortController();
  ctl.abort();
  let spawned = false;
  await assert.rejects(run(app().dir, { signal: ctl.signal, onSpawn: () => (spawned = true) }), (e) => e.code === 'cancelled');
  assert.equal(spawned, false);
});

// ---------- the output shown to the user ----------
test('failure output is cleaned: no colour codes, no real paths, no Node warnings, capped', async () => {
  const top = "console.error('\\x1b[31mred boom\\x1b[0m at ' + process.cwd()); console.log('x'.repeat(100000)); process.exit(1);";
  const { dir } = app({ server: top + '\n' });
  const r = await run(dir);
  assert.equal(r.ok, false);
  assert.ok(r.output.includes('red boom'));
  assert.ok(!r.output.includes('\x1b'), 'ANSI codes must be stripped');
  assert.ok(!r.output.includes(dir) && !r.output.includes(path.dirname(dir)), 'real paths must be hidden');
  assert.match(r.output, /<app>/);
  assert.ok(!/ExperimentalWarning|--trace-warnings/.test(r.output));
  assert.ok(r.output.length <= 4200, `output was ${r.output.length} characters`);
});
