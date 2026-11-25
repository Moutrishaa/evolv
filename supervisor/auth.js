// Console credentials. One 256-bit key in state/console.key. State lives outside app/,
// so the sandboxed app can never read it. The key is the bearer token, held only by the
// console page. There are no cookies, so a hostile page has no ambient credential to abuse.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY_RE = /^[0-9a-f]{64}$/;

/**
 * Returns the saved key, creating (or repairing) it if needed.
 * @param {string} stateDir
 * @returns {string}
 */
export function ensureConsoleKey(stateDir) {
  const file = path.join(stateDir, 'console.key');
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (KEY_RE.test(existing)) return existing;
  }
  fs.mkdirSync(stateDir, { recursive: true });
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, key + '\n', { mode: 0o600 });
  return key;
}

/**
 * Constant-time check of an "Authorization: Bearer <key>" header.
 * Hashing first makes both sides the same length, so length never leaks.
 * @param {string|undefined} header
 * @param {string} key
 */
export function bearerMatches(header, key) {
  const m = /^Bearer ([^\s]+)$/.exec(header ?? '');
  const given = crypto.createHash('sha256').update(m ? m[1] : '').digest();
  const want = crypto.createHash('sha256').update(key).digest();
  return crypto.timingSafeEqual(given, want) && m !== null;
}
