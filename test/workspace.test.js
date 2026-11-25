import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createWorkspace, sweepWorkspaces } from '../supervisor/workspace.js';
import { newChangeId } from '../supervisor/changes.js';
import { makeSeededApp, gitOut } from '../test-fixtures/helpers.js';

let app;
beforeEach(async () => {
  app = await makeSeededApp();
});
afterEach(() => app.cleanup());

const liveStatus = () => gitOut(app.appDir, ['status', '--porcelain']);
const liveHead = async () => (await gitOut(app.appDir, ['rev-parse', 'HEAD'])).trim();
const open = (id = newChangeId()) => createWorkspace({ appDir: app.appDir, workspacesDir: app.workspacesDir, id });

test('a workspace is a fresh copy of the current version, without data/', async () => {
  fs.writeFileSync(path.join(app.appDir, 'data', 'live.json'), 'live data');
  const ws = await open();
  assert.ok(ws.dir.startsWith(app.workspacesDir + path.sep));
  assert.ok(fs.existsSync(path.join(ws.dir, 'server.js')));
  assert.ok(fs.existsSync(path.join(ws.dir, 'evolv.json')));
  assert.ok(fs.existsSync(path.join(ws.dir, 'public', 'index.html')));
  assert.equal(fs.existsSync(path.join(ws.dir, 'data', 'live.json')), false, 'live data must never be in a workspace');
  await ws.discard();
});

test('a workspace starts from the saved version, not from uncommitted edits in the live app', async () => {
  fs.appendFileSync(path.join(app.appDir, 'server.js'), '\n// uncommitted live edit\n');
  const ws = await open();
  assert.ok(!fs.readFileSync(path.join(ws.dir, 'server.js'), 'utf8').includes('uncommitted live edit'));
  await ws.discard();
});

test('a clean workspace reports no changes', async () => {
  const ws = await open();
  assert.deepEqual(await ws.changedFiles(), []);
  assert.equal((await ws.diff()).trim(), '');
  await ws.discard();
});

test('changed files list modified, added and deleted files, and the diff shows them', async () => {
  const ws = await open();
  const css = path.join(ws.dir, 'public', 'style.css');
  fs.writeFileSync(css, fs.readFileSync(css, 'utf8').replace('#fafafa', '#000080'));
  fs.mkdirSync(path.join(ws.dir, 'public', 'notes'), { recursive: true });
  fs.writeFileSync(path.join(ws.dir, 'public', 'notes', 'index.html'), '<h1>Notes</h1>\n');
  fs.rmSync(path.join(ws.dir, 'public', 'chat.js'));

  const files = (await ws.changedFiles()).sort((a, b) => a.path.localeCompare(b.path));
  assert.deepEqual(files, [
    { path: 'public/chat.js', status: 'deleted' },
    { path: 'public/notes/index.html', status: 'added' },
    { path: 'public/style.css', status: 'modified' },
  ]);
  const diff = await ws.diff();
  assert.match(diff, /^\+\+\+ b\/public\/style\.css$/m);
  assert.match(diff, /^\+.*#000080/m);
  assert.match(diff, /^\+\+\+ b\/public\/notes\/index\.html$/m);
  assert.match(diff, /^--- a\/public\/chat\.js$/m);
  await ws.discard();
});

test('editing a workspace never touches the live app or its history', async () => {
  const head = await liveHead();
  const ws = await open();
  fs.writeFileSync(path.join(ws.dir, 'server.js'), '// totally different');
  fs.writeFileSync(path.join(ws.dir, 'extra.txt'), 'new');
  await ws.diff(); // stages inside the workspace's own index
  assert.equal(await liveStatus(), '');
  assert.equal(await liveHead(), head);
  assert.notEqual(fs.readFileSync(path.join(app.appDir, 'server.js'), 'utf8'), '// totally different');
  assert.equal(fs.existsSync(path.join(app.appDir, 'extra.txt')), false);
  await ws.discard();
  assert.equal(await liveStatus(), '');
  assert.equal(await liveHead(), head);
});

test('two workspaces are isolated from each other', async () => {
  const a = await open();
  const b = await open();
  fs.writeFileSync(path.join(a.dir, 'only-in-a.txt'), 'a');
  assert.equal(fs.existsSync(path.join(b.dir, 'only-in-a.txt')), false);
  assert.deepEqual(await b.changedFiles(), []);
  await a.discard();
  await b.discard();
});

test('discard removes the folder and the git worktree record, and is safe to repeat', async () => {
  const ws = await open();
  assert.ok(fs.existsSync(ws.dir));
  assert.match(await gitOut(app.appDir, ['worktree', 'list']), new RegExp(ws.id));
  await ws.discard();
  assert.equal(fs.existsSync(ws.dir), false);
  assert.doesNotMatch(await gitOut(app.appDir, ['worktree', 'list']), new RegExp(ws.id));
  await assert.doesNotReject(() => ws.discard());
});

test('discard works even when the agent left many files and folders behind', async () => {
  const ws = await open();
  for (let i = 0; i < 30; i++) {
    fs.mkdirSync(path.join(ws.dir, `d${i}`, 'deep'), { recursive: true });
    fs.writeFileSync(path.join(ws.dir, `d${i}`, 'deep', 'f.txt'), 'x');
  }
  await ws.discard();
  assert.equal(fs.existsSync(ws.dir), false);
});

test('workspace ids must be unguessable-looking tokens, never a path', async () => {
  for (const id of ['../x', '..', 'a/b', 'a\\b', '', 'short', 'x'.repeat(65), 'a b'.repeat(8), null, 5]) {
    await assert.rejects(() => open(id), /invalid/i, String(id));
  }
  assert.deepEqual(fs.readdirSync(app.workspacesDir), []);
});

test('sweepWorkspaces removes workspaces left behind by a crash', async () => {
  const left = await open();
  const left2 = await open();
  assert.equal(fs.readdirSync(app.workspacesDir).length, 2);
  await sweepWorkspaces({ appDir: app.appDir, workspacesDir: app.workspacesDir });
  assert.deepEqual(fs.readdirSync(app.workspacesDir), []);
  const list = await gitOut(app.appDir, ['worktree', 'list']);
  assert.ok(!list.includes(left.id) && !list.includes(left2.id));
  assert.equal(await liveStatus(), '');
});

test('sweepWorkspaces is fine when there is nothing to sweep', async () => {
  fs.rmSync(app.workspacesDir, { recursive: true });
  await assert.doesNotReject(() => sweepWorkspaces({ appDir: app.appDir, workspacesDir: app.workspacesDir }));
});
