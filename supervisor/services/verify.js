// The verifier (PRD section 5, step 4). It starts the staged app in the SAME sandbox as the live
// app, on a spare loopback port, with a fresh empty data/, and decides whether the change may go
// live. It passes only if ALL of these hold:
//   files         server.js exists; evolv.json is valid with a safe smoke list
//   start         GET /health returns 200 within VERIFY_TIMEOUT_MS
//   home          GET / returns 200 and HTML
//   console_link  the home page links to the recovery console at the correct address
//   smoke         every route in evolv.json returns below 500
//   alive         the process is still running, and still healthy, after a settle period
// Nothing here touches the live app.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawnSandboxed } from '../models/app-process.js';
import { MAX_ROUTES, MAX_ROUTE_CHARS, OUTPUT_CAP, HOME_BODY_CAP } from '../constants/limits.js';
import { SAFE_ROUTE } from '../constants/patterns.js';
import { CHECK_LABELS } from '../constants/messages.js';
export { CHECK_LABELS };

const execFileP = promisify(execFile);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));



class CheckFailed extends Error {}
const cancelledError = () => Object.assign(new Error('The change was cancelled.'), { code: 'cancelled' });

/** A free port on the loopback interface. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (srv.address());
      srv.close(() => resolve(port));
    });
  });
}

/**
 * GET from the staged or live app. The path is always a validated route, never a URL.
 * @param {number} port @param {string} urlPath @param {{ timeoutMs: number, signal?: AbortSignal, bodyCap?: number }} o
 * @returns {Promise<{ status: number, contentType: string, body: string }>}
 */
function httpGet(port, urlPath, { timeoutMs, signal, bodyCap = 0 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', agent: false, signal, timeout: timeoutMs, headers: { Accept: 'text/html,*/*', Connection: 'close' } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        if (size < bodyCap) {
          chunks.push(c);
          size += c.length;
        }
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/** Polls /health until it returns 200, the timeout passes, or `isDead()` says give up. */
export async function waitForHealth({ port, timeoutMs, isDead = () => false, intervalMs = 100 }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isDead()) return false;
    try {
      if ((await httpGet(port, '/health', { timeoutMs: 1000 })).status === 200) return true;
    } catch {
      /* not up yet */
    }
    await sleep(intervalMs);
  }
  return false;
}

/**
 * The supervisor's handle on the LIVE app, for promotion.
 * @param {{ proc: { start: Function, stop: Function, status: () => { state: string } }, port: number }} o
 */
export function createAppControl({ proc, port }) {
  return {
    stop: () => proc.stop(),
    start: () => proc.start(),
    waitHealthy: (/** @type {number} */ timeoutMs) => waitForHealth({ port, timeoutMs, isDead: () => proc.status().state === 'failed' }),
  };
}

/** @param {string} html @returns {string[]} the href of every real <a> element */
export function extractLinks(html) {
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, '');
  const hrefs = [];
  const re = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
  for (const m of stripped.matchAll(re)) hrefs.push((m[1] ?? m[2] ?? m[3] ?? '').trim());
  return hrefs;
}

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Strips colour codes, control characters, Node warnings and real paths; caps the length. */
export function cleanOutput(raw, dir) {
  let s = raw
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-Z\\-_]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n/g, '\n');
  s = s
    .split('\n')
    .filter((l) => !/ExperimentalWarning|--trace-warnings/.test(l))
    .join('\n');
  const flags = process.platform === 'win32' ? 'gi' : 'g';
  const forms = (p) => [p, p.replace(/\\/g, '/')];
  for (const [p, label] of [[dir, '<app>'], [path.dirname(dir), '<state>']]) {
    for (const f of forms(p).sort((a, b) => b.length - a.length)) s = s.replace(new RegExp(escapeRe(f), flags), label);
  }
  s = s.trim();
  if (s.length > OUTPUT_CAP) s = `${s.slice(0, 1000)}\n[... output shortened ...]\n${s.slice(-(OUTPUT_CAP - 1100))}`;
  return s;
}

