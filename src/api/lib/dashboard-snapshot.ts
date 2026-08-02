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

import {
  getMaxSourceUpdatedAt as probeMaxSourceUpdatedAt,
  getSourceSignature,
} from "./snapshot-freshness";
import { ensureSourceRowsColumn, pickSourceRows } from "./snapshot";

// Source tables whose MAX(updated_at) feeds the Layer 2 freshness check.
//
// Tier C C1 fix 2026-05-21 — expanded from 5 to 17 tables to close
// the correctness gap surfaced in the 2026-05-20 audit. Previously only
// tracked sales_orders / delivery_orders / invoices / job_cards /
// payment_records. But the Dashboard payload also derives from:
//   • working_hour_entries (efficiency ranking, headcount)
//   • cost_ledger          (fabric usage past-30, cost-month KPI)
//   • raw_materials, rm_batches (fabric on-hand)
//   • fg_units, fg_batches (FG inventory)
//   • workers              (active headcount by dept)
//   • customers            (outstanding A/R total)
//   • bom_templates        (next-30 fabric forecast)
//   • sales_order_items, delivery_order_items, invoice_items
//     (per-line aggregations for revenue and outstanding totals)
//
// Direct edits to any of these (admin script tweaks employee hours,
// inventory adjustment, manual cost ledger entry, etc.) used to leave
// the dashboard showing stale numbers for up to 24 hours (until the
// nightly Layer 3 cron force-rebuilt). Now Layer 2 catches them on
// the next read. Adding tables is always safe (stricter freshness);
// removing risks a write slipping past.
const TRACKED_TABLES = [
  // Original 5 — confirmed coverage of all SO/DO/Invoice/JC KPIs.
  "sales_orders",
  "delivery_orders",
  "invoices",
  "job_cards",
  "payment_records",
  // Tier C C1 additions — Dashboard cells these power were stale-
  // tolerant before.
  "sales_order_items",
  "delivery_order_items",
  "invoice_items",
  "working_hour_entries",
  "cost_ledger",
  "raw_materials",
  "rm_batches",
  "fg_units",
  "fg_batches",
  "workers",
  "customers",
  "bom_templates",
] as const;

export type DashboardSnapshotRow = {
  data: Record<string, unknown>;
  builtFrom: string; // ISO datetime
  builtAt: string;
  refreshCount: number;
  /** COUNT(*) across the source tables when built; null = unknown. */
  sourceRows: number | null;
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
      // Star select, and NO schema work on this path — naming a column that may
      // not exist yet, or running DDL per read, is what took production down on
      // 2026-08-02. Returns source_rows when present, omits it when not.
      `SELECT * FROM dashboard_snapshot WHERE org_id = ?`,
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
    builtFrom: (row.builtFrom ?? row.built_from) as string,
    builtAt: (row.builtAt ?? row.built_at) as string,
    refreshCount: Number(row.refreshCount ?? row.refresh_count ?? 0),
    sourceRows: pickSourceRows(row),
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
  // Bug fix 2026-05-21 — delegate to the schema-aware probe. Many
  // TRACKED_TABLES (job_cards, payment_records, *_items, cost_ledger,
  // fg_units, fg_batches, rm_batches, workers, customers, bom_templates)
  // have no `updated_at` column; the old hard-coded MAX(updated_at)
  // errored with `column "updated_at" does not exist` -> HTTP 500.
  return probeMaxSourceUpdatedAt(db, TRACKED_TABLES);
}

// ---------------------------------------------------------------------------
// Is the snapshot we have fresh enough to serve?
//
// Comparison rule: snapshot is fresh iff snapshot.builtFrom >= currentMax.
//
// 2026-05-26 — the "string comparison works because ISO 8601 is
// lexicographically orderable" comment that lived here was a half-truth.
// The pg driver returns TIMESTAMP columns as Date objects, and MAX over
// a TEXT column (e.g. sales_orders.updated_at) as a string. Mixed-type
// `Date >= string` coerces both via ToNumber → string becomes NaN →
// always false → "constant recompute" failure mode. Mixed-format
// strings ("2026-05-22T..." vs "2026-05-22 ...") also lie via
// lexicographic order. Coerce both to numeric timestamps via Date.parse
// so any combo of Date/string/ISO/postgres-format input compares
// chronologically. See snapshot.ts for the full incident writeup.
//
// null currentMax means every tracked table is empty → snapshot is
// trivially fresh (nothing has changed since we built it).
//
// null snapshot input means no cached row at all → caller must compute.
// ---------------------------------------------------------------------------
export function isSnapshotFresh(
  snapshot: DashboardSnapshotRow | null,
  currentMax: string | null,
  /** COUNT(*) now — the only signal that perceives a DELETE. */
  currentRows?: number | null,
): boolean {
  if (!snapshot) return false;
  if (currentRows !== undefined && currentRows !== null) {
    if (snapshot.sourceRows === null) return false;   // pre-column row: rebuild once
    if (snapshot.sourceRows !== currentRows) return false;
  }
  if (!currentMax) return true;
  const builtMs = new Date(snapshot.builtFrom as unknown as string).getTime();
  const currentMs = new Date(currentMax as unknown as string).getTime();
  if (Number.isNaN(builtMs) || Number.isNaN(currentMs)) return false;
  return builtMs >= currentMs;
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
  sourceRows: number | null = null,
): Promise<void> {
  const dataJson = JSON.stringify(data);
  const builtAt = new Date().toISOString();
  // Schema work on the WRITE only — see the read above.
  const withRows = await ensureSourceRowsColumn(db, "dashboard_snapshot");
  // Postgres ON CONFLICT path. The D1 adapter rewrites ON CONFLICT to
  // SQLite's INSERT OR REPLACE / equivalent — same effective semantics.
  await db
    .prepare(
      withRows
        ? `INSERT INTO dashboard_snapshot (org_id, data, built_from, built_at, refresh_count, source_rows)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT (org_id) DO UPDATE
       SET data = EXCLUDED.data,
           built_from = EXCLUDED.built_from,
           built_at = EXCLUDED.built_at,
           source_rows = EXCLUDED.source_rows,
           refresh_count = dashboard_snapshot.refresh_count + 1`
        : `INSERT INTO dashboard_snapshot (org_id, data, built_from, built_at, refresh_count)
       VALUES (?, ?, ?, ?, 1)
       ON CONFLICT (org_id) DO UPDATE
       SET data = EXCLUDED.data,
           built_from = EXCLUDED.built_from,
           built_at = EXCLUDED.built_at,
           refresh_count = dashboard_snapshot.refresh_count + 1`,
    )
    .bind(...(withRows
      ? [orgId, dataJson, builtFrom, builtAt, sourceRows]
      : [orgId, dataJson, builtFrom, builtAt]))
    .run();
}

/** Timestamp AND row count — the count is what sees a DELETE. */
export async function getDashboardSignature(db: D1Database) {
  return getSourceSignature(db, TRACKED_TABLES);
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
