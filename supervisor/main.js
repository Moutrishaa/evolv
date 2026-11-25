// Supervisor entry point. Everything binds to 127.0.0.1 only.
//   PORT (3000)          app origin:     proxy to the sandboxed app; /_evolv/api = submit/cancel/progress only
//   CONSOLE_PORT (3002)  console origin: recovery console + full API, bearer token required
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { AppProcess } from './process.js';
import { ensureSeeded, listVersions, promote } from './versions.js';
import { createProxy } from './proxy.js';
import { createConsoleApi, createAppApi, createFrontHandler } from './api.js';
import { ensureConsoleKey } from './auth.js';
import { Ledger } from './budget.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { ChangeRunner } from './changes.js';
import { sweepWorkspaces } from './workspace.js';
import { verifyWorkspace, createAppControl } from './verify.js';
import { EventHub } from './events.js';
import { createChangeRoutes } from './change-routes.js';

/**
 * @param {{ config: import('./config.js').Config, root: string, appPort?: number, aiBaseUrl?: string, verifySettleMs?: number,
 *   provider?: { assertReady: () => void, complete: Function }, dataRoot?: string, demo?: { banner: string } }} o
 *   Optional hooks, all set only by code that starts the supervisor, never read from .env or the environment:
 *   aiBaseUrl and verifySettleMs (tests), provider (a stand-in for the AI), dataRoot (where app/ and state/ live,
 *   default: root) and demo (shows a banner and reports mode "demo"). `npm start` sets none of them.
 */
export async function startSupervisor({ config, root, appPort = config.port + 1, aiBaseUrl, verifySettleMs = 2000, provider: providerOverride, dataRoot = root, demo }) {
  const appDir = path.join(dataRoot, 'app');
  const dataDir = path.join(appDir, 'data');
  const stateDir = path.join(dataRoot, 'state'); // outside app/: the sandbox cannot read it
  const workspacesDir = path.join(stateDir, 'workspaces');
  const consoleKey = ensureConsoleKey(stateDir);

  await ensureSeeded({ seedDir: path.join(root, 'seed'), appDir });
  await sweepWorkspaces({ appDir, workspacesDir }); // nothing can be running yet: leftovers are from a crash

  // A damaged usage file must not stop the supervisor (the console has to stay reachable):
  // the ledger reports the problem and blocks changes instead.
  const ledger = new Ledger({ file: path.join(stateDir, 'usage.json'), totalBudget: config.tokenBudget, changeLimit: config.changeTokenLimit });
  const provider = providerOverride ?? new AnthropicProvider({ apiKey: config.apiKey, model: config.model, baseUrl: aiBaseUrl });

  const app = new AppProcess({ appDir, dataDir, port: appPort });
  const proxy = createProxy({ getPort: () => appPort });
  const control = createAppControl({ proc: app, port: appPort });

  // Progress events for the widget and the console. Real paths are scrubbed from everything it sends.
  const hub = new EventHub({ scrubPaths: [root, appDir, stateDir, workspacesDir] });
  const changes = new ChangeRunner({
    appDir,
    workspacesDir,
    provider,
    ledger,
    maxSteps: config.agentMaxSteps,
    timeoutMs: 5 * 60 * 1000,
    onEvent: (e) => hub.publish(/** @type {any} */ (e)),
    log: (line) => app.logs.push(line),
    verify: (ws, opts) => verifyWorkspace({ dir: ws.dir, timeoutMs: config.verifyTimeoutMs, settleMs: verifySettleMs, consolePort: config.consolePort, ...opts }),
    promote: (args) => promote({ appDir, app: control, healthTimeoutMs: Math.max(config.verifyTimeoutMs, 10_000), ...args }),
  });
  // The same three routes on both origins: submit, cancel, progress. App pages get nothing else.
  const changeRoutes = createChangeRoutes({ runner: changes, hub });

  const consoleApi = createConsoleApi({
    port: config.consolePort,
    key: consoleKey,
    consoleDir: path.join(root, 'console'),
    banner: demo?.banner,
    routes: {
      'GET /status': async () => {
        const versions = await listVersions(appDir);
        const st = app.status();
        return {
          status: 200,
          body: {
            app: { ...st, uptimeMs: st.state === 'running' && st.startedAt ? Date.now() - st.startedAt : 0 },
            version: { current: versions[0]?.id ?? null, count: versions.length },
            budget: ledger.snapshot(),
            notice: changes.notice,
            mode: demo ? 'demo' : 'normal',
            node: process.version,
          },
        };
      },
      'GET /logs': () => ({ status: 200, body: { lines: app.logs.lines() } }),
      ...changeRoutes,
    },
  });

  // Submit, cancel and progress. Nothing else may ever be added to this table.
  const appApi = createAppApi({ port: config.port, consolePort: config.consolePort, routes: changeRoutes, banner: demo?.banner });

  const server = http.createServer(createFrontHandler({ appApi, proxy }));
  const consoleServer = http.createServer((req, res) => void consoleApi.handle(req, res));
  /** @param {http.Server} srv @param {number} port */
  const listen = (srv, port) =>
    new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => resolve(undefined)); // SEC-8: loopback only
    });
  await listen(server, config.port);
  await listen(consoleServer, config.consolePort);

  app.start();

  return {
    server,
    consoleServer,
    app,
    consoleKey,
    changes,
    ledger,
    hub,
    async close() {
      await app.stop();
      for (const srv of [server, consoleServer]) {
        srv.closeAllConnections();
        await new Promise((r) => srv.close(r));
      }
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const root = path.resolve(import.meta.dirname, '..');
  const config = loadConfig({ envPath: path.join(root, '.env') });
  const sup = await startSupervisor({ config, root });
  console.log(`Evolv running at http://127.0.0.1:${config.port}`);
  console.log(`Recovery console (signed-in link, keep it private): http://127.0.0.1:${config.consolePort}/#key=${sup.consoleKey}`);
  console.log('Later, run "npm run console" to open it again.');
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
