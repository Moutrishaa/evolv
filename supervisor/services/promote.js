// Promote: makes a verified workspace the new live version, or rolls back if it never became healthy.
// History only ever moves forward, with one narrow exception: a promoted version that never became
// healthy is rolled back. Git runs only through execFile, never a shell.
import { git, listVersions, buildCommitMessage } from '../models/versions.js';

export class PromoteError extends Error {
  /** @param {string} message @param {{ rolledBack?: boolean, restoredHealthy?: boolean }} [o] */
  constructor(message, { rolledBack = false, restoredHealthy = false } = {}) {
    super(message);
    this.name = 'PromoteError';
    this.code = 'swap_failed';
    this.rolledBack = rolledBack;
    this.restoredHealthy = restoredHealthy;
  }
}

/**
 * Makes a verified workspace the new live version.
 *
 *   1. refuse (touching nothing) if the live files were edited outside Evolv, or moved on since staging
 *   2. commit in the workspace
 *   3. stop the live app, fast-forward app/ to the commit, start it, wait for /health
 *   4. if it is not healthy: roll back automatically (M-R3 addition). The branch goes back to the
 *      previous version, so a version that never worked is never in History, and the previous
 *      version is started again. data/ is never touched.
 *
 * @param {{
 *   appDir: string,
 *   workspace: { base: string, commit: (message: string) => Promise<string> },
 *   meta: { request: string, summary: string, files: { path: string, status: string }[], tokens: number },
 *   app: { stop: () => Promise<void>, start: () => unknown, waitHealthy: (ms: number) => Promise<boolean> },
 *   healthTimeoutMs?: number,
 *   log?: (line: string) => void,
 * }} o
 */
export async function promote({ appDir, workspace, meta, app, healthTimeoutMs = 10000, log = () => {} }) {
  if ((await git(appDir, ['status', '--porcelain'])).trim() !== '') {
    throw new PromoteError("Your app's files were changed outside Evolv, so the new version was not applied. Nothing was changed or lost.");
  }
  const previous = (await git(appDir, ['rev-parse', 'HEAD'])).trim();
  if (workspace.base !== previous) {
    throw new PromoteError('Your app changed while this change was being prepared, so the new version was not applied. Nothing was changed or lost.');
  }
  const previousId = (await listVersions(appDir))[0]?.id ?? 1;

  const hash = await workspace.commit(buildCommitMessage(meta));

  await app.stop();
  try {
    await git(appDir, ['merge', '--ff-only', '--quiet', hash]);
  } catch {
    await git(appDir, ['reset', '--hard', '--quiet', previous]).catch(() => {});
    await app.start();
    throw new PromoteError('The new version could not be applied, so your previous version is still in place. Nothing was lost.', { rolledBack: true, restoredHealthy: await app.waitHealthy(healthTimeoutMs) });
  }
  await app.start();
  if (await app.waitHealthy(healthTimeoutMs)) return /** @type {any} */ ((await listVersions(appDir))[0]);

  log(`[supervisor] version ${previousId + 1} did not become healthy; rolling back to version ${previousId}`);
  await app.stop();
  try {
    await git(appDir, ['reset', '--hard', '--quiet', previous]);
  } catch {
    throw new PromoteError('The new version did not start properly, and Evolv could not put your previous version back automatically. Open the recovery console to restore it.');
  }
  await app.start();
  const restoredHealthy = await app.waitHealthy(healthTimeoutMs);
  throw new PromoteError(
    restoredHealthy
      ? `The new version did not start properly, so Evolv put your previous version (version ${previousId}) back. Nothing was lost.`
      : `The new version did not start properly, so Evolv put your previous version (version ${previousId}) back, but could not confirm that it is running. Open the recovery console to check.`,
    { rolledBack: true, restoredHealthy },
  );
}
