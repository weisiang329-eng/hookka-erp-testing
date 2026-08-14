// ---------------------------------------------------------------------------
// no-fabricated-attendance-production-time.test.mjs — a punch may publish only
// what a punch observes.
//
// BUG-2026-08-13-103, bug class C15 (a figure that reads as measured, and is
// not). Both clock-out paths used to write:
//
//     productionTimeMinutes = Math.max(0, Math.round(total * 0.85));
//     efficiencyPct = Math.round((productionTimeMinutes / standardMinutes) * 100);
//     deptBreakdown = JSON.stringify([{ deptCode, minutes: productionTimeMinutes,
//                                       productCode: "" }]);
//
// `attendance_records.production_time_minutes` has therefore NEVER been
// measured — it is `working_minutes × 0.85`. Prod, August 2026:
// 180,928 / 212,850 = 0.85005, the constant showing through. Everything
// downstream inherited it: `efficiencyPct` measured attendance LENGTH wearing
// the word "efficiency", and `deptBreakdown` republished the same number as a
// per-department split under an empty product code.
//
// There were THREE writers, not one — fixing only the office punch would have
// left the phone punch and the forgotten-punch auto-close still fabricating:
//   1. src/api/routes/attendance.ts        POST /api/attendance CLOCK_OUT
//   2. src/api/routes/worker.ts            POST /api/worker/clock CLOCK_OUT
//   3. src/api/routes/worker.ts            autoCloseForgottenPunch (midnight
//      cron + next-day self-heal) — stdMin × 0.85 ÷ stdMin, a flat 85% that
//      could not vary, because both sides came from the same number.
//
// STRUCTURAL test (readFileSync source assertions, the repo idiom): re-adding
// the ratio is a one-token edit and no runtime assertion can catch a number
// that is merely wrong-but-plausible.
//
// EOL NOTE: these files are CRLF on this machine. Every read is normalised to
// \n first — a literal "\n" anchor against CRLF bytes matches NOTHING and has
// produced a false all-clear four times this week.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
/** Read a repo file with CRLF normalised to LF, so \n anchors actually match. */
const read = (rel) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

// The ratio itself, in every spelling that would restore the bug. `0.85` is the
// load-bearing token: it is what makes a clocked minute look like a produced
// one.
const FABRICATION_TOKENS = [
  "* 0.85",
  "*0.85",
  "0.85 *",
  "0.85*",
];

test("the office punch (POST /api/attendance) never invents production time", () => {
  const src = read("src/api/routes/attendance.ts");

  for (const bad of FABRICATION_TOKENS) {
    assert.ok(
      !src.includes(bad),
      `attendance.ts: "${bad}" is the fabrication — production time is a fixed ` +
        "ratio of the clock time, not a measurement.",
    );
  }

  // The derived pair must not be recomputed from anything, under any name.
  assert.ok(
    !/productionTimeMinutes\s*=\s*Math\./.test(src),
    "attendance.ts: productionTimeMinutes must not be computed at clock-out",
  );
  assert.ok(
    !/efficiencyPct\s*=\s*Math\./.test(src),
    "attendance.ts: efficiencyPct must not be computed at clock-out",
  );

  // The clock-out UPDATE clears the columns rather than binding a value to
  // them. `= NULL` is a literal in the SQL; a `= ?` here would mean a number
  // is being written again.
  const clockOut = src.slice(src.indexOf('body.action === "CLOCK_OUT"'));
  assert.ok(clockOut.length > 200, "attendance.ts: CLOCK_OUT branch must exist");
  assert.ok(
    clockOut.includes("productionTimeMinutes = NULL") &&
      clockOut.includes("efficiencyPct = NULL"),
    "attendance.ts: CLOCK_OUT must CLEAR the unmeasured columns (= NULL), so a " +
      "re-punch also scrubs what a pre-fix clock-out wrote",
  );
  assert.ok(
    !/SET[\s\S]{0,400}productionTimeMinutes\s*=\s*\?/.test(clockOut),
    "attendance.ts: CLOCK_OUT must not bind a value into productionTimeMinutes",
  );

  // deptBreakdown is no longer built from the fabricated number.
  assert.ok(
    !/minutes:\s*productionTimeMinutes/.test(src),
    "attendance.ts: the per-department split must not republish the fabricated " +
      "production minutes",
  );

  // The clock-in INSERT seeds neither column — 0 is a claim, not a blank
  // (C15's first corollary).
  const insertMatch = src.match(
    /INSERT INTO attendance_records \(([\s\S]*?)\)[\s\S]*?VALUES/,
  );
  assert.ok(insertMatch, "attendance.ts: the clock-in INSERT must exist");
  assert.ok(
    !insertMatch[1].includes("productionTimeMinutes") &&
      !insertMatch[1].includes("efficiencyPct"),
    "attendance.ts: the clock-in INSERT must OMIT the unmeasured columns rather " +
      "than seeding them with 0",
  );
});

