// The change lifecycle (PRD section 5): admit, stage, agent edits, verify, promote, discard.
// The live app is touched only by promote(), and only after verification passed. Every other
// outcome (failure, cancel) discards the staging copy and leaves the live app exactly as it was.
import crypto from 'node:crypto';
import { createWorkspace } from '../models/workspace.js';
import { createTools } from './tools.js';
import { runAgent } from './agent.js';
import { CHANGE_ERROR_STATUS as STATUS } from '../constants/changes.js';


export class ChangeError extends Error {
  /** @param {string} code @param {string} message @param {number} [httpStatus] @param {Record<string, unknown>} [extra] */
  constructor(code, message, httpStatus, extra = {}) {
    super(message);
    this.name = 'ChangeError';
    this.code = code;
    this.httpStatus = httpStatus ?? /** @type {Record<string, number>} */ (STATUS)[code] ?? 500;
    this.expose = true; // the message is written for users
    Object.assign(this, extra);
  }
}

/** @param {unknown} err */
function toChangeError(err) {
  if (err instanceof ChangeError) return err;
  const e = /** @type {any} */ (err);
  if (e && typeof e.code === 'string' && e.code in STATUS) {
    const extra = {};
    for (const k of ['rolledBack', 'restoredHealthy', 'output', 'checks']) if (e[k] !== undefined) /** @type {any} */ (extra)[k] = e[k];
    return new ChangeError(e.code, e.message, undefined, extra);
  }
  return new ChangeError('internal_error', 'Something went wrong while preparing the change. Your app was not changed.');
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

/** What a browser is told when a change ends badly. @param {ChangeError} err */
function failureData(err) {
  const e = /** @type {any} */ (err);
  const unchanged = /not changed|unchanged|nothing was lost|previous version/i.test(err.message);
  // Two sentences must never run together ("...as JSON Your app was not changed").
  const sentence = /[.!?)]$/.test(err.message.trim()) ? err.message : `${err.message}.`;
  return {
    code: err.code,
    message: unchanged ? err.message : `${sentence} Your app was not changed.`,
    ...(e.output ? { output: e.output } : {}),
    ...(Array.isArray(e.checks) ? { checks: e.checks.map((/** @type {any} */ c) => ({ name: c.name, ok: c.ok, ...(c.detail ? { detail: c.detail } : {}) })) } : {}),
  };
}

export class ChangeRunner {
  /**
   * @param {{
   *   appDir: string, workspacesDir: string,
   *   provider: { assertReady: () => void, complete: Function },
   *   ledger: import('../models/ledger.js').Ledger,
   *   maxSteps: number, timeoutMs: number,
   *   verify?: (ws: any, o: { signal: AbortSignal, onCheck: (c: any) => void }) => Promise<{ ok: boolean, checks: any[], output: string, message: string }>,
   *   promote?: (a: { workspace: any, meta: any, log: (line: string) => void }) => Promise<{ id: number }>,
   *   onEvent?: (e: Record<string, unknown>) => void,
   *   log?: (line: string) => void,
   * }} o
   */
  constructor({ appDir, workspacesDir, provider, ledger, maxSteps, timeoutMs, verify, promote, onEvent = () => {}, log = () => {} }) {
    Object.assign(this, { appDir, workspacesDir, provider, ledger, maxSteps, timeoutMs, verify, promote, onEvent, log });
    /** @type {string|null} */
    this.activeId = null;
    /** 'agent' | 'verify' | 'promote' while a change runs, otherwise null. @type {string|null} */
    this.phase = null;
    /** Set when a new version was rolled back; cleared by the next successful change. @type {{ kind: string, message: string, at: string }|null} */
    this.notice = null;
    /** @type {AbortController|null} */
    this.controller = null;
  }

  /**
   * Admits a change, or throws ChangeError BEFORE any staging or AI call.
   * @param {unknown} requestText
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
    this.#emit('accepted', id); // synchronous, so a client can subscribe the instant it has the id

    const release = () => {
      this.activeId = null;
      this.phase = null;
      this.controller = null;
    };
    // Terminal events are announced only after the runner is free and the workspace is gone.
    const done = this.#run(id, request, controller.signal).then(
      (result) => {
        release();
        this.notice = null;
        this.#emit('done', id, { version: result.version.id, summary: result.summary, files: result.changedFiles.map((f) => f.path), tokens: result.usage.tokens, steps: result.usage.steps });
        return result;
      },
      (err) => {
        release();
        this.#emit('failed', id, failureData(err));
        throw err;
      },
    );
    done.catch(() => {}); // the caller handles errors; this only prevents an unhandled-rejection crash
    return { id, done };
  }

  /**
   * Stops a running change. Returns false if there is nothing to stop, or it is too late (once
   * promotion begins the swap cannot be interrupted).
   * @param {string} id
   */
  cancel(id) {
    if (!this.activeId || id !== this.activeId || !this.controller) return false;
    if (this.phase === 'promote') return false;
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
    const cancelled = () => new ChangeError('cancelled', 'The change was cancelled.');
    try {
      ws = await createWorkspace({ appDir: this.appDir, workspacesDir: this.workspacesDir, id });
      this.#emit('staged', id);

      this.phase = 'agent';
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
      if (changedFiles.length === 0) {
        throw new ChangeError('no_changes', 'The assistant finished without changing anything, so there is nothing to apply. Your app is unchanged.');
      }
      const diff = await ws.diff();

      if (signal.aborted) throw cancelled();
      this.phase = 'verify';
      const verdict = await /** @type {NonNullable<typeof this.verify>} */ (this.verify)(ws, { signal, onCheck: (c) => this.#emit('verify', id, c) });
      if (!verdict.ok) {
        throw new ChangeError('verify_failed', `The change did not pass the automatic checks, so your app was not changed. ${verdict.message}`, undefined, { output: verdict.output, checks: verdict.checks });
      }

      if (signal.aborted) throw cancelled();
      this.phase = 'promote'; // the point of no return: cancel() now returns false
      this.#emit('promoting', id);
      const version = await /** @type {NonNullable<typeof this.promote>} */ (this.promote)({
        workspace: ws,
        meta: { request, summary: agent.summary, files: changedFiles, tokens: this.ledger.changeUsed(id) },
        log: this.log,
      });
      return { id, summary: agent.summary, changedFiles, diff, usage: { tokens: this.ledger.changeUsed(id), steps: agent.steps }, version };
    } catch (err) {
      const e = toChangeError(err);
      if (e.code === 'swap_failed' && /** @type {any} */ (e).rolledBack) {
        this.notice = { kind: 'rolled_back', message: e.message, at: new Date().toISOString() };
        this.log(`[supervisor] The new version did not start, so it was rolled back. ${e.message}`);
      }
      throw e;
    } finally {
      if (ws) await ws.discard().catch(() => {});
    }
  }
}
