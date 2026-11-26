import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AppProcess, LogBuffer, sampleCpuSeconds } from '../../supervisor/models/app-process.js';
import { makeTempDir, getFreePort, sleep, waitFor } from '../../test-fixtures/helpers/helpers.js';

function makeApp(code) {
  const tmp = makeTempDir('evolv-proc-');
  const appDir = path.join(tmp.dir, 'app');
  const dataDir = path.join(appDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, 'package.json'), '{ "type": "module" }\n');
  fs.writeFileSync(path.join(appDir, 'server.js'), code);
  return { appDir, dataDir, cleanup: tmp.cleanup };
}

const IDLE = `console.log('hello from app'); setInterval(() => {}, 1000);`;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('LogBuffer keeps only the last 500 lines', () => {
  const buf = new LogBuffer(500);
  for (let i = 0; i < 700; i++) buf.push(`line ${i}`);
  const lines = buf.lines();
  assert.equal(lines.length, 500);
  assert.equal(lines[0].text, 'line 200');
  assert.equal(lines.at(-1).text, 'line 699');
});

test('start, capture logs, stop kills the process, start again works', async () => {
  const app = makeApp(IDLE);
  const proc = new AppProcess({ appDir: app.appDir, dataDir: app.dataDir, port: await getFreePort() });
  try {
    proc.start();
    await waitFor(() => proc.status().state === 'running', { what: 'running' });
    const pid1 = proc.status().pid;
    await waitFor(() => proc.logs.lines().some((l) => l.text.includes('hello from app')), { what: 'log line' });

    await proc.stop();
    assert.equal(proc.status().state, 'stopped');
    assert.equal(alive(pid1), false, 'process must really be dead after stop()');

    proc.start();
    await waitFor(() => proc.status().state === 'running', { what: 'running again' });
    assert.notEqual(proc.status().pid, pid1);
  } finally {
    await proc.stop();
    app.cleanup();
  }
});

test('an externally killed app is restarted with a new pid', async () => {
  const app = makeApp(IDLE);
  const proc = new AppProcess({
    appDir: app.appDir,
    dataDir: app.dataDir,
    port: await getFreePort(),
    backoffMs: [20, 20, 20],
  });
  try {
    proc.start();
    await waitFor(() => proc.status().state === 'running');
    const pid1 = proc.status().pid;
    process.kill(pid1); // simulate a crash
    await waitFor(() => proc.status().state === 'running' && proc.status().pid !== pid1, { what: 'restart' });
    assert.ok(proc.status().restarts >= 1);
  } finally {
    await proc.stop();
    app.cleanup();
  }
});

test('after 3 crashes within 60 seconds it gives up and stays down', async () => {
  const app = makeApp(`process.exit(1);`);
  const proc = new AppProcess({
    appDir: app.appDir,
    dataDir: app.dataDir,
    port: await getFreePort(),
    backoffMs: [10, 10, 10],
    maxCrashes: 3,
    crashWindowMs: 60000,
  });
  try {
    proc.start();
    await waitFor(() => proc.status().state === 'failed', { what: 'failed state' });
    assert.equal(proc.status().spawns, 3);
    await sleep(300);
    assert.equal(proc.status().spawns, 3, 'must not keep restarting');
    assert.equal(proc.status().state, 'failed');
  } finally {
    await proc.stop();
    app.cleanup();
  }
});

test('CPU watchdog restarts an app that stays pinned', async () => {
  const app = makeApp(IDLE);
  const t0 = Date.now();
  const proc = new AppProcess({
    appDir: app.appDir,
    dataDir: app.dataDir,
    port: await getFreePort(),
    backoffMs: [10],
    maxCrashes: 99,
    cpuSampleMs: 50,
    cpuPinnedMs: 300,
    // Fake sampler: CPU seconds grow as fast as wall clock = pinned at 100%.
    sampleCpu: async () => (Date.now() - t0) / 1000,
  });
  try {
    proc.start();
    await waitFor(() => proc.status().spawns >= 2, { timeout: 5000, what: 'watchdog restart' });
    assert.ok(proc.logs.lines().some((l) => /watchdog/i.test(l.text)));
  } finally {
    await proc.stop();
    app.cleanup();
  }
});

test('CPU watchdog leaves an idle app alone', async () => {
  const app = makeApp(IDLE);
  const proc = new AppProcess({
    appDir: app.appDir,
    dataDir: app.dataDir,
    port: await getFreePort(),
    cpuSampleMs: 50,
    cpuPinnedMs: 300,
    sampleCpu: async () => 0.01, // no CPU growth
  });
  try {
    proc.start();
    await waitFor(() => proc.status().state === 'running');
    await sleep(900);
    assert.equal(proc.status().spawns, 1);
  } finally {
    await proc.stop();
    app.cleanup();
  }
});

test('sampleCpuSeconds reads real CPU time for a real pid', async (t) => {
  const v = await sampleCpuSeconds(process.pid);
  if (v === null) return t.skip('CPU sampling not supported on this platform');
  assert.ok(Number.isFinite(v) && v > 0);
});
