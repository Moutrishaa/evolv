// Network helpers for the promotion tests: an SSE reader and a request poller.
import http from 'node:http';
import { request, sleep } from './helpers.js';

/**
 * Reads a Server-Sent Events stream until `until(event)` is true, the stream ends, or time runs out.
 * Resolves { status, headers, events: [{ id, type, data }], comments }.
 */
export function readSse(url, { headers = {}, until, timeout = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const events = [];
    let comments = 0;
    let settled = false;
    let timer;
    let req;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(value);
    };
    req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: { Accept: 'text/event-stream', ...headers } },
      (res) => {
        if (res.statusCode !== 200) {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => done({ status: res.statusCode, headers: res.headers, events, comments, body: Buffer.concat(chunks).toString('utf8') }));
          return;
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = { id: null, type: 'message', data: null };
            let isComment = true;
            for (const line of block.split('\n')) {
              if (line.startsWith(':')) continue;
              isComment = false;
              if (line.startsWith('id: ')) ev.id = Number(line.slice(4));
              else if (line.startsWith('event: ')) ev.type = line.slice(7);
              else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6));
            }
            if (isComment) {
              comments++;
              continue;
            }
            events.push(ev);
            if (until?.(ev, events)) return done({ status: 200, headers: res.headers, events, comments });
          }
        });
        res.on('end', () => done({ status: 200, headers: res.headers, events, comments, ended: true }));
      },
    );
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`SSE timed out after ${timeout} ms; events so far: ${events.map((e) => e.type).join(', ')}`));
    }, timeout);
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    req.end();
  });
}

/** Hits a URL every few milliseconds until stopped, so "no downtime" is proven, not assumed. */
export function startPoller(url, { intervalMs = 20 } = {}) {
  let stopped = false;
  const results = [];
  const loop = (async () => {
    while (!stopped) {
      try {
        const r = await request(url);
        results.push({ status: r.status, ok: r.status === 200, body: r.body });
      } catch (err) {
        results.push({ status: 0, ok: false, error: err.code ?? String(err) });
      }
      await sleep(intervalMs);
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
      return { total: results.length, failures: results.filter((r) => !r.ok), results };
    },
  };
}
