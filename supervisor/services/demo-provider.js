// DEMO ONLY. A scripted stand-in for the AI, used by `npm run demo` so the widget, progress,
// promotion and rejection can be tried without a key.
//
// It lives inside the supervisor process: no network, no key, nothing to configure. It only
// produces tool calls, and every one of them goes through the SAME tools, path guard, sandbox,
// verifier and promotion as a real model's calls. Nothing here weakens any rule.
import { estimateTokens } from '../models/ledger.js';
import { DEMO_PHRASES, DEMO_BANNER } from '../constants/demo.js';
export { DEMO_PHRASES, DEMO_BANNER };


/** Checked in this order, so "crash the page" is a crash and "rollback navy" is a rollback. */
const PRIORITY = ['rollback', 'crash', 'nolink', 'slow', 'navy', 'page'];

let counter = 0;
const use = (name, input) => ({ type: 'tool_use', id: `demo_${String(++counter).padStart(6, '0')}`, name, input });
const finish = (summary) => [use('finish', { summary })];

/** Strips the line numbers read_file adds, to get the file text back. @param {string} text */
const unnumber = (text) =>
  String(text)
    .split('\n')
    .filter((l) => !l.startsWith('['))
    .map((l) => l.replace(/^\s*\d+\t/, ''))
    .join('\n');

const ABOUT_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>About</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <main>
    <h1>About this app</h1>
    <p>This page was added by a change request in demo mode.</p>
    <p><a href="/">Back to the home page</a></p>
  </main>
