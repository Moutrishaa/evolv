// The seven agent tools (PRD section 7). They reach only the staging workspace, every path
// goes through the path guard, and a tool error is a result, never an exception.
//
// Deliberate change from the full PRD: `search` matches literal text, not a regular
// expression. An AI-written regex could freeze the supervisor, and the recovery console with it.
import fs from 'node:fs';
import path from 'node:path';
import { resolveInRoot, isProtected, PathGuardError } from '../security/pathguard.js';
import { LIMITS } from '../constants/limits.js';
export { LIMITS };


/** One wording for "missing", "protected" and "escapes the workspace", so they cannot be told apart. */
const notFoundMessage = (p) => `Not found: ${p}`;

/** A tool-level failure with a message that is safe to show the model. */
class ToolError extends Error {}

const ok = (content, extra = {}) => ({ ok: true, content: capResult(content), ...extra });
const fail = (message) => ({ ok: false, content: capResult(`Error: ${message}`) });

/** @param {string} s */
function capResult(s) {
  if (s.length <= LIMITS.maxResultChars) return s;
  return s.slice(0, LIMITS.maxResultChars) + `\n[output cut at ${LIMITS.maxResultChars} characters]`;
}

/**
 * Turn the guard's verdict into text for the model. Protected places are reported exactly
 * like missing ones, so the model cannot even learn that they exist.
 * @param {string} root @param {unknown} userPath @param {{ allowRoot?: boolean, forWrite?: boolean }} [opts]
 */
function guard(root, userPath, { allowRoot = false, forWrite = false } = {}) {
  try {
    return resolveInRoot(root, userPath, { allowRoot });
  } catch (err) {
    if (!(err instanceof PathGuardError)) throw err;
    if (err.code === 'protected') {
      throw new ToolError(forWrite ? 'That location is reserved and cannot be written.' : notFoundMessage(String(userPath)));
    }
    if (err.code === 'symlink') throw new ToolError(notFoundMessage(String(userPath)));
    throw new ToolError(err.message);
  }
}

/** @param {unknown} v @param {string} name */
function needString(v, name) {
  if (typeof v !== 'string') throw new ToolError(`"${name}" must be text.`);
  return v;
}

/** @param {unknown} v @param {string} name */
function optionalLine(v, name) {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || /** @type {number} */ (v) < 1) throw new ToolError(`"${name}" must be a whole number, 1 or more.`);
  return /** @type {number} */ (v);
}

/** @param {string} abs @param {string} rel @param {number} maxBytes */
function readText(abs, rel, maxBytes) {
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    throw new ToolError(notFoundMessage(rel));
  }
  if (!st.isFile()) throw new ToolError(`${rel} is a folder, not a file.`);
  if (st.size > maxBytes) throw new ToolError(`${rel} is too large to read (${st.size} bytes).`);
  const buf = fs.readFileSync(abs);
  if (buf.includes(0)) throw new ToolError(`${rel} looks like a binary file, which cannot be read.`);
  return buf.toString('utf8');
}

/** @param {string} text */
function splitLines(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

export const DEFINITIONS = [
  {
    name: 'list_files',
    description: 'List one folder of the app (not recursive). Folders end with "/".',
    input_schema: {
      type: 'object',
      properties: { dir: { type: 'string', description: 'Folder, relative to the app root. Omit for the root.' } },
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file with line numbers (at most 2000 lines; use from_line and to_line for more).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the app root, forward slashes.' },
        from_line: { type: 'integer', minimum: 1 },
        to_line: { type: 'integer', minimum: 1 },
      },
      required: ['path'],
    },
  },
  {
    name: 'search',
    description: 'Find literal text (not a regex) in the app files. At most 100 matches as path:line: text.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Exact text, case-sensitive, 1 to 200 characters.' },
        dir: { type: 'string', description: 'Only search this folder.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or fully replace a file (max 200 KB). Folders are created.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace text in a file. old_text must appear EXACTLY ONCE or the edit is refused; add surrounding text to make it unique.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file (not server.js or evolv.json).',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'finish',
    description: 'Call when the change is complete, with ONE sentence a non-developer would understand.',
    input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  },
];

