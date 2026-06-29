// ---------------------------------------------------------------------------
// session-cookie-remember-me.test.mjs
//
// Regression for the "Remember me" fix (2026-06-24, BUG-2026-06-24-001).
//
// Root cause: the dashboard login's session credential is the HttpOnly
// `hookka_session` cookie set by the server. The server ALWAYS emitted it
// with `Max-Age=7d` regardless of the checkbox, so the cookie was persistent
// (survived a browser restart) whether or not "Remember me" was ticked — the
// checkbox state was captured in React but never sent to the server and never
// read by it, so it did nothing.
//
// Fix: the checkbox now drives cookie PERSISTENCE via the `persistent` flag on
// the shared session-cookie builders:
//   • persistent === true  → cookie carries `Max-Age` (on-disk, survives
//     restart).
//   • persistent === false → no `Max-Age`/`Expires` → SESSION cookie the
//     browser drops on close.
//
// These tests lock in the exact Set-Cookie contract so the two cases can't
// silently collapse back into "always persistent" again.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping handles the .ts import on newer Node */
}

const m = await import(
  pathToFileURL(
    resolve(process.cwd(), "src/api/lib/session-cookie.ts"),
  ).href
);

test("checked (persistent) → session cookie carries Max-Age (survives restart)", () => {
  const h = m.sessionCookieHeader("tok-123", true);
  assert.match(h, /^hookka_session=tok-123;/);
  assert.match(h, /Max-Age=604800\b/); // 7 days in seconds
  // Security attributes must always be present.
  assert.match(h, /HttpOnly/);
  assert.match(h, /Secure/);
  assert.match(h, /SameSite=Lax/);
  assert.match(h, /Path=\//);
});

test("unchecked (session-only) → session cookie has NO Max-Age/Expires", () => {
  const h = m.sessionCookieHeader("tok-123", false);
  assert.match(h, /^hookka_session=tok-123;/);
  assert.doesNotMatch(h, /Max-Age/i);
  assert.doesNotMatch(h, /Expires/i);
  // Still fully hardened — only persistence changed, not security.
  assert.match(h, /HttpOnly/);
  assert.match(h, /Secure/);
  assert.match(h, /SameSite=Lax/);
});

test("CSRF cookie persistence tracks the session cookie", () => {
  const persistent = m.csrfCookieHeader("csrf-abc", true);
  assert.match(persistent, /^hookka_csrf=csrf-abc;/);
  assert.match(persistent, /Max-Age=604800\b/);
  // CSRF cookie is intentionally NOT HttpOnly (the api-client reads it).
  assert.doesNotMatch(persistent, /HttpOnly/);
  assert.match(persistent, /Secure/);
  assert.match(persistent, /SameSite=Lax/);

  const sessionOnly = m.csrfCookieHeader("csrf-abc", false);
  assert.doesNotMatch(sessionOnly, /Max-Age/i);
  assert.doesNotMatch(sessionOnly, /Expires/i);
});

test("the two persistence modes produce DIFFERENT headers (the bug guard)", () => {
  // The original bug was that both modes produced an identical persistent
  // cookie. This assertion fails loudly if anyone re-hardcodes Max-Age.
  assert.notEqual(
    m.sessionCookieHeader("tok", true),
    m.sessionCookieHeader("tok", false),
  );
  assert.notEqual(
    m.csrfCookieHeader("csrf", true),
    m.csrfCookieHeader("csrf", false),
  );
});
