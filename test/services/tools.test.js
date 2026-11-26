// The seven agent tools. Every tool reaches only the workspace, hides protected paths, and
// returns errors as results instead of throwing.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTools, LIMITS } from '../../supervisor/services/tools.js';
import { makeTempDir } from '../../test-fixtures/helpers/helpers.js';

let tmp, root, tools, outsideFile;

const write = (rel, content) => {
  const f = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
};
const read = (rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, ...rel.split('/')));

beforeEach(() => {
  tmp = makeTempDir('evolv-tools-');
  root = path.join(tmp.dir, 'ws');
  fs.mkdirSync(root);
  write('server.js', "import http from 'node:http';\nconsole.log('hi');\n");
  write('evolv.json', '{ "smoke": ["/"] }\n');
  write('public/index.html', '<h1>Hello</h1>\n<p>Hello again</p>\n');
  write('public/style.css', 'body { color: #111; }\n');
  write('public/data/x.json', '{}'); // a "data" folder that is NOT at the root: allowed
  write('lib/util.js', 'export const a = 1;\nexport const b = 2;\n');
  write('lib/server.js', '// not the entry point\n');
  write('.hidden', 'hidden-content');
  write('.git/config', 'SECRET-GIT');
  write('.git/HEAD', 'SECRET-GIT-HEAD');
  write('.env', 'SECRET-ENV=1');
  write('data/notes.json', 'SECRET-DATA');
  write('node_modules/x/index.js', 'SECRET-NM');
  outsideFile = path.join(tmp.dir, 'outside.txt');
  fs.writeFileSync(outsideFile, 'OUTSIDE-SECRET');
  tools = createTools({ root });
});
afterEach(() => {
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'OUTSIDE-SECRET');
  tmp.cleanup();
});

const run = (name, input) => tools.execute(name, input);

test('exactly seven tools, each with a JSON schema', () => {
  const names = tools.definitions.map((d) => d.name).sort();
  assert.deepEqual(names, ['delete_file', 'edit_file', 'finish', 'list_files', 'read_file', 'search', 'write_file']);
  for (const d of tools.definitions) {
    assert.equal(typeof d.description, 'string');
    assert.equal(d.input_schema.type, 'object');
    assert.ok(d.input_schema.properties);
  }
});

test('execute never throws, whatever it is given', () => {
  const weird = [undefined, null, 5, 'x', [], {}, { path: {} }, { path: 'a', content: 5 }, { path: 'a', old_text: [], new_text: 1 }, { pattern: 7 }, { dir: 9 }, { summary: {} }];
  for (const name of [...tools.definitions.map((d) => d.name), 'no_such_tool', '', null]) {
    for (const input of weird) {
      const r = run(name, input);
      assert.equal(typeof r.ok, 'boolean', `${name} ${JSON.stringify(input)}`);
      assert.equal(typeof r.content, 'string');
    }
  }
  assert.equal(run('no_such_tool', {}).ok, false);
});

test('error text never reveals the real folder path', () => {
  const attempts = [
    ['read_file', { path: 'missing.txt' }], ['read_file', { path: '../outside.txt' }], ['read_file', { path: '.env' }],
    ['list_files', { dir: 'nope' }], ['write_file', { path: '.git/x', content: 'a' }], ['edit_file', { path: 'nope', old_text: 'a', new_text: 'b' }],
    ['delete_file', { path: 'nope' }], ['search', { pattern: 'x', dir: 'nope' }],
  ];
  for (const [n, i] of attempts) {
    const r = run(n, i);
    assert.equal(r.ok, false, `${n} ${JSON.stringify(i)}`);
    assert.ok(!r.content.includes(root) && !r.content.includes(tmp.dir), `${n} leaked the path: ${r.content}`);
  }
});

