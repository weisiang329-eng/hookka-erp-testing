// ---------------------------------------------------------------------------
// TOTP 2FA enrollment + verification routes (Phase C.6).
//
// Mounted at `/api/auth/totp` from worker.ts.
//
// Routes:
//   POST /enroll           — auth-required. Generates a fresh secret +
//                             recovery codes, returns the otpauth URL,
//                             a QR-code image URL (qrserver.com proxy), and
//                             the plaintext recovery codes (shown ONCE).
//                             Does NOT mark the user as enrolled — they
//                             must confirm by submitting a real code.
//   POST /verify           — auth-required. Body { code }. If TOTP code
//                             matches the in-flight (un-confirmed) secret,
//                             flips users.totpEnrolledAt to now. From here on
//                             the password-login path requires TOTP.
//   POST /login-verify     — PUBLIC. Body { userId, code }. Used right after
//                             /api/auth/login when the response was
//                             { totpRequired: true }. Issues a session on
//                             success.
//   POST /disable          — auth-required. Body { password }. Re-auth
//                             gate, then nulls out totp* columns.
//
// Pending-secret design: enrollment generates a secret, returns it, and
// stores it in users.totpSecret IMMEDIATELY but leaves totpEnrolledAt NULL.
// auth.ts only treats a user as TOTP-enrolled when totpEnrolledAt is non-null
// — so an aborted enrollment leaves a dangling secret that's harmless. A
// re-enrollment overwrites it. Recovery codes are generated at this stage
// too (they share the user's enrollment lifecycle).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import {
  generateSecret,
  verifyTotp,
  enrollUrl,
  generateRecoveryCodes,
  verifyRecoveryCode,
  hashRecoveryCode,
} from "../lib/totp";
import { verifyPassword } from "../lib/password";
import {
  checkLoginRateLimit,
  clearLoginRateLimit,
} from "../lib/rate-limit";

const app = new Hono<Env>();

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOTP_ISSUER = "Hookka Manufacturing ERP";

type UserRow = {
  id: string;
  email: string;
  passwordHash: string;
  role: string;
  isActive: number;
  displayName: string | null;
  totpSecret: string | null;
  totpEnrolledAt: string | null;
  totpRecoveryHashes: string | null;
};

function ctxUserId(c: unknown): string | undefined {
  return (c as { get: (k: string) => unknown }).get("userId") as
    | string
    | undefined;
}

