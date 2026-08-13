// ---------------------------------------------------------------------------
// D1-backed auth route — login / logout / me / change-password.
//
// Session tokens are opaque UUIDs (crypto.randomUUID) stored in user_sessions
// with a 7-day fixed-at-issue lifetime that's slid forward by 7 days on every
// authenticated request whose remaining lifetime drops below 24h (Sprint 4).
// The authMiddleware in src/api/lib/auth-middleware.ts handles both token
// verification and the sliding refresh for every non-public /api/* request,
// so /me and /change-password can assume the request is already authenticated
// by the time the handler runs.
//
// Sprint 7: dashboard logins now land the session token in a HttpOnly
// `hookka_session` cookie instead of the JSON body. A second non-HttpOnly
// `hookka_csrf` cookie holds a per-session CSRF token that the client must
// echo via `X-CSRF-Token` on mutating requests (double-submit pattern,
// enforced in auth-middleware.ts). The body still carries the public user
// blob so the login page can render the welcome state without an extra
// /me round-trip, but the token itself never touches localStorage.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import { permissionsForRole } from "../lib/role-policy";
import { hiddenNavPrefixes, hiddenNavForRole, homeForPermissions } from "../lib/nav-permissions";
import type { Context } from "hono";
import type { Env } from "../worker";
import { hashPassword, verifyPassword } from "../lib/password";
import { validatePasswordStrength } from "../lib/password-strength";
import { emitCounter } from "../lib/observability";
import {
  checkLoginRateLimit,
  clearLoginRateLimit,
  clientIp,
} from "../lib/rate-limit";
import { emitAudit } from "../lib/audit";
import { issuePendingTotpToken } from "../lib/totp-pending";
import {
  SESSION_COOKIE,
  CSRF_COOKIE,
} from "../lib/auth-middleware";
import {
  sessionCookieHeader,
  csrfCookieHeader,
} from "../lib/session-cookie";

const app = new Hono<Env>();

