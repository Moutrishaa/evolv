// Route tables are plain objects keyed "METHOD /path", with ":name" segments for parameters.
/**
 * @typedef {{ status: number, body: unknown }} RouteResult
 * @typedef {(req: import('node:http').IncomingMessage, ctx: { params: Record<string,string>, readJson: () => Promise<unknown> }) => any} Handler
 * @typedef {Record<string, Handler>} Routes   keyed "METHOD /path", with ":name" segments
 */

/**
 * @param {Routes} routes @param {string} method @param {string} rel @param {RegExp} paramRe
 * @returns {{ handler: Handler, params: Record<string,string> } | null}
 */
export function matchRoute(routes, method, rel, paramRe) {
  const parts = rel.split('/');
  for (const [key, handler] of Object.entries(routes)) {
    const space = key.indexOf(' ');
    if (key.slice(0, space) !== method) continue;
    const pattern = key.slice(space + 1).split('/');
    if (pattern.length !== parts.length) continue;
    /** @type {Record<string,string>} */
    const params = {};
    const ok = pattern.every((seg, i) => {
      if (!seg.startsWith(':')) return seg === parts[i];
      if (!paramRe.test(parts[i])) return false;
      params[seg.slice(1)] = parts[i];
      return true;
    });
    if (ok) return { handler, params };
  }
  return null;
}