test("GET /api/attendance publishes the unmeasured fields as null, never a number", () => {
  const src = read("src/api/routes/attendance.ts");
  const fn = src.slice(
    src.indexOf("function rowToAttendance"),
    src.indexOf("function genId"),
  );
  assert.ok(fn.length > 200, "attendance.ts: rowToAttendance must exist");

  // Unconditionally null — NOT `r.productionTimeMinutes`. Every stored value is
  // fabricated, so a passthrough would republish the fabrication for the ~2,780
  // historic rows.
  assert.match(
    fn,
    /productionTimeMinutes:\s*null/,
    "rowToAttendance: productionTimeMinutes must be published as null",
  );
  assert.match(
    fn,
    /efficiencyPct:\s*null/,
    "rowToAttendance: efficiencyPct must be published as null",
  );
  assert.ok(
    !/productionTimeMinutes:\s*r\./.test(fn) &&
      !/efficiencyPct:\s*r\./.test(fn),
    "rowToAttendance: neither field may be read back off the row",
  );
  assert.ok(
    !/deptBreakdown:\s*parseDeptBreakdown\(r\./.test(fn),
    "rowToAttendance: the stored dept split is the same fabricated number and " +
      "must not be published",
  );
  // ...and never as 0, which would be a claim rather than a blank.
  assert.ok(
    !/productionTimeMinutes:\s*0\b/.test(fn) && !/efficiencyPct:\s*0\b/.test(fn),
    "rowToAttendance: 0 is a claim ('no production time'), not 'unknown'",
  );
});

test("the phone punch and the forgotten-punch auto-close fabricate nothing either", () => {
  const src = read("src/api/routes/worker.ts");

  for (const bad of FABRICATION_TOKENS) {
    assert.ok(
      !src.includes(bad),
      `worker.ts: "${bad}" is the same fabrication the office punch carried — ` +
        "it lived here TWICE (POST /clock and autoCloseForgottenPunch).",
    );
  }
  assert.ok(
    !/productionTimeMinutes\s*=\s*Math\./.test(src),
    "worker.ts: productionTimeMinutes must not be computed",
  );
  assert.ok(
    !/(efficiencyPct|effPct)\s*=\s*(Math\.|stdMin|standardMinutes)/.test(src),
    "worker.ts: efficiency must not be derived from the punch",
  );

  // autoCloseForgottenPunch: the flat-85% pair is gone, but the OWNER'S RULE
  // (a forgotten punch pays as a normal shift) survives — workingMinutes is
  // still the contracted shift and the row still says so in `notes`. Deleting
  // that would be the over-correction.
  const auto = src.slice(
    src.indexOf("async function autoCloseForgottenPunch"),
    src.indexOf("// Midnight cron entry"),
  );
  assert.ok(auto.length > 200, "worker.ts: autoCloseForgottenPunch must exist");
  assert.ok(
    !auto.includes("prodMin"),
    "autoCloseForgottenPunch: the fabricated production-minutes variable must be gone",
  );
  assert.ok(
    auto.includes("Forgot to punch out"),
    "autoCloseForgottenPunch: the owner's forgotten-punch rule + its note must stay",
  );
  assert.match(
    auto,
    /const stdMin = \(workingHoursPerDay \|\| 9\) \* 60/,
    "autoCloseForgottenPunch: the contracted-shift figure must stay — a " +
      "forgotten punch pays as a normal shift (owner 2026-06-16)",
  );

  // /api/worker/history must not hand the phone the fabricated per-day pair.
  assert.match(
    src,
    /productionTimeMinutes:\s*null,\s*\n?\s*efficiencyPct:\s*null/,
    "worker.ts: /history must publish the per-day attendance metrics as null",
  );

  // Both write paths clear through the ONE shared helper, so a future fix to
  // either surface cannot drift from the other.
  assert.ok(
    src.includes('import { metricsNullable } from "./attendance"'),
    "worker.ts: both punch surfaces must clear the columns through the shared " +
      "metricsNullable definition in attendance.ts",
  );
  assert.equal(
    (src.match(/productionTimeMinutes = NULL, efficiencyPct = NULL,/g) ?? []).length,
    2,
    "worker.ts: BOTH clock-out paths (the punch and the auto-close) must clear " +
      "the unmeasured columns",
  );
});

test("the auto-created attendance row seeds no metrics", () => {
  const src = read("src/api/routes/working-hour-entries.ts");
  const insert = src.slice(src.indexOf("INSERT INTO attendance_records"));
  const cols = insert.slice(0, insert.indexOf("VALUES"));
  assert.ok(cols.length > 50, "working-hour-entries.ts: the INSERT must exist");
  assert.ok(
    !cols.includes("productionTimeMinutes") && !cols.includes("efficiencyPct"),
    "working-hour-entries.ts: the auto-created row must OMIT the unmeasured " +
      "columns — it exists only to hang working-hour entries off",
  );
});

// ---------------------------------------------------------------------------
// Do NOT over-correct: the job-card-derived metric is real and must survive —
// but it must stop reading as measured production time.
// ---------------------------------------------------------------------------
test("the surviving efficiency metric keeps its clocked denominator", () => {
  const src = read("src/api/routes/department-performance.ts");
  assert.ok(
    src.includes("FROM working_hour_entries"),
    "department-performance.ts must keep reading working_hour_entries — clocked " +
      "time is what makes this denominator real",
  );
  // BOTH per-worker sites, not one. The formula lives twice — once in
  // `projectPerformanceSummary` (the ?view=summary projection Reports reads)
  // and once in the daily-row build (what the Employees tab drills into) — and
  // a single-site `assert.match` passed happily while the OTHER site had its
  // denominator swapped for a literal. Caught by mutating this file and finding
  // the guard still green; count them instead.
  assert.equal(
    (
      src.match(
        /w\.workingMinutes > 0\s*\n?\s*\?\s*Math\.round\(\(w\.productionMinutes \/ w\.workingMinutes\) \* 100\)/g,
      ) ?? []
    ).length,
    2,
    "department-performance.ts: BOTH per-worker efficiency sites (the summary " +
      "projection and the daily-row build) must stay productionMinutes ÷ " +
      "workingMinutes — a literal denominator in either one is a fabrication",
  );
  // ...and the department/day rollup, whose denominator is the same clocked sum.
  assert.match(
    src,
    /cell\.workingMinutes > 0\s*\n?\s*\?\s*Math\.round\(\(cell\.productionMinutes \/ cell\.workingMinutes\) \* 100\)/,
    "department-performance.ts: the per-day rollup must divide by clocked time too",
  );
});

test("department-performance publishes how many cards actually recorded a duration", () => {
  const src = read("src/api/routes/department-performance.ts");

  // Provenance test, not a NULL check: 4,289 populated actualMinutes values on
  // prod are byte-identical copies of that card's own estMinutes, so non-null
  // is not evidence of a measurement.
  assert.match(
    src,
    /actual !== null && actual > 0 && actual !== \(jc\.estMinutes \?\? 0\)/,
    "department-performance.ts: a card counts as measured only when its " +
      "recorded duration DIFFERS from its own standard",
  );
  assert.match(
    src,
    /cards:\s*cardsInRange,\s*\n?\s*measuredCards:\s*cardsWithMeasuredActual,/,
    "department-performance.ts: totals must carry the coverage pair so the " +
      "caption can state the numerator's provenance",
  );
});

test("both screens caption the metric as standard-vs-clocked and show coverage", () => {
  for (const rel of ["src/pages/employees.tsx", "src/pages/reports.tsx"]) {
    const src = read(rel);
    // Prose assertions run against a whitespace-collapsed copy: JSX wraps its
    // text across source lines, so an exact-substring match on a sentence is a
    // guard that silently stops matching the first time anyone reformats.
    const prose = src.replace(/\s+/g, " ");
    assert.ok(
      prose.includes("standard minutes earned ÷ clocked minutes"),
      `${rel}: the efficiency figure must be labelled standard-vs-clocked, not ` +
        "as measured production time",
    );
    assert.ok(
      prose.includes("carry a measured duration"),
      `${rel}: the actual-capture coverage must be printed beside the figure — ` +
        "C15's third corollary, publish the provenance next to the number",
    );
    assert.ok(
      /measuredCards \?\? 0\) === 0/.test(src),
      `${rel}: zero measured cards must read differently from partial coverage ` +
        "(every minute is standard time in that case)",
    );
  }
});
