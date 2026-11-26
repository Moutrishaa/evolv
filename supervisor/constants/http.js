// HTTP: security headers, allowed methods, the only console files that may be served, proxy header rules.
// Constants only: no imports, no logic.

export const SAFE_METHODS = new Set(['GET', 'HEAD']);

/** The only console files that can ever be served. */
export const CONSOLE_FILES = {
  '': ['index.html', 'text/html; charset=utf-8'],
  'index.html': ['index.html', 'text/html; charset=utf-8'],
  'console.js': ['console.js', 'text/javascript; charset=utf-8'],
  'console.css': ['console.css', 'text/css; charset=utf-8'],
};

export const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'X-Evolv-Supervisor': '1',
};

export const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
