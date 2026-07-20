import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("STAGING_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const r = await sql`SELECT id, code, stock_qty, dept_status, status FROM wip_items WHERE code = '1003-(Q) | (5FT) | (28") | (DV 10") | PC151-18 | (FC)';`;
  console.log(JSON.stringify(r, null, 2));

  // Check overall summary
  const sum = await sql`
    SELECT
      CASE WHEN stock_qty > 0 THEN 'positive' WHEN stock_qty = 0 THEN 'zero' ELSE 'negative' END AS bucket,
      COUNT(*) AS n
    FROM wip_items WHERE code LIKE '%(FC)%'
    GROUP BY bucket ORDER BY bucket;
  `;
  console.log("\n=== FC stock distribution ===");
  console.log(JSON.stringify(sum, null, 2));
} finally { await sql.end(); }
