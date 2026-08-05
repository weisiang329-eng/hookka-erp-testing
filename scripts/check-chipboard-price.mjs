// Look up chipboard unit prices from raw_materials + recent PO line items.
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
     WHERE description ILIKE '%chipboard%'
        OR description ILIKE '%chip board%'
        OR description ILIKE '%particle%'
        OR item_code ILIKE '%chip%'
        OR item_code ILIKE '%CB%'
        OR item_group ILIKE '%chip%'
     ORDER BY item_group, item_code
  `;
  console.log(`\n=== raw_materials matching chipboard (${rm.length}) ===`);
  for (const r of rm) {
    console.log(`  ${r.item_code.padEnd(28)} ${(r.description ?? "").padEnd(48)} grp=${(r.item_group ?? "—").padEnd(14)} uom=${r.base_uom ?? "—"}  bal=${r.balance_qty}`);
  }

  if (rm.length === 0) {
    console.log("\n  no chipboard codes found.");
  } else {
    const codes = rm.map(r => r.item_code);
    const lines = await sql`
      SELECT poi.supplier_sku,
             poi.unit_price_sen,
             poi.unit,
             po.order_date,
             po.po_no,
             po.supplier_name
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.id = poi.purchase_order_id
       WHERE poi.supplier_sku = ANY(${codes})
       ORDER BY poi.supplier_sku, po.order_date DESC
       LIMIT 500
    `;
    const latestByCode = new Map();
    for (const l of lines) {
      if (!latestByCode.has(l.supplier_sku)) latestByCode.set(l.supplier_sku, l);
    }
    console.log(`\n=== Latest PO unit price per chipboard code ===`);
    for (const code of codes) {
      const l = latestByCode.get(code);
      if (!l) { console.log(`  ${code.padEnd(28)} no PO history`); continue; }
      const price = l.unit_price_sen != null ? `RM ${(l.unit_price_sen/100).toFixed(2)}` : "—";
      console.log(`  ${code.padEnd(28)} ${price.padEnd(12)} uom=${l.unit ?? "—"}  date=${l.order_date}  PO=${l.po_no}  supplier=${l.supplier_name}`);
    }
  }
} finally { await sql.end(); }
