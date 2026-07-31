// ---------------------------------------------------------------------------
// api-rate-limit.ts — general-purpose API rate-limit middleware.
//
// Why this exists: even with strong auth, a stolen session token or a
// compromised insider account can hammer the API. The login limiter in
// rate-limit.ts only caps pre-auth attempts; once a Bearer token is valid,
// nothing throttles how many writes the holder fires. This middleware adds
// a per-user (or per-IP for unauthenticated) ceiling on every /api/* call.
//
// Sizing: Hookka's normal load is ~40-500 requests per 24 hours per user.
// Defaults of 300/min and 5000/hr sit at least 10x above any realistic human
// burst, so a normal operator will never see a 429 — only an abusive pattern
// (scripted scrape, runaway loop, credential-stuffer with a stolen token)
// trips it.
//
// Implementation:
//   * Two fixed-time buckets — current minute and current hour. Cheaper than
//     a true sliding window and good enough for "stop the runaway loop".
//   * Counter stored in SESSION_CACHE KV (same binding as auth + login-limit).
//     One read + one write per request — KV is single-digit-ms on the warm
//     path so the overhead is negligible.
//   * KV eventual consistency means under high concurrency the counter can
//     drift slightly. That's fine: we're catching abuse, not enforcing a
//     hard quota — over-counting by a few is the safe direction.
//   * Best-effort: any KV failure (binding missing in test env, transient
//     blip, etc.) falls through and ALLOWS the request. We never want a
//     KV outage to lock real users out of the app.
//   * Exempt paths skip the counter entirely — health checks, SSE-style
//     long-poll endpoints, anything that legitimately fires constantly.
// ---------------------------------------------------------------------------
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../worker";
import { getRateLimitConfig } from "./api-rate-limit-config";

/** Options for {@link apiRateLimit}. */
export type ApiRateLimitOpts = {
  /** Override default per-minute cap (300). Per-endpoint config still applies. */
  perMinute?: number;
  /** Override default per-hour cap (5000). Per-endpoint config still applies. */
  perHour?: number;
  /**
   * Paths that bypass the limiter entirely. Matched by EXACT path or by
   * "prefix + /" so "/api/health" exempts only the exact path while a future
   * "/api/sse/" exempts the whole subtree.
   *
   * Defaults exempt the health check, the Postgres ping, and the QC-pending
   * cron trigger (CRON_SECRET-gated, cron driver can call it as often as it
   * wants). Callers can pass an array to add more.
   */
  exempt?: string[];
};

const DEFAULT_EXEMPT = [
  "/api/health",
  "/api/pg-ping",
  // Cron-triggered endpoints — already gated by CRON_SECRET and called by
  // a single trusted caller; the per-IP limit would clip nothing useful.
  "/api/internal/",
  "/api/qc-pending/trigger",
];

const KEY_PREFIX = "apirl:";

/** Extract the best-available client IP for use in a fallback rate-limit key. */
function clientIp(c: Context<Env>): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/** True when `path` matches any exempt entry (exact match or "prefix/" rule). */
function isExempt(path: string, exempt: string[]): boolean {
  for (const e of exempt) {
    if (path === e) return true;
    // Prefix-style entries are written with a trailing slash, e.g.
    // "/api/internal/". Anything under that subtree bypasses the limiter.
    if (e.endsWith("/") && path.startsWith(e)) return true;
  }
  return false;
}

/**
 * Hono middleware factory. Returns a middleware that throttles /api/* traffic
 * to a per-user (or per-IP) ceiling per minute AND per hour. Wire AFTER
 * authMiddleware + tenantMiddleware so c.get('userId') is populated; falls
 * back to client IP for unauthenticated public endpoints.
 *
 * Returns the middleware, not a Promise — safe to register at module load.
 */
// Isolate-local backstop for AUTHENTICATED GET requests (perf audit
// 2026-07-31). The KV limiter costs ~2 round-trips (2 reads + 2 blocking
// writes) per request and — since it ships WARN-ONLY by default — doesn't even
// block on the read hot path. So authed GETs skip KV entirely and use this
// free in-memory counter instead: it still catches a runaway client hammering
// the same isolate (a fetch-loop → the same few isolates), which is the real
// risk, while removing the latency. Loose across isolates by design; writes /
// login / unauthenticated traffic keep the full KV limiter below. The window
// is generous enough that normal human use never trips it (600 GETs / 10s per
// user per isolate ≈ 60/s).
const GET_BACKSTOP_WINDOW_MS = 10_000;
const GET_BACKSTOP_MAX = 600;
const GET_BACKSTOP_CAP = 5000;
const _getBackstop = new Map<string, { windowStart: number; count: number }>();

