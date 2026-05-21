// ---------------------------------------------------------------------------
// snapshot.ts — Generic cache-aside snapshot helper.
//
// Single library used by every snapshot-ized endpoint (sales-orders/stats,
// invoice/stats, dashboard/overview, accounting/aging, etc.). Each caller
// constructs a SnapshotConfig with its specific table name and source-table
// list, then calls `withSnapshot()` which handles the entire read-through
// + write-back lifecycle.
//
// Architecture (cache-aside, write-back-on-miss):
//
//   Read flow inside withSnapshot():
//     1. SELECT snapshot row + cross-table MAX(updated_at) in parallel.
//     2. If snapshot row exists AND built_from >= currentMax → return data.
//     3. Else call computeFresh(), UPSERT the result into the snapshot
//        table with built_from = currentMax, return the data.
//
//   Mutations: no active maintenance. Source-table writes bump their own
//   updated_at column (existing convention in every Hookka route);
//   Layer 2 picks up the bump on the next read.
//
//   Layer 3: nightly cron (per-snapshot) wipes the row, forcing a
//   recompute. Belt-and-braces against any write that skipped updated_at.
//
// Per the 2026-05-20 /plan-eng-review D2 pivot — see the AUDIT-BACKLOG
// file for the rationale (incremental-in-tx was too expensive to
// implement; cache-aside achieves the same user-visible behaviour).
// ---------------------------------------------------------------------------

export type SnapshotConfig = {
  /** Snapshot table name, e.g. "invoice_stats_snapshot". */
  tableName: string;
  /** Tables whose MAX(updated_at) collectively determines snapshot freshness. */
  sourceTables: readonly string[];
};

export type SnapshotRow = {
  data: Record<string, unknown>;
  builtFrom: string;
  builtAt: string;
  refreshCount: number;
};

// ---------------------------------------------------------------------------
// Read a single snapshot row. Returns null if missing or unparseable.
// cacheKey defaults to '' for param-less endpoints.
// ---------------------------------------------------------------------------
export async function readSnapshot(
  db: D1Database,
  config: SnapshotConfig,
  orgId: string,
  cacheKey: string = "",
): Promise<SnapshotRow | null> {
  const row = await db
    .prepare(
      `SELECT data, built_from AS "builtFrom", built_at AS "builtAt",
              refresh_count AS "refreshCount"
         FROM ${config.tableName}
        WHERE org_id = ? AND cache_key = ?`,
    )
    .bind(orgId, cacheKey)
    .first<{
      data: string;
      builtFrom: string;
      builtAt: string;
      refreshCount: number;
    }>();
  if (!row) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed =
      typeof row.data === "string"
        ? (JSON.parse(row.data) as Record<string, unknown>)
        : (row.data as Record<string, unknown>);
  } catch {
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
// Write or update a snapshot row. Increments refresh_count on every write.
// ---------------------------------------------------------------------------
export async function writeSnapshot(
  db: D1Database,
  config: SnapshotConfig,
  orgId: string,
  data: Record<string, unknown>,
  builtFrom: string,
  cacheKey: string = "",
): Promise<void> {
  const dataJson = JSON.stringify(data);
  const builtAt = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO ${config.tableName} (org_id, cache_key, data, built_from, built_at, refresh_count)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT (org_id, cache_key) DO UPDATE
       SET data = EXCLUDED.data,
           built_from = EXCLUDED.built_from,
           built_at = EXCLUDED.built_at,
           refresh_count = ${config.tableName}.refresh_count + 1`,
    )
    .bind(orgId, cacheKey, dataJson, builtFrom, builtAt)
    .run();
}

// ---------------------------------------------------------------------------
// Compute the cross-table MAX(updated_at) for the config's source tables.
// One round-trip via UNION ALL. Returns null if every source table is empty.
// ---------------------------------------------------------------------------
export async function getMaxSourceUpdatedAt(
  db: D1Database,
  config: SnapshotConfig,
): Promise<string | null> {
  const unionParts = config.sourceTables
    .map((t) => `SELECT MAX(updated_at) AS t FROM ${t}`)
    .join(" UNION ALL ");
  const sql = `SELECT MAX(t) AS "maxUpdatedAt" FROM (${unionParts}) sub`;
  const row = await db
    .prepare(sql)
    .first<{ maxUpdatedAt: string | null }>();
  return row?.maxUpdatedAt ?? null;
}

// ---------------------------------------------------------------------------
// Comparison rule. Snapshot is fresh iff builtFrom >= currentMax.
//   • null snapshot       → never fresh (cold cache)
//   • null currentMax     → trivially fresh (every source table empty)
//   • lexicographic compare on ISO-8601 strings works as numeric compare.
// ---------------------------------------------------------------------------
export function isSnapshotFresh(
  snapshot: SnapshotRow | null,
  currentMax: string | null,
): boolean {
  if (!snapshot) return false;
  if (!currentMax) return true;
  return snapshot.builtFrom >= currentMax;
}

// ---------------------------------------------------------------------------
// High-level wrapper — the only function endpoint handlers normally need.
//
// Returns the payload. If the snapshot is fresh, returns the cached
// data (5ms). If stale, calls computeFresh(), writes the result back
// (best-effort; errors swallowed), and returns the fresh data.
//
// Write-back failures are logged but don't propagate — the caller's
// computed payload is still returned. The cache is a perf optimisation,
// not load-bearing.
// ---------------------------------------------------------------------------
export async function withSnapshot<T extends Record<string, unknown>>(
  db: D1Database,
  config: SnapshotConfig,
  orgId: string,
  computeFresh: () => Promise<T>,
  cacheKey: string = "",
): Promise<T> {
  const [snap, currentMax] = await Promise.all([
    readSnapshot(db, config, orgId, cacheKey),
    getMaxSourceUpdatedAt(db, config),
  ]);
  if (isSnapshotFresh(snap, currentMax) && snap) {
    return snap.data as T;
  }
  const data = await computeFresh();
  try {
    await writeSnapshot(
      db,
      config,
      orgId,
      data,
      currentMax ?? new Date().toISOString(),
      cacheKey,
    );
  } catch (e) {
    console.warn(`[${config.tableName}] write-back failed:`, e);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Explicit invalidation. Used by admin scripts that bypass the standard
// updated_at bump (rare). Layer 2 normally handles invalidation
// automatically; this is a force-clear escape hatch.
// ---------------------------------------------------------------------------
export async function invalidateSnapshot(
  db: D1Database,
  config: SnapshotConfig,
  orgId: string,
  cacheKey?: string,
): Promise<void> {
  if (cacheKey === undefined) {
    // Wipe every cache_key row for this org.
    await db
      .prepare(`DELETE FROM ${config.tableName} WHERE org_id = ?`)
      .bind(orgId)
      .run();
  } else {
    await db
      .prepare(
        `DELETE FROM ${config.tableName} WHERE org_id = ? AND cache_key = ?`,
      )
      .bind(orgId, cacheKey)
      .run();
  }
}
