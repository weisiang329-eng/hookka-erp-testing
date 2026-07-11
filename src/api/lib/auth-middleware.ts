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
  // Self-service password reset (added 2026-05-27). Both endpoints
  // are PUBLIC by definition — the caller has no session to present
  // because they're trying to recover one.
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  // Phase C.6 — TOTP step-2 of password login. The caller already proved
  // possession of the password (got back { totpRequired: true, userId }) and
  // must now prove possession of the second factor. No bearer yet.
  "/api/auth/totp/login-verify",
  // Note: /api/auth/totp/setup-start, /setup-confirm and /dismiss-prompt
  // are NOT public — they require an active dashboard session (the caller
  // is already logged in). They flow through the normal cookie/bearer
  // check below.
  "/api/health",
  // Front-End RUM telemetry sink. Fire-and-forget error/perf beacons from
  // the browser — they fire on page load, longtasks, and unhandled errors,
  // INCLUDING when the session has expired or hasn't resolved yet, which was
  // generating a flood of 401s (and silently dropping the very error data we
  // want to see). Made public 2026-05-28 so beacons always land. Soft-auth
  // still sets userId when a valid session is present (attribution preserved);
  // anonymous beacons record with empty userId. Abuse-capped at 50 events
  // per batch in the handler (routes/fe-rum.ts).
  "/api/fe-rum/event",
  // Google Sheets onEdit webhook. Apps Script can't carry the dashboard JWT,
  // so auth boils down to the HMAC signature (SHEETS_SYNC_SECRET) + 5-minute
  // timestamp window inside the handler. See docs/SHEETS-SYNC.md.
  "/api/sheets-sync/apps-script-webhook",
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
  // 2026-05-27 — daily-report cron triggers. The endpoint itself does its
  // own CRON_SECRET HMAC check (constant-time SHA-256) before doing any
  // work. No session — external cron services can't carry one anyway.
  "/api/internal/reports/",
  // 2026-07-12 — Delivery Agent cron trigger. Same model as the report
  // triggers above: the handler does its own CRON_SECRET constant-time
  // check before any work. See routes/delivery-agent.ts (POST /run-trigger).
  "/api/internal/delivery-agent/",
  // 2026-06-12 — QR dispatch/deliver scan flow. Drivers scan the QR printed
  // on a DO / Packing List with a normal phone camera — no session exists.
  // The handler's gate is the unguessable 64-hex qrtoken (migration 0167):
  // GET returns a minimal no-price summary; POST /advance only performs the
  // forward DO transitions (DRAFT→LOADED, LOADED/IN_TRANSIT→DELIVERED)
  // through the SAME office PUT path. See routes/public-do-qr.ts.
  "/api/public/do-qr/",
  // 2026-06-17 — public rack STOCK-IN scan flow. A worker scans a printed rack
  // QR (HKRACK:<rack id>) with a normal phone camera — no session — then scans
  // items to stock them into that rack. The token is the plain rack id (stock-in
  // is additive/low-risk; the worker endpoint already accepts a bare rack id).
  // GET exposes only the rack label + item count; POST /stock-in writes via the
  // SAME helper the worker route uses. See routes/public-rack-qr.ts.
  "/api/public/rack-qr/",
  // 2026-06-24 — public packing-sticker → RACK assignment (the ITEM→RACK
  // direction). A storekeeper scans the QR on a Packing (FG) sticker with a
  // normal phone camera — no session — and lands on /p/<token> to set the rack
  // for THAT piece. The gate is the unguessable 64-hex job_card qr_token
  // (migration 0187), minted lazily only by the AUTHED sticker-print endpoint.
  // GET returns a minimal no-price summary; POST /rack performs ONLY set/clear
  // of the rackingNumber on the one token-resolved PACKING card, via the SAME
  // applyPackingRack helper the worker /packing-rack path uses. See
  // routes/public-rack-write.ts.
  "/api/public/rack-write/",
];

// Customer QR tracking lookup: only the single-unit GET is public. The list
// endpoint and all writes (scan/generate) require auth — otherwise anyone on
// the internet can dump inventory or mutate unit status.
const FG_UNIT_PUBLIC_GET_RE = /^\/api\/fg-units\/[^/]+$/;

