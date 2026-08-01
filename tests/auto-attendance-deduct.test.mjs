// ---------------------------------------------------------------------------
// auto-attendance-deduct.test.mjs — the punch → auto short-hour dock helper
// (src/api/lib/attendance-deduct.ts).
//
// This moves REAL MONEY, so the tests pin BOTH halves:
//   1. computePunchShortfallHours — the shift maths (08:00–18:00, 1h lunch = 9h,
//      10-min late grace folds into shortfall, OT is separate). Pure.
//   2. maybeApplyAutoPunchDock — every guard, because each one is a "don't
//      wrongly dock a worker" promise: no clock-out → skip, finalised month →
//      skip, a manual dock is never overridden, tiny/zero shortfall → no dock
//      (and a stale AUTO dock is cleared), and the happy path writes source=AUTO.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  // Native type-stripping handles it on Node 22+.
}

const dock = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/attendance-deduct.ts")).href
);
const { HOOKKA_ATTENDANCE: BASE_RULES } = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/attendance-rules.ts")).href
);

// A stateful mock DB: one optional existing dock for the (worker, date) lookup,
// a payslip-lock count, and recorders for what got written. Routes by SQL
// fingerprint — the helper runs: ALTER (ensure), SELECT existing dock, SELECT
// payslip lock count, then either a DELETE (clear stale) or a batch(DELETE,INSERT).
// loggedHours — the day's working_hour_entries total. Defaults to a normal
// logged day because that is the only state in which a short-hour dock is even
// meaningful: a day with ZERO logged hours is an ABSENCE, already charged in
// full by the payroll engine, and the "never charge one day twice" guard
// (BUG-2026-08-01-002) refuses to dock it. Set loggedHours: 0 to exercise that.
function mockDb({ existingDock = null, lockedCount = 0, workerHours = null, loggedHours = 8 } = {}) {
  const calls = { alters: 0, deletes: [], inserts: [], batches: 0 };
  function stmt(sql) {
    let bound = [];
    const api = {
      __sql: sql,
      bound: () => bound,
      bind(...args) {
        bound = args;
        return api;
      },
      async first() {
        if (
          sql.includes("FROM payroll_hour_deductions") &&
          sql.includes("WHERE workerId")
        ) {
          return existingDock; // { id, source } | null
        }
        if (sql.includes("FROM working_hour_entries")) return { h: loggedHours };
        if (sql.includes("FROM payslips")) return { c: lockedCount };
        // Per-employee standard day (BUG-2026-07-17-006). null → the helper
        // keeps the global 9h default, which is what every other test expects.
        if (sql.includes("FROM workers")) {
          return workerHours === null ? null : { workingHoursPerDay: workerHours };
        }
        return null;
      },
      async all() {
        return { results: [] };
      },
      async run() {
        if (sql.startsWith("ALTER TABLE")) calls.alters++;
        else if (sql.startsWith("DELETE")) calls.deletes.push({ sql, bound });
        return {};
      },
    };
    return api;
  }
  return {
    __calls: calls,
    prepare(sql) {
      return stmt(sql);
    },
    async batch(stmts) {
      calls.batches++;
      for (const s of stmts) {
        if (s.__sql.startsWith("INSERT"))
          calls.inserts.push({ sql: s.__sql, bound: s.bound() });
        else if (s.__sql.startsWith("DELETE"))
          calls.deletes.push({ sql: s.__sql, bound: s.bound() });
      }
      return [];
    },
  };
}

// Reset the module-level "source column" migration cache before each case so the
// ensure step is exercised against the fresh mock.
test.beforeEach(() => dock._resetDeductionSourceMigForTests());

// ── computePunchShortfallHours (pure shift maths) ───────────────────────────

test("on-time full day 08:00–18:00 → zero shortfall", () => {
  const r = dock.computePunchShortfallHours("08:00", "18:00");
  assert.equal(r.valid, true);
  assert.equal(r.hasClockOut, true);
  assert.equal(r.shortfallHours, 0);
  assert.equal(r.lateMin, 0);
  assert.equal(r.otMin, 0);
});

test("leaving an hour early 08:00–17:00 → 1.0h shortfall", () => {
  const r = dock.computePunchShortfallHours("08:00", "17:00");
  assert.equal(r.shortfallHours, 1);
});

test("late 12 min (past grace) 08:12–18:00 → ceiled to a 15-min block = 0.25h, lateMin 12", () => {
  // Owner 2026-06-11: penal lateness rounds UP to 15-min blocks.
  const r = dock.computePunchShortfallHours("08:12", "18:00");
  assert.equal(r.lateMin, 12);
  assert.equal(r.shortfallHours, 0.25);
});

test("late within the 10-min grace 08:08–18:00 → no shortfall, no late", () => {
  const r = dock.computePunchShortfallHours("08:08", "18:00");
  assert.equal(r.lateMin, 0);
  assert.equal(r.shortfallHours, 0);
});

test("overtime 08:00–19:10 → no shortfall, OT 60m (clock-out floored to 19:00)", () => {
  const r = dock.computePunchShortfallHours("08:00", "19:10");
  assert.equal(r.shortfallHours, 0);
  assert.equal(r.otMin, 60);
});

