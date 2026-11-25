// Supervisor entry point: port 3000, 127.0.0.1 only.
//   /_evolv/*       -> console + API
//   everything else -> reverse proxy -> sandboxed app on 127.0.0.1
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { AppProcess } from './process.js';
import { ensureSeeded, listVersions } from './versions.js';
import { createProxy } from './proxy.js';
import { createApi, isConsolePath } from './api.js';

/**
 * @param {{ config: import('./config.js').Config, root: string, appPort?: number }} o
 */
export async function startSupervisor({ config, root, appPort = config.port + 1 }) {
  const appDir = path.join(root, 'app');
  const dataDir = path.join(appDir, 'data');

  await ensureSeeded({ seedDir: path.join(root, 'seed'), appDir });

  const app = new AppProcess({ appDir, dataDir, port: appPort });
  const proxy = createProxy({ getPort: () => appPort });

  const api = createApi({
    port: config.port,
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

  const server = http.createServer((req, res) => {
    if (isConsolePath(req.url ?? '/')) void api.handle(req, res);
    else proxy.handle(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '127.0.0.1', () => resolve(undefined)); // SEC-8: loopback only
  });

  app.start();

  return {
    server,
    app,
    async close() {
      await app.stop();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const root = path.resolve(import.meta.dirname, '..');
  const config = loadConfig({ envPath: path.join(root, '.env') });
  const sup = await startSupervisor({ config, root });
  console.log(`Evolv running at http://127.0.0.1:${config.port}  (recovery console: /_evolv)`);
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
