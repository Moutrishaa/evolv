// Shared HTTP plumbing for both supervisor origins: sending replies with the security headers,
// the Host / Origin checks, bounded JSON body reading, and turning thrown errors into replies.
// Both origins check the Host header (DNS rebinding) and refuse CORS preflights, so no
// cross-origin page can call either API with a custom header.
import path from 'node:path';
import { SAFE_METHODS, SECURITY_HEADERS } from '../constants/http.js';
import { MAX_BODY_BYTES } from '../constants/limits.js';

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

/** @param {import('node:http').ServerResponse} res @param {number} status @param {Record<string,string>} headers @param {string|Buffer} [body] */
export function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
/** @param {import('node:http').ServerResponse} res @param {number} status @param {unknown} body */
export const sendJson = (res, status, body) => send(res, status, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(body));
/** @param {import('node:http').ServerResponse} res @param {number} status @param {string} code @param {string} message */
export const fail = (res, status, code, message) => sendJson(res, status, { error: { code, message } });

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
export function respond(req, res, result) {
  if (!result.stream) return sendJson(res, result.status, result.body);
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no', Connection: 'keep-alive' });
  res.flushHeaders();
  result.stream(res, req);
}

/** Errors that carry `expose` have messages written for users; anything else is a plain 500. @param {unknown} err @param {import('node:http').ServerResponse} res */
export function failFrom(err, res) {
  const e = /** @type {any} */ (err);
  if (res.headersSent) return void res.destroy();
  if (e && e.expose === true) return fail(res, e.httpStatus ?? 500, e.code ?? 'internal_error', e.message);
  fail(res, 500, 'internal_error', 'Something went wrong in the supervisor.');
}

/** @param {number} port */
export const hostsFor = (port) => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
/** @param {number} port */
export const originsFor = (port) => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);

/**
 * Strict Origin allow-list. Writes need an exact match. Reads may omit it (same-origin
 * navigations do) but a present Origin must still match.
 * @param {import('node:http').IncomingMessage} req @param {Set<string>} allowed
 */
export function originAllowed(req, allowed) {
  const origin = req.headers.origin;
  if (origin === undefined) return SAFE_METHODS.has(req.method ?? 'GET');
  return allowed.has(String(origin));
}

/** @param {string} rawPathname @returns {string|null} */
export function decodePath(rawPathname) {
  try {
    const p = decodeURIComponent(rawPathname);
    return p.includes('\0') || p.includes('\\') ? null : p;
  } catch {
    return null;
  }
}
