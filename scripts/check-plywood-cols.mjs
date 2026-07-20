import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const sql = postgres(
  requiredDatabaseUrl("PROD_DATABASE_URL"),
  { ssl: "require", max: 1, idle_timeout: 5 },
);
try {
  const cols = await sql`
    SELECT column_name FROM information_schema.columns
     WHERE table_name = 'raw_materials' ORDER BY ordinal_position
  `;
  console.log("raw_materials columns:");
  for (const c of cols) console.log("  " + c.column_name);
} finally { await sql.end(); }
