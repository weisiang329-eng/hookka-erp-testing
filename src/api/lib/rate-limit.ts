// ---------------------------------------------------------------------------
// rate-limit.ts — Sprint 2 (pre-launch auth hardening).
//
// Lightweight KV-backed counter for login attempts. Used to throttle:
//   * /api/auth/login                   (key: email + ip)
//   * /api/auth/totp/login-verify       (key: userId)
//   * /api/auth/oauth/google/callback   (key: ip)
//   * /api/worker-auth/login            (key: empNo)
//   * /api/worker-auth/reset-pin        (key: empNo)
//
// Strategy: 10 attempts per 15-minute window. After the 10th failure the
// caller is locked out (HTTP 429) until the KV key TTL expires.
//
// Implementation notes:
//   * Counter is a simple integer string in KV. We re-use SESSION_CACHE so we
//     don't need a fresh binding.
//   * KV is eventually consistent — two concurrent reads can both see N then
//     both write N+1 — the counter can over-count under high concurrency,
//     which is fine for an attempt limiter (errors on the safe side: lockout
//     a hair earlier rather than later). We do NOT use this as a hard
//     security boundary, but as a brute-force speed bump.
//   * The KV key TTL is set on first write to `windowSec`. Subsequent writes
//     KEEP the same TTL (KV has no "set if absent" so we just always pass
//     the same TTL — KV resets the TTL on every put, but the increase is
//     small relative to windowSec and is the conservative choice from the
//     defender's perspective).
//   * Returns:
//       null                — caller is under the limit, proceed.
//       Response (429)      — caller is locked out, return immediately.
//
// The KV namespace can be missing in unit tests / local dev; in that case
// rate-limiting is a no-op (returns null) so tests don't have to wire a KV
// stub.
// ---------------------------------------------------------------------------
import type { Context } from "hono";
import type { Env } from "../worker";

const RL_PREFIX = "ratelimit:login:";

/**
 * Check (and increment) the rate-limit counter for `key`.
 *
 * @param c           Hono context — used for KV binding + 429 response.
 * @param key         Identifier for the bucket. Caller-supplied composite
 *                    string, e.g. `email:ip` or `empNo`.
 * @param max         Maximum attempts within the window (default 10).
 * @param windowSec   Window length in seconds (default 900 = 15 min).
 * @returns           `null` when allowed, or a Response (429) the caller
 *                    should `return` immediately.
 */
export async function checkLoginRateLimit(
  c: Context<Env>,
  key: string,
  max: number = 10,
  windowSec: number = 900,
): Promise<Response | null> {
  const kv = c.env.SESSION_CACHE;
  // Without KV (test env), don't block — fall through.
  if (!kv) return null;
  if (!key) return null;

  const sanitised = key.replace(/[^a-zA-Z0-9._@:-]/g, "_");
  const fullKey = `${RL_PREFIX}${sanitised}`;

  let current = 0;
  try {
    const raw = await kv.get(fullKey);
    if (raw) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n)) current = n;
    }
  } catch (e) {
    // KV blip — fail open rather than locking out every login.
    console.warn("[rate-limit] KV read failed, allowing:", e);
    return null;
  }

  if (current >= max) {
    // Already at/over the cap. Don't bump further (no point) — just deny.
    return c.json(
      {
        success: false,
        error:
          "Too many login attempts. Please wait 15 minutes before trying again.",
        retryAfterSec: windowSec,
      },
      429,
    );
  }

  // Bump the counter. Best-effort write — if it fails we still allow this
  // attempt (next attempt re-reads the stale count).
  const next = current + 1;
  try {
    await kv.put(fullKey, String(next), { expirationTtl: windowSec });
  } catch (e) {
    console.warn("[rate-limit] KV write failed:", e);
  }

  return null;
}

/**
 * Best-effort reset on a successful login. Clears the counter so the user
 * doesn't carry yesterday's failed attempts into today.
 *
 * Caller should NOT block on this — it's fire-and-forget. We catch errors
 * internally and only log.
 */
export async function clearLoginRateLimit(
  c: Context<Env>,
  key: string,
): Promise<void> {
  const kv = c.env.SESSION_CACHE;
  if (!kv || !key) return;
  const sanitised = key.replace(/[^a-zA-Z0-9._@:-]/g, "_");
  try {
    await kv.delete(`${RL_PREFIX}${sanitised}`);
  } catch (e) {
    console.warn("[rate-limit] KV delete failed:", e);
  }
}

/** Extract the best-available client IP for use in a rate-limit key. */
export function clientIp(c: Context<Env>): string {
  return (
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}
