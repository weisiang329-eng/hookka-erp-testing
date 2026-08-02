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

import {
  getMaxSourceUpdatedAt as probeMaxSourceUpdatedAt,
  getSourceSignature,
} from "./snapshot-freshness";

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
  /**
   * COUNT(*) across the source tables when this row was built, or null when the
   * column does not exist yet / could not be read. Null means "unknown", which
   * isSnapshotFresh treats as stale-once rather than as a match.
   */
  sourceRows: number | null;
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
  // `SELECT *`, ON PURPOSE, and NO migration call on this path.
  //
  // v1 of this fix named source_rows explicitly and ran the runtime ALTER here.
  // Every snapshot read then performed DDL, on 31 tables, and cached the
  // in-flight promise across requests — which db-pg.ts warns in capitals must
  // never happen ("Cannot perform I/O on behalf of a different request").
  // /api/sales-orders, its stats and overdue-counts all 500'd from the moment
  // it deployed, and because Workers aborts the whole request for that class of
  // error, the try/catch added afterwards could not save it either.
  //
  // A star select needs neither. It returns source_rows when the column exists
  // and simply omits it when it does not, so reads keep working before, during
  // and after the column appears — and the read path does no schema work at all.
  const row = await db
    .prepare(
      `SELECT * FROM ${config.tableName} WHERE org_id = ? AND cache_key = ?`,
    )
    .bind(orgId, cacheKey)
    .first<{
      data: string;
      builtFrom?: string;
      built_from?: string;
      builtAt?: string;
      built_at?: string;
      refreshCount?: number;
      refresh_count?: number;
      sourceRows?: number | string | null;
      source_rows?: number | string | null;
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
  // Dual-keyed: db-pg's columnFrom camelCases what it returns, but a star
  // select through other paths can hand back the raw snake_case names. Reading
  // only one form is the repo's most-repeated bug.
  const rawRows = row.sourceRows ?? row.source_rows ?? null;
  return {
    data: parsed,
    builtFrom: (row.builtFrom ?? row.built_from) as string,
    builtAt: (row.builtAt ?? row.built_at) as string,
    refreshCount: Number(row.refreshCount ?? row.refresh_count ?? 0),
    sourceRows: rawRows === null || rawRows === undefined ? null : Number(rawRows),
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
  sourceRows: number | null = null,
): Promise<void> {
  const dataJson = JSON.stringify(data);
  const builtAt = new Date().toISOString();
  // Schema work happens HERE and nowhere else. A rebuild is rare (the whole
  // point of a snapshot) whereas reads are constant, so this is the one place
  // where a once-per-isolate ALTER costs nothing and risks little — and a
  // failure here is already tolerated by the caller.
  const withRows = await ensureSourceRowsColumn(db, config.tableName);
  const cols = withRows
    ? "(org_id, cache_key, data, built_from, built_at, refresh_count, source_rows)"
    : "(org_id, cache_key, data, built_from, built_at, refresh_count)";
  const vals = withRows ? "(?, ?, ?, ?, ?, 1, ?)" : "(?, ?, ?, ?, ?, 1)";
  const setRows = withRows ? "\n           source_rows = EXCLUDED.source_rows," : "";
  const binds: unknown[] = [orgId, cacheKey, dataJson, builtFrom, builtAt];
  if (withRows) binds.push(sourceRows);
  await db
    .prepare(
      `INSERT INTO ${config.tableName} ${cols}
       VALUES ${vals}
       ON CONFLICT (org_id, cache_key) DO UPDATE
       SET data = EXCLUDED.data,
           built_from = EXCLUDED.built_from,
           built_at = EXCLUDED.built_at,${setRows}
           refresh_count = ${config.tableName}.refresh_count + 1`,
    )
    .bind(...binds)
    .run();
}

// ---------------------------------------------------------------------------
// Add source_rows to one snapshot table. Returns whether the column can be used.
//
// The cache is a Set of TABLE NAMES — plain data with no I/O identity. v1
// cached the in-flight Promise instead, which is exactly what db-pg.ts forbids
// ("MUST NOT be cached across requests… Cannot perform I/O on behalf of a
// different request") and is the most likely reason it took production down:
// a second request awaiting the first request's socket. A Set cannot do that.
//
// Failure is NOT fatal and NOT silent. The real driver message is logged — the
// generic 500 body is precisely what stopped me diagnosing v1 — and the caller
// writes the old column list instead, so the snapshot keeps working exactly as
// it did before this feature existed.
// ---------------------------------------------------------------------------
const _rowsColReady = new Set<string>();
const _rowsColFailed = new Set<string>();
export async function ensureSourceRowsColumn(
  db: D1Database,
  tableName: string,
): Promise<boolean> {
  if (_rowsColReady.has(tableName)) return true;
  if (_rowsColFailed.has(tableName)) return false;
  try {
    await db
      .prepare(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS source_rows BIGINT`)
      .run();
    _rowsColReady.add(tableName);
    return true;
  } catch (e) {
    _rowsColFailed.add(tableName);
    console.error(
      `[snapshot] ${tableName}: could not add source_rows — delete-detection is OFF for this table. ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return false;
  }
}

/** For tests — drop the per-table migration cache. */
export function _resetSourceRowsMigForTests(): void {
  _rowsColReady.clear();
  _rowsColFailed.clear();
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
  /**
   * COUNT(*) across the source tables right now.
   *
   * MAX(updated_at) CANNOT SEE A DELETE — removing rows never raises a maximum.
   * Measured on production 2026-08-02: 0 draft sales orders in the database,
   * two of them still being served, because the last edit was the previous day
   * and built_from was newer than MAX. It would have stayed wrong forever.
   *
   * undefined = caller opted out; null = could not be counted. Both skip the
   * check and fall back to the timestamp-only rule, never to "always stale".
   */
  currentRows?: number | null,
): boolean {
  if (!snapshot) return false;
  // Checked FIRST: it is the only signal that perceives a deletion. A snapshot
  // written before the column existed has sourceRows null — stale exactly once,
  // then it rebuilds and carries the count from then on. No backfill needed.
  if (currentRows !== undefined && currentRows !== null) {
    if (snapshot.sourceRows === null) return false;
    if (snapshot.sourceRows !== currentRows) return false;
  }
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
// In-isolate single-flight registry (stampede protection).
//
// When several requests all find the snapshot stale/cold for the SAME
// (table, org, cacheKey) at once, only ONE runs computeFresh(); the others
// await its result. This flattens the "five operators open the same dept
// sheet at the same moment" spike that would otherwise fire five simultaneous
// full recomputes at the DB — the overload ("爆") case. Scope is the Worker
// isolate (module-global Map); best-effort across isolates, which is plenty at
// our scale — an isolate routinely serves a burst of concurrent requests, and
// that is exactly where a stampede would form.
// ---------------------------------------------------------------------------
const inFlightComputes = new Map<string, Promise<Record<string, unknown>>>();

function flightKey(tableName: string, orgId: string, cacheKey: string): string {
  return `${tableName}::${orgId}::${cacheKey}`;
}

// computeFresh() + write-back, single-flighted by flightKey. Concurrent callers
// share one in-flight promise; the entry clears when it settles.
async function computeAndStore<T extends Record<string, unknown>>(
  db: D1Database,
  config: SnapshotConfig,
  orgId: string,
  computeFresh: () => Promise<T>,
  cacheKey: string,
  currentMax: string | null,
  sourceRows: number | null,
): Promise<T> {
  const key = flightKey(config.tableName, orgId, cacheKey);
  const existing = inFlightComputes.get(key);
  if (existing) return existing as Promise<T>;
  const p = (async () => {
    const data = await computeFresh();
    try {
      await writeSnapshot(
        db,
        config,
        orgId,
        data,
        currentMax ?? new Date().toISOString(),
        cacheKey,
        sourceRows,
      );
    } catch (e) {
      console.warn(`[${config.tableName}] write-back failed:`, e);
    }
    return data;
  })();
  inFlightComputes.set(key, p as Promise<Record<string, unknown>>);
  void p.finally(() => {
    inFlightComputes.delete(key);
  });
  return p;
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
  // Optional Hono context. Two uses, both backwards-compatible (no-op when
  // omitted): (1) emit cache.hit / cache.miss counters to Analytics Engine;
  // (2) `executionCtx.waitUntil` powers the serve-stale background refresh
  // below. The `executionCtx` getter throws outside a Worker isolate (tests,
  // local node), so we read it via optional chaining — those paths simply
  // fall back to a synchronous recompute.
  c?: {
    env: unknown;
    executionCtx?: { waitUntil(p: Promise<unknown>): void };
  },
  opts?: {
    // Serve-stale-while-revalidate. When the snapshot is stale BUT a prior
    // copy exists, return that copy immediately and refresh in the background
    // (needs a Worker runtime for waitUntil). Removes the ~2-3s recompute wait
    // from the read path — the lag ("卡") case. Opt-in per endpoint, so the
    // brief one-revalidation staleness is only accepted where it's fine
    // (production sheets, dashboards). Cold (no prior copy) still computes
    // synchronously — we can't serve nothing.
    staleWhileRevalidate?: boolean;
    // Fired once after a background revalidation writes fresh data. The
    // production list uses it to bump its KV-layer version so the edge cache
    // stops serving the stale body it cached during the SWR window.
    onRevalidated?: () => void | Promise<void>;
  },
): Promise<T> {
  const [snap, signature] = await Promise.all([
    readSnapshot(db, config, orgId, cacheKey),
    getSourceSignature(db, config.sourceTables),
  ]);
  const currentMax = signature.maxUpdatedAt;
  const sourceRows = signature.rowCount;

  if (isSnapshotFresh(snap, currentMax, sourceRows) && snap) {
    if (c) {
      try {
        const { emitCounter } = await import("./observability");
        emitCounter(c as never, "cache.hit", { resource: config.tableName });
      } catch { /* swallow */ }
    }
    return snap.data as T;
  }

  if (c) {
    try {
      const { emitCounter } = await import("./observability");
      emitCounter(c as never, "cache.miss", { resource: config.tableName });
    } catch { /* swallow */ }
  }

  // Serve-stale-while-revalidate: a stale-but-present snapshot + a Worker
  // runtime → hand back the old copy now and refresh in the background. The
  // refresh is single-flighted; only the request that actually starts it wires
  // up waitUntil + onRevalidated (concurrent stale reads just serve the copy).
  if (opts?.staleWhileRevalidate && snap) {
    // The executionCtx getter throws outside a Worker isolate (tests, local
    // node); guard so those paths fall through to a synchronous recompute
    // rather than erroring.
    let waitUntil: ((p: Promise<unknown>) => void) | undefined;
    try {
      const ctx = c?.executionCtx;
      if (ctx?.waitUntil) waitUntil = ctx.waitUntil.bind(ctx);
    } catch {
      waitUntil = undefined;
    }
    if (waitUntil) {
      const key = flightKey(config.tableName, orgId, cacheKey);
      if (!inFlightComputes.has(key)) {
        const refresh = computeAndStore(
          db,
          config,
          orgId,
          computeFresh,
          cacheKey,
          currentMax,
          sourceRows,
        );
        waitUntil(
          refresh
            .then(() => opts.onRevalidated?.())
            .catch((e) =>
              console.warn(`[${config.tableName}] revalidate failed:`, e),
            ),
        );
      }
      return snap.data as T;
    }
  }

  // Cold (no prior copy), SWR not enabled, or no Worker runtime → recompute
  // synchronously, still single-flighted so concurrent cold reads don't
  // stampede the DB.
  return computeAndStore<T>(
    db,
    config,
    orgId,
    computeFresh,
    cacheKey,
    currentMax,
    sourceRows,
  );
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

// ---------------------------------------------------------------------------
// Belt-and-braces explicit invalidation for the snapshots that render hub /
// branch / customer-state fields. Called after a successful
// PATCH /api/sales-orders/:id/hub or PATCH /api/consignment-orders/:id/hub
// cascade completes.
//
// Why explicit on top of the auto-freshness layer? The cache-aside helpers
// (this file, dashboard-snapshot.ts, delivery-snapshot.ts, invoice-snapshot.ts)
// auto-invalidate by comparing built_from against MAX(updated_at) across the
// configured sourceTables. The hub-edit cascade does bump updated_at on every
// row it touches, so the freshness probe SHOULD detect staleness on the next
// read. In practice we have hit edge cases where the probe lies:
//   • Mixed TIMESTAMP / TEXT columns across source tables produce subtly
//     wrong MAX comparisons (see snapshot.ts isSnapshotFresh comment, the
//     2026-05-26 sales-orders 4-day-stale incident).
//   • Source tables that don't have updated_at at all (line items / append-
//     only) get silently skipped by the schema probe.
//   • Replication lag between the cascade's write batch and the snapshot
//     read's freshness probe on the same request.
//
// Hub changes are operator-visible and rare (<10/month) — a 7-row DELETE is
// negligible cost. Wiping the affected rows GUARANTEES the next read recomputes,
// regardless of whether the auto-freshness layer would have caught the bump.
//
// Each DELETE is wrapped in try/catch — a missing snapshot table or a transient
// failure must NOT roll back the hub change. The cascade has already committed
// at this point; the worst case is the snapshot stays stale until the nightly
// rebuild (Layer 3) or the next source-table bump trips the freshness probe.
//
// `kind` selects the snapshot set:
//   • 'sales'       — SO hub change. Wipes SO list / stats, production list,
//                     dashboard, delivery stats + po-values, invoice stats.
//   • 'consignment' — CO hub change. Wipes CO stats, CN stats, production list,
//                     dashboard.
// ---------------------------------------------------------------------------
const HUB_CHANGE_SNAPSHOT_TABLES: Record<"sales" | "consignment", readonly string[]> = {
  sales: [
    "sales_orders_list_snapshot",
    "sales_orders_stats_snapshot",
    "production_orders_list_snapshot",
    "dashboard_snapshot",
    "delivery_stats_snapshot",
    "delivery_po_values_snapshot",
    "invoice_stats_snapshot",
  ],
  consignment: [
    "consignment_orders_stats_snapshot",
    "consignment_notes_stats_snapshot",
    "production_orders_list_snapshot",
    "dashboard_snapshot",
  ],
};

export async function invalidateHubChangeSnapshots(
  db: D1Database,
  orgId: string,
  kind: "sales" | "consignment",
): Promise<void> {
  const tables = HUB_CHANGE_SNAPSHOT_TABLES[kind];
  await Promise.all(
    tables.map(async (table) => {
      try {
        await db
          .prepare(`DELETE FROM ${table} WHERE org_id = ?`)
          .bind(orgId)
          .run();
      } catch (err) {
        // Never fail the hub edit because a snapshot wipe failed. Log and
        // continue — the freshness probe / nightly rebuild still cover us.
        console.warn(
          `[invalidateHubChangeSnapshots] DELETE ${table} failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }),
  );
}

// Same wipe set, different trigger — kept as a named alias so the call site
// reads honestly instead of claiming a hub change happened.
//
// An SO/CO status cascade (ON_HOLD / CANCELLED / RESUME, cascadeSOStatusToPOs)
// rewrites production_orders.status for every downstream PO. The dept sheets
// render that status (amber ON HOLD row + reason), the SO list renders the SO
// status, and the dashboard counts both — exactly the tables this set wipes.
// Without it the freshness probe is the only thing standing between the hold
// and the shop floor, and it is documented above as unreliable: on 2026-07-22
// SO-2607-120 went ON_HOLD at 14:22 while the Fab Sew snapshot (built 06:19)
// kept serving PENDING rows, so the sheet showed no hold at all on first load.
// A hold that the floor cannot see is a hold that did not happen.
export const invalidateOrderCascadeSnapshots = invalidateHubChangeSnapshots;
