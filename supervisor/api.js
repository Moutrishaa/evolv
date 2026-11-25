// Everything under /_evolv: the console pages and the JSON API (B1: read-only routes).
// Security: Host check on every request (DNS rebinding), and a session cookie plus a
// matching Origin on every state-changing request.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const COOKIE = 'evolv_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The only console files that can ever be served. */
const CONSOLE_FILES = {
  '': ['index.html', 'text/html; charset=utf-8'],
  'index.html': ['index.html', 'text/html; charset=utf-8'],
  'console.js': ['console.js', 'text/javascript; charset=utf-8'],
  'console.css': ['console.css', 'text/css; charset=utf-8'],
};

/**
 * Lowercased, decoded, dot-segments resolved. True if the path lands in /_evolv.
 * Used by the router so no spelling of the path can slip through to the app.
 * @param {string} rawUrl
 */
export function isConsolePath(rawUrl) {
  let p = rawUrl.split('?')[0].split('#')[0];
  try {
    p = decodeURIComponent(p);
  } catch {
    return true; // undecodable: never forward to the app
  }
  p = path.posix.normalize('/' + p.replace(/\\/g, '/')).toLowerCase();
  return p === '/_evolv' || p.startsWith('/_evolv/');
}

/**
 * @typedef {{ status: number, body: unknown }} RouteResult
 * @param {{
 *   port: number,
 *   consoleDir: string,
 *   routes: Record<string, (req: import('node:http').IncomingMessage) => RouteResult | Promise<RouteResult>>
 * }} o  routes are keyed "METHOD /path", the path relative to /_evolv/api
 */
export function createApi({ port, consoleDir, routes }) {
  const token = crypto.randomBytes(32).toString('hex');
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

  /** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
  function json(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Evolv-Supervisor': '1',
    });
    res.end(JSON.stringify(body));
  }
  const fail = (/** @type {any} */ res, /** @type {number} */ status, /** @type {string} */ code, /** @type {string} */ message) =>
    json(res, status, { error: { code, message } });

  /** @param {string|undefined} header */
  function hasValidToken(header) {
    const m = (header ?? '').split(';').map((s) => s.trim()).find((c) => c.startsWith(`${COOKIE}=`));
    if (!m) return false;
    const given = Buffer.from(m.slice(COOKIE.length + 1));
    const want = Buffer.from(token);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  }

  return {
    /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
    async handle(req, res) {
      try {
        if (!allowedHosts.has(String(req.headers.host ?? '').toLowerCase())) {
          return fail(res, 403, 'forbidden', 'Unexpected Host header.');
        }
        const method = req.method ?? 'GET';
        const url = new URL(req.url ?? '/', 'http://x');
        let rel = decodeURIComponent(url.pathname).replace(/^\/_evolv/i, '');

        if (!SAFE_METHODS.has(method)) {
          if (!hasValidToken(req.headers.cookie) || !allowedOrigins.has(String(req.headers.origin ?? ''))) {
            return fail(res, 403, 'forbidden', 'Missing or invalid session token or Origin.');
          }
        }

        if (rel.startsWith('/api/') || rel === '/api') {
          const handler = routes[`${method} ${rel.slice(4)}`];
          if (!handler) return fail(res, 404, 'not_found', 'No such API route.');
          const result = await handler(req);
          return json(res, result.status, result.body);
        }

        if (method !== 'GET' && method !== 'HEAD') return fail(res, 404, 'not_found', 'Not found.');
        rel = rel.replace(/^\//, '');
        const entry = Object.hasOwn(CONSOLE_FILES, rel) ? CONSOLE_FILES[/** @type {keyof typeof CONSOLE_FILES} */ (rel)] : null;
        if (!entry) return fail(res, 404, 'not_found', 'Not found.');
        const body = fs.readFileSync(path.join(consoleDir, entry[0]));
        /** @type {Record<string,string>} */
        const headers = { 'Content-Type': entry[1], 'Cache-Control': 'no-store', 'X-Evolv-Supervisor': '1' };
        if (entry[0] === 'index.html') {
          headers['Set-Cookie'] = `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/_evolv`;
        }
        res.writeHead(200, headers);
        res.end(method === 'HEAD' ? undefined : body);
      } catch {
        if (!res.headersSent) fail(res, 500, 'internal_error', 'Something went wrong in the supervisor.');
        else res.destroy();
      }
    },
  };
}
