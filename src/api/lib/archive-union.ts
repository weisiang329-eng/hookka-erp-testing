// ---------------------------------------------------------------------------
// Self-healing UNION source for the `includeArchive` read path.
//
// The archive tables (production_orders_archive, job_cards_archive) were
// created at migration 0038 via `CREATE TABLE … AS SELECT * … WHERE FALSE`,
// which froze a snapshot of the hot table's columns. Every column ADDED to a
// hot table afterwards reached prod only via runtime self-apply ALTER (migration
// files are inert on prod) and those ALTERs touched ONLY the hot table — never
// the archive sibling. So the archives drifted (missing org_id,
// consignment_order_id, company_co_id, repairscope on production_orders;
// branch_key, distributed_at, qr_token on job_cards …).
//
// The old `includeArchive` source did:
//   (SELECT *, '' AS "archivedAt" FROM hot UNION ALL SELECT * FROM archive)
// — hot projects N+1 columns, archive projects (N−k)+1 → Postgres rejects the
// UNION with "each UNION query must have the same number of columns", so EVERY
// archive-inclusive read 500s. Even at equal counts, `SELECT *` UNION ALL
// matches POSITIONALLY, so a different physical column order would silently
// misalign values.
//
// Fix: introspect both tables, ALTER the archive into structural parity (adding
// any missing hot column, mirroring its real type so the positional UNION is
// type-compatible), then build an EXPLICIT, identically-ordered, double-quoted
// column list (driven by the hot table's ordinal order) used by BOTH SELECT
// sides — killing the count mismatch AND the positional fragility. Quoting each
// identifier by its TRUE stored name bypasses the camelCase→snake_case rewriter
// (quoted identifiers pass through verbatim), so the derived table exposes the
// same column names as `SELECT *` did — the outer query is unaffected.
//
// Memoized per (hot|archive) pair per isolate (module-level promise), same shape
// as ensurePendingMigrations. Fail-soft: any introspection failure returns null
// and the caller falls back to the legacy literal (no regression vs today).
// ---------------------------------------------------------------------------

import { DEFAULT_ORG_ID } from "./tenant";

type ColInfo = { name: string; ord: number; dataType: string };

// One flight per (hot|archive) pair per isolate. The resolved value is just a
// SQL string, reusable across requests regardless of which request's `db`
// binding warmed the cache.
const specCache = new Map<string, Promise<string | null>>();

async function introspect(db: D1Database, table: string): Promise<ColInfo[]> {
  // information_schema column/table identifiers are NOT in the rename map, so
  // the SQL text passes through the supabase-compat rewriter unchanged. Result
  // keys ARE camelCased by postgres.js (column_name → columnName, etc.), so we
  // read the camelCase keys (with a snake fallback for safety).
  const res = await db
    .prepare(
      `SELECT column_name, ordinal_position, data_type
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ?
        ORDER BY ordinal_position`,
    )
    .bind(table)
    .all<{
      columnName?: string;
      column_name?: string;
      ordinalPosition?: number;
      ordinal_position?: number;
      dataType?: string;
      data_type?: string;
    }>();
  return (res.results ?? [])
    .map((r) => ({
      name: String(r.columnName ?? r.column_name ?? ""),
      ord: Number(r.ordinalPosition ?? r.ordinal_position ?? 0),
      dataType: String(r.dataType ?? r.data_type ?? "text"),
    }))
    .filter((c) => c.name);
}

// Map an information_schema data_type to a type string usable in
// `ALTER TABLE … ADD COLUMN`. We mirror the hot column's real type so the
// (positional, type-checked) UNION ALL never hits e.g. a text-vs-timestamptz
// mismatch. Unknown / user-defined types fall back to text — safe for an
// append-only display-read archive (values render as strings; the row
// converters tolerate it).
function alterType(dataType: string): string {
  const t = dataType.toLowerCase().trim();
  const KNOWN = new Set([
    "text",
    "boolean",
    "integer",
    "bigint",
    "smallint",
    "numeric",
    "real",
    "double precision",
    "date",
    "uuid",
    "jsonb",
    "json",
    "timestamp with time zone",
    "timestamp without time zone",
    "time without time zone",
    "character varying",
  ]);
  return KNOWN.has(t) ? t : "text";
}

/**
 * Build the `includeArchive` UNION source for a (hot, archive) table pair, or
 * null on failure (caller falls back to the legacy SELECT * literal). Memoized.
 */
export async function archiveUnionSource(
  db: D1Database,
  hot: string,
  archive: string,
): Promise<string | null> {
  const key = `${hot}|${archive}`;
  const hit = specCache.get(key);
  if (hit) return hit;

  const p = (async (): Promise<string | null> => {
    let hotCols: ColInfo[];
    let archCols: ColInfo[];
    try {
      [hotCols, archCols] = await Promise.all([
        introspect(db, hot),
        introspect(db, archive),
      ]);
    } catch (e) {
      console.error("[archive-union] introspection failed", hot, archive, e);
      return null;
    }
    if (hotCols.length === 0 || archCols.length === 0) return null;

    const archSet = new Set(archCols.map((c) => c.name.toLowerCase()));

    // 1) Self-heal: ADD COLUMN IF NOT EXISTS on the archive for every hot column
    //    it lacks, mirroring the hot column's real type. (`archived_at` is
    //    archive-only — never on the hot table — so it never enters this loop.)
    for (const c of hotCols) {
      if (archSet.has(c.name.toLowerCase())) continue;
      try {
        await db
          .prepare(
            `ALTER TABLE ${archive} ADD COLUMN IF NOT EXISTS "${c.name}" ${alterType(c.dataType)}`,
          )
          .run();
        archSet.add(c.name.toLowerCase());
      } catch (e) {
        // A column we couldn't add is dropped from the list below, so the UNION
        // still has matching counts (it just omits that column for both sides).
        console.warn("[archive-union] ALTER skipped", archive, c.name, e);
      }
    }

    // 1b) Backfill org_id. Archive rows predate multi-tenancy, so once the
    //     column exists it is NULL on every archived row — and the org-scoped
    //     read (`WHERE org_id = ?`) then filters them ALL out, so no archived
    //     row ever surfaces. Backfill to the default org (Hookka is single
    //     tenant; archive rows all belong to it). Idempotent (`WHERE … IS NULL`
    //     → no-ops once filled), runs once per isolate via the memoized promise.
    if (archSet.has("org_id")) {
      try {
        await db
          .prepare(`UPDATE ${archive} SET "org_id" = ? WHERE "org_id" IS NULL`)
          .bind(DEFAULT_ORG_ID)
          .run();
      } catch (e) {
        console.warn("[archive-union] org_id backfill skipped", archive, e);
      }
    }

    // 2) Explicit, identically-ordered, quoted column list = hot columns (in
    //    ordinal order) that now exist on BOTH sides.
    const cols = hotCols
      .filter((c) => archSet.has(c.name.toLowerCase()))
      .map((c) => `"${c.name}"`);
    if (cols.length === 0) return null;
    const list = cols.join(", ");

    // Hot side projects '' archivedAt (hot has no such column); archive side
    // surfaces its native archived_at under the same camelCase alias, so the
    // exposed field name stays `archivedAt` exactly as before.
    return (
      `(SELECT ${list}, '' AS "archivedAt" FROM ${hot}` +
      ` UNION ALL ` +
      `SELECT ${list}, "archived_at" AS "archivedAt" FROM ${archive})`
    );
  })();

  specCache.set(key, p);
  return p;
}
