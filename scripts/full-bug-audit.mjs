import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("STAGING_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  // 1. Current inventory WIP (what's visible)
  console.log("=== 1. Current visible Inventory WIP rows (stock_qty != 0) ===");
  const visible = await sql`
    SELECT id, code, type, dept_status, stock_qty, status
    FROM wip_items WHERE stock_qty != 0
    ORDER BY stock_qty DESC, code;
  `;
  console.log(`Count: ${visible.length}`);
  for (const v of visible) console.log(`  qty=${String(v.stock_qty).padStart(3)} dept=${(v.dept_status||'').padEnd(12)} status=${(v.status||'').padEnd(12)} ${v.code}`);

  // 2. JCs still DONE (per user "cleared all completion dates")
  console.log("\n=== 2. Any JCs still DONE? ===");
  const stillDone = await sql`
    SELECT jc.id, jc.department_code, jc.wip_label, jc.status, jc.completed_date, po.company_so_id
    FROM job_cards jc JOIN production_orders po ON po.id = jc.production_order_id
    WHERE jc.status IN ('COMPLETED', 'TRANSFERRED')
    ORDER BY jc.department_code, po.company_so_id;
  `;
  console.log(`Count: ${stillDone.length}`);
  for (const j of stillDone.slice(0, 30)) console.log(`  ${j.department_code.padEnd(12)} ${j.status.padEnd(10)} ${j.company_so_id}  ${j.wip_label}`);

  // 3. For each visible row, find what JC should be producing it
  console.log("\n=== 3. For each visible row, trace producer JC ===");
  for (const v of visible.slice(0, 20)) {
    const producers = await sql`
      SELECT jc.id, jc.department_code, jc.status, po.company_so_id
      FROM job_cards jc JOIN production_orders po ON po.id = jc.production_order_id
      WHERE jc.wip_label = ${v.code}
      ORDER BY jc.department_code;
    `;
    console.log(`  Row qty=${v.stock_qty}  ${v.code}`);
    for (const p of producers) console.log(`    JC ${p.department_code} ${p.status}  ${p.company_so_id}`);
  }
} finally { await sql.end(); }
