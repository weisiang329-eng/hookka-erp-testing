// ---------------------------------------------------------------------------
// no-fabricated-worker-metrics.test.mjs — nothing on Reports › Employee may be
// invented.
//
// BUG-2026-08-13-006. Hours Worked / Items Completed / Efficiency % in the
// "Worker Efficiency" table were computed from `seed(w.id)` — a hash of the
// worker's own id:
//
//     const s = seed(w.id);
//     const hours = 180 + (s % 40);
//     const items = 30 + (s % 25);
//     const eff   = ((items / (hours / 9)) * 10).toFixed(1);
//
// so each person carried the same fabricated performance forever, and it could
// only change if their primary key changed. Beside it sat "Attendance Rate
// 94.5%", "Avg Hours/Day 8.7" and "Average OT Hours / Worker 12.5", all typed
// into the source. The owner had been reading invented per-worker performance.
//
// The replacements are real: /api/department-performance (denominator =
// clocked time from `working_hour_entries`) and /api/attendance. Where no real
// value exists the cell must read "—" and the page must say why — an attendance
// RATE is the standing example: `attendance_records` carries a row only when
// somebody punches, so all 2,780 rows in 2026 are PRESENT and a rate is 100% by
// construction.
//
// Structural, by the repo idiom: a plausible-looking constant cannot be caught
// at runtime — that is exactly what makes it dangerous.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

const REPORTS = "src/pages/reports.tsx";

function employeeTab(src) {
  const start = src.indexOf("function EmployeeReportTab(");
  assert.ok(start > 0, `${REPORTS}: EmployeeReportTab not found`);
  const next = src.indexOf("\nfunction ", start + 1);
  return src.slice(start, next > 0 ? next : src.length);
}

// Comments at the fix site quote the constants they exist to forbid.
const stripComments = (s) =>
  s.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

