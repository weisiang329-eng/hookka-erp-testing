import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const stagingUrl = requiredDatabaseUrl("STAGING_DATABASE_URL");
const prodUrl = requiredDatabaseUrl("PROD_DATABASE_URL");

async function dump(label, url) {
  const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });
  try {
    console.log(`\n=== ${label} ===`);
    const r = await sql`
      SELECT dept_status, COUNT(*) AS n, SUM(stock_qty) AS sum_stock
      FROM wip_items WHERE stock_qty != 0 AND dept_status = 'FAB_SEW'
      GROUP BY dept_status;
    `;
    console.log(JSON.stringify(r, null, 2));

    const top = await sql`
      SELECT code, stock_qty
      FROM wip_items WHERE dept_status = 'FAB_SEW' AND stock_qty > 0
      ORDER BY stock_qty DESC LIMIT 10;
    `;
    console.log("Top 10 SEW stock rows:");
    for (const r2 of top) console.log(`  qty=${r2.stock_qty}  ${r2.code}`);
  } finally {
    await sql.end();
  }
}

await dump("STAGING", stagingUrl);
await dump("PROD", prodUrl);