// ---------- list_files ----------
test('list_files shows the app and hides hidden and protected entries', () => {
  const r = run('list_files', {});
  assert.equal(r.ok, true);
  const lines = r.content.split('\n');
  assert.ok(lines.some((l) => l.startsWith('server.js')));
  assert.ok(lines.some((l) => l.startsWith('evolv.json')));
  assert.ok(lines.includes('public/'));
  assert.ok(lines.includes('lib/'));
  for (const hidden of ['.git', '.env', 'data', 'node_modules', '.hidden']) {
    assert.ok(!lines.some((l) => l.replace(/\/$/, '').startsWith(hidden)), `${hidden} must be invisible`);
  }
  assert.ok(!r.content.includes('SECRET'));
});

test('list_files on a sub-folder, and a non-root data folder is allowed', () => {
  const r = run('list_files', { dir: 'public' });
  assert.ok(r.content.includes('index.html') && r.content.includes('data/'));
  assert.equal(run('list_files', { dir: 'public/data' }).ok, true);
});

test('list_files refuses protected, missing, escaping and non-directory targets as "not found"', () => {
  for (const dir of ['.git', 'data', 'node_modules', '.env', 'nope', 'server.js']) {
    const r = run('list_files', { dir });
    assert.equal(r.ok, false, dir);
    assert.match(r.content, /not found|not a folder/i, dir);
    assert.ok(!r.content.includes('SECRET'));
  }
  assert.equal(run('list_files', { dir: '../' }).ok, false);
  assert.equal(run('list_files', { dir: '/etc' }).ok, false);
});

test('list_files caps very large folders', () => {
  for (let i = 0; i < LIMITS.maxListEntries + 20; i++) write(`bulk/f${String(i).padStart(4, '0')}.txt`, 'x');
  const r = run('list_files', { dir: 'bulk' });
  assert.equal(r.ok, true);
  assert.match(r.content, new RegExp(`showing ${LIMITS.maxListEntries} of ${LIMITS.maxListEntries + 20}`));
  assert.ok(r.content.split('\n').length <= LIMITS.maxListEntries + 3);
});

// ---------- read_file ----------
test('read_file returns numbered lines', () => {
  const r = run('read_file', { path: 'server.js' });
  assert.equal(r.ok, true);
  assert.match(r.content, /^\s*1\timport http from 'node:http';$/m);
  assert.match(r.content, /^\s*2\tconsole\.log\('hi'\);$/m);
});

