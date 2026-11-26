// Reverse proxy from the supervisor to the sandboxed app on 127.0.0.1.
import http from 'node:http';
import { HOP_BY_HOP } from '../constants/http.js';
import { appDownPage } from '../views/html.js';


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
        res.end(appDownPage);
      });
      res.on('close', () => upstream.destroy());
      req.pipe(upstream);
    },
  };
}
