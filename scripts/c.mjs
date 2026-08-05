import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";
const sql = postgres(stagingUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const r = await sql`
    SELECT jc.id, jc.wip_label, jc.wip_qty, po.company_so_id, po.line_no, po.quantity, po.item_category
    FROM job_cards jc JOIN production_orders po ON po.id = jc.production_order_id
    WHERE jc.department_code = 'FAB_CUT' AND jc.wip_key LIKE '%::FAB_CUT' AND jc.wip_qty <> 1;
  `;
  console.log(JSON.stringify(r, null, 2));
} finally { await sql.end(); }
