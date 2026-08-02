// ---------------------------------------------------------------------------
// delivery-snapshot.ts — cache-aside read-through for the two heavy
// Delivery Orders endpoints.
//
// Pattern mirrors lib/dashboard-snapshot.ts (PR 1, claude/dashboard-snapshot).
// See migrations-postgres/0124_delivery_snapshots.sql for the table defs
// and the architecture overview.
//
// Two snapshot tables, same shape, different source-table sets for the
// Layer 2 freshness check:
//
//   delivery_stats_snapshot     — derived from delivery_orders only.
//                                  Layer 2 watches just that table.
//
//   delivery_po_values_snapshot — derived from delivery_orders +
//                                  delivery_order_items + sales_orders +
//                                  sales_order_items. Layer 2 watches all 4
//                                  because a price change on any line affects
//                                  the resolver output.
// ---------------------------------------------------------------------------

import { getMaxSourceUpdatedAt, getSourceSignature } from "./snapshot-freshness";
import { ensureSourceRowsColumn, pickSourceRows } from "./snapshot";

type SnapRow = {
  data: Record<string, unknown>;
  builtFrom: string;
  builtAt: string;
  refreshCount: number;
  /** COUNT(*) across the source tables when built; null = unknown. */
  sourceRows: number | null;
};

// Generic single-row reader. Each snapshot table has the same column
// shape so one helper handles all of them.
async function readGeneric(
  db: D1Database,
  tableName: string,
  orgId: string,
): Promise<SnapRow | null> {
  const row = await db
    .prepare(
      // Star select, and NO schema work on this path — naming a column that may
      // not exist yet, or running DDL per read, is what took production down on
      // 2026-08-02. This returns source_rows when present and omits it when not.
      `SELECT * FROM ${tableName} WHERE org_id = ?`,
    )
    .bind(orgId)
    .first<Record<string, unknown> & {
      data: string;
      builtFrom?: string;
      built_from?: string;
      builtAt?: string;
      built_at?: string;
      refreshCount?: number;
      refresh_count?: number;
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
    builtFrom: (row.builtFrom ?? row.built_from) as string,
    builtAt: (row.builtAt ?? row.built_at) as string,
    refreshCount: Number(row.refreshCount ?? row.refresh_count ?? 0),
    sourceRows: pickSourceRows(row),
  };
}

async function writeGeneric(
  db: D1Database,
  tableName: string,
  orgId: string,
  data: Record<string, unknown>,
  builtFrom: string,
  sourceRows: number | null = null,
): Promise<void> {
  const dataJson = JSON.stringify(data);
  const builtAt = new Date().toISOString();
  // Schema work on the WRITE only — see the read above.
  const withRows = await ensureSourceRowsColumn(db, tableName);
  await db
    .prepare(
      withRows
        ? `INSERT INTO ${tableName} (org_id, data, built_from, built_at, refresh_count, source_rows)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT (org_id) DO UPDATE
       SET data = EXCLUDED.data,
           built_from = EXCLUDED.built_from,
           built_at = EXCLUDED.built_at,
           source_rows = EXCLUDED.source_rows,
           refresh_count = ${tableName}.refresh_count + 1`
        : `INSERT INTO ${tableName} (org_id, data, built_from, built_at, refresh_count)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (org_id) DO UPDATE
       SET data = EXCLUDED.data,
           built_from = EXCLUDED.built_from,
           built_at = EXCLUDED.built_at,
           refresh_count = ${tableName}.refresh_count + 1`,
    )
    .bind(...(withRows
      ? [orgId, dataJson, builtFrom, builtAt, sourceRows]
      : [orgId, dataJson, builtFrom, builtAt]))
    .run();
}

