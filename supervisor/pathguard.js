// The path guard (SEC-1, SEC-2, SEC-3). Every path an AI tool receives goes through here.
//
// One strict rule set on EVERY operating system, so behaviour never depends on the machine:
//   - forward slashes only; no backslashes, no drive letters, no ":" (NTFS streams)
//   - no "..", no absolute paths
//   - no Windows tricks: trailing dot or space, reserved device names, 8.3 short names (GIT~1)
//   - protected and invisible: .git*, .env*, node_modules (any depth), data/ (root only)
//   - no symlinks or junctions anywhere on the way
// The guard only reads the file system (lstat, realpath). It never creates or changes anything.
import fs from 'node:fs';
import path from 'node:path';

export class PathGuardError extends Error {
  /** @param {'invalid_path'|'absolute_path'|'traversal'|'protected'|'symlink'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'PathGuardError';
    this.code = code;
  }
}

const MAX_PATH_CHARS = 1024;
const MAX_SEGMENT_CHARS = 255;
const MAX_DEPTH = 20;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const ILLEGAL_CHARS = /[<>"|?*]/;
const SHORT_NAME = /~\d/;

/**
 * True for places the agent may never see or touch. Compared case-insensitively because
 * NTFS and macOS treat ".GIT" and ".git" as the same folder.
 * @param {string[]} segments
 */
export function isProtected(segments) {
  const lower = segments.map((s) => s.toLowerCase());
  if (lower[0] === 'data') return true; // the app's real data lives at the root only
  return lower.some((s) => s.startsWith('.git') || s.startsWith('.env') || s === 'node_modules');
}

/**
 * @param {unknown} userPath
 * @param {boolean} allowRoot
 * @returns {string[]} clean segments
 */
function lexical(userPath, allowRoot) {
  if (userPath === undefined || userPath === null || userPath === '') {
    if (allowRoot) return [];
    throw new PathGuardError('invalid_path', 'A path is required.');
  }
  if (typeof userPath !== 'string') throw new PathGuardError('invalid_path', 'The path must be text.');
  if (userPath.length > MAX_PATH_CHARS) throw new PathGuardError('invalid_path', 'The path is too long.');
  if (/[\u0000-\u001f\u007f]/.test(userPath)) throw new PathGuardError('invalid_path', 'The path contains control characters.');

  if (/^[A-Za-z]:/.test(userPath) || userPath.startsWith('/') || userPath.startsWith('\\')) {
    throw new PathGuardError('absolute_path', 'Absolute paths are not allowed. Use a path relative to the app folder.');
  }
  if (userPath.includes('\\')) throw new PathGuardError('invalid_path', 'Use forward slashes (/) in paths, never backslashes.');
  if (userPath.includes(':')) throw new PathGuardError('invalid_path', 'Colons are not allowed in paths.');

  const segments = [];
  for (const seg of userPath.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new PathGuardError('traversal', 'Paths may not contain "..".');
    segments.push(seg);
  }
  if (segments.length === 0) {
    if (allowRoot && /^\.?\/*$/.test(userPath)) return [];
    throw new PathGuardError('invalid_path', 'A file or folder name is required.');
  }
  if (segments.length > MAX_DEPTH) throw new PathGuardError('invalid_path', 'The path is nested too deeply.');

  for (const seg of segments) {
    if (seg.length > MAX_SEGMENT_CHARS) throw new PathGuardError('invalid_path', 'A name in the path is too long.');
    if (/[. ]$/.test(seg) || seg.trim() === '') throw new PathGuardError('invalid_path', 'Names may not end in a dot or a space.');
    if (ILLEGAL_CHARS.test(seg)) throw new PathGuardError('invalid_path', 'A name contains a character that is not allowed.');
    if (SHORT_NAME.test(seg)) throw new PathGuardError('invalid_path', 'Names containing "~" and a digit are not allowed.');
    if (RESERVED.test(seg.split('.')[0])) throw new PathGuardError('invalid_path', 'That name is reserved by the operating system.');
  }
  if (isProtected(segments)) throw new PathGuardError('protected', 'That location is reserved.');
  return segments;
}

/**
 * Turns an agent-supplied path into a safe absolute path inside `root`, or throws.
 * @param {string} root  absolute path of the workspace
 * @param {unknown} userPath
 * @param {{ allowRoot?: boolean }} [opts]
 * @returns {{ abs: string, rel: string, segments: string[] }}
 */
export function resolveInRoot(root, userPath, { allowRoot = false } = {}) {
  const segments = lexical(userPath, allowRoot);
  const abs = segments.length ? path.join(root, ...segments) : root;

  // Walk down from the root. Anything that exists on the way must be a plain folder or file.
  let current = root;
  let deepestExisting = root;
  for (const seg of segments) {
    current = path.join(current, seg);
    let st;
    try {
      st = fs.lstatSync(current);
    } catch (err) {
      if (/** @type {any} */ (err).code === 'ENOENT' || /** @type {any} */ (err).code === 'ENOTDIR') break;
      throw new PathGuardError('invalid_path', 'That path cannot be used.');
    }
    if (st.isSymbolicLink()) throw new PathGuardError('symlink', 'Links are not allowed.');
    deepestExisting = current;
  }

  // Belt and braces: the real location of the deepest existing part must still be inside the
  // real workspace (catches reparse points that lstat does not call symlinks).
  try {
    const realRoot = fs.realpathSync.native(root);
    const realDeep = fs.realpathSync.native(deepestExisting);
    const rel = path.relative(realRoot, realDeep);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new PathGuardError('symlink', 'Links are not allowed.');
  } catch (err) {
    if (err instanceof PathGuardError) throw err;
    throw new PathGuardError('invalid_path', 'That path cannot be used.');
  }

  return { abs, rel: segments.join('/'), segments };
}
