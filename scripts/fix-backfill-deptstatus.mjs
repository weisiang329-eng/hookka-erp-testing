import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("STAGING_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  // Backfill rows for merged FC have dept_status='PENDING' + status='PENDING'
  // but stock_qty > 0 (positive). For positive FC stock, dept_status should
  // be 'FAB_CUT' (the dept that produced) and status 'COMPLETED'.
  // Negative stubs (stock_qty < 0) keep dept_status='PENDING' since the
  // upstream FC genuinely hasn't run yet.
  const r = await sql`
    UPDATE wip_items
    SET dept_status = 'FAB_CUT', status = 'COMPLETED'
    WHERE code LIKE '%(FC)%'
      AND stock_qty > 0
      AND (dept_status = 'PENDING' OR status = 'PENDING');
  `;
  console.log(`Updated ${r.count} positive FC rows: dept_status=FAB_CUT, status=COMPLETED`);

  // Verify
  const counts = await sql`
    SELECT dept_status, status, COUNT(*) AS n, SUM(stock_qty) AS sum_qty
    FROM wip_items
    WHERE code LIKE '%(FC)%'
    GROUP BY dept_status, status
    ORDER BY dept_status, status;
  `;
  console.log("\nFC wip_items by dept_status × status:");
  console.log(JSON.stringify(counts, null, 2));
} finally { await sql.end(); }
