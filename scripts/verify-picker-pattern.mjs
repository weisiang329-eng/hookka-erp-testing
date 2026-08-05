// Verify the picker pattern: for a BF SO with multiple POs (HB+DV), confirm
// only ONE of those POs holds the merged FC JC; the others rely on picker
// fallback. This is what commit 19c7aee fixes for BF/ACC.
import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";

const url =
  stagingUrl();

const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

try {
  // 1. Pick 5 BF SOs with multiple POs in same SOID and check FC JC
  // distribution.
  console.log("=== BF SOs with multi-PO distribution (FC JC sits on which) ===");
  const bfSample = await sql`
    WITH multi_po_so AS (
      SELECT po.company_so_id, COUNT(DISTINCT po.id) AS po_count
      FROM production_orders po
      WHERE po.item_category = 'BEDFRAME' AND po.company_so_id IS NOT NULL
      GROUP BY po.company_so_id
      HAVING COUNT(DISTINCT po.id) >= 2
      ORDER BY po.company_so_id
      LIMIT 5
    )
    SELECT po.company_so_id, po.id AS po_id, po.product_code, po.size_label,
           po.gap_inches, po.divan_height_inches,
           jc.id AS fc_jc_id, jc.wip_label, jc.status
    FROM multi_po_so m
    JOIN production_orders po ON po.company_so_id = m.company_so_id
    LEFT JOIN job_cards jc ON jc.production_order_id = po.id
                            AND jc.department_code = 'FAB_CUT'
    ORDER BY po.company_so_id, po.id;
  `;
  for (const r of bfSample) {
    console.log(
      `${r.company_so_id} | po=${r.po_id.slice(-12)} | ${r.product_code} | DV=${r.divan_height_inches ?? '-'} | FC=${r.fc_jc_id ? r.fc_jc_id.slice(-12) : 'NONE'} | ${r.wip_label ?? '-'}`,
    );
  }

  // 2. Compare a SOFA SO with multiple lines/products
  console.log("\n=== SOFA SOs with multi-PO distribution (cross-PO merge by baseModel+fabric) ===");
  const sofaSample = await sql`
    WITH multi_po_so AS (
      SELECT po.company_so_id, COUNT(DISTINCT po.id) AS po_count
      FROM production_orders po
      WHERE po.item_category = 'SOFA' AND po.company_so_id IS NOT NULL
      GROUP BY po.company_so_id
      HAVING COUNT(DISTINCT po.id) >= 3
      ORDER BY po.company_so_id
      LIMIT 3
    )
    SELECT po.company_so_id, po.id AS po_id, po.product_code, po.fabric_code,
           jc.id AS fc_jc_id, jc.wip_label, jc.status
    FROM multi_po_so m
    JOIN production_orders po ON po.company_so_id = m.company_so_id
    LEFT JOIN job_cards jc ON jc.production_order_id = po.id
                            AND jc.department_code = 'FAB_CUT'
    ORDER BY po.company_so_id, po.id;
  `;
  for (const r of sofaSample) {
    console.log(
      `${r.company_so_id} | po=${r.po_id.slice(-12)} | ${r.product_code} | fabric=${r.fabric_code} | FC=${r.fc_jc_id ? r.fc_jc_id.slice(-12) : 'NONE'} | ${r.wip_label ?? '-'}`,
    );
  }

  // 3. Verify FAB_SEW JCs exist for the same SOs (downstream visibility test)
  console.log("\n=== FAB_SEW JCs that need to find their merged FC ===");
  const sewSample = await sql`
    WITH multi_po_so AS (
      SELECT po.company_so_id
      FROM production_orders po
      WHERE po.item_category = 'BEDFRAME' AND po.company_so_id IS NOT NULL
      GROUP BY po.company_so_id
      HAVING COUNT(DISTINCT po.id) >= 2
      ORDER BY po.company_so_id
      LIMIT 3
    )
    SELECT po.company_so_id, po.id AS po_id, po.product_code,
           SUM(CASE WHEN jc.department_code = 'FAB_CUT' THEN 1 ELSE 0 END) AS fc,
           SUM(CASE WHEN jc.department_code = 'FAB_SEW' THEN 1 ELSE 0 END) AS sew,
           SUM(CASE WHEN jc.department_code = 'FRAME' THEN 1 ELSE 0 END) AS frame
    FROM multi_po_so m
    JOIN production_orders po ON po.company_so_id = m.company_so_id
    LEFT JOIN job_cards jc ON jc.production_order_id = po.id
    GROUP BY po.company_so_id, po.id, po.product_code
    ORDER BY po.company_so_id, po.id;
  `;
  for (const r of sewSample) {
    console.log(
      `${r.company_so_id} | po=${r.po_id.slice(-12)} | ${r.product_code} | FC=${r.fc} SEW=${r.sew} FRAME=${r.frame}`,
    );
  }

} finally {
  await sql.end();
}
