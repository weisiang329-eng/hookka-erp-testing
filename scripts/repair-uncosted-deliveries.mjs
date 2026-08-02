#!/usr/bin/env node
// ============================================================================
// repair-uncosted-deliveries.mjs — put a cost on the units that shipped
// without one.
//
// READ THIS BEFORE RUNNING IT.
//
// What is broken
// --------------
// `consumeFGBatchesForDO` FIFO-consumes fg_batches per delivered line and
// returns `{ statements, totalCogsSen, shortages }`. The caller consumes only
// `statements`; `shortages` — the lines it could NOT satisfy — is dropped, and
// no reconcile exists anywhere. Those units shipped at RM0 COGS, so the DO and
// its invoice read 100% margin, permanently.
//
// `GET /api/reports/cogs-integrity.json` measures it. Run that FIRST.
//
// Why this script is gated the way it is
// --------------------------------------
// Houzs-ERP's inventory-costing-oversell COE spends its section 6 on having
// written the repair before knowing the size or the shape of the damage, and
// having to redo it. Costing is the last place to guess. So:
//
//   * --dry-run is the DEFAULT and prints every row it would write
//   * the target host is checked against an allow-list and fails closed
//   * a real run needs `--confirm <host>` — you have to name the database back
//   * nothing is written unless a per-DO valuation basis actually exists
//
// The valuation rule (the part that needs a human)
// ------------------------------------------------
// An uncosted unit is valued at the AVERAGE UNIT COST OF THE COSTED UNITS ON
// THE SAME DO. That is the most defensible basis available from the data: same
// product mix, same date, same batch generation.
//
// When a DO has NO costed unit at all there is no basis, and this script
// REFUSES to value it — those rows are listed as `needs_decision` and left
// alone. Inventing a number for them would be worse than the gap.
//
// What it writes
// --------------
// One `cost_ledger` row per repaired DO: type='ADJUSTMENT', direction='OUT',
// itemType='FG', refType='DELIVERY_ORDER', refId=<do id>, notes carrying this
// script's name and the run date, so the repair is traceable and a second run
// is a no-op (it skips any DO that already has an ADJUSTMENT from this script).
//
// It deliberately does NOT touch fg_batches: the physical stock left the
// warehouse and the batches were already drawn down for whatever they could
// cover. This is a COSTING correction, not an inventory one.
//
// Usage:
//   export REPAIR_DATABASE_URL=postgresql://...
//   node scripts/repair-uncosted-deliveries.mjs                    # dry run
//   node scripts/repair-uncosted-deliveries.mjs --confirm <host>   # writes
// ============================================================================
import postgres from "postgres";

const URL_ = process.env.REPAIR_DATABASE_URL || "";
const TARGET_ALLOWLIST = [
  "db.vpwdqtsxexpiqxzweivd.supabase.co", // prod — the only place this matters
  "db.zaxygxwadidiqcphibma.supabase.co", // staging — rehearse here first
];
const MARKER = "repair-uncosted-deliveries";

function hostOf(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
}

function assertTarget(u) {
  const host = hostOf(u);
  if (!host) throw new Error("REPAIR_DATABASE_URL is missing or unparseable — refusing to run.");
  if (!TARGET_ALLOWLIST.includes(host)) {
    throw new Error(`REFUSING: ${host} is not in the allow-list.`);
  }
  return host;
}

const RM = (sen) => `RM ${(sen / 100).toFixed(2)}`;

