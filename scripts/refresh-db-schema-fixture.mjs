// Snapshot the production schema (table → columns) for tests/db-schema.json.
//
// tests/sql-columns-exist.test.mjs checks every `SELECT … FROM <table>` in
// src/api against this snapshot. CI has no database, so the snapshot is what
// CI compares to — re-run this after any migration that adds or renames a
// column:
//
//   node scripts/refresh-db-schema-fixture.mjs
//
// Names only, no data. Reading information_schema needs no table privileges
// beyond connecting.
import postgres from "postgres";
import fs from "node:fs";

const url =
  process.env.DATABASE_URL ||
  "postgresql://postgres:ZaXI0JigbBD6muTk@db.vpwdqtsxexpiqxzweivd.supabase.co:5432/postgres";
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

try {
  const rows = await sql`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, column_name;
  `;
  const out = {};
  for (const r of rows) (out[r.table_name] ??= []).push(r.column_name);
  fs.writeFileSync("tests/db-schema.json", `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    `wrote tests/db-schema.json — ${Object.keys(out).length} tables, ${rows.length} columns`,
  );
} finally {
  await sql.end();
}
