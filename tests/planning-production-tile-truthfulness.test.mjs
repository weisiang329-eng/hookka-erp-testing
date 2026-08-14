// ---------------------------------------------------------------------------
// planning-production-tile-truthfulness.test.mjs — the four tiles left unfixed
// by the 2026-08-14 dashboard audit (docs/DASHBOARD-DATA-AUDIT.md). All four
// are docs/BUG-CLASSES.md C15, and all four turn on the same corollary:
//
//     `0` is a claim, not a blank.
//
//   BUG-2026-08-13-144  /planning/mrp computed its shortages with
//                       `const onOrder = 0;` (mrp.ts:701). Material already
//                       sitting on an open purchase order reported as a FULL
//                       shortage, so the page recommended re-ordering stock
//                       that was already inbound. The real figure was three
//                       feet away — the Fabric tab of the same page already
//                       computes "PO Outstanding" in fabric-usage.ts.
//
//   BUG-2026-08-13-145  …and on the same row, `moq = mainBinding?.moq || 50`
//                       and `leadTimeDays = mainBinding?.leadTimeDays || 14`.
//                       Two literals, printed on the cell carrying the
//                       SUPPLIER'S NAME, so they read as figures the supplier
//                       had stated. Neither has a source. Note 0 does not mean
//                       "zero" in those columns: supplier_material_bindings.moq
//                       and .leadTimeDays are `INTEGER NOT NULL DEFAULT 0`
//                       (migrations/0001_init.sql:273,275), so 0 is what an
//                       untouched row holds and is UNMEASURED, not a value.
//
//   BUG-2026-08-13-146  /production Overview asserted "0 of 0 work orders ·
//                       0/0 cells complete" in the same viewport as its own
//                       "No orders loaded yet." callout, because the matrix is
//                       gated on `activeTab === "ALL"` while the fetch is gated
//                       on `shouldFetch` (default false in overview mode). No
//                       request had been sent; the footer stated a result for
//                       it anyway.
//
//   BUG-2026-08-13-147  /production/wip-times destructured `loading` and used
//                       it only for the export button and the table — never for
//                       the four totals tiles. During the fetch, on a dead read
//                       and on an empty body all four printed `0`, and
//                       "⚠️ Missing BOM time" printed its 0 in the NEUTRAL
//                       colour (amber only when `> 0`), so a failed load was
//                       pixel-identical to all-clear. The same tile is also
//                       structurally blind to the worst case it exists to
//                       catch — a product with NO active BOM template emits no
//                       row — which is now counted and published beside it.
//
// STRUCTURAL (readFileSync source assertions), for the reason every sibling
// *-truthfulness / no-fabricated-* file gives: none of these is a runtime
// error. `0` is a valid number, a grey `0` is valid markup and `|| 50` is valid
// arithmetic — a plausible screen is exactly what this class produces, so the
// source is the only thing that can be pinned.
//
// Comments are stripped before matching so this header may quote each removed
// expression verbatim without satisfying or tripping a guard, and every read
// normalises CRLF + BOM so the assertions are EOL-agnostic (this repo's files
// are CRLF; a literal \n anchor would silently match nothing — five false
// all-clears in one week came from exactly that).
//
// Every assertion below was proved RED by reintroducing the exact removed
// expression on disk, asserting the byte count changed, and watching this file
// fail. See the PR body for the recorded red runs.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const read = (rel) =>
  readFileSync(join(root, rel), "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");

