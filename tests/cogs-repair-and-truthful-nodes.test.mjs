// ---------------------------------------------------------------------------
// cogs-repair-and-truthful-nodes.test.mjs
//
//   1. the COGS repair is gated, reversible-by-inspection, and refuses to guess
//   2. raw-material shortages stop being thrown away too
//   3. the consignment map stops INVENTING an AR receipt
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const repair = readFileSync("scripts/repair-uncosted-deliveries.mjs", "utf8");
const poHelpers = readFileSync("src/api/routes/production-orders/_helpers.ts", "utf8");
const coPage = readFileSync("src/pages/consignment/detail.tsx", "utf8");
const coRoute = readFileSync("src/api/routes/consignment-orders.ts", "utf8");

// --- 1. the repair ----------------------------------------------------------

test("the repair refuses to guess a value it cannot justify", () => {
  // A DO with no costed unit has NO basis. Inventing one is worse than the gap.
  assert.match(repair, /needsDecision\.push/);
  assert.match(repair, /no honest basis, left alone/);
  // The basis that IS used is the DO's own costed units — same product mix,
  // same date, same batch generation.
  assert.match(repair, /Number\(r\.costed_sen\) \/ Number\(r\.costed_qty\)/);
});

test("the repair is dry-run by default and fails closed", () => {
  assert.match(repair, /const dryRun = !confirmed;/);
  assert.match(repair, /argv\[ci \+ 1\] === host/, "a real run must name the database back");
  assert.match(repair, /TARGET_ALLOWLIST/);
  assert.match(repair, /is not in the allow-list/);
});

test("running it twice is a no-op, and one run is all-or-nothing", () => {
  // Idempotency by marker, so a re-run cannot double-cost.
  assert.match(repair, /const MARKER = "repair-uncosted-deliveries"/);
  assert.match(repair, /already_repaired/);
  // A half-applied costing correction is harder to reason about than the gap.
  assert.match(repair, /await sql\.begin\(async \(tx\) => \{/);
});

test("it corrects COSTING only — it never touches physical stock", () => {
  // The goods really did leave; fg_batches were already drawn down for whatever
  // they could cover.
  assert.doesNotMatch(repair, /UPDATE fg_batches|DELETE FROM fg_batches/);
  assert.match(repair, /type = 'ADJUSTMENT'|'ADJUSTMENT', 'FG'/);
});

// --- 2. raw-material shortages ---------------------------------------------

test("a raw-material shortage is reported, not thrown away", () => {
  // A shortage is NOT an exception — the consume succeeds and returns the lines
  // it could not satisfy, and every caller was discarding that list.
  assert.match(poHelpers, /const rm = await consumeRawMaterialsForPO\(db, existing\.id\);/);
  assert.match(poHelpers, /for \(const sh of rm\.shortages \?\? \[\]\)/);
  assert.match(poHelpers, /so this job is under-costed/);
});

// --- 3. the fabricated AR node ---------------------------------------------

test("the consignment map no longer invents an AR receipt", () => {
  // It used to derive `AR-<coId>` from the ORDER ID with a hardcoded
  // "RECEIVED" — a document number nobody could find, because it never existed.
  assert.doesNotMatch(coPage, /docNo: `AR-\$\{order\.companyCOId/);
  assert.doesNotMatch(coPage, /status: "RECEIVED",\n\s*href: `\/accounting`/);
  // Real receipt when there is one; an honest placeholder when there isn't.
  assert.match(coPage, /if \(linkedPayments\.length > 0\)/);
  assert.match(coPage, /docNo: "Not recorded"/);
  // And the payload actually carries them.
  assert.match(coRoute, /FROM invoice_payments WHERE invoice_id IN/);
  assert.match(coRoute, /linkedPayments,/);
});
