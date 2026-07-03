import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeMaterialPeriod,
  rollupByGroup,
  valueIssues,
  computeMaterialCheckpoints,
  windowFromCheckpoints,
} from "../src/lib/material-cost-fifo.ts";

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

// --- F6-v2: single-pass monthly checkpoints === per-window computeMaterialPeriod ---
// The perf rebuild replays each item ONCE and derives every P&L window from
// monthly snapshots. It MUST reproduce computeMaterialPeriod (the proven slow
// path) to the sen, for any month-aligned window — that equivalence is what
// lets the finance side stop re-replaying per window.

function monthEndIso(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // day 0 of next month = last day of this
}
function prevMonthYm(ym) {
  let [y, m] = ym.split("-").map(Number);
  m -= 1; if (m === 0) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
}
function monthSeq(startYm, endYm) {
  const out = [];
  let [y, m] = startYm.split("-").map(Number);
  const [ey, em] = endYm.split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1; if (m === 13) { m = 1; y += 1; }
  }
  return out;
}
function checkpointLookup(m, monthsYm) {
  const cps = computeMaterialCheckpoints(m, monthsYm.map(monthEndIso));
  const byYm = new Map();
  cps.forEach((cp, i) => byYm.set(monthsYm[i], cp));
  return byYm;
}
function assertCheckpointMatch(m, monthsYm, startYm, endYm) {
  const byYm = checkpointLookup(m, monthsYm);
  const fast = windowFromCheckpoints(byYm.get(endYm), byYm.get(prevMonthYm(startYm)) ?? null);
  const slow = computeMaterialPeriod(m, `${startYm}-01`, monthEndIso(endYm));
  // Money (integer sen) must be bit-exact — sums/diffs of integers never drift.
  for (const k of ["openingSen", "purchaseSen", "closingSen", "consumedSen"]) {
    assert.equal(fast[k], slow[k], `checkpoint ${k} mismatch [${startYm}..${endYm}]: fast=${fast[k]} slow=${slow[k]}`);
  }
  // negativeUnits is a FRACTIONAL diagnostic qty (kg/m), not money. The fast path
  // subtracts two cumulative sums; the slow path sums the window directly — same
  // true value, but non-associative float can differ in the last bits. Magnitude
  // must match (the accounting layer rounds it before surfacing in the warning).
  assert.ok(Math.abs(fast.negativeUnits - slow.negativeUnits) < 1e-6,
    `negativeUnits drift [${startYm}..${endYm}]: fast=${fast.negativeUnits} slow=${slow.negativeUnits}`);
}

test("checkpoints — single month equals computeMaterialPeriod", () => {
  const m = {
    rmId: "rmA", itemGroup: "FABRIC", opening: { qty: 10, unitCostSen: 100 }, openingDate: "2026-01-01",
    events: [
      { kind: "receipt", date: "2026-06-05", qty: 5, unitCostSen: 200 },
      { kind: "issue", date: "2026-06-10", qty: 12 },
    ],
  };
  assertCheckpointMatch(m, monthSeq("2025-12", "2026-12"), "2026-06", "2026-06");
});

test("checkpoints — multi-month windows (spanning, single, post-activity flat)", () => {
  const m = {
    rmId: "rmB", itemGroup: "FOAM", opening: { qty: 4, unitCostSen: 120 }, openingDate: "2026-01-01",
    events: [
      { kind: "receipt", date: "2026-02-10", qty: 6, unitCostSen: 150 },
      { kind: "issue", date: "2026-03-03", qty: 7, ref: "PO1" },
      { kind: "receipt", date: "2026-05-20", qty: 9, unitCostSen: 175 },
      { kind: "issue", date: "2026-07-01", qty: 5, ref: "PO2" },
    ],
  };
  const months = monthSeq("2025-12", "2026-12");
  assertCheckpointMatch(m, months, "2026-01", "2026-12"); // whole range
  assertCheckpointMatch(m, months, "2026-03", "2026-05"); // mid window
  assertCheckpointMatch(m, months, "2026-02", "2026-02"); // single active month
  assertCheckpointMatch(m, months, "2026-08", "2026-10"); // after all events → flat
});

