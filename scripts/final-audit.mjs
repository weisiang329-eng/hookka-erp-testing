import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";
const sql = postgres(stagingUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
const checks = [];
function ok(name, cond, info='') { checks.push({ name, pass: cond, info }); }
try {
  // ===== A. Schema integrity =====
  const fcCount = await sql`SELECT COUNT(*) AS n FROM job_cards WHERE department_code = 'FAB_CUT' AND wip_key LIKE '%::FAB_CUT';`;
  ok("A1. Total FC JCs (Option C wipKey)", true, `${fcCount[0].n}`);

  const wrongKey = await sql`SELECT COUNT(*) AS n FROM job_cards WHERE department_code = 'FAB_CUT' AND wip_key NOT LIKE '%::FAB_CUT' AND wip_key IS NOT NULL;`;
  ok("A2. FC JCs with non-Option-C wipKey schema (should be 0)", Number(wrongKey[0].n) === 0, `${wrongKey[0].n}`);

  const wrongType = await sql`SELECT COUNT(*) AS n FROM job_cards WHERE department_code = 'FAB_CUT' AND wip_key LIKE '%::FAB_CUT' AND wip_type NOT IN ('BEDFRAME','SOFA','ACCESSORY');`;
  ok("A3. FC JCs with wrong wipType (should be 0)", Number(wrongType[0].n) === 0, `${wrongType[0].n}`);

  const wrongLabel = await sql`SELECT COUNT(*) AS n FROM job_cards WHERE department_code = 'FAB_CUT' AND wip_key LIKE '%::FAB_CUT' AND wip_label NOT LIKE '%(FC)';`;
  ok("A4. FC JCs without (FC) suffix in wipLabel (should be 0)", Number(wrongLabel[0].n) === 0, `${wrongLabel[0].n}`);

  const wipQtyMismatch = await sql`
    SELECT COUNT(*) AS n FROM job_cards jc JOIN production_orders po ON po.id = jc.production_order_id
    WHERE jc.department_code = 'FAB_CUT' AND jc.wip_key LIKE '%::FAB_CUT' AND jc.wip_qty <> po.quantity;
  `;
  ok("A5. FC JC wipQty mismatch with PO.quantity (should be 0)", Number(wipQtyMismatch[0].n) === 0, `${wipQtyMismatch[0].n}`);

  // ===== B. wip_items consistency =====
  const orphanFc = await sql`
    SELECT COUNT(*) AS n FROM wip_items w
    WHERE w.code LIKE '%(FC)%' AND NOT EXISTS (SELECT 1 FROM job_cards jc WHERE jc.wip_label = w.code);
  `;
  ok("B1. Orphan FC wip_items (no matching JC) (should be 0)", Number(orphanFc[0].n) === 0, `${orphanFc[0].n}`);

  const wrongFcType = await sql`
    SELECT COUNT(*) AS n FROM wip_items WHERE code LIKE '%(FC)%' AND type NOT IN ('BEDFRAME','SOFA','ACCESSORY');
  `;
  ok("B2. FC wip_items with wrong type (should be 0)", Number(wrongFcType[0].n) === 0, `${wrongFcType[0].n}`);

  const phantomStock = await sql`
    SELECT COUNT(*) AS n FROM wip_items w
    WHERE w.stock_qty != 0
      AND NOT EXISTS (SELECT 1 FROM job_cards jc WHERE jc.wip_label = w.code AND jc.status IN ('COMPLETED','TRANSFERRED'));
  `;
  ok("B3. Phantom stock_qty (no DONE JC backing it) (should be 0)", Number(phantomStock[0].n) === 0, `${phantomStock[0].n}`);

  // ===== C. Cascade balance =====
  const fcStockMismatch = await sql`
    WITH groups AS (
      SELECT jc.wip_label AS fc_label, jc.production_order_id AS fc_po_id, jc.status AS fc_status,
             po.company_so_id, po.fabric_code, po.item_category
      FROM job_cards jc JOIN production_orders po ON po.id = jc.production_order_id
      WHERE jc.department_code = 'FAB_CUT' AND jc.wip_key LIKE '%::FAB_CUT'
    ),
    expected AS (
      SELECT g.fc_label, SUM(
        CASE
          WHEN g.fc_status IN ('COMPLETED','TRANSFERRED') AND NOT EXISTS (
            SELECT 1 FROM job_cards jc2 JOIN production_orders po2 ON po2.id = jc2.production_order_id
            WHERE jc2.department_code = 'FAB_SEW' AND jc2.status IN ('COMPLETED','TRANSFERRED')
              AND CASE WHEN g.item_category = 'SOFA'
                       THEN po2.company_so_id = g.company_so_id AND po2.fabric_code = g.fabric_code
                       ELSE po2.id = g.fc_po_id END) THEN 1
          WHEN g.fc_status NOT IN ('COMPLETED','TRANSFERRED') AND EXISTS (
            SELECT 1 FROM job_cards jc2 JOIN production_orders po2 ON po2.id = jc2.production_order_id
            WHERE jc2.department_code = 'FAB_SEW' AND jc2.status IN ('COMPLETED','TRANSFERRED')
              AND CASE WHEN g.item_category = 'SOFA'
                       THEN po2.company_so_id = g.company_so_id AND po2.fabric_code = g.fabric_code
                       ELSE po2.id = g.fc_po_id END) THEN -1
          ELSE 0
        END
      )::int AS expected_qty
      FROM groups g GROUP BY g.fc_label
    )
    SELECT COUNT(*) AS n FROM expected e LEFT JOIN wip_items w ON w.code = e.fc_label
    WHERE COALESCE(w.stock_qty, 0) <> e.expected_qty;
  `;
  ok("C1. FC stock_qty matches per-set rule (should be 0 mismatch)", Number(fcStockMismatch[0].n) === 0, `${fcStockMismatch[0].n}`);

  // ===== D. SO category integrity =====
  const mixedSO = await sql`
    SELECT COUNT(DISTINCT company_so_id) AS n FROM production_orders
    WHERE company_so_id IN (
      SELECT po.company_so_id FROM production_orders po WHERE po.item_category = 'BEDFRAME'
      INTERSECT
      SELECT po.company_so_id FROM production_orders po WHERE po.item_category = 'SOFA'
    );
  `;
  ok("D1. SOs mixing BF + SOFA (should be 0)", Number(mixedSO[0].n) === 0, `${mixedSO[0].n}`);

  // ===== E. wip_items dept_status correctness =====
  const wrongDept = await sql`
    SELECT COUNT(*) AS n FROM wip_items WHERE code LIKE '%(FC)%' AND stock_qty > 0 AND dept_status <> 'FAB_CUT';
  `;
  ok("E1. Positive FC stock with wrong dept_status (should be 0)", Number(wrongDept[0].n) === 0, `${wrongDept[0].n}`);

  // ===== F. Current state =====
  const summary = await sql`
    SELECT
      (SELECT COUNT(*) FROM job_cards WHERE status IN ('COMPLETED','TRANSFERRED')) AS done_jcs,
      (SELECT COUNT(*) FROM wip_items WHERE stock_qty != 0) AS nonzero_wip,
      (SELECT COUNT(*) FROM wip_items WHERE stock_qty < 0) AS negative_wip,
      (SELECT COUNT(*) FROM wip_items WHERE stock_qty > 0) AS positive_wip,
      (SELECT COUNT(*) FROM job_cards WHERE department_code = 'FAB_CUT' AND wip_key LIKE '%::FAB_CUT') AS option_c_fcs;
  `;

  // ===== Print results =====
  console.log("\n========== FINAL AUDIT ==========\n");
  for (const c of checks) {
    const tag = c.pass ? "✅" : "❌";
    console.log(`${tag}  ${c.name}: ${c.info}`);
  }
  console.log("\n=== Current state ===");
  console.log(JSON.stringify(summary[0], null, 2));
  const failed = checks.filter(c => !c.pass);
  console.log(`\n${failed.length === 0 ? "🎉 ALL GREEN — ready to merge" : `⚠️  ${failed.length} fail(s)`}`);
} finally { await sql.end(); }