test("missing clock-out → not valid, hasClockOut false", () => {
  const r = dock.computePunchShortfallHours("08:00", null);
  assert.equal(r.hasClockOut, false);
  assert.equal(r.valid, false);
  assert.equal(r.shortfallHours, 0);
});

test("garbage / reversed times → not valid", () => {
  assert.equal(dock.computePunchShortfallHours("xx", "18:00").valid, false);
  assert.equal(dock.computePunchShortfallHours("18:00", "08:00").valid, false);
});

// ── maybeApplyAutoPunchDock (guards) ────────────────────────────────────────

test("no clock-out → skip, never writes (forgot-to-punch-out guard)", async () => {
  const db = mockDb();
  const res = await dock.maybeApplyAutoPunchDock(db, {
    workerId: "W1",
    date: "2026-06-03",
    clockIn: "08:00",
    clockOut: null,
  });
  assert.equal(res.applied, false);
  assert.equal(res.reason, "no-clockout");
  assert.equal(db.__calls.batches, 0);
  assert.equal(db.__calls.inserts.length, 0);
});

test("clean late/short day → applies an AUTO dock with the shortfall hours", async () => {
  const db = mockDb({ existingDock: null, lockedCount: 0 });
  const res = await dock.maybeApplyAutoPunchDock(db, {
    workerId: "W1",
    date: "2026-06-03",
    clockIn: "08:12",
    clockOut: "18:00",
  });
  assert.equal(res.applied, true);
  assert.equal(res.reason, "applied");
  assert.equal(res.hours, 0.25);
  assert.equal(db.__calls.inserts.length, 1);
  const ins = db.__calls.inserts[0];
  // INSERT (id, workerId, date, hours, note, source)
  assert.equal(ins.bound[1], "W1");
  assert.equal(ins.bound[2], "2026-06-03");
  assert.equal(ins.bound[3], 0.25);
  assert.equal(ins.bound[5], dock.AUTO_DOCK_SOURCE);
});

test("a MANUAL dock on that day is NEVER overridden", async () => {
  const db = mockDb({ existingDock: { id: "phd-x", source: "MANUAL" } });
  const res = await dock.maybeApplyAutoPunchDock(db, {
    workerId: "W1",
    date: "2026-06-03",
    clockIn: "08:30",
    clockOut: "17:00",
  });
  assert.equal(res.applied, false);
  assert.equal(res.reason, "manual-exists");
  assert.equal(db.__calls.batches, 0);
  assert.equal(db.__calls.deletes.length, 0);
});

test("an existing AUTO dock IS overwritten (re-punch recompute)", async () => {
  const db = mockDb({ existingDock: { id: "phd-old", source: "AUTO" } });
  const res = await dock.maybeApplyAutoPunchDock(db, {
    workerId: "W1",
    date: "2026-06-03",
    clockIn: "08:00",
    clockOut: "17:00",
  });
  assert.equal(res.applied, true);
  assert.equal(res.hours, 1);
  assert.equal(db.__calls.inserts.length, 1);
  assert.equal(db.__calls.inserts[0].bound[5], dock.AUTO_DOCK_SOURCE);
});

test("finalised month (a payslip not DRAFT) → never touched", async () => {
  const db = mockDb({ lockedCount: 1 });
  const res = await dock.maybeApplyAutoPunchDock(db, {
    workerId: "W1",
    date: "2026-05-03",
    clockIn: "08:30",
    clockOut: "17:00",
  });
  assert.equal(res.applied, false);
  assert.equal(res.reason, "period-locked");
  assert.equal(db.__calls.inserts.length, 0);
});

test("full day → no dock; a stale AUTO dock is cleared", async () => {
  const db = mockDb({ existingDock: { id: "phd-stale", source: "AUTO" } });
  const res = await dock.maybeApplyAutoPunchDock(db, {
    workerId: "W1",
    date: "2026-06-03",
    clockIn: "08:00",
    clockOut: "18:00",
  });
  assert.equal(res.applied, false);
  assert.equal(res.reason, "no-shortfall");
  // the stale AUTO row was deleted, nothing inserted
  assert.equal(db.__calls.inserts.length, 0);
  assert.equal(db.__calls.deletes.length, 1);
  assert.equal(db.__calls.deletes[0].bound[0], "phd-stale");
});

test("full day with NO existing dock → no write at all", async () => {
  const db = mockDb({ existingDock: null });
  const res = await dock.maybeApplyAutoPunchDock(db, {
    workerId: "W1",
    date: "2026-06-03",
    clockIn: "08:00",
    clockOut: "18:00",
  });
  assert.equal(res.applied, false);
  assert.equal(res.reason, "no-shortfall");
  assert.equal(db.__calls.deletes.length, 0);
  assert.equal(db.__calls.inserts.length, 0);
});


