import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("PROD_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  // Compare: products.cost_price_sen (BOM standard) vs avg of FG_COMPLETED ledger.
  // Sample one PO and break down its cost components from cost_ledger.
  const onePo = await sql`
    SELECT type, item_type, qty, unit_cost_sen, total_cost_sen, notes
      FROM cost_ledger
     WHERE ref_id = 'pord-so-8f71918d-01'
     ORDER BY date, type
  `;
  console.log("Cost ledger for PO pord-so-8f71918d-01:");
  for (const r of onePo) {
    const u = r.unit_cost_sen != null ? `RM ${(r.unit_cost_sen/100).toFixed(2)}` : "—";
    const t = r.total_cost_sen != null ? `RM ${(r.total_cost_sen/100).toFixed(2)}` : "—";
    console.log(`  ${r.type.padEnd(15)} item=${r.item_type.padEnd(4)} qty=${r.qty}  unit=${u}  total=${t}  ${r.notes ?? ""}`);
  }

  // Now: per-category rollup of products.cost_price_sen (BOM standard)
  const bomAvg = await sql`
    SELECT category,
           COUNT(*) FILTER (WHERE cost_price_sen IS NOT NULL AND cost_price_sen > 0) AS priced,
           COUNT(*) AS total,
           AVG(NULLIF(cost_price_sen, 0))::int AS avg_sen,
           MIN(NULLIF(cost_price_sen, 0)) AS min_sen,
           MAX(NULLIF(cost_price_sen, 0)) AS max_sen
      FROM products
     WHERE category IN ('BEDFRAME', 'SOFA')
     GROUP BY category
  `;
  console.log("\nproducts.cost_price_sen (BOM standard cost) rollup:");
  for (const r of bomAvg) {
    const avg = r.avg_sen != null ? `RM ${(r.avg_sen/100).toFixed(2)}` : "—";
    const min = r.min_sen != null ? `RM ${(r.min_sen/100).toFixed(2)}` : "—";
    const max = r.max_sen != null ? `RM ${(r.max_sen/100).toFixed(2)}` : "—";
    console.log(`  ${r.category.padEnd(10)} priced=${r.priced}/${r.total}  avg=${avg}  min=${min}  max=${max}`);
  }

  // Per-category total ledger cost per PO (sum of LABOR + WIP_COMPLETED + FG_COMPLETED for the PO)
  // Better: get sum(total_cost_sen) of ALL ledger entries grouped by ref_id (PO), then divide by qty produced.
  const perPo = await sql`
    SELECT po.item_category AS category,
           cl.ref_id        AS po_id,
           po.product_code,
           po.product_name,
           po.quantity,
           SUM(CASE WHEN cl.type = 'LABOR_POSTED' AND cl.direction = 'IN' THEN cl.total_cost_sen ELSE 0 END) AS labor_sen,
           SUM(CASE WHEN cl.type = 'RM_ISSUE'    AND cl.direction = 'OUT' THEN cl.total_cost_sen ELSE 0 END) AS rm_sen,
           SUM(CASE WHEN cl.type = 'FG_COMPLETED' THEN cl.total_cost_sen ELSE 0 END) AS fg_completed_sen
      FROM cost_ledger cl
      JOIN production_orders po ON po.id = cl.ref_id
     WHERE cl.ref_type = 'PRODUCTION_ORDER'
     GROUP BY po.item_category, cl.ref_id, po.product_code, po.product_name, po.quantity
    HAVING SUM(CASE WHEN cl.type = 'FG_COMPLETED' THEN cl.total_cost_sen ELSE 0 END) > 0
  `;
  // Compute per-unit total cost (labor+rm) per PO, then aggregate
  const byCat = new Map();
  for (const r of perPo) {
    const totalSen = Number(r.labor_sen) + Number(r.rm_sen);
    const qty = Number(r.quantity) || 1;
    const perUnit = totalSen / qty;
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category).push({ poId: r.po_id, code: r.product_code, name: r.product_name, qty, perUnit, labor: Number(r.labor_sen), rm: Number(r.rm_sen), fg: Number(r.fg_completed_sen) });
  }
  console.log("\nPer-PO actual cost (labor+RM, sen/unit) — aggregated by category:");
  for (const [cat, rows] of byCat) {
    rows.sort((a,b) => a.perUnit - b.perUnit);
    const ps = rows.map(r => r.perUnit);
    const avg = ps.reduce((a,b)=>a+b,0) / ps.length;
    console.log(`  ${cat.padEnd(10)} n=${rows.length}  avg=RM ${(avg/100).toFixed(2)}  min=RM ${(ps[0]/100).toFixed(2)}  max=RM ${(ps[ps.length-1]/100).toFixed(2)}`);
  }

  // Top 5 highest + lowest per-unit cost per category
  for (const [cat, rows] of byCat) {
    rows.sort((a,b) => b.perUnit - a.perUnit);
    console.log(`\n${cat} — top 5 highest per-unit cost:`);
    for (const r of rows.slice(0, 5)) {
      console.log(`  ${r.code.padEnd(20)} RM ${(r.perUnit/100).toFixed(2).padEnd(10)} (qty=${r.qty}, labor=RM ${(r.labor/100).toFixed(2)}, RM=RM ${(r.rm/100).toFixed(2)}) ${r.name?.slice(0,40) ?? ""}`);
    }
    rows.sort((a,b) => a.perUnit - b.perUnit);
    console.log(`\n${cat} — top 5 lowest per-unit cost:`);
    for (const r of rows.slice(0, 5)) {
      console.log(`  ${r.code.padEnd(20)} RM ${(r.perUnit/100).toFixed(2).padEnd(10)} (qty=${r.qty}, labor=RM ${(r.labor/100).toFixed(2)}, RM=RM ${(r.rm/100).toFixed(2)}) ${r.name?.slice(0,40) ?? ""}`);
    }
  }
} finally { await sql.end(); }