async function main() {
  const host = assertTarget(URL_);
  const argv = process.argv.slice(2);
  const ci = argv.indexOf("--confirm");
  const confirmed = ci !== -1 && argv[ci + 1] === host;
  const dryRun = !confirmed;

  console.log(`[repair] target ${host}`);
  console.log(
    dryRun
      ? `[repair] DRY RUN — nothing will be written.\n` +
          `[repair] To execute: node scripts/repair-uncosted-deliveries.mjs --confirm ${host}`
      : `[repair] CONFIRMED — cost_ledger ADJUSTMENT rows will be written.`,
  );

  const sql = postgres(URL_, { ssl: "require", max: 1, connect_timeout: 15 });
  try {
    // Same query as src/api/lib/cogs-integrity.ts — kept in step with it on
    // purpose so the script repairs exactly what the detector reports.
    const rows = await sql.unsafe(`
      SELECT d.id                       AS do_id,
             d.do_no                    AS do_no,
             d.delivered_at             AS delivered_at,
             COALESCE(items.qty, 0)     AS delivered_qty,
             COALESCE(led.qty, 0)       AS costed_qty,
             COALESCE(led.sen, 0)       AS costed_sen,
             COALESCE(fixed.n, 0)       AS already_repaired
        FROM delivery_orders d
        LEFT JOIN (SELECT delivery_order_id AS r, SUM(quantity) AS qty
                     FROM delivery_order_items GROUP BY delivery_order_id) items
               ON items.r = d.id
        LEFT JOIN (SELECT ref_id AS r, SUM(qty) AS qty, SUM(total_cost_sen) AS sen
                     FROM cost_ledger
                    WHERE type = 'FG_DELIVERED' AND ref_type = 'DELIVERY_ORDER'
                      AND direction = 'OUT'
                    GROUP BY ref_id) led
               ON led.r = d.id
        LEFT JOIN (SELECT ref_id AS r, COUNT(*) AS n
                     FROM cost_ledger
                    WHERE type = 'ADJUSTMENT' AND ref_type = 'DELIVERY_ORDER'
                      AND notes LIKE '%${MARKER}%'
                    GROUP BY ref_id) fixed
               ON fixed.r = d.id
       WHERE d.delivered_at IS NOT NULL
         AND COALESCE(items.qty, 0) > COALESCE(led.qty, 0)
       ORDER BY d.delivered_at DESC
    `);

    const repairable = [];
    const needsDecision = [];
    const alreadyDone = [];
    for (const r of rows) {
      const gap = Number(r.delivered_qty) - Number(r.costed_qty);
      if (gap <= 0) continue;
      if (Number(r.already_repaired) > 0) {
        alreadyDone.push(r);
        continue;
      }
      if (Number(r.costed_qty) <= 0) {
        needsDecision.push({ ...r, gap });
        continue;
      }
      const unit = Number(r.costed_sen) / Number(r.costed_qty);
      repairable.push({ ...r, gap, unitSen: Math.round(unit), totalSen: Math.round(unit * gap) });
    }

    const total = repairable.reduce((n, r) => n + r.totalSen, 0);
    console.log(
      `\n[repair] ${rows.length} uncosted deliveries found:\n` +
        `  ${repairable.length} repairable (${RM(total)} of missing COGS)\n` +
        `  ${needsDecision.length} with NO costed unit — no honest basis, left alone\n` +
        `  ${alreadyDone.length} already repaired by a previous run\n`,
    );
    for (const r of repairable) {
      console.log(
        `  ${r.do_no}  ${r.delivered_at?.slice?.(0, 10) ?? ""}  ` +
          `${r.gap} unit(s) x ${RM(r.unitSen)} = ${RM(r.totalSen)}`,
      );
    }
    if (needsDecision.length) {
      console.log(`\n[repair] NEEDS A DECISION — nothing on these DOs was ever costed:`);
      for (const r of needsDecision) {
        console.log(`  ${r.do_no}  ${r.gap} unit(s), no basis to value them`);
      }
    }

    if (dryRun) {
      console.log(`\n[repair] DRY RUN — no rows written.`);
      return;
    }
    if (repairable.length === 0) {
      console.log(`\n[repair] nothing to write.`);
      return;
    }

    const stamp = new Date().toISOString();
    let written = 0;
    // One transaction: either the whole repair lands or none of it does. A
    // half-applied costing correction is harder to reason about than the gap.
    await sql.begin(async (tx) => {
      for (const r of repairable) {
        await tx.unsafe(
          `INSERT INTO cost_ledger
             (id, date, type, item_type, item_id, batch_id, qty, direction,
              unit_cost_sen, total_cost_sen, ref_type, ref_id, notes)
           VALUES ($1, $2, 'ADJUSTMENT', 'FG', $3, NULL, $4, 'OUT', $5, $6,
                   'DELIVERY_ORDER', $7, $8)`,
          [
            `cl-fix-${crypto.randomUUID().slice(0, 12)}`,
            stamp,
            r.do_id, // no single product — the DO is the item of record here
            r.gap,
            r.unitSen,
            r.totalSen,
            r.do_id,
            `${MARKER} ${stamp.slice(0, 10)}: ${r.gap} unit(s) delivered on ${r.do_no} ` +
              `had no FG layer; valued at this DO's own average of ${RM(r.unitSen)}/unit`,
          ],
        );
        written += 1;
      }
    });
    console.log(`\n[repair] wrote ${written} ADJUSTMENT row(s), ${RM(total)} total.`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error("[repair] FAILED:", e);
  process.exit(1);
});
