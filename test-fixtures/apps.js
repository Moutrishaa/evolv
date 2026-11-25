// Builders for small apps used to test the verifier, promotion and the whole pipeline.
// Each follows the app contract (entry server.js, PORT, /health, evolv.json) unless a test
// deliberately breaks one rule.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.js';

export const LINK = '<a href="/_evolv">Recovery console</a>';
export const SEED_SERVER = fs.readFileSync(path.join(ROOT, 'seed', 'server.js'), 'utf8');

/**
 * Source for a tiny server.js.
 * @param {{ home?: string, homeType?: string, homeStatus?: number, healthStatus?: number,
 *   routes?: Record<string, [number, string]>, top?: string, listenDelayMs?: number, dieAfterMs?: number }} [o]
 */
export function serverSource({ home = `<h1>Hello</h1>${LINK}`, homeType = 'text/html', homeStatus = 200, healthStatus = 200, routes = {}, top = '', listenDelayMs = 0, dieAfterMs = 0 } = {}) {
  const routeCode = Object.entries(routes)
    .map(([p, [status, body]]) => `  if (req.url === ${JSON.stringify(p)}) { res.writeHead(${status}); return res.end(${JSON.stringify(body)}); }`)
    .join('\n');
  return `import http from 'node:http';
${top}
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(${healthStatus}); return res.end('ok'); }
  if (req.url === '/') { res.writeHead(${homeStatus}, { 'Content-Type': ${JSON.stringify(homeType)} }); return res.end(${JSON.stringify(home)}); }
${routeCode}
  res.writeHead(404); res.end('not found');
});
setTimeout(() => server.listen(Number(process.env.PORT), '127.0.0.1'), ${listenDelayMs});
${dieAfterMs ? `setTimeout(() => process.exit(7), ${listenDelayMs + dieAfterMs});` : ''}
`;
}

/** Writes a complete app folder. `files` overrides or adds files; `smoke` sets evolv.json. */
export function writeApp(dir, { server = serverSource(), smoke = ['/'], files = {}, rawEvolv } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }\n');
  if (server !== null) fs.writeFileSync(path.join(dir, 'server.js'), server);
  if (rawEvolv !== null) fs.writeFileSync(path.join(dir, 'evolv.json'), rawEvolv ?? JSON.stringify({ smoke }));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

/** The real seed server with a prelude that makes it exit if DATA_DIR/poison.txt exists. */
export const POISON_SERVER = SEED_SERVER.replace(
  "const publicDir",
  "import { existsSync } from 'node:fs';\nif (existsSync(path.join(process.env.DATA_DIR, 'poison.txt'))) process.exit(1);\nconst publicDir",
);

// Whole-server variants for end-to-end change scripts (each is a complete replacement server.js).
export const CRASH_ON_START = "throw new Error('boom: this app cannot start');\n";
export const SYNTAX_ERROR = 'this is { not valid javascript\n';
export const NEVER_LISTENS = 'setInterval(() => {}, 1000);\n';
