import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";
const sql = postgres(stagingUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const code = '1003-(Q) | (5FT) | (28") | (DV 10") | PC151-18 | (FC)';
  console.log("=== wip_items row ===");
  const w = await sql`SELECT id, code, type, dept_status, stock_qty, status FROM wip_items WHERE code = ${code};`;
  console.log(JSON.stringify(w, null, 2));

  console.log("\n=== FC JCs with this wipLabel ===");
  const j = await sql`
    SELECT jc.id, jc.production_order_id, jc.wip_qty, jc.status, jc.completed_date,
           po.company_so_id, po.line_no, po.quantity
    FROM job_cards jc JOIN production_orders po ON po.id = jc.production_order_id
    WHERE jc.wip_label = ${code} AND jc.department_code = 'FAB_CUT'
    ORDER BY po.company_so_id;
  `;
  console.log(JSON.stringify(j, null, 2));

  console.log("\n=== SEW state for those POs ===");
  for (const fc of j) {
    const sews = await sql`
      SELECT department_code, status, wip_label, wip_qty, completed_date
      FROM job_cards
      WHERE production_order_id = ${fc.production_order_id} AND department_code = 'FAB_SEW'
      ORDER BY wip_label;
    `;
    console.log(`  ${fc.company_so_id}-${String(fc.line_no).padStart(2,'0')} (po=${fc.production_order_id}):`);
    for (const s of sews) console.log(`    ${s.status.padEnd(10)} qty=${s.wip_qty} done=${s.completed_date||'-'} ${s.wip_label}`);
  }
} finally { await sql.end(); }
