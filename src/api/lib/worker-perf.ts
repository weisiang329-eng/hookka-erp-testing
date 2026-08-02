// ---------------------------------------------------------------------------
// worker-perf.ts — speed-up helpers for the worker portal's two heaviest reads
// (GET /api/worker/history + GET /api/worker/payslips, both of which run
// computeMonthlyEfficiencyByWorker).
//
// Three concerns live here, all ADDITIVE (no behaviour change for fresh data —
// the snapshot result is byte-identical to the live compute):
//
//   1. ensureWorkerPerfIndices / ensureWorkerSnapshotTables — runtime
//      self-apply of the 0197/0198/0199 migrations (Hookka deploys do NOT
//      replay migration files; tables + indices reach prod ONLY via these
//      CREATE … IF NOT EXISTS, memoized per isolate). Mirrors the
//      ensureNonprodRequests pattern already in worker.ts.
//
//   2. memoizedMonthlyEfficiency — a tiny short-TTL in-isolate memo keyed by
//      from:to so that /history and /payslips (and rapid re-fetches within a
//      worker's session) don't recompute the SAME range twice. The formula is
//      untouched — this only caches its OUTPUT for a few seconds. Long enough
//      to collapse a session's burst, short enough that a just-keyed edit is
//      visible almost immediately (and the page-level snapshots below carry the
//      real freshness contract anyway).
//
//   3. readWorkerSnapshot / withWorkerSnapshot — cache-aside read-through for
//      the /payslips and /history payloads, mirroring lib/snapshot.ts +
//      production_orders_list_snapshot. Lazy recompute-on-READ (never
//      eager-on-write): a freshness probe (MAX updated_at/created_at across the
//      configured source tables) decides whether to serve the snapshot or
//      rebuild. nightly-wipe philosophy carries from the shared snapshot layer.
// ---------------------------------------------------------------------------

import { getSourceSignature } from "./snapshot-freshness";
import { ensureSourceRowsColumn, pickSourceRows } from "./snapshot";
import {
  computeMonthlyEfficiencyByWorker,
  type WorkerMonthlyEfficiency,
} from "./efficiency-allowance";
import { loadActiveBomRows, type BomRow } from "./wip-times-core";

// D1-compat shape (matches the SupabaseAdapter installed as c.var.DB).
type DbLike = D1Database;

// ───────────────────────── 1. runtime self-apply ─────────────────────────

let _perfIndicesMig: Promise<void> | null = null;
/**
 * Self-apply the worker-portal perf indices (migration 0197). Memoized per
 * isolate; awaited at the top of /history + /payslips. CREATE INDEX IF NOT
 * EXISTS is a no-op once present, so this is cheap on the warm path.
 *
 * Columns are the REAL snake_case schema names (the route SQL uses camelCase
 * which db-pg rewrites; the physical columns are snake_case per 0001_init).
 *   • job_cards(completed_date)              — efficiency / completed scan.
 *   • attendance_records(employee_id, date)  — /history's combined predicate.
 * piece_pics(job_card_id) is NOT added here — idx_piece_pics_jc already covers
 * it (verified against 0001_init.sql).
 */
export function ensureWorkerPerfIndices(db: DbLike): Promise<void> {
  if (_perfIndicesMig) return _perfIndicesMig;
  _perfIndicesMig = (async () => {
    await db
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_job_cards_completed_date ON job_cards (completed_date)",
      )
      .run();
    await db
      .prepare(
        "CREATE INDEX IF NOT EXISTS idx_attendance_employee_date ON attendance_records (employee_id, date)",
      )
      .run();
  })();
  return _perfIndicesMig;
}

let _snapTablesMig: Promise<void> | null = null;
/**
 * Self-apply the two worker-portal snapshot tables (migrations 0198 + 0199).
 * Memoized per isolate; awaited before the first snapshot read. Types match the
 * Postgres twins (JSONB data, TIMESTAMP built_from/built_at). On the SQLite
 * d1-compat path these map cleanly (TEXT/timestamp), same as every other
 * snapshot table.
 */
