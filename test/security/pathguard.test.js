// The path guard is the only thing standing between an AI-chosen string and the file system.
// Every rejection here must also leave the disk untouched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveInRoot, isProtected, PathGuardError } from '../../supervisor/security/pathguard.js';
import { makeTempDir } from '../../test-fixtures/helpers/helpers.js';

let tmp, root, outside, snapshotBefore;

function listAll(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    out.push(path.relative(base, full) + (e.isDirectory() ? '/' : ''));
    if (e.isDirectory() && !e.isSymbolicLink()) listAll(full, base, out);
  }
  return out.sort();
}

before(() => {
  tmp = makeTempDir('evolv-guard-');
  root = path.join(tmp.dir, 'ws');
  outside = path.join(tmp.dir, 'outside');
  fs.mkdirSync(path.join(root, 'public'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'server.js'), '// entry');
  fs.writeFileSync(path.join(root, 'public', 'index.html'), '<h1>hi</h1>');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-SECRET');
  snapshotBefore = JSON.stringify([listAll(root), listAll(outside)]);
});

after(() => {
  // The guard must never create, change or delete anything.
  assert.equal(JSON.stringify([listAll(root), listAll(outside)]), snapshotBefore, 'the guard changed the disk');
  tmp.cleanup();
});

function rejects(input, code, opts) {
  assert.throws(
    () => resolveInRoot(root, input, opts),
    (err) => {
      assert.ok(err instanceof PathGuardError, `not a PathGuardError for ${JSON.stringify(input)}: ${err}`);
      assert.equal(err.code, code, `${JSON.stringify(input)} -> ${err.code} (${err.message})`);
      assert.ok(!err.message.includes(root), 'error message must not reveal the real folder path');
      return true;
    },
  );
}

test('traversal with .. is rejected anywhere in the path', () => {
  for (const p of ['..', '../x', 'a/../../x', 'a/b/../../../x', '../outside/secret.txt', 'a/../x', 'public/..']) {
    rejects(p, 'traversal');
  }
});

test('absolute paths of every flavour are rejected', () => {
  for (const p of ['/etc/passwd', 'C:\\Windows\\win.ini', 'C:/x', 'C:x', '\\\\server\\share', '\\\\?\\C:\\', '//server/x', '\\x', 'c:\\']) {
    rejects(p, 'absolute_path');
  }
});

test('malformed and Windows-tricky paths are rejected', () => {
  const bad = [
    'a/..\\..\\x', // backslashes are never allowed
    'a\\b',
    'file.txt:stream', // NTFS alternate data stream
    '',
    '   ',
    '\0x',
    'a\u0001b',
    'a\u007fb',
    'GIT~1/config', // 8.3 short name for .git
    'PROGRA~1',
    'foo~2.txt',
    '.git.', // Windows strips trailing dots and spaces
    '.git ',
    'foo.',
    'CON',
    'nul.txt',
    'aux',
    'COM1.txt',
    'lpt9',
    'a<b',
    'a?b',
    'a*b',
    'a|b',
    'a"b',
    'x'.repeat(256),
    'a/'.repeat(600) + 'x',
    Array.from({ length: 21 }, (_, i) => `d${i}`).join('/'),
    '.',
  ];
  for (const p of bad) rejects(p, 'invalid_path');
});

test('non-string input is rejected', () => {
  for (const p of [null, undefined, 5, {}, [], ['a'], true]) rejects(p, 'invalid_path');
});

test('protected and invisible locations are rejected, in any letter case', () => {
  const protectedPaths = [
    '.git/config', '.GIT/config', '.Git', 'a/.git/x', '.gitignore', '.gitattributes', '.gitmodules',
    '.env', '.env.local', '.ENV', 'a/.env', 'a/b/.env.production',
    'node_modules/a', 'a/node_modules/b', 'NODE_MODULES/x',
    'data', 'data/x', 'DATA/x', 'Data/notes.json',
  ];
  for (const p of protectedPaths) rejects(p, 'protected');
});

