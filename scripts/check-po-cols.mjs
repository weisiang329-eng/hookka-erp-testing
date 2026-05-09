import postgres from "postgres";
const sql = postgres("postgresql://postgres:ZaXI0JigbBD6muTk@db.vpwdqtsxexpiqxzweivd.supabase.co:5432/postgres", { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const c = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'production_orders' ORDER BY ordinal_position`;
  console.log("production_orders columns:");
  for (const x of c) console.log("  " + x.column_name);
} finally { await sql.end(); }
