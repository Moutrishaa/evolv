// Reads .env and the real environment into one validated config object.
// Dependency-free. The API key is stored non-enumerable so it never shows up in
// JSON.stringify, console.log, Object.keys or Object.entries.
import fs from 'node:fs';

/**
 * @typedef {Object} Config
 * @property {'anthropic'} provider
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
  const known = ['AI_PROVIDER', 'AI_API_KEY', 'AI_MODEL', 'TOKEN_BUDGET', 'CHANGE_TOKEN_LIMIT', 'AGENT_MAX_STEPS', 'VERIFY_TIMEOUT_MS', 'PORT', 'CONSOLE_PORT'];
  /** @type {Record<string,string>} */
  const src = { ...file };
  for (const k of known) if (env[k] !== undefined) src[k] = /** @type {string} */ (env[k]);

  const provider = src.AI_PROVIDER || 'anthropic';
  if (provider !== 'anthropic') throw new Error(`AI_PROVIDER must be "anthropic" in the MVP (got "${provider}")`);

  const port = positiveInt(src, 'PORT', 3000);
  const consolePort = positiveInt(src, 'CONSOLE_PORT', port + 2);
  if (consolePort === port || consolePort === port + 1) {
    throw new Error(`CONSOLE_PORT (${consolePort}) must differ from PORT (${port}) and the app port (${port + 1})`);
  }

  const config = {
    provider: /** @type {'anthropic'} */ (provider),
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
