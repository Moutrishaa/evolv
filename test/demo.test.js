// Dev-only demo mode (`npm run demo`): a scripted "AI" inside the supervisor, so the widget,
// progress, promotion and rejection can be tried without a key. It must be impossible to turn on
// from the app, the agent, .env or the environment, it must use its own data folder, and it must
// never change a security rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startDemo, loadDemoConfig } from '../supervisor/demo.js';
import { createDemoProvider, DEMO_PHRASES, DEMO_BANNER } from '../supervisor/demo-provider.js';
import { createConsoleApi, createAppApi } from '../supervisor/api.js';
import { loadConfig } from '../supervisor/config.js';
import { createTools } from '../supervisor/tools.js';
import { startEnv } from '../test-fixtures/env.js';
import { readSse, startPoller } from '../test-fixtures/net.js';
import { makeTempDir, getFreePort, getConsolePortFor, request, waitFor, sleep, gitOut, ROOT } from '../test-fixtures/helpers.js';

const JSON_HDR = (origin) => ({ 'Content-Type': 'application/json', Origin: origin });

/** A complete demo Evolv in a temp folder. Real supervisor, real sandbox, scripted AI. */
async function demoEnv({ envText = '' } = {}) {
  const tmp = makeTempDir('evolv-demo-');
  const root = path.join(tmp.dir, 'root');
  fs.mkdirSync(root);
  fs.cpSync(path.join(ROOT, 'seed'), path.join(root, 'seed'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'console'), path.join(root, 'console'), { recursive: true });
  const dataRoot = path.join(tmp.dir, 'demo-data');
  const port = await getFreePort();
  const consolePort = await getConsolePortFor(port);
  const config = loadDemoConfig({ envText, env: { PORT: String(port), CONSOLE_PORT: String(consolePort), VERIFY_TIMEOUT_MS: '4000' } });
  const lines = [];
  const demo = await startDemo({ config, root, dataRoot, appPort: await getFreePort(), delayMs: 15, slowDelayMs: 500, verifySettleMs: 200, log: (l) => lines.push(l) });
  const base = `http://127.0.0.1:${port}`;
  const cbase = `http://127.0.0.1:${consolePort}`;
  const auth = { Authorization: `Bearer ${demo.sup.consoleKey}` };
  await waitFor(async () => (await request(`${base}/health`)).status === 200, { timeout: 15000, what: 'demo app' });
  const env = {
    demo, sup: demo.sup, root, dataRoot, tmp, base, cbase, auth, lines, config,
    appDir: path.join(dataRoot, 'app'),
    status: async () => JSON.parse((await request(`${cbase}/api/status`, { headers: auth })).body),
    submit: (text) => request(`${base}/_evolv/api/changes`, { method: 'POST', headers: JSON_HDR(base), body: JSON.stringify({ request: text }) }),
    async runChange(text) {
      const res = await env.submit(text);
      assert.equal(res.status, 202, res.body);
      const { id } = JSON.parse(res.body);
      const sse = await readSse(`${base}/_evolv/api/changes/${id}/events`, { until: (e) => e.type === 'done' || e.type === 'failed', timeout: 40000 });
      return { id, events: sse.events, last: sse.events.at(-1) };
    },
    async close() {
      await demo.sup.close();
      tmp.cleanup();
    },
  };
  return env;
}

// ---------- the scripted provider on its own ----------
const firstCall = (request_) => ({ system: 's', tools: [], messages: [{ role: 'user', content: `The user's request:\n\n${request_}` }] });

