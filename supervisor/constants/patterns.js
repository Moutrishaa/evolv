// Regular expressions: id and key shapes, reserved Windows names, safe route shape.
// Constants only: no imports, no logic.

export const PARAM_RE = /^[A-Za-z0-9_-]{1,64}$/;

export const APP_ID_RE = /^[A-Za-z0-9_-]{22,64}$/; // change ids are 128-bit random: unguessable


export const KEY_RE = /^[0-9a-f]{64}$/;

export const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;

export const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export const ILLEGAL_CHARS = /[<>"|?*]/;

export const SHORT_NAME = /~\d/;

export const SAFE_ROUTE = /^\/(?!\/)[^\s\\\u0000-\u001f\u007f]*$/;
