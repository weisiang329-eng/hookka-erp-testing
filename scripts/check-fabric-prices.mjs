// Fabric price summary: B.M-FABR (bedframe) + S.M-FABR (sofa) + S-FABRIC.
// Outputs per-group min/median/max + a CSV with every code.
import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

const sql = postgres(
  prodUrl(),
  { ssl: "require", max: 1, idle_timeout: 5 },
);
const OUT = "scripts/out/fabric-prices-2026-05-09.csv";
const FABRIC_GROUPS = ["B.M-FABR", "S.M-FABR", "S-FABRIC"];

function csvEscape(v) { if (v == null) return ""; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

try {
  const rm = await sql`
    SELECT item_code, description, item_group, base_uom, balance_qty
      FROM raw_materials
     WHERE COALESCE(is_active, 1) <> 0
       AND item_group = ANY(${FABRIC_GROUPS})
     ORDER BY item_group, item_code
  `;
  const lines = await sql`
    SELECT DISTINCT ON (poi.supplier_sku) poi.supplier_sku, poi.unit_price_sen, poi.unit, po.order_date, po.supplier_name
      FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.purchase_order_id
     WHERE poi.supplier_sku IS NOT NULL
     ORDER BY poi.supplier_sku, po.order_date DESC NULLS LAST
  `;
  const priceByCode = new Map(lines.map(l => [l.supplier_sku, l]));

  const rows = [["Group","Code","Description","UOM","Balance","Latest Price (RM)","PO UOM","PO Date","Supplier"].map(csvEscape).join(",")];
  const byGroup = new Map();

  for (const r of rm) {
    const p = priceByCode.get(r.item_code);
    const priceRM = p?.unit_price_sen != null ? p.unit_price_sen / 100 : null;
    if (!byGroup.has(r.item_group)) byGroup.set(r.item_group, { all: [], priced: [] });
    const g = byGroup.get(r.item_group);
    g.all.push(r);
    if (priceRM != null) g.priced.push({ code: r.item_code, desc: r.description, price: priceRM, date: p.order_date, supp: p.supplier_name, uom: p.unit });
    rows.push([
      r.item_group, r.item_code, r.description ?? "", r.base_uom ?? "", r.balance_qty ?? "",
      priceRM != null ? priceRM.toFixed(2) : "", p?.unit ?? "", p?.order_date ?? "", p?.supplier_name ?? "",
    ].map(csvEscape).join(","));
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, rows.join("\n") + "\n", "utf8");

  // Per-group stats
  console.log(`\n=== Per-group price stats (RM) ===`);
  console.log(`Group       Codes  Priced   Min      Median   Avg      Max     `);
  for (const g of FABRIC_GROUPS) {
    const x = byGroup.get(g);
    if (!x || x.all.length === 0) { console.log(`${g.padEnd(12)} no data`); continue; }
    const ps = x.priced.map(r => r.price).sort((a,b)=>a-b);
    if (ps.length === 0) { console.log(`${g.padEnd(12)} ${String(x.all.length).padEnd(6)} 0 priced`); continue; }
    const min = ps[0], max = ps[ps.length-1];
    const median = ps.length % 2 === 0 ? (ps[ps.length/2 - 1] + ps[ps.length/2]) / 2 : ps[(ps.length-1)/2];
    const avg = ps.reduce((a,b)=>a+b,0) / ps.length;
    console.log(`${g.padEnd(12)} ${String(x.all.length).padEnd(6)} ${String(ps.length).padEnd(8)} ${min.toFixed(2).padEnd(8)} ${median.toFixed(2).padEnd(8)} ${avg.toFixed(2).padEnd(8)} ${max.toFixed(2)}`);
  }

  // Top 10 most expensive + cheapest per group
  for (const g of FABRIC_GROUPS) {
    const x = byGroup.get(g);
    if (!x || x.priced.length === 0) continue;
    const sorted = [...x.priced].sort((a,b)=>b.price - a.price);
    console.log(`\n=== ${g} — top 10 most expensive ===`);
    for (const r of sorted.slice(0, 10)) {
      console.log(`  ${r.code.padEnd(20)} RM ${r.price.toFixed(2).padEnd(8)} ${(r.desc ?? "").slice(0,55)} (${r.date}, ${r.supp})`);
    }
    console.log(`\n=== ${g} — top 10 cheapest ===`);
    for (const r of sorted.slice(-10).reverse()) {
      console.log(`  ${r.code.padEnd(20)} RM ${r.price.toFixed(2).padEnd(8)} ${(r.desc ?? "").slice(0,55)} (${r.date}, ${r.supp})`);
    }
  }
  console.log(`\nFull CSV: ${OUT}`);
} finally { await sql.end(); }
