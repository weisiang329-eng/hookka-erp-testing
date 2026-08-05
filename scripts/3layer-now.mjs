import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";
const sql = postgres(stagingUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  console.log("=== LAYER 1: DB current state ===");
  const nz = await sql`SELECT COUNT(*) AS n, SUM(stock_qty) AS sum FROM wip_items WHERE stock_qty != 0;`;
  console.log(`  wip_items stock != 0: ${nz[0].n} rows, sum=${nz[0].sum}`);

  const top = await sql`SELECT id, code, dept_status, stock_qty FROM wip_items WHERE stock_qty != 0 ORDER BY stock_qty DESC LIMIT 15;`;
  for (const r of top) console.log(`    qty=${String(r.stock_qty).padStart(3)} dept=${(r.dept_status||'').padEnd(10)} ${r.code}`);

  console.log("\n=== Done JCs ===");
  const dones = await sql`SELECT department_code, COUNT(*) AS n FROM job_cards WHERE status IN ('COMPLETED','TRANSFERRED') GROUP BY department_code ORDER BY department_code;`;
  console.log(JSON.stringify(dones, null, 2));

  const doneList = await sql`
    SELECT jc.department_code, jc.wip_label, jc.wip_qty, jc.completed_date, po.company_so_id
    FROM job_cards jc JOIN production_orders po ON po.id = jc.production_order_id
    WHERE jc.status IN ('COMPLETED','TRANSFERRED') ORDER BY jc.completed_date DESC LIMIT 20;
  `;
  console.log("\nRecent done JCs:");
  for (const j of doneList) console.log(`  ${j.completed_date} ${j.department_code.padEnd(10)} ${j.company_so_id} qty=${j.wip_qty}  ${j.wip_label}`);
} finally { await sql.end(); }
