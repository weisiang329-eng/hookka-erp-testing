import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
const sql = postgres(prodUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const c = await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'working_hour_entries' ORDER BY ordinal_position`;
  console.log("working_hour_entries columns:");
  for (const x of c) console.log(`  ${x.column_name.padEnd(20)} ${x.data_type}`);
  // Try the exact query the route runs
  const r = await sql`SELECT DISTINCT date FROM working_hour_entries WHERE worker_id = 'worker-b311d39e' AND date LIKE '2026-05-%'`;
  console.log("\nsample rows for EMP-001 May 2026:");
  for (const row of r) console.log("  date=" + row.date);
} finally { await sql.end(); }