// ── BUG-2026-07-17-006 — a full day is THIS worker's day ────────────────────
// ANN (EMP-004) is contracted workingHoursPerDay = 7.5, not the global 9. The
// pay side already honoured it (hourlyRate = dailyRate / 7.5), and so did the
// settle-period To-fill (expected − logged) branch — but BOTH punch branches
// measured her against the global 9 and docked 9 − 7.5 = 1.5h on EVERY full day
// she worked (−RM233.58 over 13 days in July for a worker who was never short).
//
// The first fix caught only the LIVE punch path (maybeApplyAutoPunchDock). The
// monthly POST /settle-period — the path that actually built her July — kept
// scoring punches against the global 9, so deleting her docks would have let the
// next settle silently re-create them. Both now go through rulesForWorkerHours;
// the tests below pin the shared helper so neither caller can drift again.

test("7.5h worker who works her FULL day is NOT docked", async () => {
  const db = mockDb({ workerHours: 7.5 });
  // 08:00–16:30 minus the 1h lunch = 7.5h worked = exactly her full day.
  const r = await dock.maybeApplyAutoPunchDock(db, {
    workerId: "w-ann",
    date: "2026-07-01",
    clockIn: "08:00",
    clockOut: "16:30",
  });
  assert.equal(r.applied, false, "a full 7.5h day must not be docked");
  assert.equal(db.__calls.inserts.length, 0, "no dock row written");
});

test("9h worker is still measured against 9h (no regression)", async () => {
  const db = mockDb({ workerHours: 9 });
  const r = await dock.maybeApplyAutoPunchDock(db, {
    workerId: "w-std",
    date: "2026-07-01",
    clockIn: "08:00",
    clockOut: "16:30",
  });
  // 7.5h worked against a 9h day = 1.5h short → still docked.
  assert.equal(r.applied, true, "a 9h worker leaving at 16:30 IS 1.5h short");
});

test("a 7.5h worker genuinely short IS still docked", async () => {
  const db = mockDb({ workerHours: 7.5 });
  // 08:00–15:30 minus lunch = 6.5h against her 7.5h day = 1h short.
  const r = await dock.maybeApplyAutoPunchDock(db, {
    workerId: "w-ann",
    date: "2026-07-01",
    clockIn: "08:00",
    clockOut: "15:30",
  });
  assert.equal(r.applied, true, "short vs her OWN day must still dock");
});

test("missing / zero hours falls back to the global 9h", async () => {
  for (const h of [null, 0]) {
    const db = mockDb({ workerHours: h });
    const r = await dock.maybeApplyAutoPunchDock(db, {
      workerId: "w-unset",
      date: "2026-07-01",
      clockIn: "08:00",
      clockOut: "16:30",
    });
    assert.equal(r.applied, true, `hours=${h} must keep the 9h default`);
  }
});

// ── rulesForWorkerHours — the shared helper BOTH dock paths run rules through ──
// Pinned directly (not just via the punch path) because POST /settle-period is
// the second caller and it builds the whole month in bulk. If this helper is
// right, both callers are right.

test("rulesForWorkerHours: a 7.5h contract shortens the standard day", () => {
  const r = dock.rulesForWorkerHours(BASE_RULES, 7.5);
  assert.equal(r.standardWorkMin, 450, "7.5h = 450 min");
});

test("rulesForWorkerHours: OT thresholds are NOT touched", () => {
  const r = dock.rulesForWorkerHours(BASE_RULES, 7.5);
  // OT keys off endMin, so a 7.5h contract must NOT make 16:30 count as OT.
  assert.equal(r.endMin, BASE_RULES.endMin, "endMin must not move");
  assert.equal(r.startMin, BASE_RULES.startMin, "startMin must not move");
  assert.equal(r.lunchMin, BASE_RULES.lunchMin, "lunch must not move");
  assert.equal(r.lateGraceMin, BASE_RULES.lateGraceMin, "grace must not move");
});

test("rulesForWorkerHours: unset hours keep the global day", () => {
  // 0 means "not configured", never "works a zero-hour day" — the difference
  // between leaving pay alone and docking someone their entire salary.
  for (const h of [null, undefined, 0, NaN, ""]) {
    const r = dock.rulesForWorkerHours(BASE_RULES, h);
    assert.equal(
      r.standardWorkMin,
      BASE_RULES.standardWorkMin,
      `hours=${String(h)} must keep the global default`,
    );
  }
});

test("rulesForWorkerHours: matching hours return the rules untouched", () => {
  const r = dock.rulesForWorkerHours(BASE_RULES, 9);
  assert.equal(r, BASE_RULES, "a 9h contract on a 9h shift is a no-op");
});

test("rulesForWorkerHours: ANN's real July day scores ZERO shortfall", () => {
  // The exact case that cost her RM233.58: 08:00–16:30 minus the 1h lunch =
  // 7.5h = her full contracted day. This is what settle-period now computes.
  const rules = dock.rulesForWorkerHours(BASE_RULES, 7.5);
  const sf = dock.computePunchShortfallHours("08:00", "16:30", rules);
  assert.equal(sf.shortfallHours, 0, "her full day must be 0h short");
  // ...and the un-fixed global rules are what produced the 1.5h/day dock.
  const wrong = dock.computePunchShortfallHours("08:00", "16:30", BASE_RULES);
  assert.equal(wrong.shortfallHours, 1.5, "the old global-9h read = 1.5h short");
});
