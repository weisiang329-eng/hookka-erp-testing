import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
// Query BOTH Supabase DBs to figure out which one the testing site uses.
import postgres from "postgres";

const dbA = requiredDatabaseUrl("STAGING_DATABASE_URL");
const dbB = requiredDatabaseUrl("PROD_DATABASE_URL");

async function check(label, url) {
  const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });
  try {
    const totals = await sql`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE stock_qty < 0) AS neg,
        COUNT(*) FILTER (WHERE stock_qty = 0) AS zero,
        COUNT(*) FILTER (WHERE stock_qty > 0) AS pos,
        COUNT(*) FILTER (WHERE stock_qty != 0) AS nonzero,
        MIN(stock_qty) AS min_q,
        MAX(stock_qty) AS max_q
      FROM wip_items;
    `;
    const sample = await sql`SELECT code, type, status, stock_qty FROM wip_items WHERE stock_qty != 0 ORDER BY stock_qty ASC LIMIT 5`;
    const sosCount = await sql`SELECT COUNT(*) AS n FROM sales_orders;`;
    const posCount = await sql`SELECT COUNT(*) AS n FROM production_orders;`;
    console.log(`\n=== ${label}  (${url.split("@")[1].split(":")[0]}) ===`);
    console.log("wip_items:", JSON.stringify(totals[0]));
    console.log("sales_orders count:", sosCount[0].n, "production_orders count:", posCount[0].n);
    console.log("worst non-zero wip_items:");
    for (const r of sample) console.log(`  qty=${r.stock_qty}  ${r.type}  ${r.status}  ${r.code}`);
  } finally {
    await sql.end();
  }
}

await check("DB-A", dbA);
await check("DB-B", dbB);
