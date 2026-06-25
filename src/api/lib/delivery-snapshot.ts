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

import { getMaxSourceUpdatedAt } from "./snapshot-freshness";

type SnapRow = {
  data: Record<string, unknown>;
  builtFrom: string;
  builtAt: string;
  refreshCount: number;
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
      `SELECT data, built_from AS "builtFrom", built_at AS "builtAt",
              refresh_count AS "refreshCount"
         FROM ${tableName}
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

async function writeGeneric(
  db: D1Database,
  tableName: string,
  orgId: string,
  data: Record<string, unknown>,
  builtFrom: string,
): Promise<void> {
  const dataJson = JSON.stringify(data);
  const builtAt = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO ${tableName} (org_id, data, built_from, built_at, refresh_count)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (org_id) DO UPDATE
       SET data = EXCLUDED.data,
           built_from = EXCLUDED.built_from,
           built_at = EXCLUDED.built_at,
           refresh_count = ${tableName}.refresh_count + 1`,
    )
    .bind(orgId, dataJson, builtFrom, builtAt)
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

function isFresh(snap: SnapRow | null, currentMax: string | null): boolean {
  if (!snap) return false;
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
): Promise<void> {
  return writeGeneric(db, "delivery_stats_snapshot", orgId, data, builtFrom);
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
): Promise<void> {
  return writeGeneric(db, "delivery_po_values_snapshot", orgId, data, builtFrom);
}

export async function getDeliveryPoValuesMaxUpdatedAt(
  db: D1Database,
): Promise<string | null> {
  return getMaxUpdatedAtFor(db, PO_VALUES_SOURCE_TABLES);
}

// Re-exported for clarity at call sites.
export { isFresh as isSnapshotFresh };
