// ---------------------------------------------------------------------------
// D1-backed auth route — login / logout / me / change-password.
//
// Session tokens are opaque UUIDs (crypto.randomUUID) stored in user_sessions
// with a 30-day sliding window from issue time. The authMiddleware in
// src/api/lib/auth-middleware.ts handles token verification for every
// non-public /api/* request, so /me and /change-password can assume the
// request is already authenticated by the time the handler runs.
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
import type { Env } from "../worker";
import { hashPassword, verifyPassword } from "../lib/password";
import { emitCounter } from "../lib/observability";
import {
  SESSION_COOKIE,
  CSRF_COOKIE,
} from "../lib/auth-middleware";

const app = new Hono<Env>();

// 30 days, in ms — tweak here, not in the schema.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TTL_S = SESSION_TTL_MS / 1000;

// Build the two Set-Cookie headers for a successful dashboard login.
// - `hookka_session`: HttpOnly + Secure + SameSite=Strict so JS can't read
//   the token and it never leaves a same-site context. This is the
//   credential.
// - `hookka_csrf`:   NOT HttpOnly so the api-client can read it and echo it
//   in the X-CSRF-Token header (double-submit). Secure + SameSite=Strict to
//   keep an attacker on a cross-origin page from reading or forging it.
function sessionCookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_S}`;
}
function csrfCookieHeader(csrfToken: string): string {
  return `${CSRF_COOKIE}=${csrfToken}; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_S}`;
}
// Clear cookie variants — Max-Age=0 + empty value tells the browser to drop
// the cookie immediately. Path/SameSite must mirror the originally-issued
// cookie or the browser ignores the clear.
const SESSION_CLEAR_COOKIE = `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
const CSRF_CLEAR_COOKIE = `${CSRF_COOKIE}=; Secure; SameSite=Strict; Path=/; Max-Age=0`;

// Random URL-safe-ish CSRF token. crypto.randomUUID() is plenty of entropy
// (122 bits) and is already used for session tokens — no need for a heavier
// base64-of-random-bytes here.
function newCsrfToken(): string {
  return crypto.randomUUID();
}

// Set both cookies on the response (login / accept-invite / TOTP verify).
// Hono lets us call header() twice with the same name — both Set-Cookie
// lines land in the response.
function issueSessionCookies(c: { header: (k: string, v: string, opts?: { append?: boolean }) => void }, sessionToken: string, csrfToken: string): void {
  c.header("Set-Cookie", sessionCookieHeader(sessionToken), { append: true });
  c.header("Set-Cookie", csrfCookieHeader(csrfToken), { append: true });
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
};

function publicUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    role: u.role,
    displayName: u.displayName ?? "",
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
  const { email, password } = body as { email?: string; password?: string };
  if (!email || !password) {
    return c.json(
      { success: false, error: "email and password are required" },
      400,
    );
  }

  const user = await c.var.DB.prepare(
    "SELECT * FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1",
  )
    .bind(email.trim())
    .first<UserRow>();
  if (!user) {
    // P6.3 — count failed logins. We deliberately do NOT include the email
    // in the metric blob (PII / brute-force enumeration) — just the count.
    emitCounter(c, "auth.login_fail", { resource: "unknown_email" });
    return c.json({ success: false, error: "Invalid credentials" }, 401);
  }
  if (user.isActive !== 1) {
    emitCounter(c, "auth.login_fail", { resource: "account_disabled" });
    return c.json({ success: false, error: "Account disabled" }, 403);
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    emitCounter(c, "auth.login_fail", { resource: "bad_password" });
    return c.json({ success: false, error: "Invalid credentials" }, 401);
  }

  // Phase C.6 — TOTP gate. If the user is enrolled, do NOT issue a session
  // here; the frontend must POST { userId, code } to
  // /api/auth/totp/login-verify which issues the session on success.
  // Returning userId (NOT a token) is intentional — userId alone is useless
  // without a valid TOTP/recovery code.
  if (user.totpEnrolledAt) {
    return c.json({
      success: true,
      totpRequired: true,
      userId: user.id,
    });
  }

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

  // Sprint 7: token lives in the HttpOnly cookie; only the public user blob
  // and the CSRF token come back in the JSON body. The CSRF token is also
  // available via the non-HttpOnly cookie — we mirror it in the body so
  // tests / curl users can grab it without parsing Set-Cookie.
  issueSessionCookies(c, token, csrfToken);
  return c.json({
    success: true,
    data: { user: publicUser(user), csrfToken },
  });
});

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
  if (token) {
    const { invalidateSessionCache } = await import("../lib/auth-middleware");
    await Promise.all([
      c.var.DB.prepare("DELETE FROM user_sessions WHERE token = ?")
        .bind(token)
        .run(),
      invalidateSessionCache(c.env.SESSION_CACHE, token),
    ]);
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
// with the bypass behavior in src/api/lib/authz.ts.
//
// READ_ONLY fallback: users without a roleId fall through to role_read_only
// per the same convention as authz.ts.
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
    // mirroring authz.ts's resolveUserRole().
    const roleRow = await c.var.DB.prepare(
      `SELECT u.roleId AS roleId, r.name AS roleName
         FROM users u
         LEFT JOIN roles r ON r.id = u.roleId
        WHERE u.id = ?
        LIMIT 1`,
    )
      .bind(userId)
      .first<{ roleId: string | null; roleName: string | null }>();

    if (!roleRow) {
      // Authenticated but no users row — shouldn't happen in practice.
      return c.json({ success: true, permissions: [] });
    }

    // SUPER_ADMIN bypass — sentinel list keeps payload tiny + matches the
    // authz.ts SUPER_ADMIN short-circuit.
    if (roleRow.roleName === "SUPER_ADMIN") {
      return c.json({
        success: true,
        role: roleRow.roleName,
        permissions: ["*"],
      });
    }

    const roleId = roleRow.roleId ?? "role_read_only";
    const roleName = roleRow.roleName ?? "READ_ONLY";

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
  if (newPassword.length < 6) {
    return c.json(
      { success: false, error: "newPassword must be at least 6 characters" },
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

  const newHash = await hashPassword(newPassword);
  await c.var.DB.prepare("UPDATE users SET passwordHash = ? WHERE id = ?")
    .bind(newHash, userId)
    .run();

  return c.json({ success: true });
});

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
