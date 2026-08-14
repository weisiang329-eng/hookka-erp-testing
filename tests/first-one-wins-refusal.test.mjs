// ---------------------------------------------------------------------------
// first-one-wins-refusal.test.mjs — BUG-2026-08-13-144 … -147.
//
// THE CLASS: code needs ONE row, several could answer (or none exactly does),
// and it takes `[0]`. The pick is silent, it is arbitrary — `IN (...)` and a
// `.filter` carry no order anyone chose — and every consumer downstream reads
// the result as if it had been looked up.
//
// This is the class BUG-2026-07-17-001 named ("first-one-wins guess"), where
// three invoice lines inherited one sales order's customer PO. The repo already
// carries the correct discipline in `src/api/lib/invoice-so-item-link.ts`:
// COUNT the claimants, link on exactly one, return NULL with a REASON for
// anything contested. This file pins that discipline at the four sites where
// the guess decided identity or money.
//
//   -144  three-way-match.ts   the receipt line priced against another ORDER's
//                              line at the same position                (money)
//   -145  worker/scan.tsx      a scanned barcode opening a DIFFERENT job card,
//                              marked `wholeCard: true`             (identity)
//   -146  worker.ts +          an 8-digit hash token resolved by `.find` across
//         public-rack-qr.ts    EVERY card in a department            (identity)
//   -147  production-orders.ts a scan of piece 5 completing piece 1  (identity)
//
// A WRONG MATCH IS WORSE THAN A MISSING ONE. A missing one reports "cannot
// check"; a wrong one reports "checked, all fine".
//
// Part BEHAVIOURAL — `resolveGrnPoLine` is pure, so the refusal rule is driven
// directly with adversarial fixtures. Part STRUCTURAL — the other three sites
// live inside request handlers whose branch can only be pinned at the source.
//
// EOL: every structural pattern is written with `\s` / `[\s\S]`, never a
// literal newline. This tree is CRLF; an `\n` anchor matches nothing and the
// assertion passes forever.
//
// Every assertion below was proved RED by reintroducing the exact removed
// expression, with the file's bytes asserted CHANGED ON DISK before the run.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildPoLineIndex,
  resolveGrnPoLine,
  isResolvedGrnPoLine,
} from "../src/api/lib/grn-po-line-link.ts";

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

const TWM = read("src/api/routes/three-way-match.ts");
const SCAN = read("src/pages/worker/scan.tsx");
const WORKER = read("src/api/routes/worker.ts");
const RACKQR = read("src/api/routes/public-rack-qr.ts");
const PROD = read("src/api/routes/production-orders.ts");

// Two orders, deliberately with the SAME NUMBER OF LINES so a positional read
// against the wrong one succeeds instead of falling off the end — that is what
// made the bug silent rather than loud.
const PO_A = "po-aaa";
const PO_B = "po-bbb";
const PO_ITEMS = [
  { id: "poi-a1", purchaseOrderId: PO_A },
  { id: "poi-a2", purchaseOrderId: PO_A },
  { id: "poi-b1", purchaseOrderId: PO_B },
  { id: "poi-b2", purchaseOrderId: PO_B },
];

// ═══════════════════════════════════════════════════════════════════════════
// BUG-2026-08-13-144 — BEHAVIOURAL: the money path refuses to guess.
// ═══════════════════════════════════════════════════════════════════════════

test("-144 a line with no po_id on a MULTI-order receipt is refused, not priced off order [0]", () => {
  const idx = buildPoLineIndex(PO_ITEMS, [PO_A, PO_B]);
  // The exact shape the old code mispriced: a legacy line (no po_item_id, no
  // po_id) on a receipt that spans two orders. `?? pos[0]` gave it PO_A's line
  // at index 1 — a real id, a real price, and the wrong order's.
  const r = resolveGrnPoLine(idx, { poItemIndex: 1 });
  assert.equal(r.poItemId, null, "a contested line must resolve to NOTHING");
  assert.equal(r.outcome, "contested-po");
  assert.equal(isResolvedGrnPoLine(r.outcome), false);
});

