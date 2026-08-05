// Export latest PO unit price for every active raw_materials code as CSV.
// Output: scripts/out/raw-materials-prices-2026-05-09.csv
import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const sql = postgres(
  prodUrl(),
  { ssl: "require", max: 1, idle_timeout: 5 },
);
const OUT = "scripts/out/raw-materials-prices-2026-05-09.csv";

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

try {
  const rm = await sql`
    SELECT item_code, description, item_group, base_uom, balance_qty
      FROM raw_materials
     WHERE COALESCE(is_active, 1) <> 0
     ORDER BY item_group, item_code
  `;
  const lines = await sql`
    SELECT DISTINCT ON (poi.supplier_sku)
           poi.supplier_sku, poi.unit_price_sen, poi.unit,
           po.order_date, po.supplier_name
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
     WHERE poi.supplier_sku IS NOT NULL
     ORDER BY poi.supplier_sku, po.order_date DESC NULLS LAST
  `;
  const priceByCode = new Map(lines.map(l => [l.supplier_sku, l]));

  const headers = ["Group", "Code", "Description", "UOM", "Balance", "Latest Price (RM)", "PO UOM", "PO Date", "Supplier"];
  const rows = [headers.map(csvEscape).join(",")];
  let priced = 0, missing = 0;

  for (const r of rm) {
    const p = priceByCode.get(r.item_code);
    const priceRM = p?.unit_price_sen != null ? (p.unit_price_sen / 100).toFixed(2) : "";
    if (priceRM) priced++; else missing++;
    rows.push([
      r.item_group ?? "",
      r.item_code,
      r.description ?? "",
      r.base_uom ?? "",
      r.balance_qty ?? "",
      priceRM,
      p?.unit ?? "",
      p?.order_date ?? "",
      p?.supplier_name ?? "",
    ].map(csvEscape).join(","));
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, rows.join("\n") + "\n", "utf8");
  console.log(`Wrote ${rm.length} rows → ${OUT}`);
  console.log(`  priced: ${priced}`);
  console.log(`  no PO history: ${missing}`);
} finally { await sql.end(); }