export function ensureWorkerSnapshotTables(db: DbLike): Promise<void> {
  if (_snapTablesMig) return _snapTablesMig;
  _snapTablesMig = (async () => {
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS worker_payslips_snapshot (
           org_id        TEXT NOT NULL,
           cache_key     TEXT NOT NULL DEFAULT '',
           data          JSONB NOT NULL,
           built_from    TIMESTAMP NOT NULL,
           built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
           refresh_count INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (org_id, cache_key)
         )`,
      )
      .run();
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS worker_history_snapshot (
           org_id        TEXT NOT NULL,
           cache_key     TEXT NOT NULL DEFAULT '',
           data          JSONB NOT NULL,
           built_from    TIMESTAMP NOT NULL,
           built_at      TIMESTAMP NOT NULL DEFAULT NOW(),
           refresh_count INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (org_id, cache_key)
         )`,
      )
      .run();
  })();
  return _snapTablesMig;
}

// ──────────────────── 2. short-TTL efficiency dedup memo ────────────────────

// Module-global (per-isolate) memo. An isolate routinely serves a burst of a
// worker's requests (open My-Pay, swipe to History, change the range); this
// collapses the duplicate computeMonthlyEfficiencyByWorker calls for the SAME
// [from,to] into one. TTL is deliberately short so a freshly-keyed edit is
// visible almost immediately — the page snapshots own the real freshness probe.
const EFF_MEMO_TTL_MS = 5_000;
const effMemo = new Map<
  string,
  { at: number; p: Promise<Map<string, WorkerMonthlyEfficiency>> }
>();

/**
 * computeMonthlyEfficiencyByWorker, memoized by from:to for EFF_MEMO_TTL_MS.
 * Returns the SAME Map the underlying helper does — callers only ever READ it
 * (look up their own worker), so sharing one immutable result is safe. The
 * formula is unchanged; this only avoids recomputing the identical range twice
 * in quick succession (within a request and across a session's burst).
 */
export function memoizedMonthlyEfficiency(
  db: DbLike,
  from: string,
  to: string,
): Promise<Map<string, WorkerMonthlyEfficiency>> {
  const key = `${from}:${to}`;
  const now = Date.now();
  const hit = effMemo.get(key);
  if (hit && now - hit.at < EFF_MEMO_TTL_MS) return hit.p;
  const p = computeMonthlyEfficiencyByWorker(db, from, to);
  effMemo.set(key, { at: now, p });
  // Drop the entry if the compute rejects so a transient failure isn't pinned
  // for the whole TTL.
  void p.catch(() => {
    const cur = effMemo.get(key);
    if (cur && cur.p === p) effMemo.delete(key);
  });
  return p;
}

// ──────────────── 2b. org-agnostic ACTIVE-BOM rows memo (wip-times) ─────────

// GET /api/worker/wip-times runs loadActiveBomRows(db, null, null) — a whole-
// table ACTIVE-BOM × products read — on every open and on every dept-selector
// switch. The rows are identical across workers and dept switches (the dept
// filter happens AFTER the load, in aggregateWipTimes), so a worker flipping
// between their departments re-reads the same rows repeatedly. Memoize the
// org-agnostic load for a short TTL so a session's burst collapses to one read.
// BOMs change rarely; the short TTL keeps a just-edited standard time visible
// within a few seconds.
const BOM_MEMO_TTL_MS = 15_000;
let bomMemo: { at: number; p: Promise<BomRow[]> } | null = null;

/**
 * loadActiveBomRows(db, null, null), memoized per isolate for BOM_MEMO_TTL_MS.
 * Only the org-agnostic (worker-portal) variant is memoized — the dashboard
 * passes a real orgId and keeps its own uncached path.
 */
export function loadActiveBomRowsMemoized(db: DbLike): Promise<BomRow[]> {
  const now = Date.now();
  if (bomMemo && now - bomMemo.at < BOM_MEMO_TTL_MS) return bomMemo.p;
  const p = loadActiveBomRows(db, null, null);
  bomMemo = { at: now, p };
  void p.catch(() => {
    if (bomMemo && bomMemo.p === p) bomMemo = null;
  });
  return p;
}

// ─────────────────── 3. cache-aside snapshot read-through ───────────────────

