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
});

test('values come from .env text, and real environment variables override', () => {
  const c = loadConfig({ envText: 'PORT=4000\nTOKEN_BUDGET=5', env: { PORT: '4100' } });
  assert.equal(c.port, 4100);
  assert.equal(c.tokenBudget, 5);
});

test('invalid numbers and providers are rejected', () => {
  assert.throws(() => loadConfig({ envText: 'PORT=abc', env: {} }), /PORT/);
  assert.throws(() => loadConfig({ envText: 'TOKEN_BUDGET=-1', env: {} }), /TOKEN_BUDGET/);
  assert.throws(() => loadConfig({ envText: 'AI_PROVIDER=openai', env: {} }), /AI_PROVIDER/);
});

test('the API key is never visible when the config is printed or serialised', () => {
  const c = loadConfig({ envText: 'AI_API_KEY=sk-super-secret', env: {} });
  assert.equal(c.apiKey, 'sk-super-secret'); // available to code that needs it
  assert.ok(!JSON.stringify(c).includes('sk-super-secret'));
  assert.ok(!JSON.stringify(Object.entries(c)).includes('sk-super-secret'));
  assert.ok(!String(Object.keys(c)).includes('apiKey'));
});
