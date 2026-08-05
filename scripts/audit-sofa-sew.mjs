import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";
const sql = postgres(stagingUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  // Top 20 sofa SEW rows by stock_qty descending
  console.log("=== TOP 20 sofa SEW wip_items by stock_qty ===");
  const top = await sql`
    SELECT w.id, w.code, w.type, w.dept_status, w.stock_qty, w.status
    FROM wip_items w
    WHERE w.dept_status = 'FAB_SEW'
      AND EXISTS (
        SELECT 1 FROM job_cards jc JOIN production_orders po ON po.id = jc.production_order_id
        WHERE jc.wip_label = w.code AND po.item_category = 'SOFA'
      )
    ORDER BY w.stock_qty DESC
    LIMIT 20;
  `;
  for (const r of top) console.log(`  qty=${String(r.stock_qty).padStart(3)}  ${r.code}`);

  // Check: rows where SEW done + UPH done but stock still > 0 (consume failed)
  console.log("\n=== Sofa SEW rows where ALL UPH JCs in matching POs are DONE (UPH consumed) but stock > 0 ===");
  const stuck = await sql`
    WITH sew_rows AS (
      SELECT DISTINCT w.id, w.code, w.stock_qty
      FROM wip_items w
      WHERE w.dept_status = 'FAB_SEW' AND w.stock_qty > 0
        AND EXISTS (
          SELECT 1 FROM job_cards jc JOIN production_orders po ON po.id = jc.production_order_id
          WHERE jc.wip_label = w.code AND po.item_category = 'SOFA'
        )
    ),
    sew_uph AS (
      SELECT 
        s.code,
        s.stock_qty,
        COUNT(jc_uph.id) AS uph_total,
        COUNT(jc_uph.id) FILTER (WHERE jc_uph.status IN ('COMPLETED','TRANSFERRED')) AS uph_done,
        COUNT(DISTINCT jc_sew.id) AS sew_done_count
      FROM sew_rows s
      JOIN job_cards jc_sew ON jc_sew.wip_label = s.code AND jc_sew.department_code = 'FAB_SEW' AND jc_sew.status IN ('COMPLETED','TRANSFERRED')
      LEFT JOIN job_cards jc_uph ON jc_uph.production_order_id = jc_sew.production_order_id 
        AND jc_uph.department_code = 'UPHOLSTERY' AND jc_uph.wip_key = jc_sew.wip_key
      GROUP BY s.code, s.stock_qty
    )
    SELECT * FROM sew_uph WHERE uph_total > 0 AND uph_done = uph_total LIMIT 15;
  `;
  console.log(`Stuck sofa SEW rows (UPH done but SEW stock still positive): ${stuck.length}`);
  for (const s of stuck) console.log(`  qty=${s.stock_qty} (sew_done=${s.sew_done_count}, uph_done=${s.uph_done}/${s.uph_total})  ${s.code}`);

  // Check FOAM/UPHOLSTERY etc dept stock
  console.log("\n=== All wip_items by dept_status ===");
  const byDept = await sql`
    SELECT dept_status, COUNT(*) AS n, SUM(stock_qty) AS sum_stock
    FROM wip_items WHERE stock_qty != 0
    GROUP BY dept_status ORDER BY dept_status;
  `;
  console.log(JSON.stringify(byDept, null, 2));
} finally { await sql.end(); }