// Sprint 4: dashboard session window dropped from 30 days to 7 days, BUT
// the auth-middleware sliding-refresh extends expiresAt back to +7 days
// on every authenticated request whose remaining lifetime is < 24h. Net
// effect: an active user stays logged in indefinitely; an inactive user
// is bounced after 7 days of no traffic. Matches the behaviour the
// security review flagged (30-day fixed window was too forgiving for a
// dashboard that controls money).
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Set-Cookie builders live in ../lib/session-cookie so the password-only and
// 2FA login paths can't drift. "Remember me" → persistent (on-disk) cookie;
// unchecked → session cookie cleared on browser close. See that file.
//
// Clear cookie variants — Max-Age=0 + empty value tells the browser to drop
// the cookie immediately. Path/SameSite must mirror the originally-issued
// cookie or the browser ignores the clear.
// SameSite must match the originally-issued cookie (now Lax — see
// session-cookie.ts) or the browser ignores the clear and the cookie lingers.
const SESSION_CLEAR_COOKIE = `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
const CSRF_CLEAR_COOKIE = `${CSRF_COOKIE}=; Secure; SameSite=Lax; Path=/; Max-Age=0`;

// Random URL-safe-ish CSRF token. crypto.randomUUID() is plenty of entropy
// (122 bits) and is already used for session tokens — no need for a heavier
// base64-of-random-bytes here.
function newCsrfToken(): string {
  return crypto.randomUUID();
}

// Set both cookies on the response (login / accept-invite / TOTP verify).
// Hono lets us call header() twice with the same name — both Set-Cookie
// lines land in the response.
//
// `persistent` defaults to true so any caller that doesn't opt in keeps the
// pre-"Remember me" behaviour (a 7-day persistent cookie). Only the password
// login passes it through from the checkbox.
function issueSessionCookies(c: { header: (k: string, v: string, opts?: { append?: boolean }) => void }, sessionToken: string, csrfToken: string, persistent = true): void {
  c.header("Set-Cookie", sessionCookieHeader(sessionToken, persistent), { append: true });
  c.header("Set-Cookie", csrfCookieHeader(csrfToken, persistent), { append: true });
}

type UserRow = {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  isActive: number;
  createdAt: string;
  lastLoginAt: string | null;
  displayName: string | null;
  // Phase C.6 — TOTP 2FA. Non-null totpEnrolledAt means the user MUST present
  // a TOTP code (or recovery code) before /login issues a session.
  totpSecret?: string | null;
  totpEnrolledAt?: string | null;
  // TRUE while the account still carries the password an ADMIN chose for it.
  // Until the person changes it, nothing the account does can be attributed to
  // them — the admin knows the credential too. Dual-keyed: the column is
  // snake_case and db-pg camelCases it on read.
  mustChangePassword?: boolean | number | null;
  must_change_password?: boolean | number | null;
};

function publicUser(u: UserRow) {
  const mustChange = u.mustChangePassword ?? u.must_change_password ?? false;
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    displayName: u.displayName ?? "",
    // Surfaced so the app can make the first thing an admin-created user does
    // be choosing their own password. Nothing else depends on it.
    mustChangePassword: mustChange === true || mustChange === 1,
  };
}

function bearerTokenFrom(req: Request): string | null {
  const auth = req.headers.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Resolve the dashboard session token from the request — cookie first
// (Sprint 7 default), Authorization: Bearer fallback (legacy). Returns null
// if neither present or empty.
function sessionTokenFrom(req: Request): string | null {
  const cookieHeader = req.headers.get("cookie");
  if (cookieHeader) {
    for (const part of cookieHeader.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === SESSION_COOKIE) {
        const v = part.slice(eq + 1).trim();
        if (v) {
          try { return decodeURIComponent(v); } catch { return v; }
        }
      }
    }
  }
  return bearerTokenFrom(req);
}

// ----- POST /api/auth/login -----------------------------------------------
// Body: { email, password }
// Returns: { success, data: { token, user } }
app.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { email, password, rememberMe } = body as {
    email?: string;
    password?: string;
    rememberMe?: boolean;
  };
  // "Remember me" → persistent (on-disk) cookie that survives a browser
  // restart. Unchecked / absent → session cookie cleared when the browser
  // closes. Coerce to a strict boolean so a missing/odd value falls back to
  // the safer session-only behaviour.
  const persistSession = rememberMe === true;
  if (!email || !password) {
    return c.json(
      { success: false, error: "email and password are required" },
      400,
    );
  }

  // Brute-force throttle — 10 attempts / 15 min keyed on email + ip.
  const rlKey = `${email.trim().toLowerCase()}:${clientIp(c)}`;
  const rlDenied = await checkLoginRateLimit(c, rlKey);
  if (rlDenied) return rlDenied;

  // The adapter retries a transient connection-create failure once; if it
  // STILL throws here the DB is genuinely unreachable — return a friendly,
  // retriable 503 instead of letting it surface as a raw 500 (the "login can't
  // load" the operator sees on weak-wifi days). See HANDOFF-ERP-PERFORMANCE.md.
  let user: UserRow | null;
  try {
    user = await c.var.DB.prepare(
      "SELECT * FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1",
    )
      .bind(email.trim())
      .first<UserRow>();
  } catch (err) {
    console.warn(
      "[auth/login] user lookup failed (DB connection):",
      err instanceof Error ? err.message : String(err),
    );
    return c.json(
      {
        success: false,
        error: "Login service is busy right now — please try again in a moment.",
      },
      503,
    );
  }
  if (!user) {
    // P6.3 — count failed logins. We deliberately do NOT include the email
    // in the metric blob (PII / brute-force enumeration) — just the count.
    emitCounter(c, "auth.login_fail", { resource: "unknown_email" });
    // Sprint 2 task 5 — audit row on every failed login attempt. resourceId
    // hashed-or-truncated email so we can spot brute-force patterns without
    // dumping raw plaintext into the audit table.
    await emitAudit(c, {
      resource: "auth",
      resourceId: email.trim().toLowerCase().slice(0, 64),
      action: "login.fail",
      after: { reason: "unknown_email" },
    });
    return c.json({ success: false, error: "Invalid credentials" }, 401);
  }
  if (user.isActive !== 1) {
    emitCounter(c, "auth.login_fail", { resource: "account_disabled" });
    await emitAudit(c, {
      resource: "auth",
      resourceId: user.id,
      action: "login.fail",
      after: { reason: "account_disabled" },
    });
    return c.json({ success: false, error: "Account disabled" }, 403);
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    emitCounter(c, "auth.login_fail", { resource: "bad_password" });
    await emitAudit(c, {
      resource: "auth",
      resourceId: user.id,
      action: "login.fail",
      after: { reason: "bad_password" },
    });
    return c.json({ success: false, error: "Invalid credentials" }, 401);
  }

  // Phase C.6 — TOTP gate. If the user is enrolled, do NOT issue a session
  // here; the frontend must POST { userId, code } to
  // /api/auth/totp/login-verify which issues the session on success.
  // Returning userId (NOT a token) is intentional — userId alone is useless
  // without a valid TOTP/recovery code.
  //
  // 2026-08-13 (BUG-2026-08-13-101): the reverse was ALSO true and was not
  // intended — a valid TOTP/recovery code plus a userId was useless without…
  // nothing. `/login-verify` never checked that this password step had
  // happened, so 2FA was an alternative first factor rather than a second one.
  // We now also mint a PENDING-2FA token here, which `/login-verify` requires.
  //
  // The recorded decision above is preserved, not reversed: what step 1 must
  // not hand back is anything that grants access to the app. `pendingToken` is
  // not a session — it is accepted at exactly one endpoint, it grants nothing
  // by itself, it dies in five minutes, and it is burned when a session is
  // issued from it. See src/api/lib/totp-pending.ts.
  if (TOTP_LOGIN_ENFORCEMENT_ENABLED && user.totpEnrolledAt) {
    let pendingToken: string;
    try {
      pendingToken = await issuePendingTotpToken(c.var.DB, user.id);
    } catch (err) {
      // Deliberately a hard failure. The alternatives are both worse: issuing
      // the session here skips the second factor, and returning the old
      // `{ totpRequired, userId }` shape hands back a step-2 the caller cannot
      // pass. "Try again" is the only safe answer.
      console.warn(
        "[auth/login] pending-2FA token issue failed:",
        err instanceof Error ? err.message : String(err),
      );
      return c.json(
        {
          success: false,
          error: "Login service is busy right now — please try again in a moment.",
        },
        503,
      );
    }
    return c.json({
      success: true,
      totpRequired: true,
      userId: user.id,
      pendingToken,
    });
  }

  // 2026-05-27 — Soft 2FA prompt for SUPER_ADMIN. Computed BEFORE we issue
  // the session so the FE can decide whether to interrupt the dashboard
  // navigation with a setup modal. Failures here MUST NOT block login —
  // every branch is wrapped so a wedged audit table never locks anyone out.
  // See computeTotpPrompt() below for the policy.
  const totpPrompt = await computeTotpPrompt(c, user).catch((err) => {
    console.warn(
      "[auth/login] totp prompt compute failed (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  });

  const token = crypto.randomUUID();
  const csrfToken = newCsrfToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);

  // Atomic: write session + update lastLoginAt in one batch.
  await c.var.DB.batch([
    c.var.DB.prepare(
      "INSERT INTO user_sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)",
    ).bind(token, user.id, now.toISOString(), expires.toISOString()),
    c.var.DB.prepare("UPDATE users SET lastLoginAt = ? WHERE id = ?").bind(
      now.toISOString(),
      user.id,
    ),
  ]);

  // P6.3 — count successful logins for the dashboard.
  emitCounter(c, "auth.login_success", { resource: user.role });
  // Reset the rate-limit counter on successful login so today's attempts
  // don't carry over. waitUntil is best-effort — executionCtx getter throws
  // outside Worker isolates (tests, local node), so fall back to fire-and-
  // forget. The cleanup is idempotent.
  try {
    c.executionCtx.waitUntil(clearLoginRateLimit(c, rlKey));
  } catch {
    void clearLoginRateLimit(c, rlKey).catch(() => {});
  }
  // Sprint 2 task 5 — audit row for the successful login. We deliberately
  // do NOT include the bearer token in the snapshot.
  await emitAudit(c, {
    resource: "auth",
    resourceId: user.id,
    action: "login",
    after: { role: user.role, email: user.email },
  });

  // Sprint 7: token lives in the HttpOnly cookie; only the public user blob
  // and the CSRF token come back in the JSON body. The CSRF token is also
  // available via the non-HttpOnly cookie — we mirror it in the body so
  // tests / curl users can grab it without parsing Set-Cookie.
  issueSessionCookies(c, token, csrfToken, persistSession);
  // Soft 2FA prompt fields are folded into the existing data envelope so
  // the FE can read response.data.totpPromptRequired / severity. When the
  // helper returned null (computation failed) we omit both keys — the FE
  // treats absence as "no prompt", matching pre-2FA behaviour.
  return c.json({
    success: true,
    data: {
      user: publicUser(user),
      csrfToken,
      ...(totpPrompt
        ? {
            totpPromptRequired: true,
            severity: totpPrompt.severity,
          }
        : {}),
    },
  });
});

// ---------------------------------------------------------------------------
// computeTotpPrompt — soft-enforcement 2FA policy for SUPER_ADMIN logins.
//
// Returns null when no prompt should be shown (non-admin role, already
// enrolled, dismissed in last 24h, or the lookup failed).
//
// Severity ladder:
//   • "hard" — SUPER_ADMIN created AFTER the cutoff (2026-05-28). No grace
//     period; the FE must navigate to /setup-2fa and refuse to dismiss.
//   • "soft" — Existing SUPER_ADMIN whose 14-day grace has elapsed AND who
//     hasn't dismissed the prompt today. FE shows a modal with "Remind me
//     later".
//   • "info" — Existing SUPER_ADMIN still inside the 14-day grace window.
//     FE renders a small banner only; no modal interruption.
//
// Lock-out safety: this only fires when totpEnrolledAt is NULL (user has
// not yet set up 2FA). Once they do, the regular TOTP gate above handles
// every subsequent login. There is no scenario where this helper can
// prevent the password-only login from succeeding — it only annotates the
// response with a hint.
// ---------------------------------------------------------------------------
// 2026-08-04 KILL SWITCH (BUG-2026-08-04-006). The login-time TOTP verify step
// was never built on the frontend — there is no page that POSTs
// { userId, code } to /api/auth/totp/login-verify — so the moment a user
// enrolls in 2FA the hard gate below returns { totpRequired } with no way to
// enter a code, and login.tsx crashes ("Cannot read properties of undefined
// (reading 'user')"). A SUPER_ADMIN (nico) locked himself out exactly this way.
// Until the verify flow ships, disable BOTH the hard gate AND the soft prompt
// that lures admins into enrolling. Flip back to true when login-verify exists.
const TOTP_LOGIN_ENFORCEMENT_ENABLED = false;
const TOTP_HARD_ENFORCE_CUTOFF_MS = Date.parse("2026-05-28T00:00:00.000Z");
const TOTP_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
const TOTP_DISMISS_COOLOFF_MS = 24 * 60 * 60 * 1000;

async function computeTotpPrompt(
  c: Context<Env>,
  user: UserRow,
): Promise<{ severity: "soft" | "info" | "hard" } | null> {
  // Kill switch (BUG-2026-08-04-006): no soft prompt while 2FA login is
  // disabled — do not lure anyone into enrolling into a feature that would lock
  // them out. Re-enable with TOTP_LOGIN_ENFORCEMENT_ENABLED once login-verify ships.
  if (!TOTP_LOGIN_ENFORCEMENT_ENABLED) return null;
  // Only SUPER_ADMIN gets the prompt for now. Other roles can opt-in
  // manually via Settings → Security in a future enhancement.
  if (user.role !== "SUPER_ADMIN") return null;
  // Already enrolled → no prompt; the TOTP gate handles them.
  if (user.totpEnrolledAt) return null;

  // createdAt may be missing on legacy seed rows — treat missing as
  // "ancient" so the grace clock has already elapsed.
  const createdMs = user.createdAt ? Date.parse(user.createdAt) : 0;
  const now = Date.now();

  // Hard branch — new super admins minted after the cutoff get NO grace.
  // Forces them to /setup-2fa on first login. Wei Siang's account predates
  // the cutoff so this branch never fires for him.
  if (Number.isFinite(createdMs) && createdMs >= TOTP_HARD_ENFORCE_CUTOFF_MS) {
    return { severity: "hard" };
  }

  // Within the 14-day grace window → informational banner only.
  const graceExpiresMs = createdMs + TOTP_GRACE_MS;
  if (Number.isFinite(graceExpiresMs) && graceExpiresMs > now) {
    return { severity: "info" };
  }

  // Grace expired. Check if the user dismissed the prompt in the last 24h —
  // if so, give them the rest of the day off. Best-effort query; on error
  // we err on the side of showing the prompt (more secure default than
  // accidentally skipping it).
  try {
    const dismissedSinceIso = new Date(
      now - TOTP_DISMISS_COOLOFF_MS,
    ).toISOString();
    const recent = await c.var.DB.prepare(
      `SELECT ts FROM audit_events
        WHERE resource = 'auth-totp'
          AND resourceId = ?
          AND action = 'totp-dismissed'
          AND ts >= ?
        ORDER BY ts DESC
        LIMIT 1`,
    )
      .bind(user.id, dismissedSinceIso)
      .first<{ ts: string }>();
    if (recent) return null;
  } catch (err) {
    console.warn(
      "[auth/login] dismiss-lookup failed (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
  }

  return { severity: "soft" };
}

// ----- POST /api/auth/logout ----------------------------------------------
// Deletes the caller's session AND purges the KV session cache so the token
// stops working immediately (otherwise auth-middleware's KV cache would keep
// the logged-out session alive for up to SESSION_CACHE_TTL_S).
// Idempotent: unknown/missing token → still ok.
//
// Sprint 7: prefers the cookie token; on success clears both auth cookies
// so the next request from this browser is fully unauthenticated.
app.post("/logout", async (c) => {
  const token = sessionTokenFrom(c.req.raw);
  // Capture userId BEFORE deletion so the audit row has a real actor id.
  const userId = (c as unknown as { get: (k: string) => string | undefined }).get(
    "userId",
  );
  if (token) {
    const { invalidateSessionCache } = await import("../lib/auth-middleware");
    await Promise.all([
      c.var.DB.prepare("DELETE FROM user_sessions WHERE token = ?")
        .bind(token)
        .run(),
      invalidateSessionCache(c.env.SESSION_CACHE, token),
    ]);
    // Sprint 2 task 5 — emit audit on every logout call. Idempotent calls
    // (no token, no session) skip the audit row entirely.
    if (userId) {
      await emitAudit(c, {
        resource: "auth",
        resourceId: userId,
        action: "logout",
      });
    }
  }
  // Clear cookies regardless — even if the token was missing/unknown the
  // browser may still hold a stale pair.
  c.header("Set-Cookie", SESSION_CLEAR_COOKIE, { append: true });
  c.header("Set-Cookie", CSRF_CLEAR_COOKIE, { append: true });
  return c.json({ success: true });
});

// ----- GET /api/auth/me ---------------------------------------------------
// Requires the auth middleware to have stashed userId on the ctx.
app.get("/me", async (c) => {
  const userId = (c as unknown as { get: (k: string) => unknown }).get(
    "userId",
  ) as string | undefined;
  if (!userId) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }
  const user = await c.var.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(userId)
    .first<UserRow>();
  if (!user) {
    return c.json({ success: false, error: "User not found" }, 404);
  }
  return c.json({ success: true, data: { user: publicUser(user) } });
});

// ----- GET /api/auth/me/permissions ---------------------------------------
// Returns the resolved (resource, action) permission strings for the caller's
// role. The frontend uses this to gate routes + nav links so users don't
// bounce off API 403s after navigating (P3.6).
//
// Shape: { success: true, permissions: string[] } — each entry is
//        "resource:action", e.g. "invoices:read".
//
// SUPER_ADMIN: returns ["*"] as a single sentinel — the frontend treats it
// as "allow everything". Cheaper than enumerating the full matrix and aligns
// with the bypass behavior in src/api/lib/rbac.ts.
//
// READ_ONLY fallback: users without a roleId fall through to role_read_only
// per the same convention as rbac.ts.
app.get("/me/permissions", async (c) => {
  const userId = (c as unknown as { get: (k: string) => unknown }).get(
    "userId",
  ) as string | undefined;
  if (!userId) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  // Defensive wrap (2026-04-26 prod 500 dogfood report): if the roles /
  // role_permissions tables are missing or the JOIN throws, degrade to a
  // legacy lookup against users.role TEXT and surface a permissive
  // ["*:read"] set so the UI keeps gating reads sensibly. SUPER_ADMIN /
  // ADMIN still get the wildcard. Mutations stay forbidden until the
  // operator re-applies migrations.
  try {
    // Look up the user's role (id + name). Empty roleId -> READ_ONLY fallback,
    // mirroring rbac.ts's role resolution.
    // BUG-2026-08-05: this resolved the role ONLY through users.roleId →
    // roles.name, while the GATE (rbac.ts) reads the users.role TEXT and
    // short-circuits SUPER_ADMIN / ADMIN. The owner's row carries
    // role='SUPER_ADMIN' but a roleId the roles table doesn't resolve, so the
    // menu asked this endpoint, got the READ_ONLY fallback, and hid
    // /procurement/pi and the HR group from him — while every one of those
    // pages opened fine by URL, because the gate knew he was SUPER_ADMIN.
    // Read BOTH and let the legacy TEXT stand in, so the menu can never
    // disagree with the gate that enforces it.
    const roleRow = await c.var.DB.prepare(
      `SELECT u.roleId AS roleId, u.role AS "legacyRole", r.name AS "roleName"
         FROM users u
         LEFT JOIN roles r ON r.id = u.roleId
        WHERE u.id = ?
        LIMIT 1`,
    )
      .bind(userId)
      .first<{ roleId: string | null; legacyRole: string | null; roleName: string | null }>();

    if (!roleRow) {
      // Authenticated but no users row — shouldn't happen in practice.
      return c.json({ success: true, permissions: [] });
    }

    const resolvedRole = roleRow.roleName ?? roleRow.legacyRole ?? null;

    // SUPER_ADMIN / ADMIN bypass — sentinel list keeps the payload tiny and
    // matches the rbac.ts short-circuit, which grants BOTH "*:*".
    if (resolvedRole === "SUPER_ADMIN" || resolvedRole === "ADMIN") {
      return c.json({
        success: true,
        role: resolvedRole,
        permissions: ["*"],
        navHidden: [],
        home: "/dashboard",
      });
    }

    const roleId = roleRow.roleId ?? "role_read_only";
    const roleName = resolvedRole ?? "READ_ONLY";

    // A role whose policy is written in CODE never touches the table — the same
    // short-circuit rbac.ts uses for the GATE. Reading the table here while the
    // gate read the code would hand the browser a different answer from the one
    // the API enforces: menus for pages that 403, or pages hidden that work.
    const coded = permissionsForRole(roleName);
    if (coded) {
      return c.json({
        success: true,
        role: roleName,
        permissions: [...coded],
        navHidden: [...new Set([...hiddenNavPrefixes(coded), ...hiddenNavForRole(roleName)])],
        home: homeForPermissions(coded, roleName),
      });
    }

    const permsRes = await c.var.DB.prepare(
      `SELECT p.resource AS resource, p.action AS action
         FROM role_permissions rp
         JOIN permissions p ON rp.permissionId = p.id
        WHERE rp.roleId = ?`,
    )
      .bind(roleId)
      .all<{ resource: string; action: string }>();

    const rows = permsRes.results ?? [];
    const permissions = rows.map((r) => `${r.resource}:${r.action}`);

    return c.json({
      success: true,
      role: roleName,
      permissions,
      // Computed here so the browser never needs to know which resource guards
      // which link (owner: "直接从 backend 就挡掉嘛").
      navHidden: [...new Set([...hiddenNavPrefixes(new Set(permissions)), ...hiddenNavForRole(roleName)])],
      home: homeForPermissions(new Set(permissions), roleName),
    });
  } catch (err) {
    console.warn(
      `[auth] /me/permissions failed for userId=${userId} — falling back to legacy users.role. err=${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    // Fallback: legacy users.role TEXT lookup. Same query the
    // auth-middleware already runs to stamp userRole on the context.
    let legacyRole = "READ_ONLY";
    try {
      const r = await c.var.DB.prepare(
        "SELECT role FROM users WHERE id = ? LIMIT 1",
      )
        .bind(userId)
        .first<{ role: string | null }>();
      if (r?.role) legacyRole = r.role.toUpperCase();
    } catch {
      // Even the legacy lookup failed — return read-only against unknown role.
    }
    if (legacyRole === "SUPER_ADMIN" || legacyRole === "ADMIN") {
      return c.json({ success: true, role: legacyRole, permissions: ["*"] });
    }
    return c.json({
      success: true,
      role: legacyRole,
      permissions: ["*:read"],
    });
  }
});

