// Progress events for each change, streamed to browsers as Server-Sent Events.
// App pages are untrusted, so: strict connection limits, bounded history, ids that cannot be
// guessed, and every payload is sanitised (no control characters, no real paths, capped size).


import { TERMINAL_EVENTS as TERMINAL } from '../constants/changes.js';
import { EVENT_MAX_STRING as MAX_STRING } from '../constants/limits.js';

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class EventHub {
  /**
   * @param {{ maxChanges?: number, ttlMs?: number, maxPerChange?: number, maxTotal?: number,
   *   heartbeatMs?: number, maxEvents?: number, scrubPaths?: string[], now?: () => number }} [o]
   */
  constructor({ maxChanges = 5, ttlMs = 15 * 60 * 1000, maxPerChange = 5, maxTotal = 20, heartbeatMs = 15000, maxEvents = 500, scrubPaths = [], now = Date.now } = {}) {
    Object.assign(this, { maxChanges, ttlMs, maxPerChange, maxTotal, heartbeatMs, maxEvents, now });
    /** @type {Map<string, { events: { id: number, type: string, data: any }[], seq: number, finished: boolean, finishedAt: number, subs: Set<any> }>} */
    this.changes = new Map();
    this.total = 0;
    const variants = scrubPaths.filter(Boolean).flatMap((p) => [p, p.replace(/\\/g, '/')]);
    this.scrub = [...new Set(variants)].sort((a, b) => b.length - a.length).map((p) => new RegExp(escapeRe(p), process.platform === 'win32' ? 'gi' : 'g'));
  }

  /** @param {unknown} v @param {number} [depth] */
  #sanitize(v, depth = 0) {
    if (typeof v === 'string') {
      let s = v.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
      for (const re of this.scrub) s = s.replace(re, '<app>');
      return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}...` : s;
    }
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) return v;
    if (depth >= 5) return undefined;
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => this.#sanitize(x, depth + 1));
    if (v && typeof v === 'object') {
      /** @type {Record<string, unknown>} */
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        const clean = this.#sanitize(x, depth + 1);
        if (clean !== undefined) out[k] = clean;
      }
      return out;
    }
    return undefined;
  }

  #evict() {
    const t = this.now();
    for (const [id, c] of this.changes) if (c.finished && t - c.finishedAt > this.ttlMs) this.changes.delete(id);
    const finished = [...this.changes.entries()].filter(([, c]) => c.finished).sort((a, b) => a[1].finishedAt - b[1].finishedAt);
    while (finished.length > this.maxChanges) {
      const [id] = /** @type {[string, any]} */ (finished.shift());
      this.changes.delete(id);
    }
  }

  /** @param {{ type: string, changeId: string } & Record<string, unknown>} event */
  publish(event) {
    const { type: rawType, changeId, ...rest } = event;
    const type = String(rawType).replace(/[^a-z_]/g, '') || 'message';
    let c = this.changes.get(changeId);
    if (!c) {
      c = { events: [], seq: 0, finished: false, finishedAt: 0, subs: new Set() };
      this.changes.set(changeId, c);
    }
    if (c.finished) return; // a finished change is never reopened
    const ev = { id: ++c.seq, type, data: this.#sanitize(rest) ?? {} };
    c.events.push(ev);
    while (c.events.length > this.maxEvents) c.events.splice(1, 1); // keep the first event, drop the oldest after it
    const terminal = TERMINAL.has(type);
    for (const sub of c.subs) this.#write(sub, ev);
    if (terminal) {
      c.finished = true;
      c.finishedAt = this.now();
      for (const sub of [...c.subs]) sub.res.end();
    }
    this.#evict();
  }

  /** @param {string} id */
  has(id) {
    this.#evict();
    return this.changes.has(id);
  }

  /** @param {string} id @returns {{ id: number, type: string, data: any }[]} */
  history(id) {
    return this.changes.get(id)?.events.slice() ?? [];
  }

  connections() {
    return this.total;
  }

  /** @param {string} id @returns {'ok'|'unknown'|'too_many'} */
  check(id) {
    this.#evict();
    const c = this.changes.get(id);
    if (!c) return 'unknown';
    if (c.subs.size >= this.maxPerChange || this.total >= this.maxTotal) return 'too_many';
    return 'ok';
  }

  /** Writes the history, then follows live until the change finishes or the client leaves. */
  subscribe(/** @type {string} */ id, /** @type {import('node:http').ServerResponse} */ res, /** @type {import('node:http').IncomingMessage} */ req) {
    const c = this.changes.get(id);
    if (!c) return res.end();
    const lastHeader = Number(req?.headers?.['last-event-id']);
    const last = Number.isInteger(lastHeader) && lastHeader >= 0 ? lastHeader : 0;
    const sub = { res, timer: /** @type {any} */ (null), closed: false };
    for (const ev of c.events) if (ev.id > last) this.#write(sub, ev);
    if (c.finished) return res.end();

    sub.timer = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(':\n\n');
    }, this.heartbeatMs);
    sub.timer.unref();
    c.subs.add(sub);
    this.total++;
    const cleanup = () => {
      if (sub.closed) return;
      sub.closed = true;
      clearInterval(sub.timer);
      c.subs.delete(sub);
      this.total--;
    };
    res.on('close', cleanup);
    res.on('finish', cleanup);
  }

  #write(/** @type {{ res: import('node:http').ServerResponse }} */ sub, /** @type {{ id: number, type: string, data: any }} */ ev) {
    const { res } = sub;
    if (res.writableEnded || res.destroyed) return;
    if (res.writableLength > 1024 * 1024) return void res.destroy(); // a client that never reads is cut off
    res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`);
  }
}
