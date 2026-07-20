import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("PROD_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const t = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'supplier%'`;
  for (const r of t) console.log("table:", r.table_name);
  const c = await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'supplier_material_bindings' ORDER BY ordinal_position`;
  console.log("\nsupplier_material_bindings columns:");
  for (const x of c) console.log(`  ${x.column_name} ${x.data_type}`);
  const sample = await sql`SELECT * FROM supplier_material_bindings LIMIT 2`;
  console.log("\nsample row:");
  for (const r of sample) console.log(JSON.stringify(r));
} finally { await sql.end(); }
