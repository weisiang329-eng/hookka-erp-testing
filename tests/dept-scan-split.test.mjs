// ---------------------------------------------------------------------------
// dept-scan-split.test.mjs — department-QR day splitting (owner 2026-06-11).
//   • No scans → the whole punch window = the worker's HOME department.
//   • Time before the first scan = home; each scan re-routes until the next.
//   • Re-scanning the same department is not a boundary; out-of-window scans
//     clamp; returning to a department SUMS its minutes.
//   • prorateHours: 2-dp rows that ALWAYS sum back to the total exactly
//     (largest-remainder), zero/negative weights dropped.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping on Node 22+ */
}

const lib = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/dept-scan-split.ts")).href
);

const IN = 8 * 60; // 08:00
const OUT = 18 * 60; // 18:00

test("no scans → one bucket: the home department, full window, category null", () => {
  const b = lib.buildDeptBuckets(IN, OUT, "FAB_SEW", []);
  assert.deepEqual(b, [{ departmentCode: "FAB_SEW", category: null, minutes: 600 }]);
});

test("no scans AND no home dept → nothing attributable", () => {
  assert.deepEqual(lib.buildDeptBuckets(IN, OUT, "", []), []);
});

test("one scan: before = home, after = scanned dept", () => {
  const b = lib.buildDeptBuckets(IN, OUT, "FAB_SEW", [
    { departmentCode: "PACKING", category: "SOFA", atMin: 14 * 60 }, // 14:00
  ]);
  assert.deepEqual(b, [
    { departmentCode: "FAB_SEW", category: null, minutes: 360 },
    { departmentCode: "PACKING", category: "SOFA", minutes: 240 },
  ]);
});

test("LINE switch inside ONE department is a boundary (owner v2: Sofa vs Bedframe per person)", () => {
  // 08:00 scans Fab Sew·Sofa at punch-in → 13:00 scans Fab Sew·Bedframe.
  const b = lib.buildDeptBuckets(IN, OUT, "FAB_SEW", [
    { departmentCode: "FAB_SEW", category: "SOFA", atMin: IN },
    { departmentCode: "FAB_SEW", category: "BEDFRAME", atMin: 13 * 60 },
  ]);
  assert.deepEqual(b, [
    { departmentCode: "FAB_SEW", category: "SOFA", minutes: 300 },
    { departmentCode: "FAB_SEW", category: "BEDFRAME", minutes: 300 },
  ]);
});

test("multiple scans + return: minutes SUM per (dept × category)", () => {
  // 08:00 Sofa line (scanned) → 10:00 WAREHOUSING → 12:00 back to Sofa line.
  const b = lib.buildDeptBuckets(IN, OUT, "FAB_SEW", [
    { departmentCode: "FAB_SEW", category: "SOFA", atMin: IN },
    { departmentCode: "WAREHOUSING", atMin: 10 * 60 },
    { departmentCode: "FAB_SEW", category: "SOFA", atMin: 12 * 60 },
  ]);
  assert.deepEqual(b, [
    { departmentCode: "FAB_SEW", category: "SOFA", minutes: 120 + 360 },
    { departmentCode: "WAREHOUSING", category: null, minutes: 120 },
  ]);
});

test("re-scanning the CURRENT dept+line is not a boundary", () => {
  const b = lib.buildDeptBuckets(IN, OUT, "FAB_SEW", [
    { departmentCode: "FAB_SEW", category: "SOFA", atMin: IN },
    { departmentCode: "FAB_SEW", category: "SOFA", atMin: 9 * 60 }, // same station again
    { departmentCode: "REPAIR", atMin: 15 * 60 },
  ]);
  assert.deepEqual(b, [
    { departmentCode: "FAB_SEW", category: "SOFA", minutes: 420 },
    { departmentCode: "REPAIR", category: null, minutes: 180 },
  ]);
});

