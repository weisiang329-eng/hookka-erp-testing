import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
const sql = postgres(
  prodUrl(),
  { ssl: "require", max: 1, idle_timeout: 5 },
);
try {
  const cols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'purchase_order_items' ORDER BY ordinal_position`;
  console.log("purchase_order_items columns:");
  for (const c of cols) console.log("  " + c.column_name);
  const pcols = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'purchase_orders' ORDER BY ordinal_position`;
  console.log("\npurchase_orders columns:");
  for (const c of pcols) console.log("  " + c.column_name);
} finally { await sql.end(); }
