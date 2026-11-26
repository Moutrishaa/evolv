// Chat widget. Sends a change request to the supervisor, shows live progress, and reloads the
// page when the new version is live. Everything the server says is written as text, never markup.
const chips = document.getElementById('chat-chips');
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
  chips.setAttribute('aria-disabled', String(on));
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

async function errorInfo(res) {
  try {
    const body = await res.json();
    if (body && body.error && body.error.message) return { code: body.error.code, message: body.error.message };
  } catch {
    /* not JSON */
  }
  return { code: null, message: `Something went wrong (error ${res.status}). Please try again.` };
}

async function errorMessage(res) {
  return (await errorInfo(res)).message;
}

// The page forgets a running change when it is reloaded, but the Recovery Console still knows it
// and can cancel it. The link is built here, not in the HTML, so the home page keeps exactly one
// static link to the console.
function pointToConsole() {
  const link = document.createElement('a');
  link.href = '/_evolv';
  link.textContent = 'Open the Recovery Console';
  log.append(' ', link);
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
  stream.addEventListener('waiting', (e) => {
    const d = payload(e);
    const seconds = Number.isInteger(d.seconds) && d.seconds > 0 ? d.seconds : null; // only a whole number is ever shown
    const why = d.reason === 'rate_limit' ? 'The AI provider is busy (rate limit)'
      : d.reason === 'daily_limit' ? "Your AI provider's daily limit is almost used up"
      : 'The AI provider is having trouble';
    say(seconds ? `${why}. Waiting ${seconds} seconds, then trying again...` : `${why}. Waiting a moment, then trying again...`);
  });
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

async function submitText(text) {
  if (running) return;
  const request = text.trim();
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
    const info = await errorInfo(res);
    if (info.code === 'busy') {
      say(`${info.message} You can cancel it in the Recovery Console.`);
      pointToConsole();
    } else {
      say(info.message);
    }
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
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  submitText(input.value);
});

// Enter sends, Shift+Enter starts a new line.
input.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  submitText(input.value);
});

// A prompt chip sends its request straight away, exactly like typing it and pressing Send.
chips.addEventListener('click', (event) => {
  const chip = event.target && event.target.closest ? event.target.closest('button[data-request]') : null;
  if (!chip || running) return;
  submitText(chip.dataset.request || '');
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