// ----- POST /api/auth/change-password -------------------------------------
// Body: { oldPassword, newPassword }
app.post("/change-password", async (c) => {
  const userId = (c as unknown as { get: (k: string) => unknown }).get(
    "userId",
  ) as string | undefined;
  if (!userId) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }
  const body = await c.req.json().catch(() => ({}));
  const { oldPassword, newPassword } = body as {
    oldPassword?: string;
    newPassword?: string;
  };
  if (!oldPassword || !newPassword) {
    return c.json(
      { success: false, error: "oldPassword and newPassword are required" },
      400,
    );
  }

  const user = await c.var.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(userId)
    .first<UserRow>();
  if (!user) {
    return c.json({ success: false, error: "User not found" }, 404);
  }
  const ok = await verifyPassword(oldPassword, user.passwordHash);
  if (!ok) {
    return c.json({ success: false, error: "Old password incorrect" }, 401);
  }

  // Security hardening 2026-05-27 — replaces the legacy `length < 6` rule
  // with a real strength gate (12+ chars, 4 char-classes, common-password
  // dictionary, reject email local-part). See src/api/lib/password-strength.
  // We check AFTER the old-password verification so an attacker probing
  // weak-password rules can't enumerate via this endpoint.
  const strength = validatePasswordStrength(newPassword, user.email);
  if (!strength.ok) {
    return c.json(
      { success: false, error: strength.error ?? "Password too weak" },
      400,
    );
  }

  const newHash = await hashPassword(newPassword);
  await c.var.DB.prepare("UPDATE users SET passwordHash = ? WHERE id = ?")
    .bind(newHash, userId)
    .run();
  // Clearing the flag is the POINT of the change: from here the credential is
  // the person's own and their actions are theirs alone.
  //
  // SEPARATE statement, and its failure cannot fail the password change. The
  // column is created by ensureUserOrgColumns over in the users route, so on a
  // cold isolate where nobody has opened User Management yet it may not exist —
  // and a password rotation must never be blocked by a column that only
  // controls a prompt. Worst case the person is asked to change it once more.
  try {
    await c.var.DB.prepare(
      "UPDATE users SET must_change_password = FALSE WHERE id = ?",
    )
      .bind(userId)
      .run();
  } catch (err) {
    console.warn(
      "[auth] could not clear must_change_password:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Security hardening — kill EVERY existing session for this user. If
  // the old password was leaked (the reason they're rotating), any token
  // issued under the old credential is also tainted. Logging back in with
  // the new password mints a fresh session. The current request's session
  // is included — the caller will be bounced to /login on next nav.
  try {
    await c.var.DB.prepare("DELETE FROM user_sessions WHERE userId = ?")
      .bind(userId)
      .run();
  } catch (err) {
    // Best-effort: if session revocation fails the password is still
    // changed (the bigger win). Log and continue.
    console.warn(
      "[auth/change-password] session revoke failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Sprint 2 task 5 — audit password change. Snapshot is bare (the new
  // hash is sensitive and the old one is being rotated out), action label
  // is enough for compliance.
  await emitAudit(c, {
    resource: "auth",
    resourceId: userId,
    action: "password-change",
  });

  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Self-service password reset (forgot-password flow). 2026-05-27.
//
// Background: Hookka previously had no self-service reset — the login form
// said "ask a super admin". Worked fine until Wei Siang (the only
// SUPER_ADMIN) got locked out, and the only recovery was a manual SQL
// UPDATE on users.passwordHash. This pair of endpoints fixes that.
//
//   POST /api/auth/forgot-password   { email }
//     → Always returns 200. Body says "if account exists, email sent."
//     → Internally: if email matches a users row, generate a 64-char
//       random token (two crypto.randomUUID()s concatenated), INSERT
//       into password_reset_tokens with expiresAt = now + 1h, send
//       email via Resend with link APP_URL/reset-password?token=...
//
//   POST /api/auth/reset-password    { token, newPassword }
//     → Validates token (exists, not used, not expired, email matches a
//       real users row), hashes new password, UPDATEs users.passwordHash,
//       marks token usedAt = now. Audit-logged.
//
// Security notes:
//   - Email enumeration mitigated by always-200 from /forgot-password.
//   - Rate limit: 1 reset request per email per 5 minutes (cheap query
//     on idx_password_reset_tokens_email).
//   - Tokens are single-use and 1-hour TTL.
//   - On successful reset we DO NOT auto-login — caller has to log in
//     fresh. Defends against the "stolen reset link" case (auto-login
//     would create a session for the link holder, even though the
//     account owner may not have requested the reset).
// ---------------------------------------------------------------------------

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;  // 1 hour
const RESET_REQUEST_COOLDOWN_MS = 5 * 60 * 1000;  // 5 minutes per email

app.post("/forgot-password", async (c) => {
  // Security hardening 2026-05-27 — per-IP rate limit. The existing
  // per-email cooldown (5 min) prevents email-resend abuse, but an
  // attacker can rotate emails from one IP to enumerate / spam Resend
  // credits. Cap a single IP at 20 forgot-password requests per 15 min.
  // Returns the same generic 429-shape response we'd return for any
  // rate limit; the response body matches checkLoginRateLimit's default.
  const ipKey = `forgot-pw:${clientIp(c)}`;
  const ipLimited = await checkLoginRateLimit(c, ipKey, 20, 900);
  if (ipLimited) return ipLimited;

  // Parse body — body might be malformed; we still respond 200 because
  // the enumeration mitigation only works if EVERY input returns the
  // same shape.
  const body = await c.req.json().catch(() => ({}));
  const email = String((body as { email?: unknown }).email ?? "")
    .trim()
    .toLowerCase();

  // Generic success response. Same shape regardless of whether email
  // exists or rate-limited — prevents account enumeration.
  const respond = () =>
    c.json({
      success: true,
      message:
        "If an account with that email exists, a password reset link has been sent.",
    });

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    // Garbage email — return generic success anyway, but don't waste
    // a DB roundtrip / email send.
    return respond();
  }

  // Rate-limit check. One reset request per email per 5 min.
  const recent = await c.var.DB.prepare(
    `SELECT createdAt FROM password_reset_tokens
      WHERE email = ?
      ORDER BY createdAt DESC
      LIMIT 1`,
  )
    .bind(email)
    .first<{ createdAt: string }>();
  if (recent) {
    const ageMs = Date.now() - Date.parse(recent.createdAt);
    if (Number.isFinite(ageMs) && ageMs < RESET_REQUEST_COOLDOWN_MS) {
      // Silently swallow — don't tell the caller "rate-limited", that
      // leaks email existence too.
      return respond();
    }
  }

  // Look up user. If absent, return generic success (no email send).
  const user = await c.var.DB.prepare(
    "SELECT id, email, displayName FROM users WHERE email = ?",
  )
    .bind(email)
    .first<{ id: string; email: string; displayName: string | null }>();
  if (!user) {
    return respond();
  }

  // Generate token. Two UUIDs concatenated (with dashes stripped) gives
  // ~256 bits of entropy — overkill but cheap.
  const token = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();

  // INSERT only the load-bearing columns. The request_ip / request_ua
  // forensics columns exist on the table for future use but the worker
  // doesn't currently populate them — the audit_events row written by
  // emitAudit() below already captures actor identity for forensics.
  // Skipping them here avoids needing entries in column-rename-map.json.
  await c.var.DB.prepare(
    `INSERT INTO password_reset_tokens (token, email, expiresAt)
     VALUES (?, ?, ?)`,
  )
    .bind(token, email, expiresAt)
    .run();

  // Send email. Best-effort — if Resend is down or unconfigured, we
  // still return 200 (the user can retry; if it's a config issue the
  // admin sees the warning in wrangler tail). The success response
  // doesn't say "email sent" specifically — "if account exists, link
  // sent" — so the user knows to wait.
  try {
    const { sendMail } = await import("../lib/email");
    const env = c.env as unknown as {
      RESEND_API_KEY?: string;
      BREVO_API_KEY?: string;
      RESEND_FROM_EMAIL?: string;
      APP_URL?: string;
    };
    const appUrl =
      env.APP_URL || "https://erp.hookka.com";
    const from =
      env.RESEND_FROM_EMAIL ||
      "Hookka Manufacturing ERP <noreply@hookka.com>";
    const resetUrl = `${appUrl}/reset-password?token=${encodeURIComponent(token)}`;
    const displayName = user.displayName || email;
    const subject = "Reset your Hookka ERP password";
    const text =
      `Hi ${displayName},\n\n` +
      `Someone (probably you) requested a password reset for ${email}.\n\n` +
      `Click this link to set a new password — it expires in 1 hour:\n\n` +
      `${resetUrl}\n\n` +
      `If you didn't request this, you can safely ignore this email — your password won't change.\n\n` +
      `— Hookka Manufacturing ERP`;
    const html =
      `<p>Hi ${escapeHtml(displayName)},</p>` +
      `<p>Someone (probably you) requested a password reset for <strong>${escapeHtml(email)}</strong>.</p>` +
      `<p><a href="${resetUrl}" style="display:inline-block;background:#6B5C32;color:#fff;padding:10px 18px;text-decoration:none;border-radius:6px">Set a new password</a></p>` +
      `<p>Or copy this link into your browser (expires in 1 hour):<br/><code>${resetUrl}</code></p>` +
      `<p style="color:#5A5550;font-size:12px">If you didn't request this, you can safely ignore this email — your password won't change.</p>`;
    // Send through sendMail — picks Brevo when BREVO_API_KEY is set
    // (the 2026-05-27 cutover provider for hookka.com), Resend otherwise.
    const result = await sendMail(env, from, {
      to: email,
      subject,
      html,
      text,
    });
    if (!result.ok) {
      // Durable fallback — a reset link must never be silently lost. The direct
      // send failed (provider blip / timeout / rate-limit), so enqueue it to the
      // outbox: the drain retries it (with backoff) and the failure is now a
      // visible row instead of a dropped email. (2026-06-04 reset reliability.)
      console.warn(
        `[auth/forgot-password] direct send failed for ${email}: ${result.error}; enqueuing to outbox`,
      );
      try {
        const { enqueueEmail } = await import("../lib/email-outbox");
        await enqueueEmail(c, { to: email, subject, html, text });
      } catch (e) {
        console.error(
          "[auth/forgot-password] outbox fallback ALSO failed:",
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  } catch (err) {
    console.warn(
      "[auth/forgot-password] email path threw:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Audit (forensics: who requested a reset and from where).
  await emitAudit(c, {
    resource: "auth",
    resourceId: user.id,
    action: "password-reset-request",
  });

  return respond();
});

app.post("/reset-password", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token = String((body as { token?: unknown }).token ?? "").trim();
  const newPassword = String(
    (body as { newPassword?: unknown }).newPassword ?? "",
  );

  if (!token) {
    return c.json(
      { success: false, error: "Reset token is required" },
      400,
    );
  }
  // Pre-flight: token must be present, password must be non-empty.
  // Full strength validation (12+ chars + char classes + dictionary)
  // runs AFTER the token + email lookup so we have the email to feed
  // into the local-part check — keeps the strength rule one consistent
  // spot. Empty-string guard here just avoids a noisy strength error
  // when the user accidentally submits a blank form.
  if (!newPassword) {
    return c.json(
      { success: false, error: "New password is required" },
      400,
    );
  }

  const row = await c.var.DB.prepare(
    `SELECT token, email, expiresAt, usedAt
       FROM password_reset_tokens
      WHERE token = ?`,
  )
    .bind(token)
    .first<{
      token: string;
      email: string;
      expiresAt: string;
      usedAt: string | null;
    }>();
  if (!row) {
    return c.json(
      { success: false, error: "Invalid or expired reset link" },
      400,
    );
  }
  if (row.usedAt) {
    return c.json(
      {
        success: false,
        error: "This reset link has already been used. Request a new one.",
      },
      410,
    );
  }
  const expMs = Date.parse(row.expiresAt);
  if (!Number.isFinite(expMs) || expMs < Date.now()) {
    return c.json(
      {
        success: false,
        error: "This reset link has expired. Request a new one.",
      },
      410,
    );
  }

  const user = await c.var.DB.prepare(
    "SELECT id FROM users WHERE email = ?",
  )
    .bind(row.email)
    .first<{ id: string }>();
  if (!user) {
    // Edge case: account was deleted between request and reset.
    return c.json(
      { success: false, error: "Account no longer exists" },
      404,
    );
  }

  // Security hardening 2026-05-27 — full strength gate using the same
  // validator that the FE meter calls. The email arg blocks the local-part
  // from appearing in the password (e.g. "weisiang329-Strong!" would fail
  // for weisiang329@gmail.com). Returns the FIRST failing rule as a
  // plain-English message so the user can act on it.
  const strength = validatePasswordStrength(newPassword, row.email);
  if (!strength.ok) {
    return c.json(
      { success: false, error: strength.error ?? "Password too weak" },
      400,
    );
  }

  const newHash = await hashPassword(newPassword);
  await c.var.DB.prepare(
    "UPDATE users SET passwordHash = ? WHERE id = ?",
  )
    .bind(newHash, user.id)
    .run();
  await c.var.DB.prepare(
    "UPDATE password_reset_tokens SET usedAt = ? WHERE token = ?",
  )
    .bind(new Date().toISOString(), token)
    .run();

  // Security hardening — kill EVERY active session for this user. The
  // reason they're resetting is usually "I lost the old password" which
  // means it might be in someone else's hands. Any token issued under
  // the old credential is now invalid. User must log in fresh.
  try {
    await c.var.DB.prepare("DELETE FROM user_sessions WHERE userId = ?")
      .bind(user.id)
      .run();
  } catch (err) {
    console.warn(
      "[auth/reset-password] session revoke failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Audit — action label is enough; we don't snapshot the new hash.
  await emitAudit(c, {
    resource: "auth",
    resourceId: user.id,
    action: "password-reset-complete",
  });

  return c.json({
    success: true,
    message: "Password updated. You can now log in with your new password.",
  });
});

// Minimal HTML-escape used only by the forgot-password email template.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Invite acceptance flow — PUBLIC routes, exempted in auth-middleware.ts.
//
// GET /api/auth/invite/:token   → preflight (fetches the invite meta so the
//                                   recipient can see "You were invited as X")
// POST /api/auth/accept-invite  → creates the users row, marks the invite
//                                   accepted, and logs the user in.
// ---------------------------------------------------------------------------

type InviteRow = {
  token: string;
  email: string;
  role: string;
  displayName: string | null;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
};

// GET /api/auth/invite/:token
app.get("/invite/:token", async (c) => {
  const token = c.req.param("token");
  const nowIso = new Date().toISOString();

  const row = await c.var.DB.prepare(
    `SELECT i.email, i.displayName, i.expiresAt, i.acceptedAt,
            u.displayName AS "inviterDisplayName",
            u.email AS "inviterEmail"
       FROM user_invites i
       LEFT JOIN users u ON u.id = i.invitedBy
      WHERE i.token = ?
      LIMIT 1`,
  )
    .bind(token)
    .first<{
      email: string;
      displayName: string | null;
      expiresAt: string;
      acceptedAt: string | null;
      inviterDisplayName: string | null;
      inviterEmail: string | null;
    }>();

  if (!row || row.acceptedAt || row.expiresAt <= nowIso) {
    return c.json({ success: false, error: "Invalid or expired invite" }, 404);
  }

  const inviterName =
    row.inviterDisplayName && row.inviterDisplayName.length > 0
      ? row.inviterDisplayName
      : (row.inviterEmail ?? "");

  return c.json({
    success: true,
    data: {
      email: row.email,
      displayName: row.displayName ?? "",
      inviterName,
      expiresAt: row.expiresAt,
    },
  });
});

// POST /api/auth/accept-invite
// Body: { token, password, displayName? }
app.post("/accept-invite", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { token, password, displayName } = body as {
    token?: string;
    password?: string;
    displayName?: string;
  };
  if (!token || !password) {
    return c.json(
      { success: false, error: "token and password are required" },
      400,
    );
  }
  if (password.length < 6) {
    return c.json(
      { success: false, error: "password must be at least 6 characters" },
      400,
    );
  }

  const nowIso = new Date().toISOString();
  const invite = await c.var.DB.prepare(
    "SELECT * FROM user_invites WHERE token = ? LIMIT 1",
  )
    .bind(token)
    .first<InviteRow>();
  if (!invite || invite.acceptedAt || invite.expiresAt <= nowIso) {
    return c.json({ success: false, error: "Invalid or expired invite" }, 404);
  }

  // Race condition: someone else (re-)created a user with this email between
  // invite send and now. Bail loudly rather than silently overwriting.
  const existingUser = await c.var.DB.prepare(
    "SELECT id FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1",
  )
    .bind(invite.email)
    .first<{ id: string }>();
  if (existingUser) {
    return c.json(
      { success: false, error: "A user with this email already exists" },
      409,
    );
  }

  const resolvedDisplayName =
    (displayName && displayName.trim()) ||
    invite.displayName ||
    "";
  const userId = `user-${crypto.randomUUID().slice(0, 8)}`;
  const passwordHash = await hashPassword(password);
  const sessionToken = crypto.randomUUID();
  const csrfToken = newCsrfToken();
  const sessionExpires = new Date(
    Date.now() + SESSION_TTL_MS,
  ).toISOString();

  // Atomic: create user, mark invite accepted, issue session in one batch.
  await c.var.DB.batch([
    c.var.DB.prepare(
      `INSERT INTO users (id, email, passwordHash, role, isActive, createdAt, lastLoginAt, displayName)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
    ).bind(
      userId,
      invite.email,
      passwordHash,
      invite.role,
      nowIso,
      nowIso,
      resolvedDisplayName,
    ),
    c.var.DB.prepare(
      "UPDATE user_invites SET acceptedAt = ? WHERE token = ?",
    ).bind(nowIso, token),
    c.var.DB.prepare(
      "INSERT INTO user_sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)",
    ).bind(sessionToken, userId, nowIso, sessionExpires),
  ]);

  // Sprint 7: set both auth cookies; body returns user + csrfToken only.
  issueSessionCookies(c, sessionToken, csrfToken);
  return c.json({
    success: true,
    data: {
      user: {
        id: userId,
        email: invite.email,
        role: invite.role,
        displayName: resolvedDisplayName,
      },
      csrfToken,
    },
  });
});

export default app;
