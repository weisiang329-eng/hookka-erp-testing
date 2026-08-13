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
//   POST /login-verify     — PUBLIC. Body { userId, code, pendingToken }.
//                             Used right after /api/auth/login when the
//                             response was { totpRequired: true }. The
//                             pendingToken is that response's proof that the
//                             PASSWORD verified — without it this endpoint was
//                             a password-free login (BUG-2026-08-13-101).
//                             Issues a session on success.
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
import { emitAudit } from "../lib/audit";
import {
  sessionCookieHeader,
  csrfCookieHeader,
} from "../lib/session-cookie";
import {
  checkPendingTotpToken,
  consumePendingTotpToken,
} from "../lib/totp-pending";

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

  // Sprint 2 task 5 — audit TOTP enrollment kickoff. Snapshot only the fact
  // that an enrollment started — never the secret or recovery codes.
  await emitAudit(c, {
    resource: "auth-totp",
    resourceId: userId,
    action: "totp.enroll-start",
  });

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

  // Sprint 2 task 5 — audit completed TOTP enrollment. From here on the
  // user MUST present a TOTP code on /login.
  await emitAudit(c, {
    resource: "auth-totp",
    resourceId: userId,
    action: "totp.enroll",
    after: { enrolledAt: nowIso },
  });

  return c.json({ success: true, enrolledAt: nowIso });
});

// ----- POST /api/auth/totp/login-verify ------------------------------------
// PUBLIC. Used after /api/auth/login returns
// { totpRequired: true, userId, pendingToken }.
// Body: { userId, code, pendingToken }. The `code` may be either a 6-digit TOTP
// or a recovery code (matched by length: 6-digit numeric → TOTP, anything else
// is treated as recovery).
//
// `pendingToken` is REQUIRED (BUG-2026-08-13-101). Without it this endpoint
// accepted { userId, code } and issued a full session, so for an enrolled user
// the password was never checked at all: a user id — which is not a secret —
// plus one TOTP code or one recovery code was the entire credential. The token
// is the proof that step 1 happened; see src/api/lib/totp-pending.ts.
app.post("/login-verify", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    userId?: string;
    code?: string;
    rememberMe?: boolean;
    pendingToken?: string;
  };
  const { userId, code, rememberMe, pendingToken } = body;
  // Carry "Remember me" through the 2FA step so an enrolled user gets the
  // same persist-or-session cookie choice a password-only user gets.
  const persistSession = rememberMe === true;
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

  // Step 1 must have happened, for THIS user, within the last five minutes.
  // Checked before anything is read about the user so a caller without the
  // token learns nothing beyond "no" — and still spends rate-limit budget.
  //
  // The row is NOT burned here. A mistyped 6-digit code would otherwise cost
  // the operator their password step, and a gate that punishes typos is a gate
  // that gets switched back off; the 10-attempts-per-15-minutes throttle above
  // already bounds the retries. It is burned below, once a session exists.
  let pending: Awaited<ReturnType<typeof checkPendingTotpToken>>;
  try {
    pending = await checkPendingTotpToken(c.var.DB, userId, pendingToken);
  } catch (err) {
    console.warn(
      "[auth-totp/login-verify] pending-token lookup failed:",
      err instanceof Error ? err.message : String(err),
    );
    // Fail CLOSED. This is the check that stands in for the password.
    return c.json(
      {
        success: false,
        error: "Sign-in service is busy right now — please try again in a moment.",
      },
      503,
    );
  }
  if (!pending.ok) {
    await emitAudit(c, {
      resource: "auth-totp",
      resourceId: userId,
      action: "totp.login-verify.fail",
      after: { reason: `pending-${pending.reason}` },
    });
    // An expired token gets its own message — "start again" is actionable,
    // "invalid credentials" would send the operator hunting for a wrong
    // password. Every other reason stays indistinguishable.
    return c.json(
      {
        success: false,
        error:
          pending.reason === "expired"
            ? "That sign-in attempt timed out. Please enter your password again."
            : "Invalid credentials",
      },
      401,
    );
  }

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
    // Sprint 2 task 5 — audit failed login-verify so brute-force runs are
    // visible in the journal even when the rate limiter caps them.
    await emitAudit(c, {
      resource: "auth-totp",
      resourceId: userId,
      action: "totp.login-verify.fail",
    });
    return c.json({ success: false, error: "Invalid credentials" }, 401);
  }

  // Issue session — same shape as /api/auth/login.
  const sessionToken = crypto.randomUUID();
  const csrfToken = crypto.randomUUID();
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

  // Burn the pending token (and any sibling left by an earlier password
  // attempt) now that the session exists — one password step, one session.
  await consumePendingTotpToken(c.var.DB, userId);

  // Reset the rate-limit counter on success. waitUntil is best-effort —
  // executionCtx getter throws outside Worker isolates (tests, local node).
  try {
    c.executionCtx.waitUntil(clearLoginRateLimit(c, rlKey));
  } catch {
    void clearLoginRateLimit(c, rlKey).catch(() => {});
  }

  // Sprint 2 task 5 — audit successful login-verify. Pairs with the .fail
  // entry above for clean brute-force timeline reconstruction.
  await emitAudit(c, {
    resource: "auth-totp",
    resourceId: userId,
    action: "totp.login-verify",
    after: { role: user.role },
  });

  // Sprint 7: set the two auth cookies; body keeps user + csrfToken only.
  c.header("Set-Cookie", sessionCookieHeader(sessionToken, persistSession), { append: true });
  c.header("Set-Cookie", csrfCookieHeader(csrfToken, persistSession), { append: true });
  return c.json({
    success: true,
    data: {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        displayName: user.displayName ?? "",
      },
      csrfToken,
    },
  });
});

