// ---------------------------------------------------------------------------
// CSRF token helper — Sprint 7.
//
// On login the server sets two cookies:
//   • hookka_session — HttpOnly, the credential. JS cannot read it.
//   • hookka_csrf    — NOT HttpOnly. JS reads it here and the api-client
//                       echoes the value as `X-CSRF-Token` on mutating
//                       requests. The server compares cookie vs header
//                       (double-submit pattern). A cross-origin attacker
//                       can neither read the cookie (SameSite=Strict) nor
//                       forge the header — so they can't satisfy both
//                       sides of the check.
//
// This file is deliberately tiny so it can be imported from anywhere
// without dragging in localStorage / blob logic.
// ---------------------------------------------------------------------------

export const CSRF_COOKIE_NAME = "hookka_csrf";
export const CSRF_HEADER_NAME = "X-CSRF-Token";

/**
 * Reads a single cookie out of `document.cookie`. Returns null when the
 * cookie isn't set or the document context is missing (SSR).
 */
export function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const raw = document.cookie || "";
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    const v = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return null;
}

/** Convenience: returns the current CSRF cookie value, or null. */
export function readCsrfCookie(): string | null {
  return readCookie(CSRF_COOKIE_NAME);
}
