// The constants folder holds only data, and the security-relevant values did not change when they moved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as C from '../../supervisor/constants/index.js';

const dir = path.join(import.meta.dirname, '..', '..', 'supervisor', 'constants');

test('constants files have no imports (pure data, no logic, no cycles)', () => {
  for (const f of fs.readdirSync(dir).filter((n) => n !== 'index.js')) {
    assert.ok(!/^\s*import\s/m.test(fs.readFileSync(path.join(dir, f), 'utf8')), `${f} must not import`);
  }
});

test('limits keep the values they had before the move', () => {
  assert.equal(C.MAX_BODY_BYTES, 16 * 1024);
  assert.equal(C.MAX_PATH_CHARS, 1024);
  assert.equal(C.MAX_SEGMENT_CHARS, 255);
  assert.equal(C.MAX_DEPTH, 20);
  assert.equal(C.CHANGE_TIMEOUT_MS, 300_000);
  assert.equal(C.MAX_FORMAT_FAILURES, 3);
  assert.equal(C.LIMITS.maxWriteBytes, 200 * 1024);
  assert.deepEqual(C.LIMITS.undeletable, ['server.js', 'evolv.json']);
  assert.ok(Object.isFrozen(C.LIMITS));
});

test('security headers, safe methods and console files are unchanged', () => {
  assert.deepEqual([...C.SAFE_METHODS], ['GET', 'HEAD']);
  assert.equal(C.SECURITY_HEADERS['X-Frame-Options'], 'DENY');
  assert.match(C.SECURITY_HEADERS['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.deepEqual(Object.keys(C.CONSOLE_FILES), ['', 'index.html', 'console.js', 'console.css']);
});

test('patterns still accept and refuse the same things', () => {
  assert.ok(C.KEY_RE.test('a'.repeat(64)) && !C.KEY_RE.test('A'.repeat(64)));
  assert.ok(C.APP_ID_RE.test('a'.repeat(22)) && !C.APP_ID_RE.test('a'.repeat(21)));
  assert.ok(C.RESERVED.test('CON') && C.RESERVED.test('lpt1') && !C.RESERVED.test('console'));
  assert.ok(C.SAFE_ROUTE.test('/about') && !C.SAFE_ROUTE.test('//evil') && !C.SAFE_ROUTE.test('/a b'));
});

test('the Windows sandbox variable list is unchanged', () => {
  assert.equal(C.WINDOWS_REQUIRED_VAR, 'SYSTEMROOT');
  assert.equal(C.WINDOWS_LIBUV_VARS.length, 11);
});