test('the provider picks a scenario by keyword, with a fixed priority, and falls back to a help scenario', async () => {
  const p = createDemoProvider({ delayMs: 0, slowDelayMs: 0 });
  const names = async (text) => (await p.complete(firstCall(text))).content.filter((b) => b.type === 'tool_use').map((b) => b.name);
  assert.deepEqual(await names('make it NAVY please'), ['list_files']);
  assert.equal(p.scenarioFor('make it navy'), 'navy');
  assert.equal(p.scenarioFor('add a page'), 'page');
  assert.equal(p.scenarioFor('please crash it'), 'crash');
  assert.equal(p.scenarioFor('nolink'), 'nolink');
  assert.equal(p.scenarioFor('test a rollback'), 'rollback');
  assert.equal(p.scenarioFor('go slow'), 'slow');
  assert.equal(p.scenarioFor('hello there'), 'help');
  assert.equal(p.scenarioFor('crash the page'), 'crash', 'crash outranks page');
  assert.equal(p.scenarioFor('rollback navy'), 'rollback', 'rollback outranks navy');
  for (const phrase of DEMO_PHRASES) assert.notEqual(p.scenarioFor(phrase), 'help', phrase);
});

test('the provider speaks the same interface as the real one and cannot hold a key or reach a network', async () => {
  const p = createDemoProvider({ delayMs: 0 });
  assert.doesNotThrow(() => p.assertReady());
  const r = await p.complete(firstCall('navy'));
  assert.equal(r.stopReason, 'tool_use');
  assert.equal(r.estimated, false);
  assert.ok(Number.isInteger(r.usage.inputTokens) && r.usage.inputTokens > 0);
  assert.ok(Number.isInteger(r.usage.outputTokens) && r.usage.outputTokens > 0);
  const ids = new Set();
  for (let i = 0; i < 5; i++) for (const b of (await p.complete(firstCall('navy'))).content) ids.add(b.id);
  assert.equal(ids.size, 5, 'tool-call ids are unique');
  assert.ok(!/key|token|secret/i.test(Object.keys(p).join(',') + JSON.stringify(p)));
  assert.equal(p.fetchImpl, undefined);
});

test('a scripted step can be cancelled mid-delay, like a real call (with a rounded-up estimate)', async () => {
  const p = createDemoProvider({ delayMs: 5000 });
  const ctl = new AbortController();
  const pending = p.complete({ ...firstCall('navy'), signal: ctl.signal });
  setTimeout(() => ctl.abort(), 30);
  await assert.rejects(pending, (e) => e.aborted === true && Number.isInteger(e.estimatedInputTokens) && e.estimatedInputTokens > 0);
  const done = new AbortController();
  done.abort();
  await assert.rejects(p.complete({ ...firstCall('navy'), signal: done.signal }), (e) => e.aborted === true);
});

// ---------- every scenario, through the real supervisor ----------
test('navy: goes live as version 2, then toggles back as version 3', async () => {
  const env = await demoEnv();
  try {
    const first = await env.runChange('Change the background to dark navy and the text to white');
    assert.equal(first.last.type, 'done', JSON.stringify(first.last));
    assert.equal(first.last.data.version, 2);
    const types = first.events.map((e) => e.type);
    for (const t of ['accepted', 'staged', 'step', 'tool', 'verify', 'promoting', 'done']) assert.ok(types.includes(t), `missing ${t}`);
    assert.ok(first.events.some((e) => e.type === 'tool' && e.data.name === 'read_file' && e.data.file === 'public/style.css'), 'progress names the file');
    assert.match((await request(`${env.base}/style.css`)).body, /#0b1f4b/);

    const second = await env.runChange('navy again');
    assert.equal(second.last.type, 'done', JSON.stringify(second.last));
    assert.equal(second.last.data.version, 3);
    assert.doesNotMatch((await request(`${env.base}/style.css`)).body, /#0b1f4b/, 'the original colours are back');
    const status = await env.status();
    assert.ok(status.budget.used > 0 && status.budget.used < status.budget.total, 'the usage meter moves');
  } finally {
    await env.close();
  }
});

test('page: adds an About page and a link, updates the smoke list, and goes live', async () => {
  const env = await demoEnv();
  try {
    const r = await env.runChange('add an about page');
    assert.equal(r.last.type, 'done', JSON.stringify(r.last));
    assert.equal((await request(`${env.base}/about.html`)).status, 200);
    assert.match((await request(`${env.base}/`)).body, /href="\/about\.html"/);
    assert.match((await request(`${env.base}/`)).body, /href="\/_evolv"/, 'the recovery link is still there');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.appDir, 'evolv.json'), 'utf8')).smoke, ['/', '/about.html']);
  } finally {
    await env.close();
  }
});

