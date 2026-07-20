import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("PROD_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const c = await sql`SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name = 'worker_pins'`;
  for (const x of c) console.log(`${x.column_name.padEnd(15)} type=${x.data_type}  default=${x.column_default ?? "—"}`);
  const sample = await sql`SELECT worker_id, must_reset, length(pin) FROM worker_pins LIMIT 3`;
  console.log("\nsample:");
  for (const r of sample) console.log(`  workerId=${r.worker_id}  must_reset=${r.must_reset} (type=${typeof r.must_reset})`);
} finally { await sql.end(); }
