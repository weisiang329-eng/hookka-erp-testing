// ---------------------------------------------------------------------------
// invoice-snapshot.ts — cache-aside read-through for /api/invoices/stats.
//
// Pattern mirrors lib/dashboard-snapshot.ts (PR 1) and lib/delivery-
// snapshot.ts (PR 3). See migrations-postgres/0118_invoice_stats_snapshot.sql
// for the table def and architecture overview.
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

const SOURCE_TABLES = ["invoices"] as const;

export async function readInvoiceStatsSnapshot(
  db: D1Database,
  orgId: string,
): Promise<SnapRow | null> {
  const row = await db
    .prepare(
      `SELECT * FROM invoice_stats_snapshot
        WHERE org_id = ?`,
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

export async function writeInvoiceStatsSnapshot(
  db: D1Database,
  orgId: string,
  data: Record<string, unknown>,
  builtFrom: string,
  sourceRows: number | null = null,
): Promise<void> {
  const dataJson = JSON.stringify(data);
  const builtAt = new Date().toISOString();
  // Schema work happens on the WRITE only. Doing it on the read is what took
  // production down on 2026-08-02 (DDL on every read, across 31 tables, with
  // the in-flight promise cached across requests).
  const withRows = await ensureSourceRowsColumn(db, "invoice_stats_snapshot");
  await db
    .prepare(
      withRows
        ? `INSERT INTO invoice_stats_snapshot (org_id, data, built_from, built_at, refresh_count, source_rows)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT (org_id) DO UPDATE
       SET data = EXCLUDED.data,
           built_from = EXCLUDED.built_from,
           built_at = EXCLUDED.built_at,
           source_rows = EXCLUDED.source_rows,
           refresh_count = invoice_stats_snapshot.refresh_count + 1`
        : `INSERT INTO invoice_stats_snapshot (org_id, data, built_from, built_at, refresh_count)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (org_id) DO UPDATE
       SET data = EXCLUDED.data,
           built_from = EXCLUDED.built_from,
           built_at = EXCLUDED.built_at,
           refresh_count = invoice_stats_snapshot.refresh_count + 1`,
    )
    .bind(...(withRows
      ? [orgId, dataJson, builtFrom, builtAt, sourceRows]
      : [orgId, dataJson, builtFrom, builtAt]))
    .run();
}

/** Timestamp AND row count — the count is the only signal that sees a DELETE. */
export async function getInvoiceStatsSignature(db: D1Database) {
  return getSourceSignature(db, SOURCE_TABLES);
}

export async function getInvoiceStatsMaxUpdatedAt(
  db: D1Database,
): Promise<string | null> {
  // Bug fix 2026-05-21 — delegate to the schema-aware probe (consistency
  // with the other snapshot helpers; `invoices` has `updated_at` so this
  // endpoint was not among the broken ones, but the shared probe keeps
  // all four helpers on one freshness implementation).
  return getMaxSourceUpdatedAt(db, SOURCE_TABLES);
}

export function isSnapshotFresh(
  snapshot: SnapRow | null,
  currentMax: string | null,
  /** COUNT(*) now. MAX(updated_at) cannot perceive a DELETE; this can. */
  currentRows?: number | null,
): boolean {
  if (!snapshot) return false;
  if (currentRows !== undefined && currentRows !== null) {
    if (snapshot.sourceRows === null) return false;   // pre-column row: rebuild once
    if (snapshot.sourceRows !== currentRows) return false;
  }
  if (!currentMax) return true;
  // Type-aware compare — pg driver returns TIMESTAMP cols as Date and
  // MAX over TEXT cols as string; raw `>=` between mixed types silently
  // misclassifies the snapshot as fresh or stale. See snapshot.ts
  // isSnapshotFresh comment for the full sales-orders incident writeup.
  const builtMs = new Date(snapshot.builtFrom as unknown as string).getTime();
  const currentMs = new Date(currentMax as unknown as string).getTime();
  if (Number.isNaN(builtMs) || Number.isNaN(currentMs)) return false;
  return builtMs >= currentMs;
}
