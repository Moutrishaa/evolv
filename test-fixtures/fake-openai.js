// Fake OpenAI-compatible server (Chat Completions). A local HTTP server with a scripted answer
// for each request. It checks the bearer token, serves under any base path, and deliberately
// echoes a wrong key back in its 401 so tests can prove the adapter scrubs error text.
import http from 'node:http';

let counter = 0;

/** A tool call as the API returns it: `arguments` is a JSON STRING. Pass a string to send it verbatim (e.g. malformed). */
export const call = (name, args, id) => ({
  id: id ?? `call_${String(++counter).padStart(5, '0')}`,
  type: 'function',
  function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
});

/**
 * A normal reply. Usage defaults to 100 in / 50 out. Pass `usage: undefined` explicitly to omit
 * the field entirely, or `usage: null` to send null. (A default parameter would turn an explicit
 * undefined back into the default, so presence is checked with `in`.)
 */
export const chatReply = (opts = {}) => {
  const { content = null, toolCalls, finish, delayMs = 0, message = {} } = opts;
  const usage = 'usage' in opts ? opts.usage : { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 };
  return {
    message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}), ...message },
    finish_reason: finish ?? (toolCalls?.length ? 'tool_calls' : 'stop'),
    usage,
    delayMs,
  };
};

/** An error answer: { status, body, headers }. `error` fields land under body.error. */
export const apiError = (status, message, { code, type = 'api_error', headers } = {}) => ({
  status,
  body: { error: { message, type, ...(code ? { code } : {}) } },
  ...(headers ? { headers } : {}),
});

/**
 * @param {{ apiKey?: string|null, script?: any, basePath?: string }} [o]
 *   apiKey: the bearer token the server expects (null = a keyless local server)
 *   script: an array (the last entry repeats) or a function (requestBody, callNumber) => item
 */
export async function startFakeOpenAI({ apiKey = 'test-key', script = [], basePath = '' } = {}) {
  const state = { script, requests: [] };

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

      if (req.method !== 'POST' || req.url !== `${basePath}/chat/completions`) {
        return sendJson(404, { error: { message: `Not found: ${req.method} ${req.url}`, type: 'invalid_request_error' } });
      }
      if (apiKey !== null && req.headers.authorization !== `Bearer ${apiKey}`) {
        // Echoes what it received, like a sloppy gateway would.
        return sendJson(401, { error: { message: `Incorrect API key provided: ${req.headers.authorization}`, type: 'invalid_request_error', code: 'invalid_api_key' } });
      }

      const item = typeof state.script === 'function' ? state.script(body, n) : state.script[Math.min(n, state.script.length - 1)];
      if (!item) return sendJson(200, { choices: [{ index: 0, message: { role: 'assistant', content: '(empty script)' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });

      const respond = () => {
        if (item.destroy) return req.socket.destroy();
        if (item.rawBody !== undefined) {
          res.writeHead(item.status ?? 200, { 'Content-Type': item.contentType ?? 'text/html', ...(item.headers ?? {}) });
          return res.end(item.rawBody);
        }
        if (item.status) return sendJson(item.status, item.body ?? {}, item.headers);
        const out = { id: `chatcmpl-${n}`, object: 'chat.completion', model: body?.model ?? 'fake', choices: [{ index: 0, message: item.message, finish_reason: item.finish_reason }] };
        if (item.usage !== undefined) out.usage = item.usage;
        sendJson(200, out);
      };
      if (item.delayMs) {
        const timer = setTimeout(respond, item.delayMs);
        res.on('close', () => clearTimeout(timer)); // the client gave up
      } else respond();
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    /** The value to use as AI_BASE_URL. */
    url: `${origin}${basePath}`,
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
