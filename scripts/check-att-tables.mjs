import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
const sql = postgres(prodUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const t = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name='attendance' OR table_name='attendance_records')`;
  for (const r of t) console.log("table:", r.table_name);
} finally { await sql.end(); }
