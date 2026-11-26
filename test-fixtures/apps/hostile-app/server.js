// HOSTILE TEST FIXTURE. Never run this outside the sandbox launcher.
// It lives in test-fixtures/ (not test/) so a bare `node --test` never executes it directly.
// It tries every attack the sandbox must stop, then reports the outcome at GET /report.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';

const appDir = import.meta.dirname;
const rootDir = path.dirname(appDir);
const dataDir = process.env.DATA_DIR;

/** Run one attack. Returns what happened without ever leaking file contents. */
function attempt(name, fn) {
  try {
    fn();
    return { name, succeeded: true, code: null };
  } catch (err) {
    return { name, succeeded: false, code: err && err.code ? String(err.code) : 'THROWN_NO_CODE' };
  }
}

const attacks = [
  attempt('read ../.env', () => fs.readFileSync(path.join(rootDir, '.env'), 'utf8')),
  attempt('read state/console.key', () => fs.readFileSync(path.join(rootDir, 'state', 'console.key'), 'utf8')),
  attempt('read supervisor/ file', () => fs.readFileSync(path.join(rootDir, 'supervisor', 'secret.js'), 'utf8')),
  attempt('read Windows system path', () =>
    fs.readFileSync(process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd', 'utf8')),
  attempt('write outside data/', () => fs.writeFileSync(path.join(rootDir, 'escaped.txt'), 'pwned')),
  attempt('write own code outside data/', () => fs.writeFileSync(path.join(appDir, 'tampered.js'), 'pwned')),
  attempt('spawn a process', () => {
    const child = spawn(process.execPath, ['-v']);
    child.on('error', () => {});
  }),
  attempt('start a worker', () => {
    const worker = new Worker('1 + 1', { eval: true });
    worker.on('error', () => {});
  }),
  attempt('load a native addon', () => process.dlopen({ exports: {} }, path.join(appDir, 'fake.node'))),
];

// Control: writing inside data/ MUST work, otherwise the sandbox is just broken.
const control = attempt('write inside data/ (control)', () =>
  fs.writeFileSync(path.join(dataDir, 'ok.txt'), 'allowed'));

// Network attacks on the console port, made from inside the sandbox. The network is open
// (--allow-net), so only the console's own authentication stands in the way.
const target = JSON.parse(fs.readFileSync(path.join(appDir, 'target.json'), 'utf8'));
const consoleOrigin = `http://127.0.0.1:${target.consolePort}`;

function call(name, method, urlPath, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: target.consolePort, method, path: urlPath, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ name, status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', (err) => resolve({ name, status: 0, body: '', error: err.code }));
    req.end(method === 'POST' ? '{}' : undefined);
  });
}

const forged = { Origin: consoleOrigin };
const netAttacks = Promise.all([
  call('GET console shell', 'GET', '/'),
  call('GET /api/status, no token', 'GET', '/api/status', forged),
  call('POST /api/reset, forged Origin, no token', 'POST', '/api/reset', forged),
  call('POST /api/versions/undo, forged Origin, no token', 'POST', '/api/versions/undo', forged),
  call('POST /api/versions/1/restore, forged Origin, no token', 'POST', '/api/versions/1/restore', forged),
  call('POST /api/reset, guessed bearer', 'POST', '/api/reset', { ...forged, Authorization: 'Bearer ' + '0'.repeat(64) }),
  call('POST /api/reset, cookie only', 'POST', '/api/reset', { ...forged, Cookie: 'evolv_session=guess' }),
]);

let report;
const ready = netAttacks.then((net) => {
  report = {
    attacks,
    control,
    net,
    envKeys: Object.keys(process.env).sort(),
    envNonEmptyKeys: Object.keys(process.env).filter((k) => process.env[k] !== '').sort(),
    aiKeyVisible: process.env.AI_API_KEY !== undefined,
    permissionModelOn: Boolean(process.permission),
  };
});

http
  .createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/report') {
      await ready;
      return res.end(JSON.stringify(report));
    }
    res.end('{}');
  })
  .listen(Number(process.env.PORT), '127.0.0.1');