type SnapRow = {
  data: Record<string, unknown>;
  builtFrom: string;
  /** COUNT(*) across the source tables when built; null = unknown. */
  sourceRows: number | null;
};

async function readWorkerSnapshot(
  db: DbLike,
  tableName: string,
  orgId: string,
  cacheKey: string,
): Promise<SnapRow | null> {
  const row = await db
    .prepare(
      // Star select + no schema work on the read — see lib/snapshot.ts.
      `SELECT * FROM ${tableName} WHERE org_id = ? AND cache_key = ?`,
    )
    .bind(orgId, cacheKey)
    .first<Record<string, unknown> & { data: string; builtFrom?: string; built_from?: string }>();
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
    sourceRows: pickSourceRows(row),
  };
}

async function writeWorkerSnapshot(
  db: DbLike,
  tableName: string,
  orgId: string,
  cacheKey: string,
  data: Record<string, unknown>,
  builtFrom: string,
  sourceRows: number | null = null,
): Promise<void> {
  // Schema work on the WRITE only.
  const withRows = await ensureSourceRowsColumn(db as never, tableName);
  await db
    .prepare(
      withRows
        ? `INSERT INTO ${tableName} (org_id, cache_key, data, built_from, built_at, refresh_count, source_rows)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (org_id, cache_key) DO UPDATE
       SET data = EXCLUDED.data,
           built_from = EXCLUDED.built_from,
           built_at = EXCLUDED.built_at,
           source_rows = EXCLUDED.source_rows,
           refresh_count = ${tableName}.refresh_count + 1`
        : `INSERT INTO ${tableName} (org_id, cache_key, data, built_from, built_at, refresh_count)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT (org_id, cache_key) DO UPDATE
       SET data = EXCLUDED.data,
           built_from = EXCLUDED.built_from,
           built_at = EXCLUDED.built_at,
           refresh_count = ${tableName}.refresh_count + 1`,
    )
    .bind(...(withRows
      ? [orgId, cacheKey, JSON.stringify(data), builtFrom, new Date().toISOString(), sourceRows]
      : [orgId, cacheKey, JSON.stringify(data), builtFrom, new Date().toISOString()]))
    .run();
}

// Type-aware freshness compare — pg returns TIMESTAMP cols as Date and MAX over
// TEXT cols as string; parse both to ms before comparing. (Same rule as
// lib/snapshot.ts isSnapshotFresh — see that file for the incident writeup.)
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
  const builtMs = new Date(snap.builtFrom as unknown as string).getTime();
  const currentMs = new Date(currentMax as unknown as string).getTime();
  if (Number.isNaN(builtMs) || Number.isNaN(currentMs)) return false;
  return builtMs >= currentMs;
}

/**
 * Cache-aside read-through for a worker-portal payload.
 *
 * Serves the stored snapshot when its built_from is at-or-after the current
 * MAX(freshness col) across `sourceTables`; otherwise calls computeFresh(),
 * writes the result back (best-effort — a write-back failure never fails the
 * request) and returns it. Lazy recompute-on-READ; no eager-on-write path.
 *
 * The snapshot result is byte-identical to the live compute, so this is purely
 * a latency optimisation — correctness is unchanged.
 */
export async function withWorkerSnapshot<T extends Record<string, unknown>>(
  db: DbLike,
  opts: {
    tableName: string;
    sourceTables: readonly string[];
    orgId: string;
    cacheKey: string;
  },
  computeFresh: () => Promise<T>,
): Promise<T> {
  const [snap, sig] = await Promise.all([
    readWorkerSnapshot(db, opts.tableName, opts.orgId, opts.cacheKey),
    getSourceSignature(db as never, opts.sourceTables),
  ]);
  const currentMax = sig.maxUpdatedAt;
  if (isFresh(snap, currentMax, sig.rowCount) && snap) {
    return snap.data as T;
  }
  const data = await computeFresh();
  try {
    await writeWorkerSnapshot(
      db,
      opts.tableName,
      opts.orgId,
      opts.cacheKey,
      data,
      currentMax ?? new Date().toISOString(),
      sig.rowCount,
    );
  } catch (e) {
    console.warn(`[${opts.tableName}] write-back failed:`, e);
  }
  return data;
}
