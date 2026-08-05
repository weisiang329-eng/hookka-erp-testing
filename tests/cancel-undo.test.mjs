// ---------------------------------------------------------------------------
// cancel-undo.test.mjs — a cancel you can take back.
//
// Owner 2026-08-04, forwarding a message from the floor: "mr lim, ini u boleh
// tolong reverse balik ke? i silap cancel." Then, on being told it was
// terminal: "其实它就是把 cancel、uncancel 的过程，理解成 reverse 或者 undo 这样
// 的意思，不是吗？这样不是比较简单吗？"
//
// It is that simple, and it always could have been. Cancel was a one-way door
// for one reason only: it was LOSSY. The cascade overwrote every in-flight job
// card's status with 'CANCELLED' and recorded nothing about what it had been,
// so WAITING, IN_PROGRESS and PAUSED all collapsed into the same value. There
// was no honest way back — only a guess dressed up as a restore.
//
// So the fix is not a button, it is `pre_cancel_status`: capture the prior
// status IN THE SAME WRITE as the cancel, and the reverse becomes exact.
//
// What must NOT come back is equally important:
//   • COMPLETED / TRANSFERRED work was never cancelled and is never touched —
//     it has fg_units and cost_ledger behind it;
//   • a row cancelled for some OTHER reason has no pre_cancel_status, so an
//     undo steps over it. Undoing one cancel is not a licence to revive
//     unrelated work;
//   • the cost_ledger is append-only, so restoring WIP cost re-POSTS rather
//     than deleting the reversal — both the cancel and the undo stay visible.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
const PO_HELPERS = read("src/api/routes/production-orders/_helpers.ts");
const PO_ROUTES = read("src/api/routes/production-orders.ts");
const SO_HELPERS = read("src/api/routes/sales-orders/_helpers.ts");
const SO_ROUTES = read("src/api/routes/sales-orders.ts");
const SVC = read("src/api/routes/service-orders.ts");
const SO_PAGE = read("src/pages/sales/detail.tsx");
const SVC_PAGE = read("src/pages/service-orders/detail.tsx");
const M_PAGE = read("src/pages/m/screens/SalesDetailScreen.tsx");

// ── The capture, which is what makes a reverse possible at all ──────────────

test("a production-order cancel records where it came from, in the same write", () => {
  assert.match(
    PO_HELPERS,
    /UPDATE production_orders\s*\n\s*SET status = \?, pre_cancel_status = \?, updated_at = \?/,
  );
});

test("the job-card cascade captures each card's OWN prior status", () => {
  // The lossy part. Without this every restore is a guess.
  assert.match(
    PO_HELPERS,
    /SET pre_cancel_status = status, status = 'CANCELLED', updated_at = \?/,
  );
  assert.match(SO_HELPERS, /SET pre_cancel_status = status, status = 'CANCELLED'/);
});

test("a second cancel cannot overwrite the stored status with CANCELLED", () => {
  // Excluding already-CANCELLED rows is what keeps the memory truthful.
  const cascade = PO_HELPERS.slice(
    PO_HELPERS.indexOf("SET pre_cancel_status = status"),
  ).slice(0, 400);
  assert.match(cascade, /AND status NOT IN \('COMPLETED', 'TRANSFERRED', 'CANCELLED'\)/);
});

test("the sales order records its own prior status for hold AND cancel", () => {
  assert.match(SO_ROUTES, /pre_hold_status = \?, pre_cancel_status = \?,/);
  assert.match(
    SO_ROUTES,
    /newStatus === "CANCELLED" && existing\.status !== "CANCELLED"\s*\n\s*\? existing\.status/,
  );
});

// ── The reverse ────────────────────────────────────────────────────────────

