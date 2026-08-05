import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
const sql = postgres(prodUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const c = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'production_orders' ORDER BY ordinal_position`;
  console.log("production_orders columns:");
  for (const x of c) console.log("  " + x.column_name);
} finally { await sql.end(); }
