// `npm run console`: opens the recovery console already signed in.
// Reads the key from state/console.key (which the sandboxed app cannot read).
import path from 'node:path';
import { execFile } from 'node:child_process';
import { loadConfig } from './config.js';
import { ensureConsoleKey } from './auth.js';

const root = path.resolve(import.meta.dirname, '..');
const config = loadConfig({ envPath: path.join(root, '.env') });
const key = ensureConsoleKey(path.join(root, 'state'));
const url = `http://127.0.0.1:${config.consolePort}/#key=${key}`;

console.log('Opening the recovery console. Keep this link private:');
console.log(url);

// execFile with fixed arguments, never a shell.
const [cmd, args] =
  process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
  : process.platform === 'darwin' ? ['open', [url]]
  : ['xdg-open', [url]];
execFile(cmd, args, (err) => {
  if (err) console.log('Could not open a browser automatically. Paste the link above into one.');
});