test("-144 the SAME line on a SINGLE-order receipt still resolves — legacy behaviour is unchanged", () => {
  // Being the only candidate is an OBSERVATION, not a guess. If this ever
  // starts refusing, every historical single-PO receipt stops being checkable,
  // which is the opposite failure and just as bad.
  const idx = buildPoLineIndex(
    PO_ITEMS.filter((i) => i.purchaseOrderId === PO_A),
    [PO_A],
  );
  const r = resolveGrnPoLine(idx, { poItemIndex: 1 });
  assert.equal(r.poItemId, "poi-a2");
  assert.equal(r.poId, PO_A);
  assert.equal(r.outcome, "positional");
  assert.equal(isResolvedGrnPoLine(r.outcome), true);
});

test("-144 a line that NAMES its own order is read on that order, not on the header", () => {
  const idx = buildPoLineIndex(PO_ITEMS, [PO_A, PO_B]);
  const r = resolveGrnPoLine(idx, { po_id: PO_B, poItemIndex: 0 });
  assert.equal(r.poItemId, "poi-b1", "index 0 of PO_B, never index 0 of PO_A");
  assert.equal(r.poId, PO_B);
  assert.equal(r.outcome, "positional");
});

test("-144 an explicit po_item_id wins over any position", () => {
  const idx = buildPoLineIndex(PO_ITEMS, [PO_A, PO_B]);
  // The index says A's first line; the recorded id says B's second. Identity
  // must win, and the resolved poId must follow the LINE, not the hint.
  const r = resolveGrnPoLine(idx, {
    po_id: PO_A,
    po_item_id: "poi-b2",
    poItemIndex: 0,
  });
  assert.equal(r.poItemId, "poi-b2");
  assert.equal(r.poId, PO_B);
  assert.equal(r.outcome, "id");
});

test("-144 po_item_id / po_id are read dual-keyed (camelCase spelling resolves too)", () => {
  // They are snake_case in the schema, but a driver or view may hand them back
  // camelCased; a one-sided read sees undefined and silently degrades to the
  // positional path — which is the bug wearing a different hat.
  const idx = buildPoLineIndex(PO_ITEMS, [PO_A, PO_B]);
  assert.equal(resolveGrnPoLine(idx, { poItemId: "poi-b1" }).poItemId, "poi-b1");
  assert.equal(
    resolveGrnPoLine(idx, { poId: PO_B, poItemIndex: 1 }).poItemId,
    "poi-b2",
  );
});

test("-144 a RECORDED po_item_id that no loaded order carries does NOT fall through to the position", () => {
  // The receipt already answered the question. Asking a vaguer question until
  // some row answers is exactly how a wrong link gets written with a clear
  // conscience (invoice-so-item-link.ts makes the same refusal).
  const idx = buildPoLineIndex(PO_ITEMS, [PO_A, PO_B]);
  const r = resolveGrnPoLine(idx, {
    po_id: PO_A,
    po_item_id: "poi-deleted",
    poItemIndex: 0,
  });
  assert.equal(r.poItemId, null);
  assert.equal(r.outcome, "unknown-line");
});

test("-144 an out-of-range or missing position is refused, never clamped to a neighbour", () => {
  const idx = buildPoLineIndex(PO_ITEMS, [PO_A]);
  assert.equal(resolveGrnPoLine(idx, { poItemIndex: 9 }).outcome, "index-out-of-range");
  assert.equal(resolveGrnPoLine(idx, { poItemIndex: 9 }).poItemId, null);
  assert.equal(resolveGrnPoLine(idx, { poItemIndex: null }).outcome, "index-missing");
  assert.equal(resolveGrnPoLine(idx, {}).poItemId, null);
  assert.equal(resolveGrnPoLine(buildPoLineIndex([], []), {}).outcome, "no-po");
});

test("-144 buildPoLineIndex preserves the caller's ORDER BY and does not re-sort", () => {
  // `poItemIndex` is a position, and a position only means something against a
  // stated order. If this index ever sorts on its own, it silently overrides
  // PO_ITEMS_ORDER and re-opens the mismatch below.
  const reversed = [
    { id: "poi-a2", purchaseOrderId: PO_A },
    { id: "poi-a1", purchaseOrderId: PO_A },
  ];
  const idx = buildPoLineIndex(reversed, [PO_A]);
  assert.equal(resolveGrnPoLine(idx, { poItemIndex: 0 }).poItemId, "poi-a2");
});

