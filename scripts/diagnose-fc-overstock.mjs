import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("STAGING_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  // Total FC wip_items by stock state
  console.log("=== FC wip_items stock distribution ===");
  const dist = await sql`
    SELECT 
      CASE 
        WHEN stock_qty > 0 THEN 'positive'
        WHEN stock_qty = 0 THEN 'zero'
        WHEN stock_qty < 0 THEN 'negative'
      END AS bucket,
      COUNT(*) AS n, SUM(stock_qty) AS sum_qty
    FROM wip_items
    WHERE code LIKE '%(FC)%'
    GROUP BY bucket
    ORDER BY bucket;
  `;
  console.log(JSON.stringify(dist, null, 2));

  // For FC rows with stock>0, count how many have all SEW done (should be 0 stock)
  console.log("\n=== FC rows where ALL SEW JCs are DONE but stock still > 0 (consume failed) ===");
  const stuck = await sql`
    WITH fc_with_sew AS (
      SELECT DISTINCT 
        jc.wip_label AS fc_label,
        jc.production_order_id AS fc_po_id,
        po.company_so_id,
        po.fabric_code,
        po.item_category
      FROM job_cards jc
      JOIN production_orders po ON po.id = jc.production_order_id
      WHERE jc.department_code = 'FAB_CUT'
        AND jc.wip_key LIKE '%::FAB_CUT'
        AND jc.status IN ('COMPLETED','TRANSFERRED')
    ),
    sew_status AS (
      SELECT 
        fws.fc_label,
        fws.company_so_id,
        fws.item_category,
        COUNT(jc2.id) AS sew_total,
        COUNT(jc2.id) FILTER (WHERE jc2.status IN ('COMPLETED','TRANSFERRED')) AS sew_done
      FROM fc_with_sew fws
      JOIN production_orders po2 ON 
        CASE 
          WHEN fws.item_category = 'SOFA' THEN po2.company_so_id = fws.company_so_id AND po2.fabric_code = fws.fabric_code
          ELSE po2.id = fws.fc_po_id
        END
      LEFT JOIN job_cards jc2 ON jc2.production_order_id = po2.id AND jc2.department_code = 'FAB_SEW'
      GROUP BY fws.fc_label, fws.company_so_id, fws.item_category
    )
    SELECT s.fc_label, s.sew_done, s.sew_total, w.stock_qty
    FROM sew_status s
    JOIN wip_items w ON w.code = s.fc_label
    WHERE s.sew_done = s.sew_total AND s.sew_total > 0 AND w.stock_qty > 0
    LIMIT 10;
  `;
  console.log(`Found ${stuck.length} stuck rows (showing 10):`);
  console.log(JSON.stringify(stuck, null, 2));
} finally { await sql.end(); }
