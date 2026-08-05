// Read-only dump — pulls the RAW JSON of every plausible maintenance source
// (kv_config.variants-config + maintenance_config_history latest effective
// row) and prints them so we can see what's actually stored vs what my
// previous audit script extracted. Wei Siang's response 2026-05-09 said the
// "dirty" entries I called out ARE in his maintenance UI — meaning my
// extractValues() helper was either reading the wrong source or missed a
// nested shape.
//
// Usage: node scripts/dump-maintenance-raw-2026-05-09.mjs
import postgres from "postgres";
import { prodUrl } from "./_db.mjs";

const url =
  prodUrl();

const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

try {
  console.log("\n=== kv_config.variants-config (raw JSON) ===");
  const kv = await sql`SELECT value FROM kv_config WHERE key = 'variants-config' LIMIT 1`;
  if (kv[0]?.value) {
    const cfg = JSON.parse(kv[0].value);
    console.log(JSON.stringify(cfg, null, 2));
  } else {
    console.log("(no kv_config row)");
  }

  console.log("\n\n=== maintenance_config_history (master, latest effective) ===");
  const mc = await sql`
    SELECT id, effective_from, created_at, config
      FROM maintenance_config_history
     WHERE scope = 'master'
       AND effective_from <= TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')
     ORDER BY effective_from DESC, created_at DESC
     LIMIT 1
  `;
  if (mc[0]?.config) {
    console.log(`row id: ${mc[0].id}`);
    console.log(`effective_from: ${mc[0].effective_from}`);
    console.log(`created_at: ${mc[0].created_at}`);
    const cfg = JSON.parse(mc[0].config);
    console.log(JSON.stringify(cfg, null, 2));
  } else {
    console.log("(no maintenance_config_history row)");
  }

  console.log("\n\n=== maintenance_config_history (master, ALL rows, last 5) ===");
  const all = await sql`
    SELECT id, effective_from, created_at
      FROM maintenance_config_history
     WHERE scope = 'master'
     ORDER BY effective_from DESC, created_at DESC
     LIMIT 5
  `;
  for (const r of all) {
    console.log(`  ${r.effective_from}  id=${r.id}  created=${r.created_at}`);
  }
} finally {
  await sql.end();
}
