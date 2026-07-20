import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
// ============================================================================
// clone-prod-to-staging.mjs
//
// One-shot dataset clone from testing prod → staging Supabase, so the preview
// deploy can be perf-benchmarked against a representative slice (~833 POs /
// 12.6k JCs) before a perf-sensitive change merges to main.
//
// Approach: per-table SELECT + batched INSERT over postgres-js.
//   1. Intersect tables present in BOTH public schemas (skip tables that only
//      exist on prod — staging missing migrations should be a follow-up).
//   2. On staging: SET session_replication_role = replica (disable FK +
//      audit triggers — Supabase's `postgres` role has the privilege).
//   3. TRUNCATE every shared table on staging (CASCADE drops dependents that
//      we'd refill anyway).
//   4. For each table: SELECT all rows from prod, INSERT in batches into
//      staging via parameterised multi-row INSERT.
//   5. RESET session_replication_role + ANALYZE.
//
// Why not COPY streams: postgres-js's COPY-TO-STDOUT readable() can hang
// mid-stream on some Supabase pooler configs (observed 2026-05-11 — 5
// tables in, then silent stall). SELECT + INSERT runs in ~1-3 minutes for
// this dataset size and never stalls because each statement is a discrete
// round-trip.
//
// Idempotent — re-running TRUNCATEs and reloads from scratch.
//
// Usage: node scripts/clone-prod-to-staging.mjs
// ============================================================================
import postgres from "postgres";

const PROD_URL = requiredDatabaseUrl("PROD_DATABASE_URL");
const STAGING_URL = requiredDatabaseUrl("STAGING_DATABASE_URL");

const pgOpts = { ssl: "require", max: 1, idle_timeout: 5, connect_timeout: 15 };
const BATCH_SIZE = 500;

async function main() {
  const prod = postgres(PROD_URL, pgOpts);
  const staging = postgres(STAGING_URL, pgOpts);

  try {
    const listSql = `
      SELECT tablename FROM pg_catalog.pg_tables
      WHERE schemaname = 'public' AND tablename NOT LIKE 'pg_%'
      ORDER BY tablename
    `;
    const [prodTables, stagingTables] = await Promise.all([
      prod.unsafe(listSql),
      staging.unsafe(listSql),
    ]);
    const prodSet = new Set(prodTables.map((r) => r.tablename));
    const stagingSet = new Set(stagingTables.map((r) => r.tablename));
    const tables = [...prodSet].filter((t) => stagingSet.has(t)).sort();
    const missingFromStaging = [...prodSet].filter((t) => !stagingSet.has(t));
    console.log(`[clone] ${tables.length} tables in common; ${missingFromStaging.length} only-on-prod (skipped)`);
    if (missingFromStaging.length > 0) {
      console.log(`[clone]   skipped (staging missing migration): ${missingFromStaging.join(", ")}`);
    }

    await staging`SET session_replication_role = replica`;
    console.log("[clone] staging triggers disabled");

    // TRUNCATE all in one CASCADE statement.
    const quoted = tables.map((t) => `"${t}"`).join(", ");
    await staging.unsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
    console.log(`[clone] TRUNCATEd ${tables.length} tables on staging`);

    let totalRows = 0;
    for (const table of tables) {
      const t0 = Date.now();
      // Column intersection per table (handles schema drift — e.g.
      // 2026-05-11: prod has customers.ocr_prompt_rules, staging does
      // not). Use staging's columns as the authoritative list so we never
      // try to INSERT a column staging is missing; SELECT the same list
      // from prod (skipping any prod-only columns).
      const colSql = `
        SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1
        ORDER BY ordinal_position
      `;
      const [prodColsRes, stagingColsRes] = await Promise.all([
        prod.unsafe(colSql, [table]),
        staging.unsafe(colSql, [table]),
      ]);
      const prodColSet = new Set(prodColsRes.map((r) => r.column_name));
      const cols = stagingColsRes
        .map((r) => r.column_name)
        .filter((c) => prodColSet.has(c));
      if (cols.length === 0) {
        console.log(`[clone] ${table.padEnd(36)}    SKIP — no common columns`);
        continue;
      }
      const quotedCols = cols.map((c) => `"${c}"`).join(", ");

      // Stream rows in chunks via OFFSET/LIMIT. Sorting by ctid keeps the
      // page order stable across paginated SELECTs without needing a PK we
      // might not know.
      let offset = 0;
      let count = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const rows = await prod.unsafe(
          `SELECT ${quotedCols} FROM "${table}" ORDER BY ctid LIMIT $1 OFFSET $2`,
          [BATCH_SIZE, offset],
        );
        if (rows.length === 0) break;
        // Build parameterised multi-row INSERT. Bind values per row in
        // column order. NULL / Date / boolean handled natively by
        // postgres-js parameter binding.
        const placeholders = [];
        const values = [];
        let p = 1;
        for (const row of rows) {
          const slots = [];
          for (const c of cols) {
            slots.push(`$${p++}`);
            values.push(row[c]);
          }
          placeholders.push(`(${slots.join(", ")})`);
        }
        await staging.unsafe(
          `INSERT INTO "${table}" (${quotedCols}) VALUES ${placeholders.join(", ")}`,
          values,
        );
        count += rows.length;
        offset += rows.length;
        if (rows.length < BATCH_SIZE) break;
      }
      totalRows += count;
      console.log(`[clone] ${table.padEnd(36)} ${String(count).padStart(8)} rows  (${Date.now() - t0}ms)`);
    }

    await staging`ANALYZE`;
    await staging`SET session_replication_role = origin`;
    console.log(`[clone] DONE. Total rows: ${totalRows.toLocaleString()}`);
  } finally {
    await prod.end();
    await staging.end();
  }
}

main().catch((e) => {
  console.error("[clone] FAILED:", e);
  process.exit(1);
});