test('read_file honours from_line and to_line', () => {
  write('many.txt', Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  const r = run('read_file', { path: 'many.txt', from_line: 10, to_line: 12 });
  assert.match(r.content, /^\s*10\tline 10$/m);
  assert.match(r.content, /^\s*12\tline 12$/m);
  assert.ok(!r.content.includes('line 9') && !r.content.includes('line 13'));
});

test('read_file returns at most 2,000 lines and says how to read more', () => {
  write('big.txt', Array.from({ length: 2500 }, (_, i) => `row ${i + 1}`).join('\n') + '\n');
  const r = run('read_file', { path: 'big.txt' });
  assert.match(r.content, /showing lines 1-2000 of 2500/);
  assert.ok(r.content.includes('row 2000') && !r.content.includes('row 2001'));
  const wide = run('read_file', { path: 'big.txt', from_line: 1, to_line: 2500 });
  assert.match(wide.content, /showing lines 1-2000 of 2500/);
  const next = run('read_file', { path: 'big.txt', from_line: 2001, to_line: 2500 });
  assert.ok(next.content.includes('row 2500'));
});

test('read_file result size is capped even for very long lines', () => {
  write('wide.txt', Array.from({ length: 1500 }, () => 'y'.repeat(1000)).join('\n'));
  const r = run('read_file', { path: 'wide.txt' });
  assert.ok(r.content.length <= LIMITS.maxResultChars + 300, `result was ${r.content.length} chars`);
});

test('read_file rejects bad ranges, directories, binary and huge files', () => {
  assert.equal(run('read_file', { path: 'server.js', from_line: 0 }).ok, false);
  assert.equal(run('read_file', { path: 'server.js', from_line: 5, to_line: 2 }).ok, false);
  assert.equal(run('read_file', { path: 'server.js', from_line: 1.5 }).ok, false);
  assert.equal(run('read_file', { path: 'server.js', from_line: 99 }).ok, false); // past the end
  assert.equal(run('read_file', { path: 'public' }).ok, false);
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
  assert.match(run('read_file', { path: 'blob.bin' }).content, /binary/i);
  fs.writeFileSync(path.join(root, 'huge.txt'), 'a'.repeat(LIMITS.maxFileReadBytes + 1));
  assert.match(run('read_file', { path: 'huge.txt' }).content, /too large/i);
  write('empty.txt', '');
  assert.equal(run('read_file', { path: 'empty.txt' }).ok, true);
});

test('read_file cannot see protected files, and says only "not found"', () => {
  // Protected places must be indistinguishable from missing ones: the exact same message.
  const protectedPaths = ['.env', '.env.local', '.git/config', '.git/HEAD', '.GIT/config', '.gitignore', 'data/notes.json', 'DATA/notes.json', 'node_modules/x/index.js'];
  for (const p of protectedPaths) {
    const r = run('read_file', { path: p });
    assert.equal(r.ok, false, p);
    assert.ok(!r.content.includes('SECRET'), p);
    assert.match(r.content, /^Error: Not found: /, `${p} must say exactly "Not found", got: ${r.content}`);
    assert.equal(r.content.replace(p, 'X'), run('read_file', { path: 'zzz' }).content.replace('zzz', 'X'), `${p} must look exactly like a missing file`);
  }
  // Malformed paths get the guard's own, more helpful, wording. They still never succeed or leak.
  for (const p of ['../outside.txt', '/etc/passwd', 'C:\\Windows\\win.ini']) {
    const r = run('read_file', { path: p });
    assert.equal(r.ok, false, p);
    assert.ok(!r.content.includes('SECRET') && !r.content.includes('OUTSIDE'), p);
    assert.match(r.content, /may not|absolute|forward slashes|colons/i, p);
  }
});

// ---------- search ----------
test('search finds literal text with file and line', () => {
  const r = run('search', { pattern: 'Hello' });
  assert.equal(r.ok, true);
  assert.match(r.content, /public\/index\.html:1:.*Hello/);
  assert.match(r.content, /public\/index\.html:2:.*Hello again/);
});

test('search treats the pattern as plain text, never as a regex', () => {
  write('re.txt', 'axb\na.b\n(a+)+$\n');
  assert.match(run('search', { pattern: 'a.b' }).content, /re\.txt:2:/);
  assert.ok(!run('search', { pattern: 'a.b' }).content.includes('re.txt:1:'));
  assert.match(run('search', { pattern: '(a+)+$' }).content, /re\.txt:3:/);
  assert.equal(run('search', { pattern: '[' }).ok, true); // no regex syntax error possible
});

test('search cannot be frozen by a regex-bomb pattern', () => {
  write('bomb.txt', 'a'.repeat(50000) + '!');
  const t0 = Date.now();
  const r = run('search', { pattern: '(a+)+$' });
  assert.equal(r.ok, true);
  assert.ok(Date.now() - t0 < 1500, 'search took too long');
});

test('search returns at most 100 matches and says so', () => {
  write('many.txt', Array.from({ length: 150 }, (_, i) => `needle ${i}`).join('\n'));
  const r = run('search', { pattern: 'needle' });
  assert.equal(r.content.split('\n').filter((l) => l.includes('many.txt:')).length, LIMITS.maxSearchMatches);
  assert.match(r.content, /first 100 matches/);
});

test('search never looks inside protected or hidden places', () => {
  for (const needle of ['SECRET', 'SECRET-GIT', 'SECRET-ENV', 'SECRET-DATA', 'SECRET-NM', 'hidden-content']) {
    const r = run('search', { pattern: needle });
    assert.equal(r.ok, true);
    assert.ok(!r.content.includes('SECRET') && !r.content.includes('hidden-content'), needle);
    assert.match(r.content, /no matches/i);
  }
  for (const dir of ['.git', 'data', 'node_modules']) {
    const r = run('search', { pattern: 'SECRET', dir });
    assert.equal(r.ok, false, dir);
    assert.ok(!r.content.includes('SECRET-'));
  }
});

test('search can be limited to a folder, and skips binary files', () => {
  const r = run('search', { pattern: 'export', dir: 'lib' });
  assert.match(r.content, /lib\/util\.js:1:/);
  assert.ok(!r.content.includes('public/'));
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from('needle\0needle'));
  assert.ok(!run('search', { pattern: 'needle' }).content.includes('blob.bin'));
});

