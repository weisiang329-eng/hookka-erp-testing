import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("PROD_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const t = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name='attendance' OR table_name='attendance_records')`;
  for (const r of t) console.log("table:", r.table_name);
} finally { await sql.end(); }
