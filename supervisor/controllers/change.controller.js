// The three change routes, registered on BOTH origins (PRD section 10):
//   POST /changes              submit a change             -> 202 { id }
//   POST /changes/:id/cancel   cancel the running change   -> 200 { cancelled: true }
//   GET  /changes/:id/events   progress, as Server-Sent Events
// App pages get exactly these and nothing else. Ids are 128-bit random, so another page cannot
// guess a change to watch or cancel.
import { ChangeError } from '../services/change-runner.js';

/**
 * @param {{
 *   runner: { activeId: string|null, phase: string|null, start: (text: unknown) => { id: string }, cancel: (id: string) => boolean },
 *   hub: { check: (id: string) => 'ok'|'unknown'|'too_many', subscribe: Function },
 * }} o
 */
export function createChangeRoutes({ runner, hub }) {
  return {
    'POST /changes': async (_req, ctx) => {
      const body = /** @type {any} */ (await ctx.readJson());
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.request !== 'string') {
        throw new ChangeError('invalid_request', 'Send a JSON object like {"request": "describe the change"}.');
      }
      const { id } = runner.start(body.request); // throws ChangeError: busy, budget, damaged ledger, bad request
      return { status: 202, body: { id } };
    },

    'POST /changes/:id/cancel': (_req, { params }) => {
      if (params.id !== runner.activeId) throw new ChangeError('not_found', 'There is no running change with that id.', 404);
      if (runner.phase === 'promote') throw new ChangeError('too_late', 'It is too late to cancel: the change is already being applied to your app.', 409);
      runner.cancel(params.id);
      return { status: 200, body: { cancelled: true } };
    },

    'GET /changes/:id/events': (_req, { params }) => {
      const verdict = hub.check(params.id);
      if (verdict === 'unknown') throw new ChangeError('not_found', 'There is no change with that id.', 404);
      if (verdict === 'too_many') throw new ChangeError('rate_limited', 'Too many progress streams are open for this change.', 429);
      return { status: 200, stream: (/** @type {any} */ res, /** @type {any} */ req) => hub.subscribe(params.id, res, req) };
    },
  };
}
