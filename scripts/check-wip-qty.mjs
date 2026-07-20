import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";

const sql = postgres(
  requiredDatabaseUrl("STAGING_DATABASE_URL"),
  { ssl: "require", max: 1, idle_timeout: 5 },
);

try {
  console.log("=== SO-2605-006 (BF qty=2 same model) — every JC ===");
  const r = await sql`
    SELECT po.line_no, po.product_code, jc.department_code, jc.wip_label, jc.wip_qty, jc.wip_type
    FROM job_cards jc
    JOIN production_orders po ON po.id = jc.production_order_id
    WHERE po.company_so_id = 'SO-2605-006'
    ORDER BY po.line_no, jc.department_code, jc.wip_label;
  `;
  for (const j of r) {
    console.log(`  L${j.line_no}  ${j.department_code.padEnd(12)}  qty=${j.wip_qty}  type=${(j.wip_type||'').padEnd(10)}  ${j.wip_label}`);
  }

  // Quick comparo: check the OLD SO-2604-347's per-piece JC qty
  console.log("\n=== SO-2604-347 (legacy backfilled, BF qty=1) — every JC ===");
  const r2 = await sql`
    SELECT po.line_no, po.product_code, jc.department_code, jc.wip_label, jc.wip_qty, jc.wip_type
    FROM job_cards jc
    JOIN production_orders po ON po.id = jc.production_order_id
    WHERE po.company_so_id = 'SO-2604-347'
    ORDER BY po.line_no, jc.department_code, jc.wip_label;
  `;
  for (const j of r2) {
    console.log(`  L${j.line_no}  ${j.department_code.padEnd(12)}  qty=${j.wip_qty}  type=${(j.wip_type||'').padEnd(10)}  ${j.wip_label}`);
  }
} finally {
  await sql.end();
}
