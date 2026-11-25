// The change lifecycle (PRD section 5, steps 1 to 3): admit, stage, let the agent edit.
// Verification and promotion are B3, so for now a finished change reports what the agent did
// and then discards the staging copy. The live app is never touched.
import crypto from 'node:crypto';
import { createWorkspace } from './workspace.js';
import { createTools } from './tools.js';
import { runAgent } from './agent.js';

const STATUS = {
  invalid_request: 400,
  busy: 409,
  cancelled: 409,
  agent_limit: 422,
  budget_exhausted: 429,
  provider_error: 502,
  ledger_unreadable: 503,
  internal_error: 500,
};

export class ChangeError extends Error {
  /** @param {string} code @param {string} message @param {number} [httpStatus] */
  constructor(code, message, httpStatus) {
    super(message);
    this.name = 'ChangeError';
    this.code = code;
    this.httpStatus = httpStatus ?? /** @type {Record<string, number>} */ (STATUS)[code] ?? 500;
  }
}

/** @param {unknown} err */
function toChangeError(err) {
  if (err instanceof ChangeError) return err;
  const e = /** @type {any} */ (err);
  if (e && typeof e.code === 'string' && e.code in STATUS) return new ChangeError(e.code, e.message);
  return new ChangeError('internal_error', 'Something went wrong while preparing the change.');
}

/** 128 random bits, URL-safe. Unguessable, and carries no information. */
export const newChangeId = () => crypto.randomBytes(16).toString('base64url');

/**
 * 1 to 4,000 characters of text, no control characters except newline and tab.
 * @param {unknown} text
 */
export function validateRequest(text) {
  if (typeof text !== 'string') throw new ChangeError('invalid_request', 'The request must be text.');
  const trimmed = text.trim();
  if (trimmed.length < 1) throw new ChangeError('invalid_request', 'The request is empty. Describe the change you want.');
  if (trimmed.length > 4000) throw new ChangeError('invalid_request', 'The request is too long. Keep it under 4,000 characters.');
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) throw new ChangeError('invalid_request', 'The request contains characters that are not allowed.');
  return trimmed;
}

export class ChangeRunner {
  /**
   * @param {{
   *   appDir: string, workspacesDir: string,
   *   provider: { assertReady: () => void, complete: Function },
   *   ledger: import('./budget.js').Ledger,
   *   maxSteps: number, timeoutMs: number,
   *   onEvent?: (e: Record<string, unknown>) => void,
   * }} o
   */
  constructor({ appDir, workspacesDir, provider, ledger, maxSteps, timeoutMs, onEvent = () => {} }) {
    Object.assign(this, { appDir, workspacesDir, provider, ledger, maxSteps, timeoutMs, onEvent });
    /** @type {string|null} */
    this.activeId = null;
    /** @type {AbortController|null} */
    this.controller = null;
  }

  /**
   * Admits a change, or throws ChangeError BEFORE any staging or AI call.
   * @param {unknown} requestText
   * @returns {{ id: string, done: Promise<{ id: string, summary: string, changedFiles: { path: string, status: string }[], diff: string, usage: { tokens: number, steps: number } }> }}
   */
  start(requestText) {
    const request = validateRequest(requestText);
    if (this.activeId) throw new ChangeError('busy', 'Another change is already running. Wait for it to finish, or cancel it.');
    try {
      this.ledger.assertCanStartChange();
    } catch (err) {
      throw toChangeError(err);
    }
    try {
      this.provider.assertReady();
    } catch (err) {
      throw toChangeError(err);
    }

    const id = newChangeId();
    this.activeId = id; // taken synchronously: a second start in the same tick sees "busy"
    const controller = new AbortController();
    this.controller = controller;
    const done = this.#run(id, request, controller.signal).finally(() => {
      this.activeId = null;
      this.controller = null;
    });
    done.catch(() => {}); // the caller handles errors; this only prevents an unhandled-rejection crash
    return { id, done };
  }

  /** @param {string} id @returns {boolean} true if a running change was told to stop */
  cancel(id) {
    if (!this.activeId || id !== this.activeId || !this.controller) return false;
    this.controller.abort();
    return true;
  }

  /** @param {string} type @param {string} changeId @param {Record<string, unknown>} [data] */
  #emit(type, changeId, data = {}) {
    this.onEvent({ ...data, type, changeId });
  }

  /** @param {string} id @param {string} request @param {AbortSignal} signal */
  async #run(id, request, signal) {
    /** @type {Awaited<ReturnType<typeof createWorkspace>>|null} */
    let ws = null;
    try {
      ws = await createWorkspace({ appDir: this.appDir, workspacesDir: this.workspacesDir, id });
      this.#emit('staged', id);
      const agent = await runAgent({
        provider: this.provider,
        tools: createTools({ root: ws.dir }),
        request,
        ledger: this.ledger,
        changeId: id,
        maxSteps: this.maxSteps,
        timeoutMs: this.timeoutMs,
        signal,
        onEvent: (e) => this.#emit(e.type, id, e),
      });
      const changedFiles = await ws.changedFiles();
      const diff = await ws.diff();
      return { id, summary: agent.summary, changedFiles, diff, usage: { tokens: this.ledger.changeUsed(id), steps: agent.steps } };
    } catch (err) {
      throw toChangeError(err);
    } finally {
      if (ws) await ws.discard().catch(() => {}); // B3 keeps it for verification instead
    }
  }
}
