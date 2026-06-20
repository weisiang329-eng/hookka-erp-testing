import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketAging } from "../src/lib/other-party-aging.ts";

const TODAY = "2026-06-30";

test("buckets a bill by age", () => {
  const rows = bucketAging(
    [
      { partyId: "p1", partyName: "A", billNo: "B1", billDate: "2026-06-20", outstandingSen: 100 }, // 10 days → current
      { partyId: "p1", partyName: "A", billNo: "B2", billDate: "2026-05-10", outstandingSen: 200 }, // 51 days → 31-60
      { partyId: "p1", partyName: "A", billNo: "B3", billDate: "2026-01-01", outstandingSen: 300 }, // 180 days → 120+
    ],
    TODAY,
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { current: rows[0].current, d31_60: rows[0].d31_60, d120plus: rows[0].d120plus, total: rows[0].totalSen },
    { current: 100, d31_60: 200, d120plus: 300, total: 600 },
  );
});

test("aggregates per party and sorts by total desc", () => {
  const rows = bucketAging(
    [
      { partyId: "p1", partyName: "A", billNo: "B1", billDate: "2026-06-20", outstandingSen: 100 },
      { partyId: "p2", partyName: "B", billNo: "B2", billDate: "2026-06-20", outstandingSen: 500 },
    ],
    TODAY,
  );
  assert.deepEqual(rows.map((r) => r.partyId), ["p2", "p1"]); // p2 (500) before p1 (100)
});

test("skips zero/negative outstanding", () => {
  const rows = bucketAging(
    [{ partyId: "p1", partyName: "A", billNo: "B1", billDate: "2026-06-20", outstandingSen: 0 }],
    TODAY,
  );
  assert.equal(rows.length, 0);
});
