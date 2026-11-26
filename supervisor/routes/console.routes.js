// CONSOLE origin (CONSOLE_PORT): the recovery console UI and the full API.
// Every /api call needs "Authorization: Bearer <key>" plus a strict Origin check.
// There are no cookies. The page never proxies to the app.
import fs from 'node:fs';
import path from 'node:path';
import { bearerMatches } from '../middleware/auth.js';
import { SAFE_METHODS, CONSOLE_FILES } from '../constants/http.js';
import { PARAM_RE } from '../constants/patterns.js';
import { fail, failFrom, send, respond, readJsonBody, hostsFor, originsFor, originAllowed, decodePath } from '../middleware/http.js';
import { matchRoute } from './router.js';
import { withBanner } from '../views/html.js';

/**
 * @param {{ port: number, consoleDir: string, key: string, routes: import('./router.js').Routes, banner?: string }} o
 */
export function createConsoleApi({ port, consoleDir, key, routes, banner }) {
  const hosts = hostsFor(port);
  const origins = originsFor(port);
  return {
    /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
    async handle(req, res) {
      try {
        if (!hosts.has(String(req.headers.host ?? '').toLowerCase())) return fail(res, 403, 'forbidden', 'Unexpected Host header.');
        const method = req.method ?? 'GET';
        if (method === 'OPTIONS') return fail(res, 403, 'forbidden', 'Cross-origin requests are not allowed.');
        const pathname = decodePath(new URL(req.url ?? '/', 'http://x').pathname);
        if (pathname === null) return fail(res, 400, 'invalid_request', 'Bad path.');

        if (pathname === '/api' || pathname.startsWith('/api/')) {
          if (!bearerMatches(req.headers.authorization, key)) return fail(res, 401, 'unauthorized', 'A valid console token is required.');
          if (!originAllowed(req, origins)) return fail(res, 403, 'forbidden', 'Origin not allowed.');
          const hit = matchRoute(routes, method, pathname.slice('/api'.length), PARAM_RE);
          if (!hit) return fail(res, 404, 'not_found', 'No such API route.');
          const result = await hit.handler(req, { params: hit.params, readJson: () => readJsonBody(req) });
          return respond(req, res, result);
        }

        if (!SAFE_METHODS.has(method)) return fail(res, 404, 'not_found', 'Not found.');
        const name = pathname.replace(/^\//, '');
        const entry = Object.hasOwn(CONSOLE_FILES, name) ? CONSOLE_FILES[/** @type {keyof typeof CONSOLE_FILES} */ (name)] : null;
        if (!entry) return fail(res, 404, 'not_found', 'Not found.');
        let body = fs.readFileSync(path.join(consoleDir, entry[0]));
        if (banner && entry[0] === 'index.html') body = Buffer.from(withBanner(body.toString('utf8'), banner));
        return send(res, 200, { 'Content-Type': entry[1] }, method === 'HEAD' ? undefined : body);
      } catch (err) {
        failFrom(err, res);
      }
    },
  };
}