test('crash: rejected by the verifier, the live app keeps serving the old version with zero downtime', async () => {
  const env = await demoEnv();
  try {
    const pid = env.sup.app.status().pid;
    const before = (await request(`${env.base}/`)).body;
    const poller = startPoller(`${env.base}/`, { intervalMs: 15 });
    const r = await env.runChange('crash it');
    const polled = await poller.stop();
    assert.equal(r.last.type, 'failed');
    assert.equal(r.last.data.code, 'verify_failed');
    assert.match(r.last.data.message, /your app was not changed/i);
    assert.match(r.last.data.output, /deliberately crashes on start/);
    assert.deepEqual(polled.failures, []);
    assert.ok(polled.results.every((x) => x.body === before));
    assert.equal(env.sup.app.status().pid, pid);
    assert.equal((await env.status()).version.current, 1);
  } finally {
    await env.close();
  }
});

test('nolink: rejected by the recovery-link check', async () => {
  const env = await demoEnv();
  try {
    const r = await env.runChange('nolink please');
    assert.equal(r.last.type, 'failed');
    assert.equal(r.last.data.code, 'verify_failed');
    assert.equal(r.last.data.checks.find((c) => !c.ok).name, 'console_link');
    assert.match(r.last.data.message, /recovery console/i);
    assert.match((await request(`${env.base}/`)).body, /href="\/_evolv"/, 'the live home page still has the link');
  } finally {
    await env.close();
  }
});

test('rollback: passes verification, fails on the live data, and is rolled back with a plain notice', async () => {
  const env = await demoEnv();
  try {
    assert.ok(fs.existsSync(path.join(env.appDir, 'data', 'demo-poison.txt')), 'the demo plants its trigger in its OWN data/');
    const headBefore = (await gitOut(env.appDir, ['rev-parse', 'HEAD'])).trim();
    const r = await env.runChange('rollback demo');
    assert.deepEqual(r.events.filter((e) => e.type === 'verify' && e.data.status === 'failed'), [], 'verification passed');
    assert.equal(r.last.type, 'failed');
    assert.equal(r.last.data.code, 'swap_failed');
    assert.match(r.last.data.message, /previous version/i);
    await waitFor(async () => (await request(`${env.base}/health`)).status === 200, { timeout: 15000, what: 'old version back' });
    assert.equal((await gitOut(env.appDir, ['rev-parse', 'HEAD'])).trim(), headBefore);
    const status = await env.status();
    assert.equal(status.notice.kind, 'rolled_back');
    assert.match(status.notice.message, /nothing was lost/i);
    assert.equal(status.version.current, 1);
  } finally {
    await env.close();
  }
});

test('slow: can be cancelled from the widget\'s cancel route', async () => {
  const env = await demoEnv();
  try {
    const { id } = JSON.parse((await env.submit('slow one')).body);
    const url = `${env.base}/_evolv/api/changes/${id}/events`;
    await readSse(url, { until: (e) => e.type === 'step' });
    const cancel = await request(`${env.base}/_evolv/api/changes/${id}/cancel`, { method: 'POST', headers: JSON_HDR(env.base), body: '{}' });
    assert.equal(cancel.status, 200);
    const sse = await readSse(url, { until: (e) => e.type === 'failed' || e.type === 'done' });
    assert.equal(sse.events.at(-1).data.code, 'cancelled');
    assert.equal((await env.status()).version.current, 1);
  } finally {
    await env.close();
  }
});

test('anything else: "nothing to apply, your app is unchanged"', async () => {
  const env = await demoEnv();
  try {
    const r = await env.runChange('what is the weather');
    assert.equal(r.last.type, 'failed');
    assert.equal(r.last.data.code, 'no_changes');
    assert.match(r.last.data.message, /unchanged/i);
  } finally {
    await env.close();
  }
});

