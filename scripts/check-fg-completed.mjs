import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("PROD_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const sample = await sql`SELECT * FROM cost_ledger WHERE type = 'FG_COMPLETED' ORDER BY date DESC LIMIT 5`;
  console.log("Sample FG_COMPLETED rows:");
  for (const r of sample) console.log(JSON.stringify(r, null, 2));

  // Aggregate by category — join through products
  const agg = await sql`
    SELECT p.category, COUNT(*) AS n,
           AVG(cl.unit_cost_sen)::int AS avg_unit_cost_sen,
           MIN(cl.unit_cost_sen) AS min_unit_cost_sen,
           MAX(cl.unit_cost_sen) AS max_unit_cost_sen
      FROM cost_ledger cl
      JOIN products p ON p.id = cl.item_id
     WHERE cl.type = 'FG_COMPLETED' AND cl.unit_cost_sen IS NOT NULL
     GROUP BY p.category
     ORDER BY p.category
  `;
  console.log("\nFG_COMPLETED rollups per category (RM/unit):");
  for (const r of agg) {
    console.log(`  ${r.category.padEnd(10)} n=${r.n}  avg=RM ${(r.avg_unit_cost_sen/100).toFixed(2)}  min=RM ${(r.min_unit_cost_sen/100).toFixed(2)}  max=RM ${(r.max_unit_cost_sen/100).toFixed(2)}`);
  }
} finally { await sql.end(); }
