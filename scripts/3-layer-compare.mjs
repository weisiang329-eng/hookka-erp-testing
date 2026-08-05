import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";
const sql = postgres(stagingUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  console.log("=== LAYER 1: DB raw wip_items ===");
  const total = await sql`SELECT COUNT(*) AS n FROM wip_items;`;
  const nonzero = await sql`SELECT COUNT(*) AS n FROM wip_items WHERE stock_qty != 0;`;
  const positive = await sql`SELECT COUNT(*) AS n, SUM(stock_qty) AS s FROM wip_items WHERE stock_qty > 0;`;
  const negative = await sql`SELECT COUNT(*) AS n, SUM(stock_qty) AS s FROM wip_items WHERE stock_qty < 0;`;
  console.log(`Total wip_items rows: ${total[0].n}`);
  console.log(`  stock_qty != 0: ${nonzero[0].n}`);
  console.log(`  positive: ${positive[0].n} (sum=${positive[0].s})`);
  console.log(`  negative: ${negative[0].n} (sum=${negative[0].s})`);

  // Sample rows
  console.log("\n--- Top 20 by stock_qty ---");
  const top = await sql`SELECT id, code, dept_status, stock_qty, status FROM wip_items WHERE stock_qty != 0 ORDER BY stock_qty DESC LIMIT 20;`;
  for (const r of top) console.log(`  qty=${String(r.stock_qty).padStart(4)} dept=${(r.dept_status||'').padEnd(12)} status=${(r.status||'').padEnd(12)} ${r.code}`);

  console.log("\n=== LAYER 2: Backend /api/inventory/wip semantics check ===");
  console.log("(SELECT id, code, type, relatedProduct, deptStatus, stockQty FROM wip_items WHERE stockQty != 0)");
  console.log("Expected to match LAYER 1 'stock_qty != 0' row count.");

  // Check JC state distribution
  console.log("\n=== JC status distribution ===");
  const jc = await sql`SELECT status, COUNT(*) AS n FROM job_cards GROUP BY status ORDER BY status;`;
  console.log(JSON.stringify(jc, null, 2));
} finally { await sql.end(); }
