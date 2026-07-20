import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";

const sql = postgres(
  requiredDatabaseUrl("STAGING_DATABASE_URL"),
  { ssl: "require", max: 1, idle_timeout: 5 },
);

try {
  for (const soid of ["SO-2605-006", "SO-2605-007", "SO-2605-008"]) {
    console.log(`\n========= ${soid} =========`);
    const pos = await sql`
      SELECT id, line_no, product_code, fabric_code, item_category, quantity
      FROM production_orders WHERE company_so_id = ${soid}
      ORDER BY line_no, id;
    `;
    console.log(`POs (${pos.length}):`);
    for (const p of pos) {
      console.log(`  ${p.id} line=${p.line_no} ${p.product_code.padEnd(14)} ${p.fabric_code} qty=${p.quantity}`);
    }

    const fc = await sql`
      SELECT jc.production_order_id AS po_id, jc.wip_key, jc.wip_label, jc.wip_qty, jc.wip_type, jc.status
      FROM job_cards jc
      JOIN production_orders po ON po.id = jc.production_order_id
      WHERE po.company_so_id = ${soid} AND jc.department_code = 'FAB_CUT'
      ORDER BY jc.wip_key;
    `;
    console.log(`\nFC JCs (${fc.length}):`);
    for (const j of fc) {
      console.log(`  on PO ${j.po_id}`);
      console.log(`    key:    ${j.wip_key}`);
      console.log(`    label:  ${j.wip_label}`);
      console.log(`    type=${j.wip_type}  qty=${j.wip_qty}  status=${j.status}`);
    }

    const all = await sql`
      SELECT jc.department_code, COUNT(*) AS n, SUM(jc.wip_qty) AS sum_qty
      FROM job_cards jc JOIN production_orders po ON po.id = jc.production_order_id
      WHERE po.company_so_id = ${soid}
      GROUP BY jc.department_code ORDER BY jc.department_code;
    `;
    console.log("\nDept JC counts:");
    for (const a of all) console.log(`  ${a.department_code.padEnd(12)} count=${a.n}  sumQty=${a.sum_qty}`);
  }
} finally {
  await sql.end();
}
