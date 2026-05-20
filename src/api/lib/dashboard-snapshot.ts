// ---------------------------------------------------------------------------
// dashboard-snapshot.ts — read-through cache helper for the dashboard
// overview payload.
//
// Architecture (decided in 2026-05-20 /plan-eng-review, D2 pivoted from
// "incremental in-tx" to "read-through cache" for implementation
// tractability — see docs/AUDIT-BACKLOG-2026-05-20.md):
//
//   Read /api/dashboard/overview:
//     1. SELECT data, built_from FROM dashboard_snapshot WHERE org_id = ?
//     2. Compute fresh MAX(updated_at) across 5 tracked source tables.
//     3. If snapshot exists AND snapshot.built_from >= fresh_max
//        → return data (5ms total).
//     4. Else → fall through to the existing compute path, write the
//        result back to dashboard_snapshot with the fresh_max as
//        built_from, return the data (~200ms one-time, then subsequent
//        reads hit step 3).
//
// Mutations (SO/DO/Invoice/JC/Payment create / update):
//   • No active maintenance. The mutation bumps the source table's
//     updated_at column (via DB trigger or explicit SET updated_at = NOW()
//     already done by every route in the codebase). Next dashboard read
//     sees fresh_max > built_from and re-computes.
//
// Layer 3 — nightly reconciliation:
//   • A GitHub Actions cron (added in a later commit of this PR) calls
//     a forced-rebuild endpoint every 24h at 02:00 SGT. Belt-and-braces
//     in case Layer 2 misses a write (e.g. a hand-crafted UPDATE that
//     forgot to bump updated_at).
//
// Multi-tenant: every row is scoped by org_id (PRIMARY KEY). All four
// functions in this file take an explicit orgId and never read across
// tenants.
// ---------------------------------------------------------------------------

// The 5 source tables whose MAX(updated_at) feeds the Layer 2 freshness
// check. Picked because every dashboard KPI ultimately derives from one
// of them (or from a child table whose parent's updated_at is also
// bumped by the same route). Adding more tables here is safe (the check
// becomes stricter); removing one risks letting a write slip past
// Layer 2.
const TRACKED_TABLES = [
  "sales_orders",
  "delivery_orders",
  "invoices",
  "job_cards",
  "payment_records",
] as const;

export type DashboardSnapshotRow = {
  data: Record<string, unknown>;
  builtFrom: string; // ISO datetime
  builtAt: string;
  refreshCount: number;
};

// ---------------------------------------------------------------------------
// Read the current snapshot row for an org. Returns null if no row exists
// yet (cold cache — caller should compute + write via writeSnapshot).
// ---------------------------------------------------------------------------
export async function readSnapshot(
  db: D1Database,
  orgId: string,
): Promise<DashboardSnapshotRow | null> {
  const row = await db
    .prepare(
      `SELECT data, built_from AS "builtFrom", built_at AS "builtAt",
              refresh_count AS "refreshCount"
         FROM dashboard_snapshot
        WHERE org_id = ?`,
    )
    .bind(orgId)
    .first<{
      data: string;
      builtFrom: string;
      builtAt: string;
      refreshCount: number;
    }>();
  if (!row) return null;
  let parsed: Record<string, unknown>;
  try {
    // D1 stores as TEXT JSON; postgres stores as JSONB which the
    // postgres adapter typically returns as a parsed object. Handle
    // both cases.
    parsed =
      typeof row.data === "string"
        ? (JSON.parse(row.data) as Record<string, unknown>)
        : (row.data as Record<string, unknown>);
  } catch {
    // Corrupted JSON — treat as cold cache.
    return null;
  }
  return {
    data: parsed,
    builtFrom: row.builtFrom,
    builtAt: row.builtAt,
    refreshCount: row.refreshCount ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Compute the cross-table MAX(updated_at). One round-trip via UNION ALL.
//
// Postgres + SQLite both support this shape: the inner UNION ALL emits
// one row per table with its MAX, the outer MAX collapses to a single
// scalar. Empty tables emit NULL which MAX skips.
//
// Returns null if every tracked table is empty (fresh install) — caller
// should treat this as "snapshot is trivially fresh" since there's
// nothing to track.
// ---------------------------------------------------------------------------
export async function getMaxSourceUpdatedAt(
  db: D1Database,
): Promise<string | null> {
  const unionParts = TRACKED_TABLES.map(
    (t) => `SELECT MAX(updated_at) AS t FROM ${t}`,
  ).join(" UNION ALL ");
  const sql = `SELECT MAX(t) AS "maxUpdatedAt" FROM (${unionParts}) sub`;
  const row = await db
    .prepare(sql)
    .first<{ maxUpdatedAt: string | null }>();
  return row?.maxUpdatedAt ?? null;
}

// ---------------------------------------------------------------------------
// Is the snapshot we have fresh enough to serve?
//
// Comparison rule: snapshot is fresh iff snapshot.builtFrom >= currentMax.
// String comparison works because ISO 8601 datetimes are lexicographically
// orderable when the format is consistent (which it is — every route in
// the codebase writes ISO datetimes via toISOString() or datetime('now')).
//
// null currentMax means every tracked table is empty → snapshot is
// trivially fresh (nothing has changed since we built it).
//
// null snapshot input means no cached row at all → caller must compute.
// ---------------------------------------------------------------------------
export function isSnapshotFresh(
  snapshot: DashboardSnapshotRow | null,
  currentMax: string | null,
): boolean {
  if (!snapshot) return false;
  if (!currentMax) return true;
  return snapshot.builtFrom >= currentMax;
}

// ---------------------------------------------------------------------------
// UPSERT the snapshot row for an org. Increments refresh_count by 1 on
// every write so we can monitor how often the cache misses (sudden
// uptick suggests a hot mutation loop bumping updated_at faster than
// reads can settle).
// ---------------------------------------------------------------------------
export async function writeSnapshot(
  db: D1Database,
  orgId: string,
  data: Record<string, unknown>,
  builtFrom: string,
): Promise<void> {
  const dataJson = JSON.stringify(data);
  const builtAt = new Date().toISOString();
  // Postgres ON CONFLICT path. The D1 adapter rewrites ON CONFLICT to
  // SQLite's INSERT OR REPLACE / equivalent — same effective semantics.
  await db
    .prepare(
      `INSERT INTO dashboard_snapshot (org_id, data, built_from, built_at, refresh_count)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (org_id) DO UPDATE
       SET data = EXCLUDED.data,
           built_from = EXCLUDED.built_from,
           built_at = EXCLUDED.built_at,
           refresh_count = dashboard_snapshot.refresh_count + 1`,
    )
    .bind(orgId, dataJson, builtFrom, builtAt)
    .run();
}

// ---------------------------------------------------------------------------
// Explicit invalidation — wipe the row for an org. Use after a mutation
// that you KNOW affects the dashboard but might not have bumped a
// tracked-table updated_at column (e.g. a backfill script, an admin
// override). Layer 2 will re-detect the staleness on the next read and
// compute fresh.
//
// Mutation routes don't normally need to call this — the standard
// `SET updated_at = NOW()` on the source-table UPDATE is enough.
// ---------------------------------------------------------------------------
export async function invalidateSnapshot(
  db: D1Database,
  orgId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM dashboard_snapshot WHERE org_id = ?")
    .bind(orgId)
    .run();
}
