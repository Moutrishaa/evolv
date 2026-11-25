// Version store, B1 part: seed app/ from seed/ and record version 1.
// Undo, restore, diff and reset arrive in B4. Git runs only through execFile, never a shell.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileP = promisify(execFile);

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

/**
 * Versions, newest first. Version ids are 1-based in commit order.
 * @param {string} appDir
 * @returns {Promise<{ id: number, hash: string, time: string, summary: string }[]>}
 */
export async function listVersions(appDir) {
  if (!fs.existsSync(path.join(appDir, '.git'))) return [];
  const out = await git(appDir, ['log', '--format=%H%x1f%cI%x1f%s']);
  const rows = out.split('\n').filter(Boolean);
  return rows.map((row, i) => {
    const [hash, time, summary] = row.split('\x1f');
    return { id: rows.length - i, hash, time, summary };
  });
}
