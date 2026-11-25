// DEMO ONLY: `npm run demo`. Starts the normal supervisor with a scripted stand-in for the AI.
//
// Why this cannot be switched on by the app, the agent, .env or the environment:
//   - it is a separate command, not a setting, so it cannot be left on by accident
//   - this file is only ever started by a person typing `npm run demo`; main.js (what `npm start`
//     runs) does not know it exists
//   - the AI-written app cannot read supervisor/ or .env, cannot start processes, and the agent's
//     path guard cannot see them either
// It uses its own data folder (demo-data/), so your real app/ and state/ are never touched, and it
// never builds the real provider, so no key is read or sent anywhere.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { startSupervisor } from './main.js';
import { createDemoProvider, DEMO_BANNER, DEMO_PHRASES } from './demo-provider.js';

/**
 * Reads .env like normal but DROPS the AI key, from the file and from the environment,
 * so a real key can never reach demo mode.
 * @param {{ envPath?: string, envText?: string, env?: Record<string, string|undefined> }} [o]
 */
export function loadDemoConfig({ envPath, envText, env = process.env } = {}) {
  const text = envText ?? (envPath && fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '');
  const withoutKey = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*AI_API_KEY\s*=/.test(line))
    .join('\n');
  return loadConfig({ envText: withoutKey, env: { ...env, AI_API_KEY: undefined } });
}

/**
 * @param {{ config: import('./config.js').Config, root: string, dataRoot: string, appPort?: number,
 *   delayMs?: number, slowDelayMs?: number, verifySettleMs?: number, log?: (line: string) => void }} o
 */
export async function startDemo({ config, root, dataRoot, appPort, delayMs = 600, slowDelayMs = 1000, verifySettleMs, log = console.log }) {
  fs.mkdirSync(dataRoot, { recursive: true });
  const provider = createDemoProvider({ delayMs, slowDelayMs });
  const sup = await startSupervisor({ config, root, dataRoot, appPort, provider, demo: { banner: DEMO_BANNER }, verifySettleMs });

  // The "rollback" scenario fails on this file, in the DEMO's own live data only.
  fs.writeFileSync(path.join(dataRoot, 'app', 'data', 'demo-poison.txt'), 'Demo trigger: the "rollback" scenario refuses to start when this file exists.\n');

  const links = { app: `http://127.0.0.1:${config.port}`, console: `http://127.0.0.1:${config.consolePort}/#key=${sup.consoleKey}` };
  const bar = '='.repeat(64);
  for (const line of [
    bar,
    '  DEMO MODE: no real AI is used and nothing is sent anywhere.',
    '  Changes are scripted. Your real app and usage record are NOT touched.',
    bar,
    `  App:      ${links.app}`,
    `  Console:  ${links.console}`,
    '',
    `  Type one of these words in the chat: ${DEMO_PHRASES.join(', ')}`,
    '    navy      goes live (type it again to switch back)',
    '    page      adds an About page and goes live',
    '    crash     a change that cannot start: REJECTED, your app keeps running',
    '    nolink    removes the recovery link: REJECTED',
    '    rollback  passes the checks, then fails on live data: ROLLED BACK',
    '    slow      runs for a while so you can press Cancel',
    bar,
  ]) log(line);
  return { sup, links, provider };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const root = path.resolve(import.meta.dirname, '..');
  const config = loadDemoConfig({ envPath: path.join(root, '.env') });
  const { sup } = await startDemo({ config, root, dataRoot: path.join(root, 'demo-data') });
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await sup.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
