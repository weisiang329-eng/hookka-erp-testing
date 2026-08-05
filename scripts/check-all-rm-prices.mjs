// Dump latest PO unit price for every raw_materials code, grouped by item_group.
import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
const sql = postgres(
  prodUrl(),
  { ssl: "require", max: 1, idle_timeout: 5 },
);
try {
  const rm = await sql`
    SELECT item_code, description, item_group, base_uom, balance_qty
      FROM raw_materials
     WHERE COALESCE(is_active, 1) <> 0
     ORDER BY item_group, item_code
  `;
  // Latest PO unit price per supplier_sku
  const lines = await sql`
    SELECT DISTINCT ON (poi.supplier_sku)
           poi.supplier_sku,
           poi.unit_price_sen,
           poi.unit,
           po.order_date,
           po.supplier_name
      FROM purchase_order_items poi
      JOIN purchase_orders po ON po.id = poi.purchase_order_id
     WHERE poi.supplier_sku IS NOT NULL
     ORDER BY poi.supplier_sku, po.order_date DESC NULLS LAST
  `;
  const priceByCode = new Map(lines.map(l => [l.supplier_sku, l]));

  // Group by item_group
  const byGroup = new Map();
  for (const r of rm) {
    const g = r.item_group ?? "(NO GROUP)";
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(r);
  }
  const groups = [...byGroup.keys()].sort();

  let totalCodes = 0, withPrice = 0;
  for (const g of groups) {
    const rows = byGroup.get(g);
    console.log(`\n========== ${g}  (${rows.length} codes) ==========`);
    for (const r of rows) {
      totalCodes++;
      const p = priceByCode.get(r.item_code);
      const price = p?.unit_price_sen != null ? `RM ${(p.unit_price_sen/100).toFixed(2)}` : "—";
      const date  = p?.order_date ?? "—";
      const supp  = p?.supplier_name ?? "—";
      if (p?.unit_price_sen != null) withPrice++;
      console.log(`  ${r.item_code.padEnd(28)} ${(r.description ?? "").slice(0,55).padEnd(55)} uom=${(r.base_uom ?? "—").padEnd(5)} ${price.padEnd(11)} (${date}) ${supp}`);
    }
  }
  console.log(`\n=== Summary ===`);
  console.log(`  Groups : ${groups.length}`);
  console.log(`  Codes  : ${totalCodes}`);
  console.log(`  Priced : ${withPrice}`);
  console.log(`  No PO  : ${totalCodes - withPrice}`);
} finally { await sql.end(); }
