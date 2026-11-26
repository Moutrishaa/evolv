// B3 end to end: a real supervisor, a real sandboxed live app, the real proxy and HTTP routes,
// and a fake AI. These tests prove the promise of the whole product: a bad change can never
// take the live app down, and a good one goes live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startEnv, changeScript, AI_KEY } from '../../test-fixtures/helpers/env.js';
import { startPoller, readSse } from '../../test-fixtures/helpers/net.js';
import { serverSource, POISON_SERVER, SEED_SERVER, CRASH_ON_START, SYNTAX_ERROR, NEVER_LISTENS } from '../../test-fixtures/apps/apps.js';
import { reply, toolUse } from '../../test-fixtures/fakes/fake-provider.js';
import { request, sleep, waitFor, gitOut, ROOT } from '../../test-fixtures/helpers/helpers.js';

const NAVY_CSS = fs.readFileSync(path.join(ROOT, 'seed', 'public', 'style.css'), 'utf8').replace('#6366f1', '#000080');

/** Runs one change while hammering the live home page, then reports what the live app did. */
async function changeWhilePolling(env, requestText) {
  const pid = env.sup.app.status().pid;
  const spawns = env.sup.app.status().spawns;
  const before = (await request(`${env.base}/`)).body;
  const poller = startPoller(`${env.base}/`, { intervalMs: 15 });
  const run = await env.runChange(requestText);
  await sleep(150);
  const polled = await poller.stop();
  return { ...run, polled, pid, spawns, before };
}

function assertLiveNeverBlinked(r, env) {
  assert.ok(r.polled.total >= 20, `the poller only made ${r.polled.total} requests, so it proves little`);
  assert.deepEqual(r.polled.failures, [], 'a request to the live app failed during the change');
  assert.ok(r.polled.results.every((x) => x.body === r.before), 'the live app must keep serving the OLD version');
  assert.equal(env.sup.app.status().pid, r.pid, 'the live app must not have been restarted');
  assert.equal(env.sup.app.status().spawns, r.spawns);
  assert.equal(env.sup.app.status().state, 'running');
}

