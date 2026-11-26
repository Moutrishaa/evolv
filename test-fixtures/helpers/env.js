// A complete Evolv in a temp folder (real supervisor, real sandboxed app, real proxy, real
// routes) whose AI is the fake provider. Used by the end-to-end promotion tests.
import fs from 'node:fs';
import path from 'node:path';
import { startSupervisor } from '../../supervisor/main.js';
import { loadConfig } from '../../supervisor/config/config.js';
import { listVersions } from '../../supervisor/models/versions.js';
import { startFakeProvider, reply, toolUse } from '../fakes/fake-provider.js';
import { startFakeOpenAI, chatReply, call } from '../fakes/fake-openai.js';
import { makeTempDir, getFreePort, getConsolePortFor, request, waitFor, ROOT } from './helpers.js';
import { readSse } from './net.js';

export const AI_KEY = 'sk-e2e-key-must-never-appear';

/** One reply that writes files and then finishes, so a whole change is a single AI step. */
export const changeScript = (files, summary = 'Made the requested change.') => [
  reply([...Object.entries(files).map(([p, content]) => toolUse('write_file', { path: p, content })), toolUse('finish', { summary })]),
];

/** The same one-step change, as an OpenAI-style reply (tool call arguments are JSON strings). */
export const openaiChangeScript = (files, summary = 'Made the requested change.') => [
  chatReply({ toolCalls: [...Object.entries(files).map(([p, content]) => call('write_file', { path: p, content })), call('finish', { summary })] }),
];

/** provider: 'anthropic' (default) or 'openai' (an OpenAI-compatible fake server under /v1). */
export async function startEnv({ script = [], envText = '', settleMs = 200, tokenBudget, prepare, provider = 'anthropic' } = {}) {
  const tmp = makeTempDir('evolv-e2e-');
  fs.cpSync(path.join(ROOT, 'seed'), path.join(tmp.dir, 'seed'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'console'), path.join(tmp.dir, 'console'), { recursive: true });
  const port = await getFreePort();
  const consolePort = await getConsolePortFor(port);
  const appPort = await getFreePort();
  const config = loadConfig({
    envText: `AI_API_KEY=${AI_KEY}\n${provider === 'openai' ? 'AI_PROVIDER=openai\nAI_MODEL=test-model-x\n' : ''}${tokenBudget ? `TOKEN_BUDGET=${tokenBudget}\n` : ''}${envText}`,
    env: { PORT: String(port), CONSOLE_PORT: String(consolePort), VERIFY_TIMEOUT_MS: '4000' },
  });
  if (prepare) await prepare(tmp.dir); // e.g. damage a file before the supervisor starts
  const fake = provider === 'openai' ? await startFakeOpenAI({ apiKey: AI_KEY, basePath: '/v1', script }) : await startFakeProvider({ apiKey: AI_KEY, script });
  // aiBaseUrl and verifySettleMs are code-level test seams, never environment settings.
  const sup = await startSupervisor({ config, root: tmp.dir, appPort, aiBaseUrl: fake.url, aiRetryDelayMs: 1, verifySettleMs: settleMs });
  const base = `http://127.0.0.1:${port}`;
  const cbase = `http://127.0.0.1:${consolePort}`;
  const auth = { Authorization: `Bearer ${sup.consoleKey}` };
  const appDir = path.join(tmp.dir, 'app');
  await waitFor(async () => (await request(`${base}/health`)).status === 200, { timeout: 15000, what: 'live app' });

  const env = {
    sup, fake, base, cbase, auth, appDir, root: tmp.dir, port, consolePort, appPort,
    versions: () => listVersions(appDir),
    status: async () => JSON.parse((await request(`${cbase}/api/status`, { headers: auth })).body),
    /** Submit from an "app page": same origin, JSON. */
    submit: (request_, { origin = base } = {}) =>
      request(`${base}/_evolv/api/changes`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ request: request_ }) }),
    /** Submit and follow the stream to its end. Returns { id, events, last }. */
    async runChange(request_) {
      const res = await env.submit(request_);
      assert_(res.status === 202, `submit returned ${res.status}: ${res.body}`);
      const { id } = JSON.parse(res.body);
      const sse = await readSse(`${base}/_evolv/api/changes/${id}/events`, { until: (e) => e.type === 'done' || e.type === 'failed', timeout: 40000 });
      return { id, events: sse.events, last: sse.events.at(-1) };
    },
    workspaces: () => {
      const dir = path.join(tmp.dir, 'state', 'workspaces');
      return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    },
    async close() {
      await sup.close();
      await fake.close();
      tmp.cleanup();
    },
  };
  return env;
}

function assert_(cond, msg) {
  if (!cond) throw new Error(msg);
}
