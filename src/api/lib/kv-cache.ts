// ---------------------------------------------------------------------------
// KV cache helper — stale-while-revalidate wrapper over Cloudflare KV.
//
// Usage from a route:
//   import { cached } from '../lib/kv-cache';
//   const bom = await cached(c, 'bom:fg:' + sku, 3600, () =>
//     c.var.DB.prepare('SELECT ...').bind(sku).first()
//   );
//
// Behaviour:
//   * Cache hit  → returns cached value immediately; no DB round trip.
//   * Cache miss → runs `fetcher`, writes to KV with TTL (waitUntil — does
//                  NOT block the response).
//   * Writes    → caller must purge the key (invalidate()) to refresh.
// ---------------------------------------------------------------------------
import type { Context } from "hono";
import type { Env } from "../worker";

export async function cached<T>(
  c: Context<Env>,
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  const kv = c.env.SESSION_CACHE;
  if (!kv) return fetcher();

  const hit = await kv.get(key, { type: "json" });
  if (hit !== null) return hit as T;

  const value = await fetcher();
  // Fire-and-forget — the client doesn't wait for the cache write.
  c.executionCtx.waitUntil(
    kv.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds }),
  );
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
