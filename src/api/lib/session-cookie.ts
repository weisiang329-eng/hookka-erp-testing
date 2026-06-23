// ---------------------------------------------------------------------------
// Session-cookie builders — the single source of truth for the dashboard's
// `hookka_session` / `hookka_csrf` Set-Cookie shapes.
//
// "Remember me" (2026-06-24) controls cookie PERSISTENCE, not the server-side
// session lifetime (the user_sessions row keeps its 7-day sliding window
// either way — that's the security boundary). The `persistent` flag only
// decides where the browser keeps the cookie:
//   • persistent === true  → emit `Max-Age` so the cookie is written to disk
//     and survives a browser restart. The owner stays logged in.
//   • persistent === false → omit `Max-Age`/`Expires` entirely, making it a
//     SESSION cookie the browser drops the moment it closes. Next launch =
//     no cookie = bounced to /login.
//
// Both routes/auth.ts and routes/auth-totp.ts import these so the shape can
// never drift between the password-only and 2FA login paths.
// ---------------------------------------------------------------------------
import { SESSION_COOKIE, CSRF_COOKIE } from "./auth-middleware";

// 7-day window, matching the user_sessions TTL the sliding-refresh extends.
export const SESSION_COOKIE_TTL_S = 7 * 24 * 60 * 60;

// `hookka_session`: HttpOnly + Secure + SameSite=Strict so JS can't read the
// token and it never leaves a same-site context. This is the credential.
export function sessionCookieHeader(token: string, persistent: boolean): string {
  const base = `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/`;
  return persistent ? `${base}; Max-Age=${SESSION_COOKIE_TTL_S}` : base;
}

// `hookka_csrf`: NOT HttpOnly so the api-client can read it and echo it in the
// X-CSRF-Token header (double-submit). Secure + SameSite=Strict so a
// cross-origin page can neither read nor forge it. Same persistence as the
// session cookie so both expire together.
export function csrfCookieHeader(csrfToken: string, persistent: boolean): string {
  const base = `${CSRF_COOKIE}=${csrfToken}; Secure; SameSite=Strict; Path=/`;
  return persistent ? `${base}; Max-Age=${SESSION_COOKIE_TTL_S}` : base;
}
