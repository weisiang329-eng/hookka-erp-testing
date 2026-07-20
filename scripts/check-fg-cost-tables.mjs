import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("PROD_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const t = await sql`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND (table_name ILIKE '%cost%' OR table_name ILIKE '%fg%' OR table_name = 'products')
     ORDER BY table_name`;
  console.log("cost/fg/products tables:");
  for (const r of t) console.log("  " + r.table_name);
  for (const tbl of ["cost_ledger", "fg_units", "products"]) {
    const c = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = ${tbl} ORDER BY ordinal_position`;
    console.log(`\n${tbl}:`);
    for (const x of c) console.log("  " + x.column_name);
  }
} finally { await sql.end(); }
