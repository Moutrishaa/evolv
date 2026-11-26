import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureSeeded, listVersions } from '../../supervisor/models/versions.js';
import { makeTempDir, ROOT } from '../../test-fixtures/helpers/helpers.js';

const run = promisify(execFile);
const seedDir = path.join(ROOT, 'seed');

test('seed folder has the files the app contract needs', () => {
  for (const f of ['server.js', 'evolv.json', path.join('public', 'index.html')]) {
    assert.ok(fs.existsSync(path.join(seedDir, f)), `seed/${f} missing`);
  }
  const evolv = JSON.parse(fs.readFileSync(path.join(seedDir, 'evolv.json'), 'utf8'));
  assert.ok(Array.isArray(evolv.smoke) && evolv.smoke.includes('/'));
});

test('first start seeds app/, creates data/, and records version 1', async () => {
  const tmp = makeTempDir('evolv-ver-');
  try {
    const appDir = path.join(tmp.dir, 'app');
    const result = await ensureSeeded({ seedDir, appDir });
    assert.equal(result.seeded, true);
    assert.ok(fs.existsSync(path.join(appDir, 'server.js')));
    assert.ok(fs.existsSync(path.join(appDir, '.git')));
    assert.ok(fs.statSync(path.join(appDir, 'data')).isDirectory());

    const versions = await listVersions(appDir);
    assert.equal(versions.length, 1);
    assert.equal(versions[0].id, 1);
    assert.ok(versions[0].time);
    assert.match(versions[0].summary, /seed/i);
  } finally {
    tmp.cleanup();
  }
});

test('a second start does not re-seed or add a version', async () => {
  const tmp = makeTempDir('evolv-ver-');
  try {
    const appDir = path.join(tmp.dir, 'app');
    await ensureSeeded({ seedDir, appDir });
    fs.writeFileSync(path.join(appDir, 'marker.txt'), 'keep me');
    const again = await ensureSeeded({ seedDir, appDir });
    assert.equal(again.seeded, false);
    assert.equal((await listVersions(appDir)).length, 1);
    assert.equal(fs.readFileSync(path.join(appDir, 'marker.txt'), 'utf8'), 'keep me');
  } finally {
    tmp.cleanup();
  }
});

test('data/ is not versioned', async () => {
  const tmp = makeTempDir('evolv-ver-');
  try {
    const appDir = path.join(tmp.dir, 'app');
    await ensureSeeded({ seedDir, appDir });
    fs.writeFileSync(path.join(appDir, 'data', 'notes.json'), '[]');
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd: appDir });
    assert.equal(stdout.trim(), '', 'data/ must be git-ignored');
  } finally {
    tmp.cleanup();
  }
});