/** @param {string} dir @returns {string[]} the smoke routes, or throws CheckFailed with a plain message */
function readFilesCheck(dir) {
  if (!fs.existsSync(path.join(dir, 'server.js'))) throw new CheckFailed('server.js is missing. Every app needs an entry point called server.js.');
  const file = path.join(dir, 'evolv.json');
  if (!fs.existsSync(file)) throw new CheckFailed('evolv.json is missing. It must list the routes to check, like {"smoke": ["/"]}.');
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new CheckFailed('evolv.json is not valid JSON.');
  }
  const bad = 'evolv.json "smoke" must be a list of routes that each start with a single "/", like ["/", "/notes"].';
  const smoke = data?.smoke;
  if (!Array.isArray(smoke)) throw new CheckFailed(bad);
  if (smoke.length > MAX_ROUTES) throw new CheckFailed(`evolv.json lists too many routes (the limit is ${MAX_ROUTES}).`);
  for (const r of smoke) {
    if (typeof r !== 'string' || r.length > MAX_ROUTE_CHARS || !SAFE_ROUTE.test(r)) throw new CheckFailed(bad);
  }
  return smoke;
}

/**
 * @param {{
 *   dir: string, timeoutMs: number, settleMs?: number, consolePort?: number,
 *   signal?: AbortSignal,
 *   onSpawn?: (s: { pid: number, port: number }) => void,
 *   onCheck?: (c: { check: string, label: string, status: 'running'|'passed'|'failed', detail?: string }) => void,
 * }} o
 * @returns {Promise<{ ok: boolean, checks: { name: string, ok: boolean, detail?: string }[], output: string, message: string }>}
 */
