// Chat widget. Sends a change request to the supervisor, shows live progress, and reloads the
// page when the new version is live. Everything the server says is written as text, never markup.
const toggle = document.getElementById('chat-toggle');
const panel = document.getElementById('chat-panel');
const form = document.getElementById('chat-form');
const input = document.getElementById('chat-input');
const log = document.getElementById('chat-log');
const sendButton = document.getElementById('chat-send');
const cancelButton = document.getElementById('chat-cancel');
const output = document.getElementById('chat-output');

const API = '/_evolv/api/changes';
let running = false;
let currentId = null;
let stream = null;
let finished = false;

function say(text) {
  log.textContent = text;
}

function showOutput(text) {
  output.textContent = text || '';
  output.hidden = !text;
}

function setRunning(on) {
  running = on;
  sendButton.disabled = on;
  input.disabled = on;
  cancelButton.hidden = !on;
}

function payload(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return {};
  }
}

function toolText(name, file) {
  const where = file ? ` ${file}` : '';
  switch (name) {
    case 'read_file': return `Reading${where}`;
    case 'list_files': return 'Looking at the files';
    case 'search': return 'Searching the code';
    case 'write_file': return `Writing${where}`;
    case 'edit_file': return `Editing${where}`;
    case 'delete_file': return `Removing${where}`;
    default: return 'Wrapping up';
  }
}

async function errorMessage(res) {
  try {
    const body = await res.json();
    if (body && body.error && body.error.message) return body.error.message;
  } catch {
    /* not JSON */
  }
  return `Something went wrong (error ${res.status}). Please try again.`;
}

function follow(id) {
  if (typeof EventSource === 'undefined') {
    say('Your change was sent, but this browser cannot show progress. Reload the page in a minute to see whether it went live.');
    setRunning(false);
    return;
  }
  currentId = id;
  finished = false;
  stream = new EventSource(`${API}/${id}/events`);

  stream.addEventListener('step', (e) => say(`Working on it... (step ${payload(e).step})`));
  stream.addEventListener('tool', (e) => {
    const d = payload(e);
    say(`${toolText(d.name, d.file)}...`);
  });
  stream.addEventListener('verify', (e) => {
    const d = payload(e);
    say(`${d.label || 'Checking your app'}...`);
  });
  stream.addEventListener('promoting', () => say('Putting the new version live...'));
  stream.addEventListener('done', (e) => {
    finished = true;
    stream.close();
    say(`${payload(e).summary || 'Your change is live.'} Reloading the page...`);
    setTimeout(() => location.reload(), 1500);
  });
  stream.addEventListener('failed', (e) => {
    finished = true;
    stream.close();
    const d = payload(e);
    say(d.message || 'The change could not be made. Your app was not changed.');
    showOutput(d.output);
    setRunning(false);
  });
  stream.addEventListener('error', () => {
    if (finished || stream.readyState !== 2) return; // the browser is still trying to reconnect
    finished = true;
    say('The connection to the update was lost. Reload the page to check whether your change went live.');
    setRunning(false);
  });
}

toggle.addEventListener('click', () => {
  const open = panel.hidden;
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (running) return;
  const request = input.value.trim();
  if (!request) {
    say('Type what you would like to change first.');
    return;
  }
  setRunning(true);
  showOutput('');
  say('Sending your request...');

  let res;
  try {
    res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request }) });
  } catch {
    say('Could not reach the app. Check that Evolv is running, then try again.');
    setRunning(false);
    return;
  }
  if (!res.ok) {
    say(await errorMessage(res));
    setRunning(false);
    return;
  }
  let id = null;
  try {
    id = (await res.json()).id;
  } catch {
    /* handled below */
  }
  if (!id) {
    say('The app answered in a way this page did not understand. Please try again.');
    setRunning(false);
    return;
  }
  follow(id);
});

cancelButton.addEventListener('click', async () => {
  if (!currentId) return;
  say('Cancelling...');
  try {
    const res = await fetch(`${API}/${currentId}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!res.ok) say(await errorMessage(res));
  } catch {
    say('Could not reach the app to cancel.');
  }
});
