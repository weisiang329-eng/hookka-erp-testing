import postgres from "postgres";
const url = "postgresql://postgres:wfIPMyT4462iK0za@db.zaxygxwadidiqcphibma.supabase.co:5432/postgres";
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });
// When was this database LAST WRITTEN TO, table by table?
const tables = await sql`
  SELECT c.table_name FROM information_schema.columns c
   WHERE c.column_name = 'created_at' AND c.table_schema = 'public'
   ORDER BY c.table_name`;
const out = [];
for (const { table_name: t } of tables) {
  try {
    const [r] = await sql.unsafe(`SELECT MAX(created_at) AS last, COUNT(*) AS n FROM "${t}"`);
    if (r.last) out.push({ table: t, rows: Number(r.n), last_write: String(r.last).slice(0, 19) });
  } catch { /* skip */ }
}
out.sort((a, b) => String(b.last_write).localeCompare(String(a.last_write)));
console.log("=== 最近有写入的 15 张表 ===");
console.table(out.slice(0, 15));
console.log("=== 全资料库最后写入时间 ===", out[0]?.last_write);
console.log(`=== 共 ${out.length} 张表有资料 ===`);
await sql.end();