test('search validates its pattern', () => {
  assert.equal(run('search', { pattern: '' }).ok, false);
  assert.equal(run('search', { pattern: 'x'.repeat(201) }).ok, false);
  assert.equal(run('search', { pattern: 5 }).ok, false);
  assert.equal(run('search', { pattern: 'x', dir: '../' }).ok, false);
});

// ---------- write_file ----------
test('write_file creates folders and files, and overwrites', () => {
  const r = run('write_file', { path: 'pages/notes/index.html', content: '<h1>Notes</h1>' });
  assert.equal(r.ok, true);
  assert.equal(read('pages/notes/index.html'), '<h1>Notes</h1>');
  assert.match(run('write_file', { path: 'pages/notes/index.html', content: 'v2' }).content, /overwr/i);
  assert.equal(read('pages/notes/index.html'), 'v2');
});

test('write_file allows up to 200 KB and refuses one byte more (counted in bytes)', () => {
  assert.equal(run('write_file', { path: 'ok.txt', content: 'a'.repeat(LIMITS.maxWriteBytes) }).ok, true);
  const tooBig = run('write_file', { path: 'big.txt', content: 'a'.repeat(LIMITS.maxWriteBytes + 1) });
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.content, /200 KB|too large/i);
  assert.equal(exists('big.txt'), false);
  // 70,000 euro signs are 210,000 bytes in UTF-8
  assert.equal(run('write_file', { path: 'euro.txt', content: '€'.repeat(70000) }).ok, false);
  assert.equal(exists('euro.txt'), false);
});

test('write_file refuses NUL bytes, non-strings, directories and reserved locations', () => {
  assert.equal(run('write_file', { path: 'nul.txt', content: 'a\0b' }).ok, false);
  assert.equal(run('write_file', { path: 'n.txt', content: 5 }).ok, false);
  assert.equal(run('write_file', { path: 'public', content: 'x' }).ok, false);
  for (const p of ['.env', '.env.local', '.git/hooks/pre-commit', '.gitignore', 'data/x.json', 'node_modules/x.js', '../escape.txt', '/tmp/x', 'C:\\x.txt', 'a/../../escape.txt']) {
    const r = run('write_file', { path: p, content: 'pwned' });
    assert.equal(r.ok, false, p);
  }
  assert.equal(read('.env'), 'SECRET-ENV=1');
  assert.equal(read('.git/config'), 'SECRET-GIT');
  assert.equal(exists('data/x.json'), false);
  assert.equal(exists('.gitignore'), false);
  assert.equal(fs.existsSync(path.join(tmp.dir, 'escape.txt')), false);
});

test('write_file may replace the entry point and evolv.json (only delete is blocked)', () => {
  assert.equal(run('write_file', { path: 'server.js', content: '// new' }).ok, true);
  assert.equal(read('server.js'), '// new');
});

// ---------- edit_file ----------
test('edit_file replaces text that occurs exactly once', () => {
  const r = run('edit_file', { path: 'public/style.css', old_text: '#111', new_text: '#fff' });
  assert.equal(r.ok, true);
  assert.equal(read('public/style.css'), 'body { color: #fff; }\n');
});

