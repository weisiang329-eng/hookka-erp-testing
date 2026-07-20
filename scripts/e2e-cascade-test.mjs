import { requiredDatabaseUrl } from "./lib/required-database-url.mjs";
// End-to-end cascade test on SO-2605-006 Line 2 (clean PO).
// Steps:
//   1. Initial state: FC + SEW all WAITING, no wip_items for FC label
//   2. Complete FC → wip_items += 1 (BEDFRAME, FAB_CUT, COMPLETED)
//   3. Complete HB SEW → wip_items -= 1 (back to 0; HB SEW's own row +1)
//   4. Complete DV SEW → wip_items unchanged (dedup; DV SEW's own row +2)
//   5. Rollback DV SEW → DV's own row -2; FC upstream UNCHANGED (HB still DONE)
//   6. Rollback HB SEW → HB's own row -1; FC upstream +1 (no DONE sibling)
import postgres from "postgres";

const sql = postgres(
  requiredDatabaseUrl("STAGING_DATABASE_URL"),
  { ssl: "require", max: 1, idle_timeout: 5 },
);

const BASE = "https://claude-fab-cut-option-c-v5e4.hookka-erp-testing.pages.dev";
// Note: API requires session cookie. We don't have it server-side. So we'll just
// use SQL directly to simulate JC status changes + manually call cascade-relevant
// SQL ourselves... Actually that won't trigger the cascade. So this test must
// run via the API + browser session. Print plan only.

console.log("Starting state check for SO-2605-006 Line 2 (PO pord-so-970c90f9-02)");

const fcLabel = '1013-(Q) | (5FT) | (24") | (DV 8") | PC151-18 | (FC)';
const hbLabel = '1013-(Q) -HB 24" PC151-18';
const dvLabel = '8" Divan- 5FT PC151-18';

async function snapshot(stage) {
  const wips = await sql`
    SELECT code, stock_qty, status, dept_status FROM wip_items
    WHERE code IN (${fcLabel}, ${hbLabel}, ${dvLabel})
    ORDER BY code;
  `;
  const jcs = await sql`
    SELECT department_code, wip_label, status, completed_date FROM job_cards
    WHERE production_order_id = 'pord-so-970c90f9-02'
      AND department_code IN ('FAB_CUT', 'FAB_SEW')
    ORDER BY department_code, wip_label;
  `;
  console.log(`\n--- [${stage}] ---`);
  console.log("JC state:");
  for (const j of jcs) console.log(`  ${j.department_code.padEnd(8)} ${j.status.padEnd(10)} done=${j.completed_date||'-'}  ${j.wip_label}`);
  console.log("wip_items state (the 3 relevant codes):");
  for (const w of wips) console.log(`  qty=${String(w.stock_qty).padStart(3)}  ${w.status.padEnd(10)} dept=${w.dept_status.padEnd(10)}  ${w.code}`);
}

await snapshot("INITIAL");
await sql.end();
console.log("\n👉 Now complete FC + HB SEW + DV SEW via UI/API and re-run script to see state changes.");