/** Lines of old_text without line-ending noise or blank lines at either end. @param {string} oldText */
function oldLinesOf(oldText) {
  const lines = oldText.replace(/\r/g, '').split('\n');
  while (lines.length && lines[0].trim() === '') lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

/**
 * Where whole lines of the file equal the lines of old_text once indentation and trailing spaces are ignored.
 * @param {string} text @param {string} oldText
 */
function looseLineMatch(text, oldText) {
  const oldLines = oldLinesOf(oldText);
  const fileLines = text.split('\n');
  /** @type {number[]} */
  const hits = [];
  if (oldLines.length) {
    const want = oldLines.map((l) => l.trim());
    for (let i = 0; i + want.length <= fileLines.length; i++) {
      if (want.every((w, j) => fileLines[i + j].replace(/\r/g, '').trim() === w)) hits.push(i);
    }
  }
  return { oldLines, fileLines, hits };
}

/** Replaces the one loosely matched block, keeping the file's own indentation and line endings. */
function writeLoose(/** @type {string} */ abs, /** @type {string} */ rel, /** @type {string} */ text, /** @type {any} */ loose, /** @type {string} */ newText) {
  const { oldLines, fileLines, hits } = loose;
  const i = hits[0];
  const k = oldLines.length;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indentOf = (/** @type {string} */ l) => /^[ \t]*/.exec(l)?.[0] ?? '';
  const fileIndent = indentOf(fileLines[i]);
  const oldIndent = indentOf(oldLines[0]);
  const start = fileLines.slice(0, i).reduce((n, l) => n + l.length + 1, 0);
  let end = start + fileLines.slice(i, i + k).join('\n').length;
  if (fileLines[i + k - 1].endsWith('\r')) end -= 1; // keep the line's own CR
  const replacement = newText
    .replace(/\r\n/g, '\n')
    .replace(/\n$/, '')
    .split('\n')
    .map((l) => (l.trim() === '' ? l : l.startsWith(oldIndent) ? fileIndent + l.slice(oldIndent.length) : l))
    .join(eol);
  const result = text.slice(0, start) + replacement + text.slice(end);
  if (Buffer.byteLength(result, 'utf8') > LIMITS.maxWriteBytes) throw new ToolError('The edited file would be larger than 200 KB.');
  fs.writeFileSync(abs, result, 'utf8');
  return ok(`Edited ${rel} (old_text matched ignoring indentation).`, { file: rel });
}

/** "Not found", plus the real lines where old_text's first line is, so the next try can copy them. */
function notFoundWithHint(/** @type {string} */ rel, /** @type {string} */ text, /** @type {string} */ oldText) {
  const base = `old_text not found in ${rel}. It must match the file exactly, including spaces and line breaks.`;
  const oldLines = oldLinesOf(oldText);
  if (!oldLines.length) return `${base} Read the file again.`;
  const first = oldLines[0].trim();
  const fileLines = text.split('\n').map((l) => l.replace(/\r/g, ''));
  const at = fileLines.findIndex((l) => l.trim() === first);
  if (at < 0) return `${base} Read the file again.`;
  const shown = fileLines
    .slice(at, at + Math.min(oldLines.length, 6))
    .map((l, j) => `${at + 1 + j}: ${l.length > 160 ? `${l.slice(0, 160)}...` : l}`)
    .join('\n');
  return `${base} Its first line is at line ${at + 1}, where the file has:\n${shown}\nCopy the text exactly from there.`;
}

/**
 * @param {{ root: string }} o  root = absolute path of the staging workspace
 */
export function createTools({ root }) {
  /** @type {Record<string, (input: any) => { ok: boolean, content: string, finish?: { summary: string }, file?: string }>} */
  const impl = {
    list_files(input) {
      const { abs, rel, segments } = guard(root, input.dir, { allowRoot: true });
      let entries;
      try {
        if (!fs.statSync(abs).isDirectory()) throw new Error('not a dir');
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        throw new ToolError(notFoundMessage(rel || '.'));
      }
      const shown = entries
        .filter((e) => !e.name.startsWith('.') && !e.isSymbolicLink() && !isProtected([...segments, e.name]))
        .map((e) => ({ name: e.name, dir: e.isDirectory(), size: e.isDirectory() ? 0 : fs.statSync(path.join(abs, e.name)).size }))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
      const lines = shown.slice(0, LIMITS.maxListEntries).map((e) => (e.dir ? `${e.name}/` : `${e.name} (${e.size} bytes)`));
      if (shown.length > LIMITS.maxListEntries) lines.push(`[showing ${LIMITS.maxListEntries} of ${shown.length} entries]`);
      return ok(lines.join('\n') || '(empty folder)', { file: rel || '.' });
    },

    read_file(input) {
      const { abs, rel } = guard(root, input.path);
      const from = optionalLine(input.from_line, 'from_line') ?? 1;
      const toRequested = optionalLine(input.to_line, 'to_line');
      if (toRequested !== undefined && toRequested < from) throw new ToolError('"to_line" must not be smaller than "from_line".');
      const lines = splitLines(readText(abs, rel, LIMITS.maxFileReadBytes));
      if (lines.length === 0) return ok('(empty file)', { file: rel });
      if (from > lines.length) throw new ToolError(`${rel} has only ${lines.length} lines.`);
      const wanted = toRequested ?? from + LIMITS.maxReadLines - 1;
      const to = Math.min(wanted, lines.length, from + LIMITS.maxReadLines - 1);
      const body = lines
        .slice(from - 1, to)
        .map((l, i) => `${String(from + i).padStart(5)}\t${l}`)
        .join('\n');
      const note =
        to < lines.length && (toRequested === undefined || toRequested > to)
          ? `\n[showing lines ${from}-${to} of ${lines.length}; use from_line and to_line to read more]`
          : '';
      return ok(body + note, { file: rel });
    },

    search(input) {
      const pattern = needString(input.pattern, 'pattern');
      if (pattern.length < 1 || pattern.length > LIMITS.maxPatternChars) throw new ToolError(`"pattern" must be 1 to ${LIMITS.maxPatternChars} characters.`);
      const { abs, rel, segments } = guard(root, input.dir, { allowRoot: true });
      try {
        if (!fs.statSync(abs).isDirectory()) throw new Error('not a dir');
      } catch {
        throw new ToolError(notFoundMessage(rel || '.'));
      }
      const matches = [];
      let filesSeen = 0;
      let truncated = false;
      /** @param {string} dirAbs @param {string[]} segs */
      const walk = (dirAbs, segs) => {
        const entries = fs.readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        for (const e of entries) {
          if (truncated) return;
          if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
          const childSegs = [...segs, e.name];
          if (isProtected(childSegs)) continue;
          const childAbs = path.join(dirAbs, e.name);
          if (e.isDirectory()) walk(childAbs, childSegs);
          else if (e.isFile()) {
            if (++filesSeen > LIMITS.maxSearchFiles) return void (truncated = true);
            let buf;
            try {
              if (fs.statSync(childAbs).size > LIMITS.maxSearchFileBytes) continue;
              buf = fs.readFileSync(childAbs);
            } catch {
              continue;
            }
            if (buf.includes(0)) continue;
            const lines = splitLines(buf.toString('utf8'));
            for (let i = 0; i < lines.length; i++) {
              if (!lines[i].includes(pattern)) continue;
              if (matches.length >= LIMITS.maxSearchMatches) return void (truncated = true);
              const text = lines[i].trim().slice(0, LIMITS.maxMatchLineChars);
              matches.push(`${childSegs.join('/')}:${i + 1}: ${text}`);
            }
          }
        }
      };
      walk(abs, segments);
      if (matches.length === 0) return ok('(no matches)');
      const note = truncated ? `\n[showing the first ${LIMITS.maxSearchMatches} matches; narrow the search with dir or a longer pattern]` : '';
      return ok(matches.join('\n') + note);
    },

    write_file(input) {
      const { abs, rel } = guard(root, input.path, { forWrite: true });
      const content = needString(input.content, 'content');
      if (Buffer.byteLength(content, 'utf8') > LIMITS.maxWriteBytes) throw new ToolError('The content is too large: the limit is 200 KB.');
      if (content.includes('\0')) throw new ToolError('The content contains a NUL byte; only text files are allowed.');
      let existed = false;
      try {
        const st = fs.statSync(abs);
        if (st.isDirectory()) throw new ToolError(`${rel} is a folder.`);
        existed = true;
      } catch (err) {
        if (err instanceof ToolError) throw err;
      }
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
      } catch {
        throw new ToolError(`Could not write ${rel}.`);
      }
      return ok(`${existed ? 'Overwrote' : 'Created'} ${rel} (${Buffer.byteLength(content, 'utf8')} bytes).`, { file: rel });
    },

    edit_file(input) {
      const { abs, rel } = guard(root, input.path);
      const oldText = needString(input.old_text, 'old_text');
      const newText = needString(input.new_text, 'new_text');
      if (oldText === '') throw new ToolError('"old_text" must not be empty.');
      if (oldText === newText) throw new ToolError('"old_text" and "new_text" are identical, so nothing would change.');
      const text = readText(abs, rel, LIMITS.maxFileReadBytes);
      let count = 0;
      let at = -1;
      for (let i = text.indexOf(oldText); i !== -1; i = text.indexOf(oldText, i + oldText.length)) {
        count++;
        if (count === 1) at = i;
      }
      if (count === 0) {
        // A small model often gets indentation or line endings slightly wrong. Rather than fail (a whole
        // extra round trip), accept ONE unambiguous match of whole lines that ignores them.
        const loose = looseLineMatch(text, oldText);
        if (loose.hits.length === 1) return writeLoose(abs, rel, text, loose, newText);
        if (loose.hits.length > 1) {
          throw new ToolError(`old_text occurs ${loose.hits.length} times in ${rel} (ignoring indentation). Include more surrounding text so it matches exactly once.`);
        }
        throw new ToolError(notFoundWithHint(rel, text, oldText));
      }
      if (count > 1) {
        throw new ToolError(`old_text occurs ${count} times in ${rel}. Include more surrounding text so it matches exactly once.`);
      }
      const result = text.slice(0, at) + newText + text.slice(at + oldText.length); // literal: no $ patterns
      if (Buffer.byteLength(result, 'utf8') > LIMITS.maxWriteBytes) throw new ToolError('The edited file would be larger than 200 KB.');
      fs.writeFileSync(abs, result, 'utf8');
      return ok(`Edited ${rel}.`, { file: rel });
    },

    delete_file(input) {
      const { abs, rel, segments } = guard(root, input.path);
      if (segments.length === 1 && LIMITS.undeletable.includes(segments[0].toLowerCase())) {
        throw new ToolError(`${rel} cannot be deleted: it is the app's entry point or its evolv.json.`);
      }
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        throw new ToolError(notFoundMessage(rel));
      }
      if (!st.isFile()) throw new ToolError(`${rel} is a folder; only files can be deleted.`);
      fs.unlinkSync(abs);
      return ok(`Deleted ${rel}.`, { file: rel });
    },

    finish(input) {
      const summary = typeof input.summary === 'string' ? input.summary.trim() : '';
      if (summary === '') throw new ToolError('"summary" must be one sentence describing the change.');
      if (summary.length > LIMITS.maxSummaryChars) throw new ToolError(`"summary" is too long (maximum ${LIMITS.maxSummaryChars} characters). Use one short sentence.`);
      return ok('Finished.', { finish: { summary } });
    },
  };

  return {
    definitions: DEFINITIONS,
    /**
     * Runs a tool. Never throws.
     * @param {unknown} name @param {unknown} input
     */
    execute(name, input) {
      try {
        if (typeof name !== 'string' || !Object.hasOwn(impl, name)) return fail(`Unknown tool "${String(name)}".`);
        if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail('The tool input must be an object.');
        return impl[name](input);
      } catch (err) {
        if (err instanceof ToolError) return fail(err.message);
        return fail('The tool failed unexpectedly. Try a different approach.');
      }
    },
  };
}
