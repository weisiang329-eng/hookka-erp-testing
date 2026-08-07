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

  // Public QR dispatch/deliver scan flow (no session — limiter keys by IP).
  // A driver scans one code and taps one button; even a whole crew behind
  // one mobile-carrier NAT stays far below this. Tightened vs DEFAULT
  // because the endpoint is reachable without login.
  { prefix: "/api/public/do-qr", limits: { perMinute: 30, perHour: 300 }, reason: "public QR scan surface" },

  // Public packing-sticker → RACK assignment (no session — limiter keys by IP).
  // A storekeeper scans one sticker and taps one rack; even a whole warehouse
  // crew behind one NAT stays far below this. Same tightened public ceiling as
  // the DO-QR surface. NOTE: this MUST come before the broader rack-qr entry
  // below so the more-specific "/api/public/rack-write" prefix wins the
  // starts-with match (rack-write is not a prefix of rack-qr, but keep them
  // adjacent + ordered for clarity).
  { prefix: "/api/public/rack-write", limits: { perMinute: 30, perHour: 300 }, reason: "public rack-write scan surface" },

  // Public rack STOCK-IN scan flow (no session — limiter keys by IP). Was
  // previously missing from OVERRIDES (fell back to DEFAULT 600/min); brought
  // under the same tightened public ceiling as the other two public scan
  // surfaces. A warehouse crew scanning items into a rack stays far below this.
  { prefix: "/api/public/rack-qr", limits: { perMinute: 30, perHour: 300 }, reason: "public rack stock-in scan surface" },

  // Public customer satisfaction survey (no session — limiter keys by IP). A
  // customer opens one link and submits once; the same tightened public
  // ceiling as the three scan surfaces. This one is a public WRITE with no
  // human on our side of it, so the ceiling matters more here than anywhere
  // else — the token is single-use, and this caps how fast anyone can hunt
  // for one.
  { prefix: "/api/public/survey", limits: { perMinute: 30, perHour: 300 }, reason: "public customer survey surface" },
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
