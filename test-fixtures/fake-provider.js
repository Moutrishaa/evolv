// Fake AI provider: a local HTTP server that speaks a subset of the Anthropic Messages API
// and answers with scripted tool calls. Used by the integration tests (PRD section 14).
import http from 'node:http';

let counter = 0;
export const toolUse = (name, input = {}, id) => ({
  type: 'tool_use',
  id: id ?? `toolu_${String(++counter).padStart(6, '0')}`,
  name,
  input,
});
export const textBlock = (text) => ({ type: 'text', text });

/** A normal assistant reply. Extra field: delayMs. */
export const reply = (blocks, { input = 100, output = 50, stop = 'tool_use', delayMs = 0 } = {}) => ({
  content: blocks,
  usage: { input_tokens: input, output_tokens: output },
  stop_reason: stop,
  delayMs,
});

/** A raw HTTP answer, for errors: { status, body, headers, delayMs } or { destroy: true }. */
export const httpError = (status, message, extra = {}) => ({
  status,
  body: { type: 'error', error: { type: 'api_error', message } },
  ...extra,
});

/**
 * script: an array of replies, or a function (requestBody, callNumber) => reply.
 * The last array entry repeats forever, so "never finishes" scripts are one line.
 */
export async function startFakeProvider({ apiKey = 'test-key', script = [] } = {}) {
  const state = { script, requests: [], apiKey };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        /* leave null */
      }
      const n = state.requests.length;
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, raw, body });

      const sendJson = (status, obj, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(obj));
      };

      // Deliberately echoes the key it received, to prove the adapter scrubs error text.
      if (req.headers['x-api-key'] !== state.apiKey) {
        return sendJson(401, {
          type: 'error',
          error: { type: 'authentication_error', message: `invalid x-api-key: ${req.headers['x-api-key']}` },
        });
      }

      let item =
        typeof state.script === 'function' ? state.script(body, n) : state.script[Math.min(n, state.script.length - 1)];
      if (!item) item = reply([textBlock('(empty script)')], { stop: 'end_turn' });

      const respond = () => {
        if (item.destroy) return req.socket.destroy();
        if (item.status) return sendJson(item.status, item.body ?? {}, item.headers);
        sendJson(200, {
          id: `msg_${n}`,
          type: 'message',
          role: 'assistant',
          model: body?.model ?? 'fake',
          content: item.content,
          stop_reason: item.stop_reason,
          usage: item.usage,
        });
      };
      if (item.delayMs) {
        const timer = setTimeout(respond, item.delayMs);
        res.on('close', () => clearTimeout(timer)); // the client gave up
      } else respond();
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests: state.requests,
    setScript(s) {
      state.script = s;
    },
    async close() {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}