// ----- POST /api/auth/totp/enroll ------------------------------------------
// Auth-required. Body: {}.  Returns {otpauthUrl, qrUrl, recoveryCodes}.
app.post("/enroll", async (c) => {
  const userId = ctxUserId(c);
  if (!userId) return c.json({ success: false, error: "Unauthorized" }, 401);

  const user = await c.var.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(userId)
    .first<UserRow>();
  if (!user) return c.json({ success: false, error: "User not found" }, 404);

  // If the user is already enrolled, force them through /disable first.
  // Re-enrolling without disabling is dangerous — old recovery codes would
  // silently survive past the rotation otherwise.
  if (user.totpEnrolledAt) {
    return c.json(
      {
        success: false,
        error:
          "TOTP already enrolled. Use /api/auth/totp/disable first to rotate.",
      },
      409,
    );
  }

  const secret = generateSecret();
  const otpauth = enrollUrl(user.email, secret, TOTP_ISSUER);
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(otpauth)}`;
  const { plaintext, hashes } = await generateRecoveryCodes(userId, 8);

  // Persist the in-flight secret + recovery hashes. totpEnrolledAt stays null
  // until /verify confirms the user can produce a real code.
  await c.var.DB.prepare(
    "UPDATE users SET totpSecret = ?, totpRecoveryHashes = ?, totpEnrolledAt = NULL WHERE id = ?",
  )
    .bind(secret, JSON.stringify(hashes), userId)
    .run();

  return c.json({
    success: true,
    data: {
      otpauthUrl: otpauth,
      qrUrl,
      secret, // shown so users can type it manually if QR scan fails
      recoveryCodes: plaintext, // ⚠️ shown ONCE
    },
  });
});

// ----- POST /api/auth/totp/verify ------------------------------------------
// Auth-required. Body: {code}. Confirms enrollment.
app.post("/verify", async (c) => {
  const userId = ctxUserId(c);
  if (!userId) return c.json({ success: false, error: "Unauthorized" }, 401);

  const body = (await c.req.json().catch(() => ({}))) as { code?: string };
  const code = (body.code || "").trim();
  if (!/^\d{6}$/.test(code)) {
    return c.json({ success: false, error: "code must be 6 digits" }, 400);
  }

  const user = await c.var.DB.prepare(
    "SELECT * FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<UserRow>();
  if (!user || !user.totpSecret) {
    return c.json(
      { success: false, error: "No pending TOTP enrollment" },
      400,
    );
  }

  const ok = await verifyTotp(user.totpSecret, code, 1);
  if (!ok) return c.json({ success: false, error: "code invalid" }, 401);

  const nowIso = new Date().toISOString();
  await c.var.DB.prepare(
    "UPDATE users SET totpEnrolledAt = ? WHERE id = ?",
  )
    .bind(nowIso, userId)
    .run();

  return c.json({ success: true, enrolledAt: nowIso });
});

// ----- POST /api/auth/totp/login-verify ------------------------------------
// PUBLIC. Used after /api/auth/login returns { totpRequired: true, userId }.
// Body: { userId, code }. The `code` may be either a 6-digit TOTP or a
// recovery code (matched by length: 6-digit numeric → TOTP, anything else
// is treated as recovery).
app.post("/login-verify", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    userId?: string;
    code?: string;
  };
  const { userId, code } = body;
  if (!userId || !code) {
    return c.json(
      { success: false, error: "userId and code required" },
      400,
    );
  }

  // Brute-force throttle — 10 attempts / 15 min keyed on userId. The TOTP
  // search-space is only 10^6 so a 1000-attempts/sec script would brute the
  // window in <1s without this gate.
  const rlKey = `totp:${userId}`;
  const rlDenied = await checkLoginRateLimit(c, rlKey);
  if (rlDenied) return rlDenied;

  const user = await c.var.DB.prepare(
    "SELECT * FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<UserRow>();
  if (!user || !user.totpEnrolledAt || !user.totpSecret) {
    // Don't tell the attacker whether the user exists or has TOTP.
    return c.json({ success: false, error: "Invalid credentials" }, 401);
  }
  if (user.isActive !== 1) {
    return c.json({ success: false, error: "Account disabled" }, 403);
  }

  const trimmed = code.trim().toUpperCase();
  let ok = false;

  if (/^\d{6}$/.test(trimmed)) {
    ok = await verifyTotp(user.totpSecret, trimmed, 1);
  } else {
    // Recovery code path. Match against the stored hash list, BURN the hash
    // on success so the same code can't be re-used.
    const hashes: string[] = user.totpRecoveryHashes
      ? (JSON.parse(user.totpRecoveryHashes) as string[])
      : [];
    const idx = await verifyRecoveryCode(userId, trimmed, hashes);
    if (idx >= 0) {
      ok = true;
      const remaining = hashes.filter((_, i) => i !== idx);
      await c.var.DB.prepare(
        "UPDATE users SET totpRecoveryHashes = ? WHERE id = ?",
      )
        .bind(JSON.stringify(remaining), userId)
        .run();
    }
  }

  if (!ok) {
    return c.json({ success: false, error: "Invalid credentials" }, 401);
  }

  // Issue session — same shape as /api/auth/login.
  const sessionToken = crypto.randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  await c.var.DB.batch([
    c.var.DB
      .prepare(
        "INSERT INTO user_sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)",
      )
      .bind(sessionToken, userId, now.toISOString(), expires.toISOString()),
    c.var.DB
      .prepare("UPDATE users SET lastLoginAt = ? WHERE id = ?")
      .bind(now.toISOString(), userId),
  ]);

  // Reset the rate-limit counter on success.
  c.executionCtx.waitUntil(clearLoginRateLimit(c, rlKey));

  return c.json({
    success: true,
    data: {
      token: sessionToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        displayName: user.displayName ?? "",
      },
    },
  });
});

// ----- POST /api/auth/totp/disable -----------------------------------------
// Auth-required + re-auth: body { password }. Nulls out the TOTP columns.
app.post("/disable", async (c) => {
  const userId = ctxUserId(c);
  if (!userId) return c.json({ success: false, error: "Unauthorized" }, 401);

  const body = (await c.req.json().catch(() => ({}))) as {
    password?: string;
  };
  if (!body.password) {
    return c.json(
      { success: false, error: "password required for re-auth" },
      400,
    );
  }

  const user = await c.var.DB.prepare(
    "SELECT * FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<UserRow>();
  if (!user) return c.json({ success: false, error: "User not found" }, 404);

  const ok = await verifyPassword(body.password, user.passwordHash);
  if (!ok) {
    return c.json({ success: false, error: "Invalid password" }, 401);
  }

  await c.var.DB.prepare(
    "UPDATE users SET totpSecret = NULL, totpEnrolledAt = NULL, totpRecoveryHashes = NULL WHERE id = ?",
  )
    .bind(userId)
    .run();

  return c.json({ success: true });
});

// Re-export hashRecoveryCode for tests that want to seed rows directly.
export { hashRecoveryCode };

export default app;