export function apiRateLimit(opts: ApiRateLimitOpts = {}): MiddlewareHandler<Env> {
  const exempt = [...DEFAULT_EXEMPT, ...(opts.exempt ?? [])];

  return async (c, next) => {
    const path = c.req.path;

    // Fast path — never count requests for exempt endpoints. Saves a KV
    // round-trip on the hot health-check + cron paths.
    if (isExempt(path, exempt)) return next();

    // Pick the limit. Per-endpoint config wins; explicit opts on the factory
    // are a coarse override of the defaults. The minute/hour numbers we
    // actually enforce are the MIN of those two sources, so a tight
    // per-endpoint config (e.g. /api/auth/login = 10/min) is never loosened
    // by a generous factory-level opts.perMinute.
    const cfg = getRateLimitConfig(path);
    const perMinute = Math.min(opts.perMinute ?? cfg.perMinute, cfg.perMinute);
    const perHour = Math.min(opts.perHour ?? cfg.perHour, cfg.perHour);

    // Identity. Prefer the authenticated userId (so attackers can't dodge
    // the limit by rotating IPs behind a single stolen token); fall back to
    // the IP when there's no session yet (login, forgot-password, etc.).
    const userId = (c.get as unknown as (k: string) => string | undefined)("userId");
    const ident = userId ?? `ip:${clientIp(c)}`;

    // Fast path: an authenticated GET skips the KV limiter (~2 round-trips) and
    // uses the free isolate-local backstop instead. Only a runaway loop trips
    // it; a tripped backstop honours the same warn-only/enforce switch as KV.
    if (userId && c.req.method === "GET") {
      const nowB = Date.now();
      let b = _getBackstop.get(userId);
      if (!b || nowB - b.windowStart > GET_BACKSTOP_WINDOW_MS) {
        if (_getBackstop.size > GET_BACKSTOP_CAP) _getBackstop.clear();
        b = { windowStart: nowB, count: 0 };
        _getBackstop.set(userId, b);
      }
      b.count += 1;
      if (b.count > GET_BACKSTOP_MAX) {
        const enforcing =
          (c.env as { API_RATE_LIMIT_MODE?: string }).API_RATE_LIMIT_MODE === "enforce";
        console.warn(
          `[api-rate-limit] ${enforcing ? "429" : "WOULD-429"} isolate-backstop user=${userId} path=${path} count=${b.count}/${GET_BACKSTOP_MAX} per ${GET_BACKSTOP_WINDOW_MS}ms`,
        );
        if (enforcing) {
          c.res.headers.set("Retry-After", "10");
          return c.json(
            { success: false, error: "Too many requests. Try again shortly.", retryAfterSec: 10 },
            429,
          );
        }
      }
      return next();
    }

    const kv = c.env.SESSION_CACHE;
    // Without KV (test env, KV outage), fall through. We never let a KV
    // problem lock real users out — the login limiter has the same posture.
    if (!kv) return next();

    // Two fixed buckets: current minute and current hour. Cheap, no Redis-
    // style atomic increments needed. Each bucket TTLs itself so KV doesn't
    // grow unboundedly.
    const now = Date.now();
    const minuteBucket = Math.floor(now / 60_000);
    const hourBucket = Math.floor(now / 3_600_000);

    const sanitised = ident.replace(/[^a-zA-Z0-9._@:-]/g, "_");
    const minuteKey = `${KEY_PREFIX}${sanitised}:m:${minuteBucket}`;
    const hourKey = `${KEY_PREFIX}${sanitised}:h:${hourBucket}`;

    let minuteCount = 0;
    let hourCount = 0;
    try {
      // Two parallel reads — both buckets are small integer strings, so this
      // is cheap. Best-effort: any failure leaves both counts at 0 and we
      // fall through to allow the request.
      const [m, h] = await Promise.all([kv.get(minuteKey), kv.get(hourKey)]);
      if (m) {
        const n = Number.parseInt(m, 10);
        if (Number.isFinite(n)) minuteCount = n;
      }
      if (h) {
        const n = Number.parseInt(h, 10);
        if (Number.isFinite(n)) hourCount = n;
      }
    } catch (e) {
      // KV blip — log once and allow. Better to under-enforce for a few
      // seconds than to lock the operator out of the app.
      console.warn("[api-rate-limit] KV read failed, allowing:", e);
      return next();
    }

    // Already over the cap? Refuse without incrementing further — no point
    // bumping a counter that's already past the line. retryAfterSec hints
    // the client when to back off.
    //
    // 2026-05-27 SOFT LAUNCH: per Wei Siang "最重要不影响现在的功能" the
    // limiter ships in WARN-ONLY mode initially. We still log every breach
    // so /admin/health surfaces who would have been throttled, but we let
    // the request through. To flip to enforcement, set Cloudflare Pages
    // env var `API_RATE_LIMIT_MODE = "enforce"`. Any other value (or
    // unset) means warn-only.
    if (minuteCount >= perMinute || hourCount >= perHour) {
      const retryAfterSec = minuteCount >= perMinute ? 60 : 3600;
      const mode = (c.env as { API_RATE_LIMIT_MODE?: string }).API_RATE_LIMIT_MODE;
      const enforcing = mode === "enforce";
      console.warn(
        `[api-rate-limit] ${enforcing ? "429" : "WOULD-429"} ident=${ident} path=${path} minute=${minuteCount}/${perMinute} hour=${hourCount}/${perHour}`,
      );
      if (enforcing) {
        c.res.headers.set("Retry-After", String(retryAfterSec));
        return c.json(
          {
            success: false,
            error: "Too many requests. Try again in a minute.",
            retryAfterSec,
          },
          429,
        );
      }
      // WARN-ONLY: fall through to next() without bumping (no point
      // continuing to climb the counter past the line).
      return next();
    }

    // Bump both counters. Best-effort writes — if KV fails the next request
    // re-reads a slightly stale count, which is fine for an abuse limiter.
    // expirationTtl is set to one full bucket size on every write; KV resets
    // the TTL on each put, which slightly over-extends the bucket window —
    // the conservative direction for a limiter.
    try {
      await Promise.all([
        kv.put(minuteKey, String(minuteCount + 1), { expirationTtl: 120 }),
        kv.put(hourKey, String(hourCount + 1), { expirationTtl: 3600 }),
      ]);
    } catch (e) {
      console.warn("[api-rate-limit] KV write failed:", e);
    }

    return next();
  };
}
