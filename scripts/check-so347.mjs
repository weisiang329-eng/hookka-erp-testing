import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";

const sql = postgres(
  stagingUrl(),
  { ssl: "require", max: 1, idle_timeout: 5 },
);

try {
  console.log("=== 1. SO-2604-347-01 — exact match on company_so_id ===");
  const r1 = await sql`
    SELECT id, company_so_id, sales_order_id, line_no, product_code,
           fabric_code, item_category
    FROM production_orders
    WHERE company_so_id = 'SO-2604-347-01'
    ORDER BY id;
  `;
  console.log(`rows: ${r1.length}`);
  console.log(JSON.stringify(r1, null, 2));

  console.log("\n=== 2. Search anything LIKE %347-01% (in case field is line_no separate) ===");
  const r2 = await sql`
    SELECT id, company_so_id, sales_order_id, line_no, product_code,
           fabric_code, item_category
    FROM production_orders
    WHERE company_so_id LIKE '%347%' OR company_so_id LIKE '%2604-347%'
    ORDER BY company_so_id, line_no
    LIMIT 30;
  `;
  console.log(JSON.stringify(r2, null, 2));

  console.log("\n=== 3. JCs for those POs ===");
  const r3 = await sql`
    SELECT po.company_so_id, po.line_no, po.product_code, po.item_category,
           jc.department_code, jc.wip_key, jc.wip_label, jc.status,
           jc.completed_date, jc.due_date
    FROM production_orders po
    LEFT JOIN job_cards jc ON jc.production_order_id = po.id
    WHERE po.company_so_id LIKE '%2604-347%'
    ORDER BY po.company_so_id, po.line_no, jc.department_code;
  `;
  console.log(`JC rows: ${r3.length}`);
  console.log(JSON.stringify(r3.slice(0, 30), null, 2));
} finally {
  await sql.end();
}