// Shop-floor QR scan completion for the two merged-sticker departments
// (Fab Cut / Fab Sew). The /worker phone portal carries only X-Worker-Token —
// no dashboard session — so this POST must bypass the dashboard gate. It is
// NOT unguarded: the handler (production-orders.ts /:id/scan-complete-dept)
// binds body.workerId to the token via resolveWorkerToken (403 on mismatch)
// AND hard-rejects any deptCode other than FAB_CUT / FAB_SEW. So opening just
// this one POST lets a Fab Cut/Fab Sew worker complete their own dept's cards
// and nothing else under /api/production-orders. The sibling /scan-complete
// (per-piece, any dept) stays dashboard-only on purpose.
const WORKER_SCAN_COMPLETE_DEPT_RE =
  /^\/api\/production-orders\/[^/]+\/scan-complete-dept$/;

// Shared per-compartment Sew/Uph scan (the merged sticker scanned by either a
// sewing or an upholstery worker; the handler resolves the dept from WHO scans
// and binds the worker token + restricts to FAB_SEW/UPHOLSTERY by construction).
// Same safety shape as scan-complete-dept: open the path, the handler is the gate.
const WORKER_SCAN_COMPLETE_SHARED_RE =
  /^\/api\/production-orders\/[^/]+\/scan-complete-shared$/;

// Per-piece worker scan completion — the PACKING phone sticker routes here. The
// `$` anchor keeps this from matching scan-complete-dept / scan-complete-shared.
// The handler rejects any non-PACKING dept for worker-token callers, so opening
// the path only enables "a logged-in worker completing PACKING".
const WORKER_SCAN_COMPLETE_RE =
  /^\/api\/production-orders\/[^/]+\/scan-complete$/;

function isPublicPath(path: string, method: string): boolean {
  if (PUBLIC_PATHS.includes(path)) return true;
  if (method === "GET" && FG_UNIT_PUBLIC_GET_RE.test(path)) return true;
  if (method === "POST" && WORKER_SCAN_COMPLETE_DEPT_RE.test(path)) return true;
  if (method === "POST" && WORKER_SCAN_COMPLETE_SHARED_RE.test(path)) return true;
  if (method === "POST" && WORKER_SCAN_COMPLETE_RE.test(path)) return true;
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

// Constant-time string equality — hashes both sides before comparing so the
// comparison time depends only on the hash output length, never the secret
// contents. Same pattern as worker.ts's `constantTimeEqual`. Lives here so
// the scan-worker bypass above can call it without a circular import.
async function constantTimeEqualStr(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  if (va.length !== vb.length) return false;
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

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

  // Background scan worker bypass (added 2026-06-29 — async scan queue).
  // The /api/scan-queue/* upload endpoint stores file bytes and returns a
  // batchId; processBatch() runs under waitUntil() and self-calls the
  // existing /api/scan-po/extract or /api/scan-supplier/extract endpoint
  // with the stashed bytes. That fetch carries NO user session (the
  // operator may have closed their tab), so the only credential is a
  // shared secret. Same constant-time pattern as MAIL_INBOUND_SECRET /
  // PUSH_CRON_SECRET — only those two extract paths are eligible.
  const scanWorkerHeader = c.req.header("x-scan-worker") || "";
  const scanWorkerSecret = (
    c.env as unknown as { SCAN_WORKER_TOKEN?: string }
  ).SCAN_WORKER_TOKEN;
  if (
    scanWorkerHeader &&
    scanWorkerSecret &&
    scanWorkerSecret.length >= 16 &&
    (path === "/api/scan-po/extract" || path === "/api/scan-supplier/extract") &&
    c.req.method === "POST" &&
    (await constantTimeEqualStr(scanWorkerHeader, scanWorkerSecret))
  ) {
    // Stamp a system actor so requirePermission() inside the route allows
    // through. SUPER_ADMIN bypass is unconditional (see lib/rbac.ts).
    (c as unknown as { set: (k: string, v: unknown) => void }).set(
      "userId",
      "scan-worker",
    );
    (c as unknown as { set: (k: string, v: unknown) => void }).set(
      "userRole",
      "SUPER_ADMIN",
    );
    return next();
  }

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
    try {
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
    } catch (err) {
      // DB unreachable while verifying the session (the adapter already
      // retried a transient connection-create failure once). This is NOT a
      // "logged out" condition — returning 401 here would force-bounce an
      // authenticated user to /login on a momentary DB blip (the weak-wifi
      // "一直被登出"). Return a retriable 503 instead; the client keeps its
      // session and retries. Public routes still fall through to next().
      if (isPublic) return next();
      console.warn(
        "[auth] session verify failed (DB):",
        err instanceof Error ? err.message : String(err),
      );
      return c.json(
        { success: false, error: "Auth service busy — please retry." },
        503,
      );
    }
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
