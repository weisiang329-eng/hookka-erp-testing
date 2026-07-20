import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("PROD_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  // FG_COMPLETED unit_cost_sen is the official rolled-up "this is what 1 unit cost
  // us to produce" — fabric + materials + labor (where present).
  const rows = await sql`
    SELECT cl.id, cl.date, cl.unit_cost_sen, cl.qty, cl.ref_id,
           p.code, p.name, p.category
      FROM cost_ledger cl
      JOIN products p ON p.id = cl.item_id
     WHERE cl.type = 'FG_COMPLETED'
       AND cl.unit_cost_sen IS NOT NULL
       AND p.category IN ('BEDFRAME', 'SOFA')
     ORDER BY cl.date DESC
  `;
  const byCat = new Map();
  for (const r of rows) {
    if (!byCat.has(r.category)) byCat.set(r.category, []);
    byCat.get(r.category).push(r);
  }
  console.log("=== FG_COMPLETED unit cost (rolled-up production cost) ===\n");
  for (const cat of ["BEDFRAME", "SOFA"]) {
    const data = byCat.get(cat) ?? [];
    if (data.length === 0) { console.log(`${cat}: no data`); continue; }
    // Filter out zero-cost rows (incomplete cost capture — RM not tracked yet)
    const nonzero = data.filter(r => r.unit_cost_sen > 0);
    const costs = nonzero.map(r => r.unit_cost_sen).sort((a,b)=>a-b);
    const avg = costs.reduce((a,b)=>a+b,0) / costs.length;
    const median = costs.length % 2 === 0 ? (costs[costs.length/2-1] + costs[costs.length/2]) / 2 : costs[(costs.length-1)/2];
    console.log(`${cat}:`);
    console.log(`  total entries  : ${data.length}`);
    console.log(`  with cost > 0  : ${nonzero.length}`);
    console.log(`  avg            : RM ${(avg/100).toFixed(2)}`);
    console.log(`  median         : RM ${(median/100).toFixed(2)}`);
    console.log(`  min            : RM ${(costs[0]/100).toFixed(2)}`);
    console.log(`  max            : RM ${(costs[costs.length-1]/100).toFixed(2)}`);

    nonzero.sort((a,b) => b.unit_cost_sen - a.unit_cost_sen);
    console.log(`\n  top 5 highest:`);
    for (const r of nonzero.slice(0, 5)) {
      console.log(`    ${r.code.padEnd(20)} RM ${(r.unit_cost_sen/100).toFixed(2).padStart(8)}  ${r.name}  (${String(r.date).slice(0,10)}, PO ${r.ref_id})`);
    }
    nonzero.sort((a,b) => a.unit_cost_sen - b.unit_cost_sen);
    console.log(`\n  top 5 lowest:`);
    for (const r of nonzero.slice(0, 5)) {
      console.log(`    ${r.code.padEnd(20)} RM ${(r.unit_cost_sen/100).toFixed(2).padStart(8)}  ${r.name}  (${String(r.date).slice(0,10)}, PO ${r.ref_id})`);
    }
    console.log("");
  }
} finally { await sql.end(); }
