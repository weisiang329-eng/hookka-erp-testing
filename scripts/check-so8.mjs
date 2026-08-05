import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";
const sql = postgres(
  stagingUrl(),
  { ssl: "require", max: 1, idle_timeout: 5 },
);
try {
  console.log("=== Direct lookup of SO-2605-008 FC wip_label ===");
  const r = await sql`
    SELECT id, code, type, dept_status, stock_qty, status
    FROM wip_items
    WHERE code = '5530-1NA+L(LHF)+CNR | PC151-18 | (FC)';
  `;
  console.log(JSON.stringify(r, null, 2));

  console.log("\n=== Any wip_items containing '5530-1NA+L(LHF)+CNR' ===");
  const r2 = await sql`
    SELECT id, code, type, stock_qty, status
    FROM wip_items
    WHERE code LIKE '%5530-1NA+L(LHF)+CNR%'
       OR code LIKE '%5530%CNR%';
  `;
  console.log(JSON.stringify(r2, null, 2));

  console.log("\n=== SO-2605-008 FC JC details ===");
  const r3 = await sql`
    SELECT jc.id, jc.wip_key, jc.wip_label, jc.wip_qty, jc.status, jc.completed_date,
           jc.production_order_id
    FROM job_cards jc
    JOIN production_orders po ON po.id = jc.production_order_id
    WHERE po.company_so_id = 'SO-2605-008' AND jc.department_code = 'FAB_CUT';
  `;
  console.log(JSON.stringify(r3, null, 2));

  console.log("\n=== SO-2605-007 Line 2 FC wip_items ===");
  const r4 = await sql`
    SELECT id, code, type, dept_status, stock_qty, status
    FROM wip_items
    WHERE code = '1003-(Q) | (5FT) | (28") | (DV 10") | PC151-18 | (FC)';
  `;
  console.log(JSON.stringify(r4, null, 2));
} finally {
  await sql.end();
}
