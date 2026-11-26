// OpenAI-compatible adapter (Chat Completions): OpenAI, Groq, and local servers such as Ollama.
// Same interface as the Anthropic adapter, so the agent loop does not change:
//   assertReady()  and  complete({ system, messages, tools, signal }) -> { content, stopReason, usage, estimated }
//
// The agent speaks one internal format (Anthropic-style blocks: text, tool_use, tool_result).
// This file converts it to and from Chat Completions.
//
// The key: held in a private field, sent only in the Authorization header to the configured
// address, scrubbed from every error text, never logged. Redirects are never followed, so a
// redirect cannot carry it elsewhere. The address and key are constructor options only; nothing
// here reads the environment.
import { estimateTokens } from '../../models/ledger.js';
import { ProviderError } from './anthropic.js';
import { normalizeBaseUrl } from './base-url.js';
import { DEFAULT_OPENAI_BASE_URL as DEFAULT_BASE_URL } from '../../constants/providers.js';


const unreadable = () => new ProviderError('The AI provider sent a reply that could not be understood.');

/** @param {unknown} v */
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Keeps names short and printable before they go into a message. @param {unknown} name */
const safeName = (name) => String(name).replace(/[^\w.-]/g, '').slice(0, 64);

/** @param {unknown} content a string, or a list of parts */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (typeof p === 'string' ? p : p && p.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('');
}

/** Tool result content may be text or a list of text blocks. @param {unknown} content */
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === 'string' ? b : typeof b?.text === 'string' ? b.text : '')).join('');
  return content == null ? '' : JSON.stringify(content);
}

/** Internal conversation -> Chat Completions messages. */
function toOpenAIMessages(/** @type {string} */ system, /** @type {any[]} */ messages) {
  /** @type {any[]} */
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
    } else if (m.role === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = blocks
        .filter((b) => b.type === 'tool_use')
        // A call whose arguments could not be read goes back as {}: strict servers reject invalid JSON in the history.
        // extraContent is provider-specific data (Gemini's thought signature) that must go back exactly as it came.
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.inputError ? '{}' : JSON.stringify(b.input ?? {}) }, ...(isPlainObject(b.extraContent) ? { extra_content: b.extraContent } : {}) }));
      /** @type {any} */
      const msg = { role: 'assistant', content: text || (calls.length ? null : '') };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
    } else {
      const blocks = Array.isArray(m.content) ? m.content : [];
      // One "tool" message per result, in order, straight after the assistant message that made the calls.
      for (const b of blocks) if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: resultText(b.content) });
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

/** @param {string} name @param {unknown} raw @param {boolean} cutOff */
function readArguments(name, raw, cutOff) {
  const label = safeName(name);
  const fail = (/** @type {string} */ message) => ({ input: {}, inputError: message });
  if (raw === undefined || raw === null) return { input: {} };
  if (typeof raw === 'object' && !Array.isArray(raw)) return { input: /** @type {Record<string, unknown>} */ (raw) };
  if (typeof raw !== 'string') return fail(`The arguments for "${label}" were not valid JSON, so the tool was not run. Send the arguments as one JSON object.`);
  if (raw.trim() === '') return { input: {} };
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail(
      cutOff
        ? `Your reply was cut off at the output limit before the arguments for "${label}" were complete, so the tool was not run. Try again with less text in one call.`
        : `The arguments for "${label}" were not valid JSON, so the tool was not run. Send the arguments as one JSON object.`,
    );
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) return { input: value };
  return fail(`The arguments for "${label}" must be a JSON object, so the tool was not run.`);
}

/** @param {string|undefined} reason */
function stopReasonOf(reason) {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  if (reason === 'stop') return 'end_turn';
  if (reason === 'length') return 'max_tokens';
  return typeof reason === 'string' ? reason : null;
}

