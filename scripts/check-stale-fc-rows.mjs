import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
import postgres from "postgres";
const sql = postgres(requiredDatabaseUrl("STAGING_DATABASE_URL"), { ssl: "require", max: 1, idle_timeout: 5 });
try {
  console.log("=== This row direct lookup ===");
  const r = await sql`
    SELECT * FROM wip_items
    WHERE code = '5530-2A(LHF)+L(RHF) | (26) | BO315-22 | (FC)';
  `;
  console.log(JSON.stringify(r, null, 2));

  console.log("\n=== Any matching JC with this wipLabel? ===");
  const jc = await sql`
    SELECT id, wip_label, wip_key, status, production_order_id
    FROM job_cards
    WHERE wip_label = '5530-2A(LHF)+L(RHF) | (26) | BO315-22 | (FC)';
  `;
  console.log(`Matches: ${jc.length}`);
  console.log(JSON.stringify(jc, null, 2));

  console.log("\n=== Similar FC JC labels with 5530-2A(LHF)+L(RHF) BO315-22 ===");
  const similar = await sql`
    SELECT id, wip_label, wip_key, status FROM job_cards
    WHERE wip_label LIKE '%5530-2A(LHF)+L(RHF)%BO315-22%(FC)%' OR wip_label LIKE '%5530-2A(LHF)%L(RHF)%BO315-22%(FC)%';
  `;
  console.log(JSON.stringify(similar, null, 2));

  console.log("\n=== Find ALL orphan FC wip_items (no matching JC) ===");
  const orphans = await sql`
    SELECT w.id, w.code, w.stock_qty, w.status
    FROM wip_items w
    WHERE w.code LIKE '%(FC)%'
      AND NOT EXISTS (
        SELECT 1 FROM job_cards jc WHERE jc.wip_label = w.code
      );
  `;
  console.log(`Orphan rows: ${orphans.length}`);
  for (const o of orphans.slice(0, 15)) console.log(`  ${o.id} qty=${o.stock_qty}  ${o.code}`);
} finally { await sql.end(); }
