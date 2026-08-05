// One-off: connect to staging Supabase and investigate which SOs lost
// their FC JCs after the backfill. Run via:
//   node scripts/investigate-fc-loss.mjs
import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";

const url =
  stagingUrl();

const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

try {
  // 1. Check SO-2604-347-01 directly
  console.log("=== 1. SO-2604-347-01 ALL JCs (any dept) ===");
  const so347 = await sql`
    SELECT po.id AS po_id, po.product_code, po.item_category, po.fabric_code,
           jc.id AS jc_id, jc.department_code, jc.wip_key, jc.wip_label, jc.status
    FROM production_orders po
    LEFT JOIN job_cards jc ON jc.production_order_id = po.id
    WHERE po.company_so_id = 'SO-2604-347-01'
    ORDER BY po.id, jc.department_code;
  `;
  console.log(JSON.stringify(so347, null, 2));

  // 2. Count SOs that have JCs in non-FAB_CUT depts but ZERO FC JCs
  console.log("\n=== 2. SOs missing FC JCs (have other-dept JCs but no FC) ===");
  const missingFc = await sql`
    WITH so_jc AS (
      SELECT po.company_so_id, jc.department_code
      FROM production_orders po
      JOIN job_cards jc ON jc.production_order_id = po.id
      WHERE po.company_so_id IS NOT NULL
    ),
    so_summary AS (
      SELECT company_so_id,
             COUNT(*) FILTER (WHERE department_code = 'FAB_CUT') AS fc_count,
             COUNT(*) FILTER (WHERE department_code <> 'FAB_CUT') AS other_count
      FROM so_jc
      GROUP BY company_so_id
    )
    SELECT company_so_id, fc_count, other_count
    FROM so_summary
    WHERE fc_count = 0 AND other_count > 0
    ORDER BY company_so_id
    LIMIT 30;
  `;
  console.log(`Found ${missingFc.length} SOs missing FC (showing first 30):`);
  console.log(JSON.stringify(missingFc, null, 2));

  // 3. Total FC count by status on staging
  console.log("\n=== 3. Total FC JCs on staging ===");
  const fcCount = await sql`
    SELECT status, COUNT(*) AS n
    FROM job_cards
    WHERE department_code = 'FAB_CUT'
    GROUP BY status
    ORDER BY status;
  `;
  console.log(JSON.stringify(fcCount, null, 2));

  // 4. Compare to total POs that should have FC JCs
  console.log("\n=== 4. POs that need FC (item_category in BEDFRAME/SOFA/ACCESSORY) ===");
  const poNeedsFc = await sql`
    SELECT item_category, COUNT(*) AS po_count
    FROM production_orders
    WHERE item_category IN ('BEDFRAME', 'SOFA', 'ACCESSORY')
    GROUP BY item_category
    ORDER BY item_category;
  `;
  console.log(JSON.stringify(poNeedsFc, null, 2));

  // 5. Per-category SO count (distinct company_so_id) that have at least one JC of any kind
  console.log("\n=== 5. Per-category SOs with-other-JCs but missing-FC ===");
  const perCategory = await sql`
    WITH po_so AS (
      SELECT po.id AS po_id, po.company_so_id, po.item_category
      FROM production_orders po
      WHERE po.company_so_id IS NOT NULL
        AND po.item_category IN ('BEDFRAME', 'SOFA', 'ACCESSORY')
    ),
    so_jc AS (
      SELECT p.company_so_id, p.item_category, jc.department_code
      FROM po_so p
      JOIN job_cards jc ON jc.production_order_id = p.po_id
    ),
    so_summary AS (
      SELECT company_so_id, item_category,
             COUNT(*) FILTER (WHERE department_code = 'FAB_CUT') AS fc_count,
             COUNT(*) FILTER (WHERE department_code <> 'FAB_CUT') AS other_count
      FROM so_jc
      GROUP BY company_so_id, item_category
    )
    SELECT item_category,
           COUNT(*) FILTER (WHERE fc_count = 0 AND other_count > 0) AS missing_fc,
           COUNT(*) FILTER (WHERE fc_count > 0) AS has_fc,
           COUNT(*) AS total_with_jcs
    FROM so_summary
    GROUP BY item_category
    ORDER BY item_category;
  `;
  console.log(JSON.stringify(perCategory, null, 2));

} finally {
  await sql.end();
}
