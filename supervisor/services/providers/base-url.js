// Rules for AI_BASE_URL, shared by the config (which refuses a bad value at start-up) and by the
// OpenAI-compatible adapter (which refuses it again, so a bad address can never receive a key).
//
//   - https only. Plain http is allowed ONLY for a server on this computer, because anywhere
//     else it would send the key unencrypted.
//   - no login or password in the address, and no "?" or "#" part (a key could hide in either).
//   - never echoes the value it refuses, so a pasted secret cannot end up in a message or a log.


import { LOOPBACK_HOSTS as LOOPBACK } from '../../constants/providers.js';

/** True only for the host names that always mean "this computer". @param {string} hostname */
export const isLoopbackHostname = (hostname) => LOOPBACK.has(String(hostname).toLowerCase());

/**
 * @param {unknown} raw
 * @returns {{ url: string, host: string, loopback: boolean }}  url has no trailing slash
 */
export function normalizeBaseUrl(raw) {
  /** @param {string} message @returns {never} */
  const refuse = (message) => {
    throw new Error(`AI_BASE_URL ${message}`);
  };
  if (typeof raw !== 'string' || raw.trim() === '') refuse('must be the address of an OpenAI-compatible server, like https://api.groq.com/openai/v1.');
  const text = /** @type {string} */ (raw).trim();
  if (/[?#]/.test(text)) refuse('must not contain a "?" or "#" part.');

  let u;
  try {
    u = new URL(text);
  } catch {
    return refuse('is not a valid web address. Use something like https://api.groq.com/openai/v1.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') refuse('must start with https:// (or http:// for a server on this computer).');
  if (u.username || u.password) refuse('must not contain a login or password. Put the key in AI_API_KEY instead.');
  const loopback = isLoopbackHostname(u.hostname);
  if (u.protocol === 'http:' && !loopback) {
    refuse('must start with https://. Plain http:// is only allowed for a server on this computer (localhost), because it would send your key unencrypted.');
  }
  const pathname = u.pathname.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(pathname)) {
    refuse('should be the base address (like https://api.groq.com/openai/v1), not the full /chat/completions address.');
  }
  return { url: `${u.protocol}//${u.host}${pathname}`, host: u.host, loopback };
}
