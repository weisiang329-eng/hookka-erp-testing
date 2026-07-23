// Read-only: is the dept-sheet snapshot stale relative to the 14:22 hold?
import postgres from "postgres";
// Connection string comes from the environment — never hardcoded here.
//   PowerShell:  $env:DATABASE_URL="postgresql://…"; node scripts/<this file>
const PROD = process.env.DATABASE_URL;
if (!PROD) throw new Error("set DATABASE_URL to the prod connection string");
const sql = postgres(PROD, { ssl: "require", max: 1, idle_timeout: 15 });

const cols = (await sql`SELECT column_name FROM information_schema.columns WHERE table_name='production_orders_list_snapshot' ORDER BY ordinal_position`).map(c=>c.column_name);
console.log("snapshot cols:", cols.join(", "));
for (const r of await sql`
  SELECT org_id, cache_key, built_at, built_from, refresh_count, LENGTH(data::text) AS bytes
  FROM production_orders_list_snapshot ORDER BY built_at DESC LIMIT 8`) console.log(JSON.stringify(r));

console.log("\nSO held at: 2026-07-22T14:22:26.229Z");
const snap = await sql`SELECT data::text AS p FROM production_orders_list_snapshot ORDER BY built_at DESC LIMIT 1`;
if (snap.length) {
  const txt = snap[0].p;
  const i = txt.indexOf("SO-2607-120");
  console.log("snapshot mentions SO-2607-120:", i >= 0);
  if (i >= 0) console.log("  context:", txt.slice(Math.max(0, i - 300), i + 300));
}
await sql.end();
