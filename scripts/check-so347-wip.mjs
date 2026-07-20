import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";

const sql = postgres(
  requiredDatabaseUrl("STAGING_DATABASE_URL"),
  { ssl: "require", max: 1, idle_timeout: 5 },
);

try {
  console.log("=== 1. FC JC for SO-2604-347 ===");
  const fc = await sql`
    SELECT jc.id, jc.wip_key, jc.wip_label, jc.wip_qty, jc.status,
           jc.completed_date, jc.production_order_id, po.company_so_id
    FROM job_cards jc
    JOIN production_orders po ON po.id = jc.production_order_id
    WHERE po.company_so_id = 'SO-2604-347' AND jc.department_code = 'FAB_CUT';
  `;
  console.log(JSON.stringify(fc, null, 2));

  console.log("\n=== 2. wip_items rows that match this FC JC's wipKey or label ===");
  if (fc.length > 0) {
    const fcJc = fc[0];
    const r = await sql`
      SELECT *
      FROM wip_items
      WHERE code = ${fcJc.wip_label}
         OR id LIKE ${'%' + fcJc.id.slice(0, 50) + '%'};
    `;
    console.log("Matching wip_items:", JSON.stringify(r, null, 2));

    console.log("\n=== 3. Any FC wip_items mentioning 1013-(Q) | PC151-18 ===");
    const r2 = await sql`
      SELECT *
      FROM wip_items
      WHERE code LIKE '%1013-(Q)%'
        AND code LIKE '%(FC)%'
        AND code LIKE '%PC151-18%'
      LIMIT 10;
    `;
    console.log(JSON.stringify(r2, null, 2));

    console.log("\n=== 3b. wip_items columns ===");
    const cols = await sql`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'wip_items' ORDER BY ordinal_position;
    `;
    console.log(JSON.stringify(cols.map(c => c.column_name), null, 2));
  }

  console.log("\n=== 4. Total wip_items count by type/status ===");
  const totals = await sql`
    SELECT type, status, dept_status, COUNT(*) AS n
    FROM wip_items
    WHERE type = 'FAB_CUT'
    GROUP BY type, status, dept_status
    ORDER BY type, status;
  `;
  console.log(JSON.stringify(totals, null, 2));
} finally {
  await sql.end();
}