// ═══════════════════════════════════════════════════════════════════════════
// BUG-2026-08-13-144 — STRUCTURAL: the route wires the resolver in, prices
// NULL rather than 0, and cannot report FULL_MATCH over an unchecked line.
// ═══════════════════════════════════════════════════════════════════════════

test("-144 three-way-match resolves through the counting resolver, and pos[0] is gone", () => {
  assert.match(TWM, /resolveGrnPoLine\(lineIdx,\s*gi\)/);
  assert.doesNotMatch(
    TWM,
    /\?\?\s*pos\[0\]/,
    "falling back to an arbitrary purchase order IS the bug",
  );
  assert.doesNotMatch(
    TWM,
    /itemsByPo\.get\(ownerPoId\)/,
    "the positional read must go through the resolver, not back into the route",
  );
});

test("-144 the header PO refuses too — one claimant is kept, several are not", () => {
  assert.match(
    TWM,
    /pos\.find\(\(p\)\s*=>\s*p\.id === grn\.poId\)\s*\?\?\s*\(pos\.length === 1 \? pos\[0\] : null\)/,
  );
});

test("-144 an unresolved line is priced NULL, never 0", () => {
  // `?? 0` was the second half of the money bug: "ordered 0 @ RM 0.00" beside a
  // real receipt reads as a finding, not as "never checked", and it drives the
  // variance against TOLERANCE either way.
  assert.match(TWM, /const poQty = resolved \? \(poItem\?\.quantity \?\? null\) : null;/);
  assert.match(TWM, /const poPrice = resolved \? \(poItem\?\.unitPriceSen \?\? null\) : null;/);
  assert.doesNotMatch(TWM, /const poPrice = poItem\?\.unitPriceSen \?\? 0;/);
  assert.doesNotMatch(TWM, /const poQty = poItem\?\.quantity \?\? 0;/);
});

test("-144 an unresolved line can never reach FULL_MATCH", () => {
  assert.match(
    TWM,
    /const allMatched = unresolvedLines === 0 && matchItems\.every\(\(i\) => i\.matched\);/,
  );
  assert.doesNotMatch(
    TWM,
    /const allMatched = matchItems\.every\(\(i\) => i\.matched\);/,
  );
  // and the count is published, not swallowed
  assert.match(TWM, /unresolvedLines,/);
});

test("-144 each line records WHY it did or did not resolve", () => {
  assert.match(TWM, /resolution: link\.outcome,/);
  assert.match(TWM, /poItemId: link\.poItemId,/);
  // Rows written before this change carry no reason and must not be relabelled.
  assert.match(TWM, /r\.resolution \?\? "legacy-unknown"/);
});

test("-144 the position is read against the SAME order the stock draw-down uses", () => {
  // `grn.ts:930` reads poItemIndex against PO_ITEMS_ORDER ("line_no NULLS
  // LAST, id"); this file used a plain `ORDER BY id`. `line_no` is the PAPER
  // order, written from the request array index on POST/PUT, so the two diverge
  // the first time a PO's lines are reordered — and then one GRN line drew
  // stock from one PO line and was PRICED against another, on a SINGLE-PO
  // receipt, with nothing logged.
  assert.match(
    TWM,
    /SELECT \* FROM purchase_order_items WHERE purchaseOrderId IN \(\$\{placeholders\}\) \$\{PO_ITEMS_ORDER\}/,
  );
  assert.doesNotMatch(
    TWM,
    /purchase_order_items WHERE purchaseOrderId IN \(\$\{placeholders\}\) ORDER BY id/,
  );
  // line_no is self-applied, and migrations are inert on deploy in this repo —
  // without this await the ORDER BY names a column that may not exist yet.
  //
  // ⚠ Anchored to the START of the line. The first draft matched the bare
  // substring and stayed GREEN with the call commented out — the mutation run
  // caught it. A guard that matches a substring is not a guard.
  assert.match(TWM, /^\s*await ensurePoItemLineNo\(c\.var\.DB\);\s*$/m);
});

