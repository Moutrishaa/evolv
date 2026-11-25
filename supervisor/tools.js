// The seven agent tools (PRD section 7). They reach only the staging workspace, every path
// goes through the path guard, and a tool error is a result, never an exception.
//
// Deliberate change from the full PRD: `search` matches literal text, not a regular
// expression. An AI-written regex could freeze the supervisor, and the recovery console with it.
import fs from 'node:fs';
import path from 'node:path';
import { resolveInRoot, isProtected, PathGuardError } from './pathguard.js';

export const LIMITS = Object.freeze({
  maxReadLines: 2000,
  maxSearchMatches: 100,
  maxWriteBytes: 200 * 1024,
  maxListEntries: 500,
  maxFileReadBytes: 2 * 1024 * 1024,
  maxSearchFileBytes: 1024 * 1024,
  maxSearchFiles: 5000,
  maxPatternChars: 200,
  maxMatchLineChars: 200,
  maxResultChars: 60_000,
  maxSummaryChars: 600,
  undeletable: ['server.js', 'evolv.json'], // the entry point and the smoke list, at the app root
});

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
    description: 'List the files and folders in one folder of the app (not recursive). Folders end with "/". Hidden files are not shown.',
    input_schema: {
      type: 'object',
      properties: { dir: { type: 'string', description: 'Folder to list, relative to the app root. Omit for the root.' } },
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file with line numbers. Returns at most 2000 lines; use from_line and to_line to read more.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the app root, using forward slashes.' },
        from_line: { type: 'integer', minimum: 1 },
        to_line: { type: 'integer', minimum: 1 },
      },
      required: ['path'],
    },
  },
  {
    name: 'search',
    description: 'Find a piece of literal text (not a regular expression) in the app files. Returns at most 100 matches as path:line: text.',
    input_schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The exact text to look for, case-sensitive, 1 to 200 characters.' },
        dir: { type: 'string', description: 'Only search inside this folder. Omit to search everywhere.' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'write_file',
    description: 'Create a file or replace it completely. Missing folders are created. Maximum 200 KB of text.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Replace a piece of text in an existing file. old_text must appear EXACTLY ONCE in the file, otherwise the edit is refused. Include enough surrounding text to make it unique.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete one file. The entry point (server.js) and evolv.json cannot be deleted.',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'finish',
    description: 'Call this when the change is complete. Give ONE sentence, written for a non-developer, saying what changed.',
    input_schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
  },
];

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
        throw new ToolError(`old_text not found in ${rel}. It must match the file exactly, including spaces and line breaks. Read the file again.`);
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
