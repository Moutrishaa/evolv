// Reverse proxy from the supervisor to the sandboxed app on 127.0.0.1.
import http from 'node:http';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

const DOWN_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>App unavailable</title>
<style>body{font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem}</style></head>
<body><h1>The app isn't responding</h1>
<p>It may be starting up, restarting, or broken by a recent change.</p>
<p><a href="/_evolv">Open the recovery console</a></p></body></html>`;

/**
 * Removes the Evolv session cookie so AI-written app code can never see it.
 * @param {string|undefined} header
 */
function stripSessionCookie(header) {
  if (!header) return undefined;
  const kept = header.split(';').map((s) => s.trim()).filter((c) => c && !c.startsWith('evolv_session='));
  return kept.length ? kept.join('; ') : undefined;
}

/**
 * @param {{ getPort: () => number }} o
 */
export function createProxy({ getPort }) {
  return {
    /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
    handle(req, res) {
      /** @type {http.OutgoingHttpHeaders} */
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
      const cookie = stripSessionCookie(req.headers.cookie);
      if (cookie) headers.cookie = cookie;
      else delete headers.cookie;
      headers.host = `127.0.0.1:${getPort()}`;

      const upstream = http.request(
        { host: '127.0.0.1', port: getPort(), method: req.method, path: req.url, headers },
        (up) => {
          /** @type {http.OutgoingHttpHeaders} */
          const out = {};
          for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k)) out[k] = v;
          res.writeHead(up.statusCode ?? 502, out);
          up.pipe(res);
        },
      );
      upstream.on('error', () => {
        if (res.headersSent) return res.destroy();
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(DOWN_PAGE);
      });
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    },
  };
}
