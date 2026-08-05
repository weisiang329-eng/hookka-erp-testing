import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";
const sql = postgres(stagingUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const r = await sql`
    SELECT jc.id, jc.wip_key, jc.wip_label, jc.status, po.company_so_id, po.product_code, po.item_category, po.status AS po_status
    FROM job_cards jc JOIN production_orders po ON po.id = jc.production_order_id
    WHERE jc.department_code = 'FAB_CUT' AND jc.wip_key NOT LIKE '%::FAB_CUT' AND jc.wip_key IS NOT NULL
    ORDER BY po.company_so_id LIMIT 30;
  `;
  console.log(`Old-schema FC JCs: ${r.length}`);
  for (const j of r) console.log(`  ${j.company_so_id} ${j.product_code.padEnd(16)} cat=${j.item_category.padEnd(10)} po_status=${j.po_status} wipKey=${j.wip_key}`);
} finally { await sql.end(); }
