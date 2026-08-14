// ---------------------------------------------------------------------------
// reset-wip-quantities.mjs — the one-off reset of `wip_items.stock_qty`.
//
// ⚠️  NOT RUN. Prepared, dry-run by default, left for the owner to review and
//     execute. Nothing in this file has been executed against production.
//
// WHY A RESET IS NEEDED AT ALL
// The cascade fixes (the last stage now drains its upstream; a reverted-and-
// redone job card is no longer swallowed) stop NEW drift. They cannot undo the
// drift already banked in the running balance — `wip_items.stock_qty` is a
// number that has only ever been nudged, never re-derived, so every decrement
// that was missed since April is still sitting in it.
//
// WHAT IT WRITES
// For every code, the balance the job-card history justifies — the same
// derivation `GET /api/inventory/wip/reconcile` reports and the same one the
// cascade's settle uses (src/api/lib/wip-expected.ts). A stage's output counts
// as on-hand only when the stage is finished, the next stage has not picked it
// up, and the order has not left WIP. By construction the result contains NO
// negative rows.
//
// USAGE
//   export HOOKKA_PROD_DB_URL='postgresql://postgres:<YOUR-DB-PASSWORD>@db.vpwdqt....supabase.co:5432/postgres'
//   node --import tsx/esm scripts/reset-wip-quantities.mjs              # dry run
//   node --import tsx/esm scripts/reset-wip-quantities.mjs --limit 40   # dry run, show more
//   node --import tsx/esm scripts/reset-wip-quantities.mjs --apply      # WRITES
//
// --apply additionally requires --i-have-read-the-report, because this rewrites
// the inventory the factory reads off the WIP board.
//
// The reset is reversible in the sense that matters: it prints the full before/
// after and writes a JSON snapshot of every prior value to
// scripts/_wip-reset-backup-<timestamp>.json BEFORE the first UPDATE.
// ---------------------------------------------------------------------------
import { writeFileSync } from "node:fs";
import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
import { expectedWipByCode } from "../src/api/lib/wip-expected.ts";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const APPLY = has("--apply");
const CONFIRMED = has("--i-have-read-the-report");
const limitIdx = argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(argv[limitIdx + 1] || 25) : 25;

if (APPLY && !CONFIRMED) {
  console.error(
    "\n✗ --apply also requires --i-have-read-the-report.\n" +
      "  This rewrites every WIP balance the factory reads off the board.\n" +
      "  Run it without --apply first and read the summary.\n",
  );
  process.exit(1);
}

const sql = postgres(prodUrl(), { ssl: "require", max: 1, idle_timeout: 5 });

try {
  const [pos, jcs, stored] = await Promise.all([
    sql`SELECT id, quantity, item_category AS "itemCategory",
               special_order AS "specialOrder"
          FROM production_orders`,
    sql`SELECT id, production_order_id AS "productionOrderId",
               department_code AS "departmentCode", sequence, status,
               wip_key AS "wipKey", wip_label AS "wipLabel", wip_qty AS "wipQty",
               branch_key AS "branchKey", wip_type AS "wipType"
          FROM job_cards`,
    sql`SELECT id, code, stock_qty AS "stockQty" FROM wip_items ORDER BY code`,
  ]);

  const expected = expectedWipByCode(pos, jcs);

  const changes = [];
  for (const row of stored) {
    const want = expected.get(row.code) ?? 0;
    const have = Number(row.stockQty ?? 0);
    if (want !== have) changes.push({ id: row.id, code: row.code, have, want });
  }

  const sum = (f) => changes.reduce((n, c) => n + f(c), 0);
  console.log("wip_items reset — derived from job-card history");
  console.log(`  rows in ledger        : ${stored.length}`);
  console.log(`  rows non-zero today   : ${stored.filter((r) => Number(r.stockQty) !== 0).length}`);
  console.log(`  rows to change        : ${changes.length}`);
  console.log(`  negative rows cleared : ${changes.filter((c) => c.have < 0).length}`);
  console.log(`  units removed         : ${sum((c) => Math.max(0, c.have - c.want))}`);
  console.log(`  units added back      : ${sum((c) => Math.max(0, c.want - c.have))}`);
  console.log(`  total units before    : ${stored.reduce((n, r) => n + Number(r.stockQty ?? 0), 0)}`);
  console.log(`  total units after     : ${[...expected.values()].reduce((a, b) => a + b, 0)}`);
  console.log("");
  const biggest = [...changes].sort(
    (a, b) => Math.abs(b.have - b.want) - Math.abs(a.have - a.want),
  );
  for (const c of biggest.slice(0, LIMIT)) {
    console.log(`  ${String(c.have).padStart(5)} → ${String(c.want).padStart(4)}   ${c.code}`);
  }
  if (biggest.length > LIMIT) {
    console.log(`  … and ${biggest.length - LIMIT} more (--limit N to show more)`);
  }

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Add --apply --i-have-read-the-report to write.");
    process.exit(0);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `scripts/_wip-reset-backup-${stamp}.json`;
  writeFileSync(
    backup,
    JSON.stringify(
      stored.map((r) => ({ id: r.id, code: r.code, stockQty: Number(r.stockQty ?? 0) })),
      null,
      2,
    ),
  );
  console.log(`\nBackup of every prior value → ${backup}`);

  // One statement per row, keyed by id. `status` is deliberately untouched:
  // this reset is about QUANTITY only (owner 2026-08-08 — "先看数量").
  let done = 0;
  for (const c of changes) {
    await sql`UPDATE wip_items SET stock_qty = ${c.want} WHERE id = ${c.id}`;
    done += 1;
  }
  console.log(`Applied ${done} row(s).`);
} finally {
  await sql.end();
}
