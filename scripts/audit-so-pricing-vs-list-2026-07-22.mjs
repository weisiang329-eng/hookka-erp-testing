// Read-only system audit of SO pricing against the agreed price lists.
//
// The owner's framing: "SO 那邊對的話 invoice 就對了" — so the SO line is the
// control point. This checks every live non-service SO line against:
//
//   1. the customer's own agreed base price (customer_product_prices as of the
//      SO date, falling back to customer_products, then product_prices)
//   2. the sofa combo rules (sofa_combo_rules — a priced SET, not the sum of
//      its pieces)
//
// Split by entry path, because the base price on a scanned PO is read off the
// customer's PDF while a typed order is priced from our list — the API only
// consults the price list when the client posts basePriceSen = 0
// (sales-orders.ts:2276).
//
// Usage: $env:DATABASE_URL="postgresql://…"; node scripts/audit-so-pricing-vs-list-2026-07-22.mjs
import postgres from "postgres";
import fs from "node:fs";

let url = process.env.DATABASE_URL;
if (!url) {
  const s = fs.readFileSync(new URL("./audit-wip-both-dbs.mjs", import.meta.url), "utf8");
  const m = s.match(/"(postgresql:\/\/[^"]*vpwdqtsxexpiqxzweivd[^"]*)"/);
  if (m) url = m[1];
}
if (!url) throw new Error("set DATABASE_URL");
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 30 });
const rm = (s) => `RM ${(Number(s || 0) / 100).toLocaleString("en-MY", { minimumFractionDigits: 2 })}`;

// ---------------------------------------------------------------------------
// 1. base price vs the customer's agreed price
// ---------------------------------------------------------------------------
const rows = await sql`
  SELECT so.company_so_id, so.customer_id, so.customer_name, so.status,
         LEFT(so.company_so_date::text, 10) AS so_date,
         (so.customer_po_image_b64 IS NOT NULL) AS from_scan,
         soi.line_no, soi.product_code, soi.item_category, soi.size_label,
         soi.quantity, soi.base_price_sen,
         cp.base_price_sen AS cp_now,
         (SELECT cpp.base_price_sen
            FROM customer_product_prices cpp
           WHERE cpp.customer_product_id = cp.id
             AND cpp.effective_from <= COALESCE(so.company_so_date::text, '9999')
           ORDER BY cpp.effective_from DESC LIMIT 1) AS cp_asof,
         p.base_price_sen AS product_price
    FROM sales_order_items soi
    JOIN sales_orders so ON so.id = soi.sales_order_id
    LEFT JOIN products p ON p.code = soi.product_code
    LEFT JOIN customer_products cp ON cp.customer_id = so.customer_id AND cp.product_id = p.id
   WHERE so.status <> 'CANCELLED' AND NOT COALESCE(so.is_service_order, false)
     AND COALESCE(soi.item_category, '') <> 'SOFA'   -- sofas priced by combo, checked below
   ORDER BY so.company_so_id, soi.line_no`;

const diffs = [];
for (const r of rows) {
  const want = r.cp_asof ?? r.cp_now ?? r.product_price;
  if (want == null) continue;
  const got = Number(r.base_price_sen || 0);
  if (got === Number(want)) continue;
  diffs.push({ ...r, want: Number(want), delta: (got - Number(want)) * Number(r.quantity || 1) });
}
const under = diffs.filter((d) => d.delta < 0);
const over = diffs.filter((d) => d.delta > 0);
console.log("=== 1. BEDFRAME/other base price vs the customer's agreed price ===");
console.log(`   ${rows.length} lines checked, ${diffs.length} differ`);
console.log(`   billed BELOW the list: ${under.length} lines, ${rm(-under.reduce((t, d) => t + d.delta, 0))}`);
console.log(`   billed ABOVE the list: ${over.length} lines, ${rm(over.reduce((t, d) => t + d.delta, 0))}`);
const byPath = (arr) => {
  const s = arr.filter((d) => d.from_scan).length;
  return `${s} scanned / ${arr.length - s} typed`;
};
console.log(`   under-billed by entry path: ${byPath(under)}`);
console.log(`   over-billed  by entry path: ${byPath(over)}`);
console.log("\n   worst 20 under-billed:");
for (const d of under.sort((a, b) => a.delta - b.delta).slice(0, 20))
  console.log(
    `     ${d.company_so_id} L${d.line_no} ${String(d.product_code).padEnd(18)} ${d.customer_name.padEnd(16)} ` +
      `scan=${d.from_scan} charged ${rm(d.base_price_sen)} vs list ${rm(d.want)} x${d.quantity} = ${rm(d.delta)}`,
  );

// ---------------------------------------------------------------------------
// 2. sofa combos — is the SET price being used?
// ---------------------------------------------------------------------------
console.log("\n=== 2. SOFA lines: combo rules on prod ===");
for (const r of await sql`
  SELECT customer_id, COUNT(*)::int rules, MIN(effective_from) AS from_, MAX(effective_from) AS to_
    FROM sofa_combo_rules GROUP BY 1 ORDER BY 1`)
  console.log(`   ${r.customer_id}: ${r.rules} rules, effective ${r.from_} … ${r.to_}`);

const sofa = await sql`
  SELECT so.company_so_id, so.customer_id, so.customer_name, so.status,
         (so.customer_po_image_b64 IS NOT NULL) AS from_scan,
         soi.line_no, soi.product_code, soi.size_label, soi.base_price_sen, soi.quantity
    FROM sales_order_items soi JOIN sales_orders so ON so.id = soi.sales_order_id
   WHERE so.status <> 'CANCELLED' AND NOT COALESCE(so.is_service_order, false)
     AND soi.item_category = 'SOFA'
   ORDER BY so.company_so_id, soi.line_no`;
const zeroSofa = sofa.filter((s) => Number(s.base_price_sen || 0) === 0);
console.log(`   ${sofa.length} live sofa lines; ${zeroSofa.length} priced at RM 0`);
const scanSofa = sofa.filter((s) => s.from_scan).length;
console.log(`   entry path: ${scanSofa} scanned / ${sofa.length - scanSofa} typed`);
for (const s of zeroSofa.slice(0, 15))
  console.log(`     RM0: ${s.company_so_id} L${s.line_no} ${s.product_code} ${s.size_label ?? ""} (${s.status}, scan=${s.from_scan})`);
await sql.end();
