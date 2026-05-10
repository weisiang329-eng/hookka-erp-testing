import postgres from "postgres";
const sql = postgres("postgresql://postgres:ZaXI0JigbBD6muTk@db.vpwdqtsxexpiqxzweivd.supabase.co:5432/postgres", { ssl: "require", max: 1, idle_timeout: 5 });
try {
  await sql`ALTER TABLE workers ADD COLUMN IF NOT EXISTS categories TEXT`;
  // Don't backfill — empty means "all categories" (no filter applied).
  const c = await sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'workers' AND column_name = 'categories'`;
  console.log("categories column:", c.length > 0 ? "added" : "missing");
} finally { await sql.end(); }
