// Verify SO-2605-001 (BF) + SO-2605-002 (SOFA) cascaded correctly per Option C.
import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";

const sql = postgres(
  stagingUrl(),
  { ssl: "require", max: 1, idle_timeout: 5 },
);

try {
  for (const soid of ["SO-2605-001", "SO-2605-002"]) {
    console.log(`\n====================== ${soid} ======================`);
    const pos = await sql`
      SELECT id, line_no, product_code, fabric_code, item_category, status
      FROM production_orders WHERE company_so_id = ${soid}
      ORDER BY line_no;
    `;
    console.log(`POs (${pos.length}):`);
    for (const p of pos) {
      console.log(`  ${p.id.padEnd(28)} line=${p.line_no} ${p.product_code.padEnd(16)} ${p.fabric_code} ${p.item_category}`);
    }

    const fc = await sql`
      SELECT jc.id, jc.wip_key, jc.wip_label, jc.wip_qty, jc.wip_type, jc.production_order_id, jc.status, jc.due_date
      FROM job_cards jc
      JOIN production_orders po ON po.id = jc.production_order_id
      WHERE po.company_so_id = ${soid} AND jc.department_code = 'FAB_CUT'
      ORDER BY jc.wip_key;
    `;
    console.log(`\nFAB_CUT JCs (${fc.length}):`);
    for (const j of fc) {
      console.log(`  on PO ${j.production_order_id}`);
      console.log(`    wipKey:   ${j.wip_key}`);
      console.log(`    wipLabel: ${j.wip_label}`);
      console.log(`    wipType:  ${j.wip_type}    qty=${j.wip_qty}    status=${j.status}    due=${j.due_date}`);
    }

    const allDepts = await sql`
      SELECT jc.department_code, COUNT(*) AS n
      FROM job_cards jc
      JOIN production_orders po ON po.id = jc.production_order_id
      WHERE po.company_so_id = ${soid}
      GROUP BY jc.department_code
      ORDER BY jc.department_code;
    `;
    console.log(`\nJC count per dept:`);
    for (const d of allDepts) {
      console.log(`  ${d.department_code.padEnd(12)} ${d.n}`);
    }

    const wip = await sql`
      SELECT id, code, type, dept_status, stock_qty, status
      FROM wip_items
      WHERE code IN (SELECT wip_label FROM job_cards jc JOIN production_orders po ON po.id = jc.production_order_id WHERE po.company_so_id = ${soid})
      ORDER BY code;
    `;
    console.log(`\nwip_items linked by wip_label (${wip.length}):`);
    for (const w of wip) {
      console.log(`  ${w.id.padEnd(50)} ${w.code.padEnd(60)} type=${(w.type||'').padEnd(10)} dept=${w.dept_status} qty=${w.stock_qty} status=${w.status}`);
    }
  }
} finally {
  await sql.end();
}