test("checkpoints — group-level sum equals rollup of per-item windows (additivity)", () => {
  const items = [
    { rmId: "r1", itemGroup: "FABRIC", opening: { qty: 3, unitCostSen: 100 }, openingDate: "2026-01-01",
      events: [{ kind: "receipt", date: "2026-04-02", qty: 5, unitCostSen: 120 }, { kind: "issue", date: "2026-06-05", qty: 6, ref: "P" }] },
    { rmId: "r2", itemGroup: "FABRIC", opening: null, openingDate: "2026-01-01",
      events: [{ kind: "receipt", date: "2026-05-01", qty: 8, unitCostSen: 90 }, { kind: "issue", date: "2026-06-09", qty: 3 }] },
    { rmId: "r3", itemGroup: "FOAM", opening: { qty: 2, unitCostSen: 300 }, openingDate: "2026-01-01",
      events: [{ kind: "issue", date: "2026-06-20", qty: 5, ref: "Q" }] }, // goes negative
  ];
  const months = monthSeq("2025-12", "2026-12");
  const startYm = "2026-06", endYm = "2026-06", prevYm = prevMonthYm(startYm);
  const zero = () => ({ closingSen: 0, cumPurchaseSen: 0, cumConsumedSen: 0, cumNegativeUnits: 0 });
  const groupCum = new Map();
  for (const it of items) {
    const byYm = checkpointLookup(it, months);
    const end = byYm.get(endYm), prev = byYm.get(prevYm);
    let g = groupCum.get(it.itemGroup);
    if (!g) { g = { end: zero(), prev: zero() }; groupCum.set(it.itemGroup, g); }
    for (const k of ["closingSen", "cumPurchaseSen", "cumConsumedSen", "cumNegativeUnits"]) { g.end[k] += end[k]; g.prev[k] += prev[k]; }
  }
  const fastByGroup = new Map();
  for (const [grp, g] of groupCum) fastByGroup.set(grp, windowFromCheckpoints(g.end, g.prev));
  const slowRolled = rollupByGroup(items.map((it) => computeMaterialPeriod(it, `${startYm}-01`, monthEndIso(endYm))));
  for (const sg of slowRolled.groups) {
    const fg = fastByGroup.get(sg.itemGroup);
    assert.ok(fg, `missing fast group ${sg.itemGroup}`);
    assert.equal(fg.openingSen, sg.openingSen, `group ${sg.itemGroup} opening`);
    assert.equal(fg.purchaseSen, sg.purchaseSen, `group ${sg.itemGroup} purchase`);
    assert.equal(fg.closingSen, sg.closingSen, `group ${sg.itemGroup} closing`);
    assert.equal(fg.consumedSen, sg.consumedSen, `group ${sg.itemGroup} consumed`);
  }
});

test("checkpoints — randomized fuzz over multi-month materials + windows", () => {
  let seed = 0x2026_06_22 >>> 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 0x1_0000_0000; };
  const months = monthSeq("2026-01", "2026-12");
  const coverMonths = monthSeq("2025-12", "2027-01");
  const dayInMonth = (ym) => {
    const [y, m] = ym.split("-").map(Number);
    const last = Number(new Date(Date.UTC(y, m, 0)).toISOString().slice(8, 10));
    return `${ym}-${String(1 + Math.floor(rnd() * last)).padStart(2, "0")}`;
  };
  for (let trial = 0; trial < 200; trial++) {
    const events = [];
    const nEvents = 1 + Math.floor(rnd() * 10);
    for (let i = 0; i < nEvents; i++) {
      const ym = months[Math.floor(rnd() * months.length)];
      const d = dayInMonth(ym);
      if (rnd() < 0.5) {
        events.push({ kind: "receipt", date: d, qty: Math.round(rnd() * 800) / 100, unitCostSen: 1 + Math.floor(rnd() * 500) });
      } else {
        events.push({ kind: "issue", date: d, qty: Math.round(rnd() * 600) / 100, ref: `P${i}` });
      }
    }
    const opening = rnd() < 0.7 ? { qty: Math.round(rnd() * 500) / 100, unitCostSen: 1 + Math.floor(rnd() * 400) } : null;
    const m = { rmId: `rm${trial}`, itemGroup: "G", opening, openingDate: "2026-01-01", events };
    for (let w = 0; w < 5; w++) {
      let a = Math.floor(rnd() * months.length);
      let b = Math.floor(rnd() * months.length);
      if (a > b) [a, b] = [b, a];
      assertCheckpointMatch(m, coverMonths, months[a], months[b]);
    }
  }
});

