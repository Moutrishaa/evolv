// Reads .env and the real environment into one validated config object.
// Dependency-free. The API key is stored non-enumerable so it never shows up in
// JSON.stringify, console.log, Object.keys or Object.entries.
import fs from 'node:fs';
import { normalizeBaseUrl } from './providers/base-url.js';

/**
 * @typedef {Object} Config
 * @property {'anthropic'|'openai'} provider
 * @property {string|undefined} baseUrl  OpenAI-compatible address (openai only), https or loopback http
 * @property {string} model
 * @property {number} tokenBudget
 * @property {number} changeTokenLimit
 * @property {number} agentMaxSteps
 * @property {number} verifyTimeoutMs
 * @property {number} port
 * @property {number} consolePort  recovery console, its own origin
 * @property {string} apiKey  non-enumerable
 */

/** @param {string} text @returns {Record<string,string>} */
export function parseEnv(text) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && /^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

/** @param {Record<string,string>} src @param {string} key @param {number} dflt */
function positiveInt(src, key, dflt) {
  const raw = src[key];
  if (raw === undefined || raw === '') return dflt;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${key} must be a positive whole number (got "${raw}")`);
  return Number(raw);
}

/**
 * @param {{ envPath?: string, envText?: string, env?: Record<string,string|undefined> }} [opts]
 * @returns {Config}
 */
export function loadConfig({ envPath, envText, env = process.env } = {}) {
  let text = envText ?? '';
  if (envText === undefined && envPath && fs.existsSync(envPath)) text = fs.readFileSync(envPath, 'utf8');
  const file = parseEnv(text);
  // Real environment variables win over the file, but only for keys we know.
  const known = ['AI_PROVIDER', 'AI_API_KEY', 'AI_MODEL', 'TOKEN_BUDGET', 'CHANGE_TOKEN_LIMIT', 'AGENT_MAX_STEPS', 'VERIFY_TIMEOUT_MS', 'PORT', 'CONSOLE_PORT', 'AI_BASE_URL'];
  /** @type {Record<string,string>} */
  const src = { ...file };
  for (const k of known) if (env[k] !== undefined) src[k] = /** @type {string} */ (env[k]);

  const provider = src.AI_PROVIDER || 'anthropic';
  if (provider !== 'anthropic' && provider !== 'openai') throw new Error(`AI_PROVIDER must be "anthropic" or "openai" (got "${provider}")`);

  // AI_BASE_URL decides where the API key is SENT, so it is validated hard (https, or http only for
  // this computer; no login, query or fragment) and only allowed for the provider that uses it.
  /** @type {string|undefined} */
  let baseUrl;
  if (src.AI_BASE_URL) {
    if (provider !== 'openai') {
      throw new Error('AI_BASE_URL can only be used with AI_PROVIDER=openai. It is never used for the Anthropic provider, so it can not redirect that key.');
    }
    baseUrl = normalizeBaseUrl(src.AI_BASE_URL).url;
  } else if (provider === 'openai') {
    baseUrl = 'https://api.openai.com/v1';
  }
  if (provider === 'openai' && !src.AI_MODEL) {
    throw new Error('AI_MODEL must be set when AI_PROVIDER=openai, for example llama-3.3-70b-versatile (Groq) or gpt-4o-mini (OpenAI).');
  }

  const port = positiveInt(src, 'PORT', 3000);
  const consolePort = positiveInt(src, 'CONSOLE_PORT', port + 2);
  if (consolePort === port || consolePort === port + 1) {
    throw new Error(`CONSOLE_PORT (${consolePort}) must differ from PORT (${port}) and the app port (${port + 1})`);
  }

  const config = {
    provider: /** @type {'anthropic'|'openai'} */ (provider),
    baseUrl,
    model: src.AI_MODEL || 'claude-sonnet-5-5',
    tokenBudget: positiveInt(src, 'TOKEN_BUDGET', 300000),
    changeTokenLimit: positiveInt(src, 'CHANGE_TOKEN_LIMIT', 100000),
    agentMaxSteps: positiveInt(src, 'AGENT_MAX_STEPS', 40),
    verifyTimeoutMs: positiveInt(src, 'VERIFY_TIMEOUT_MS', 8000),
    port,
    consolePort,
  };
  Object.defineProperty(config, 'apiKey', { value: src.AI_API_KEY || '', enumerable: false });
  return /** @type {Config} */ (config);
}
