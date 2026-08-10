// ---------------------------------------------------------------------------
// invoice-void-family.test.mjs — voiding a sales invoice must cover EVERY leg
// its document family ever posted.
//
// BUG-2026-08-06-005. The void path reverses the visible family net (LIKE
// 'invoice%' — correct since BUG-2026-07-23-002) but then hid only the exact
// types IN ('invoice','invoice_void'). An EDITED invoice's live legs are
// `invoice_restate_post:<stamp>`: the hide left them visible while hiding the
// just-written reversal, so the cancelled invoice kept its full debit on
// 300-0000. Found live the day the owner voided the two Carress error invoices
// — 12,802.76 stayed on the debtor control and surfaced as a +12,802.76 half
// of the AR drift, masked under the −25,000 Houzs half.
//
// Same class as BUG-2026-07-08-002 (supplier payments) and the 2026-07-09
// other-party-bill fix: every module that edits via restate MUST treat the
// whole `<type>%` family as the document when voiding. This is the sales-
// invoice instance.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(process.cwd(), "src/api/routes/invoices.ts"),
  "utf8",
).replace(/\r\n/g, "\n");

test("the reversal nets the whole visible family", () => {
  const fn = SRC.slice(SRC.indexOf("async function buildCancelReversalStatements"));
  assert.match(fn.slice(0, 900), /sourceType LIKE 'invoice%'/);
});

test("the hide covers the whole family too — not an exact-type list", () => {
  assert.match(
    SRC,
    /SET hidden = 1 WHERE sourceType LIKE 'invoice%' AND sourceId = \?/,
    "the hide must reach invoice_restate_post/rev legs, or an edited invoice survives its own void",
  );
  assert.doesNotMatch(
    SRC,
    /SET hidden = 1 WHERE sourceType IN \('invoice','invoice_void'\)/,
    "the exact-type hide list is the defect — it leaves an edited invoice's restate legs live",
  );
});

test("the hide is org-agnostic, like the reversal", () => {
  // An orgId bind on the family hide is exactly how BUG-2026-07-23-002 skipped
  // five Carress cancels; sourceId is globally unique and suffices.
  const at = SRC.indexOf("SET hidden = 1 WHERE sourceType LIKE 'invoice%'");
  assert.ok(at > 0);
  const stmt = SRC.slice(at, at + 200);
  assert.doesNotMatch(stmt, /orgId/);
});