test('a change goes live end to end over HTTP and SSE, and the proxy serves the new version', async () => {
  const env = await startEnv({ script: changeScript({ 'public/style.css': NAVY_CSS }, 'Made the page background navy.') });
  try {
    const { id, events, last } = await env.runChange('Change the background to dark navy');
    assert.equal(last.type, 'done', JSON.stringify(last));
    assert.equal(last.data.version, 2);
    assert.equal(last.data.summary, 'Made the page background navy.');
    assert.deepEqual(last.data.files, ['public/style.css']);
    assert.ok(last.data.tokens > 0);
    const types = events.map((e) => e.type);
    assert.deepEqual(types.slice(0, 2), ['accepted', 'staged']);
    for (const t of ['step', 'tool', 'verify', 'promoting', 'done']) assert.ok(types.includes(t), `missing ${t} event`);
    assert.ok(events.map((e) => e.id).every((n, i, a) => i === 0 || n > a[i - 1]), 'ids increase');

    assert.match((await request(`${env.base}/style.css`)).body, /#000080/);
    const status = await env.status();
    assert.equal(status.version.current, 2);
    assert.ok(status.budget.used > 0);
    assert.equal(status.notice, null);
    assert.equal(env.workspaces().length, 0);
    assert.equal((await gitOut(env.appDir, ['status', '--porcelain'])).trim(), '');
    const json = JSON.stringify(events) + JSON.stringify(status);
    assert.ok(!json.includes(AI_KEY) && !json.includes(env.root), 'no key and no real paths anywhere');
    void id;
  } finally {
    await env.close();
  }
});

// ---------- the headline: a bad change never takes the live app down ----------
for (const [label, files, summary, expectCheck, expectText] of [
  ['crashes on start (throws)', { 'server.js': CRASH_ON_START }, 'Rewrote the server.', 'start', /boom: this app cannot start/],
  ['has a syntax error', { 'server.js': SYNTAX_ERROR }, 'Rewrote the server.', 'start', /SyntaxError/],
  ['never starts listening', { 'server.js': NEVER_LISTENS }, 'Rewrote the server.', 'start', /did not answer/],
  ['answers /health with 500', { 'server.js': serverSource({ healthStatus: 500 }) }, 'Changed health.', 'start', /500/],
  ['breaks a smoke route', { 'server.js': serverSource({ routes: { '/notes': [500, 'broken'] } }), 'evolv.json': '{"smoke":["/","/notes"]}' }, 'Added notes.', 'smoke', /\/notes/],
  ['removes the recovery link', { 'public/index.html': '<!doctype html><h1>Hello</h1>' }, 'Simplified the page.', 'console_link', /recovery console/i],
  ['points the recovery link at the wrong place', { 'public/index.html': '<!doctype html><a href="/console">Recovery console</a>' }, 'Moved the link.', 'console_link', /\/_evolv/],
  ['breaks evolv.json', { 'evolv.json': '{ not json' }, 'Edited evolv.json.', 'files', /evolv\.json/],
]) {
  test(`HEADLINE: a change that ${label} fails verification and the live app keeps serving the old version with zero downtime`, async () => {
    const env = await startEnv({ script: changeScript(files, summary) });
    try {
      const r = await changeWhilePolling(env, 'Please make this change');
      assert.equal(r.last.type, 'failed', JSON.stringify(r.last));
      assert.equal(r.last.data.code, 'verify_failed');
      assert.match(r.last.data.message, /did not pass the automatic checks/i);
      assert.match(r.last.data.message, /your app was not changed/i);
      assert.equal(r.last.data.checks.find((c) => !c.ok).name, expectCheck);
      assert.match(r.last.data.message + (r.last.data.output ?? ''), expectText);
      assert.ok(!JSON.stringify(r.last).includes(env.root), 'no real paths in what the browser receives');

      assertLiveNeverBlinked(r, env);
      assert.equal((await env.versions()).length, 1, 'nothing was added to History');
      assert.equal((await gitOut(env.appDir, ['status', '--porcelain'])).trim(), '');
      assert.deepEqual(env.workspaces(), [], 'the workspace was discarded');
      assert.equal((await env.status()).notice, null, 'a normal failure is not a rollback');

      // And the system is immediately usable again.
      env.fake.setScript((b, n) => changeScript({ 'public/style.css': NAVY_CSS }, 'Recovered.')[0]);
      const next = await env.runChange('Now a good one');
      assert.equal(next.last.type, 'done', JSON.stringify(next.last));
      assert.equal(next.last.data.version, 2);
    } finally {
      await env.close();
    }
  });
}

// ---------- the other headline: the post-swap health check fails and the rollback works ----------
test('HEADLINE: a version that passes verification but will not start on the live data is rolled back automatically', async () => {
  const env = await startEnv({ script: changeScript({ 'server.js': POISON_SERVER }, 'Added a data check.') });
  try {
    // The live data/ has something the new code cannot handle. Verification uses an EMPTY data/, so it passes.
    fs.writeFileSync(path.join(env.appDir, 'data', 'poison.txt'), 'live data');
    fs.writeFileSync(path.join(env.appDir, 'data', 'keep.txt'), 'user data');
    const headBefore = (await gitOut(env.appDir, ['rev-parse', 'HEAD'])).trim();
    const seedServer = fs.readFileSync(path.join(env.appDir, 'server.js'), 'utf8');
    const poller = startPoller(`${env.base}/`, { intervalMs: 20 });

    const { last, events } = await env.runChange('Add a check on startup');
    assert.deepEqual(events.filter((e) => e.type === 'verify' && e.data.status === 'failed'), [], 'verification itself must have passed');
    assert.ok(events.some((e) => e.type === 'promoting'));
    assert.equal(last.type, 'failed');
    assert.equal(last.data.code, 'swap_failed');
    assert.match(last.data.message, /previous version/i);
    assert.match(last.data.message, /nothing was lost/i);
    assert.ok(!/Error:|ENOENT|exit code|\bat \w+\.\w+ \(/.test(last.data.message), 'plain words only');

    await waitFor(async () => (await request(`${env.base}/health`)).status === 200, { timeout: 15000, what: 'old version serving again' });
    await sleep(100);
    const polled = await poller.stop();
    assert.equal(polled.results.at(-1).ok, true, 'the live app is serving again');

    // Exactly the old version, back.
    assert.equal((await gitOut(env.appDir, ['rev-parse', 'HEAD'])).trim(), headBefore);
    assert.equal(fs.readFileSync(path.join(env.appDir, 'server.js'), 'utf8'), seedServer);
    assert.equal((await env.versions()).length, 1, 'the failed version is not in History');
    assert.equal((await gitOut(env.appDir, ['status', '--porcelain'])).trim(), '');
    assert.equal(env.sup.app.status().state, 'running');
    assert.equal(fs.readFileSync(path.join(env.appDir, 'data', 'keep.txt'), 'utf8'), 'user data');
    assert.ok(fs.existsSync(path.join(env.appDir, 'data', 'poison.txt')));
    assert.deepEqual(env.workspaces(), []);

    // The console tells the user, in plain words, on Status and in Logs.
    const status = await env.status();
    assert.equal(status.notice.kind, 'rolled_back');
    assert.match(status.notice.message, /previous version/i);
    assert.match(status.notice.message, /nothing was lost/i);
    const logs = JSON.parse((await request(`${env.cbase}/api/logs`, { headers: env.auth })).body).lines.map((l) => l.text).join('\n');
    assert.match(logs, /rolled back|put your previous version back/i);

    // The lock is free; the notice stays until a change succeeds.
    env.fake.setScript(() => changeScript({ 'public/style.css': NAVY_CSS }, 'A good change.')[0]);
    const next = await env.runChange('A good one');
    assert.equal(next.last.type, 'done', JSON.stringify(next.last));
    assert.equal((await env.status()).notice, null, 'the next success clears the notice');
  } finally {
    await env.close();
  }
});

test('a change that blanks the page but passes the checks goes live, and the console still works', async () => {
  const blank = '<!doctype html><a href="/_evolv">Recovery console</a>';
  const env = await startEnv({ script: changeScript({ 'public/index.html': blank }, 'Cleared the page.') });
  try {
    const { last } = await env.runChange('Remove everything from the home page');
    assert.equal(last.type, 'done', JSON.stringify(last));
    assert.equal((await request(`${env.base}/`)).body, blank);
    // The way back is intact: the pointer page, the console shell, and the authenticated API.
    assert.ok((await request(`${env.base}/_evolv`)).body.includes(`http://127.0.0.1:${env.consolePort}/`));
    assert.equal((await request(`${env.cbase}/`)).status, 200);
    const status = await env.status();
    assert.equal(status.version.current, 2);
    assert.equal(status.app.state, 'running');
  } finally {
    await env.close();
  }
});

test('changes build on each other: a second change is version 3', async () => {
  const env = await startEnv({ script: changeScript({ 'public/style.css': NAVY_CSS }, 'Navy.') });
  try {
    assert.equal((await env.runChange('first')).last.data.version, 2);
    env.fake.setScript(() => changeScript({ 'public/extra.txt': 'second change' }, 'Added a file.')[0]);
    const second = await env.runChange('second');
    assert.equal(second.last.data.version, 3);
    assert.match((await request(`${env.base}/style.css`)).body, /#000080/, 'the first change is still there');
    assert.equal((await request(`${env.base}/extra.txt`)).body, 'second change');
    assert.deepEqual((await env.versions()).map((v) => v.id), [3, 2, 1]);
  } finally {
    await env.close();
  }
});

// ---------- cancel, end to end ----------
test('cancelling during the agent stops it; the live app never blinks', async () => {
  const env = await startEnv({ script: [reply([toolUse('list_files', {})], { delayMs: 8000 })] });
  try {
    const pid = env.sup.app.status().pid;
    const poller = startPoller(`${env.base}/`, { intervalMs: 20 });
    const res = await env.submit('Take your time');
    const { id } = JSON.parse(res.body);
    await waitFor(() => env.fake.requests.length === 1);
    const cancel = await request(`${env.base}/_evolv/api/changes/${id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: env.base }, body: '{}' });
    assert.equal(cancel.status, 200);
    assert.deepEqual(JSON.parse(cancel.body), { cancelled: true });
    const sse = await readSse(`${env.base}/_evolv/api/changes/${id}/events`, { until: (e) => e.type === 'failed' || e.type === 'done' });
    assert.equal(sse.events.at(-1).data.code, 'cancelled');
    assert.match(sse.events.at(-1).data.message, /cancelled/i);
    assert.match(sse.events.at(-1).data.message, /not changed|unchanged/i);
    const polled = await poller.stop();
    assert.deepEqual(polled.failures, []);
    assert.equal(env.sup.app.status().pid, pid);
    assert.deepEqual(env.workspaces(), []);
    assert.equal((await env.versions()).length, 1);
  } finally {
    await env.close();
  }
});

test('cancelling during verification kills the staged app and leaves the live app alone', async () => {
  const env = await startEnv({ script: changeScript({ 'server.js': NEVER_LISTENS }, 'Rewrote the server.') });
  try {
    const pid = env.sup.app.status().pid;
    const { id } = JSON.parse((await env.submit('Slow to start')).body);
    const url = `${env.base}/_evolv/api/changes/${id}/events`;
    await readSse(url, { until: (e) => e.type === 'verify' && e.data.check === 'start' });
    const t0 = Date.now();
    const cancel = await request(`${env.base}/_evolv/api/changes/${id}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: env.base }, body: '{}' });
    assert.equal(cancel.status, 200);
    const sse = await readSse(url, { until: (e) => e.type === 'failed' });
    assert.equal(sse.events.at(-1).data.code, 'cancelled');
    assert.ok(Date.now() - t0 < 4000, 'must not wait for the verification timeout');
    assert.equal(env.sup.app.status().pid, pid);
    assert.deepEqual(env.workspaces(), []);
  } finally {
    await env.close();
  }
});