test('look-alike names that are NOT protected are allowed', () => {
  for (const p of ['public/data/x.json', 'lib/data.js', 'environment.txt', 'gitignore.txt', 'my.git/x', 'envfile', 'database/x', '.hidden-file', '.eslintrc']) {
    assert.doesNotThrow(() => resolveInRoot(root, p), p);
  }
});

test('good paths resolve inside the root and are normalised', () => {
  const cases = [
    ['server.js', 'server.js'],
    ['./server.js', 'server.js'],
    ['a//b', 'a/b'],
    ['a/./b', 'a/b'],
    ['public/index.html', 'public/index.html'],
    ['public/', 'public'],
    ['new/deep/file.txt', 'new/deep/file.txt'],
    ['café.txt', 'café.txt'],
    ['my notes/a b.txt', 'my notes/a b.txt'],
    ['%2e%2e/x', '%2e%2e/x'], // a literal folder name, never decoded
    ['a.b.c', 'a.b.c'],
  ];
  for (const [input, rel] of cases) {
    const r = resolveInRoot(root, input);
    assert.equal(r.rel, rel, input);
    assert.equal(r.abs, path.resolve(root, ...rel.split('/')), input);
    assert.ok(r.abs.startsWith(root + path.sep), input);
  }
});

test('the root itself is only allowed when asked for', () => {
  const r = resolveInRoot(root, '.', { allowRoot: true });
  assert.equal(r.rel, '');
  assert.equal(r.abs, root);
  assert.equal(resolveInRoot(root, '', { allowRoot: true }).rel, '');
  assert.equal(resolveInRoot(root, undefined, { allowRoot: true }).rel, '');
  rejects('.', 'invalid_path');
  rejects('..', 'traversal', { allowRoot: true });
});

test('isProtected agrees with the rules', () => {
  assert.equal(isProtected(['.git']), true);
  assert.equal(isProtected(['a', '.ENV.local']), true);
  assert.equal(isProtected(['DATA']), true);
  assert.equal(isProtected(['public', 'data']), false);
  assert.equal(isProtected(['server.js']), false);
});

test('symlinks and junctions are rejected, whether they point out or in', (t) => {
  // A junction (directories) works without admin rights on Windows; on POSIX it is a symlink.
  fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
  fs.symlinkSync(path.join(root, 'public'), path.join(root, 'alias'), 'junction');
  try {
    rejects('link', 'symlink');
    rejects('link/secret.txt', 'symlink');
    rejects('link/new-file.txt', 'symlink'); // a write through the link
    rejects('link/deeper/new.txt', 'symlink');
    rejects('alias', 'symlink');
    rejects('alias/index.html', 'symlink'); // even a link that stays inside is refused
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'OUTSIDE-SECRET');
    assert.equal(fs.existsSync(path.join(outside, 'new-file.txt')), false);
  } finally {
    fs.rmSync(path.join(root, 'link'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'alias'), { recursive: true, force: true });
  }
  try {
    fs.symlinkSync(path.join(root, 'server.js'), path.join(root, 'filelink'), 'file');
  } catch (err) {
    if (err.code === 'EPERM') return t.diagnostic('file symlinks need privileges on this machine; junction cases above still ran');
    throw err;
  }
  try {
    rejects('filelink', 'symlink');
  } finally {
    fs.rmSync(path.join(root, 'filelink'), { force: true });
  }
});

test('a symlinked workspace root itself is fine; only links INSIDE are refused', () => {
  const linkedRoot = path.join(tmp.dir, 'ws-link');
  fs.symlinkSync(root, linkedRoot, 'junction');
  try {
    assert.equal(resolveInRoot(linkedRoot, 'server.js').rel, 'server.js');
  } finally {
    fs.rmSync(linkedRoot, { recursive: true, force: true });
  }
});
