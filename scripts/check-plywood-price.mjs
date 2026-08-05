// Look up plywood unit price from raw_materials catalog + recent PO line items.
import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
const sql = postgres(
  prodUrl(),
  { ssl: "require", max: 1, idle_timeout: 5 },
);
try {
  // 1. raw_materials catalog rows that look like plywood
  const rm = await sql`
    SELECT item_code, description, item_group, base_uom, balance_qty, item_type
      FROM raw_materials
     WHERE description ILIKE '%plywood%'
        OR description ILIKE '%ply wood%'
        OR description ILIKE '%PLY%'
        OR item_code ILIKE '%plywood%'
        OR item_code ILIKE '%PLY%'
     ORDER BY item_code
  `;
  console.log(`\n=== raw_materials matching plywood (${rm.length}) ===`);
  for (const r of rm) {
    console.log(`  ${r.item_code.padEnd(24)} ${(r.description ?? "").padEnd(40)} grp=${r.item_group ?? "—"}  uom=${r.base_uom ?? "—"}  bal=${r.balance_qty}`);
  }

  if (rm.length === 0) {
    console.log("\n  no plywood codes found.");
  } else {
    const codes = rm.map(r => r.item_code);
    // PO lines join on supplier_sku (item code) — recent ones first
    const lines = await sql`
      SELECT poi.supplier_sku,
             poi.material_name,
             poi.unit_price_sen,
             poi.unit,
             poi.quantity,
             po.order_date,
             po.po_no,
             po.supplier_name
        FROM purchase_order_items poi
        JOIN purchase_orders po ON po.id = poi.purchase_order_id
       WHERE poi.supplier_sku = ANY(${codes})
       ORDER BY poi.supplier_sku, po.order_date DESC
       LIMIT 300
    `;
    const latestByCode = new Map();
    for (const l of lines) {
      if (!latestByCode.has(l.supplier_sku)) latestByCode.set(l.supplier_sku, l);
    }
    console.log(`\n=== Latest PO unit price per plywood code ===`);
    for (const code of codes) {
      const l = latestByCode.get(code);
      if (!l) { console.log(`  ${code.padEnd(24)} no PO history`); continue; }
      const price = l.unit_price_sen != null ? `RM ${(l.unit_price_sen/100).toFixed(2)}` : "—";
      console.log(`  ${code.padEnd(24)} ${price.padEnd(12)} uom=${l.unit ?? "—"}  date=${l.order_date}  PO=${l.po_no}  supplier=${l.supplier_name}`);
    }
  }
} finally { await sql.end(); }
