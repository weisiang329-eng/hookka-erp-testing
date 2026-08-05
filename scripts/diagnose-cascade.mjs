import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";
const sql = postgres(stagingUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  // Find all test SOs (5/2-created) and dump their FC + SEW state + wip_items
  for (const soid of ["SO-2605-001", "SO-2605-002", "SO-2605-006", "SO-2605-007", "SO-2605-008"]) {
    console.log(`\n========= ${soid} =========`);
    const jcs = await sql`
      SELECT po.line_no, po.product_code, po.fabric_code, jc.department_code, jc.status, jc.wip_label, jc.wip_qty, jc.completed_date
      FROM job_cards jc
      JOIN production_orders po ON po.id = jc.production_order_id
      WHERE po.company_so_id = ${soid}
        AND jc.department_code IN ('FAB_CUT', 'FAB_SEW')
      ORDER BY po.line_no, jc.department_code, jc.wip_label;
    `;
    for (const j of jcs) {
      console.log(`  L${j.line_no} ${(j.product_code||'').padEnd(14)} ${(j.fabric_code||'').padEnd(10)} ${j.department_code.padEnd(8)} ${j.status.padEnd(10)} qty=${j.wip_qty}  done=${j.completed_date||'-'}  ${j.wip_label}`);
    }

    const wips = await sql`
      SELECT id, code, type, dept_status, stock_qty, status
      FROM wip_items
      WHERE code IN (
        SELECT DISTINCT jc.wip_label FROM job_cards jc
        JOIN production_orders po ON po.id = jc.production_order_id
        WHERE po.company_so_id = ${soid} AND jc.department_code IN ('FAB_CUT','FAB_SEW')
      )
      ORDER BY code;
    `;
    console.log("  --- relevant wip_items ---");
    for (const w of wips) {
      console.log(`    ${w.id.padEnd(40)} type=${(w.type||'').padEnd(10)} dept=${(w.dept_status||'').padEnd(10)} qty=${w.stock_qty}  status=${w.status}  ${w.code}`);
    }
  }
} finally { await sql.end(); }
