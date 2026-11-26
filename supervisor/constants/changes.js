// The change lifecycle: error code to HTTP status, and which progress events end a stream.
// Constants only: no imports, no logic.

export const CHANGE_ERROR_STATUS = {
  invalid_request: 400,
  not_found: 404,
  busy: 409,
  cancelled: 409,
  too_late: 409,
  agent_limit: 422,
  verify_failed: 422,
  no_changes: 422,
  budget_exhausted: 429,
  rate_limited: 429,
  provider_error: 502,
  ledger_unreadable: 503,
  swap_failed: 500,
  internal_error: 500,
};

export const TERMINAL_EVENTS = new Set(['done', 'failed']);
