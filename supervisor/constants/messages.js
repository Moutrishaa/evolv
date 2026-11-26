// Fixed text: what the agent is told, and labels shown to the user.
// Constants only: no imports, no logic.

export const CHECK_LABELS = {
  files: 'Checking the app files',
  start: 'Starting your app',
  home: 'Checking the home page',
  console_link: 'Checking the recovery link',
  smoke: 'Checking your pages',
  alive: 'Making sure it stays running',
};

/** Where the request ends and the file list begins in the first message (the demo provider reads only the request). */
export const FILE_LIST_MARKER = '\n\nFiles in the app';

export const NUDGE ='You did not call a tool. Use the tools to make the change. When it is complete, call finish with one sentence summarising what changed.';
