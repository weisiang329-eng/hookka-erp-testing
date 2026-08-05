// Check current state of SO-2604-347 cascade — did SEW completion consume FC WIP?
import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";

const sql = postgres(
  stagingUrl(),
  { ssl: "require", max: 1, idle_timeout: 5 },
);

try {
  console.log("=== JC state for SO-2604-347 ===");
  const jcs = await sql`
    SELECT jc.department_code, jc.status, jc.completed_date, jc.wip_label, jc.wip_qty
    FROM job_cards jc
    JOIN production_orders po ON po.id = jc.production_order_id
    WHERE po.company_so_id = 'SO-2604-347'
    ORDER BY jc.department_code, jc.id;
  `;
  console.log(JSON.stringify(jcs, null, 2));

  console.log("\n=== wip_items for this set ===");
  const wips = await sql`
    SELECT id, code, type, dept_status, stock_qty, status
    FROM wip_items
    WHERE code LIKE '%1013-(Q)%PC151-18%'
    ORDER BY code;
  `;
  console.log(JSON.stringify(wips, null, 2));
} finally {
  await sql.end();
}