test("scans outside the punch window clamp to it", () => {
  // A scan at 07:30 (before punch-in) starts at 08:00; one at 19:00 clamps to
  // 18:00 → zero-length → dropped.
  const b = lib.buildDeptBuckets(IN, OUT, "FAB_SEW", [
    { departmentCode: "WOOD_CUT", category: "BEDFRAME", atMin: 7 * 60 + 30 },
    { departmentCode: "FOAM", atMin: 19 * 60 },
  ]);
  assert.deepEqual(b, [
    { departmentCode: "WOOD_CUT", category: "BEDFRAME", minutes: 600 },
  ]);
});

test("scan at punch-in with no home dept still attributes the whole day", () => {
  const b = lib.buildDeptBuckets(IN, OUT, "", [
    { departmentCode: "REPAIR", atMin: IN },
  ]);
  assert.deepEqual(b, [{ departmentCode: "REPAIR", category: null, minutes: 600 }]);
});

test("empty / inverted punch window → no buckets", () => {
  assert.deepEqual(lib.buildDeptBuckets(OUT, IN, "FAB_SEW", []), []);
  assert.deepEqual(lib.buildDeptBuckets(IN, IN, "FAB_SEW", []), []);
});

// ── prorateHours ────────────────────────────────────────────────────────────

test("prorateHours: rows sum back to the total EXACTLY (largest remainder)", () => {
  // 9h across 3 equal buckets → 3.00 each.
  const even = lib.prorateHours(9, [
    { k: "a", weight: 1 },
    { k: "b", weight: 1 },
    { k: "c", weight: 1 },
  ]);
  assert.deepEqual(even.map((r) => r.hours), [3, 3, 3]);
  // 10h across thirds → 3.33/3.33/3.34-style with exact tie-out.
  const thirds = lib.prorateHours(10, [
    { k: "a", weight: 1 },
    { k: "b", weight: 1 },
    { k: "c", weight: 1 },
  ]);
  const sum = thirds.reduce((s, r) => s + Math.round(r.hours * 100), 0);
  assert.equal(sum, 1000);
});

test("prorateHours: weights drive the split; zero/negative weights dropped", () => {
  const r = lib.prorateHours(9, [
    { k: "home", weight: 360 },
    { k: "borrowed", weight: 240 },
    { k: "junk", weight: 0 },
  ]);
  assert.deepEqual(
    r.map((x) => ({ k: x.k, hours: x.hours })),
    [
      { k: "home", hours: 5.4 },
      { k: "borrowed", hours: 3.6 },
    ],
  );
});

test("prorateHours: zero total or no usable weights → []", () => {
  assert.deepEqual(lib.prorateHours(0, [{ k: "a", weight: 1 }]), []);
  assert.deepEqual(lib.prorateHours(9, []), []);
  assert.deepEqual(lib.prorateHours(9, [{ k: "a", weight: 0 }]), []);
});

test("prorateHours: tiny totals never create phantom hours", () => {
  // 0.02h across 3 buckets → exactly 0.02 total, no row inflated.
  const r = lib.prorateHours(0.02, [
    { k: "a", weight: 1 },
    { k: "b", weight: 1 },
    { k: "c", weight: 1 },
  ]);
  const sum = r.reduce((s, x) => s + Math.round(x.hours * 100), 0);
  assert.equal(sum, 2);
});

test("prorateHours folds sub-0.1h fragments into the largest bucket (owner 2026-07-04)", () => {
  // 9h split where one scan boundary leaves a 1-minute sliver: the sliver's
  // cents move into the biggest row instead of surfacing as a 0.01h entry.
  const rows = lib.prorateHours(9, [
    { departmentCode: "FAB_SEW", weight: 539 },
    { departmentCode: "R_AND_D", weight: 1 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].departmentCode, "FAB_SEW");
  assert.equal(rows[0].hours, 9);
  // Fragments >= 0.1h survive untouched, and totals still sum back exactly.
  const ok = lib.prorateHours(9, [
    { departmentCode: "A", weight: 480 },
    { departmentCode: "B", weight: 60 },
  ]);
  assert.equal(ok.length, 2);
  assert.equal(ok.reduce((s, r) => s + r.hours, 0), 9);
});
