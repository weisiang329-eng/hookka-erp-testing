import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("STAGING_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  // Check 1: any DONE/TRANSFERRED JC remains?
  console.log("=== JCs still in DONE/TRANSFERRED (after user cleared all completion dates) ===");
  const stillDone = await sql`
    SELECT department_code, COUNT(*) AS n
    FROM job_cards
    WHERE status IN ('COMPLETED', 'TRANSFERRED')
    GROUP BY department_code ORDER BY department_code;
  `;
  console.log(JSON.stringify(stillDone, null, 2));

  // Check 2: any wip_items with stock_qty != 0?
  console.log("\n=== wip_items WHERE stock_qty != 0 ===");
  const nonzero = await sql`
    SELECT dept_status, COUNT(*) AS n, SUM(stock_qty) AS sum_stock,
           SUM(CASE WHEN stock_qty > 0 THEN stock_qty ELSE 0 END) AS pos,
           SUM(CASE WHEN stock_qty < 0 THEN stock_qty ELSE 0 END) AS neg
    FROM wip_items WHERE stock_qty != 0
    GROUP BY dept_status ORDER BY dept_status;
  `;
  console.log(JSON.stringify(nonzero, null, 2));

  // Check 3: Top 20 phantom rows
  console.log("\n=== Top 20 phantom stock rows (no DONE JC, but stock != 0) ===");
  const phantom = await sql`
    SELECT w.id, w.code, w.dept_status, w.stock_qty
    FROM wip_items w
    WHERE w.stock_qty != 0
      AND NOT EXISTS (
        SELECT 1 FROM job_cards jc
        WHERE jc.wip_label = w.code
          AND jc.status IN ('COMPLETED','TRANSFERRED')
      )
    ORDER BY ABS(w.stock_qty) DESC
    LIMIT 20;
  `;
  console.log(`Total phantom rows: ${phantom.length}`);
  for (const p of phantom) console.log(`  ${String(p.stock_qty).padStart(3)} dept=${(p.dept_status||'').padEnd(12)} ${p.code}`);
} finally { await sql.end(); }