// ═══════════════════════════════════════════════════════════════════════════
// BUG-2026-08-13-145 — the worker's barcode opens the card they scanned.
// ═══════════════════════════════════════════════════════════════════════════

test("-145 a schedule barcode resolves only to a SOLE match, never to matches[0]", () => {
  assert.match(
    SCAN,
    /matches\.find\(\(m\) => m\.jobCard\.id === barcodeJcId\)\s*\?\?\s*\(matches\.length === 1 \? matches\[0\] : undefined\)/,
  );
  assert.doesNotMatch(
    SCAN,
    /matches\.find\(\(m\) => m\.jobCard\.id === barcodeJcId\)\s*\?\?\s*matches\[0\];/,
    "matches[0] on the PO-number branch is EVERY card on the order",
  );
});

test("-145 the whole-card completion still hangs off that single hit", () => {
  // The danger is the pairing, not either half: an arbitrary card marked
  // `wholeCard: true` completes work nobody scanned.
  assert.match(SCAN, /setResult\(\{ kind: "lookup", \.\.\.hit, wholeCard: true \}\)/);
});

// ═══════════════════════════════════════════════════════════════════════════
// BUG-2026-08-13-146 — an 8-digit hash is not an identity.
// ═══════════════════════════════════════════════════════════════════════════

for (const [label, src] of [
  ["worker.ts scan-lookup", WORKER],
  ["public-rack-qr.ts", RACKQR],
]) {
  test(`-146 ${label} counts the claimants on a barcode token instead of taking the first`, () => {
    // `deriveBarcodeToken` folds the job-card id to 8 digits (`% 100_000_000`).
    // Its own comment justifies that as "bounded by current WIP for one dept" —
    // but the SELECT beneath it has NO status filter (deliberately, so a
    // finished card says "already done"), so the real population is every card
    // the department has ever had. `.find` over that is first-one-wins on a
    // NON-UNIQUE key, deciding which physical piece a worker just handled.
    assert.match(
      src,
      /const tokenHits = cand\.filter\([\s\S]{0,200}?deriveBarcodeToken\(j\.id, j\.departmentCode \?\? deptCode\) === term,[\s\S]{0,40}?\);/,
    );
    assert.match(src, /const hit = tokenHits\.length === 1 \? tokenHits\[0\] : undefined;/);
    assert.doesNotMatch(
      src,
      /const hit = cand\.find\(/,
      "picking the first card that folds to the same 8 digits is the bug",
    );
    // A refusal that leaves no trace is a silent "Not found" nobody can debug.
    assert.match(src, /barcode token is ambiguous — refusing to guess/);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// BUG-2026-08-13-147 — a scan of piece 5 must not complete piece 1.
// ═══════════════════════════════════════════════════════════════════════════

test("-147 the scanned piece resolves to its own slot, or to a card that has only one", () => {
  assert.match(
    PROD,
    /slots\.find\(\(s\) => s\.pieceNo === pieceNo\)\s*\?\?\s*\(slots\.length === 1 \? slots\[0\] : undefined\)/,
  );
  assert.doesNotMatch(
    PROD,
    /slots\.find\(\(s\) => s\.pieceNo === pieceNo\)\s*\?\?\s*slots\[0\];/,
    "slot[0] is piece 1 — completing it for a scan of piece 5 credits the wrong piece",
  );
  // And the refusal says which piece, so a shrunk wipQty is diagnosable.
  assert.match(PROD, /which isn't on this job card/);
});

// ═══════════════════════════════════════════════════════════════════════════
// The class itself — the sites that are ALLOWED to keep a `[0]` fallback, and
// why. Recorded here so the next sweep does not have to re-derive it.
// ═══════════════════════════════════════════════════════════════════════════

test("class — the deliberate first-one-wins in do-value.ts is still LABELLED as deliberate", () => {
  // `priceForItem`'s maps are first-one-wins on purpose: for a PRICE LOOKUP any
  // matching line's value will do. Its identity twin next door counts instead.
  // If that annotation ever disappears, the next reader "fixes" the wrong one.
  const DOVALUE = read("src/api/lib/do-value.ts");
  assert.match(DOVALUE, /first-one-wins by design/);
  assert.match(DOVALUE, /COUNTS claimants/);
});
