// ---------------------------------------------------------------------------
// session-registry.ts — who is actually signed in, from where, and since when.
//
// WHY THIS EXISTS
// ---------------
// `user_sessions` shipped with four columns: token, userId, createdAt,
// expiresAt. That is enough to *validate* a session and nothing else. It is
// not enough to answer the question a security reviewer actually asks:
//
//     "This account looks active. Is that the person it belongs to?"
//
// The gap matters because of "Remember me". A session lives for days and
// slides forward every time it is used, so ONE login can grant weeks of
// access with no further login events. The login log — the thing everyone
// reaches for — shows a single entry from three weeks ago and nothing since,
// while somebody is using the account daily. An ex-employee on a remembered
// session, or a shared factory PC nobody signed out of, is invisible to it.
//
// So this module adds the three facts that make a session accountable:
//   · ip_address   — where it signed in from
//   · user_agent   — what browser/OS, so the owner can recognise their own
//   · last_seen_at — when the account was genuinely last USED, not last
//                    authenticated. This is the column that distinguishes
//                    "dormant" from "hasn't retyped a password lately".
//
// Plus `id`: a random public handle. Sessions are addressed by it in the API
// so a revoke call never has to carry the session TOKEN, which is the actual
// credential. Leaking a token in a URL or a log would hand over the session
// it was meant to manage.
//
// Columns are added at runtime (the project's established pattern — the
// migration runner cannot be relied on; see CLAUDE.md) and the migration file
// exists for a clean rebuild. Both are additive and idempotent.
// ---------------------------------------------------------------------------
import { memoizeSelfApply } from "./self-apply";

let sessionColumnsPromise: Promise<void> | null = null;

/**
 * Add the accountability columns to user_sessions. Idempotent, once per
 * isolate, memo dropped on failure so a transient blip is retried.
 */
export function ensureSessionColumns(db: D1Database): Promise<void> {
  return memoizeSelfApply(
    () => sessionColumnsPromise,
    (p) => {
      sessionColumnsPromise = p;
    },
    async () => {
      await db
        .prepare(
          `ALTER TABLE user_sessions
             ADD COLUMN IF NOT EXISTS id TEXT`,
        )
        .run();
      await db
        .prepare(
          `ALTER TABLE user_sessions
             ADD COLUMN IF NOT EXISTS ip_address TEXT`,
        )
        .run();
      await db
        .prepare(
          `ALTER TABLE user_sessions
             ADD COLUMN IF NOT EXISTS user_agent TEXT`,
        )
        .run();
      await db
        .prepare(
          `ALTER TABLE user_sessions
             ADD COLUMN IF NOT EXISTS last_seen_at TEXT`,
        )
        .run();
      // Existing sessions predate the id column. Give them one so they can be
      // listed and revoked like any other — otherwise the oldest sessions, the
      // ones most worth reviewing, would be the only ones you cannot act on.
      await db
        .prepare(
          `UPDATE user_sessions
              SET id = gen_random_uuid()::text
            WHERE id IS NULL`,
        )
        .run();
      // Listing is always "sessions for this user, newest first".
      await db
        .prepare(
          `CREATE INDEX IF NOT EXISTS idx_user_sessions_user_seen
             ON user_sessions(user_id, last_seen_at DESC)`,
        )
        .run();
    },
  );
}

/** Client IP as Cloudflare reports it, with the standard proxy fallback. */
export function clientIp(c: {
  req: { header: (k: string) => string | undefined };
}): string | null {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    null
  );
}

/** Truncated UA string. 256 chars matches what the audit log stores. */
export function clientUserAgent(c: {
  req: { header: (k: string) => string | undefined };
}): string | null {
  return (c.req.header("user-agent") ?? "").slice(0, 256) || null;
}

/**
 * How stale `last_seen_at` may get before a request refreshes it.
 *
 * Every authenticated request COULD write this, but that would add a DB write
 * to every page view for no extra insight — "last seen 4 minutes ago" and
 * "last seen 30 seconds ago" answer the same question. Five minutes keeps the
 * write volume near zero while staying precise enough to catch an account in
 * use right now. Same reasoning as the sliding-refresh gate in
 * auth-middleware.ts, which throttles its own write to about once a day.
 */
export const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;

/**
 * Build the INSERT for a new session row.
 *
 * WHY THIS IS A HELPER AND NOT AN INLINE QUERY
 * The four login paths (password, 2FA step-2, OAuth, accept-invite) all create
 * sessions. Inlining the enrichment four times guarantees they drift, and a
 * session created by a path that forgot the IP is a session you cannot review.
 *
 * WHY IT DEGRADES INSTEAD OF THROWING
 * The accountability columns are added by a runtime ALTER. If that ALTER has
 * not landed yet — a fresh isolate racing the first request, a DB role without
 * ALTER rights — the enriched INSERT would fail, and this sits directly on the
 * login path. Nobody being able to sign in is a far worse outcome than a
 * session row missing its IP. So a failed ensure falls back to the original
 * four-column INSERT: the user signs in, and that one row is simply less
 * detailed. Fail open here is correct precisely because these columns are
 * observability, not authorisation — they gate nothing.
 */
export async function sessionInsert(
  db: D1Database,
  c: { req: { header: (k: string) => string | undefined } },
  s: { token: string; userId: string; createdAt: string; expiresAt: string },
): Promise<D1PreparedStatement> {
  let enriched = true;
  try {
    await ensureSessionColumns(db);
  } catch (err) {
    enriched = false;
    console.warn(
      "[session-registry] column ensure failed; inserting a bare session row:",
      err instanceof Error ? err.message : String(err),
    );
  }

  if (!enriched) {
    return db
      .prepare(
        "INSERT INTO user_sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)",
      )
      .bind(s.token, s.userId, s.createdAt, s.expiresAt);
  }

  return db
    .prepare(
      "INSERT INTO user_sessions (id, token, userId, createdAt, expiresAt, ipAddress, userAgent, lastSeenAt)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      crypto.randomUUID(),
      s.token,
      s.userId,
      s.createdAt,
      s.expiresAt,
      clientIp(c),
      clientUserAgent(c),
      // Seed last_seen with the login time so a session that is created and
      // never used again still reports honestly, rather than showing NULL and
      // reading as "never seen".
      s.createdAt,
    );
}
