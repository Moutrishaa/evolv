// The sandbox launcher and the app process manager.
// The app runs under Node's permission model: it can read its own folder, write only
// data/, and cannot spawn processes, start workers or load native addons.
// The app's environment is exactly PORT, DATA_DIR and NODE_ENV. Never a key.
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * Flags verified with `node --help` on v26.13.1:
 *   --permission, --allow-fs-read=, --allow-fs-write=, --allow-net, --max-old-space-size=
 * --allow-net is required or the app cannot listen on its port. Node has no finer
 * network control, so outbound network is not blocked. This is the PRD's accepted risk.
 * Deliberately NOT passed: --allow-child-process, --allow-worker, --allow-addons,
 * --allow-wasi, --allow-ffi, --allow-fs-vfs, --allow-inspector.
 *
 * @param {{ appDir: string, dataDir: string, entry?: string }} o
 * @returns {string[]}
 */
export function buildSandboxArgs({ appDir, dataDir, entry = 'server.js' }) {
  return [
    '--permission',
    `--allow-fs-read=${appDir}`,
    `--allow-fs-write=${dataDir}`,
    '--allow-net',
    '--max-old-space-size=256',
    entry,
  ];
}

/** @param {{ port: number, dataDir: string }} o */
export function buildSandboxEnv({ port, dataDir }) {
  return { PORT: String(port), DATA_DIR: dataDir, NODE_ENV: 'production' };
}

/**
 * On Windows, libuv copies these 11 variables from the parent into every child whose
 * environment lacks them (verified: a child started with env={PORT} still sees them).
 * Node offers no way to turn that off, so we pass them as empty strings. The keys exist
 * but the real values (user name, profile paths, PATH) never reach the app.
 * SYSTEMROOT is the one exception: Node's crypto crashes on Windows without it (verified),
 * and its value (C:windows) is not sensitive.
 */
export const WINDOWS_REQUIRED_VAR = 'SYSTEMROOT';
export const WINDOWS_LIBUV_VARS = [
  'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT',
  'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR',
];

/**
 * Starts the app sandboxed. No shell. Environment is built from scratch, so nothing
 * from the supervisor's own environment (such as AI_API_KEY) can leak through.
 * @param {{ appDir: string, dataDir: string, port: number, entry?: string }} o
 */
