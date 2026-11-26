// The HTML the supervisor itself returns. Plain template strings: no template engine.

/** @param {string} s */
export const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Adds a loud, escaped banner to the console page. Used only when a banner is configured. @param {string} html @param {string} text */
export const withBanner = (html, text) =>
  html.replace('<title>', '<title>[DEMO] ').replace('<body>', `<body>
  <div class="demo-banner" role="alert"><strong>DEMO MODE</strong> ${escapeHtml(text)}</div>`);

/** The page at /_evolv on the app port: points to the console, which lives on its own port. @param {{ consolePort: number, banner?: string }} o */
export const consolePointerPage = ({ consolePort, banner }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Recovery console</title>
<style>body{font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem}</style></head>
<body>${banner ? `<p><strong>DEMO MODE:</strong> ${escapeHtml(banner)}</p>` : ''}<h1>Recovery console</h1>
<p>The console runs on its own address so that your app's pages can never reach it.</p>
<p><a href="http://127.0.0.1:${consolePort}/">Open the recovery console</a></p>
<p>First time on this browser? Run <code>npm run console</code> in the Evolv folder to open a signed-in link.</p>
</body></html>`;

/** Shown when the sandboxed app is not answering. */
export const appDownPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>App unavailable</title>
<style>body{font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem}</style></head>
<body><h1>The app isn't responding</h1>
<p>It may be starting up, restarting, or broken by a recent change.</p>
<p><a href="/_evolv">Open the recovery console</a></p></body></html>`;