</body>
</html>
`;

const POISON_PRELUDE = "// Demo: refuse to start if the saved data contains the demo trigger file.\nif (fs.existsSync(path.join(process.env.DATA_DIR, 'demo-poison.txt'))) process.exit(1);\n\n";

/** Each scenario is a list of steps. A step gets { prev, lastUse } and returns tool-call blocks. */
const SCENARIOS = {
  // Dark navy and white text. Asking again puts the original colours back.
  navy: [
    () => [use('list_files', {})],
    () => [use('read_file', { path: 'public/style.css' })],
    ({ prev }) => {
      const css = prev?.content ?? '';
      const dark = css.includes('#0b1f4b');
      // Two edits: the page colour first (the last step reads it), then the text colour.
      const [bgFrom, bgTo] = dark ? ['#0b1f4b', '#6366f1'] : ['#6366f1', '#0b1f4b'];
      const [inkFrom, inkTo] = dark ? ['--ink: #ffffff;', '--ink: #111111;'] : ['--ink: #111111;', '--ink: #ffffff;'];
      if (!css.includes(bgFrom) || !css.includes(inkFrom)) return finish('I could not find the colours to change.');
      return [
        use('edit_file', { path: 'public/style.css', old_text: bgFrom, new_text: bgTo }),
        use('edit_file', { path: 'public/style.css', old_text: inkFrom, new_text: inkTo }),
      ];
    },
    ({ prev, lastUse }) => {
      if (prev?.is_error) return finish('I could not change the colours.');
      return finish(String(lastUse?.input?.new_text ?? '').includes('#0b1f4b') ? 'Changed the background to dark navy and the text to white.' : 'Put the original light colours back.');
    },
  ],

  // An About page, a link to it, and an updated smoke list.
  page: [
    () => [use('list_files', {})],
    () => [use('read_file', { path: 'public/index.html' })],
    ({ prev }) => (String(prev?.content ?? '').includes('/about.html') ? finish('The About page is already there.') : [use('write_file', { path: 'public/about.html', content: ABOUT_PAGE })]),
    ({ prev }) => (prev?.is_error ? finish('I could not add the page.') : [use('edit_file', {
      path: 'public/index.html',
      old_text: '<h1>Meet Evolv</h1>',
      new_text: '<h1>Meet Evolv</h1>\n    <p><a href="/about.html">About this app</a></p>',
    })]),
    ({ prev }) => (prev?.is_error ? finish('I could not add the link.') : [use('write_file', { path: 'evolv.json', content: '{ "smoke": ["/", "/about.html"] }\n' })]),
    () => finish('Added an About page and a link to it.'),
  ],

  // A server that cannot start: the verifier must reject it.
  crash: [
    () => [use('list_files', {})],
    () => [use('read_file', { path: 'server.js' })],
    () => [use('write_file', { path: 'server.js', content: "// Demo: a change that cannot start.\nthrow new Error('Demo: this change deliberately crashes on start');\n" })],
    () => finish('Rewrote the server (this one is meant to fail).'),
  ],

  // Removes the recovery link: the fifth check must reject it.
  nolink: [
    () => [use('read_file', { path: 'public/index.html' })],
    ({ prev }) => (String(prev?.content ?? '').includes('<a class="console-link" href="/_evolv">Recovery Console</a>')
      ? [use('edit_file', { path: 'public/index.html', old_text: '<a class="console-link" href="/_evolv">Recovery Console</a>', new_text: '<span class="console-link">Recovery Console</span>' })]
      : finish('I could not find the recovery link.')),
    ({ prev }) => (prev?.is_error ? finish('I could not remove the link.') : finish('Removed the recovery link from the home page.')),
  ],

  // Passes verification (its data/ is empty), then fails on the live data and is rolled back.
  rollback: [
    () => [use('read_file', { path: 'server.js' })],
    ({ prev }) => {
      const source = unnumber(prev?.content ?? '');
      const marker = 'const publicDir';
      if (!source.includes(marker)) return finish('I could not find where to add the startup check.');
      return [use('write_file', { path: 'server.js', content: `${source.replace(marker, `${POISON_PRELUDE}${marker}`).replace(/\n*$/, '')}\n` })];
    },
    ({ prev }) => (prev?.is_error ? finish('I could not add the startup check.') : finish('Added a startup check on your saved data.')),
  ],

  // A long run so Cancel can be tried. (Each step waits slowDelayMs.)
  slow: [...Array.from({ length: 15 }, () => () => [use('list_files', {})]), () => finish('Done waiting.')],

  // Anything else.
  help: [
    () => [use('list_files', {})],
    () => finish(`Demo mode only understands a few words: ${DEMO_PHRASES.join(', ')}.`),
  ],
};

/** @param {any[]} messages */
function firstRequest(messages) {
  const first = messages[0]?.content;
  const text = typeof first === 'string' ? first : '';
  return text.replace(/^The user's request:\s*/i, '').split('\n\nFiles in the app')[0];
}

/** @param {any[]} messages */
function lastResult(messages) {
  const last = messages.at(-1);
  if (!last || !Array.isArray(last.content)) return null;
  return last.content.find((/** @type {any} */ b) => b.type === 'tool_result') ?? null;
}

/** @param {any[]} messages */
function lastToolUse(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && Array.isArray(m.content)) return m.content.find((/** @type {any} */ b) => b.type === 'tool_use') ?? null;
  }
  return null;
}

/** Waits `ms`, or rejects the moment the signal aborts. */
function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

/**
 * Same interface as the real adapter: assertReady() and complete().
 * @param {{ delayMs?: number, slowDelayMs?: number }} [o]
 */
export function createDemoProvider({ delayMs = 600, slowDelayMs = 1000 } = {}) {
  /** @param {string} text */
  function scenarioFor(text) {
    const t = String(text).toLowerCase();
    return PRIORITY.find((word) => t.includes(word)) ?? 'help';
  }

  return {
    delayMs,
    slowDelayMs,
    scenarioFor,
    assertReady() {},

    /** @param {{ system: string, messages: any[], tools: any[], signal?: AbortSignal }} o */
    async complete({ system, messages, signal }) {
      const scenario = scenarioFor(firstRequest(messages));
      const inputTokens = Math.max(1, estimateTokens(JSON.stringify({ system, messages })));
      const cancelled = () => Object.assign(new Error('The AI call was cancelled.'), { code: 'provider_error', aborted: true, estimatedInputTokens: inputTokens });
      try {
        await pause(scenario === 'slow' ? slowDelayMs : delayMs, signal);
      } catch {
        throw cancelled();
      }
      const turn = messages.filter((m) => m.role === 'assistant').length;
      const step = /** @type {any[]} */ (SCENARIOS[/** @type {keyof typeof SCENARIOS} */ (scenario)])[turn] ?? (() => finish('Done.'));
      const content = step({ prev: lastResult(messages), lastUse: lastToolUse(messages), turn });
      return { content, stopReason: 'tool_use', usage: { inputTokens, outputTokens: 40 + estimateTokens(JSON.stringify(content)) }, estimated: false };
    },
  };
}
