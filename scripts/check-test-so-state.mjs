// Check current state of all test SOs — JC status + wip_items rows
import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";

const sql = postgres(
  stagingUrl(),
  { ssl: "require", max: 1, idle_timeout: 5 },
);

try {
  for (const soid of ["SO-2605-001", "SO-2605-002", "SO-2605-006", "SO-2605-007", "SO-2605-008"]) {
    const jcs = await sql`
      SELECT po.line_no, po.product_code, po.fabric_code, jc.department_code, jc.status, jc.wip_label, jc.wip_qty, jc.completed_date
      FROM job_cards jc
      JOIN production_orders po ON po.id = jc.production_order_id
      WHERE po.company_so_id = ${soid}
        AND jc.department_code IN ('FAB_CUT', 'FAB_SEW')
      ORDER BY po.line_no, jc.department_code, jc.wip_label;
    `;
    if (jcs.length === 0) continue;
    console.log(`\n=== ${soid} ===`);
    for (const j of jcs) {
      const stat = j.status === "COMPLETED" || j.status === "TRANSFERRED" ? "DONE" : j.status;
      console.log(`  L${j.line_no} ${j.product_code.padEnd(14)} ${j.fabric_code.padEnd(10)} ${j.department_code.padEnd(8)} ${stat.padEnd(8)} qty=${j.wip_qty}  ${j.wip_label}  done=${j.completed_date || '-'}`);
    }
    const wips = await sql`
      SELECT id, code, type, dept_status, stock_qty, status
      FROM wip_items
      WHERE code IN (
        SELECT DISTINCT jc.wip_label FROM job_cards jc
        JOIN production_orders po ON po.id = jc.production_order_id
        WHERE po.company_so_id = ${soid}
      )
      ORDER BY code;
    `;
    console.log(`  --- wip_items (${wips.length}) ---`);
    for (const w of wips) {
      console.log(`    ${w.id.padEnd(40)} type=${(w.type||'').padEnd(10)} dept=${(w.dept_status||'').padEnd(12)} qty=${w.stock_qty}  status=${w.status}  ${w.code}`);
    }
  }
} finally {
  await sql.end();
}
