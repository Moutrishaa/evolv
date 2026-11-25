// Supervisor entry point. Everything binds to 127.0.0.1 only.
//   PORT (3000)          app origin:     proxy to the sandboxed app; /_evolv/api = submit/cancel/progress only
//   CONSOLE_PORT (3002)  console origin: recovery console + full API, bearer token required
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { AppProcess } from './process.js';
import { ensureSeeded, listVersions } from './versions.js';
import { createProxy } from './proxy.js';
import { createConsoleApi, createAppApi, createFrontHandler } from './api.js';
import { ensureConsoleKey } from './auth.js';

/**
 * @param {{ config: import('./config.js').Config, root: string, appPort?: number }} o
 */
export async function startSupervisor({ config, root, appPort = config.port + 1 }) {
  const appDir = path.join(root, 'app');
  const dataDir = path.join(appDir, 'data');
  const consoleKey = ensureConsoleKey(path.join(root, 'state')); // outside app/: the sandbox cannot read it

  await ensureSeeded({ seedDir: path.join(root, 'seed'), appDir });

  const app = new AppProcess({ appDir, dataDir, port: appPort });
  const proxy = createProxy({ getPort: () => appPort });

  const consoleApi = createConsoleApi({
    port: config.consolePort,
    key: consoleKey,
    consoleDir: path.join(root, 'console'),
    routes: {
      'GET /status': async () => {
        const versions = await listVersions(appDir);
        const st = app.status();
        return {
          status: 200,
          body: {
            app: { ...st, uptimeMs: st.state === 'running' && st.startedAt ? Date.now() - st.startedAt : 0 },
            version: { current: versions[0]?.id ?? null, count: versions.length },
            // B2 adds the real token ledger. Until then nothing has been spent.
            budget: { used: 0, total: config.tokenBudget },
            node: process.version,
          },
        };
      },
      'GET /logs': () => ({ status: 200, body: { lines: app.logs.lines() } }),
    },
  });

  // B2 registers submit, cancel and progress here. Nothing else may ever be added to this table.
  const appApi = createAppApi({ port: config.port, consolePort: config.consolePort, routes: {} });

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
