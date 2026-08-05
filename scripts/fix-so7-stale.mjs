import postgres from "postgres";
import { stagingUrl } from "./_db.mjs";
const sql = postgres(stagingUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const r = await sql`UPDATE wip_items SET stock_qty = 1 WHERE code = '1003-(Q) | (5FT) | (28") | (DV 10") | PC151-18 | (FC)' AND stock_qty = 2;`;
  console.log(`SO-2605-007 stale qty fix: ${r.count} rows`);
} finally { await sql.end(); }
