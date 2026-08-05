// Backfill: replay the SEW→FC consume for all historical data.
//
// Pre-Option-C, the cascade matched SEW JC to per-piece FC JC by wipKey.
// After Option C merge, FC JCs got new wipKeys (`{poId|companySOId}::baseModel::fabric::FAB_CUT`)
// that no per-piece SEW wipKey matches. So historical SEW completions
// never decremented the merged FC stock. Result: 225 FC rows in
// staging with positive stock that should be 0 (SEW already done).
//
// Per Option C dedup rule:
//   stock_qty per FC wipLabel = sum across all merge groups sharing the label of:
//     +1 if FC done AND no SEW done in this group
//     -1 if FC NOT done AND any SEW done in this group
//      0 otherwise (both done = consumed, both waiting = nothing)
//
// Run on staging now; same script will run on prod after merge to main.
import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";

const sql = postgres(
  stagingUrl(),
  { ssl: "require", max: 1, idle_timeout: 5 },
);

try {
  console.log("=== Step 1: Compute correct stock_qty per FC wipLabel ===");
  const correct = await sql`
    WITH fc_groups AS (
      SELECT
        jc.id AS fc_jc_id,
        jc.wip_label AS fc_label,
        jc.production_order_id AS fc_po_id,
        jc.status AS fc_status,
        po.company_so_id,
        po.fabric_code,
        po.item_category
      FROM job_cards jc
      JOIN production_orders po ON po.id = jc.production_order_id
      WHERE jc.department_code = 'FAB_CUT' AND jc.wip_key LIKE '%::FAB_CUT'
    ),
    sew_status AS (
      SELECT
        fg.fc_jc_id,
        fg.fc_label,
        fg.fc_status,
        EXISTS (
          SELECT 1 FROM job_cards jc2
          JOIN production_orders po2 ON po2.id = jc2.production_order_id
          WHERE jc2.department_code = 'FAB_SEW'
            AND jc2.status IN ('COMPLETED','TRANSFERRED')
            AND CASE WHEN fg.item_category = 'SOFA'
                     THEN po2.company_so_id = fg.company_so_id AND po2.fabric_code = fg.fabric_code
                     ELSE po2.id = fg.fc_po_id
                END
        ) AS any_sew_done
      FROM fc_groups fg
    )
    SELECT
      fc_label,
      SUM(
        CASE
          WHEN fc_status IN ('COMPLETED','TRANSFERRED') AND NOT any_sew_done THEN 1
          WHEN fc_status NOT IN ('COMPLETED','TRANSFERRED') AND any_sew_done THEN -1
          ELSE 0
        END
      )::int AS correct_qty
    FROM sew_status
    GROUP BY fc_label;
  `;
  console.log(`Computed ${correct.length} unique FC labels`);

  console.log("\n=== Step 2: Compare to current wip_items.stock_qty ===");
  let mismatches = 0;
  let createdRows = 0;
  let updatedRows = 0;
  for (const c of correct) {
    const cur = await sql`SELECT id, stock_qty FROM wip_items WHERE code = ${c.fc_label};`;
    if (cur.length === 0) {
      // No wip_items row exists. Create if correct_qty != 0.
      if (c.correct_qty !== 0) {
        const isFcDone = c.correct_qty > 0;
        // Use random uuid suffix to avoid id collisions (Buffer hex of
        // wipLabel hits dupes when many labels share the model prefix).
        const id = 'wip-fc-' + Math.random().toString(36).slice(2, 18);
        await sql`
          INSERT INTO wip_items (id, code, type, related_product, dept_status, stock_qty, status, org_id)
          VALUES (
            ${id},
            ${c.fc_label},
            'BEDFRAME',
            ${(c.fc_label.split(' | ')[0] || '').trim()},
            ${isFcDone ? 'FAB_CUT' : 'PENDING'},
            ${c.correct_qty},
            ${isFcDone ? 'COMPLETED' : 'PENDING'},
            'hookka'
          )
          ON CONFLICT (org_id, code) DO UPDATE SET stock_qty = EXCLUDED.stock_qty;
        `;
        createdRows++;
      }
      continue;
    }
    const row = cur[0];
    if (Number(row.stock_qty) !== c.correct_qty) {
      mismatches++;
      await sql`UPDATE wip_items SET stock_qty = ${c.correct_qty} WHERE id = ${row.id};`;
      updatedRows++;
    }
  }
  console.log(`Mismatches found: ${mismatches}`);
  console.log(`Updated: ${updatedRows}`);
  console.log(`Created: ${createdRows}`);

  console.log("\n=== Step 3: Verify final distribution ===");
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
} finally {
  await sql.end();
}
