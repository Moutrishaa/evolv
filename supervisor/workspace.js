// Staging workspaces: a fresh git worktree of the current version, outside app/.
// The agent edits only here. The live app and its history are never touched.
// Git runs only through execFile, never a shell.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileP = promisify(execFile);
const ID_RE = /^[A-Za-z0-9_-]{22,64}$/;

/** @param {string} cwd @param {string[]} args */
async function git(cwd, args) {
  const { stdout } = await execFileP('git', args, { cwd, windowsHide: true, maxBuffer: 50 * 1024 * 1024 });
  return stdout;
}

/** @param {string} dir */
function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}

/**
 * @param {{ appDir: string, workspacesDir: string, id: string }} o
 */
export async function createWorkspace({ appDir, workspacesDir, id }) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('Invalid workspace id.');
  fs.mkdirSync(workspacesDir, { recursive: true });
  const dir = path.join(workspacesDir, id);
  // From the saved version (HEAD), so uncommitted edits and data/ never come along.
  await git(appDir, ['worktree', 'add', '--detach', '--quiet', dir, 'HEAD']);

  return {
    id,
    dir,

    /** @returns {Promise<{ path: string, status: 'added'|'modified'|'deleted' }[]>} */
    async changedFiles() {
      const out = await git(dir, ['-c', 'status.renames=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all']);
      return out
        .split('\0')
        .filter((entry) => entry.length > 3)
        .map((entry) => {
          const xy = entry.slice(0, 2);
          const file = entry.slice(3);
          /** @type {'added'|'modified'|'deleted'} */
          let status = 'modified';
          if (xy === '??' || xy.includes('A')) status = 'added';
          else if (xy.includes('D')) status = 'deleted';
          return { path: file, status };
        });
    },

    /** Unified diff of everything the agent did, including new and deleted files. */
    async diff() {
      await git(dir, ['add', '-A']); // stages inside this worktree's own index only
      return git(dir, ['diff', '--cached', '--no-color', '--no-ext-diff', '--no-renames', 'HEAD']);
    },

    /** Removes the workspace and its git record. Safe to call twice. */
    async discard() {
      try {
        await git(appDir, ['worktree', 'remove', '--force', dir]);
      } catch {
        /* already gone, or git could not; the folder is removed below either way */
      }
      removeDir(dir);
      try {
        await git(appDir, ['worktree', 'prune']);
      } catch {
        /* nothing to prune */
      }
      if (fs.existsSync(dir)) throw new Error('The staging folder could not be removed.');
    },
  };
}

/** At start-up nothing can be running, so every workspace on disk is a leftover from a crash. */
export async function sweepWorkspaces({ appDir, workspacesDir }) {
  if (fs.existsSync(workspacesDir)) {
    for (const name of fs.readdirSync(workspacesDir)) removeDir(path.join(workspacesDir, name));
  }
  try {
    await git(appDir, ['worktree', 'prune']);
  } catch {
    /* the app repo does not exist yet */
  }
}
