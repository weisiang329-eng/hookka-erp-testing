// ---------------------------------------------------------------------------
// backfill-skipped-completions.mjs — close the gaps the old workflow left.
//
// Owner 2026-09-07: 「你把那些旧的单 backfill 掉，就是补回 complete」.
//
// Before the sequence lock existed, a later department could be ticked while an
// earlier one was still open. The frame WAS built — nobody recorded it. Those
// orders now sit in a state the lock calls illegal: a COMPLETED card with an
// unfinished step behind it. Left alone they would be refused every time
// someone touches them again.
//
// WHAT IT COMPLETES, AND WHAT IT REFUSES TO
//
// Only a card that a FINISHED downstream card is waiting on. If nothing
// downstream is done, nothing here knows the work happened, and it is left
// alone — this backfills a record, it does not invent one.
//
// THE DATE IS BORROWED, NOT INVENTED
//
// The stamp is the EARLIEST completion date among the finished cards that this
// one blocks: the frame cannot have been built after the sofa was upholstered.
// Today's date would be a lie that lands in every production report and every
// month's labour figure. A card with no dated downstream is skipped and
// listed — a blank is honest, a guess is not.
//
// WIP QUANTITIES ARE NOT TOUCHED HERE
//
// The cascade is not run: the downstream consume already happened months ago,
// so replaying a producer-add now would leave the row too high. `wip_items` is
// re-derived from the job cards afterwards by `reset-wip-quantities.mjs`, which
// reads the state this script leaves behind. Run the reset after this.
//
// USAGE (via .github/workflows/backfill-skipped-completions.yml)
//   node --import tsx/esm scripts/backfill-skipped-completions.mjs
//   node --import tsx/esm scripts/backfill-skipped-completions.mjs --apply --i-have-read-the-report
// ---------------------------------------------------------------------------
import postgres from "postgres";
import { prodUrl } from "./_db.mjs";
import { sequenceBlockers } from "../src/api/lib/sequence-lock.ts";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const APPLY = has("--apply");
const CONFIRMED = has("--i-have-read-the-report");
const limitIdx = argv.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? Number(argv[limitIdx + 1] || 40) : 40;

if (APPLY && !CONFIRMED) {
  console.error("\n✗ --apply also requires --i-have-read-the-report.\n");
  process.exit(1);
}

// The code the audit table's CHECK actually accepts. `UPSTREAM_INCOMPLETE` —
// the code the API refuses with — is NOT in it (migration 0022 allows only
// PREREQUISITE_NOT_MET / UPSTREAM_LOCKED), and an insert with it throws. The
// reason text says which kind of override this was, so nothing is lost.
const AUDIT_CODE = "UPSTREAM_LOCKED";

const DONE = new Set(["COMPLETED", "TRANSFERRED"]);
const DEAD = new Set(["CANCELLED"]);

const sql = postgres(prodUrl(), { ssl: "require", max: 1, idle_timeout: 5 });

