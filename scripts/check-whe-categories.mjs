import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("PROD_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const cats = await sql`SELECT category, COUNT(*) AS n, MIN(hours) AS mn, MAX(hours) AS mx FROM working_hour_entries GROUP BY category`;
  console.log("categories in working_hour_entries:");
  for (const c of cats) console.log(`  ${c.category}  n=${c.n}  range=${c.mn}..${c.mx}`);
  // Sample EI PHOO WEI for May
  const sample = await sql`SELECT date, department_code, category, hours FROM working_hour_entries WHERE worker_id = 'worker-b311d39e' AND date LIKE '2026-05-%' ORDER BY date`;
  console.log("\nEMP-001 May 2026:");
  for (const r of sample) console.log(`  ${r.date} ${r.department_code} ${r.category} ${r.hours}`);
} finally { await sql.end(); }
