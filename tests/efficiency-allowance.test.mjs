// ---------------------------------------------------------------------------
// efficiency-allowance.test.mjs — the month-cumulative efficiency helper +
// the allowance gate (src/api/lib/efficiency-allowance.ts), plus structural
// guards pinning the three payroll wire sites so a refactor can't silently
// revert the bonus back to a hardcoded 0.
//
// The efficiency number MUST match the Employees → Efficiency Overview tab
// (prodMin ÷ production-dept-hours×60 ×100) because that is the screen the
// operator reads to decide "did this worker hit the target". The gate pays the
// flat efficiencyAllowanceSen only when the worker reaches efficiencyThresholdPct.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on Node 22+.
}

const eff = await import(
  pathToFileURL(
    resolve(process.cwd(), "src/api/lib/efficiency-allowance.ts"),
  ).href
);

// A minimal DbLike that routes each query to canned rows by SQL fingerprint —
// the helper runs exactly three: departments, the job-card proration (carries
// the unique `contrib_min` alias), and working_hour_entries.
function mockDb({ depts, jc, whe }) {
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async all() {
              if (sql.includes("FROM departments")) return { results: depts };
              if (sql.includes("contrib_min")) return { results: jc };
              if (sql.includes("working_hour_entries")) return { results: whe };
              return { results: [] };
            },
          };
        },
      };
    },
  };
}

// ── monthBounds ─────────────────────────────────────────────────────────────

test("monthBounds: a 30-day month spans the 1st to the 30th", () => {
  assert.deepEqual(eff.monthBounds("2026-06"), {
    start: "2026-06-01",
    end: "2026-06-30",
  });
});

test("monthBounds: February 2026 (non-leap) ends on the 28th", () => {
  assert.deepEqual(eff.monthBounds("2026-02"), {
    start: "2026-02-01",
    end: "2026-02-28",
  });
});

// ── computeMonthlyEfficiencyByWorker ─────────────────────────────────────────

test("efficiency = prodMin ÷ (production-dept hours × 60) × 100", async () => {
  const db = mockDb({
    depts: [
      { code: "FAB_SEW", isProduction: 1 },
      { code: "WAREHOUSE", isProduction: 0 },
    ],
    jc: [
      { workerId: "W1", productionMinutes: 480 }, // 8h of output
      { workerId: "W3", productionMinutes: 240 }, // 4h of output
    ],
    whe: [
      { workerId: "W1", departmentCode: "FAB_SEW", date: "2026-06-01", hours: 8 },
      // Non-production hours never count toward the denominator.
      { workerId: "W2", departmentCode: "WAREHOUSE", date: "2026-06-01", hours: 8 },
      { workerId: "W3", departmentCode: "FAB_SEW", date: "2026-06-02", hours: 8 },
    ],
  });
  const m = await eff.computeMonthlyEfficiencyByWorker(db, "2026-06-01", "2026-06-30");

  // W1: 480 / (8×60) = 100%
  assert.equal(m.get("W1").pct, 100);
  assert.equal(m.get("W1").prodHours, 8);
  // W3: 240 / (8×60) = 50%
  assert.equal(m.get("W3").pct, 50);
  // W2: only non-production hours → denominator 0 → efficiency undefined (—).
  assert.equal(m.get("W2").pct, null);
  assert.equal(m.get("W2").daysWithEntries, 1);
});

test("a worker with hours but zero completed cards is a real 0%, not null", async () => {
  const db = mockDb({
    depts: [{ code: "FOAM", isProduction: 1 }],
    jc: [],
    whe: [{ workerId: "W9", departmentCode: "FOAM", date: "2026-06-03", hours: 8 }],
  });
  const m = await eff.computeMonthlyEfficiencyByWorker(db, "2026-06-01", "2026-06-30");
  assert.equal(m.get("W9").pct, 0); // production hours exist, output is 0
});

