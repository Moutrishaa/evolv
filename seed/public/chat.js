// Chat widget. In B1 the supervisor cannot make changes yet (that arrives with the
// agent in B2), so the widget says so instead of failing silently.
const toggle = document.getElementById('chat-toggle');
const panel = document.getElementById('chat-panel');
const form = document.getElementById('chat-form');
const log = document.getElementById('chat-log');

toggle.addEventListener('click', () => {
  const open = panel.hidden;
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  log.textContent = 'Chat is not available yet. Requesting changes will be switched on in the next build step.';
});
