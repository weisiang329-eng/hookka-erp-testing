import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("STAGING_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  // Rows with status PENDING but stock_qty != 0 — these shouldn't show as inventory
  console.log("=== wip_items WHERE status='PENDING' AND stock_qty != 0 ===");
  const r = await sql`
    SELECT id, code, type, dept_status, stock_qty, status
    FROM wip_items WHERE status = 'PENDING' AND stock_qty != 0
    ORDER BY stock_qty DESC LIMIT 20;
  `;
  console.log(`Found ${r.length}:`);
  for (const x of r) console.log(`  qty=${x.stock_qty} status=${x.status} dept=${x.dept_status}  ${x.code}`);

  // For the top SEW row "10" Divan- 5FT PC151-01" — show the JC breakdown
  console.log('\n=== Detailed JC list for "10\\" Divan- 5FT PC151-01" ===');
  const jcs = await sql`
    SELECT jc.id, po.company_so_id, jc.status, jc.wip_qty, jc.completed_date
    FROM job_cards jc JOIN production_orders po ON po.id = jc.production_order_id
    WHERE jc.wip_label = '10" Divan- 5FT PC151-01' AND jc.department_code = 'FAB_SEW'
    ORDER BY jc.status, po.company_so_id;
  `;
  console.log(`SEW JCs: ${jcs.length}`);
  for (const j of jcs) console.log(`  ${j.status.padEnd(10)} qty=${j.wip_qty} done=${j.completed_date||'-'}  ${j.company_so_id}`);
} finally { await sql.end(); }
