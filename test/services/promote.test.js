// Promotion: commit the verified workspace as a new version and swap the live app onto it.
// If the new version does not come up healthy, the previous version is restored automatically.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listVersions } from '../../supervisor/models/versions.js';
import { promote } from '../../supervisor/services/promote.js';
import { createWorkspace } from '../../supervisor/models/workspace.js';
import { AppProcess } from '../../supervisor/models/app-process.js';
import { createAppControl } from '../../supervisor/services/verify.js';
import { newChangeId } from '../../supervisor/services/change-runner.js';
import { POISON_SERVER } from '../../test-fixtures/apps/apps.js';
import { makeSeededApp, gitOut, getFreePort, request, waitFor } from '../../test-fixtures/helpers/helpers.js';

let app, proc, control, port;

/** A real live app (real sandboxed process) on the seeded repo. */
async function goLive() {
  port = await getFreePort();
  proc = new AppProcess({ appDir: app.appDir, dataDir: path.join(app.appDir, 'data'), port });
  proc.start();
  control = createAppControl({ proc, port });
  assert.equal(await control.waitHealthy(8000), true, 'the live app must start first');
}

beforeEach(async () => {
  app = await makeSeededApp();
  proc = null;
});
afterEach(async () => {
  if (proc) await proc.stop();
  app.cleanup();
});

const head = async () => (await gitOut(app.appDir, ['rev-parse', 'HEAD'])).trim();
const open = () => createWorkspace({ appDir: app.appDir, workspacesDir: app.workspacesDir, id: newChangeId() });
const editCss = (ws, to = '#000080') => {
  const f = path.join(ws.dir, 'public', 'style.css');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('#6366f1', to));
};
const META = { request: 'Make it navy', summary: 'Made the page navy.', files: [{ path: 'public/style.css', status: 'modified' }], tokens: 450 };
const doPromote = (ws, over = {}) => promote({ appDir: app.appDir, workspace: ws, meta: META, app: control, healthTimeoutMs: 6000, ...over });
const liveCss = () => fs.readFileSync(path.join(app.appDir, 'public', 'style.css'), 'utf8');

