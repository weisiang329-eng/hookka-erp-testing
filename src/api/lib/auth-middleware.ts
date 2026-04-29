// ---------------------------------------------------------------------------
// Global auth middleware for the D1-backed Hono app.
//
// Sprint 7: dashboard sessions moved from `Authorization: Bearer <token>`
// (read from localStorage on the client) to a HttpOnly `hookka_session`
// cookie set by the server on login. To defend against CSRF the server also
// sets a non-HttpOnly `hookka_csrf` cookie at login time; on every mutating
// request (POST/PUT/PATCH/DELETE) the client must echo that value in the
// `X-CSRF-Token` header. The middleware compares cookie vs header — they
// have to match for the request to land. This is the standard
// double-submit-cookie pattern; an attacker on a cross-origin page can
// neither read the cookie (SameSite=Strict + HttpOnly is irrelevant for the
// CSRF cookie, but cross-origin reads are blocked by SameSite) nor force a
// matching header.
//
// Worker portal (/api/worker/*) keeps its own header-based token flow —
// it's mobile-friendly and out of scope for this migration.
//
// Paths in PUBLIC_PATHS (login/logout/health) bypass the middleware so the
// client can authenticate before acquiring a session. OPTIONS preflight
// always passes through (CORS already handled by the top-level cors()
// middleware).
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
// TTL = 5 minutes — long enough to absorb the hot API-call pattern
// (dashboard loads fire 5-10 calls/sec per user) without round-tripping
// to D1 every time.
//
// P3.8 — TTL alone is NOT the security boundary for role/session changes.
// Every write that mutates a cached field (role flip, deactivation, logout,
// password reset, delete) explicitly purges the KV entry via
// invalidateSessionCache / purgeUserSessions, so revocation propagates on
// the next request rather than waiting up to TTL seconds. Path A from the
// P3.8 ticket: keep the cheap 5-min TTL, pay the explicit-invalidate cost
// on the rare write side instead of 5x'ing read traffic to D1.
const SESSION_CACHE_TTL_S = 300;

// Sprint 4 — sliding session refresh.
// The /login handler issues a 7-day expiry. authMiddleware (below) extends
// that expiry by SESSION_TTL_MS whenever the remaining lifetime drops below
// SLIDING_REFRESH_THRESHOLD_MS — gated by remaining-lifetime so we don't
// fire a DB write on every request, only ~once per day per active user.
// Net: an active user stays logged in indefinitely; an inactive user logs
// out after 7 days.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SLIDING_REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 1 day

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

// Parse a single cookie value out of the Cookie header, RFC-6265-lite.
// Returns null if the cookie isn't present or the header is missing.
export function readCookie(
  cookieHeader: string | null | undefined,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  // Cookies are separated by "; " — split is good enough; we URL-decode
  // values just in case (login-issued tokens are URL-safe so this is a no-op
  // for them, but invite-acceptance flows could in theory percent-encode).
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    const v = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return null;
}

// Names used by the dashboard cookie session (Sprint 7). Worker portal does
// NOT use these — it stays on `x-worker-token`.
export const SESSION_COOKIE = "hookka_session";
export const CSRF_COOKIE = "hookka_csrf";
export const CSRF_HEADER = "x-csrf-token";

// Methods that need CSRF protection. GET/HEAD/OPTIONS never mutate state and
// are exempt — also matches what browser-issued same-origin requests can do
// from a cross-origin form/img/script tag without scripting.
const CSRF_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const authMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  const path = c.req.path;

  // CORS preflight — let the cors() middleware handle it.
  if (c.req.method === "OPTIONS") return next();

  // Anything outside /api/* is served as a static asset — the middleware is
  // only registered under /api/* in worker.ts, but guard here too.
  if (!path.startsWith("/api/")) return next();

  const isPublic = isPublicPath(path, c.req.method);

  // -------- Token resolution -------------------------------------------
  // Sprint 7: prefer the HttpOnly `hookka_session` cookie. Fall back to the
  // legacy `Authorization: Bearer <token>` for one release while clients
  // roll over (and to keep ad-hoc `curl` workflows working).
  const cookieHeader = c.req.header("cookie");
  const cookieToken = readCookie(cookieHeader, SESSION_COOKIE);
  let token: string | null = cookieToken;
  if (!token) {
    const authHeader = c.req.header("authorization") || "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) token = match[1].trim();
  }
  if (!token) {
    if (isPublic) return next();
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  // -------- CSRF: double-submit cookie ---------------------------------
  // Only enforce when the caller authenticated via the cookie path (the
  // browser session). Bearer-token callers (legacy + scripts) are immune to
  // browser-style CSRF because no browser auto-attaches the bearer header
  // cross-origin.
  if (cookieToken && CSRF_METHODS.has(c.req.method)) {
    const csrfCookie = readCookie(cookieHeader, CSRF_COOKIE);
    const csrfHeader = c.req.header(CSRF_HEADER);
    if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
      return c.json(
        { success: false, error: "CSRF token missing or invalid" },
        403,
      );
    }
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
    if (isPublic) return next();
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }
  if (row.isActive !== 1) {
    if (isPublic) return next();
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  // Rollup: keep S4's millisecond-style time comparison (sliding-refresh
  // below uses these locals). Keep S1's soft-auth fallback so an expired
  // session on a public route falls through to next() instead of 401.
  const nowMs = Date.now();
  const expiresMs = new Date(row.expiresAt).getTime();
  if (expiresMs <= nowMs) {
    if (isPublic) return next();
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  // Sprint 4 — sliding session refresh.
  // Gate the DB write by remaining-lifetime so an active user fires the
  // UPDATE at most ~once per day, not on every request. After the push,
  // expiresAt is now+SESSION_TTL_MS; the KV cache is invalidated so the
  // next request reads the fresh row from Postgres (slight extra latency
  // for that one request, but cheaper than wedging a stale expiry into
  // every cached entry).
  const remainingMs = expiresMs - nowMs;
  if (remainingMs < SLIDING_REFRESH_THRESHOLD_MS) {
    const newExpires = new Date(nowMs + SESSION_TTL_MS).toISOString();
    // Fire-and-forget — extending a session is non-critical to the
    // current request. If it fails the user just gets a normal expiry
    // window and re-logs-in next time. waitUntil keeps the Worker alive
    // long enough for the write to land without blocking the response.
    c.executionCtx.waitUntil(
      Promise.all([
        c.var.DB.prepare(
          "UPDATE user_sessions SET expiresAt = ? WHERE token = ?",
        )
          .bind(newExpires, token)
          .run(),
        invalidateSessionCache(kv, token),
      ]).catch((err) => {
        console.warn("[auth] sliding-refresh failed:", err);
      }),
    );
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
