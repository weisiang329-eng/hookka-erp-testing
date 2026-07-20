import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
// Seed kv_config['public_holidays'] with 2026-05-01 (Labour Day).
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("PROD_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  const existing = await sql`SELECT value FROM kv_config WHERE key = 'public_holidays'`;
  let arr = [];
  if (existing.length > 0 && existing[0].value) {
    try {
      const parsed = JSON.parse(existing[0].value);
      if (Array.isArray(parsed)) arr = parsed.filter((d) => typeof d === "string");
    } catch {}
  }
  if (!arr.includes("2026-05-01")) arr.push("2026-05-01");
  arr.sort();
  const payload = JSON.stringify(arr);
  await sql`INSERT INTO kv_config (key, value, updated_at) VALUES ('public_holidays', ${payload}, ${new Date().toISOString()})
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`;
  console.log("public_holidays now:", arr);
} finally { await sql.end(); }