// ---------- the banner ----------
test('demo mode shows a loud banner on the console page (before sign-in), the pointer page and Status', async () => {
  const env = await demoEnv();
  try {
    const shell = await request(`${env.cbase}/`);
    assert.equal(shell.status, 200);
    assert.match(shell.body, /class="demo-banner"/);
    assert.match(shell.body, /DEMO MODE/);
    assert.ok(shell.body.includes(DEMO_BANNER));
    assert.match(shell.body, /<title>\[DEMO\] /);
    assert.match((await request(`${env.base}/_evolv`)).body, /DEMO MODE/);
    assert.equal((await env.status()).mode, 'demo');
    assert.equal((await request(`${env.cbase}/api/status`)).status, 401, 'demo mode does not loosen the token check');
  } finally {
    await env.close();
  }
});

test('normal mode has no banner and reports mode "normal"', async () => {
  const env = await startEnv({ script: [] });
  try {
    const shell = await request(`${env.cbase}/`);
    assert.ok(!/demo-banner|DEMO/.test(shell.body));
    assert.ok(!/DEMO/.test((await request(`${env.base}/_evolv`)).body));
    assert.equal((await env.status()).mode, 'normal');
  } finally {
    await env.close();
  }
});

test('the banner text is escaped, never trusted as HTML', async () => {
  const dir = makeTempDir('evolv-banner-');
  try {
    for (const f of ['index.html', 'console.js', 'console.css']) fs.writeFileSync(path.join(dir.dir, f), f === 'index.html' ? '<html><head><title>T</title></head><body><h1>x</h1></body></html>' : 'x');
    const port = await getFreePort();
    const evil = '<script>alert(1)</script> & "quotes"';
    const api = createConsoleApi({ port, consoleDir: dir.dir, key: 'k'.repeat(64), routes: {}, banner: evil });
    const http = await import('node:http');
    const server = http.createServer((req, res) => api.handle(req, res));
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    const body = (await request(`http://127.0.0.1:${port}/`)).body;
    server.close();
    assert.ok(!body.includes('<script>alert(1)</script>'));
    assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;'));
    const appApi = createAppApi({ port, consolePort: port + 1, routes: {}, banner: evil });
    const server2 = http.createServer((req, res) => appApi.handle(req, res));
    await new Promise((r) => server2.listen(port, '127.0.0.1', r));
    const pointer = (await request(`http://127.0.0.1:${port}/_evolv`)).body;
    server2.close();
    assert.ok(!pointer.includes('<script>alert(1)</script>'));
  } finally {
    dir.cleanup();
  }
});

// ---------- isolation, no network, no key ----------
test('demo uses its own data folder and never creates or touches the real app/ or state/', async () => {
  const env = await demoEnv();
  try {
    await env.runChange('navy');
    assert.ok(fs.existsSync(path.join(env.dataRoot, 'app', '.git')));
    assert.ok(fs.existsSync(path.join(env.dataRoot, 'state', 'usage.json')));
    assert.ok(fs.existsSync(path.join(env.dataRoot, 'state', 'console.key')));
    assert.equal(fs.existsSync(path.join(env.root, 'app')), false, 'the real app/ must not exist');
    assert.equal(fs.existsSync(path.join(env.root, 'state')), false, 'the real state/ must not exist');
  } finally {
    await env.close();
  }
});

test('demo makes no AI network call, never builds the real provider, and ignores a real key', async () => {
  // Built at run time, so this file never contains a key-shaped string (test/no-secrets.test.js scans for them).
  const realKey = ['sk', 'ant', 'real-looking-key-that-must-never-load-0123456789'].join('-');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...a) => (calls.push(String(a[0])), realFetch(...a));
  let env;
  try {
    env = await demoEnv({ envText: `AI_API_KEY=${realKey}\nAI_MODEL=whatever` });
    assert.equal(env.config.apiKey, '', 'the demo config never contains a key');
    assert.notEqual(env.sup.changes.provider.constructor.name, 'AnthropicProvider');
    await env.runChange('navy');
    assert.deepEqual(calls, [], 'no fetch at all: nothing was sent anywhere');
    const everything = JSON.stringify(await env.status()) + (await request(`${env.cbase}/api/logs`, { headers: env.auth })).body + JSON.stringify(env.lines);
    assert.ok(!everything.includes(realKey));
    const scan = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) scan(full);
        else assert.ok(!fs.readFileSync(full).includes(realKey), `key found in ${full}`);
      }
    };
    scan(env.dataRoot);
  } finally {
    globalThis.fetch = realFetch;
    await env?.close();
  }
});

