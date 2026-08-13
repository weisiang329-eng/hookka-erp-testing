// ---------------------------------------------------------------------------
// no-fabricated-efficiency.test.mjs — an efficiency ratio may only be built
// from cards that actually recorded a duration, and BOTH sides of the ratio
// must cover the same cards.
//
// The data (prod, 2026-08-13): 4,340 of 36,796 job cards carry a non-null
// `job_cards.actualMinutes`, 4,289 of them non-zero. Real work time IS being
// recorded, on a minority of cards. `productionTimeMinutes` is NOT a second
// source — it equals `estMinutes` on every row, i.e. the standard time under
// another name.
//
// The bug that motivated this test: Reports › Production › Department
// Efficiency summed `actualMinutes || estMinutes` into one total and plain
// `estMinutes` into the other, then divided. Every card WITHOUT a recording
// contributed its own estimate to both sides — the estimate divided by itself
// — which dragged each department to ~100% and buried the cards that had a
// real number. The Export CSV button shipped that as a KPI. The same
// expression lived in src/pages/production/tracker.tsx, which was unreachable
// dead code and has been deleted.
//
// This is a STRUCTURAL test (readFileSync source assertions, the repo idiom):
// re-adding the fallback is a one-token edit, and no runtime assertion catches
// a number that is merely wrong-but-plausible.
//
// It ALSO pins the fully-measured metric in place. /api/department-performance
// (and the employee / department / payslip surfaces built on it) divides
// production minutes by CLOCKED time from `working_hour_entries` — prod shows
// it varying (80% overall, 64% on one day, 48% for one worker). Deleting that
// while cleaning up a fabricated figure would be the obvious over-correction.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

test("Reports > Department Efficiency never falls back actual → estimate", () => {
  const src = read("src/pages/reports.tsx");

  // The exact shape of the bug, and the nullish variant of it. Either one
  // lets an unrecorded card contribute its estimate to both sides.
  for (const bad of [
    "actualMinutes || jc.estMinutes",
    "actualMinutes ?? jc.estMinutes",
    "actualMinutes || estMinutes",
    "actualMinutes ?? estMinutes",
  ]) {
    assert.ok(
      !src.includes(bad),
      `reports.tsx: "${bad}" hands an unmeasured card its own estimate on ` +
        `both sides of the ratio, pinning the department at ~100%.`,
    );
  }

  // The ratio itself reads off the paired subtotals, and degrades to a dash
  // rather than to a fabricated number.
  assert.match(
    src,
    /d\.measuredActualMin > 0\s*\?\s*\(\(d\.measuredStdMin \/ d\.measuredActualMin\) \* 100\)/,
    "reports.tsx: efficiency must be measuredStdMin ÷ measuredActualMin, " +
      "guarded on there being a measurement at all",
  );
  assert.match(
    src,
    /d\.measuredActualMin > 0[\s\S]{0,200}:\s*"—"/,
    'reports.tsx: with no measured minutes the cell must read "—"',
  );

  // The reader is told how thin the sample is — a percentage off 12 of 400
  // cards must not look like a departmental KPI.
  assert.ok(
    src.includes("d.measuredCards > 0 ? `${d.measuredCards} / ${d.orders}`"),
    "reports.tsx: the Measured Cards column must show the recorded count " +
      "against the completed count",
  );
  assert.equal(
    (src.match(/"Measured Cards"/g) ?? []).length,
    2,
    "reports.tsx: the on-screen header and the CSV header must both carry " +
      "Measured Cards",
  );

  // The neighbouring column is no longer headed as if it were a measured
  // duration, in the table AND in the CSV the operator downloads.
  assert.ok(
    !src.includes('"Avg Time (mins)"'),
    'reports.tsx: "Avg Time (mins)" reads as time taken; it is the standard ' +
      "time, so it must be labelled as such",
  );
  assert.equal(
    (src.match(/"Avg Std Time \(mins\)"/g) ?? []).length,
    2,
    "reports.tsx: the on-screen header and the CSV header must both say " +
      "Avg Std Time (mins)",
  );
});