/** "about 5 minutes", "about 2 hours". @param {number} seconds */
function humanDuration(seconds) {
  if (seconds < 90) return `${Math.ceil(seconds)} seconds`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} minutes`;
  return `${Math.round(seconds / 3600)} hours`;
}

export class OpenAIProvider {
  #apiKey;

  /**
   * @param {{
   *   apiKey: string, model: string, baseUrl?: string, fetchImpl?: typeof fetch,
   *   maxTokens?: number, maxTokensField?: string,
   *   requestTimeoutMs?: number, retries?: number, retryDelayMs?: number
   * }} o
   *   maxTokensField: the name of the output-limit field. Some newer models want "max_completion_tokens".
   */
  constructor({ apiKey, model, baseUrl = DEFAULT_BASE_URL, fetchImpl = globalThis.fetch, maxTokens = 8192, maxTokensField = 'max_tokens', requestTimeoutMs = 120_000, retries = 2, retryDelayMs = 500, rateLimitRetries = 5, maxRetryWaitMs = 60_000 }) {
    const base = normalizeBaseUrl(baseUrl); // throws a plain AI_BASE_URL message for an unsafe address
    this.#apiKey = apiKey || '';
    this.model = model;
    this.baseUrl = base.url;
    this.host = base.host;
    this.loopback = base.loopback;
    this.settings = { fetchImpl, maxTokens, maxTokensField, requestTimeoutMs, retries, retryDelayMs, rateLimitRetries, maxRetryWaitMs };
  }

  /** Where requests go and which model. Never the key. */
  describe() {
    return { provider: 'openai', model: this.model, host: this.host };
  }

  /** A key is required, except for a server on this computer (some local servers need none). */
  assertReady() {
    if (!this.#apiKey && !this.loopback) throw new ProviderError('No AI key is set. Add AI_API_KEY=... to the .env file and restart Evolv. (A key is only optional for a server on this computer.)');
  }

  /** @param {string} text */
  #scrub(text) {
    return this.#apiKey ? String(text).split(this.#apiKey).join('[hidden]') : String(text);
  }

  /**
   * @param {{ system: string, messages: any[], tools: any[], signal?: AbortSignal,
   *   onWait?: (w: { seconds: number, reason: 'rate_limit'|'unavailable'|'network' }) => void }} o
   *   onWait is told before each wait for a retry, so the user can be shown why nothing is happening.
   * @returns {Promise<{ content: any[], stopReason: string|null, usage: { inputTokens: number, outputTokens: number }, estimated: boolean }>}
   */
  async complete({ system, messages, tools, signal, onWait }) {
    this.assertReady();
    const { fetchImpl, maxTokens, maxTokensField, requestTimeoutMs, retries } = this.settings;
    /** @type {Record<string, unknown>} */
    const payload = { model: this.model, [maxTokensField]: maxTokens, messages: toOpenAIMessages(system, messages) };
    if (tools?.length) {
      payload.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    }
    const body = JSON.stringify(payload);
    const estimatedInputTokens = estimateTokens(body);
    const cancelled = () => new ProviderError('The AI call was cancelled.', { aborted: true, estimatedInputTokens });
    const url = `${this.baseUrl}/chat/completions`;
    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': 'application/json' };
    if (this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;

    const networkFailure = 'Could not reach the AI provider. Check your internet connection and AI_BASE_URL.';
    let failure = networkFailure;
    // Rate limits get their own, much greater, patience than other trouble: a per-minute token limit
    // only clears with time, and one change makes several calls that each re-send the conversation.
    const wait = { used: { rate: 0, other: 0, daily: 0 }, signal, onWait, cancelled };
    for (;;) {
      if (signal?.aborted) throw cancelled();
      const timeout = AbortSignal.timeout(requestTimeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      let status, text, retryAfter;
      try {
        // redirect: 'manual' hands us any 3xx instead of following it, so the key never travels to another address.
        const res = await fetchImpl(url, { method: 'POST', headers, body, signal: combined, redirect: 'manual' });
        status = res.status;
        retryAfter = res.headers.get('retry-after');
        text = await res.text();
      } catch {
        if (signal?.aborted) throw cancelled();
        if (timeout.aborted) throw new ProviderError('The AI provider took too long to respond.', { estimatedInputTokens });
        failure = networkFailure;
        if (!(await this.#backoff('network', null, wait))) break;
        continue; // network trouble: try again
      }

      if (status === 200) return this.#parse(text, estimatedInputTokens);
      if (status >= 300 && status < 400) {
        throw new ProviderError('The AI provider tried to redirect the request to another address. Evolv does not follow redirects, so check AI_BASE_URL in the .env file.');
      }
      if (status === 401 || status === 403) {
        throw new ProviderError(`The AI provider rejected the API key (HTTP ${status}). Check AI_API_KEY in the .env file.`);
      }
      if (status === 404) {
        throw new ProviderError('The AI provider could not find that model or address (HTTP 404). Check AI_MODEL and AI_BASE_URL in the .env file.');
      }
      const error = this.#errorOf(text);
      // Groq (and some others) validate the model's tool-call arguments themselves. When the MODEL wrote
      // invalid JSON they answer 400 "tool_use_failed" instead of a reply, so there is nothing to read.
      // That is the model's slip, not a bad request: report it as a reply with no tool call, so the agent
      // loop tells the model and lets it try again. (The tokens were spent, so the cost is estimated.)
      // Groq words this more than one way ("Failed to parse tool call arguments", "Parsing failed. The model
      // generated output that could not be parsed"), so the message patterns are loose and the sure sign
      // is `failed_generation`: the raw text the model wrote, which only appears in this situation.
      if (status === 400 && (error.code === 'tool_use_failed' || error.failed !== undefined || /failed to parse tool call arguments|parsing failed|could not be parsed/i.test(error.message ?? ''))) {
        return {
          content: [{ type: 'text', text: 'My last tool call was not valid JSON, so it was not run. I will call the tool again with valid JSON arguments.' }],
          stopReason: 'end_turn',
          usage: { inputTokens: estimatedInputTokens, outputTokens: Math.min(estimateTokens(error.failed ?? ''), this.settings.maxTokens) },
          estimated: true,
          toolFormatFailure: true,
        };
      }
      if (status === 429) {
        if (error.code === 'insufficient_quota' || error.type === 'insufficient_quota') {
          throw new ProviderError('The AI account has no remaining credit or quota (HTTP 429). Check the plan and billing with your AI provider.');
        }
        const seconds = retryAfter !== null && retryAfter !== '' ? Number(retryAfter) : NaN;
        // A DAILY quota (tokens or requests per day) is a different problem from a per-minute limit:
        // it can take hours to clear, so say so plainly and do not keep the user waiting for nothing.
        if (/tokens per day|requests per day|\(TPD\)|\(RPD\)/i.test(error.message ?? '')) {
          const clears = Number.isFinite(seconds) && seconds > 0 ? `, and about ${humanDuration(seconds)} must pass before enough frees up` : '';
          failure = `The AI provider's daily limit is used up (HTTP 429)${clears}. Try again later, upgrade the plan, or put another API key or provider in the .env file.`;
          if (Number.isFinite(seconds) && seconds > 120) throw new ProviderError(failure);
          if (!(await this.#backoff('daily_limit', retryAfter, wait))) break;
          continue;
        }
        failure = `The AI provider is rate-limiting requests (HTTP 429). ${Number.isFinite(seconds) && seconds > 0 ? `Try again in about ${Math.ceil(seconds)} seconds.` : 'Wait a minute and try again.'}`;
        if (!(await this.#backoff('rate_limit', retryAfter, wait))) break;
        continue;
      }
      if (status >= 500) {
        failure = `The AI provider is busy or unavailable (HTTP ${status}). Try again in a few minutes.`;
        if (!(await this.#backoff('unavailable', retryAfter, wait))) break;
        continue;
      }
      throw new ProviderError(`The AI provider rejected the request (HTTP ${status})${error.message ? `: ${this.#scrub(error.message).slice(0, 300)}` : ''}`);
    }
    throw new ProviderError(failure);
  }

  /** Pulls { message, code, type } out of an error body, if it has the usual shape. @param {string} text */
  #errorOf(text) {
    try {
      const parsed = JSON.parse(text);
      // Some providers (Gemini) wrap the error in a list: [{ error: {...} }].
      const e = (Array.isArray(parsed) ? parsed[0] : parsed)?.error;
      if (typeof e === 'string') return { message: e };
      if (e && typeof e === 'object') {
        return { message: typeof e.message === 'string' ? e.message : undefined, code: e.code, type: e.type, failed: typeof e.failed_generation === 'string' ? e.failed_generation : undefined };
      }
    } catch {
      /* not JSON: show nothing from it */
    }
    return {};
  }

  /**
   * Decides whether to retry and waits first. Returns false when the retries for this kind of trouble are used up.
   *   rate limit: up to `rateLimitRetries` times, waiting the LONGER of Retry-After and a growing backoff
   *               (4x, 8x, 16x... the base delay), because a per-minute limit can need more than the header says;
   *   other:      up to `retries` times, Retry-After if given, otherwise a short backoff.
   * Never longer than `maxRetryWaitMs` per wait. The wait is announced through onWait, and a cancel ends it at once.
   * @param {'rate_limit'|'daily_limit'|'unavailable'|'network'} reason @param {string|null} retryAfter
   * @param {{ used: { rate: number, other: number, daily: number }, signal?: AbortSignal, onWait?: Function, cancelled: () => Error }} ctx
   */
  async #backoff(reason, retryAfter, { used, signal, onWait, cancelled }) {
    const { retries, retryDelayMs, rateLimitRetries, maxRetryWaitMs } = this.settings;
    const isDaily = reason === 'daily_limit'; // a daily quota rarely clears quickly, so it gets only two retries
    const isRate = reason === 'rate_limit' || isDaily;
    const bucket = isDaily ? 'daily' : isRate ? 'rate' : 'other';
    if (used[bucket] >= (isDaily ? 2 : isRate ? rateLimitRetries : retries)) return false;
    const attempt = used[bucket]++;
    const header = retryAfter !== null && retryAfter !== '' ? Number(retryAfter) * 1000 : NaN;
    const headerMs = Number.isFinite(header) && header >= 0 ? header : NaN;
    const growing = retryDelayMs * (isRate ? 4 : 1) * 2 ** attempt;
    const ms = Math.min(isRate ? Math.max(Number.isNaN(headerMs) ? 0 : headerMs, growing) : Number.isNaN(headerMs) ? growing : headerMs, maxRetryWaitMs);
    onWait?.({ seconds: Math.max(1, Math.ceil(ms / 1000)), reason });
    await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(cancelled());
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(cancelled());
      }, { once: true });
    });
    return true;
  }

  /** @param {string} text @param {number} estimatedInput */
  #parse(text, estimatedInput) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw unreadable();
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw unreadable();
    if (data.error) {
      const message = typeof data.error === 'string' ? data.error : data.error?.message;
      throw new ProviderError(`The AI provider reported a problem: ${this.#scrub(message ?? 'unknown error').slice(0, 300)}`);
    }
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    const message = choice?.message;
    if (!message || typeof message !== 'object') throw unreadable();

    const cutOff = choice.finish_reason === 'length';
    const content = [];
    const reply = textOf(message.content);
    if (reply.trim() !== '') content.push({ type: 'text', text: reply });

    const used = new Set();
    let counter = 0;
    const uniqueId = (/** @type {unknown} */ id) => {
      if (typeof id === 'string' && id.trim() !== '' && !used.has(id)) return id;
      let candidate;
      let k = 1;
      do {
        candidate = typeof id === 'string' && id.trim() !== '' ? `${id}_${++k}` : `call_${++counter}`;
      } while (used.has(candidate));
      return candidate;
    };
    for (const tc of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const fn = tc?.function;
      if (!tc || (tc.type && tc.type !== 'function') || !fn || typeof fn.name !== 'string' || fn.name.trim() === '') continue;
      const id = uniqueId(tc.id);
      used.add(id);
      const { input, inputError } = readArguments(fn.name, fn.arguments, cutOff);
      content.push({ type: 'tool_use', id, name: fn.name, input, ...(inputError ? { inputError } : {}), ...(isPlainObject(tc.extra_content) ? { extraContent: tc.extra_content } : {}) });
    }

    const u = data.usage;
    const real = u && typeof u === 'object' && Number.isFinite(u.prompt_tokens) && Number.isFinite(u.completion_tokens) && u.prompt_tokens >= 0 && u.completion_tokens >= 0;
    // prompt_tokens already includes any cached tokens, so unlike Anthropic nothing is added on top.
    const usage = real
      ? { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens }
      : { inputTokens: estimatedInput, outputTokens: estimateTokens(JSON.stringify(message)) };
    return { content, stopReason: stopReasonOf(choice.finish_reason), usage, estimated: !real };
  }
}
