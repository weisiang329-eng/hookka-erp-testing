import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
const sql = postgres(prodUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  console.log("=== PROD sofa POs sizeLabel sample ===");
  const r = await sql`
    SELECT product_code, size_code, size_label, fabric_code, item_category
    FROM production_orders
    WHERE item_category = 'SOFA'
      AND product_code LIKE '5531%'
    ORDER BY company_so_id DESC
    LIMIT 12;
  `;
  console.log(JSON.stringify(r, null, 2));

  console.log("\n=== PROD sofa items sample (sales_order_items) ===");
  const r2 = await sql`
    SELECT product_code, size_code, size_label, fabric_code, gap_inches
    FROM sales_order_items
    WHERE product_code LIKE '5531-2A(LHF)' OR product_code LIKE '5531-L(RHF)' OR product_code LIKE '5530-2A(LHF)'
    LIMIT 10;
  `;
  console.log(JSON.stringify(r2, null, 2));
} finally { await sql.end(); }
