// Re-set wipQty for the 3 test SOs' merged FC JCs to set-count (1).
import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";

const sql = postgres(
  stagingUrl(),
  { ssl: "require", max: 1, idle_timeout: 5 },
);

try {
  for (const soid of ["SO-2605-006", "SO-2605-007", "SO-2605-008"]) {
    const r = await sql`
      UPDATE job_cards
      SET wip_qty = 1
      WHERE department_code = 'FAB_CUT'
        AND production_order_id IN (
          SELECT id FROM production_orders WHERE company_so_id = ${soid}
        );
    `;
    console.log(`${soid}: updated ${r.count} FC JC(s) wipQty → 1`);
  }
} finally {
  await sql.end();
}
