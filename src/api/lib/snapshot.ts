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

import { getMaxSourceUpdatedAt as probeMaxSourceUpdatedAt } from "./snapshot-freshness";

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
  // Bug fix 2026-05-21 — delegate to the schema-aware probe. Source
  // tables that lack an `updated_at` column (line-item / append-only
  // tables) made the old hard-coded MAX(updated_at) error with
  // `column "updated_at" does not exist` -> HTTP 500.
  return probeMaxSourceUpdatedAt(db, config.sourceTables);
}

// ---------------------------------------------------------------------------
// Comparison rule. Snapshot is fresh iff builtFrom >= currentMax.
//   • null snapshot       → never fresh (cold cache)
//   • null currentMax     → trivially fresh (every source table empty)
//
// Bug fix 2026-05-26 — type-aware compare. The original code did
//   `snapshot.builtFrom >= currentMax`
// and the type annotations claimed both were strings. They are not:
//   • `built_from` is a TIMESTAMP column → pg driver returns Date object.
//   • `currentMax` is MAX(updated_at). Some source tables type updated_at
//     as TEXT (e.g. sales_orders, customers, products, all the old
//     D1→Postgres carry-overs) — MAX(TEXT) returns a string. Other
//     tables type it as TIMESTAMP — MAX returns Date.
// So this comparison was a mix of `Date >= string`, `string >= string`,
// and `Date >= Date` depending on which source table dominated. The
// `Date >= string` path coerces both via ToNumber: Date → epoch ms,
// string → NaN. `x >= NaN` is always false → "never fresh" → snapshot
// computed every request. The `string >= string` path is lexicographic
// — that works ONLY if both strings share the same ISO format. The
// driver formats TIMESTAMP→string as "2026-05-22T12:21:32.000Z" (with
// T+Z) but the TEXT updated_at is written via `new Date().toISOString()`
// which produces the same format... usually. Inconsistent formats =
// silent wrong answer either direction.
//
// Sales-orders bug: snapshot built 2026-05-22 stayed "fresh" against
// MAX(updated_at)=2026-05-26 because Date >= string returned false
// (recompute), but then writeSnapshot received `currentMax` (a string)
// and stored it as TIMESTAMP — and the post-write readback STILL saw the
// snapshot as stale, so it kept recomputing on every request, which
// should have shown the user fresh data. But it didn't. The root
// behaviour was even subtler: `refresh_count` stayed at 1 since
// 2026-05-22, meaning the early-return branch fired. Coercing both to
// numeric timestamps via Date.parse is the only robust answer — works
// for Date objects, ISO strings, and postgres-format strings alike.
// ---------------------------------------------------------------------------
export function isSnapshotFresh(
  snapshot: SnapshotRow | null,
  currentMax: string | null,
): boolean {
  if (!snapshot) return false;
  if (!currentMax) return true;
  // `as unknown` because the type annotations lie — the runtime values
  // may be Date objects (TIMESTAMP cols) or strings (TEXT cols).
  // new Date(Date) and new Date(string) both return a valid Date for
  // any ISO-ish input; .getTime() gives a numeric ms-since-epoch we can
  // safely `>=`. NaN guards the malformed-string case (treat as stale
  // and recompute rather than serve old data).
  const builtMs = new Date(snapshot.builtFrom as unknown as string).getTime();
  const currentMs = new Date(currentMax as unknown as string).getTime();
  if (Number.isNaN(builtMs) || Number.isNaN(currentMs)) return false;
  return builtMs >= currentMs;
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