// ── resolveEfficiencyAllowanceSen ────────────────────────────────────────────

const E = (pct) => ({ prodMinutes: 0, prodHours: 1, daysWithEntries: 1, pct });

test("pays the flat bonus when monthly efficiency reaches the threshold", () => {
  assert.equal(eff.resolveEfficiencyAllowanceSen(E(100), 15000, 100), 15000);
  assert.equal(eff.resolveEfficiencyAllowanceSen(E(112.4), 15000, 100), 15000);
});

test("pays nothing when efficiency is below the threshold", () => {
  assert.equal(eff.resolveEfficiencyAllowanceSen(E(80), 15000, 100), 0);
  assert.equal(eff.resolveEfficiencyAllowanceSen(E(99), 15000, 100), 0);
});

test("the gate compares on the same 1-decimal figure shown on the Overview", () => {
  // 99.96% renders as "100.0%" on screen → the bonus must pay (no surprise).
  assert.equal(eff.resolveEfficiencyAllowanceSen(E(99.96), 15000, 100), 15000);
  // 99.94% renders as "99.9%" → below 100, no bonus.
  assert.equal(eff.resolveEfficiencyAllowanceSen(E(99.94), 15000, 100), 0);
});

test("no bonus when unconfigured (default 0 allowance or 0 threshold)", () => {
  assert.equal(eff.resolveEfficiencyAllowanceSen(E(100), 0, 100), 0);
  assert.equal(eff.resolveEfficiencyAllowanceSen(E(100), 15000, 0), 0);
  assert.equal(eff.resolveEfficiencyAllowanceSen(E(100), 0, 0), 0);
});

test("no bonus when efficiency is undefined (—) or the worker is absent from the map", () => {
  assert.equal(eff.resolveEfficiencyAllowanceSen(E(null), 15000, 100), 0);
  assert.equal(eff.resolveEfficiencyAllowanceSen(undefined, 15000, 100), 0);
});

// ── Structural guards on the three wire sites ────────────────────────────────

const WORKER = readFileSync(resolve(process.cwd(), "src/api/routes/worker.ts"), "utf8");
const PAYSLIPS = readFileSync(resolve(process.cwd(), "src/api/routes/payslips.ts"), "utf8");

test("worker my-pay computes the bonus via the gate (no hardcoded 0)", () => {
  assert.ok(
    !WORKER.includes("const efficiencyAllowanceSen = 0;"),
    "the placeholder efficiencyAllowanceSen = 0 must be gone",
  );
  assert.ok(
    WORKER.includes("resolveEfficiencyAllowanceSen(") &&
      WORKER.includes("computeMonthlyEfficiencyByWorker("),
    "my-pay must compute monthly efficiency and run it through the gate",
  );
});

test("worker my-pay attaches the per-day Absent / OT detail", () => {
  assert.ok(
    WORKER.includes("computeAttendanceDayDetail(") &&
      WORKER.includes("absentDates: dayDetail.absentDates") &&
      WORKER.includes("otDays: dayDetail.otDays"),
    "my-pay must return absentDates + otDays so the phone can drill the figures down",
  );
});

test("BOTH payslips paths (projected + stored) gate the allowance, neither hardcodes 0", () => {
  assert.ok(
    !PAYSLIPS.includes("const allowances = 0;"),
    "both `const allowances = 0;` sites must be replaced",
  );
  const gateCalls = (PAYSLIPS.match(/resolveEfficiencyAllowanceSen\(/g) || []).length;
  assert.ok(
    gateCalls >= 2,
    `expected the allowance gate in both the projected and POST paths, found ${gateCalls}`,
  );
});

test("payslips loads the per-worker bonus config from the workers table", () => {
  assert.ok(
    PAYSLIPS.includes("efficiencyAllowanceSen, efficiencyThresholdPct FROM workers"),
    "the worker SELECT must pull efficiencyAllowanceSen + efficiencyThresholdPct",
  );
});
