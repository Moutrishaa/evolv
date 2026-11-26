// Size, length and step limits. Changing one changes how strict the supervisor is.
// Constants only: no imports, no logic.

export const MAX_BODY_BYTES = 16 * 1024;

export const MAX_PATH_CHARS = 1024;

export const MAX_SEGMENT_CHARS = 255;

export const MAX_DEPTH = 20;

export const LIMITS = Object.freeze({
  maxReadLines: 2000,
  maxSearchMatches: 100,
  maxWriteBytes: 200 * 1024,
  maxListEntries: 500,
  maxFileReadBytes: 2 * 1024 * 1024,
  maxSearchFileBytes: 1024 * 1024,
  maxSearchFiles: 5000,
  maxPatternChars: 200,
  maxMatchLineChars: 200,
  maxResultChars: 60_000,
  maxSummaryChars: 600,
  undeletable: ['server.js', 'evolv.json'], // the entry point and the smoke list, at the app root
});

export const MAX_ROUTES = 50;

export const MAX_ROUTE_CHARS = 200;

export const OUTPUT_CAP = 4000;

export const HOME_BODY_CAP = 512 * 1024;

export const MAX_FORMAT_FAILURES = 3;

export const EVENT_MAX_STRING = 8000;

export const ANTHROPIC_MAX_RETRY_WAIT_MS = 10_000;

/** How long one change may run before it is stopped (5 minutes). */
export const CHANGE_TIMEOUT_MS = 5 * 60 * 1000;
