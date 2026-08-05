import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
const sql = postgres(prodUrl(), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const tot = await sql`SELECT COUNT(*) AS n FROM workers WHERE status = 'ACTIVE'`;
  const wPhone = await sql`SELECT COUNT(*) AS n FROM workers WHERE status = 'ACTIVE' AND phone IS NOT NULL AND phone <> ''`;
  const blank  = await sql`SELECT emp_no, name FROM workers WHERE status = 'ACTIVE' AND (phone IS NULL OR phone = '') ORDER BY emp_no LIMIT 30`;
  console.log(`Active workers       : ${tot[0].n}`);
  console.log(`With phone (resettable): ${wPhone[0].n}`);
  console.log(`Without phone (cannot self-reset): ${tot[0].n - wPhone[0].n}`);
  console.log(`\nFirst 30 without phone:`);
  for (const w of blank) console.log(`  ${w.emp_no.padEnd(10)} ${w.name}`);
} finally { await sql.end(); }