// The paired accumulation this file was written to protect MOVED into SQL with
// BUG-2026-08-13-005 — the page can no longer add job cards up in the browser
// because it no longer downloads any (that fetch was killed by the 30 s abort).
// The invariant is unchanged, so the guard follows it to its new home rather
// than being deleted; a source pin that no longer covers the arithmetic it
// names is worse than no pin at all.
test("the report-summary SQL pairs the ratio inside one `actual > 0` guard", () => {
  const src = read("src/api/routes/production-orders.ts");
  const start = src.indexOf('app.get("/report-summary"');
  assert.ok(start > 0, "GET /report-summary must exist on the PO router");
  const body = src.slice(start, start + 8000);

  // Every one of the three measured subtotals is gated on the SAME condition:
  // this card recorded a duration. Numerator and denominator therefore cover
  // exactly the same cards, which is the whole property.
  const guard = /COALESCE\(jc\.actualMinutes, 0\) > 0/g;
  assert.ok(
    (body.match(guard) ?? []).length >= 4,
    "report-summary: measuredCards, measuredStdMinutes, measuredActualMinutes " +
      "and measuredDistinctCards must each be guarded on the card having " +
      "recorded a duration",
  );
  assert.match(
    body,
    /AND COALESCE\(jc\.actualMinutes, 0\) > 0\s*\n?\s*THEN COALESCE\(jc\.estMinutes, 0\) ELSE 0 END\)\s*\n?\s*AS measured_std_minutes/,
    "report-summary: the numerator (standard minutes) must only count cards " +
      "that recorded a duration",
  );
  // No fallback may reintroduce the estimate as a stand-in for a measurement.
  for (const bad of [
    "COALESCE(jc.actualMinutes, jc.estMinutes)",
    "COALESCE(jc.actualMinutes, COALESCE(jc.estMinutes, 0))",
  ]) {
    assert.ok(
      !body.includes(bad),
      `report-summary: "${bad}" is the SQL spelling of the bug — an ` +
        "unmeasured card would divide its own estimate by itself.",
    );
  }

  // The provenance counter that stops a copied estimate being published as a
  // measurement (all 4,289 populated values on prod equal their own estimate).
  assert.match(
    body,
    /<> COALESCE\(jc\.estMinutes, 0\)[\s\S]{0,80}AS measured_distinct_cards/,
    "report-summary: measuredDistinctCards must count only the cards whose " +
      "recorded minutes actually differ from the standard minutes",
  );
  assert.match(
    read("src/pages/reports.tsx"),
    /d\.measuredDistinctCards > 0 \? ratio : "—"/,
    "reports.tsx: a percentage may only be published once at least one card's " +
      "recording differs from its estimate",
  );
});

test("the Master Tracker page that carried the same fallback is gone", () => {
  assert.ok(
    !existsSync(join(root, "src/pages/production/tracker.tsx")),
    "src/pages/production/tracker.tsx computed `(jc.actualMinutes || " +
      "jc.estMinutes)` into an Actual Hours + Efficiency % table. It was " +
      "unreachable (its route is a redirect, nothing imported it) and was " +
      "deleted — do not restore it with that expression intact.",
  );
});

test("the fully-measured efficiency metric still divides by clocked time", () => {
  // Guard against the over-correction: this one is measured end to end, and
  // prod shows it varying. It must not be swept up in a cleanup of a
  // fabricated figure.
  const src = read("src/api/routes/department-performance.ts");
  assert.ok(
    src.includes("FROM working_hour_entries"),
    "department-performance.ts must keep reading working_hour_entries — " +
      "clocked time is what makes its efficiency real",
  );
  assert.match(
    src,
    /w\.workingMinutes > 0\s*\?\s*Math\.round\(\(w\.productionMinutes \/ w\.workingMinutes\) \* 100\)/,
    "department-performance.ts: per-worker efficiency must stay " +
      "productionMinutes ÷ workingMinutes",
  );
});
