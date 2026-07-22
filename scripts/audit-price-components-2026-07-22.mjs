// Read-only: are ALL the price components actually being charged?
//
// unit_price = base + divan + leg + special  (src/lib/pricing.ts; the frontend's
// totalHeightPriceSen is folded in before submission, so it has no column).
//
//   A. SO lines whose unit_price does not equal the sum of its components
//      → a surcharge exists on the line but was never charged
//   B. invoiced lines where the invoice unit price is below the SO unit price
//      → the SO is right but the invoice under-bills
//   C. lines with a divan / leg height chosen but a zero surcharge
//      → judgement call: free default height vs a missed charge
//
// Usage: $env:DATABASE_URL="postgresql://…"; node scripts/audit-price-components-2026-07-22.mjs
import postgres from "postgres";
import fs from "node:fs";

let url = process.env.DATABASE_URL;
if (!url) {
  const s = fs.readFileSync(new URL("./audit-wip-both-dbs.mjs", import.meta.url), "utf8");
  const m = s.match(/"(postgresql:\/\/[^"]*vpwdqtsxexpiqxzweivd[^"]*)"/);
  if (m) url = m[1];
}
if (!url) throw new Error("set DATABASE_URL");
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 25 });
const rm = (s) => `RM ${(Number(s || 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2 })}`;

console.log("=== A. SO lines where unit_price != base + divan + leg + special ===");
const a = await sql`
  SELECT so.company_so_id, so.status, so.customer_name, so.is_service_order,
         soi.line_no, soi.product_code, soi.quantity,
         soi.base_price_sen, soi.divan_price_sen, soi.leg_price_sen,
         soi.special_order_price_sen, soi.unit_price_sen,
         (COALESCE(soi.base_price_sen,0) + COALESCE(soi.divan_price_sen,0)
          + COALESCE(soi.leg_price_sen,0) + COALESCE(soi.special_order_price_sen,0)) AS sum_parts
    FROM sales_order_items soi
    JOIN sales_orders so ON so.id = soi.sales_order_id
   WHERE so.status <> 'CANCELLED'
     AND COALESCE(soi.unit_price_sen,0) <>
         (COALESCE(soi.base_price_sen,0) + COALESCE(soi.divan_price_sen,0)
          + COALESCE(soi.leg_price_sen,0) + COALESCE(soi.special_order_price_sen,0))
   ORDER BY so.company_so_id, soi.line_no`;
let under = 0, over = 0;
for (const r of a) {
  const d = Number(r.sum_parts) - Number(r.unit_price_sen);
  if (d > 0) under += d * Number(r.quantity || 1); else over += -d * Number(r.quantity || 1);
}
console.log(`  ${a.length} lines differ. Components exceed the charged price by ${rm(under)}; charged price exceeds components by ${rm(over)}.`);
for (const r of a.slice(0, 25))
  console.log(
    `   ${r.company_so_id} L${r.line_no} ${r.product_code} (${r.status}${r.is_service_order ? ", SERVICE" : ""}) ` +
      `base ${rm(r.base_price_sen)} + divan ${rm(r.divan_price_sen)} + leg ${rm(r.leg_price_sen)} + special ${rm(r.special_order_price_sen)} ` +
      `= ${rm(r.sum_parts)}  BUT unit = ${rm(r.unit_price_sen)}`,
  );
if (a.length > 25) console.log(`   … ${a.length - 25} more`);

console.log("\n=== B. invoiced lines where the INVOICE unit price is below the SO unit price ===");
const b = await sql`
  SELECT so.company_so_id, soi.line_no, soi.product_code, ii.quantity,
         soi.unit_price_sen AS so_unit, ii.unit_price_sen AS inv_unit,
         i.invoice_no, i.status, i.customer_name
    FROM sales_order_items soi
    JOIN sales_orders so ON so.id = soi.sales_order_id
    JOIN invoice_items ii
      ON ii.production_order_id = 'pord-' || so.id || '-' || LPAD(soi.line_no::text, 2, '0')
    JOIN invoices i ON i.id = ii.invoice_id
   WHERE i.status <> 'CANCELLED'
     AND COALESCE(ii.unit_price_sen,0) < COALESCE(soi.unit_price_sen,0)
   ORDER BY (COALESCE(soi.unit_price_sen,0) - COALESCE(ii.unit_price_sen,0)) DESC`;
const shortfall = b.reduce((t, r) => t + (Number(r.so_unit) - Number(r.inv_unit)) * Number(r.quantity || 1), 0);
console.log(`  ${b.length} lines, total under-billed ${rm(shortfall)}`);
for (const r of b.slice(0, 25))
  console.log(
    `   ${r.invoice_no} (${r.customer_name}, ${r.status}) ${r.company_so_id} L${r.line_no} ${r.product_code} x${r.quantity}: ` +
      `SO ${rm(r.so_unit)} vs INV ${rm(r.inv_unit)} → short ${rm((Number(r.so_unit) - Number(r.inv_unit)) * Number(r.quantity || 1))}`,
  );

console.log("\n=== C. a height was chosen but no surcharge was applied ===");
for (const r of await sql`
  SELECT so.is_service_order,
         COUNT(*) FILTER (WHERE COALESCE(soi.divan_height_inches,0) > 0 AND COALESCE(soi.divan_price_sen,0) = 0)::int AS divan_free,
         COUNT(*) FILTER (WHERE COALESCE(soi.leg_height_inches,0) > 0 AND COALESCE(soi.leg_price_sen,0) = 0)::int AS leg_free,
         COUNT(*) FILTER (WHERE COALESCE(soi.divan_height_inches,0) > 0)::int AS divan_total,
         COUNT(*) FILTER (WHERE COALESCE(soi.leg_height_inches,0) > 0)::int AS leg_total
    FROM sales_order_items soi JOIN sales_orders so ON so.id = soi.sales_order_id
   WHERE so.status <> 'CANCELLED' GROUP BY 1`)
  console.log(
    `  service=${r.is_service_order}: divan height set on ${r.divan_total} lines, ${r.divan_free} with RM 0 surcharge; ` +
      `leg height set on ${r.leg_total}, ${r.leg_free} with RM 0`,
  );

console.log("\n  distinct divan heights and what they were charged (non-service, live SOs):");
for (const r of await sql`
  SELECT soi.divan_height_inches AS h, soi.divan_price_sen AS p, COUNT(*)::int n
    FROM sales_order_items soi JOIN sales_orders so ON so.id = soi.sales_order_id
   WHERE so.status <> 'CANCELLED' AND NOT COALESCE(so.is_service_order, false)
     AND COALESCE(soi.divan_height_inches,0) > 0
   GROUP BY 1,2 ORDER BY 1,2`)
  console.log(`     divan ${r.h}"  →  ${rm(r.p)}  × ${r.n} lines`);
await sql.end();
