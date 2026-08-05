// Break the 524 candidate JCs down by status, and show how many negative
// wip_items rows are pure-cancelled vs pure-waiting vs mixed.
import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
const url =
  prodUrl();
const sql = postgres(url, { ssl: "require", max: 1, idle_timeout: 5 });

try {
  const negatives = await sql`
    SELECT id, code, type, stock_qty FROM wip_items WHERE stock_qty < 0;
  `;

  let waiting = 0, inProgress = 0, cancelled = 0, other = 0;
  let pureWaiting = 0, pureCancelled = 0, mixed = 0, none = 0;
  let qtyAffectedByCancelled = 0;

  for (const w of negatives) {
    const jcs = await sql`
      SELECT status FROM job_cards
      WHERE wip_label = ${w.code} AND status NOT IN ('COMPLETED','TRANSFERRED');
    `;
    const ws = jcs.filter(j => j.status === 'WAITING').length;
    const ip = jcs.filter(j => j.status === 'IN_PROGRESS').length;
    const cn = jcs.filter(j => j.status === 'CANCELLED').length;
    const ot = jcs.length - ws - ip - cn;
    waiting += ws; inProgress += ip; cancelled += cn; other += ot;

    if (jcs.length === 0) none++;
    else if (cn > 0 && ws === 0 && ip === 0) { pureCancelled++; qtyAffectedByCancelled += Math.abs(w.stock_qty); }
    else if (cn === 0 && (ws > 0 || ip > 0)) pureWaiting++;
    else mixed++;
  }

  console.log("=== JCs by status (across all 70 negative rows) ===");
  console.log(`  WAITING:      ${waiting}`);
  console.log(`  IN_PROGRESS:  ${inProgress}`);
  console.log(`  CANCELLED:    ${cancelled}   ← skip these in backfill`);
  console.log(`  Other:        ${other}`);
  console.log(`  TOTAL:        ${waiting + inProgress + cancelled + other}`);

  console.log("\n=== Negative rows by JC-mix ===");
  console.log(`  Pure WAITING/IN_PROGRESS:  ${pureWaiting}  (clean backfill)`);
  console.log(`  Pure CANCELLED:            ${pureCancelled}  (orphan stub, |sum stock|=${qtyAffectedByCancelled})`);
  console.log(`  Mixed (some CANCELLED + some WAITING): ${mixed}  (backfill the W only)`);
  console.log(`  No matching JC at all:     ${none}`);
} finally {
  await sql.end();
}