// ---------------------------------------------------------------------------
// Soft-enforcement 2FA setup flow (2026-05-27).
//
// These wrappers exist BECAUSE the original /enroll endpoint blocks re-running
// when totpEnrolledAt is already set AND returns recovery codes (heavy ceremony).
// For the soft-prompt setup screen we want a lightweight "show me a QR" flow
// that the operator can hit even if they previously started but didn't finish.
//
// Schema note: there is NO `user_totp_secrets` table in this codebase. TOTP
// state lives on the `users` table as totpSecret + totpEnrolledAt +
// totpRecoveryHashes. The "pending vs enabled" distinction is encoded by
// totpEnrolledAt being NULL (pending) vs ISO timestamp (enabled). No ALTER
// is required.
//
// Audit actions: "totp.setup-start" and "totp-enabled" (chosen to match the
// spec; complements the existing "totp.enroll" / "totp.enroll-start" actions
// used by /enroll + /verify).
// ---------------------------------------------------------------------------

// ----- POST /api/auth/totp/setup-start -------------------------------------
// Auth-required (passes through authMiddleware). Returns the otpauth URL,
// the raw base32 secret, and a QR image URL the FE can render as an <img>.
// Idempotent — re-running before /setup-confirm rotates the pending secret.
// Once the user has already confirmed (totpEnrolledAt non-null), refuse so
// they don't accidentally clobber their working secret without going through
// /disable first.
app.post("/setup-start", async (c) => {
  const userId = ctxUserId(c);
  if (!userId) return c.json({ success: false, error: "Unauthorized" }, 401);

  const user = await c.var.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(userId)
    .first<UserRow>();
  if (!user) return c.json({ success: false, error: "User not found" }, 404);

  // Already enrolled? Force the rotation path so the old secret doesn't
  // silently survive. Matches /enroll's defensive behaviour.
  if (user.totpEnrolledAt) {
    return c.json(
      {
        success: false,
        error:
          "Two-factor sign-in is already on. Turn it off first before setting up again.",
      },
      409,
    );
  }

  // Generate or rotate the pending secret. We overwrite any prior pending
  // secret because the user may have abandoned the setup once and is now
  // restarting it — no recovery codes are issued at this stage (the soft
  // flow defers them to a future enhancement per spec).
  const secret = generateSecret();
  const otpauthUrl = enrollUrl(user.email, secret, TOTP_ISSUER);
  // qrserver.com is a public QR image proxy — no API key, no SDK. The FE
  // could compute this on its own but doing it server-side keeps the QR
  // URL out of the browser's URL bar and lets us swap providers later.
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(otpauthUrl)}`;

  // Persist the pending secret. totpEnrolledAt stays NULL — /setup-confirm
  // flips it once the user proves they can produce a code.
  try {
    await c.var.DB.prepare(
      "UPDATE users SET totpSecret = ?, totpEnrolledAt = NULL WHERE id = ?",
    )
      .bind(secret, userId)
      .run();
  } catch (err) {
    console.warn(
      "[auth-totp/setup-start] DB write failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json(
      { success: false, error: "Could not start setup. Try again." },
      500,
    );
  }

  // Best-effort audit (failure must not block setup — that would lock the
  // user out from finishing 2FA setup if the audit table is wedged).
  try {
    await emitAudit(c, {
      resource: "auth-totp",
      resourceId: userId,
      action: "totp.setup-start",
    });
  } catch {
    /* swallow */
  }

  return c.json({
    success: true,
    secret,
    otpauthUrl,
    qrCodeUrl,
  });
});

// ----- POST /api/auth/totp/setup-confirm -----------------------------------
// Auth-required. Body { code }. Verifies the 6-digit TOTP matches the pending
// secret, flips totpEnrolledAt = now, audit-logs "totp-enabled". On wrong
// code returns 400 with a plain-English message so the FE can show it inline.
app.post("/setup-confirm", async (c) => {
  const userId = ctxUserId(c);
  if (!userId) return c.json({ success: false, error: "Unauthorized" }, 401);

  const body = (await c.req.json().catch(() => ({}))) as { code?: string };
  const code = (body.code || "").trim();
  if (!/^\d{6}$/.test(code)) {
    return c.json(
      { success: false, error: "Wrong code, try again" },
      400,
    );
  }

  const user = await c.var.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(userId)
    .first<UserRow>();
  if (!user || !user.totpSecret) {
    return c.json(
      {
        success: false,
        error: "Setup hasn't been started yet. Refresh and try again.",
      },
      400,
    );
  }

  const ok = await verifyTotp(user.totpSecret, code, 1);
  if (!ok) {
    return c.json({ success: false, error: "Wrong code, try again" }, 400);
  }

  const nowIso = new Date().toISOString();
  try {
    await c.var.DB.prepare(
      "UPDATE users SET totpEnrolledAt = ? WHERE id = ?",
    )
      .bind(nowIso, userId)
      .run();
  } catch (err) {
    console.warn(
      "[auth-totp/setup-confirm] DB write failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json(
      { success: false, error: "Could not save. Try again." },
      500,
    );
  }

  // Audit row uses the spec-mandated action name "totp-enabled" so dashboards
  // / queries searching for "did this user finish setup?" find a single
  // canonical event.
  try {
    await emitAudit(c, {
      resource: "auth-totp",
      resourceId: userId,
      action: "totp-enabled",
      after: { enabledAt: nowIso },
    });
  } catch {
    /* swallow */
  }

  return c.json({ success: true, enabledAt: nowIso });
});

// ----- POST /api/auth/totp/dismiss-prompt ----------------------------------
// Auth-required. Body: {}. Writes an audit row "totp-dismissed" so the next
// login check sees that the user just dismissed and skips the prompt for the
// 24h cool-off window. Returns 200 even if the audit write fails — the user
// shouldn't be stuck in a modal because of a journal hiccup.
app.post("/dismiss-prompt", async (c) => {
  const userId = ctxUserId(c);
  if (!userId) return c.json({ success: false, error: "Unauthorized" }, 401);

  try {
    await emitAudit(c, {
      resource: "auth-totp",
      resourceId: userId,
      action: "totp-dismissed",
    });
  } catch (err) {
    console.warn(
      "[auth-totp/dismiss-prompt] audit failed:",
      err instanceof Error ? err.message : String(err),
    );
  }

  return c.json({ success: true });
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

  // Sprint 2 task 5 — audit TOTP disable. Compliance-critical: the journal
  // must show every step from a 2FA-protected account back to a 1-factor
  // account, with the actor.
  await emitAudit(c, {
    resource: "auth-totp",
    resourceId: userId,
    action: "totp.disable",
  });

  return c.json({ success: true });
});

// Re-export hashRecoveryCode for tests that want to seed rows directly.
export { hashRecoveryCode };

export default app;
