// ---------------------------------------------------------------------------
// api-rate-limit-config.ts — per-endpoint rate-limit overrides.
//
// Most endpoints share the default ceiling (300 req/min, 5000 req/hr). A few
// endpoints have different traffic shapes and need their own number — this
// file is the one place that decides which override wins for a given path.
//
// Rule of thumb when adding a new entry: a single human operator should never
// hit the limit during normal use, even on a busy day. The limits here are
// abuse ceilings, not per-feature SLAs.
// ---------------------------------------------------------------------------

/** Bucketed limits applied per (userId | clientIp, minute) and per (..., hour). */
export type RateLimitConfig = {
  perMinute: number;
  perHour: number;
};

// Default ceiling — well above any realistic single-user traffic on a small
// shop (Hookka normal load is ~40-500 req per 24 hours per user).
//
// 2026-05-27 — bumped from 300/5000 to 600/10000 per Wei Siang
// "不要影响到现在的use". Heavy dashboards (e.g. /admin/health fires
// 14 concurrent endpoints, and /production/orders triggers a fan-out of
// SO + items + customer + payments + audit on each row click) can spike
// over 300/min during routine browsing. 600/min is still 50x above
// observed single-user 24h burst, but leaves headroom for dashboard
// pages and double-tab workflows.
const DEFAULT: RateLimitConfig = { perMinute: 600, perHour: 10000 };

// Per-path overrides. Match is "starts-with" on the incoming pathname so we
// can cover whole prefix families (e.g. "/api/upload" matches both
// "/api/upload/file" and "/api/upload-batch").
//
// Keep this list short: every entry is a special case we have to think about
// during incidents. Anything not listed gets DEFAULT.
const OVERRIDES: Array<{ prefix: string; limits: RateLimitConfig; reason: string }> = [
  // Login already has its own per-(email+ip) lockout in rate-limit.ts (10 in
  // 15 min). The number here is just a defense-in-depth ceiling for someone
  // hammering many accounts from one session — well above any human login
  // pattern but enough to slow scripted credential stuffing.
  { prefix: "/api/auth/login", limits: { perMinute: 10, perHour: 200 }, reason: "login DiD ceiling" },

  // Forgot-password is IP-rate-limited inside the handler. This is a higher
  // wrapper ceiling so a single user clicking "Resend" repeatedly while also
  // browsing the app doesn't trip the API-wide limit on unrelated requests.
  { prefix: "/api/auth/forgot-password", limits: { perMinute: 5, perHour: 50 }, reason: "password reset cap" },

  // Front-end RUM batches errors + Core Web Vitals. A noisy page (lots of
  // navigation, lots of vitals) can legitimately fire several batches per
  // minute. Bump the ceiling so observability doesn't get clipped.
  { prefix: "/api/fe-rum/event", limits: { perMinute: 600, perHour: 10000 }, reason: "RUM batches are chatty" },

  // File uploads are slow per-request. The operator rarely uploads more than
  // a handful per minute, but each upload may stream — give it headroom.
  { prefix: "/api/upload", limits: { perMinute: 60, perHour: 1000 }, reason: "uploads are slower" },
  { prefix: "/api/files", limits: { perMinute: 60, perHour: 1000 }, reason: "file asset uploads" },
];

/**
 * Resolve the rate-limit config for an incoming request path.
 *
 * Returns the FIRST matching override prefix, or DEFAULT when nothing matches.
 * Order in OVERRIDES is significant only when two prefixes could both match
 * the same path — keep the more specific one first.
 */
export function getRateLimitConfig(path: string): RateLimitConfig {
  for (const o of OVERRIDES) {
    if (path.startsWith(o.prefix)) return o.limits;
  }
  return DEFAULT;
}