try {
  const jcs = await sql`
    SELECT id, production_order_id AS "productionOrderId",
           department_code AS "departmentCode", sequence, status,
           wip_key AS "wipKey", branch_key AS "branchKey",
           completed_date AS "completedDate"
      FROM job_cards`;

  const byPo = new Map();
  for (const jc of jcs) {
    const list = byPo.get(jc.productionOrderId) ?? [];
    list.push(jc);
    byPo.set(jc.productionOrderId, list);
  }

  // A card completed here can itself be blocked by something further back, so
  // the sweep repeats until it finds nothing new. Bounded: the deepest BOM
  // chain on production is 6 stages.
  const fixes = new Map();      // id -> { card, date, blockedFor: Set<dept> }
  const undated = new Map();    // id -> card (blocked, but no dated downstream)
  const poHits = new Set();

  for (let pass = 0; pass < 10; pass += 1) {
    let found = 0;
    for (const [poId, cards] of byPo) {
      for (const card of cards) {
        if (!DONE.has(String(card.status ?? "").toUpperCase())) continue;
        for (const b of sequenceBlockers(card, cards)) {
          const blocker = cards.find((c) => c.id === b.id);
          if (!blocker) continue;
          if (DONE.has(String(blocker.status ?? "").toUpperCase())) continue;
          if (DEAD.has(String(blocker.status ?? "").toUpperCase())) continue;
          const date = card.completedDate ? String(card.completedDate).slice(0, 10) : null;
          if (!date) {
            if (!fixes.has(blocker.id)) undated.set(blocker.id, blocker);
            continue;
          }
          const cur = fixes.get(blocker.id);
          if (!cur) {
            fixes.set(blocker.id, {
              card: blocker,
              date,
              blockedFor: new Set([card.departmentCode]),
            });
            undated.delete(blocker.id);
            found += 1;
          } else {
            if (date < cur.date) cur.date = date;
            cur.blockedFor.add(card.departmentCode);
          }
          poHits.add(poId);
          // Treat it as done for the next pass so a chain resolves in order.
          blocker.status = "COMPLETED";
          blocker.completedDate = fixes.get(blocker.id).date;
        }
      }
    }
    if (found === 0) break;
  }

  // The audit table carries a CHECK on the override code. An apply run found
  // that out the hard way — the insert threw after the first card had already
  // been completed. Print the live constraint so the allowed vocabulary is
  // MEASURED here rather than read off a migration file that may have been
  // altered since.
  const [chk] = await sql`
    SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = 'scan_override_audit'::regclass
       AND contype = 'c'
     LIMIT 1`;
  console.log(`  audit code constraint   : ${chk?.def ?? "none"}`);
  console.log("");

  console.log("backfill of skipped completions — derived from the BOM sequence");
  console.log(`  job cards read          : ${jcs.length}`);
  console.log(`  production orders hit   : ${poHits.size}`);
  console.log(`  cards to complete       : ${fixes.size}`);
  console.log(`  skipped, no dated step  : ${undated.size}`);
  console.log("");

  const rows = [...fixes.values()].sort((a, b) => a.date.localeCompare(b.date));
  for (const r of rows.slice(0, LIMIT)) {
    console.log(
      `  ${r.date}  ${String(r.card.departmentCode ?? "").padEnd(12)} ` +
        `→ was waited on by ${[...r.blockedFor].join(", ")}  (PO ${r.card.productionOrderId})`,
    );
  }
  if (rows.length > LIMIT) console.log(`  … and ${rows.length - LIMIT} more`);

  if (undated.size > 0) {
    console.log("\n  NOT touched — the downstream card carries no completion date:");
    for (const c of [...undated.values()].slice(0, 20)) {
      console.log(`    ${String(c.departmentCode ?? "").padEnd(12)} PO ${c.productionOrderId}`);
    }
  }

  if (!APPLY) {
    console.log("\nDRY RUN — nothing written. Add --apply --i-have-read-the-report to write.");
    process.exit(0);
  }

  let done = 0;
  for (const r of rows) {
    const res = await sql`
      UPDATE job_cards
         SET status = 'COMPLETED',
             completed_date = ${r.date}
       WHERE id = ${r.card.id}
         AND status NOT IN ('COMPLETED', 'TRANSFERRED', 'CANCELLED')`;
    if (res.count > 0) done += 1;
    // Same audit trail an operator's unlock leaves, so the weekly review sees
    // one list rather than two: these are the same event, done in bulk.
    await sql`
      INSERT INTO scan_override_audit
        (id, worker_id, worker_name, job_card_id, production_order_id,
         override_code, reason, created_at)
      VALUES (${"soa-bf" + Math.random().toString(16).slice(2, 8)}, 'backfill', 'backfill',
              ${r.card.id}, ${r.card.productionOrderId}, ${AUDIT_CODE},
              ${`${r.card.departmentCode ?? ""} completed by backfill — ${[...r.blockedFor].join(", ")} was already finished on ${r.date}`},
              ${new Date().toISOString()})`;
  }
  console.log(`\nCompleted ${done} card(s). Now re-run the WIP reset — this changed what the balances derive to.`);
} finally {
  await sql.end();
}
