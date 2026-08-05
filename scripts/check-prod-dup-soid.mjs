// Check if prod has the same duplicate sales_orders rows as staging.
import postgres from "postgres";
import { prodUrl } from "./_db.mjs";

const url =
  prodUrl();

const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

try {
  console.log("=== PROD: company_so_ids with multiple sales_orders rows ===");
  const dups = await sql`
    SELECT company_so_id, COUNT(*) AS so_rows,
           STRING_AGG(id, ',' ORDER BY created_at) AS so_ids,
           STRING_AGG(created_at::text, ',' ORDER BY created_at) AS created_ats
    FROM sales_orders
    WHERE company_so_id IS NOT NULL
    GROUP BY company_so_id
    HAVING COUNT(*) >= 2
    ORDER BY company_so_id;
  `;
  console.log(`Total duplicates: ${dups.length}`);
  console.log(JSON.stringify(dups, null, 2));

  console.log("\n=== PROD: PO line_no collisions per company_so_id ===");
  const lines = await sql`
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
    SELECT l.company_so_id, l.line_no, l.po_id, l.sales_order_id,
           l.product_code, l.fabric_code
    FROM lined l
    JOIN dup d ON d.company_so_id = l.company_so_id AND d.line_no = l.line_no
    ORDER BY l.company_so_id, l.line_no, l.sales_order_id;
  `;
  console.log(`PROD PO row collisions: ${lines.length}`);
  console.log(JSON.stringify(lines, null, 2));

} finally {
  await sql.end();
}
