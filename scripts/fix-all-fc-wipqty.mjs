// Reset all merged FC JC wipQty to set-count = anchor PO's quantity.
// BF: each PO is one set (qty=1 typically). SOFA: line qty per PO.
import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";
const sql = postgres(stagingUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  console.log("=== Before: distinct FC JC wipQty values ===");
  const before = await sql`
    SELECT wip_qty, COUNT(*) AS n FROM job_cards
    WHERE department_code = 'FAB_CUT' AND wip_key LIKE '%::FAB_CUT'
    GROUP BY wip_qty ORDER BY wip_qty;
  `;
  console.log(JSON.stringify(before, null, 2));

  console.log("\n=== Fix: set FC JC wipQty = anchor PO's quantity (set count) ===");
  const r = await sql`
    UPDATE job_cards
    SET wip_qty = po.quantity
    FROM production_orders po
    WHERE po.id = job_cards.production_order_id
      AND job_cards.department_code = 'FAB_CUT'
      AND job_cards.wip_key LIKE '%::FAB_CUT'
      AND job_cards.wip_qty <> po.quantity;
  `;
  console.log(`Updated ${r.count} FC JCs`);

  console.log("\n=== After: distinct FC JC wipQty ===");
  const after = await sql`
    SELECT wip_qty, COUNT(*) AS n FROM job_cards
    WHERE department_code = 'FAB_CUT' AND wip_key LIKE '%::FAB_CUT'
    GROUP BY wip_qty ORDER BY wip_qty;
  `;
  console.log(JSON.stringify(after, null, 2));
} finally { await sql.end(); }
