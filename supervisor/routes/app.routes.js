// APP origin (PORT): app pages live here. /_evolv/api offers ONLY submit a change, cancel a change
// and read its progress. Undo, restore, reset, history, status and logs do not exist on this port.
import { SAFE_METHODS } from '../constants/http.js';
import { APP_ID_RE } from '../constants/patterns.js';
import { fail, failFrom, send, respond, readJsonBody, hostsFor, originsFor, originAllowed, decodePath, isConsolePath } from '../middleware/http.js';
import { matchRoute } from './router.js';
import { consolePointerPage } from '../views/html.js';

/**
 * App origin: a pointer page at /_evolv, and the three routes app pages may use.
 * @param {{ port: number, consolePort: number, routes: import('./router.js').Routes, banner?: string }} o
 *   routes are the ONLY routes served under /_evolv/api (submit, cancel, events)
 */
export function createAppApi({ port, consolePort, routes, banner }) {
  const hosts = hostsFor(port);
  const origins = originsFor(port);
  const pointerPage = consolePointerPage({ consolePort, banner });

  return {
    /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
    async handle(req, res) {
      try {
        if (!hosts.has(String(req.headers.host ?? '').toLowerCase())) return fail(res, 403, 'forbidden', 'Unexpected Host header.');
        const method = req.method ?? 'GET';
        if (method === 'OPTIONS') return fail(res, 403, 'forbidden', 'Cross-origin requests are not allowed.');
        const raw = new URL(req.url ?? '/', 'http://x').pathname;

        if ((raw === '/_evolv' || raw === '/_evolv/') && SAFE_METHODS.has(method)) {
          return send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' }, method === 'HEAD' ? undefined : pointerPage);
        }

        // Canonical spelling only. Anything else under /_evolv is a 404.
        if (raw.startsWith('/_evolv/api/')) {
          if (!originAllowed(req, origins)) return fail(res, 403, 'forbidden', 'Origin not allowed.');
          const rel = decodePath(raw.slice('/_evolv/api'.length));
          const hit = rel === null ? null : matchRoute(routes, method, rel, APP_ID_RE);
          if (!hit) return fail(res, 404, 'not_found', 'No such API route.');
          const result = await hit.handler(req, { params: hit.params, readJson: () => readJsonBody(req) });
          return respond(req, res, result);
        }
        return fail(res, 404, 'not_found', 'Not found.');
      } catch (err) {
        failFrom(err, res);
      }
    },
  };
}

/**
 * Front door of the app port: anything that could mean /_evolv goes to the app API,
 * everything else to the proxy.
 * @param {{ appApi: { handle: Function }, proxy: { handle: Function } }} o
 */
export function createFrontHandler({ appApi, proxy }) {
  return (/** @type {any} */ req, /** @type {any} */ res) => {
    if (isConsolePath(req.url ?? '/')) void appApi.handle(req, res);
    else proxy.handle(req, res);
  };
}