export function spawnSandboxed({ appDir, dataDir, port, entry = 'server.js' }) {
  const env = buildSandboxEnv({ port, dataDir });
  if (process.platform === 'win32') {
    for (const name of WINDOWS_LIBUV_VARS) env[name] = name === WINDOWS_REQUIRED_VAR ? (process.env[name] ?? '') : '';
  }
  return spawn(process.execPath, buildSandboxArgs({ appDir, dataDir, entry }), {
    cwd: appDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
}

/**
 * Total CPU seconds used by a process, or null if this platform is not supported.
 * @param {number} pid
 * @returns {Promise<number|null>}
 */
export async function sampleCpuSeconds(pid) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileP(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).TotalProcessorTime.TotalSeconds`],
        { windowsHide: true, timeout: 5000 },
      );
      const v = Number(stdout.trim().replace(',', '.'));
      return Number.isFinite(v) ? v : null;
    }
    const { stdout } = await execFileP('ps', ['-o', 'cputime=', '-p', String(pid)], { timeout: 5000 });
    const parts = stdout.trim().split(':').map(Number); // [[dd-]hh:]mm:ss
    if (parts.some((n) => !Number.isFinite(n))) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  } catch {
    return null;
  }
}

/** Keeps the last N log lines. */
export class LogBuffer {
  /** @param {number} [limit] */
  constructor(limit = 500) {
    this.limit = limit;
    /** @type {{ time: string, text: string }[]} */
    this.items = [];
  }
  /** @param {string} text */
  push(text) {
    this.items.push({ time: new Date().toISOString(), text });
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
  }
  lines() {
    return this.items.slice();
  }
}

/**
 * Runs the app, restarts it after a crash with backoff, gives up after
 * `maxCrashes` crashes within `crashWindowMs`, and restarts it if it stays pinned
 * at ~100% CPU for `cpuPinnedMs`.
 * States: stopped | running | backoff | failed
 */
export class AppProcess extends EventEmitter {
  /**
   * @param {{
   *   appDir: string, dataDir: string, port: number, entry?: string,
   *   backoffMs?: number[], maxCrashes?: number, crashWindowMs?: number,
   *   cpuSampleMs?: number, cpuPinnedMs?: number,
   *   sampleCpu?: (pid: number) => Promise<number|null>
   * }} o
   */
  constructor(o) {
    super();
    this.o = {
      entry: 'server.js',
      backoffMs: [500, 1000, 2000],
      maxCrashes: 3,
      crashWindowMs: 60000,
      cpuSampleMs: 5000,
      cpuPinnedMs: 30000,
      sampleCpu: sampleCpuSeconds,
      ...o,
    };
    this.logs = new LogBuffer(500);
    this.state = 'stopped';
    /** @type {import('node:child_process').ChildProcess|null} */
    this.child = null;
    this.spawns = 0;
    this.restarts = 0;
    /** @type {number[]} */
    this.crashTimes = [];
    this.startedAt = 0;
    this.stopping = false;
    /** @type {NodeJS.Timeout|null} */
    this.backoffTimer = null;
    /** @type {NodeJS.Timeout|null} */
    this.cpuTimer = null;
  }

  status() {
    return {
      state: this.state,
      pid: this.child?.pid ?? null,
      port: this.o.port,
      spawns: this.spawns,
      restarts: this.restarts,
      recentCrashes: this.crashTimes.length,
      startedAt: this.startedAt || null,
    };
  }

  /** Begin (or begin again after a stop or a give-up). */
  start() {
    if (this.child || this.state === 'backoff') return;
    this.stopping = false;
    this.crashTimes = [];
    this.#spawn();
  }

  #spawn() {
    const { appDir, dataDir, port, entry } = this.o;
    this.spawns++;
    const child = spawnSandboxed({ appDir, dataDir, port, entry });
    this.child = child;
    this.state = 'running';
    this.startedAt = Date.now();
    this.logs.push(`[supervisor] app started (pid ${child.pid})`);
    this.emit('state', this.status());

    const onData = (/** @type {Buffer} */ chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) this.logs.push(line);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => this.logs.push(`[supervisor] spawn error: ${err.message}`));
    child.on('exit', (code, signal) => this.#onExit(child, code, signal));
    this.#startWatchdog(child);
  }

  /** @param {import('node:child_process').ChildProcess} child @param {number|null} code @param {string|null} signal */
  #onExit(child, code, signal) {
    if (this.child !== child) return;
    this.child = null;
    this.#stopWatchdog();
    this.logs.push(`[supervisor] app exited (code ${code}, signal ${signal})`);
    if (this.stopping) {
      this.state = 'stopped';
      this.emit('state', this.status());
      return;
    }
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < this.o.crashWindowMs);
    this.crashTimes.push(now);
    if (this.crashTimes.length >= this.o.maxCrashes) {
      this.state = 'failed';
      this.logs.push(`[supervisor] ${this.crashTimes.length} crashes in ${this.o.crashWindowMs / 1000}s: giving up. Use Undo or Restore in the console.`);
      this.emit('state', this.status());
      return;
    }
    const delay = this.o.backoffMs[Math.min(this.crashTimes.length - 1, this.o.backoffMs.length - 1)];
    this.state = 'backoff';
    this.logs.push(`[supervisor] restarting in ${delay} ms`);
    this.emit('state', this.status());
    this.backoffTimer = setTimeout(() => {
      this.backoffTimer = null;
      if (this.stopping) return;
      this.restarts++;
      this.#spawn();
    }, delay);
  }

  /** @param {import('node:child_process').ChildProcess} child */
  #startWatchdog(child) {
    const { cpuSampleMs, cpuPinnedMs, sampleCpu } = this.o;
    let last = /** @type {{ cpu: number, at: number }|null} */ (null);
    let pinnedSince = /** @type {number|null} */ (null);
    const pid = /** @type {number} */ (child.pid);
    const tick = async () => {
      const cpu = await sampleCpu(pid);
      if (this.child !== child || cpu === null) return;
      const at = Date.now();
      if (last) {
        const usage = (cpu - last.cpu) / ((at - last.at) / 1000); // 1.0 = one core fully busy
        if (usage >= 0.95) {
          pinnedSince ??= last.at;
          if (at - pinnedSince >= cpuPinnedMs) {
            this.logs.push(`[supervisor] watchdog: CPU pinned for ${Math.round((at - pinnedSince) / 1000)}s, restarting the app`);
            pinnedSince = null;
            child.kill();
            return;
          }
        } else {
          pinnedSince = null;
        }
      }
      last = { cpu, at };
    };
    this.cpuTimer = setInterval(() => void tick().catch(() => {}), cpuSampleMs);
    this.cpuTimer.unref();
  }

  #stopWatchdog() {
    if (this.cpuTimer) clearInterval(this.cpuTimer);
    this.cpuTimer = null;
  }

  /** Stop the app and wait until the process is really gone. */
  async stop() {
    this.stopping = true;
    if (this.backoffTimer) clearTimeout(this.backoffTimer);
    this.backoffTimer = null;
    this.#stopWatchdog();
    const child = this.child;
    if (!child) {
      if (this.state !== 'failed') this.state = 'stopped';
      return;
    }
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    const timeout = new Promise((resolve) => setTimeout(resolve, 3000, 'timeout'));
    if ((await Promise.race([exited, timeout])) === 'timeout' && child.pid) {
      // Windows fallback: kill the whole tree. execFile, no shell.
      await execFileP('taskkill', ['/pid', String(child.pid), '/T', '/F']).catch(() => {});
      await exited;
    }
  }

  async restart() {
    await this.stop();
    this.start();
  }
}
