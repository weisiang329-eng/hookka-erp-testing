// ---------------------------------------------------------------------------
// check-fg-ledger.mjs — do the two finished-goods ledgers agree?
//
//   export HOOKKA_PROD_DB_URL='postgresql://postgres:<YOUR-DB-PASSWORD>@db.vpwdqt....supabase.co:5432/postgres'
//   node --import tsx/esm scripts/check-fg-ledger.mjs            # prod
//   node --import tsx/esm scripts/check-fg-ledger.mjs --staging  # staging
//
// (tsx is needed because the arithmetic is imported from the app, not copied.
// A reconciliation with two implementations reconciles nothing.)
//
// READ-ONLY. Safe to run at any time, including mid-shift. Exits 0 when the
// three totals agree, 1 when they genuinely do not, 2 on a connection/setup
// failure — so a failed connection is never mistaken for a clean book.
//
// Houzs shipped this same two-ledger shape without a check and the halves
// diverged in production; their post-mortem's conclusion was that nothing ever
// asserted they agreed. This is that assertion.
// ---------------------------------------------------------------------------
import postgres from "postgres";
import { prodUrl, stagingUrl } from "./_db.mjs";
import { diffFgReconciliation } from "../src/api/lib/fg-ledger-reconcile.ts";
import { FG_ONHAND_STATUSES } from "../src/api/lib/fg-stock-events.ts";

const staging = process.argv.includes("--staging");
const orgId = (process.argv.find((a) => a.startsWith("--org="))?.slice(6) ?? "hookka").trim();

const sql = postgres(staging ? stagingUrl() : prodUrl(), {
  ssl: "require",
  max: 1,
  idle_timeout: 5,
});

const toMap = (rows) => {
  const m = new Map();
  for (const r of rows) {
    const code = r.code ?? "(no product code)";
    m.set(code, (m.get(code) ?? 0) + Number(r.n ?? 0));
  }
  return m;
};

try {
  const hasEvents = await sql`SELECT to_regclass('public.fg_stock_events') AS t`;
  if (!hasEvents[0]?.t) {
    console.error(
      "\n✗ fg_stock_events does not exist on this database.\n" +
        "  It is created by the runtime self-apply in src/api/lib/fg-stock-events.ts —\n" +
        "  deploy the app and let one write run, or apply migrations-postgres/0221_fg_stock_events.sql.\n",
    );
    process.exit(2);
  }

  const onHandList = FG_ONHAND_STATUSES;

  const [ledger, onHand, inFlight, lots, orphans, unseeded] = await Promise.all([
    sql`SELECT e.product_code AS code, SUM(e.direction) AS n
          FROM fg_stock_events e
          JOIN fg_units u ON u.id = e.fg_unit_id
         WHERE e.org_id = ${orgId}
         GROUP BY e.product_code`,
    sql`SELECT product_code AS code, COUNT(*) AS n
          FROM fg_units
         WHERE org_id = ${orgId} AND status = ANY(${onHandList})
         GROUP BY product_code`,
    sql`SELECT product_code AS code, COUNT(*) AS n
          FROM fg_units
         WHERE org_id = ${orgId} AND status = 'LOADED'
         GROUP BY product_code`,
    sql`SELECT p.code AS code, SUM(b.remaining_qty) AS n
          FROM fg_batches b
          LEFT JOIN products p ON p.id = b.product_id
         WHERE b.org_id = ${orgId}
         GROUP BY p.code`,
    sql`SELECT COUNT(*) AS n FROM fg_stock_events e
         WHERE e.org_id = ${orgId}
           AND NOT EXISTS (SELECT 1 FROM fg_units u WHERE u.id = e.fg_unit_id)`,
    sql`SELECT COUNT(*) AS n FROM fg_units u
         WHERE u.org_id = ${orgId}
           AND NOT EXISTS (SELECT 1 FROM fg_stock_events e WHERE e.fg_unit_id = u.id)`,
  ]);

  const result = diffFgReconciliation({
    ledgerBalance: toMap(ledger),
    onHandUnits: toMap(onHand),
    inFlightUnits: toMap(inFlight),
    lotRemaining: toMap(lots),
    orphanEvents: Number(orphans[0]?.n ?? 0),
    unitsWithoutEvents: Number(unseeded[0]?.n ?? 0),
  });

  const pad = (s, n) => String(s).padStart(n);
  console.log(`\nFG stock ledger reconciliation — org "${orgId}" (${staging ? "STAGING" : "PROD"})\n`);
  console.log(
    `  Σ events (balance)        ${pad(result.totals.ledgerBalance, 8)}\n` +
      `  on-hand fg_units          ${pad(result.totals.onHandUnits, 8)}\n` +
      `  in flight (LOADED)        ${pad(result.totals.inFlightUnits, 8)}   ← bridging term, see fg-ledger-reconcile.ts\n` +
      `  Σ fg_batches.remaining    ${pad(result.totals.lotRemaining, 8)}\n`,
  );

  if (result.unitsWithoutEvents > 0) {
    console.log(
      `  NOTE: ${result.unitsWithoutEvents} fg_unit(s) carry no event at all — the opening balance has not been\n` +
        `        seeded. Run POST /api/fg-units/seed-stock-events?execute=1 first, or every\n` +
        `        pre-ledger piece will read as a disagreement it is not.\n`,
    );
  }
  if (result.orphanEvents > 0) {
    console.log(
      `  NOTE: ${result.orphanEvents} event(s) reference a deleted fg_unit. Informational — a regenerate\n` +
        `        or de-dupe repair removes the unit and its events together.\n`,
    );
  }

  if (result.ok) {
    console.log(`✓ all ${result.rows.length} product(s) with stock agree on all three counts.\n`);
    process.exit(0);
  }

  for (const p of result.problems) console.log(`  ✗ ${p}`);
  console.log(
    `\n  ${"product".padEnd(20)}${pad("events", 8)}${pad("units", 8)}${pad("inFlight", 10)}${pad("lots", 8)}${pad("lots@disp", 11)}`,
  );
  for (const r of result.disagreements.slice(0, 40)) {
    console.log(
      `  ${r.productCode.padEnd(20)}${pad(r.ledgerBalance, 8)}${pad(r.onHandUnits, 8)}` +
        `${pad(r.inFlightUnits, 10)}${pad(r.lotRemaining, 8)}${pad(r.lotRemainingAtDispatch, 11)}`,
    );
  }
  if (result.disagreements.length > 40) {
    console.log(`  … and ${result.disagreements.length - 40} more`);
  }
  console.log("");
  process.exit(1);
} catch (err) {
  console.error("\n✗ reconciliation could not run:", err?.message ?? err, "\n");
  process.exit(2);
} finally {
  await sql.end();
}
