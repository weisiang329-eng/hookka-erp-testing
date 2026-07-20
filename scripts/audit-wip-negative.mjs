import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
// Read-only audit: scan wip_items for negative or zero stock_qty.
// Also cross-checks job_cards.wip_qty for negatives just in case.
import postgres from "postgres";

const url =
  requiredDatabaseUrl("STAGING_DATABASE_URL");

const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

try {
  console.log("=== wip_items totals ===");
  const totals = await sql`
    SELECT
      COUNT(*) AS total_rows,
      COUNT(*) FILTER (WHERE stock_qty < 0)  AS negative_rows,
      COUNT(*) FILTER (WHERE stock_qty = 0)  AS zero_rows,
      COUNT(*) FILTER (WHERE stock_qty > 0)  AS positive_rows,
      MIN(stock_qty) AS min_qty,
      MAX(stock_qty) AS max_qty,
      SUM(stock_qty) AS sum_qty
    FROM wip_items;
  `;
  console.log(JSON.stringify(totals[0], null, 2));

  console.log("\n=== Negative wip_items by type / status ===");
  const byTypeStatus = await sql`
    SELECT type, status, COUNT(*) AS n, MIN(stock_qty) AS worst, SUM(stock_qty) AS sum_qty
    FROM wip_items
    WHERE stock_qty < 0
    GROUP BY type, status
    ORDER BY n DESC;
  `;
  console.log(JSON.stringify(byTypeStatus, null, 2));

  console.log("\n=== All negative wip_items (full list, ordered by worst first) ===");
  const negatives = await sql`
    SELECT id, code, type, related_product, dept_status, stock_qty, status
    FROM wip_items
    WHERE stock_qty < 0
    ORDER BY stock_qty ASC, code ASC;
  `;
  console.log(`Total negative rows: ${negatives.length}`);
  for (const r of negatives) {
    console.log(
      `  qty=${String(r.stock_qty).padStart(5)}  ${r.type.padEnd(10)}  ${r.status.padEnd(12)}  ${r.code}  (rel=${r.related_product ?? "-"}, dept=${r.dept_status ?? "-"})`,
    );
  }

  console.log("\n=== Cross-check: job_cards.wip_qty negatives ===");
  const jcNeg = await sql`
    SELECT COUNT(*) AS n,
           MIN(wip_qty) AS worst,
           COUNT(*) FILTER (WHERE wip_qty < 0) AS negative_jcs
    FROM job_cards;
  `;
  console.log(JSON.stringify(jcNeg[0], null, 2));

  if (Number(jcNeg[0].negative_jcs) > 0) {
    const jcDetail = await sql`
      SELECT jc.id, jc.wip_label, jc.wip_qty, jc.department_code,
             po.company_so_id, po.product_code, po.line_no
      FROM job_cards jc
      JOIN production_orders po ON po.id = jc.production_order_id
      WHERE jc.wip_qty < 0
      ORDER BY jc.wip_qty ASC;
    `;
    for (const r of jcDetail) {
      console.log(
        `  qty=${String(r.wip_qty).padStart(5)}  ${(r.department_code ?? "").padEnd(12)}  ${r.company_so_id ?? "-"}  L${r.line_no}  ${r.product_code}  ${r.wip_label}`,
      );
    }
  }

  console.log("\n=== Cross-check: stock_movements net per wip code (sanity, top 20 deepest negatives) ===");
  const moveNet = await sql`
    SELECT ref_id,
           SUM(CASE WHEN movement_type = 'IN'  THEN qty ELSE 0 END) AS qty_in,
           SUM(CASE WHEN movement_type = 'OUT' THEN qty ELSE 0 END) AS qty_out,
           SUM(CASE WHEN movement_type = 'IN'  THEN qty ELSE 0 END)
             - SUM(CASE WHEN movement_type = 'OUT' THEN qty ELSE 0 END) AS net
    FROM stock_movements
    WHERE ref_type = 'WIP_ITEM'
    GROUP BY ref_id
    HAVING SUM(CASE WHEN movement_type = 'IN'  THEN qty ELSE 0 END)
         - SUM(CASE WHEN movement_type = 'OUT' THEN qty ELSE 0 END) < 0
    ORDER BY net ASC
    LIMIT 20;
  `;
  console.log(`stock_movements rows with net negative: ${moveNet.length}`);
  for (const r of moveNet) {
    console.log(`  net=${String(r.net).padStart(5)}  in=${r.qty_in}  out=${r.qty_out}  wip_id=${r.ref_id}`);
  }
} finally {
  await sql.end();
}
