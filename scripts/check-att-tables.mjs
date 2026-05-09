import postgres from "postgres";
const sql = postgres("postgresql://postgres:ZaXI0JigbBD6muTk@db.vpwdqtsxexpiqxzweivd.supabase.co:5432/postgres", { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const t = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name='attendance' OR table_name='attendance_records')`;
  for (const r of t) console.log("table:", r.table_name);
} finally { await sql.end(); }
