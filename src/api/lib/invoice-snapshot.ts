// ---------------------------------------------------------------------------
// invoice-snapshot.ts — cache-aside read-through for /api/invoices/stats.
//
// Pattern mirrors lib/dashboard-snapshot.ts (PR 1) and lib/delivery-
// snapshot.ts (PR 3). See migrations-postgres/0118_invoice_stats_snapshot.sql
// for the table def and architecture overview.
// ---------------------------------------------------------------------------

type SnapRow = {
  data: Record<string, unknown>;
  builtFrom: string;
  builtAt: string;
  refreshCount: number;
};

const SOURCE_TABLES = ["invoices"] as const;

export async function readInvoiceStatsSnapshot(
  db: D1Database,
  orgId: string,
): Promise<SnapRow | null> {
  const row = await db
    .prepare(
      `SELECT data, built_from AS "builtFrom", built_at AS "builtAt",
              refresh_count AS "refreshCount"
         FROM invoice_stats_snapshot
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

export async function writeInvoiceStatsSnapshot(
  db: D1Database,
  orgId: string,
  data: Record<string, unknown>,
  builtFrom: string,
): Promise<void> {
  const dataJson = JSON.stringify(data);
  const builtAt = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO invoice_stats_snapshot (org_id, data, built_from, built_at, refresh_count)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (org_id) DO UPDATE
       SET data = EXCLUDED.data,
           built_from = EXCLUDED.built_from,
           built_at = EXCLUDED.built_at,
           refresh_count = invoice_stats_snapshot.refresh_count + 1`,
    )
    .bind(orgId, dataJson, builtFrom, builtAt)
    .run();
}

export async function getInvoiceStatsMaxUpdatedAt(
  db: D1Database,
): Promise<string | null> {
  const unionParts = SOURCE_TABLES
    .map((t) => `SELECT MAX(updated_at) AS t FROM ${t}`)
    .join(" UNION ALL ");
  const sql = `SELECT MAX(t) AS "maxUpdatedAt" FROM (${unionParts}) sub`;
  const row = await db
    .prepare(sql)
    .first<{ maxUpdatedAt: string | null }>();
  return row?.maxUpdatedAt ?? null;
}

export function isSnapshotFresh(
  snapshot: SnapRow | null,
  currentMax: string | null,
): boolean {
  if (!snapshot) return false;
  if (!currentMax) return true;
  return snapshot.builtFrom >= currentMax;
}
