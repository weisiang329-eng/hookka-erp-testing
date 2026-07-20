import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
// Add department_codes column to workers (JSON array of department codes).
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("PROD_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  await sql`ALTER TABLE workers ADD COLUMN IF NOT EXISTS department_codes TEXT`;
  // Backfill existing rows
  await sql`UPDATE workers SET department_codes = '["' || department_code || '"]' WHERE department_codes IS NULL AND department_code IS NOT NULL AND department_code <> ''`;
  const sample = await sql`SELECT emp_no, department_code, department_codes FROM workers LIMIT 5`;
  console.log("Sample after backfill:");
  for (const r of sample) console.log(`  ${r.emp_no}  primary=${r.department_code}  codes=${r.department_codes}`);
} finally { await sql.end(); }