test('loadDemoConfig drops the key from the file AND from the real environment', () => {
  process.env.AI_API_KEY = 'sk-from-the-real-environment';
  try {
    const c = loadDemoConfig({ envText: 'AI_API_KEY=sk-from-the-file\nPORT=4100', env: process.env });
    assert.equal(c.apiKey, '');
    assert.equal(c.port, 4100, 'everything else is read as usual');
  } finally {
    delete process.env.AI_API_KEY;
  }
});

test('the terminal gets the same loud warning, the phrases to try, and both links', async () => {
  const env = await demoEnv();
  try {
    const text = env.lines.join('\n');
    assert.match(text, /DEMO MODE/);
    assert.match(text, /No real AI/i);
    for (const phrase of DEMO_PHRASES) assert.ok(text.includes(phrase), phrase);
    assert.ok(text.includes(`http://127.0.0.1:${env.config.port}`));
    assert.ok(text.includes(`http://127.0.0.1:${env.config.consolePort}/#key=${env.sup.consoleKey}`));
  } finally {
    await env.close();
  }
});

// ---------- unreachable from the app, the agent, .env and the environment ----------
test('nothing on the normal start path can turn demo mode on', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const main = read('supervisor/main.js');
  assert.equal((main.match(/process\.env/g) ?? []).length, 0, 'main.js must not read the environment');
  const argvLines = main.split('\n').filter((l) => /process\.argv/.test(l));
  assert.equal(argvLines.length, 1, 'main.js reads argv on exactly one line');
  assert.match(argvLines[0], /^const isMain = /, 'and only to detect that it is the entry script');
  assert.ok(!/--demo|EVOLV_DEMO|demo-provider|demo\.js/i.test(main), 'main.js must not know how to start demo mode');
  for (const f of ['supervisor/config.js', '.env.example']) assert.ok(!/demo/i.test(read(f)), `${f} must not mention demo`);
  assert.equal(JSON.parse(read('package.json')).scripts.start, 'node supervisor/main.js');
  assert.equal(JSON.parse(read('package.json')).scripts.demo, 'node supervisor/demo.js');
  assert.match(read('.gitignore'), /^demo-data\/$/m);
});

test('.env cannot select it: another provider is rejected and stray demo settings are ignored', () => {
  assert.throws(() => loadConfig({ envText: 'AI_PROVIDER=demo', env: {} }), /AI_PROVIDER/);
  assert.throws(() => loadConfig({ envText: 'AI_PROVIDER=fake', env: {} }), /AI_PROVIDER/);
  const plain = Object.keys(loadConfig({ envText: '', env: {} })).sort();
  const stray = Object.keys(loadConfig({ envText: 'DEMO=1\nEVOLV_DEMO=1\nDEMO_MODE=true', env: { EVOLV_DEMO: '1', DEMO: '1' } })).sort();
  assert.deepEqual(stray, plain);
});

test('the agent cannot see or reach the demo provider, the demo data folder or the supervisor', async () => {
  const env = await demoEnv();
  try {
    const ws = path.join(env.dataRoot, 'state', 'workspaces', 'probe');
    fs.mkdirSync(ws, { recursive: true });
    const tools = createTools({ root: ws });
    for (const p of ['../../../supervisor/demo-provider.js', '../../../../supervisor/demo.js', '../../app/data/demo-poison.txt', '../../../state/console.key', '..\\..\\supervisor\\demo.js']) {
      const r = tools.execute('read_file', { path: p });
      assert.equal(r.ok, false, p);
      assert.ok(!/scripted|DEMO_PHRASES|createDemoProvider/.test(r.content), p);
    }
    assert.equal(tools.execute('list_files', { dir: '../../..' }).ok, false);
  } finally {
    await env.close();
  }
});
