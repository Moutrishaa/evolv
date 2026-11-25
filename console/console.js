// Recovery console, B1: Status and Logs. Everything from the server is written with
// textContent, never innerHTML, so log lines cannot inject markup.
const API = '/_evolv/api';
const tabs = { status: document.getElementById('tab-status'), logs: document.getElementById('tab-logs') };
const statusList = document.getElementById('status-list');
const statusError = document.getElementById('status-error');
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

async function getJson(path) {
  const res = await fetch(API + path, { cache: 'no-store' });
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
  } catch (err) {
    statusError.textContent = `Could not reach the supervisor: ${err.message}`;
    statusError.hidden = false;
  }
}

refresh();
setInterval(refresh, 3000);
