// The supervisor's two faces, on two ports (= two browser origins):
//
//   APP origin     (PORT)         app pages live here. /_evolv/api offers ONLY submit a change,
//                                 cancel a change and read its progress. Undo, restore, reset,
//                                 history, status and logs do not exist on this port.
//   CONSOLE origin (CONSOLE_PORT) the recovery console and the full API. Every /api call needs
//                                 "Authorization: Bearer <key>" plus a strict Origin check.
//                                 There are no cookies. The page never proxies to the app.
//
// Both check the Host header (DNS rebinding) and refuse CORS preflights, so no cross-origin
// page can call either API with a custom header.
import fs from 'node:fs';
import path from 'node:path';
import { bearerMatches } from './auth.js';

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const PARAM_RE = /^[A-Za-z0-9_-]{1,64}$/;
const APP_ID_RE = /^[A-Za-z0-9_-]{22,64}$/; // change ids are 128-bit random: unguessable

/** The only console files that can ever be served. */
const CONSOLE_FILES = {
  '': ['index.html', 'text/html; charset=utf-8'],
  'index.html': ['index.html', 'text/html; charset=utf-8'],
  'console.js': ['console.js', 'text/javascript; charset=utf-8'],
  'console.css': ['console.css', 'text/css; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Evolv-Supervisor': '1',
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
 * @typedef {(req: import('node:http').IncomingMessage, ctx: { params: Record<string,string>, readJson: () => Promise<unknown> }) => any} Handler
 * @typedef {Record<string, Handler>} Routes   keyed "METHOD /path", with ":name" segments
 */

/**
 * @param {Routes} routes @param {string} method @param {string} rel @param {RegExp} paramRe
 * @returns {{ handler: Handler, params: Record<string,string> } | null}
 */
function matchRoute(routes, method, rel, paramRe) {
  const parts = rel.split('/');
  for (const [key, handler] of Object.entries(routes)) {
    const space = key.indexOf(' ');
    if (key.slice(0, space) !== method) continue;
    const pattern = key.slice(space + 1).split('/');
    if (pattern.length !== parts.length) continue;
    /** @type {Record<string,string>} */
    const params = {};
    const ok = pattern.every((seg, i) => {
      if (!seg.startsWith(':')) return seg === parts[i];
      if (!paramRe.test(parts[i])) return false;
      params[seg.slice(1)] = parts[i];
      return true;
    });
    if (ok) return { handler, params };
  }
  return null;
}

/** @param {import('node:http').ServerResponse} res @param {number} status @param {Record<string,string>} headers @param {string|Buffer} [body] */
function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
const sendJson = (res, status, body) => send(res, status, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(body));
/** @param {import('node:http').ServerResponse} res @param {number} status @param {string} code @param {string} message */
const fail = (res, status, code, message) => sendJson(res, status, { error: { code, message } });

/** An error a route handler may throw to answer with a specific status. Its message is safe to show. */
export class ApiError extends Error {
  /** @param {number} httpStatus @param {string} code @param {string} message */
  constructor(httpStatus, code, message) {
    super(message);
    this.name = 'ApiError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.expose = true;
  }
}

const MAX_BODY_BYTES = 16 * 1024;

/**
 * Reads a small JSON body. Only application/json is accepted, so a plain HTML form on another
 * site cannot post to us, and nothing over 16 KB is ever read into memory.
 * @param {import('node:http').IncomingMessage} req
 */
export function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\s*(;.*)?$/i.test(String(req.headers['content-type'] ?? ''))) {
      return reject(new ApiError(415, 'invalid_request', 'Send the request as JSON (Content-Type: application/json).'));
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) return reject(new ApiError(413, 'invalid_request', 'The request is too large.'));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        chunks.length = 0;
        return reject(new ApiError(413, 'invalid_request', 'The request is too large.'));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ApiError(400, 'invalid_request', 'The request body is not valid JSON.'));
      }
    });
    req.on('error', () => reject(new ApiError(400, 'invalid_request', 'The request could not be read.')));
  });
}

/**
 * Sends a route's result. A result with `stream` becomes a Server-Sent Events response.
 * @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res
 * @param {{ status: number, body?: unknown, stream?: (res: import('node:http').ServerResponse, req: import('node:http').IncomingMessage) => void }} result
 */
function respond(req, res, result) {
  if (!result.stream) return sendJson(res, result.status, result.body);
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
  res.flushHeaders();
  result.stream(res, req);
}

/** Errors that carry `expose` have messages written for users; anything else is a plain 500. @param {unknown} err @param {import('node:http').ServerResponse} res */
function failFrom(err, res) {
  const e = /** @type {any} */ (err);
  if (res.headersSent) return void res.destroy();
  if (e && e.expose === true) return fail(res, e.httpStatus ?? 500, e.code ?? 'internal_error', e.message);
  fail(res, 500, 'internal_error', 'Something went wrong in the supervisor.');
}

/** @param {string} s */
const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Adds a loud, escaped banner to the console page. Used only when a banner is configured. @param {string} html @param {string} text */
const withBanner = (html, text) =>
  html.replace('<title>', '<title>[DEMO] ').replace('<body>', `<body>
  <div class="demo-banner" role="alert"><strong>DEMO MODE</strong> ${escapeHtml(text)}</div>`);

/** @param {number} port */
const hostsFor = (port) => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
/** @param {number} port */
const originsFor = (port) => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

/**
 * Strict Origin allow-list. Writes need an exact match. Reads may omit it (same-origin
 * navigations do) but a present Origin must still match.
 * @param {import('node:http').IncomingMessage} req @param {Set<string>} allowed
 */
function originAllowed(req, allowed) {
  const origin = req.headers.origin;
  if (origin === undefined) return SAFE_METHODS.has(req.method ?? 'GET');
  return allowed.has(String(origin));
}

/** @param {string} rawPathname @returns {string|null} */
function decodePath(rawPathname) {
  try {
    const p = decodeURIComponent(rawPathname);
    return p.includes('\0') || p.includes('\\') ? null : p;
  } catch {
    return null;
  }
}

/**
 * Recovery console origin: UI shell, plus the full API behind a bearer token.
 * @param {{ port: number, consoleDir: string, key: string, routes: Routes }} o
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

/**
 * App origin: a pointer page at /_evolv, and the three routes app pages may use.
 * @param {{ port: number, consolePort: number, routes: Routes }} o
 *   routes are the ONLY routes served under /_evolv/api (B2 registers submit, cancel, events)
 */
export function createAppApi({ port, consolePort, routes, banner }) {
  const hosts = hostsFor(port);
  const origins = originsFor(port);
  const pointerPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Recovery console</title>
<style>body{font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem}</style></head>
<body>${banner ? `<p><strong>DEMO MODE:</strong> ${escapeHtml(banner)}</p>` : ''}<h1>Recovery console</h1>
<p>The console runs on its own address so that your app's pages can never reach it.</p>
<p><a href="http://127.0.0.1:${consolePort}/">Open the recovery console</a></p>
<p>First time on this browser? Run <code>npm run console</code> in the Evolv folder to open a signed-in link.</p>
</body></html>`;

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
