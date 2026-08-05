// Investigate why SO-2603-157-01 appears twice in the Production sheet.
// Hypothesis: two separate sales_orders rows share company_so_id=SO-2603-157
// and each one fans out -01/-02 POs.
import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";

const url =
  stagingUrl();

const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

try {
  console.log("=== sales_orders rows for SO-2603-157 ===");
  const so = await sql`
    SELECT id, company_so_id, customer_id, status, created_at
    FROM sales_orders
    WHERE company_so_id = 'SO-2603-157'
    ORDER BY created_at;
  `;
  console.log(JSON.stringify(so, null, 2));

  console.log("\n=== production_orders for SO-2603-157 ===");
  const po = await sql`
    SELECT po.id, po.sales_order_id, po.company_so_id, po.line_no,
           po.product_code, po.size_label, po.fabric_code, po.item_category
    FROM production_orders po
    WHERE po.company_so_id = 'SO-2603-157'
    ORDER BY po.sales_order_id, po.line_no;
  `;
  console.log(JSON.stringify(po, null, 2));

  console.log("\n=== Count ALL company_so_ids that have multiple sales_orders rows ===");
  const dupSO = await sql`
    SELECT company_so_id, COUNT(*) AS so_rows
    FROM sales_orders
    WHERE company_so_id IS NOT NULL
    GROUP BY company_so_id
    HAVING COUNT(*) >= 2
    ORDER BY company_so_id
    LIMIT 50;
  `;
  console.log(`SOs with multiple sales_orders rows: ${dupSO.length}`);
  console.log(JSON.stringify(dupSO, null, 2));

  console.log("\n=== Same line_no within same company_so_id (the actual duplicate driver) ===");
  const dupLine = await sql`
    WITH lined AS (
      SELECT po.company_so_id, po.line_no, po.id AS po_id, po.sales_order_id,
             po.product_code, po.fabric_code
      FROM production_orders po
      WHERE po.company_so_id IS NOT NULL
    ),
    dup AS (
      SELECT company_so_id, line_no, COUNT(*) AS po_count
      FROM lined
      GROUP BY company_so_id, line_no
      HAVING COUNT(*) >= 2
    )
    SELECT l.company_so_id, l.line_no, l.po_id, l.sales_order_id, l.product_code, l.fabric_code
    FROM lined l
    JOIN dup d ON d.company_so_id = l.company_so_id AND d.line_no = l.line_no
    ORDER BY l.company_so_id, l.line_no, l.sales_order_id
    LIMIT 50;
  `;
  console.log(`Rows in (company_so_id, line_no) collisions: ${dupLine.length}`);
  console.log(JSON.stringify(dupLine, null, 2));

} finally {
  await sql.end();
}
