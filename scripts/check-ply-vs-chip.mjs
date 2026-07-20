import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("PROD_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const rm = await sql`
    SELECT item_code, description, item_group, base_uom, balance_qty
      FROM raw_materials
     WHERE item_group IN ('PLYWOOD','OTHERS','EQUIPMEN','B.OTHERS')
       AND (description ILIKE '%plywood%' OR description ILIKE '%chipboard%' OR description ILIKE '%MDF%')
     ORDER BY item_group, item_code
  `;
  const lines = await sql`
    SELECT DISTINCT ON (poi.supplier_sku) poi.supplier_sku, poi.unit_price_sen, po.order_date, po.supplier_name
      FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.purchase_order_id
     WHERE poi.supplier_sku IS NOT NULL ORDER BY poi.supplier_sku, po.order_date DESC
  `;
  const p = new Map(lines.map(l => [l.supplier_sku, l]));
  console.log("group     code                         description                                       price       date         supplier");
  for (const r of rm) {
    const x = p.get(r.item_code);
    const price = x?.unit_price_sen != null ? `RM ${(x.unit_price_sen/100).toFixed(2)}` : "—";
    console.log(`${(r.item_group ?? "—").padEnd(9)} ${r.item_code.padEnd(28)} ${(r.description ?? "").slice(0,48).padEnd(48)} ${price.padEnd(11)} ${(x?.order_date ?? "—").toString().padEnd(12)} ${x?.supplier_name ?? "—"}`);
  }
} finally { await sql.end(); }
