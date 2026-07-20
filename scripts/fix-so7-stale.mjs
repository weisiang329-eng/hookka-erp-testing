import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("STAGING_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const r = await sql`UPDATE wip_items SET stock_qty = 1 WHERE code = '1003-(Q) | (5FT) | (28") | (DV 10") | PC151-18 | (FC)' AND stock_qty = 2;`;
  console.log(`SO-2605-007 stale qty fix: ${r.count} rows`);
} finally { await sql.end(); }
