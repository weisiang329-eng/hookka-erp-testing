import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
const sql = postgres(prodUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const c = await sql`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'kv_config' ORDER BY ordinal_position`;
  for (const x of c) console.log(`  ${x.column_name} ${x.data_type}`);
  const r = await sql`SELECT * FROM kv_config WHERE key = 'public_holidays'`;
  console.log("\npublic_holidays row:", JSON.stringify(r[0]));
} finally { await sql.end(); }
