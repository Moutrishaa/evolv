// Recovery console, B1: Status and Logs. Everything from the server is written with
// textContent, never innerHTML, so log lines cannot inject markup.
// The console key is the bearer token. It arrives once in the URL fragment (never sent to a
// server), is kept in this origin's localStorage, and is sent only in the Authorization header.
// No cookies are used, so no other page can make this console act.
const API = '/api';
const KEY_STORE = 'evolv_console_key';
let memoryKey = null;
const fromHash = /^#key=([0-9a-f]{64})$/.exec(location.hash);
if (fromHash) {
  memoryKey = fromHash[1];
  try { localStorage.setItem(KEY_STORE, memoryKey); } catch { /* private mode: keep it in memory */ }
  history.replaceState(null, '', location.pathname + location.search);
}
function currentKey() {
  if (memoryKey) return memoryKey;
  try { return localStorage.getItem(KEY_STORE); } catch { return null; }
}
const tabs = { status: document.getElementById('tab-status'), logs: document.getElementById('tab-logs') };
const statusList = document.getElementById('status-list');
const statusError = document.getElementById('status-error');
const loginHelp = document.getElementById('login-help');
const main = document.getElementById('main-content');
const logView = document.getElementById('log-view');
let active = 'status';

for (const button of document.querySelectorAll('nav button')) {
  button.addEventListener('click', () => {
    active = button.dataset.tab;
    for (const b of document.querySelectorAll('nav button')) b.setAttribute('aria-selected', String(b === button));
    for (const [name, el] of Object.entries(tabs)) el.hidden = name !== active;
    refresh();
  });
}

class LoginNeeded extends Error {}

async function getJson(path) {
  const key = currentKey();
  if (!key) throw new LoginNeeded();
  const res = await fetch(API + path, { cache: 'no-store', headers: { Authorization: 'Bearer ' + key } });
  if (res.status === 401) throw new LoginNeeded();
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

function renderStatus(s) {
  const rows = [
    ['App', s.app.state],
    ['Process id', s.app.pid ?? 'none'],
    ['Port', s.app.port],
    ['Uptime', `${Math.round(s.app.uptimeMs / 1000)} s`],
    ['Restarts', s.app.restarts],
    ['Current version', s.version.current === null ? 'none' : `v${s.version.current}`],
    ['Versions saved', s.version.count],
    ['AI usage', `${s.budget.used} / ${s.budget.total} tokens`],
    ...(s.budget.problem ? [['Usage record problem', s.budget.problem]] : []),
    ...(s.notice ? [['Notice', s.notice.message]] : []),
    ...(s.mode === 'demo' ? [['Mode', 'DEMO: scripted AI, no real model']] : []),
    ...(s.ai ? [['AI provider', `${s.ai.provider}${s.ai.model ? ` (model ${s.ai.model})` : ''}`]] : []),
    ...(s.ai && s.ai.host ? [['AI requests go to', s.ai.host]] : []),
    ['Node', s.node],
  ];
  statusList.replaceChildren();
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = String(value);
    statusList.append(dt, dd);
  }
}

async function refresh() {
  try {
    if (active === 'status') renderStatus(await getJson('/status'));
    else {
      const { lines } = await getJson('/logs');
      const stick = logView.scrollTop + logView.clientHeight >= logView.scrollHeight - 8;
      logView.textContent = lines.map((l) => `${l.time}  ${l.text}`).join('\n') || '(no log lines yet)';
      if (stick) logView.scrollTop = logView.scrollHeight;
    }
    statusError.hidden = true;
    loginHelp.hidden = true;
    main.hidden = false;
  } catch (err) {
    if (err instanceof LoginNeeded) {
      loginHelp.hidden = false;
      main.hidden = true;
      return;
    }
    statusError.textContent = `Could not reach the supervisor: ${err.message}`;
    statusError.hidden = false;
  }
}

refresh();
setInterval(refresh, 3000);
