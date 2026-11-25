// Shared helpers for the tests. Not a test file itself.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureSeeded } from '../supervisor/versions.js';

export const ROOT = path.resolve(import.meta.dirname, '..');

export async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** A free console port that does not collide with PORT or PORT+1 (the default app port). */
export async function getConsolePortFor(port) {
  for (;;) {
    const p = await getFreePort();
    if (p !== port && p !== port + 1) return p;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeout = 10000, interval = 50, what = 'condition' } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

/** Plain http GET/POST that lets tests set any header (Host, Origin, Cookie). */
export function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** A scratch directory that is removed afterwards. */
export function makeTempDir(prefix = 'evolv-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/**
 * Builds a fake project root for sandbox tests:
 *   <root>/.env                   canary secret
 *   <root>/supervisor/secret.js   canary
 *   <root>/app/server.js          the hostile app
 *   <root>/app/data/
 */
export function makeSandboxFixture() {
  const tmp = makeTempDir('evolv-sandbox-');
  const appDir = path.join(tmp.dir, 'app');
  const dataDir = path.join(appDir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(tmp.dir, 'supervisor'));
  fs.writeFileSync(path.join(tmp.dir, '.env'), 'AI_API_KEY=sk-canary-do-not-leak\n');
  fs.writeFileSync(path.join(tmp.dir, 'supervisor', 'secret.js'), '// canary\n');
  fs.copyFileSync(path.join(ROOT, 'test-fixtures', 'hostile-app', 'server.js'), path.join(appDir, 'server.js'));
  fs.writeFileSync(path.join(appDir, 'package.json'), '{ "type": "module" }\n');
  return { root: tmp.dir, appDir, dataDir, cleanup: tmp.cleanup };
}

const execFileP = promisify(execFile);

/** Runs git with execFile (never a shell) and returns stdout. */
export async function gitOut(cwd, args) {
  const { stdout } = await execFileP('git', args, { cwd, windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

/** A real seeded app repo (version 1) plus state/ and state/workspaces/ in a temp root. */
export async function makeSeededApp() {
  const tmp = makeTempDir('evolv-app-');
  const appDir = path.join(tmp.dir, 'app');
  await ensureSeeded({ seedDir: path.join(ROOT, 'seed'), appDir });
  const stateDir = path.join(tmp.dir, 'state');
  const workspacesDir = path.join(stateDir, 'workspaces');
  fs.mkdirSync(workspacesDir, { recursive: true });
  return { root: tmp.dir, appDir, stateDir, workspacesDir, cleanup: tmp.cleanup };
}
