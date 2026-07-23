// ---------------------------------------------------------------------------
// po-list-cache.ts — the per-org version key behind the KV cache for
// GET /api/production-orders.
//
// Lives in lib/ (not inside production-orders.ts) because writers OUTSIDE the
// production module also have to invalidate the dept sheets: an SO/CO status
// cascade (ON_HOLD / CANCELLED / RESUME) rewrites production_orders.status for
// every downstream PO, and the operator must see that on the NEXT render, not
// after the 5-minute body TTL expires.
//
// The list endpoint stores its body under a stable KV key with the org version
// in metadata. A read whose metadata version still matches returns X-Cache: HIT
// and never consults the DB — so a writer that skips this bump stays invisible
// for the whole PO_LIST_BODY_TTL_S window even though the snapshot layer was
// wiped. Both layers must be invalidated together (BUG-2026-06-09-005).
// ---------------------------------------------------------------------------
import type { Context } from "hono";
import type { Env } from "../worker";

export async function poListCacheVersion(
  c: Context<Env>,
  orgId: string,
): Promise<string> {
  const kv = c.env.SESSION_CACHE;
  if (!kv) return "0";
  try {
    return (await kv.get(`pos:version:${orgId}`)) ?? "0";
  } catch {
    return "0";
  }
}

/**
 * Invalidate EVERY cached read of GET /api/production-orders for one org:
 *   (1) bump the KV version key so the Layer-1 edge body is skipped, AND
 *   (2) DELETE the Layer-2 dept-sheet snapshot rows so the next read does a
 *       COLD recompute and returns FRESH data.
 *
 * Both layers, always. Doing only the KV bump leaves the snapshot stale for
 * minutes (BUG-2026-06-09-005); doing only the snapshot leaves a warm KV body
 * serving X-Cache: HIT for the rest of its TTL (2026-07-22, the ON_HOLD that
 * the shop floor could not see).
 *
 * Lives here rather than inside production-orders.ts because the writers are
 * spread across six route modules — see
 * tests/production-write-invalidation-class.test.mjs, which enumerates them
 * and fails when a new one forgets. Best-effort by contract: callers own the
 * try/catch, because a failed cache wipe must never roll back a committed
 * business write.
 */
export async function invalidateProductionListCaches(
  c: Context<Env>,
  orgId: string,
): Promise<void> {
  await bumpPoListCacheVersion(c, orgId);
  await c.var.DB
    .prepare(`DELETE FROM production_orders_list_snapshot WHERE org_id = ?`)
    .bind(orgId)
    .run();
}

export async function bumpPoListCacheVersion(
  c: Context<Env>,
  orgId: string,
): Promise<void> {
  const kv = c.env.SESSION_CACHE;
  if (!kv) return;
  const v = String(Date.now());
  // BUG-2026-05-12: original implementation fired the kv.put via waitUntil so
  // the response would return faster, but that meant the operator's NEXT GET
  // (typically <100 ms later when the auto-refresh kicks in or they navigate
  // away + back) could still read the OLD version key, build the OLD cache
  // key, and hit the OLD cached payload — i.e. the date the operator just
  // saved looked "missing". Contributes to the operator-reported "set then
  // gone" symptom. Block on the put to guarantee the very next read sees the
  // new version. KV writes are ~10–30 ms at the writing edge, which is well
  // below the Worker request budget, so the latency cost is acceptable.
  try {
    await kv.put(`pos:version:${orgId}`, v, { expirationTtl: 86400 });
  } catch (err) {
    console.error("[bumpPoListCacheVersion] kv write failed", err);
  }
}
