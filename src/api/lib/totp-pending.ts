// ---------------------------------------------------------------------------
// totp-pending.ts — the missing half of the two-step login.
//
// THE BUG THIS EXISTS TO CLOSE (BUG-2026-08-13-101)
// ------------------------------------------------
// `/api/auth/totp/login-verify` used to take `{ userId, code }` and issue a
// full session. Nothing anywhere proved that step 1 (the PASSWORD) had ever
// happened. For an enrolled user, a user id — which is not a secret; it travels
// in audit rows, in admin screens and in any earlier response — plus one TOTP
// code or one recovery code was a complete credential. 2FA was not a second
// factor, it was an ALTERNATIVE first factor, and a weaker one.
//
// THE RECORDED DECISION THIS PRESERVES
// ------------------------------------
// `auth.ts` says of the step-1 response: *"Returning userId (NOT a token) is
// intentional — userId alone is useless without a valid TOTP/recovery code."*
// What that protects is that step 1 must not hand back anything that grants
// access to the app. That still holds: the value issued here is NOT a session
// token. It is accepted at exactly one endpoint (`/login-verify`), it grants
// nothing on its own, it expires in five minutes, and it is burned the moment a
// session is issued from it. The middleware's session lookup reads
// `user_sessions`; a pending token lives in its own table and can never be
// mistaken for a session row.
//
// WHY A TABLE AND NOT KV
// ----------------------
// `rate-limit.ts` fails OPEN when `SESSION_CACHE` is absent (tests, local dev),
// which is right for a speed bump and wrong for a credential — a missing KV
// binding would silently disable the gate. The DB, by contrast, is already
// load-bearing for login: the password check itself is a `users` read, so a
// database that cannot answer has already failed the login. Putting the pending
// token there adds no new way for login to break.
//
// Schema reaches prod through the runtime self-apply, not the migration file
// (CLAUDE.md: migrations are inert on deploy). Columns are snake_case, so no
// `column-rename-map.json` entry is needed; rows are read dual-keyed because
// `SELECT *` renames a mapped snake column back to camelCase.
// ---------------------------------------------------------------------------
import { memoizeSelfApply } from "./self-apply";

/** How long a password-verified login may wait at the 2FA prompt. */
export const PENDING_TOTP_TTL_MS = 5 * 60 * 1000;

let pendingTablePromise: Promise<void> | null = null;

/**
 * Create the pending-login table. Idempotent, once per isolate, and the memo is
 * DROPPED on failure so a transient blip is retried instead of remembered as
 * done (C9 — a runtime migration memoised as a promise).
 */
export function ensureTotpPendingTable(db: D1Database): Promise<void> {
  return memoizeSelfApply(
    () => pendingTablePromise,
    (p) => {
      pendingTablePromise = p;
    },
    async () => {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS totp_pending_logins (
             token_hash TEXT PRIMARY KEY,
             user_id TEXT NOT NULL,
             created_at TEXT,
             expires_at TEXT
           )`,
        )
        .run();
    },
  );
}

/** SHA-256, hex. The table stores the hash so a DB read is not a credential. */
export async function hashPendingToken(token: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`totp-pending:${token}`),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Mint a pending-2FA token for a user whose PASSWORD has just verified.
 *
 * Throws if the row cannot be written. The caller must NOT fall back to
 * issuing a session, and must not fall back to the old password-free
 * `/login-verify` — a storage failure means "try again", not "skip the gate".
 */
export async function issuePendingTotpToken(
  db: D1Database,
  userId: string,
  nowMs: number = Date.now(),
): Promise<string> {
  await ensureTotpPendingTable(db);
  // Two UUIDs = 256 bits of crypto randomness, the same primitive the session
  // token uses, doubled because this one is handed out before any second factor
  // has been presented.
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
  const tokenHash = await hashPendingToken(token);
  await db
    .prepare(
      `INSERT INTO totp_pending_logins (token_hash, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(
      tokenHash,
      userId,
      new Date(nowMs).toISOString(),
      new Date(nowMs + PENDING_TOTP_TTL_MS).toISOString(),
    )
    .run();
  return token;
}

export type PendingTokenCheck =
  | { ok: true }
  | { ok: false; reason: "missing" | "unknown" | "expired" | "wrong-user" };

/**
 * Does `token` prove that the password step happened for `userId`, recently?
 *
 * Read-only on purpose — the row is burned separately, by `consume…` below,
 * and only once a session is actually issued. A mistyped 6-digit code must not
 * cost the operator their password step; the 10-per-15-minutes throttle already
 * bounds the retries, and forcing a full re-login on every typo is exactly the
 * kind of friction that gets a security gate switched back off.
 */
export async function checkPendingTotpToken(
  db: D1Database,
  userId: string,
  token: string | undefined,
  nowMs: number = Date.now(),
): Promise<PendingTokenCheck> {
  if (!token) return { ok: false, reason: "missing" };
  await ensureTotpPendingTable(db);
  const row = await db
    .prepare(
      "SELECT user_id, expires_at FROM totp_pending_logins WHERE token_hash = ?",
    )
    .bind(await hashPendingToken(token))
    .first<{
      user_id?: string;
      userId?: string;
      expires_at?: string;
      expiresAt?: string;
    }>();
  if (!row) return { ok: false, reason: "unknown" };
  // Dual-keyed: `SELECT *`-style column renaming maps a snake column back to
  // its camelCase twin when the rename map knows it (HOOKKA-GOTCHAS).
  const rowUserId = row.userId ?? row.user_id ?? "";
  const expiresAt = row.expiresAt ?? row.expires_at ?? "";
  if (rowUserId !== userId) return { ok: false, reason: "wrong-user" };
  const expMs = Date.parse(expiresAt);
  if (!Number.isFinite(expMs) || expMs <= nowMs) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true };
}

/**
 * Burn the pending token — call this once the session has been issued, so the
 * same token can never mint a second one.
 *
 * Also sweeps this user's other pending rows: a user who typed their password
 * three times before reaching for their phone should not leave two live tokens
 * behind. Best-effort; a failure here must never fail a login that already
 * succeeded.
 */
export async function consumePendingTotpToken(
  db: D1Database,
  userId: string,
): Promise<void> {
  try {
    await db
      .prepare("DELETE FROM totp_pending_logins WHERE user_id = ?")
      .bind(userId)
      .run();
  } catch (err) {
    console.warn(
      "[totp-pending] burn failed (non-fatal):",
      err instanceof Error ? err.message : String(err),
    );
  }
}
