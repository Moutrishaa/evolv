// The token ledger (M-U1, M-U2, M-U3). Persistent, atomic, and fail-closed: a damaged
// file blocks new changes and says so in plain words. It is never silently reset to zero,
// because that would quietly un-spend the user's budget.
import fs from 'node:fs';
import path from 'node:path';
import { LEDGER_FILE_VERSION as VERSION } from '../constants/storage.js';

export class BudgetError extends Error {
  /** @param {'budget_exhausted'|'agent_limit'|'ledger_unreadable'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'BudgetError';
    this.code = code;
  }
}

/** One token per 4 characters, always rounded UP, so an estimate never undercounts. */
export const estimateTokens = (/** @type {string} */ text) => Math.ceil(String(text).length / 4);

const isCount = (/** @type {unknown} */ n) => typeof n === 'number' && Number.isInteger(n) && n >= 0;

/** @param {any} d */
function validShape(d) {
  if (!d || typeof d !== 'object' || d.version !== VERSION) return false;
  if (!isCount(d.totalInput) || !isCount(d.totalOutput)) return false;
  if (!d.changes || typeof d.changes !== 'object' || Array.isArray(d.changes)) return false;
  return Object.values(d.changes).every((c) => c && typeof c === 'object' && isCount(/** @type {any} */ (c).input) && isCount(/** @type {any} */ (c).output));
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class Ledger {
  /** @param {{ file: string, totalBudget: number, changeLimit: number }} o */
  constructor({ file, totalBudget, changeLimit }) {
    this.file = file;
    this.totalBudget = totalBudget;
    this.changeLimit = changeLimit;
    /** @type {string|null} */
    this.problem = null;
    this.totalInput = 0;
    this.totalOutput = 0;
    /** @type {Map<string, { input: number, output: number, at: string }>} */
    this.changes = new Map();
    this.#load();
  }

  #load() {
    if (!fs.existsSync(this.file)) return; // first run: nothing spent yet
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!validShape(data)) throw new Error('bad shape');
      this.totalInput = data.totalInput;
      this.totalOutput = data.totalOutput;
      for (const [id, c] of Object.entries(data.changes)) this.changes.set(id, /** @type {any} */ (c));
    } catch {
      this.problem =
        `The usage record is damaged and cannot be read, so no new changes can start ` +
        `(this stops your token budget from being reset by accident). ` +
        `The file is: ${this.file} ` +
        `To fix it, copy the backup "${this.file}.bak" over it, or delete the file to start counting from zero.`;
    }
  }

  #requireReadable() {
    if (this.problem) throw new BudgetError('ledger_unreadable', this.problem);
  }

  used() {
    return this.totalInput + this.totalOutput;
  }
  remaining() {
    return Math.max(0, this.totalBudget - this.used());
  }
  /** @param {string} id */
  changeUsed(id) {
    const c = this.changes.get(id);
    return c ? c.input + c.output : 0;
  }
  snapshot() {
    return { used: this.used(), total: this.totalBudget, remaining: this.remaining(), problem: this.problem };
  }

  /** Called before a change is admitted: refuse before any AI call. */
  assertCanStartChange() {
    this.#requireReadable();
    if (this.used() >= this.totalBudget) {
      throw new BudgetError(
        'budget_exhausted',
        `The token budget is spent (${this.used()} of ${this.totalBudget} tokens used). No new changes can start. Raise TOKEN_BUDGET in the .env file to continue.`,
      );
    }
  }

  /** Called before every AI call inside a change. @param {string} changeId */
  checkBeforeCall(changeId) {
    this.assertCanStartChange();
    const spent = this.changeUsed(changeId);
    if (spent >= this.changeLimit) {
      throw new BudgetError('agent_limit', `This change has used ${spent} tokens, which reaches the per-change limit of ${this.changeLimit} tokens.`);
    }
  }

  /** @param {string} changeId @param {{ inputTokens: number, outputTokens: number }} usage */
  record(changeId, { inputTokens, outputTokens }) {
    this.#requireReadable();
    for (const n of [inputTokens, outputTokens]) {
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw new TypeError('Token counts must be finite numbers, zero or more.');
    }
    const input = Math.ceil(inputTokens);
    const output = Math.ceil(outputTokens);
    const prev = this.changes.get(changeId) ?? { input: 0, output: 0, at: '' };
    this.changes.set(changeId, { input: prev.input + input, output: prev.output + output, at: new Date().toISOString() });
    this.totalInput += input;
    this.totalOutput += output;
    this.#persist();
  }

  #persist() {
    const data = {
      version: VERSION,
      totalInput: this.totalInput,
      totalOutput: this.totalOutput,
      changes: Object.fromEntries(this.changes),
    };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    // Windows can briefly refuse a rename while antivirus or an indexer holds the file.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, this.file);
        return;
      } catch (err) {
        if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(/** @type {any} */ (err).code)) throw err;
        sleepSync(15 * (attempt + 1));
      }
    }
  }
}
