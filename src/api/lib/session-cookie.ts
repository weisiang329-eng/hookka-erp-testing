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

// `hookka_session`: HttpOnly + Secure + SameSite=Lax so the cookie still rides
// along on cross-site NAVIGATIONS (clicking erp.hookka.com from WhatsApp Web,
// email, Notion etc — Strict drops the cookie on those, the user lands without
// a session, hits a 401, and the api-client bounces them to /login. Owner
// 2026-06-29: "为什么一直被登錄出去"). Lax still blocks cross-site forms / POSTs,
// and CSRF is double-defended by the X-CSRF-Token header (csrfCookieHeader
// below + src/lib/api-client.ts). HttpOnly keeps JS from reading the token.
export function sessionCookieHeader(token: string, persistent: boolean): string {
  const base = `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/`;
  return persistent ? `${base}; Max-Age=${SESSION_COOKIE_TTL_S}` : base;
}

// `hookka_csrf`: NOT HttpOnly so the api-client can read it and echo it in the
// X-CSRF-Token header (double-submit). Lax so it rides cross-site navigations
// in lockstep with the session cookie (otherwise the user arrives session-OK
// but CSRF-empty and their first mutating click 403s).
export function csrfCookieHeader(csrfToken: string, persistent: boolean): string {
  const base = `${CSRF_COOKIE}=${csrfToken}; Secure; SameSite=Lax; Path=/`;
  return persistent ? `${base}; Max-Age=${SESSION_COOKIE_TTL_S}` : base;
}
