import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("STAGING_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  console.log("============ INVENTORY AUDIT ============");

  // 1. wipQty mismatch with PO quantity (after my fix)
  const wipQtyMismatch = await sql`
    SELECT jc.id, jc.wip_qty, po.quantity, po.company_so_id
    FROM job_cards jc JOIN production_orders po ON po.id = jc.production_order_id
    WHERE jc.department_code = 'FAB_CUT' AND jc.wip_key LIKE '%::FAB_CUT'
      AND jc.wip_qty <> po.quantity;
  `;
  console.log(`\n1. FC JCs with wipQty != PO.quantity: ${wipQtyMismatch.length}`);
  if (wipQtyMismatch.length > 0) console.log(JSON.stringify(wipQtyMismatch.slice(0, 5), null, 2));

  // 2. Orphan FC wip_items (no matching JC)
  const orphans = await sql`
    SELECT w.id, w.code, w.stock_qty
    FROM wip_items w
    WHERE w.code LIKE '%(FC)%'
      AND NOT EXISTS (SELECT 1 FROM job_cards jc WHERE jc.wip_label = w.code);
  `;
  console.log(`\n2. Orphan FC wip_items rows: ${orphans.length}`);
  for (const o of orphans.slice(0, 10)) console.log(`  ${o.code} qty=${o.stock_qty}`);

  // 3. FC JCs with no matching wip_items row (FC done but inventory missing)
  const missing = await sql`
    SELECT jc.id, jc.wip_label, jc.status, po.company_so_id
    FROM job_cards jc JOIN production_orders po ON po.id = jc.production_order_id
    WHERE jc.department_code = 'FAB_CUT'
      AND jc.wip_key LIKE '%::FAB_CUT'
      AND jc.status IN ('COMPLETED','TRANSFERRED')
      AND NOT EXISTS (SELECT 1 FROM wip_items w WHERE w.code = jc.wip_label);
  `;
  console.log(`\n3. Completed FC JCs with NO wip_items row: ${missing.length}`);
  for (const m of missing.slice(0, 10)) console.log(`  ${m.company_so_id} ${m.wip_label}`);

  // 4. FC wip_items rows where stock_qty doesn't match JC state (per-set)
  const stock = await sql`
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
      FROM groups g GROUP BY g.fc_label
    )
    SELECT e.fc_label, e.expected_qty, w.stock_qty AS actual_qty
    FROM expected e LEFT JOIN wip_items w ON w.code = e.fc_label
    WHERE COALESCE(w.stock_qty, 0) <> e.expected_qty;
  `;
  console.log(`\n4. FC wip_items stock_qty MISMATCH with JC state: ${stock.length}`);
  for (const s of stock.slice(0, 10)) console.log(`  expected=${s.expected_qty} actual=${s.actual_qty}  ${s.fc_label}`);

  // 5. Negative stock from old data
  const negs = await sql`SELECT id, code, stock_qty FROM wip_items WHERE code LIKE '%(FC)%' AND stock_qty < 0;`;
  console.log(`\n5. Negative-stock FC rows (legitimate stubs): ${negs.length}`);
  for (const n of negs.slice(0, 10)) console.log(`  qty=${n.stock_qty}  ${n.code}`);

  console.log("\n============ DONE ============");
} finally { await sql.end(); }
