import { test } from "node:test";
import assert from "node:assert/strict";
import { computeMaterialPeriod, rollupByGroup } from "../src/lib/material-cost-fifo.ts";

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
