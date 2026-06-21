import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMaterialPeriod, rollupByGroup, valueIssues } from "../src/lib/material-cost-fifo.ts";

const M = (events) => ({ rmId: "rm1", itemGroup: "FABRIC", opening: { qty: 10, unitCostSen: 100 }, openingDate: "2026-01-01", events });

test("opening only — no events", () => {
  const r = computeMaterialPeriod(M([]), "2026-06-01", "2026-06-30");
  assert.equal(r.openingSen, 1000); assert.equal(r.purchaseSen, 0);
  assert.equal(r.closingSen, 1000); assert.equal(r.consumedSen, 0);
});
test("FIFO consume eats oldest layer first", () => {
  // opening 10@100; receipt 5@200 on 6/5; issue 12 on 6/10 → consumes 10@100 + 2@200 = 1400
  const r = computeMaterialPeriod(M([
    { kind: "receipt", date: "2026-06-05", qty: 5, unitCostSen: 200 },
    { kind: "issue", date: "2026-06-10", qty: 12 },
  ]), "2026-06-01", "2026-06-30");
  assert.equal(r.openingSen, 1000);
  assert.equal(r.purchaseSen, 1000);   // 5×200
  assert.equal(r.consumedSen, 1400);   // 10×100 + 2×200
  assert.equal(r.closingSen, 600);     // 3×200 left
  assert.equal(r.openingSen + r.purchaseSen - r.closingSen, r.consumedSen); // 恒等式
});
test("negative stock flagged, valued at last cost", () => {
  const r = computeMaterialPeriod({ rmId: "rm2", itemGroup: "FOAM", opening: null, openingDate: "2026-01-01",
    events: [{ kind: "receipt", date: "2026-06-01", qty: 2, unitCostSen: 50 }, { kind: "issue", date: "2026-06-02", qty: 5 }] },
    "2026-06-01", "2026-06-30");
  assert.equal(r.negativeUnits, 3);
  assert.equal(r.consumedSen, 2*50 + 3*50); // 3 excess @ last cost 50 = 250
  assert.equal(r.closingSen, 0);
});
test("ADJUSTMENT in/out are receipt/issue", () => {
  const r = computeMaterialPeriod(M([{ kind: "issue", date: "2026-06-03", qty: 4 }]), "2026-06-01", "2026-06-30");
  assert.equal(r.consumedSen, 400); assert.equal(r.closingSen, 600);
});
test("rollupByGroup sums by item_group", () => {
  const a = computeMaterialPeriod(M([]), "2026-06-01", "2026-06-30");
  const out = rollupByGroup([a, { ...a, itemGroup: "FABRIC" }]);
  assert.equal(out.groups.length, 1);
  assert.equal(out.groups[0].openingSen, 2000);
  assert.equal(out.totals.openingSen, 2000);
});

// --- Task 4a: per-issue FIFO valuation (valueIssues) ---------------------------

test("valueIssues — single issue eats oldest first (12 over 10@100 + 5@200 = 1400)", () => {
  const issues = valueIssues(M([
    { kind: "receipt", date: "2026-06-05", qty: 5, unitCostSen: 200 },
    { kind: "issue", date: "2026-06-10", qty: 12 },
  ]));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].fifoCostSen, 1400); // 10×100 + 2×200
  assert.equal(issues[0].qty, 12);
  assert.equal(issues[0].date, "2026-06-10");
  assert.equal(issues[0].negativeUnits, 0);
});

test("valueIssues — ref carried through per issue", () => {
  const issues = valueIssues(M([
    { kind: "issue", date: "2026-06-03", qty: 2, ref: "PO-AAA" },
    { kind: "receipt", date: "2026-06-04", qty: 4, unitCostSen: 150 },
    { kind: "issue", date: "2026-06-05", qty: 1, ref: "PO-BBB" },
    { kind: "issue", date: "2026-06-06", qty: 1 }, // no ref
  ]));
  assert.equal(issues.length, 3);
  assert.equal(issues[0].ref, "PO-AAA");
  assert.equal(issues[1].ref, "PO-BBB");
  assert.equal(issues[2].ref, undefined);
});

test("valueIssues — negative stock flagged per issue, valued at last cost", () => {
  const issues = valueIssues({
    rmId: "rm2", itemGroup: "FOAM", opening: null, openingDate: "2026-01-01",
    events: [
      { kind: "receipt", date: "2026-06-01", qty: 2, unitCostSen: 50 },
      { kind: "issue", date: "2026-06-02", qty: 5, ref: "PO-NEG" },
    ],
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].negativeUnits, 3);
  assert.equal(issues[0].fifoCostSen, 2 * 50 + 3 * 50); // 2 from layer + 3 excess @ last 50
  assert.equal(issues[0].ref, "PO-NEG");
});

test("valueIssues — one IssueCost per issue event, receipts excluded", () => {
  const issues = valueIssues(M([
    { kind: "issue", date: "2026-06-02", qty: 1 },
    { kind: "receipt", date: "2026-06-03", qty: 3, unitCostSen: 100 },
    { kind: "issue", date: "2026-06-04", qty: 2 },
    { kind: "issue", date: "2026-06-05", qty: 1 },
  ]));
  assert.equal(issues.length, 3);
});

