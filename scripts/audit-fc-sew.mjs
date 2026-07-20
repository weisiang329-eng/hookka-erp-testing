import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("STAGING_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  // Re-audit FC stock vs JC state
  console.log("=== FC stock vs JC state ===");
  const fcMismatch = await sql`
    WITH groups AS (
      SELECT
        jc.wip_label AS fc_label,
        jc.production_order_id AS fc_po_id,
        jc.status AS fc_status,
        po.company_so_id, po.fabric_code, po.item_category
      FROM job_cards jc JOIN production_orders po ON po.id = jc.production_order_id
      WHERE jc.department_code = 'FAB_CUT' AND jc.wip_key LIKE '%::FAB_CUT'
    ),
    expected AS (
      SELECT
        g.fc_label,
        g.item_category,
        SUM(
          CASE
            WHEN g.fc_status IN ('COMPLETED','TRANSFERRED') AND NOT EXISTS (
              SELECT 1 FROM job_cards jc2 JOIN production_orders po2 ON po2.id = jc2.production_order_id
              WHERE jc2.department_code = 'FAB_SEW' AND jc2.status IN ('COMPLETED','TRANSFERRED')
                AND CASE WHEN g.item_category = 'SOFA'
                         THEN po2.company_so_id = g.company_so_id AND po2.fabric_code = g.fabric_code
                         ELSE po2.id = g.fc_po_id END
            ) THEN 1
            WHEN g.fc_status NOT IN ('COMPLETED','TRANSFERRED') AND EXISTS (
              SELECT 1 FROM job_cards jc2 JOIN production_orders po2 ON po2.id = jc2.production_order_id
              WHERE jc2.department_code = 'FAB_SEW' AND jc2.status IN ('COMPLETED','TRANSFERRED')
                AND CASE WHEN g.item_category = 'SOFA'
                         THEN po2.company_so_id = g.company_so_id AND po2.fabric_code = g.fabric_code
                         ELSE po2.id = g.fc_po_id END
            ) THEN -1
            ELSE 0
          END
        )::int AS expected_qty
      FROM groups g GROUP BY g.fc_label, g.item_category
    )
    SELECT e.fc_label, e.item_category, e.expected_qty, w.stock_qty AS actual
    FROM expected e LEFT JOIN wip_items w ON w.code = e.fc_label
    WHERE COALESCE(w.stock_qty, 0) <> e.expected_qty;
  `;
  console.log(`Mismatches: ${fcMismatch.length}`);
  for (const m of fcMismatch.slice(0, 20)) console.log(`  [${m.item_category}] expected=${m.expected_qty} actual=${m.actual} | ${m.fc_label}`);

  // SEW audit: each SEW wipLabel = JC's wipQty contribution per PO done.
  // Stock = sum of producer contributions - downstream UPH consume.
  console.log("\n=== SEW stock summary by category ===");
  const sewStock = await sql`
    SELECT 
      CASE WHEN po.item_category = 'SOFA' THEN 'SOFA'
           WHEN po.item_category = 'BEDFRAME' THEN 'BEDFRAME'
           ELSE 'OTHER' END AS cat,
      COUNT(DISTINCT w.code) AS rows,
      SUM(w.stock_qty) AS sum_stock
    FROM wip_items w
    JOIN job_cards jc ON jc.wip_label = w.code AND jc.department_code = 'FAB_SEW'
    JOIN production_orders po ON po.id = jc.production_order_id
    WHERE w.dept_status = 'FAB_SEW' OR w.dept_status = 'PENDING'
    GROUP BY cat
    ORDER BY cat;
  `;
  console.log(JSON.stringify(sewStock, null, 2));

  // Pick a sofa with FC done but SEW done not consumed
  console.log("\n=== Sofa SOs where FC done + SEW done but FC stock != 0 ===");
  const sofaIssues = await sql`
    WITH groups AS (
      SELECT
        jc.wip_label AS fc_label,
        po.company_so_id, po.fabric_code,
        jc.status AS fc_status,
        EXISTS (
          SELECT 1 FROM job_cards jc2 JOIN production_orders po2 ON po2.id = jc2.production_order_id
          WHERE jc2.department_code = 'FAB_SEW' AND jc2.status IN ('COMPLETED','TRANSFERRED')
            AND po2.company_so_id = po.company_so_id AND po2.fabric_code = po.fabric_code
        ) AS any_sew_done
      FROM job_cards jc JOIN production_orders po ON po.id = jc.production_order_id
      WHERE jc.department_code = 'FAB_CUT' AND jc.wip_key LIKE '%::FAB_CUT' AND po.item_category = 'SOFA'
    )
    SELECT g.company_so_id, g.fc_label, g.fc_status, g.any_sew_done, w.stock_qty
    FROM groups g LEFT JOIN wip_items w ON w.code = g.fc_label
    WHERE g.fc_status IN ('COMPLETED','TRANSFERRED') AND g.any_sew_done AND COALESCE(w.stock_qty, 0) <> 0;
  `;
  console.log(`Sofa rows where FC+SEW both done but stock != 0: ${sofaIssues.length}`);
  for (const s of sofaIssues.slice(0, 10)) console.log(`  ${s.company_so_id} stock=${s.stock_qty}  ${s.fc_label}`);
} finally { await sql.end(); }