export async function verifyWorkspace({ dir, timeoutMs, settleMs = 2000, consolePort, signal, onSpawn, onCheck }) {
  /** @type {{ name: string, ok: boolean, detail?: string }[]} */
  const checks = [];
  let raw = '';
  let child = null;
  /** @type {{ code: number|null, signal: string|null }|null} */
  let exitInfo = null;
  let exited = Promise.resolve();
  let cancelled = false;
  const reqAbort = new AbortController();

  const onAbort = () => {
    cancelled = true;
    reqAbort.abort();
  };
  if (signal?.aborted) throw cancelledError();
  signal?.addEventListener('abort', onAbort, { once: true });

  const note = (/** @type {string} */ name, /** @type {'running'|'passed'|'failed'} */ status, /** @type {string} */ detail) =>
    onCheck?.({ check: name, label: CHECK_LABELS[/** @type {keyof typeof CHECK_LABELS} */ (name)], status, ...(detail ? { detail } : {}) });
  const guard = () => {
    if (cancelled) throw cancelledError();
  };
  const run = async (/** @type {string} */ name, /** @type {() => Promise<unknown>|unknown} */ fn) => {
    guard();
    note(name, 'running');
    try {
      const result = await fn();
      guard();
      checks.push({ name, ok: true });
      note(name, 'passed');
      return result;
    } catch (err) {
      if (cancelled) throw cancelledError();
      const message = err instanceof CheckFailed ? err.message : `The check could not be completed (${name}).`;
      checks.push({ name, ok: false, detail: message });
      note(name, 'failed', message);
      throw err instanceof CheckFailed ? err : new CheckFailed(message);
    }
  };
  const seconds = (/** @type {number} */ ms) => Math.max(1, Math.round(ms / 1000));

  try {
    const smoke = /** @type {string[]} */ (await run('files', () => readFilesCheck(dir)));

    // Fresh, empty data/: the staged app never sees anyone's real data.
    const dataDir = path.join(dir, 'data');
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.mkdirSync(dataDir, { recursive: true });

    const port = await freePort();
    child = spawnSandboxed({ appDir: dir, dataDir, port });
    exited = new Promise((resolve) => child.once('exit', (code, sig) => ((exitInfo = { code, signal: sig }), resolve())));
    const collect = (/** @type {Buffer} */ chunk) => {
      raw += chunk;
      if (raw.length > 131072) raw = `${raw.slice(0, 65536)}\n[...]\n${raw.slice(-65536)}`;
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (err) => collect(Buffer.from(`${err.message}\n`)));
    onSpawn?.({ pid: /** @type {number} */ (child.pid), port });
    const get = (/** @type {string} */ p, /** @type {number} */ bodyCap = 0) => httpGet(port, p, { timeoutMs, signal: reqAbort.signal, bodyCap });

    await run('start', async () => {
      const deadline = Date.now() + timeoutMs;
      let lastStatus = 0;
      while (Date.now() < deadline) {
        guard();
        if (exitInfo) throw new CheckFailed(`The app stopped right after it started (exit code ${exitInfo.code}), so it did not start.`);
        try {
          const r = await get('/health');
          if (r.status === 200) return;
          lastStatus = r.status;
        } catch {
          /* not listening yet */
        }
        await sleep(50);
      }
      throw new CheckFailed(lastStatus ? `GET /health returned HTTP ${lastStatus} instead of 200.` : `The app did not answer on /health within ${seconds(timeoutMs)} seconds.`);
    });

    let homeHtml = '';
    await run('home', async () => {
      const r = await get('/', HOME_BODY_CAP);
      if (r.status !== 200) throw new CheckFailed(`GET / returned HTTP ${r.status} instead of 200.`);
      if (!/html/i.test(r.contentType)) throw new CheckFailed(`The home page is not HTML (content type "${r.contentType || 'none'}").`);
      homeHtml = r.body;
    });

    await run('console_link', () => {
      const allowed = new Set(['/_evolv', '/_evolv/']);
      if (consolePort) for (const host of ['127.0.0.1', 'localhost']) for (const tail of ['', '/']) allowed.add(`http://${host}:${consolePort}${tail}`);
      if (!extractLinks(homeHtml).some((h) => allowed.has(h))) {
        throw new CheckFailed(
          `The home page no longer has a link to the recovery console, or the link points to the wrong place. It must point to /_evolv${consolePort ? ` (or to http://127.0.0.1:${consolePort}/)` : ''}. Without it there is no way back if something breaks.`,
        );
      }
    });

    await run('smoke', async () => {
      for (const route of smoke) {
        let r;
        try {
          r = await get(route);
        } catch {
          throw new CheckFailed(`GET ${route} did not answer.`);
        }
        if (r.status >= 500 || r.status === 0) throw new CheckFailed(`GET ${route} returned HTTP ${r.status}; it must be below 500.`);
      }
    });

    await run('alive', async () => {
      const until = Date.now() + settleMs;
      while (Date.now() < until) {
        guard();
        if (exitInfo) throw new CheckFailed(`The app stopped about ${Math.max(1, Math.round(settleMs / 1000))} second(s) after it started (exit code ${exitInfo.code}).`);
        await sleep(40);
      }
      if (exitInfo) throw new CheckFailed(`The app stopped shortly after it started (exit code ${exitInfo.code}).`);
      let healthy = false;
      try {
        healthy = (await get('/health')).status === 200;
      } catch {
        /* handled below */
      }
      if (!healthy) throw new CheckFailed('The app stopped answering on /health shortly after it started.');
    });

    return { ok: true, checks, output: cleanOutput(raw, dir), message: '' };
  } catch (err) {
    if (cancelled || /** @type {any} */ (err)?.code === 'cancelled') throw cancelledError();
    if (err instanceof CheckFailed) return { ok: false, checks, output: cleanOutput(raw, dir), message: err.message };
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reqAbort.abort();
    await stopChild(child, exited);
  }
}

/** @param {import('node:child_process').ChildProcess|null} child @param {Promise<void>} exited */
async function stopChild(child, exited) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill();
  const outcome = await Promise.race([exited.then(() => 'exited'), sleep(3000).then(() => 'timeout')]);
  if (outcome === 'timeout' && child.pid) {
    await execFileP('taskkill', ['/pid', String(child.pid), '/T', '/F']).catch(() => {});
    await exited;
  }
}