test('edit_file with 0 matches is an error and leaves the file alone', () => {
  const r = run('edit_file', { path: 'public/style.css', old_text: 'nope', new_text: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.content, /not found/i);
  assert.equal(read('public/style.css'), 'body { color: #111; }\n');
});

// A small model often gets spaces, indentation or line endings slightly wrong. Failing then costs a whole round trip.
test('edit_file still works when only the indentation or line endings of old_text are off', () => {
  write('box.css', '.box {\n    color: red;\n    margin: 0;\n}\n');
  const r = run('edit_file', { path: 'box.css', old_text: 'color: red;\nmargin: 0;', new_text: 'color: blue;\nmargin: 4px;' });
  assert.equal(r.ok, true, r.content);
  assert.equal(read('box.css'), '.box {\n    color: blue;\n    margin: 4px;\n}\n', 'the file indentation is kept');
  write('crlf.txt', 'one\ntwo\nthree\n');
  assert.equal(run('edit_file', { path: 'crlf.txt', old_text: 'one\r\ntwo', new_text: 'ONE\r\nTWO' }).ok, true);
  assert.equal(read('crlf.txt'), 'ONE\nTWO\nthree\n');
  write('crlf2.txt', 'one\r\ntwo\r\nthree\r\n');
  assert.equal(run('edit_file', { path: 'crlf2.txt', old_text: 'one\ntwo', new_text: 'ONE\nTWO' }).ok, true);
  assert.equal(read('crlf2.txt'), 'ONE\r\nTWO\r\nthree\r\n', 'a CRLF file stays CRLF');
});

test('the tolerant match never guesses: two possible places is an error, and exact matches still win', () => {
  write('dup.css', 'a {\n  color: red;\n}\nb {\n    color: red;\n}\n');
  const r = run('edit_file', { path: 'dup.css', old_text: 'color: red;\n}', new_text: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.content, /2 times/);
  assert.equal(read('dup.css'), 'a {\n  color: red;\n}\nb {\n    color: red;\n}\n');
  write('exact.txt', 'x\n  x\n');
  const e = run('edit_file', { path: 'exact.txt', old_text: 'x', new_text: 'y' });
  assert.equal(e.ok, false, 'an exact match that occurs twice is still refused');
});

test('when old_text cannot be found, the error shows the real lines where its first line is, so one retry can succeed', () => {
  write('three.txt', 'alpha\nbeta\ngamma\ndelta\n');
  const r = run('edit_file', { path: 'three.txt', old_text: 'beta\nNOT THERE', new_text: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.content, /not found/i);
  assert.match(r.content, /line 2/i);
  assert.ok(r.content.includes('beta') && r.content.includes('gamma'), r.content);
  assert.equal(read('three.txt'), 'alpha\nbeta\ngamma\ndelta\n');
  const none = run('edit_file', { path: 'three.txt', old_text: 'nothing like it', new_text: 'x' });
  assert.equal(none.ok, false);
  assert.ok(!/line \d/i.test(none.content));
});

test('edit_file with 2 or more matches is an error that says how many', () => {
  write('dup.txt', 'x x\n');
  const r = run('edit_file', { path: 'dup.txt', old_text: 'x', new_text: 'y' });
  assert.equal(r.ok, false);
  assert.match(r.content, /occurs 2 times/);
  assert.equal(read('dup.txt'), 'x x\n');
  write('dup3.txt', 'aaa');
  assert.match(run('edit_file', { path: 'dup3.txt', old_text: 'a', new_text: 'b' }).content, /occurs 3 times/);
  assert.equal(read('dup3.txt'), 'aaa');
});

test('edit_file inserts new_text literally (no $ replacement patterns)', () => {
  write('lit.txt', 'price: X\n');
  assert.equal(run('edit_file', { path: 'lit.txt', old_text: 'X', new_text: "$& $1 $$ $'" }).ok, true);
  assert.equal(read('lit.txt'), "price: $& $1 $$ $'\n");
});

test('edit_file handles multi-line text', () => {
  const r = run('edit_file', { path: 'public/index.html', old_text: '<h1>Hello</h1>\n<p>Hello again</p>', new_text: '<h1>Bye</h1>' });
  assert.equal(r.ok, true);
  assert.equal(read('public/index.html'), '<h1>Bye</h1>\n');
});

test('edit_file validates its input and the size of the result', () => {
  assert.equal(run('edit_file', { path: 'server.js', old_text: '', new_text: 'x' }).ok, false);
  assert.equal(run('edit_file', { path: 'server.js', old_text: 'hi', new_text: 'hi' }).ok, false);
  assert.equal(run('edit_file', { path: 'server.js', old_text: 'hi', new_text: 5 }).ok, false);
  const r = run('edit_file', { path: 'server.js', old_text: 'hi', new_text: 'z'.repeat(LIMITS.maxWriteBytes) });
  assert.equal(r.ok, false);
  assert.match(read('server.js'), /console\.log\('hi'\)/);
  assert.equal(run('edit_file', { path: 'missing.txt', old_text: 'a', new_text: 'b' }).ok, false);
  assert.equal(run('edit_file', { path: 'public', old_text: 'a', new_text: 'b' }).ok, false);
});

test('edit_file cannot touch protected files', () => {
  for (const p of ['.env', '.git/config', 'data/notes.json', 'node_modules/x/index.js', '../outside.txt']) {
    const r = run('edit_file', { path: p, old_text: 'SECRET', new_text: 'pwned' });
    assert.equal(r.ok, false, p);
    assert.ok(!r.content.includes('SECRET'));
  }
  assert.equal(read('.env'), 'SECRET-ENV=1');
});

// ---------- delete_file ----------
test('delete_file removes an ordinary file', () => {
  assert.equal(run('delete_file', { path: 'public/style.css' }).ok, true);
  assert.equal(exists('public/style.css'), false);
});

test('delete_file refuses the entry point and evolv.json, in any letter case', () => {
  for (const p of ['server.js', 'evolv.json', 'SERVER.JS', './Evolv.json']) {
    const r = run('delete_file', { path: p });
    assert.equal(r.ok, false, p);
    assert.match(r.content, /entry point|evolv\.json/i);
  }
  assert.equal(exists('server.js'), true);
  assert.equal(exists('evolv.json'), true);
});

test('delete_file allows a nested file that merely shares the name', () => {
  assert.equal(run('delete_file', { path: 'lib/server.js' }).ok, true);
  assert.equal(exists('lib/server.js'), false);
});

test('delete_file refuses folders, missing and protected paths', () => {
  assert.equal(run('delete_file', { path: 'public' }).ok, false);
  assert.equal(exists('public/index.html'), true);
  assert.equal(run('delete_file', { path: 'nope.txt' }).ok, false);
  for (const p of ['.env', '.git/HEAD', 'data/notes.json', 'node_modules/x/index.js', '../outside.txt', '/etc/hosts']) {
    assert.equal(run('delete_file', { path: p }).ok, false, p);
  }
  assert.equal(read('.env'), 'SECRET-ENV=1');
  assert.equal(read('.git/HEAD'), 'SECRET-GIT-HEAD');
  assert.equal(read('data/notes.json'), 'SECRET-DATA');
});

// ---------- finish ----------
test('finish returns the summary and signals the loop to stop', () => {
  const r = run('finish', { summary: '  Changed the background to navy.  ' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.finish, { summary: 'Changed the background to navy.' });
});

test('finish needs a real one-line summary', () => {
  for (const summary of ['', '   ', 5, undefined, 'x'.repeat(LIMITS.maxSummaryChars + 1)]) {
    const r = run('finish', { summary });
    assert.equal(r.ok, false, String(summary).slice(0, 20));
    assert.equal(r.finish, undefined);
  }
});

test('other tools never signal finish', () => {
  assert.equal(run('read_file', { path: 'server.js' }).finish, undefined);
});
