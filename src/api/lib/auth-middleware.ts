// ---------------------------------------------------------------------------
// Global auth middleware for the D1-backed Hono app.
//
// Reads `Authorization: Bearer <token>`, resolves the session row in
// user_sessions, verifies the session hasn't expired and the user is still
// active, and stashes `userId` / `userRole` on the Hono context so downstream
// handlers can `c.get('userId')`.
//
// Paths in PUBLIC_PATHS (login/logout/health) bypass the middleware so the
// client can authenticate before acquiring a token. OPTIONS preflight always
// passes through (CORS already handled by the top-level cors() middleware).
// ---------------------------------------------------------------------------
import type { MiddlewareHandler } from "hono";
import type { Env } from "../worker";

// Exact-match endpoints that always bypass the dashboard auth gate.
export const PUBLIC_PATHS = [
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/accept-invite",
  // Phase C.6 — TOTP step-2 of password login. The caller already proved
  // possession of the password (got back { totpRequired: true, userId }) and
  // must now prove possession of the second factor. No bearer yet.
  "/api/auth/totp/login-verify",
  "/api/health",
];

// Prefix-match endpoints that bypass the dashboard auth gate. These cover the
// shop-floor Worker Portal (its own PIN/token flow via /api/worker-auth and
// /api/worker) and the invite preflight (GET /api/auth/invite/:token —
// anyone with the token URL can hit it).
// Anything else under /api/* goes through the Bearer token check.
const PUBLIC_PREFIXES = [
  "/api/worker-auth/",
  "/api/worker/",
  "/api/auth/invite/",
  // Phase B.3 — Google Workspace OAuth handshake. /start mints CSRF state +
  // 302's to Google; /callback consumes Google's redirect, finds-or-links
  // the local user, and issues a session. Both are pre-auth by definition.
  "/api/auth/oauth/",
];

// Customer QR tracking lookup: only the single-unit GET is public. The list
// endpoint and all writes (scan/generate) require auth — otherwise anyone on
// the internet can dump inventory or mutate unit status.
const FG_UNIT_PUBLIC_GET_RE = /^\/api\/fg-units\/[^/]+$/;

function isPublicPath(path: string, method: string): boolean {
  if (PUBLIC_PATHS.includes(path)) return true;
  if (method === "GET" && FG_UNIT_PUBLIC_GET_RE.test(path)) return true;
  for (const pfx of PUBLIC_PREFIXES) {
    if (path === pfx || path.startsWith(pfx)) return true;
  }
  return false;
}

type SessionJoinRow = {
  userId: string;
  expiresAt: string;
  role: string;
  isActive: number;
};

// KV session cache (Phase 2.6a).  Key = "sess:" + sha256(token) to avoid
// storing tokens in plaintext as KV keys.  Value = SessionJoinRow JSON.
// TTL = 5 minutes — short enough that role revocation and session
// invalidation propagate within a tolerable window, long enough to absorb
// the hot API-call pattern (dashboard loads fire 5-10 calls/sec per user).
const SESSION_CACHE_TTL_S = 300;

export async function sessionCacheKey(token: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  const hex = Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sess:${hex}`;
}

/**
 * Called from /api/auth/logout and any endpoint that deletes user_sessions
 * rows — invalidates the KV cache entry so a logged-out user cannot keep
 * using the token for up to TTL seconds.
 */
export async function invalidateSessionCache(
  kv: KVNamespace | undefined,
  token: string,
): Promise<void> {
  if (!kv || !token) return;
  const key = await sessionCacheKey(token);
  await kv.delete(key);
}

/**
 * Purge ALL active sessions for a user — both the DB rows AND the KV cache
 * entries keyed by each token's hash.  Used when deactivating or deleting
 * a user, resetting a password, or rotating roles.  Without the KV purge a
 * banned user would keep API access for up to SESSION_CACHE_TTL_S.
 */
export async function purgeUserSessions(
  db: D1Database,
  kv: KVNamespace | undefined,
  userId: string,
): Promise<void> {
  // Collect tokens BEFORE deleting the rows — once rows are gone we have no
  // way to know which KV keys to purge.
  const tokensRes = await db
    .prepare("SELECT token FROM user_sessions WHERE userId = ?")
    .bind(userId)
    .all<{ token: string }>();
  const tokens = (tokensRes.results ?? []).map((r) => r.token);

  await db
    .prepare("DELETE FROM user_sessions WHERE userId = ?")
    .bind(userId)
    .run();

  if (kv && tokens.length > 0) {
    await Promise.all(tokens.map((t) => invalidateSessionCache(kv, t)));
  }
}

export const authMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  const path = c.req.path;

  // CORS preflight — let the cors() middleware handle it.
  if (c.req.method === "OPTIONS") return next();

  // Anything outside /api/* is served as a static asset — the middleware is
  // only registered under /api/* in worker.ts, but guard here too.
  if (!path.startsWith("/api/")) return next();

  // Public endpoints (login/logout/health + worker portal + public tracking)
  // bypass the auth check entirely.
  if (isPublicPath(path, c.req.method)) return next();

  const authHeader = c.req.header("authorization") || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }
  const token = match[1].trim();
  if (!token) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  // KV first — saves the Hyperdrive round trip on cache hit.
  const cacheKey = await sessionCacheKey(token);
  let row: SessionJoinRow | null = null;
  const kv = c.env.SESSION_CACHE;
  if (kv) {
    const cached = await kv.get(cacheKey, { type: "json" });
    if (cached) row = cached as SessionJoinRow;
  }

  if (!row) {
    row = await c.var.DB.prepare(
      `SELECT s.userId AS userId, s.expiresAt AS expiresAt,
              u.role AS role, u.isActive AS isActive
         FROM user_sessions s
         JOIN users u ON u.id = s.userId
        WHERE s.token = ?
        LIMIT 1`,
    )
      .bind(token)
      .first<SessionJoinRow>();
    if (row && kv) {
      // expirationTtl capped at the session expiry to avoid serving a stale
      // session past its real expiry.  min(300s, remaining-lifetime).
      const remainingMs = new Date(row.expiresAt).getTime() - Date.now();
      const ttl = Math.max(
        1,
        Math.min(SESSION_CACHE_TTL_S, Math.floor(remainingMs / 1000)),
      );
      // Fire-and-forget — don't block the request on cache writes.
      c.executionCtx.waitUntil(
        kv.put(cacheKey, JSON.stringify(row), { expirationTtl: ttl }),
      );
    }
  }

  if (!row) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }
  if (row.isActive !== 1) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  const now = new Date().toISOString();
  if (row.expiresAt <= now) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  // Stash on ctx so downstream handlers can read via c.get('userId').
  // Cast avoids needing to touch the exported Env in worker.ts.
  (c as unknown as { set: (k: string, v: unknown) => void }).set(
    "userId",
    row.userId,
  );
  (c as unknown as { set: (k: string, v: unknown) => void }).set(
    "userRole",
    row.role,
  );

  await next();
};