// --- stockTakeChainValue (periodic-inventory mode, owner rule 2026-07-03) ---
import { stockTakeChainValue } from "../src/lib/material-cost-fifo.ts";

const piCumFrom = (perYm) => {
  // build cumulative lookup over a fixed month axis
  const months = ["2026-05", "2026-06", "2026-07", "2026-08"];
  const cum = new Map();
  let run = 0;
  for (const m of months) { run += perYm[m] ?? 0; cum.set(m, run); }
  return (ym) => (ym < "2026-05" ? 0 : (cum.get(ym) ?? run));
};

test("stockTakeChainValue — no counts: seed + all purchases to date", () => {
  const piOf = piCumFrom({ "2026-05": 1000, "2026-06": 2000 });
  const noSt = () => null;
  assert.equal(stockTakeChainValue(5000, piOf, noSt, "2026-05", "2026-05"), 6000);
  assert.equal(stockTakeChainValue(5000, piOf, noSt, "2026-06", "2026-05"), 8000);
  // month before the first axis month → just the seed
  assert.equal(stockTakeChainValue(5000, piOf, noSt, "2026-04", "2026-05"), 5000);
});

test("stockTakeChainValue — count resets the chain; later months add purchases since", () => {
  const piOf = piCumFrom({ "2026-05": 1000, "2026-06": 2000, "2026-07": 400 });
  const st = (ym) => (ym === "2026-06" ? 7500 : null);
  // at the counted month: exactly the count
  assert.equal(stockTakeChainValue(5000, piOf, st, "2026-06", "2026-05"), 7500);
  // after it: count + July purchases only
  assert.equal(stockTakeChainValue(5000, piOf, st, "2026-07", "2026-05"), 7900);
  // before it: chain ignores the future count
  assert.equal(stockTakeChainValue(5000, piOf, st, "2026-05", "2026-05"), 6000);
});

test("stockTakeChainValue — latest count wins when several exist", () => {
  const piOf = piCumFrom({ "2026-05": 1000, "2026-06": 2000, "2026-07": 400, "2026-08": 300 });
  const st = (ym) => (ym === "2026-05" ? 9000 : ym === "2026-07" ? 100 : null);
  assert.equal(stockTakeChainValue(5000, piOf, st, "2026-06", "2026-05"), 11000); // 9000 + Jun 2000
  assert.equal(stockTakeChainValue(5000, piOf, st, "2026-08", "2026-05"), 400); // 100 + Aug 300
});

test("stockTakeChainValue — consumed is zero between counts (window identity)", () => {
  // opening(prev chain) + purchases(window) − closing(end chain) === 0 when no
  // count falls inside the window.
  const piOf = piCumFrom({ "2026-05": 1000, "2026-06": 2000, "2026-07": 400 });
  const noSt = () => null;
  const opening = stockTakeChainValue(5000, piOf, noSt, "2026-05", "2026-05");
  const closing = stockTakeChainValue(5000, piOf, noSt, "2026-07", "2026-05");
  const purchases = piOf("2026-07") - piOf("2026-05");
  assert.equal(opening + purchases - closing, 0);
});

test("stockTakeChainValue — a zero count is a real count (0 ≠ missing)", () => {
  const piOf = piCumFrom({ "2026-06": 2000 });
  const st = (ym) => (ym === "2026-05" ? 0 : null);
  assert.equal(stockTakeChainValue(5000, piOf, st, "2026-06", "2026-05"), 2000);
});