test("the seed() hash that invented worker performance is gone", () => {
  const src = read(REPORTS);
  assert.ok(
    !/\bfunction seed\b|\bconst seed\s*=/.test(src),
    `${REPORTS}: the seed() id-hash must not exist — every metric it fed is ` +
      "now sourced from clocked time or from punch records.",
  );
  assert.ok(
    !/\bseed\(/.test(stripComments(src)),
    `${REPORTS}: nothing may be derived from a hash of a worker id`,
  );
  // The exact arithmetic, in case it comes back under another name.
  for (const bad of ["180 + (s % 40)", "30 + (s % 25)", "Math.imul(31, h)"]) {
    assert.ok(
      !src.includes(bad),
      `${REPORTS}: "${bad}" is the fabricated-performance formula`,
    );
  }
});

test("no hardcoded attendance or efficiency constant is rendered", () => {
  const body = stripComments(employeeTab(read(REPORTS)));
  // Each of these was a rendered figure with no source behind it.
  const FABRICATED = [
    ["94.5", "the invented attendance rate"],
    ["8.7", "the invented average hours per day"],
    ['"12.5"', "the invented average OT hours per worker"],
    ["presentRate", "the attendance-rate constant"],
    ["avgHoursPerDay =", "the hours-per-day constant"],
    ["workingDays = 22", "the assumed 22-day working month"],
  ];
  for (const [needle, what] of FABRICATED) {
    assert.ok(
      !body.includes(needle),
      `${REPORTS} › EmployeeReportTab: ${what} (${needle}) must be sourced ` +
        'from data or rendered as "—" with a stated reason.',
    );
  }
});

test("every Employee figure comes from a named real source", () => {
  const body = employeeTab(read(REPORTS));

  // Clocked-time efficiency — the one metric in this app whose denominator is
  // time people actually punched.
  assert.ok(
    body.includes("/api/department-performance?view=summary&from="),
    `${REPORTS} › EmployeeReportTab: worker efficiency must come from ` +
      "/api/department-performance, windowed by the tab's own date range",
  );
  // Windowed — a bare /api/attendance call is the slow whole-table read.
  assert.ok(
    /\/api\/attendance\?from=/.test(body),
    `${REPORTS} › EmployeeReportTab: attendance must be fetched with ?from=&to=`,
  );
  assert.ok(
    !/["'`]\/api\/attendance["'`]/.test(stripComments(body)),
    `${REPORTS} › EmployeeReportTab: a bare /api/attendance read scans the ` +
      "whole table; no page makes one",
  );

  // The efficiency column renders the SERVER's figure, and degrades to a dash
  // rather than to 0% when the worker clocked nothing.
  assert.match(
    body,
    /w\.workingMinutes > 0 \? `\$\{w\.efficiencyPct\}%` : "—"/,
    `${REPORTS} › EmployeeReportTab: a worker with no clocked time must read ` +
      '"—", not 0% — the row exists, the measurement does not',
  );
  assert.match(
    body,
    /w\.workingMinutes > 0 \? \(w\.workingMinutes \/ 60\)\.toFixed\(1\) : "—"/,
    `${REPORTS} › EmployeeReportTab: Clocked Hours must be the real clocked ` +
      'denominator, or "—"',
  );

  // The attendance rate is refused, out loud, with its reason.
  assert.ok(
    body.includes('["Average Attendance Rate", "—"]'),
    `${REPORTS} › EmployeeReportTab: an attendance RATE is not computable ` +
      "from a table that only records presences — it must read “—”",
  );
  assert.ok(
    /Attendance Rate reads [“"]—[”"] because/.test(body),
    `${REPORTS} › EmployeeReportTab: a dash must be accompanied by the reason ` +
      "it is a dash",
  );

  // Headers renamed to what the columns now actually hold.
  assert.equal(
    (read(REPORTS).match(/"Job Cards Completed"/g) ?? []).length,
    2,
    `${REPORTS}: the on-screen header and the CSV header must both say Job ` +
      'Cards Completed — "Items Completed" named a hashed number',
  );
  assert.equal(
    (read(REPORTS).match(/"Clocked Hours"/g) ?? []).length,
    2,
    `${REPORTS}: the on-screen header and the CSV header must both say ` +
      "Clocked Hours",
  );
});

test("view=summary projects the trusted engine, it does not recompute it", () => {
  const src = read("src/api/routes/department-performance.ts");
  assert.ok(
    src.includes("export function projectPerformanceSummary("),
    "department-performance.ts: the summary view must be a named projection",
  );
  const start = src.indexOf("export function projectPerformanceSummary(");
  const body = src.slice(start, src.indexOf("\napp.get(", start));

  // It may only ADD UP what the handler produced. Any read of the underlying
  // tables here would be a second copy of the formula — the C4/C10 shape.
  for (const bad of ["working_hour_entries", "job_cards", "prepare(", ".bind("]) {
    assert.ok(
      !body.includes(bad),
      `department-performance.ts: projectPerformanceSummary must not touch ` +
        `"${bad}" — it is a projection of the computed payload, never a ` +
        "second implementation of the efficiency formula.",
    );
  }
  // Same expression as the daily rows, applied to the range sums.
  assert.match(
    body,
    /w\.workingMinutes > 0\s*\?\s*Math\.round\(\(w\.productionMinutes \/ w\.workingMinutes\) \* 100\)/,
    "department-performance.ts: the range efficiency must be the same " +
      "productionMinutes ÷ workingMinutes the daily rows use",
  );
  // Both exits honour the view, or a cache hit silently returns 9.5 MB.
  assert.equal(
    (src.match(/projectPerformanceSummary\(/g) ?? []).length,
    3,
    "department-performance.ts: the projection must be applied at the " +
      "snapshot-hit return AND the fresh-compute return (plus its definition)",
  );
});

// Behavioural cover for the fold itself: the per-worker range row must be the
// sum of the per-day rows it came from, so a report can never disagree with
// the /employees drilldown it is a projection of.
const { projectPerformanceSummary } = await import(
  "../src/api/routes/department-performance.ts"
);

test("the range roll-up equals the daily rows it was folded from", async () => {
  const full = {
    range: { from: "2026-06-14", to: "2026-06-16" },
    departmentCode: null,
    category: null,
    totals: {
      workingMinutes: 1500,
      productionMinutes: 1200,
      efficiencyPct: 80,
      workerCount: 3,
    },
    daily: [
      {
        date: "2026-06-14",
        workingMinutes: 900,
        productionMinutes: 720,
        efficiencyPct: 80,
        jobs: [{ jobCardId: "jc-a" }, { jobCardId: "jc-b" }],
        workers: [
          {
            workerId: "w1",
            workerName: "AUNG",
            workingMinutes: 540,
            productionMinutes: 540,
            jobs: [{ jobCardId: "jc-a" }, { jobCardId: "jc-b" }],
          },
          {
            workerId: "w2",
            workerName: "MEW",
            workingMinutes: 360,
            productionMinutes: 180,
            jobs: [{ jobCardId: "jc-a" }],
          },
        ],
      },
      {
        date: "2026-06-15",
        workingMinutes: 600,
        productionMinutes: 480,
        efficiencyPct: 80,
        jobs: [{ jobCardId: "jc-a" }],
        workers: [
          {
            workerId: "w1",
            workerName: "AUNG",
            workingMinutes: 60,
            productionMinutes: 60,
            // jc-a again — a card that spans two days must count ONCE.
            jobs: [{ jobCardId: "jc-a" }, { jobCardId: "jc-c" }],
          },
          {
            workerId: "w2",
            workerName: "MEW",
            workingMinutes: 540,
            productionMinutes: 420,
            jobs: [],
          },
          {
            // Credited on a card but never clocked in — the /employees view
            // deliberately surfaces these with workingMinutes 0.
            workerId: "w3",
            workerName: "VIOLET",
            workingMinutes: 0,
            productionMinutes: 0,
            jobs: [{ jobCardId: "jc-d" }],
          },
        ],
      },
    ],
  };

  const out = projectPerformanceSummary(full);

  // The heavy drilldowns are what made this 9.5 MB — they must be gone.
  assert.ok(
    out.daily.every((d) => !("jobs" in d) && !("workers" in d)),
    "the per-day job and worker arrays must be dropped from the summary view",
  );
  assert.deepEqual(out.totals, full.totals, "totals pass through untouched");

  const byId = Object.fromEntries(out.workers.map((w) => [w.workerId, w]));
  assert.equal(byId.w1.workingMinutes, 600, "540 + 60");
  assert.equal(byId.w1.productionMinutes, 600);
  assert.equal(byId.w1.efficiencyPct, 100);
  assert.equal(byId.w1.jobCards, 3, "jc-a, jc-b, jc-c — jc-a counted once");
  assert.equal(byId.w2.workingMinutes, 900, "360 + 540");
  assert.equal(byId.w2.efficiencyPct, 67, "600 / 900 rounded");

  // A worker who clocked nothing gets 0 here; the PAGE is what must turn that
  // into "—" (asserted above), because 0% would read as terrible performance
  // rather than as an absent measurement.
  assert.equal(byId.w3.workingMinutes, 0);
  assert.equal(byId.w3.efficiencyPct, 0);

  // The fold must reconcile with the daily rows — this is the property that
  // makes it a projection rather than a second implementation.
  const dailyWorking = full.daily.reduce((s, d) => s + d.workingMinutes, 0);
  const foldWorking = out.workers.reduce((s, w) => s + w.workingMinutes, 0);
  assert.equal(foldWorking, dailyWorking, "1500 minutes, both ways");

  // Sorted by clocked time, heaviest first.
  assert.deepEqual(
    out.workers.map((w) => w.workerId),
    ["w2", "w1", "w3"],
  );
});