// Block comments are anchored to the start of a line — the unanchored pattern
// eats JSX `accept="*/*"`-style attributes and silently blanks the rest of the
// file, which is how a guard passes while the bug is still in it.
function stripComments(src) {
  return src
    .replace(/^[ \t]*\{?\/\*[\s\S]*?\*\/\}?[ \t]*$/gm, "")
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

const MRP_API = "src/api/routes/mrp.ts";
const MRP_PAGE = "src/pages/planning/mrp.tsx";
const PROD_PAGE = "src/pages/production/index.tsx";
const WIP_PAGE = "src/pages/production/wip-times.tsx";
const WIP_CORE = "src/api/lib/wip-times-core.ts";
const WIP_API = "src/api/routes/wip-times.ts";
const TYPES = "src/types/index.ts";

const mrpApi = () => stripComments(read(MRP_API));
const mrpPage = () => stripComments(read(MRP_PAGE));
const prodPage = () => stripComments(read(PROD_PAGE));
const wipPage = () => stripComments(read(WIP_PAGE));

// ===========================================================================
// BUG-2026-08-13-144 — MRP shortages ignored everything already on order
// ===========================================================================

test("mrp.ts must not hard-code onOrder to a literal", () => {
  const src = mrpApi();
  assert.ok(
    !/const onOrder\s*=\s*0\s*;/.test(src),
    "`const onOrder = 0;` is back — every open PO is invisible again and the " +
      "page recommends re-ordering inbound stock",
  );
  assert.ok(
    /const onOrder = onOrderByCode\.get\(code\) \?\? 0;/.test(src),
    "onOrder must come from the per-material open-PO map. The `?? 0` here is " +
      "legitimate and is NOT the bug: a material with no open PO line genuinely " +
      "has nothing on order — the bug was the map never existing",
  );
});

test("the on-order query reads open PO lines from the real tables", () => {
  const src = mrpApi();
  assert.ok(
    /FROM purchase_order_items poi/.test(src),
    "on-order must be summed from purchase_order_items, not inferred",
  );
  assert.ok(
    /INNER JOIN purchase_orders po ON po\.id = poi\.purchaseOrderId/.test(src),
    "the line must be joined to its PO so the PO's status can gate it",
  );
  assert.ok(
    /po\.status NOT IN \('RECEIVED', 'CANCELLED', 'CLOSED'\)/.test(src),
    "OPEN is the same definition the Fabric tab of this very page already uses " +
      "(fabric-usage.ts). Two tabs of one page disagreeing about 'on order' " +
      "would be a new defect",
  );
  assert.ok(
    /GREATEST\(poi\.quantity - COALESCE\(poi\.receivedQty, 0\), 0\)/.test(src),
    "per-line outstanding is ordered − received, floored at 0 — a GRN " +
      "over-receipt must not manufacture negative demand",
  );
  assert.ok(
    /NULLIF\(TRIM\(poi\.material_code\), ''\)/.test(src) &&
      /SPLIT_PART\(poi\.materialName, ' - ', 1\)/.test(src),
    "code resolution must try material_code (migration 0103) AND the legacy " +
      "`<itemCode> - <description>` materialName convention, or every pre-0103 " +
      "PO line silently contributes nothing",
  );
});

test("open PO lines that resolve to no material code are COUNTED, not dropped", () => {
  const src = mrpApi();
  assert.ok(
    /onOrderUnresolvedLines \+= Number\(r\.lines\) \|\| 0;/.test(src),
    "a line whose inbound quantity is credited to nothing must be counted — " +
      "silently dropping it is BUG-2026-08-13-096, a clean number that means " +
      "'cannot see'",
  );
  assert.ok(
    /onOrderUnresolvedLines,\n\s*horizon: horizonParam,/.test(src),
    "…and published in the response meta so the page can qualify On Order",
  );
});

test("a reloaded MRP run reports UNCOUNTED coverage as null, never 0", () => {
  const src = mrpApi();
  assert.ok(
    /onOrderUnresolvedLines:\n?\s*latestRun\.onOrderUnresolvedLines == null\n?\s*\? null/.test(
      src.replace(/\s+/g, " ").replace(/ /g, " ") // tolerate reflow
    ) ||
      /latestRun\.onOrderUnresolvedLines == null/.test(src),
    "a run persisted before this count existed must reload as null — `|| 0` " +
      "would turn 'nobody counted' into 'there were none'",
  );
  assert.ok(
    !/onOrderUnresolvedLines:\s*Number\(latestRun\.onOrderUnresolvedLines\)\s*\|\|\s*0/.test(src),
    "`Number(...) || 0` is the exact laundering this guard exists to stop",
  );
});

test("the On Order figure is rendered where it is subtracted", () => {
  const src = mrpPage();
  assert.ok(
    />\s*On Order\s*</.test(src),
    "the column must exist — while the server hard-coded 0 there was no column, " +
      "so the operator could not see that Net Req ignored every open PO",
  );
  assert.ok(
    /\{req\.onOrder > 0 \? req\.onOrder : "-"\}/.test(src),
    "the row must print the real per-material on-order quantity",
  );
});

test("the page states its On-Order coverage instead of implying completeness", () => {
  const src = mrpPage();
  assert.ok(
    /On Order below is a floor/.test(src),
    "when some open PO lines resolve to no material code, On Order is a floor " +
      "and the shortage it feeds is overstated — the page must say so",
  );
  assert.ok(
    /onOrderCoverageUnknown/.test(src),
    "a saved run with no count must say the coverage is unknown, not fine",
  );
});

// ===========================================================================
// BUG-2026-08-13-145 — an invented MOQ and lead time, under the supplier's name
// ===========================================================================

test("mrp.ts must not invent an MOQ or a lead time", () => {
  const src = mrpApi();
  assert.ok(
    !/moq\s*=\s*mainBinding\?\.moq\s*\|\|\s*50/.test(src),
    "`mainBinding?.moq || 50` is back — an invented minimum order quantity, " +
      "rounded into a suggested PO the owner can act on",
  );
  assert.ok(
    !/leadTimeDays\s*=\s*mainBinding\?\.leadTimeDays\s*\|\|\s*14/.test(src),
    "`mainBinding?.leadTimeDays || 14` is back — a deadline built on a literal, " +
      "printed under the supplier's own name",
  );
  // The general form, so the next author cannot swap in a different literal.
  assert.ok(
    !/mainBinding\?\.(moq|leadTimeDays)\s*\|\|\s*\d/.test(src),
    "no numeric fallback of ANY value belongs on these two fields — the point " +
      "is not that 50 and 14 were the wrong numbers, it is that there is no " +
      "number to state",
  );
});

test("an unstated MOQ / lead time becomes null, and 0 counts as unstated", () => {
  const src = mrpApi();
  assert.ok(
    /const moq = Number\.isFinite\(rawMoq\) && rawMoq > 0 \? rawMoq : null;/.test(src),
    "moq must be null unless the binding states a positive one. `> 0` is " +
      "deliberate: the column is INTEGER NOT NULL DEFAULT 0, so 0 cannot be " +
      "told apart from 'never filled in'",
  );
  assert.ok(
    /const leadTimeDays = Number\.isFinite\(rawLead\) && rawLead > 0 \? rawLead : null;/.test(
      src,
    ),
    "same rule for the lead time",
  );
});

test("no MOQ means suggest exactly the shortage — not a rounded invention", () => {
  const src = mrpApi();
  assert.ok(
    /moq == null \? netRequired : Math\.ceil\(netRequired \/ moq\) \* moq/.test(src),
    "with no stated MOQ the suggestion must be the measured shortage itself; " +
      "rounding it up requires an MOQ that someone actually stated",
  );
});

test("no lead time means no deadline — the red 'Order By' date cannot be guessed", () => {
  const src = mrpApi();
  assert.ok(
    /if \(earliestNeedDate && netRequired > 0 && leadTimeDays != null\)/.test(src),
    "suggestedOrderDate must not be computed without a lead time — the cell " +
      "turns RED on that date, and a deadline with no input is a guess wearing " +
      "a warning",
  );
});

test("the MRP page renders an em dash for an unstated MOQ / lead time", () => {
  const src = mrpPage();
  assert.ok(
    /\{moq == null \? "MOQ —" : `MOQ \$\{moq\}`\}/.test(src),
    "an unstated MOQ must render '—' beside the suggested quantity",
  );
  assert.ok(
    /\{leadTime == null \? "lead time —" : `\$\{leadTime\}d lead`\}/.test(src),
    "an unstated lead time must render '—' under the supplier name, not vanish " +
      "and not print a number",
  );
  assert.ok(
    !/leadTimeDays\s*\?\?\s*\d/.test(src) && !/req\.moq\s*\?\?\s*\d/.test(src),
    "no numeric fallback may be reintroduced on the page either — the API fix " +
      "is undone by one `?? 14` in the renderer",
  );
});

test("the shared MRP type carries null, so a fallback cannot be typed away", () => {
  const src = stripComments(read(TYPES));
  assert.ok(
    /moq\?: number \| null;/.test(src) && /leadTimeDays\?: number \| null;/.test(src),
    "both fields must admit null in the type the page reads, or the renderer " +
      "is pushed back into `as Record<string, unknown>` casts and any literal " +
      "becomes invisible to tsc",
  );
});

// ===========================================================================
// BUG-2026-08-13-146 — /production Overview's 0/0 on a cold landing
// ===========================================================================

test("production Overview counts are gated on an OBSERVED payload", () => {
  const src = prodPage();
  assert.ok(
    /const ordersLoadFailed = ordersUrl != null && isUnknownOutcome\(ordersFailure\);/.test(src),
    "the dead-read case must use isUnknownOutcome — the repo's single decision " +
      "(BUG-2026-08-13-107 / -016), not a second mechanism",
  );
  assert.ok(
    /failure: ordersFailure/.test(src),
    "…which requires the orders fetch to actually READ `failure`; it did not",
  );
  assert.ok(
    /const ordersObserved =\n?\s*ordersUrl != null && \(orders\.length > 0 \|\| \(!loading && !ordersLoadFailed\)\);/.test(
      src,
    ),
    "cold landing (ordersUrl null — no request was ever sent), in-flight and " +
      "dead read must all be excluded; only an observed body licenses a count",
  );
});

test("the matrix footer prints '—' with a reason, not a confident 0/0", () => {
  const src = prodPage();
  // Both spans must live INSIDE the `ordersObserved ?` true branch. Matching
  // them together in one anchored pattern is the point: an assertion that
  // merely finds `{ordersObserved` somewhere in the file would pass while the
  // guard had been short-circuited out of the branch — the exact way a guard in
  // record-load-failure-class.test.mjs went green over a live bug.
  assert.ok(
    /\{ordersObserved \? \(\s*<>\s*<span>\{visibleOrders\.length\} of \{orders\.length\} work orders<\/span>\s*<span>\{overallDone\}\/\{overallTotal\} cells complete<\/span>\s*<\/>\s*\) : \(/.test(
      src,
    ),
    "both footer counts must sit inside the observed branch of one gate",
  );
  assert.ok(
    /— cells complete \(\{ordersUnobservedReason\}\)/.test(src),
    "'0/0 cells complete' rendered under 'No orders loaded yet.' — the " +
      "replacement must state WHICH of the three unsourceable cases it is in, " +
      "otherwise '—' is only a prettier lie",
  );
});

test("the tab bar fractions are gated too — the bug was not only in the footer", () => {
  const src = prodPage();
  assert.ok(
    /\{ordersObserved \? `\$\{overallDone\}\/\$\{overallTotal\}` : "—"\}/.test(src),
    "the Overview tab printed the same unsourceable 0/0",
  );
  assert.ok(
    /\{ordersObserved \? `\$\{d\.done\}\/\$\{d\.total\}` : "—"\}/.test(src),
    "…and so did every one of the eight department tabs",
  );
});

test("'No production orders found.' is only said about an observed body", () => {
  const src = prodPage();
  assert.ok(
    /ordersObserved\n?\s*\? "No production orders found\."/.test(src),
    "a statement about the factory needs an observation behind it (C15's " +
      "false-absence half)",
  );
  assert.ok(
    /— orders \(\{ordersUnobservedReason\}\)/.test(src),
    "the header's 'N of M orders' printed 0 of 0 on a dead read too",
  );
});

// ===========================================================================
// BUG-2026-08-13-147 — wip-times' four tiles, and the tile's own blind spot
// ===========================================================================

test("wip-times reads `failure` and classifies it with the shared guard", () => {
  const src = wipPage();
  assert.ok(
    /const rowsFailed = isUnknownOutcome\(failure\);/.test(src),
    "the repo's single decision, reused — not a second mechanism",
  );
  assert.ok(
    /const rowsObserved = !rowsFailed && Array\.isArray\(resp\?\.data\);/.test(src),
    "only an actual array in the response body is an observation. `!loading` " +
      "alone is not: a dead read also ends with loading=false",
  );
});

test("all four totals tiles render '—' unless the payload was observed", () => {
  const src = wipPage();
  for (const [expr, label] of [
    ['totals.wips.toLocaleString()', "WIPs in scope"],
    ['totals.productAppearances.toLocaleString()', "Product appearances"],
    ['fmtMinutes(totals.avgMinutes)', "Avg across WIPs"],
    ['totals.missing.toLocaleString()', "Missing BOM time"],
  ]) {
    const guarded = new RegExp(
      `\\{rowsObserved \\? ${expr.replace(/[.()*+?^${}|[\]\\]/g, "\\$&")} : "—"\\}`,
    );
    assert.ok(guarded.test(src), `${label} tile is printing a number ungated`);
  }
});

test("the Missing-BOM-time tile must not wear the all-clear colour when unknown", () => {
  const src = wipPage();
  assert.ok(
    /!rowsObserved\n?\s*\? "text-\[#9CA3AF\]"\n?\s*: totals\.missing > 0\n?\s*\? "text-\[#C99A3F\]"/.test(
      src,
    ),
    "this tile went amber only when `> 0`, so a failed load rendered its 0 in " +
      "the neutral colour and read as all-clear. The unknown state must be " +
      "grey and must be tested FIRST, before the >0 branch",
  );
  assert.ok(
    /Couldn&apos;t load WIP times — the figures below are unknown, not clear\./.test(src),
    "a dead read must say so and offer a retry, not leave four dashes to " +
      "interpret",
  );
});

test("the tile publishes the blind spot it structurally cannot observe", () => {
  const core = stripComments(read(WIP_CORE));
  assert.ok(
    /export async function countProductsWithoutActiveBom/.test(core),
    "a product with NO active BOM template emits no process row, so the tile " +
      "could never count the most complete form of 'missing BOM time'. It is " +
      "now counted",
  );
  assert.ok(
    /UPPER\(COALESCE\(bt\.versionStatus, ''\)\) = 'ACTIVE'/.test(core) &&
      /NOT EXISTS/.test(core),
    "the count must be 'no ACTIVE template exists', mirroring the exact filter " +
      "in loadActiveBomRows that creates the blind spot",
  );

  const api = stripComments(read(WIP_API));
  assert.ok(
    /productsWithoutActiveBom,/.test(api),
    "…and published on the response",
  );
  assert.ok(
    /let productsWithoutActiveBom: number \| null = null;/.test(api),
    "a failed coverage query must report null, never 0 — reporting 0 would " +
      "assert full coverage off a query that did not run",
  );

  const page = stripComments(read(WIP_PAGE));
  assert.ok(
    /not measured\) — they emit no row, so this count excludes them/.test(page),
    "an unmeasured blind spot must be stated as '—', not omitted",
  );
  assert.ok(
    /they emit no row to count/.test(page),
    "when the blind spot is non-empty the tile must say how many it excludes",
  );
  assert.ok(
    /whole category, not this dept/.test(page),
    "the count is category-scoped and can never be dept-scoped (a product with " +
      "no BOM has no department); reading it as 'in this dept' would be a new " +
      "mislabelling",
  );
});
