// ---------------------------------------------------------------------------
// KV cache helper — TRUE stale-while-revalidate over Cloudflare KV.
//
// Usage from a route:
//   import { cached } from '../lib/kv-cache';
//   const bom = await cached(c, 'bom:fg:' + sku, 3600, () =>
//     c.var.DB.prepare('SELECT ...').bind(sku).first()
//   );
//
// Behaviour (2026-07-14 — was block-on-miss, now serve-stale):
//   * Fresh hit (age < ttlSeconds)     → return cached value; no DB round trip.
//   * STALE hit (ttl elapsed, not hard-expired) → return the STALE value
//       IMMEDIATELY and revalidate in the background (waitUntil). The user NEVER
//       blocks on a recompute once the key has ever been warmed — this is what
//       kills the periodic cold-recompute stall (e.g. dashboard/overview's ~7.6s
//       hit once per 60s TTL window). Bounded staleness: the value can be at most
//       `ttlSeconds` old in the normal case (revalidation refreshes it), and at
//       most the hard TTL old in the pathological case where every revalidation
//       fails — after which the key hard-expires in KV and the next read blocks
//       for one fresh recompute.
//   * Miss (never warmed / hard-expired) → block on `fetcher` once, store, return.
//   * Writes → invalidate() deletes the key → next read is a miss → blocks for a
//       fresh value. So post-write freshness is unaffected by serve-stale.
//
// Values are wrapped as { __swr:1, v, soft } (soft = epoch-ms when it goes
// stale). Legacy raw entries (pre-2026-07-14) are treated as stale on first read
// and upgraded to the wrapped form by the background revalidation — no flush
// needed.
// ---------------------------------------------------------------------------
import type { Context } from "hono";
import type { Env } from "../worker";

interface SwrEnvelope<T> {
  __swr: 1;
  v: T;
  soft: number; // epoch ms; value is fresh while Date.now() < soft
}

function isEnvelope<T>(x: unknown): x is SwrEnvelope<T> {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { __swr?: unknown }).__swr === 1 &&
    typeof (x as { soft?: unknown }).soft === "number"
  );
}

// How long KV physically retains an entry past its soft-stale point. Generous
// enough that steady traffic keeps serving stale-then-revalidated data without
// ever blocking, but bounded so a stuck revalidation can't serve ancient data
// forever (after this, the key is gone → one blocking recompute).
function hardTtl(ttlSeconds: number): number {
  return Math.max(ttlSeconds * 6, ttlSeconds + 300);
}

export async function cached<T>(
  c: Context<Env>,
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const kv = c.env.SESSION_CACHE;
  if (!kv) return fetcher();

  const store = async (value: T): Promise<void> => {
    const env: SwrEnvelope<T> = {
      __swr: 1,
      v: value,
      soft: Date.now() + ttlSeconds * 1000,
    };
    await kv.put(key, JSON.stringify(env), {
      expirationTtl: hardTtl(ttlSeconds),
    });
  };
  // Recompute + repersist off the response path. Swallow errors — a failed
  // revalidation just leaves the (still-served) stale value in place until it
  // hard-expires.
  const revalidate = (): void => {
    c.executionCtx?.waitUntil(
      (async () => {
        try {
          await store(await fetcher());
        } catch {
          /* keep serving stale until hard expiry */
        }
      })(),
    );
  };

  const hit = await kv.get(key, { type: "json" });

  if (isEnvelope<T>(hit)) {
    if (Date.now() < hit.soft) return hit.v; // fresh
    revalidate(); // stale → serve now, refresh in background
    return hit.v;
  }

  if (hit !== null) {
    // Legacy raw entry (pre-SWR): serve it as stale + upgrade format in the bg.
    revalidate();
    return hit as T;
  }

  // Cold miss — block once, then persist for everyone after us.
  const value = await fetcher();
  c.executionCtx?.waitUntil(store(value));
  return value;
}

/** Purge one or many keys. Use after writes that invalidate cached reads. */
export async function invalidate(
  c: Context<Env>,
  ...keys: string[]
): Promise<void> {
  const kv = c.env.SESSION_CACHE;
  if (!kv) return;
  await Promise.all(keys.map((k) => kv.delete(k)));
}
