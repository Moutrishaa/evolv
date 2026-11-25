// Anthropic Messages API adapter. The key is held in a private field, used only in the
// x-api-key header, and scrubbed from every error text. The base URL is a constructor option
// only: never an environment variable, so nothing in .env can redirect the key elsewhere.
import { estimateTokens } from '../budget.js';

export class ProviderError extends Error {
  /** @param {string} message @param {{ aborted?: boolean, estimatedInputTokens?: number }} [extra] */
  constructor(message, extra = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = 'provider_error';
    if (extra.aborted) this.aborted = true;
    if (extra.estimatedInputTokens !== undefined) this.estimatedInputTokens = extra.estimatedInputTokens;
  }
}

const API_VERSION = '2023-06-01';
const MAX_RETRY_WAIT_MS = 10_000;
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

export class AnthropicProvider {
  #apiKey;

  /**
   * @param {{
   *   apiKey: string, model: string, baseUrl?: string, fetchImpl?: typeof fetch,
   *   maxTokens?: number, requestTimeoutMs?: number, retries?: number, retryDelayMs?: number
   * }} o
   */
  constructor({ apiKey, model, baseUrl = 'https://api.anthropic.com', fetchImpl = globalThis.fetch, maxTokens = 8192, requestTimeoutMs = 120_000, retries = 2, retryDelayMs = 500 }) {
    this.#apiKey = apiKey || '';
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.maxTokens = maxTokens;
    this.requestTimeoutMs = requestTimeoutMs;
    this.retries = retries;
    this.retryDelayMs = retryDelayMs;
  }

  /** Fails early, in plain words, if no key is configured. */
  assertReady() {
    if (!this.#apiKey) throw new ProviderError('No AI key is set. Add AI_API_KEY=... to the .env file and restart Evolv.');
  }

  /** @param {string} text */
  #scrub(text) {
    return this.#apiKey ? String(text).split(this.#apiKey).join('[hidden]') : String(text);
  }

  /**
   * @param {{ system: string, messages: any[], tools: any[], signal?: AbortSignal }} o
   * @returns {Promise<{ content: any[], stopReason: string|null, usage: { inputTokens: number, outputTokens: number }, estimated: boolean }>}
   */
  async complete({ system, messages, tools, signal }) {
    this.assertReady();
    const body = JSON.stringify({ model: this.model, max_tokens: this.maxTokens, system, tools, messages });
    const estimatedInputTokens = estimateTokens(body);
    const cancelled = () => new ProviderError('The AI call was cancelled.', { aborted: true, estimatedInputTokens });
    const url = `${this.baseUrl}/v1/messages`;
    const headers = { 'x-api-key': this.#apiKey, 'anthropic-version': API_VERSION, 'content-type': 'application/json' };

    let failure = 'Could not reach the AI provider. Check your internet connection.';
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (signal?.aborted) throw cancelled();
      const timeout = AbortSignal.timeout(this.requestTimeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

      let status, text, retryAfter;
      try {
        const res = await this.fetchImpl(url, { method: 'POST', headers, body, signal: combined });
        status = res.status;
        retryAfter = res.headers.get('retry-after');
        text = await res.text();
      } catch {
        if (signal?.aborted) throw cancelled();
        if (timeout.aborted) throw new ProviderError('The AI provider took too long to respond.', { estimatedInputTokens });
        await this.#pause(attempt, null);
        continue; // network trouble: try again
      }

      if (status === 200) return this.#parse(text, estimatedInputTokens);
      if (status === 401 || status === 403) {
        throw new ProviderError(`The AI provider rejected the API key (HTTP ${status}). Check AI_API_KEY in the .env file.`);
      }
      if (status === 429 || status >= 500) {
        failure = `The AI provider is busy or unavailable (HTTP ${status}). Try again in a few minutes.`;
        await this.#pause(attempt, retryAfter);
        continue;
      }
      let detail = '';
      try {
        const m = JSON.parse(text)?.error?.message;
        if (typeof m === 'string') detail = `: ${this.#scrub(m).slice(0, 300)}`;
      } catch {
        /* no readable detail */
      }
      throw new ProviderError(`The AI provider rejected the request (HTTP ${status})${detail}`);
    }
    throw new ProviderError(failure);
  }

  /** Waits before a retry. Does nothing after the last attempt. @param {number} attempt @param {string|null} retryAfter */
  async #pause(attempt, retryAfter) {
    if (attempt >= this.retries) return;
    const header = retryAfter !== null && retryAfter !== '' ? Number(retryAfter) : NaN;
    const ms = Number.isFinite(header) && header >= 0 ? header * 1000 : this.retryDelayMs * 2 ** attempt;
    await sleep(Math.min(ms, MAX_RETRY_WAIT_MS));
  }

  /** @param {string} text @param {number} estimatedInput */
  #parse(text, estimatedInput) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ProviderError('The AI provider sent a reply that could not be understood.');
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.content)) {
      throw new ProviderError('The AI provider sent a reply that could not be understood.');
    }
    const content = [];
    for (const b of data.content) {
      if (b?.type === 'text' && typeof b.text === 'string') content.push({ type: 'text', text: b.text });
      else if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input && typeof b.input === 'object' ? b.input : {} });
      }
    }
    const u = data.usage;
    const real = u && Number.isFinite(u.input_tokens) && Number.isFinite(u.output_tokens);
    const usage = real
      ? {
          inputTokens: u.input_tokens + (Number.isFinite(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : 0) + (Number.isFinite(u.cache_read_input_tokens) ? u.cache_read_input_tokens : 0),
          outputTokens: u.output_tokens,
        }
      : { inputTokens: estimatedInput, outputTokens: estimateTokens(JSON.stringify(content)) };
    return { content, stopReason: typeof data.stop_reason === 'string' ? data.stop_reason : null, usage, estimated: !real };
  }
}