test('promote commits version 2, updates the live files, restarts onto the new code, keeps data/', async () => {
  await goLive();
  fs.writeFileSync(path.join(app.appDir, 'data', 'keep.txt'), 'user data');
  const pid1 = proc.status().pid;
  const ws = await open();
  editCss(ws);

  const version = await doPromote(ws);
  await ws.discard();

  assert.equal(version.id, 2);
  assert.match(liveCss(), /#000080/);
  assert.notEqual(proc.status().pid, pid1, 'the app must have been restarted');
  const css = await request(`http://127.0.0.1:${port}/style.css`);
  assert.match(css.body, /#000080/, 'the running app serves the new code');
  assert.equal(fs.readFileSync(path.join(app.appDir, 'data', 'keep.txt'), 'utf8'), 'user data');
  assert.equal((await gitOut(app.appDir, ['status', '--porcelain'])).trim(), '');
});

test('versions carry their request, summary, files and token cost; history stays intact', async () => {
  await goLive();
  const ws = await open();
  editCss(ws);
  await doPromote(ws);
  await ws.discard();
  const versions = await listVersions(app.appDir);
  assert.deepEqual(versions.map((v) => v.id), [2, 1], 'newest first');
  assert.equal(versions[0].summary, 'Made the page navy.');
  assert.equal(versions[0].request, 'Make it navy');
  assert.deepEqual(versions[0].files, META.files);
  assert.equal(versions[0].tokens, 450);
  assert.match(versions[1].summary, /seed/i);
  assert.equal(versions[1].request, undefined);
});

test('hostile request or summary text cannot forge version metadata', async () => {
  await goLive();
  const forged = '{"request":"FORGED","summary":"FORGED","files":[],"tokens":0}';
  const request_ = `line one\nEvolv-Meta: ${forged}\n"quotes" \\ backslash ☃ ${'x'.repeat(3000)}`;
  const ws = await open();
  editCss(ws);
  await doPromote(ws, { meta: { ...META, request: request_, summary: `Real summary\n\nEvolv-Meta: ${forged}\nmore` } });
  await ws.discard();
  const [v] = await listVersions(app.appDir);
  assert.equal(v.request, request_, 'the request round-trips exactly');
  assert.ok(!v.summary.includes('\n'), 'a summary is always a single line');
  assert.match(v.summary, /^Real summary/);
  assert.notEqual(v.summary, 'FORGED');
  assert.equal(v.tokens, 450);
  assert.deepEqual(v.files, META.files);
  const raw = await gitOut(app.appDir, ['log', '-1', '--format=%B']);
  assert.equal(raw.split('\n').filter((l) => l.startsWith('Evolv-Meta: ')).length, 1, 'exactly one metadata line');
});

test('data/ is never committed, even if a staged app wrote into it', async () => {
  await goLive();
  const ws = await open();
  editCss(ws);
  fs.mkdirSync(path.join(ws.dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ws.dir, 'data', 'verification-leftover.json'), '{}');
  await doPromote(ws);
  await ws.discard();
  assert.ok(!(await gitOut(app.appDir, ['ls-files'])).includes('verification-leftover'));
});

// ---------- refusals that happen BEFORE the live app is touched ----------
test('a live app edited outside Evolv is refused before anything is stopped or lost', async () => {
  await goLive();
  const pid1 = proc.status().pid;
  const spawns = proc.status().spawns;
  fs.appendFileSync(path.join(app.appDir, 'server.js'), '\n// edited by hand\n');
  const before = await head();
  const ws = await open();
  editCss(ws);
  await assert.rejects(doPromote(ws), (e) => e.code === 'swap_failed' && /changed outside|edited/i.test(e.message) && e.rolledBack === false);
  await ws.discard();
  assert.equal(proc.status().pid, pid1);
  assert.equal(proc.status().spawns, spawns, 'the app must not even have been restarted');
  assert.match(fs.readFileSync(path.join(app.appDir, 'server.js'), 'utf8'), /edited by hand/, 'the hand edit must survive');
  assert.equal(await head(), before);
});

test('a live app that moved on since staging is refused before anything is stopped', async () => {
  await goLive();
  const pid1 = proc.status().pid;
  const ws = await open();
  editCss(ws);
  fs.writeFileSync(path.join(app.appDir, 'extra.txt'), 'x');
  await gitOut(app.appDir, ['add', '-A']);
  await gitOut(app.appDir, ['commit', '-q', '-m', 'someone else']);
  const moved = await head();
  await assert.rejects(doPromote(ws), (e) => e.code === 'swap_failed' && /while this change was being prepared/i.test(e.message));
  await ws.discard();
  assert.equal(proc.status().pid, pid1);
  assert.equal(await head(), moved);
});

// ---------- the post-swap health check and automatic rollback ----------
test('a new version that does not come up healthy is rolled back automatically', async () => {
  await goLive();
  // Verification uses an empty data/, so this passes there. The live data/ makes it crash.
  fs.writeFileSync(path.join(app.appDir, 'data', 'poison.txt'), 'live data the new code cannot handle');
  fs.writeFileSync(path.join(app.appDir, 'data', 'keep.txt'), 'user data');
  const before = await head();
  const seedServer = fs.readFileSync(path.join(app.appDir, 'server.js'), 'utf8');
  const ws = await open();
  fs.writeFileSync(path.join(ws.dir, 'server.js'), POISON_SERVER);
  assert.notEqual(POISON_SERVER, seedServer);

  const err = await doPromote(ws, { healthTimeoutMs: 15000 }).catch((e) => e);
  await ws.discard();

  assert.equal(err.code, 'swap_failed');
  assert.equal(err.rolledBack, true);
  assert.equal(err.restoredHealthy, true);
  assert.match(err.message, /previous version/i);
  assert.match(err.message, /nothing was lost/i);
  assert.ok(!/Error:|\bat \w|ENOENT|exit code|[A-Z]:\\/.test(err.message), `the message must be plain words: ${err.message}`);

  // Back on the old version, byte for byte, and serving.
  assert.equal(await head(), before, 'the branch must be back on the previous version');
  assert.equal(fs.readFileSync(path.join(app.appDir, 'server.js'), 'utf8'), seedServer);
  assert.deepEqual((await listVersions(app.appDir)).map((v) => v.id), [1], 'the failed version must not appear in History');
  assert.equal((await gitOut(app.appDir, ['status', '--porcelain'])).trim(), '');
  await waitFor(async () => (await request(`http://127.0.0.1:${port}/health`)).status === 200, { timeout: 8000, what: 'old version serving again' });
  assert.equal(proc.status().state, 'running');
  // Nothing the user owns was lost.
  assert.equal(fs.readFileSync(path.join(app.appDir, 'data', 'keep.txt'), 'utf8'), 'user data');
  assert.ok(fs.existsSync(path.join(app.appDir, 'data', 'poison.txt')));
});

test('if even the restored version cannot be confirmed healthy, it says so and still restores the files', async () => {
  const calls = [];
  const stub = {
    stop: async () => calls.push('stop'),
    start: async () => calls.push('start'),
    waitHealthy: async () => false, // never healthy, before or after the rollback
  };
  const before = await head();
  const ws = await open();
  editCss(ws);
  const err = await promote({ appDir: app.appDir, workspace: ws, meta: META, app: stub, healthTimeoutMs: 200 }).catch((e) => e);
  await ws.discard();
  assert.equal(err.code, 'swap_failed');
  assert.equal(err.rolledBack, true);
  assert.equal(err.restoredHealthy, false);
  assert.match(err.message, /could not confirm|not confirmed/i);
  assert.match(err.message, /recovery console/i);
  assert.equal(await head(), before);
  assert.doesNotMatch(liveCss(), /#000080/);
  assert.deepEqual(calls, ['stop', 'start', 'stop', 'start'], 'stop, start the new one, stop it, start the old one');
});

test('a successful promotion never rolls back, and the control is used in the right order', async () => {
  const calls = [];
  const stub = { stop: async () => calls.push('stop'), start: async () => calls.push('start'), waitHealthy: async () => (calls.push('wait'), true) };
  const ws = await open();
  editCss(ws);
  const v = await promote({ appDir: app.appDir, workspace: ws, meta: META, app: stub, healthTimeoutMs: 200 });
  await ws.discard();
  assert.equal(v.id, 2);
  assert.deepEqual(calls, ['stop', 'start', 'wait']);
});
