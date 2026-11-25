// The version store: seed the app, list versions, and promote a verified change.
// A version is a git commit in app/. History only ever moves forward, with one narrow
// exception: a promoted version that never became healthy is rolled back (see promote()).
// Undo, restore, diff and reset arrive in B4. Git runs only through execFile, never a shell.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileP = promisify(execFile);
const META_PREFIX = 'Evolv-Meta: ';

/**
 * @param {string} cwd
 * @param {string[]} args
 */
async function git(cwd, args) {
  const { stdout } = await execFileP('git', args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}

/**
 * Creates app/ from the seed the first time only.
 * @param {{ seedDir: string, appDir: string }} o
 * @returns {Promise<{ seeded: boolean }>}
 */
export async function ensureSeeded({ seedDir, appDir }) {
  if (fs.existsSync(path.join(appDir, '.git'))) {
    fs.mkdirSync(path.join(appDir, 'data'), { recursive: true });
    return { seeded: false };
  }
  fs.mkdirSync(appDir, { recursive: true });
  fs.cpSync(seedDir, appDir, { recursive: true });
  fs.mkdirSync(path.join(appDir, 'data'), { recursive: true });
  // data/ is the app's only writable place and is never versioned.
  fs.writeFileSync(path.join(appDir, '.gitignore'), 'data/\n');

  await git(appDir, ['init', '--quiet']);
  // Local identity and settings so this works on a machine with no global git config.
  await git(appDir, ['config', 'user.name', 'Evolv']);
  await git(appDir, ['config', 'user.email', 'evolv@localhost']);
  await git(appDir, ['config', 'commit.gpgsign', 'false']);
  await git(appDir, ['config', 'core.autocrlf', 'false']);
  await git(appDir, ['add', '-A']);
  await git(appDir, ['commit', '--quiet', '-m', 'Initial seed app']);
  return { seeded: true };
}

/** One line, whatever the input. @param {unknown} s */
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * @param {{ request: string, summary: string, files: { path: string, status: string }[], tokens: number }} meta
 * The summary is forced onto one line so it can never forge a second metadata line; the request
 * lives inside JSON, where its newlines are escaped.
 */
function buildCommitMessage(meta) {
  const summary = oneLine(meta.summary);
  const payload = JSON.stringify({ request: String(meta.request ?? ''), summary, files: meta.files ?? [], tokens: meta.tokens ?? 0 });
  return `${summary.slice(0, 200) || 'Change'}\n\n${META_PREFIX}${payload}\n`;
}

/** @param {string} body @returns {{ request: string, summary: string, files: { path: string, status: string }[], tokens: number }|null} */
function parseMeta(body) {
  // The real line is appended last, so the last one wins.
  const line = body.split('\n').filter((l) => l.startsWith(META_PREFIX)).pop();
  if (!line) return null;
  try {
    const m = JSON.parse(line.slice(META_PREFIX.length));
    const okFiles = Array.isArray(m.files) && m.files.every((f) => f && typeof f.path === 'string' && typeof f.status === 'string');
    if (typeof m.request !== 'string' || typeof m.summary !== 'string' || !okFiles || !Number.isInteger(m.tokens)) return null;
    return m;
  } catch {
    return null;
  }
}

/**
 * Versions, newest first. Version ids are 1-based in commit order.
 * @param {string} appDir
 * @returns {Promise<{ id: number, hash: string, time: string, summary: string, request?: string, files?: { path: string, status: string }[], tokens?: number }[]>}
 */
export async function listVersions(appDir) {
  if (!fs.existsSync(path.join(appDir, '.git'))) return [];
  const out = await git(appDir, ['log', '--format=%H%x1f%cI%x1f%B%x1e']);
  const rows = out.split('\x1e').map((r) => r.replace(/^\n/, '')).filter((r) => r.trim() !== '');
  return rows.map((row, i) => {
    const [hash, time, body = ''] = row.split('\x1f');
    const meta = parseMeta(body);
    const version = { id: rows.length - i, hash, time, summary: meta ? meta.summary : oneLine(body.split('\n')[0]) };
    return meta ? { ...version, request: meta.request, files: meta.files, tokens: meta.tokens } : version;
  });
}

export class PromoteError extends Error {
  /** @param {string} message @param {{ rolledBack?: boolean, restoredHealthy?: boolean }} [o] */
  constructor(message, { rolledBack = false, restoredHealthy = false } = {}) {
    super(message);
    this.name = 'PromoteError';
    this.code = 'swap_failed';
    this.rolledBack = rolledBack;
    this.restoredHealthy = restoredHealthy;
  }
}

/**
 * Makes a verified workspace the new live version.
 *
 *   1. refuse (touching nothing) if the live files were edited outside Evolv, or moved on since staging
 *   2. commit in the workspace
 *   3. stop the live app, fast-forward app/ to the commit, start it, wait for /health
 *   4. if it is not healthy: roll back automatically (M-R3 addition). The branch goes back to the
 *      previous version, so a version that never worked is never in History, and the previous
 *      version is started again. data/ is never touched.
 *
 * @param {{
 *   appDir: string,
 *   workspace: { base: string, commit: (message: string) => Promise<string> },
 *   meta: { request: string, summary: string, files: { path: string, status: string }[], tokens: number },
 *   app: { stop: () => Promise<void>, start: () => unknown, waitHealthy: (ms: number) => Promise<boolean> },
 *   healthTimeoutMs?: number,
 *   log?: (line: string) => void,
 * }} o
 */
export async function promote({ appDir, workspace, meta, app, healthTimeoutMs = 10000, log = () => {} }) {
  if ((await git(appDir, ['status', '--porcelain'])).trim() !== '') {
    throw new PromoteError("Your app's files were changed outside Evolv, so the new version was not applied. Nothing was changed or lost.");
  }
  const previous = (await git(appDir, ['rev-parse', 'HEAD'])).trim();
  if (workspace.base !== previous) {
    throw new PromoteError('Your app changed while this change was being prepared, so the new version was not applied. Nothing was changed or lost.');
  }
  const previousId = (await listVersions(appDir))[0]?.id ?? 1;

  const hash = await workspace.commit(buildCommitMessage(meta));

  await app.stop();
  try {
    await git(appDir, ['merge', '--ff-only', '--quiet', hash]);
  } catch {
    await git(appDir, ['reset', '--hard', '--quiet', previous]).catch(() => {});
    await app.start();
    throw new PromoteError('The new version could not be applied, so your previous version is still in place. Nothing was lost.', { rolledBack: true, restoredHealthy: await app.waitHealthy(healthTimeoutMs) });
  }
  await app.start();
  if (await app.waitHealthy(healthTimeoutMs)) return /** @type {any} */ ((await listVersions(appDir))[0]);

  log(`[supervisor] version ${previousId + 1} did not become healthy; rolling back to version ${previousId}`);
  await app.stop();
  try {
    await git(appDir, ['reset', '--hard', '--quiet', previous]);
  } catch {
    throw new PromoteError('The new version did not start properly, and Evolv could not put your previous version back automatically. Open the recovery console to restore it.');
  }
  await app.start();
  const restoredHealthy = await app.waitHealthy(healthTimeoutMs);
  throw new PromoteError(
    restoredHealthy
      ? `The new version did not start properly, so Evolv put your previous version (version ${previousId}) back. Nothing was lost.`
      : `The new version did not start properly, so Evolv put your previous version (version ${previousId}) back, but could not confirm that it is running. Open the recovery console to check.`,
    { rolledBack: true, restoredHealthy },
  );
}