test("a cancelled production order can be un-cancelled, and only then", () => {
  assert.match(PO_ROUTES, /app\.post\("\/:id\/uncancel"/);
  assert.match(
    PO_HELPERS,
    /Only a CANCELLED production order can be un-cancelled\. This one is \$\{from\}/,
  );
});

test("it restores each job card to ITS OWN status, not a blanket value", () => {
  assert.match(
    PO_HELPERS,
    /SET status = COALESCE\(pre_cancel_status, 'PENDING'\),\s*\n\s*pre_cancel_status = NULL/,
  );
});

test("only the cards THIS cancel took down are revived", () => {
  // A card cancelled for another reason carries no pre_cancel_status.
  const undo = PO_HELPERS.slice(
    PO_HELPERS.indexOf('} else if (next === "UNCANCEL") {\n    statements.push('),
  );
  assert.match(
    undo.slice(0, 1500),
    /AND status = 'CANCELLED'\s*\n\s*AND pre_cancel_status IS NOT NULL/,
  );
});

test("CANCELLED is no longer terminal on the sales order", () => {
  assert.match(
    SO_HELPERS,
    /CANCELLED: \["DRAFT", "CONFIRMED", "IN_PRODUCTION", "READY_TO_SHIP"\]/,
  );
  assert.doesNotMatch(SO_HELPERS, /^\s*CANCELLED: \[\],$/m);
});

test("but an order that already shipped cannot be undone into thin air", () => {
  // SHIPPED onwards has a delivery order or an invoice behind it; a status
  // flip would contradict physical and financial evidence. That needs a
  // credit note, not an undo.
  const table = SO_HELPERS.slice(
    SO_HELPERS.indexOf("export const VALID_TRANSITIONS"),
  ).slice(0, 1600);
  const line = table.split("\n").find((l) => l.trim().startsWith("CANCELLED:"));
  assert.ok(line, "the CANCELLED row must be findable in the table");
  for (const forbidden of ["SHIPPED", "DELIVERED", "INVOICED", "CLOSED"]) {
    assert.ok(!line.includes(forbidden), `${forbidden} must not be reachable from CANCELLED`);
  }
});

test("CANCELLED is no longer terminal on the service order either", () => {
  assert.match(SVC, /CANCELLED: \["OPEN", "IN_PRODUCTION", "RESERVED", "IN_REPAIR"\]/);
});

// ── What must NOT come back ────────────────────────────────────────────────

test("completed work is never cancelled, so there is nothing to restore", () => {
  assert.match(SO_HELPERS, /AND status NOT IN \('COMPLETED', 'TRANSFERRED', 'CANCELLED'\)/);
});

test("the WIP cost is re-POSTED, never un-deleted", () => {
  // cost_ledger is append-only and hash-chained; the undo writes the original
  // direction again so the running totals net back and both events survive.
  const undo = SO_HELPERS.slice(SO_HELPERS.indexOf("if (isUncancel) {"));
  assert.match(undo, /type <> 'ADJUSTMENT'/, "re-post the ORIGINAL rows, not the reversals");
  assert.match(undo, /entry\.direction,/, "same direction as the original, not the opposite");
  assert.match(undo, /Re-post of \$\{entry\.type\}/);
  assert.doesNotMatch(undo.slice(0, 4000), /DELETE FROM cost_ledger/);
});

test("a STOCK_SWAP undo re-consumes the stock the cancel handed back", () => {
  assert.match(SVC, /UPDATE fg_batches SET remainingQty = remainingQty - \? WHERE id = \? AND remainingQty >= \?/);
});

// ── The hold bug found in the same family ──────────────────────────────────

test("pre_hold_status is actually written now", () => {
  // The detail page has read `order.preHoldStatus` since 2026-04 to decide
  // where Resume goes, but nothing ever wrote it — so an IN_PRODUCTION order
  // put on hold resumed to CONFIRMED, silently moving BACKWARDS a stage while
  // the dialog announced it as normal.
  assert.match(PO_HELPERS, /ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS pre_hold_status TEXT/);
  assert.match(SO_HELPERS, /preHoldStatus: row\.preHoldStatus \?\? row\.pre_hold_status \?\? ""/);
  assert.match(SO_PAGE, /order\.preHoldStatus as SOStatus/);
});

// ── Self-apply + surfaces ──────────────────────────────────────────────────

test("every new column is self-applied — a migration file alone is inert", () => {
  for (const sql of [
    "ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS pre_cancel_status TEXT",
    "ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS pre_cancel_status TEXT",
    "ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS pre_cancel_status TEXT",
  ]) {
    assert.ok(PO_HELPERS.includes(sql), `missing self-apply: ${sql}`);
  }
  assert.match(SVC, /ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS pre_cancel_status TEXT/);
  // …and awaited on the path that WRITES it.
  assert.match(SVC, /await ensureServiceOrderMigrations\(c\.var\.DB\);\s*\n\s*const body/);
});

test("the schema fixture records them", () => {
  const schema = JSON.parse(read("tests/db-schema.json"));
  assert.ok(schema.production_orders.includes("pre_cancel_status"));
  assert.ok(schema.job_cards.includes("pre_cancel_status"));
  assert.ok(schema.sales_orders.includes("pre_cancel_status"));
  assert.ok(schema.sales_orders.includes("pre_hold_status"));
  assert.ok(schema.service_orders.includes("pre_cancel_status"));
});

test("all three surfaces offer the undo, so they cannot drift", () => {
  assert.match(SO_PAGE, /Undo Cancel/);
  assert.match(SVC_PAGE, /Undo Cancel/);
  assert.match(M_PAGE, /Undo Cancel/);
  assert.doesNotMatch(
    SO_PAGE,
    /\["SHIPPED", "INVOICED", "CLOSED", "CANCELLED"\]\.includes\(order\.status\)/,
    "CANCELLED must no longer be listed as having no actions left",
  );
});

test("the mobile cancel no longer claims it is permanent", () => {
  assert.doesNotMatch(M_PAGE, /This can't be undone/);
});

test("the undo is audited under its own action name", () => {
  assert.match(PO_HELPERS, /next === "UNCANCEL"\s*\n\s*\? "uncancel"/);
});

// ── Service CASES — a different table, and it was missed the first time ─────
// `service_cases` is not `service_orders`. Cancelling a CASE had the same
// dead end, plus a display bug that made it worse: the list's Stage column and
// the detail stepper are DERIVED from the case's service orders, so a case
// whose SV order had already been delivered kept reporting "Delivered" after
// the cancel. Owner 2026-08-04: "在外面也看不到这个地方已经变 cancel 了."

const CASES_ROUTE = read("src/api/routes/service-cases.ts");
const CASES_PAGE = read("src/pages/service-cases/detail.tsx");
const CASES_LIST = read("src/pages/service-cases/index.tsx");
const PIPELINE = read("src/lib/case-pipeline.ts");

test("a cancelled case is no longer terminal", () => {
  assert.match(CASES_ROUTE, /CANCELLED: \["OPEN", "IN_PROGRESS"\]/);
  assert.match(CASES_PAGE, /CANCELLED: \["OPEN", "IN_PROGRESS"\]/);
});

test("the case records the state its cancel interrupted", () => {
  assert.match(
    CASES_ROUTE,
    /ALTER TABLE service_cases ADD COLUMN IF NOT EXISTS pre_cancel_status TEXT/,
  );
  assert.match(
    CASES_ROUTE,
    /next === "CANCELLED" && existing\.status !== "CANCELLED"\s*\n\s*\? existing\.status/,
  );
});

test("leaving CANCELLED clears closedAt instead of COALESCE-ing it", () => {
  // COALESCE would keep the cancel timestamp, and every surface that dates the
  // case would still read it as closed.
  assert.match(CASES_ROUTE, /SET status = \?, closedAt = NULL,/);
  assert.match(
    CASES_ROUTE,
    /const leavingTerminal =\s*\n\s*existing\.status === "CANCELLED" && next !== "CANCELLED";/,
  );
});

test("the pipeline knows the case was cancelled", () => {
  // It only ever checked CLOSED, so the derivation ran on regardless.
  assert.match(PIPELINE, /const cancelled = input\.caseStatus === "CANCELLED";/);
  assert.match(
    PIPELINE,
    /const closed = input\.caseStatus === "CLOSED" \|\| cancelled;/,
  );
  assert.match(PIPELINE, /return \{ index, label, doneFlags, enteredAt, cancelled \};/);
});

test("a cancelled case reads as Cancelled in the list, not Delivered", () => {
  assert.match(CASES_LIST, /stageLabel: pipe\.cancelled \? "Cancelled" : pipe\.label/);
  assert.match(CASES_LIST, /Cancelled: "bg-\[#F5DCDC\] text-\[#7A2E24\]"/);
});

test("the detail stepper says so rather than showing a full chain", () => {
  assert.match(CASES_PAGE, /\{pipe\.cancelled && \(/);
  assert.match(CASES_PAGE, /This case was cancelled\./);
});

test("the case page offers the undo, and stops calling cancel permanent", () => {
  assert.match(CASES_PAGE, /Undo Cancel/);
  assert.doesNotMatch(CASES_PAGE, /This is terminal — the case can't be reopened/);
});

test("the case read exposes where to go back to", () => {
  assert.match(CASES_ROUTE, /preCancelStatus:\s*\n\s*\(row as \{ preCancelStatus\?: string \| null \}\)\.preCancelStatus/);
});
