// ---------------------------------------------------------------------------
// snapshot-freshness.ts — schema-aware cross-table freshness probe.
//
// Bug fix 2026-05-21 (caught by the staging before/after verification):
// the snapshot helpers originally hard-coded
//   SELECT MAX(updated_at) FROM <table>
// for every source table. But `updated_at` is NOT a universal column in
// this schema — only ~28 of 130+ tables have it (line-item and
// append-only tables don't). Any snapshot whose source list included one
// of those tables errored with `column "updated_at" does not exist`, and
// the endpoint returned HTTP 500. 9 of 15 snapshot endpoints were down.
//
// Fix: probe information_schema once (cached per isolate) to learn which
// timestamp-typed column each source table actually has — `updated_at`
// preferred, else `created_at` — then build the freshness UNION using the
// right column per table. Tables with no timestamp-typed column are
// skipped: they cannot be tracked incrementally, and the Layer 3 nightly
// rebuild covers them (<=24h staleness worst case).
//
// Used by all four snapshot helpers (dashboard-snapshot, snapshot,
// delivery-snapshot, invoice-snapshot) so the freshness logic lives in
// exactly one place.
// ---------------------------------------------------------------------------

// Per-isolate cache: sorted-table-list -> (table -> freshness column).
// The DB schema is static at runtime, so one information_schema probe
// per distinct source set is enough for the isolate's lifetime.
const schemaCache = new Map<string, Map<string, string>>();

async function resolveFreshnessColumns(
  db: D1Database,
  tables: readonly string[],
): Promise<Map<string, string>> {
  const key = [...tables].sort().join(",");
  const cached = schemaCache.get(key);
  if (cached) return cached;

  const placeholders = tables.map(() => "?").join(", ");
  const res = await db
    .prepare(
      `SELECT table_name AS "tableName", column_name AS "columnName"
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN (${placeholders})
          AND column_name IN ('updated_at', 'created_at')
          AND data_type LIKE 'timestamp%'`,
    )
    .bind(...tables)
    .all<{ tableName: string; columnName: string }>();

  const has = new Map<string, Set<string>>();
  for (const r of res.results ?? []) {
    const s = has.get(r.tableName) ?? new Set<string>();
    s.add(r.columnName);
    has.set(r.tableName, s);
  }

  const resolved = new Map<string, string>();
  for (const t of tables) {
    const cols = has.get(t);
    if (!cols) continue; // no timestamp-typed column — nightly cron covers it
    resolved.set(t, cols.has("updated_at") ? "updated_at" : "created_at");
  }
  schemaCache.set(key, resolved);
  return resolved;
}

// ---------------------------------------------------------------------------
// Cross-table MAX of each source table's freshness column. One extra
// round-trip the first time a source set is seen (schema probe, cached
// thereafter), then one UNION ALL round-trip per call.
//
// Returns null when no source table has a usable timestamp column — the
// caller (isSnapshotFresh) treats null as "trivially fresh", so the
// snapshot is then refreshed only by the Layer 3 nightly rebuild.
// ---------------------------------------------------------------------------
export async function getMaxSourceUpdatedAt(
  db: D1Database,
  tables: readonly string[],
): Promise<string | null> {
  if (tables.length === 0) return null;
  const cols = await resolveFreshnessColumns(db, tables);
  if (cols.size === 0) return null;

  const parts: string[] = [];
  for (const [table, col] of cols) {
    parts.push(`SELECT MAX(${col}) AS t FROM ${table}`);
  }
  const sql = `SELECT MAX(t) AS "maxUpdatedAt" FROM (${parts.join(
    " UNION ALL ",
  )}) sub`;
  const row = await db
    .prepare(sql)
    .first<{ maxUpdatedAt: string | null }>();
  return row?.maxUpdatedAt ?? null;
}
