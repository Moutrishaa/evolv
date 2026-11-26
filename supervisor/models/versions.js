// The version store: seed the app, and list its versions. A version is a git commit in app/.
// Promoting a change is in services/promote.js. Git runs only through execFile, never a shell.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { META_PREFIX } from '../constants/storage.js';

const execFileP = promisify(execFile);

/**
 * @param {string} cwd
 * @param {string[]} args
 */
export async function git(cwd, args) {
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
export function buildCommitMessage(meta) {
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
