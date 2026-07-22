// Read-only: the 21 zero-priced lines that sit on invoices carrying a total —
// free replacements, or a price someone forgot to enter?
//
// Usage: $env:DATABASE_URL="postgresql://…"; node scripts/audit-underbilled-2026-07-22.mjs
import postgres from "postgres";
import fs from "node:fs";

let url = process.env.DATABASE_URL;
if (!url) {
  const s = fs.readFileSync(new URL("./audit-wip-both-dbs.mjs", import.meta.url), "utf8");
  const m = s.match(/"(postgresql:\/\/[^"]*vpwdqtsxexpiqxzweivd[^"]*)"/);
  if (m) url = m[1];
}
if (!url) throw new Error("set DATABASE_URL");
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 20 });
const rm = (s) => `RM ${(Number(s || 0) / 100).toFixed(2)}`;

const targets = ["INV-2607-047", "INV-2607-046", "INV-2607-054", "INV-2607-027", "INV-2607-038"];
for (const no of targets) {
  const inv = (await sql`
    SELECT i.*, so.is_service_order, so.company_so_id AS so_code
      FROM invoices i LEFT JOIN sales_orders so ON so.id = i.sales_order_id
     WHERE i.invoice_no = ${no}`)[0];
  if (!inv) continue;
  console.log(`\n### ${no}  ${inv.customer_name}  total ${rm(inv.total_sen)}  DO=${inv.do_no}  SO=${inv.company_so_id}  service=${inv.is_service_order}`);
  for (const ii of await sql`
    SELECT product_code, size_label, fabric_code, quantity, unit_price_sen, production_order_id
      FROM invoice_items WHERE invoice_id = ${inv.id} ORDER BY id`)
    console.log(`   ${ii.unit_price_sen === 0 ? "ZERO " : "     "}${ii.product_code} ${ii.size_label ?? ""} ${ii.fabric_code ?? ""} x${ii.quantity} @ ${rm(ii.unit_price_sen)}  poId=${ii.production_order_id ?? "—"}`);

  // What did the DO actually carry?
  const doRow = (await sql`SELECT id FROM delivery_orders WHERE do_no = ${inv.do_no}`)[0];
  if (!doRow) continue;
  console.log("   DO lines:");
  for (const di of await sql`
    SELECT product_code, size_label, quantity, po_no, production_order_id, sales_order_no
      FROM delivery_order_items WHERE delivery_order_id = ${doRow.id} ORDER BY id`) {
    const svc = di.production_order_id
      ? (await sql`
          SELECT po.service_order_id, po.sales_order_id
            FROM production_orders po WHERE po.id = ${di.production_order_id}`)[0]
      : null;
    console.log(
      `     ${di.product_code} ${di.size_label ?? ""} x${di.quantity} so=${di.sales_order_no} poId=${di.production_order_id ?? "—"}` +
        (svc?.service_order_id ? `  ← SERVICE ORDER ${svc.service_order_id}` : ""),
    );
  }
}
await sql.end();
