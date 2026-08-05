import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
const sql = postgres(prodUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const c = await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'workers' ORDER BY ordinal_position`;
  for (const x of c) console.log(`  ${x.column_name} ${x.data_type}`);
  const positions = await sql`SELECT DISTINCT position FROM workers ORDER BY position`;
  console.log("\nDistinct positions:");
  for (const p of positions) console.log("  " + p.position);
} finally { await sql.end(); }