// --- THE LOAD-BEARING INVARIANT --------------------------------------------------
// For any material + any [start,end]:
//   Σ valueIssues(m).fifoCostSen where start <= date <= end  ===  computeMaterialPeriod(m,start,end).consumedSen
// Same FIFO, same core ⇒ exactly equal to the sen.

function sumIssuesInWindow(m, start, end) {
  return valueIssues(m)
    .filter((i) => i.date >= start && i.date <= end)
    .reduce((s, i) => s + i.fifoCostSen, 0);
}

function assertInvariant(m, start, end) {
  const period = computeMaterialPeriod(m, start, end);
  const summed = sumIssuesInWindow(m, start, end);
  assert.equal(
    summed,
    period.consumedSen,
    `invariant broke for [${start},${end}]: Σissues=${summed} vs consumedSen=${period.consumedSen}`,
  );
}

test("invariant — fractional-qty case: Σ in-window issue cost === consumedSen", () => {
  // fractional layers + fractional issues; the book-value-diff method must still tie out.
  const m = {
    rmId: "rmF", itemGroup: "FABRIC",
    opening: { qty: 3.33, unitCostSen: 137 }, openingDate: "2026-01-01",
    events: [
      { kind: "receipt", date: "2026-06-02", qty: 2.5, unitCostSen: 211 },
      { kind: "issue", date: "2026-06-03", qty: 1.75, ref: "P1" },
      { kind: "receipt", date: "2026-06-04", qty: 4.2, unitCostSen: 99 },
      { kind: "issue", date: "2026-06-05", qty: 5.1, ref: "P2" },
      { kind: "issue", date: "2026-06-20", qty: 0.9, ref: "P3" },
    ],
  };
  assertInvariant(m, "2026-06-01", "2026-06-30");
  // also a sub-window that splits issues across the boundary
  assertInvariant(m, "2026-06-04", "2026-06-10");
  assertInvariant(m, "2026-06-06", "2026-06-30");
});

test("invariant — multi-layer case: Σ in-window issue cost === consumedSen", () => {
  // mirrors the existing 'FIFO eats oldest first' scenario across several windows.
  const m = M([
    { kind: "receipt", date: "2026-06-05", qty: 5, unitCostSen: 200 },
    { kind: "issue", date: "2026-06-10", qty: 12 },
    { kind: "receipt", date: "2026-06-15", qty: 8, unitCostSen: 300 },
    { kind: "issue", date: "2026-06-20", qty: 4 },
  ]);
  assertInvariant(m, "2026-06-01", "2026-06-30");
  assertInvariant(m, "2026-06-01", "2026-06-12"); // only first issue
  assertInvariant(m, "2026-06-12", "2026-06-30"); // only second issue
});

test("invariant — negative-stock case: Σ in-window issue cost === consumedSen", () => {
  const m = {
    rmId: "rm2", itemGroup: "FOAM", opening: null, openingDate: "2026-01-01",
    events: [
      { kind: "receipt", date: "2026-06-01", qty: 2, unitCostSen: 50 },
      { kind: "issue", date: "2026-06-02", qty: 5 }, // 3 negative
      { kind: "receipt", date: "2026-06-03", qty: 10, unitCostSen: 70 },
      { kind: "issue", date: "2026-06-04", qty: 1 },
    ],
  };
  assertInvariant(m, "2026-06-01", "2026-06-30");
  assertInvariant(m, "2026-06-01", "2026-06-02"); // window ends right after the negative issue
});

test("invariant — randomized fuzz over many materials + windows", () => {
  // Deterministic LCG so failures are reproducible.
  let seed = 0x2026_06_22 >>> 0;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const day = (n) => `2026-06-${String(n).padStart(2, "0")}`;

  for (let trial = 0; trial < 300; trial++) {
    const events = [];
    const nEvents = 1 + Math.floor(rnd() * 8);
    for (let i = 0; i < nEvents; i++) {
      const d = day(1 + Math.floor(rnd() * 28));
      if (rnd() < 0.5) {
        // fractional qty + odd unit cost stress the rounding
        const qty = Math.round(rnd() * 800) / 100; // 0..8.00, 2dp
        const unitCostSen = 1 + Math.floor(rnd() * 500);
        events.push({ kind: "receipt", date: d, qty, unitCostSen });
      } else {
        const qty = Math.round(rnd() * 600) / 100; // 0..6.00, 2dp
        events.push({ kind: "issue", date: d, qty, ref: `P${i}` });
      }
    }
    const opening = rnd() < 0.7
      ? { qty: Math.round(rnd() * 500) / 100, unitCostSen: 1 + Math.floor(rnd() * 400) }
      : null;
    const m = { rmId: `rm${trial}`, itemGroup: "G", opening, openingDate: "2026-06-01", events };

    // a handful of random windows, including degenerate ones
    for (let w = 0; w < 4; w++) {
      let a = 1 + Math.floor(rnd() * 28);
      let b = 1 + Math.floor(rnd() * 28);
      if (a > b) [a, b] = [b, a];
      assertInvariant(m, day(a), day(b));
    }
    // and the all-encompassing window
    assertInvariant(m, "2026-06-01", "2026-06-28");
  }
});
