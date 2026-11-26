// Console-only routes (they need the bearer token): the app's status and its recent log lines.
import { listVersions } from '../models/versions.js';

/**
 * @param {{
 *   appDir: string,
 *   app: { status: () => any, logs: { lines: () => string[] } },
 *   ledger: { snapshot: () => unknown },
 *   changes: { notice: unknown, activeId: string|null, phase: string|null },
 *   ai: unknown,
 *   demo?: unknown,
 * }} o
 */
export function createConsoleController({ appDir, app, ledger, changes, ai, demo }) {
  return {
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
          // The running change, so the console can offer Cancel. The console origin needs the token; app pages never see this.
          change: changes.activeId ? { id: changes.activeId, phase: changes.phase } : null,
          mode: demo ? 'demo' : 'normal',
          ai,
          node: process.version,
        },
      };
    },
    'GET /logs': () => ({ status: 200, body: { lines: app.logs.lines() } }),
  };
}
