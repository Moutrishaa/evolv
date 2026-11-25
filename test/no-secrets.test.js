// If a real AI key is in .env, it must appear in no tracked file, no git history, and nothing
// the app or the supervisor stored on disk. Skips quietly when there is no key to look for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseEnv } from '../supervisor/config.js';
import { ROOT } from '../test-fixtures/helpers.js';

const run = promisify(execFile);
const envFile = path.join(ROOT, '.env');
const key = fs.existsSync(envFile) ? (parseEnv(fs.readFileSync(envFile, 'utf8')).AI_API_KEY ?? '') : '';

test('.env is git-ignored', async () => {
  const { stdout } = await run('git', ['check-ignore', '.env'], { cwd: ROOT }).catch((e) => ({ stdout: '' }));
  assert.equal(stdout.trim(), '.env');
});

test('no tracked file or commit contains an Anthropic-style key', async () => {
  const { stdout } = await run('git', ['grep', '-n', '-E', 'sk-ant-[A-Za-z0-9_-]{20,}', '--', '.'], { cwd: ROOT }).catch((e) => ({ stdout: e.stdout ?? '' }));
  assert.equal(stdout.trim(), '', 'a key-shaped string is committed');
});

test('the real key (if there is one) appears in no tracked file, no git history, and no stored state', async (t) => {
  if (key.length < 8) return t.skip('no AI_API_KEY in .env, nothing to look for');
  // The key goes into a private temp file for git's -f option, never onto a command line.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolv-secret-'));
  const pattern = path.join(dir, 'pattern');
  fs.writeFileSync(pattern, key + '\n', { mode: 0o600 });
  try {
    const grep = async (cwd, args) => run('git', args, { cwd, maxBuffer: 50 * 1024 * 1024 }).then((r) => r.stdout, (e) => (e.code === 1 ? '' : Promise.reject(e)));
    assert.equal((await grep(ROOT, ['grep', '-l', '-F', '-f', pattern])).trim(), '', 'key found in a tracked file');
    const commits = (await run('git', ['rev-list', '--all'], { cwd: ROOT })).stdout.split('\n').filter(Boolean);
    for (const c of commits) {
      assert.equal((await grep(ROOT, ['grep', '-l', '-F', '-f', pattern, c])).trim(), '', `key found in commit ${c.slice(0, 7)}`);
    }
    // Everything the supervisor and the app wrote to disk (ledger, key file, workspaces, app repo).
    const scan = (d) => {
      if (!fs.existsSync(d)) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) scan(full);
        else if (fs.statSync(full).size < 20 * 1024 * 1024) assert.ok(!fs.readFileSync(full).includes(key), `key found in ${path.relative(ROOT, full)}`);
      }
    };
    scan(path.join(ROOT, 'state'));
    scan(path.join(ROOT, 'app'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
