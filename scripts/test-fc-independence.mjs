import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
// Set FC#1 completedDate=2026-05-05, FC#2 completedDate=2026-05-10. Then
// confirm each Line's SEW row sees its own group's FC date.
import postgres from "postgres";

const sql = postgres(
  requiredDatabaseUrl("STAGING_DATABASE_URL"),
  { ssl: "require", max: 1, idle_timeout: 5 },
);

try {
  // Set FC#1 (PC151-18) → 2026-05-05
  await sql`
    UPDATE job_cards SET status = 'COMPLETED', completed_date = '2026-05-05'
    WHERE wip_key = 'SO-2605-002::5530::PC151-18::FAB_CUT';
  `;
  // Set FC#2 (BO315-25) → 2026-05-10
  await sql`
    UPDATE job_cards SET status = 'COMPLETED', completed_date = '2026-05-10'
    WHERE wip_key = 'SO-2605-002::5530::BO315-25::FAB_CUT';
  `;
  console.log("Set FC#1=2026-05-05, FC#2=2026-05-10");

  // Verify
  const fcs = await sql`
    SELECT jc.wip_key, jc.completed_date, jc.production_order_id, po.product_code, po.fabric_code
    FROM job_cards jc
    JOIN production_orders po ON po.id = jc.production_order_id
    WHERE po.company_so_id = 'SO-2605-002' AND jc.department_code = 'FAB_CUT'
    ORDER BY jc.wip_key;
  `;
  console.log("\nFC JCs after update:");
  for (const f of fcs) {
    console.log(`  ${f.wip_key}  on PO ${f.production_order_id} (${f.product_code} ${f.fabric_code}) → ${f.completed_date}`);
  }
} finally {
  await sql.end();
}
