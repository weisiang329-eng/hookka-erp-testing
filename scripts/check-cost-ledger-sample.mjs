import postgres from "postgres";
const sql = postgres("postgresql://postgres:ZaXI0JigbBD6muTk@db.vpwdqtsxexpiqxzweivd.supabase.co:5432/postgres", { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const t = await sql`SELECT type, item_type, direction, COUNT(*) AS n
                        FROM cost_ledger GROUP BY type, item_type, direction ORDER BY n DESC LIMIT 30`;
  console.log("cost_ledger types:");
  for (const r of t) console.log(`  type=${r.type}  item=${r.item_type}  dir=${r.direction}  count=${r.n}`);
  const sample = await sql`SELECT * FROM cost_ledger WHERE item_type = 'fg_unit' LIMIT 5`;
  console.log("\nsample fg_unit ledger rows:");
  for (const r of sample) console.log(JSON.stringify(r));
} finally { await sql.end(); }
