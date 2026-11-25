import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnv, loadConfig } from '../supervisor/config.js';

test('parseEnv handles comments, blanks, quotes and empty values', () => {
  const env = parseEnv('# c\n\nA=1\nB="two words"\nC=\nD = spaced \n');
  assert.deepEqual(env, { A: '1', B: 'two words', C: '', D: 'spaced' });
});

test('defaults match section 11 of the MVP PRD', () => {
  const c = loadConfig({ envText: '', env: {} });
  assert.equal(c.provider, 'anthropic');
  assert.equal(c.model, 'claude-sonnet-5-5');
  assert.equal(c.tokenBudget, 300000);
  assert.equal(c.changeTokenLimit, 100000);
  assert.equal(c.agentMaxSteps, 40);
  assert.equal(c.verifyTimeoutMs, 8000);
  assert.equal(c.port, 3000);
  assert.equal(c.consolePort, 3002);
});

test('console port defaults to PORT+2 and can be set; it may not collide with the app ports', () => {
  assert.equal(loadConfig({ envText: 'PORT=4000', env: {} }).consolePort, 4002);
  assert.equal(loadConfig({ envText: 'CONSOLE_PORT=5555', env: {} }).consolePort, 5555);
  assert.throws(() => loadConfig({ envText: 'CONSOLE_PORT=3000', env: {} }), /CONSOLE_PORT/);
  assert.throws(() => loadConfig({ envText: 'CONSOLE_PORT=3001', env: {} }), /CONSOLE_PORT/);
});

test('values come from .env text, and real environment variables override', () => {
  const c = loadConfig({ envText: 'PORT=4000\nTOKEN_BUDGET=5', env: { PORT: '4100' } });
  assert.equal(c.port, 4100);
  assert.equal(c.tokenBudget, 5);
});

test('invalid numbers and unknown providers are rejected', () => {
  assert.throws(() => loadConfig({ envText: 'PORT=abc', env: {} }), /PORT/);
  assert.throws(() => loadConfig({ envText: 'TOKEN_BUDGET=-1', env: {} }), /TOKEN_BUDGET/);
  // "openai" is now a real provider (see below). Everything else, including demo and fake, is still refused.
  for (const bad of ['demo', 'fake', 'groq', 'gemini', 'ollama', 'OpenAI', 'ANTHROPIC', 'openai;x', 'openai ai']) {
    assert.throws(() => loadConfig({ envText: `AI_PROVIDER=${bad}\nAI_MODEL=m`, env: {} }), /AI_PROVIDER/, bad);
  }
});

// ---------- the OpenAI-compatible provider ----------
const OPENAI = 'AI_PROVIDER=openai\nAI_MODEL=llama-3.3-70b-versatile\n';

test('openai is accepted, with the OpenAI address as the default base URL', () => {
  const c = loadConfig({ envText: OPENAI, env: {} });
  assert.equal(c.provider, 'openai');
  assert.equal(c.model, 'llama-3.3-70b-versatile');
  assert.equal(c.baseUrl, 'https://api.openai.com/v1');
});

test('AI_BASE_URL can point at any compatible server (Groq, local) and is normalised', () => {
  for (const [given, expected] of [
    ['https://api.groq.com/openai/v1', 'https://api.groq.com/openai/v1'],
    ['https://api.groq.com/openai/v1/', 'https://api.groq.com/openai/v1'],
    ['https://example.com:8443/v1', 'https://example.com:8443/v1'],
    ['http://localhost:11434/v1', 'http://localhost:11434/v1'],
    ['http://127.0.0.1:1234/v1', 'http://127.0.0.1:1234/v1'],
    ['http://[::1]:8080/v1', 'http://[::1]:8080/v1'],
  ]) {
    assert.equal(loadConfig({ envText: `${OPENAI}AI_BASE_URL=${given}`, env: {} }).baseUrl, expected, given);
  }
  // the real environment overrides the file, like every other setting
  assert.equal(loadConfig({ envText: `${OPENAI}AI_BASE_URL=https://a.example/v1`, env: { AI_BASE_URL: 'https://b.example/v1' } }).baseUrl, 'https://b.example/v1');
});

test('unsafe or malformed AI_BASE_URL values are refused with a plain message that never echoes credentials', () => {
  for (const bad of [
    'http://api.groq.com/openai/v1', 'http://192.168.1.5:11434/v1', 'http://localhost.evil.com/v1', 'http://127.0.0.1.evil.com/v1',
    'ftp://x/v1', 'file:///etc/passwd', 'javascript:alert(1)', 'api.groq.com/openai/v1', 'https://',
    'https://api.groq.com/v1?key=abc', 'https://api.groq.com/v1#frag', 'https://api.groq.com/openai/v1/chat/completions',
  ]) {
    assert.throws(() => loadConfig({ envText: `${OPENAI}AI_BASE_URL=${bad}`, env: {} }), /AI_BASE_URL/, bad);
  }
  assert.throws(
    () => loadConfig({ envText: `${OPENAI}AI_BASE_URL=https://alice:hunter2pw@api.groq.com/v1`, env: {} }),
    (e) => /AI_BASE_URL/.test(e.message) && !/hunter2pw|alice/.test(e.message),
  );
  assert.throws(
    () => loadConfig({ envText: `${OPENAI}AI_BASE_URL=https://api.groq.com/v1?token=sk-leak-1234`, env: {} }),
    (e) => !/sk-leak-1234/.test(e.message),
  );
});

test('AI_MODEL must be chosen for openai (the Claude default makes no sense there)', () => {
  assert.throws(() => loadConfig({ envText: 'AI_PROVIDER=openai', env: {} }), (e) => /AI_MODEL/.test(e.message) && /llama|gpt/i.test(e.message));
  assert.equal(loadConfig({ envText: 'AI_PROVIDER=openai\nAI_MODEL=gpt-4o-mini', env: {} }).model, 'gpt-4o-mini');
});

test('AI_BASE_URL with the Anthropic provider is an error, so it can never redirect the Anthropic key', () => {
  assert.throws(() => loadConfig({ envText: 'AI_BASE_URL=https://api.groq.com/openai/v1', env: {} }), /AI_BASE_URL.*openai|openai.*AI_BASE_URL/i);
  assert.throws(() => loadConfig({ envText: 'AI_PROVIDER=anthropic\nAI_BASE_URL=https://evil.example/v1', env: {} }), /AI_BASE_URL/);
  assert.equal(loadConfig({ envText: '', env: {} }).baseUrl, undefined);
  assert.equal(loadConfig({ envText: 'AI_PROVIDER=anthropic', env: {} }).baseUrl, undefined);
});

test('the key is still hidden with openai, and may be empty (the provider decides if that is allowed)', () => {
  const c = loadConfig({ envText: `${OPENAI}AI_API_KEY=sk-groq-secret-999`, env: {} });
  assert.equal(c.apiKey, 'sk-groq-secret-999');
  assert.ok(!JSON.stringify(c).includes('sk-groq-secret-999'));
  assert.equal(loadConfig({ envText: OPENAI, env: {} }).apiKey, '');
});

test('the API key is never visible when the config is printed or serialised', () => {
  const c = loadConfig({ envText: 'AI_API_KEY=sk-super-secret', env: {} });
  assert.equal(c.apiKey, 'sk-super-secret'); // available to code that needs it
  assert.ok(!JSON.stringify(c).includes('sk-super-secret'));
  assert.ok(!JSON.stringify(Object.entries(c)).includes('sk-super-secret'));
  assert.ok(!String(Object.keys(c)).includes('apiKey'));
});