async function getMaxUpdatedAtFor(
  db: D1Database,
  tables: readonly string[],
): Promise<string | null> {
  // Bug fix 2026-05-21 — delegate to the schema-aware probe.
  // delivery_order_items / sales_order_items have no `updated_at`
  // column; the old hard-coded MAX(updated_at) errored with
  // `column "updated_at" does not exist` -> HTTP 500 on po-values.
  return getMaxSourceUpdatedAt(db, tables);
}

function isFresh(
  snap: SnapRow | null,
  currentMax: string | null,
  /** COUNT(*) now — the only signal that perceives a DELETE. */
  currentRows?: number | null,
): boolean {
  if (!snap) return false;
  if (currentRows !== undefined && currentRows !== null) {
    if (snap.sourceRows === null) return false;   // pre-column row: rebuild once
    if (snap.sourceRows !== currentRows) return false;
  }
  if (!currentMax) return true;
  // Type-aware compare — see snapshot.ts isSnapshotFresh comment for the
  // full rationale. pg driver returns TIMESTAMP cols as Date, MAX over
  // TEXT cols as string; raw `>=` between mixed types silently lies.
  const builtMs = new Date(snap.builtFrom as unknown as string).getTime();
  const currentMs = new Date(currentMax as unknown as string).getTime();
  if (Number.isNaN(builtMs) || Number.isNaN(currentMs)) return false;
  return builtMs >= currentMs;
}

// ============================================================================
// delivery_stats_snapshot — caches /api/delivery-orders/stats
// ============================================================================

const STATS_SOURCE_TABLES = ["delivery_orders"] as const;

export async function readDeliveryStatsSnapshot(
  db: D1Database,
  orgId: string,
): Promise<SnapRow | null> {
  return readGeneric(db, "delivery_stats_snapshot", orgId);
}

export async function writeDeliveryStatsSnapshot(
  db: D1Database,
  orgId: string,
  data: Record<string, unknown>,
  builtFrom: string,
  sourceRows: number | null = null,
): Promise<void> {
  return writeGeneric(db, "delivery_stats_snapshot", orgId, data, builtFrom, sourceRows);
}

export async function getDeliveryStatsMaxUpdatedAt(
  db: D1Database,
): Promise<string | null> {
  return getMaxUpdatedAtFor(db, STATS_SOURCE_TABLES);
}

// ============================================================================
// delivery_po_values_snapshot — caches /api/delivery-orders/po-values
// ============================================================================

const PO_VALUES_SOURCE_TABLES = [
  "delivery_orders",
  "delivery_order_items",
  "sales_orders",
  "sales_order_items",
] as const;

export async function readDeliveryPoValuesSnapshot(
  db: D1Database,
  orgId: string,
): Promise<SnapRow | null> {
  return readGeneric(db, "delivery_po_values_snapshot", orgId);
}

export async function writeDeliveryPoValuesSnapshot(
  db: D1Database,
  orgId: string,
  data: Record<string, unknown>,
  builtFrom: string,
  sourceRows: number | null = null,
): Promise<void> {
  return writeGeneric(db, "delivery_po_values_snapshot", orgId, data, builtFrom, sourceRows);
}

export async function getDeliveryPoValuesMaxUpdatedAt(
  db: D1Database,
): Promise<string | null> {
  return getMaxUpdatedAtFor(db, PO_VALUES_SOURCE_TABLES);
}

// Re-exported for clarity at call sites.
export { isFresh as isSnapshotFresh };

// ---------------------------------------------------------------------------
// Freshness SIGNATURE — timestamp AND row count.
//
// MAX(updated_at) cannot perceive a DELETE: removing rows never raises a
// maximum, so a snapshot holding a deleted delivery order stayed "fresh"
// indefinitely. Declared after the source-table lists so they are in scope.
// ---------------------------------------------------------------------------
export async function getDeliveryStatsSignature(db: D1Database) {
  return getSourceSignature(db, STATS_SOURCE_TABLES);
}

export async function getDeliveryPoValuesSignature(db: D1Database) {
  return getSourceSignature(db, PO_VALUES_SOURCE_TABLES);
}
