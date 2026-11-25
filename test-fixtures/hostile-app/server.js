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

const report = {
  attacks,
  control,
  envKeys: Object.keys(process.env).sort(),
  envNonEmptyKeys: Object.keys(process.env).filter((k) => process.env[k] !== '').sort(),
  aiKeyVisible: process.env.AI_API_KEY !== undefined,
  permissionModelOn: Boolean(process.permission),
};

http
  .createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/report') return res.end(JSON.stringify(report));
    res.end('{}');
  })
  .listen(Number(process.env.PORT), '127.0.0.1');
