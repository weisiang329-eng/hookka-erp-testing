// ---------------------------------------------------------------------------
// punch-degenerate-window.test.mjs — BUG-2026-08-01-005.
//
// A worker who forgets the MORNING punch and does both at knock-off leaves a
// window like 18:01 IN / 18:02 OUT. That is technically "valid" (out > in), and
// the shift maths turned it into a FULL day's shortfall — docked on top of the
// absence the same day already carried, because it had no logged hours either.
// KYAW ZIN OO 2026-07-01: RM78.85 absence + RM70.96 hour dock = RM149.81 for a
// day he was physically at the factory.
//
// Rule: a window that yields NO payable minutes at all is a BROKEN PUNCH, not a
// zero-hour day. It is not evidence, so it docks nothing and the day is left to
// the absence rule / the office.
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

const { computePunchShortfallHours } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/attendance-deduct.ts")).href
);

test("18:01 → 18:02 is a broken punch, not a 9h shortfall", () => {
  const r = computePunchShortfallHours("18:01", "18:02");
  assert.equal(r.shortfallHours, 0);
  assert.equal(r.valid, false); // not evidence — nothing to dock
});

test("same-minute punch (18:01 → 18:01) docks nothing", () => {
  const r = computePunchShortfallHours("18:01", "18:01");
  assert.equal(r.shortfallHours, 0);
});

test("a late-evening sliver of work still docks nothing rather than a full day", () => {
  // 17:50 → 18:00: after the late blocks there are no payable regular minutes.
  // The day's absence (no logged hours) is the bigger charge anyway.
  const r = computePunchShortfallHours("17:50", "18:00");
  assert.equal(r.shortfallHours, 0);
});

test("a REAL short day is still docked — the guard must not swallow those", () => {
  // 08:00 → 14:00 = 5h payable against a 9h day.
  const r = computePunchShortfallHours("08:00", "14:00");
  assert.equal(r.valid, true);
  assert.equal(r.shortfallHours, 4);
});

test("a real late arrival is still docked", () => {
  // 09:09 in = 69 minutes late, charged to the MINUTE now (HR 2026-08-02):
  // 69/60 = 1.15h. Under the old ceil-to-15 the same arrival cost 1.25h —
  // EI PHOO WEI 2026-07-11 was docked the rounded figure.
  const r = computePunchShortfallHours("09:09", "18:03");
  assert.equal(r.valid, true);
  assert.equal(r.shortfallHours, 1.15);
});

test("a full day is still zero", () => {
  const r = computePunchShortfallHours("08:00", "18:00");
  assert.equal(r.valid, true);
  assert.equal(r.shortfallHours, 0);
});

// ---------------------------------------------------------------------------
// The CLASS guard: one day, one charge.
//
// The payroll engine calls a day an ABSENCE when it has no LOGGED HOURS, and
// docks the full ÷26 day rate for it. So an hour dock on a zero-logged day is
// always a SECOND deduction for the same day. The rule is enforced once, in
// maybeApplyAutoDayDock, because all three auto paths funnel through it: the
// live punch-out, the office re-apply-from-punch endpoint, and the monthly
// settle. Pinning it here means none of them can grow the bug back.
// ---------------------------------------------------------------------------
const { maybeApplyAutoDayDock, _resetDeductionSourceMigForTests } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/attendance-deduct.ts")).href
);

function dockDb({ loggedHours = 0, existingDock = null } = {}) {
  const calls = { deletes: [], inserts: [], batches: 0 };
  const stmt = (sql) => {
    let bound = [];
    const api = {
      __sql: sql,
      bound: () => bound,
      bind(...a) { bound = a; return api; },
      async first() {
        if (sql.includes("FROM payroll_hour_deductions")) return existingDock;
        if (sql.includes("FROM working_hour_entries")) return { h: loggedHours };
        if (sql.includes("FROM payslips")) return { c: 0 };
        return null;
      },
      async all() { return { results: [] }; },
      async run() { if (sql.startsWith("DELETE")) calls.deletes.push(bound); return {}; },
    };
    return api;
  };
  return {
    __calls: calls,
    prepare: stmt,
    async batch(stmts) {
      calls.batches++;
      for (const s of stmts) if (s.__sql.startsWith("INSERT")) calls.inserts.push(s.bound());
      return [];
    },
  };
}

test("zero logged hours = ABSENCE: never also docked", async () => {
  _resetDeductionSourceMigForTests();
  const db = dockDb({ loggedHours: 0 });
  const r = await maybeApplyAutoDayDock(db, {
    workerId: "w1", date: "2026-07-01", shortfallHours: 9, note: "Auto: short 9h",
  });
  assert.equal(r.applied, false);
  assert.equal(r.reason, "absent-day");
  assert.equal(db.__calls.inserts.length, 0);
});

test("an absent day's stale AUTO dock is CLEARED (self-heals old rows)", async () => {
  _resetDeductionSourceMigForTests();
  const db = dockDb({ loggedHours: 0, existingDock: { id: "phd-old", source: "AUTO" } });
  const r = await maybeApplyAutoDayDock(db, {
    workerId: "w1", date: "2026-07-01", shortfallHours: 9, note: "Auto: short 9h",
  });
  assert.equal(r.reason, "absent-day");
  assert.equal(db.__calls.deletes.length, 1);
  assert.deepEqual(db.__calls.deletes[0], ["phd-old"]);
});

test("an owner's MANUAL dock on an absent day still wins", async () => {
  _resetDeductionSourceMigForTests();
  const db = dockDb({ loggedHours: 0, existingDock: { id: "phd-m", source: "MANUAL" } });
  const r = await maybeApplyAutoDayDock(db, {
    workerId: "w1", date: "2026-07-01", shortfallHours: 9, note: "Auto: short 9h",
  });
  assert.equal(r.reason, "manual-exists");
  assert.equal(db.__calls.deletes.length, 0); // untouched
});

test("a day WITH logged hours is still docked normally", async () => {
  _resetDeductionSourceMigForTests();
  const db = dockDb({ loggedHours: 7.5 });
  const r = await maybeApplyAutoDayDock(db, {
    workerId: "w1", date: "2026-07-02", shortfallHours: 1.5, note: "Auto: short 1.5h",
  });
  assert.equal(r.applied, true);
  assert.equal(r.hours, 1.5);
  assert.equal(db.__calls.inserts.length, 1);
});
