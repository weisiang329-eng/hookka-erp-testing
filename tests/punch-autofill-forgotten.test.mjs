// ---------------------------------------------------------------------------
// punch-autofill-forgotten.test.mjs — BUG-2026-08-01-001.
//
// Pay reads working_hour_entries, NOT attendance_records. Both forgotten-punch
// auto-close paths (midnight cron + next clock-in self-heal) used to close the
// attendance row and stop there, so the day sat at 0 logged hours and the
// payroll engine counted it as an ABSENCE — docking a full day (salary ÷ 26)
// on a day the worker actually came in. 25 worker-days in 2026-07 alone.
//
// The fix: autoCloseForgottenPunch now calls autofillWorkingHoursFromPunch with
// `fixedHours` = the worker's CONTRACTED shift. These tests pin that contract:
//   1. fixedHours wins over the punch window (a late punch can't shrink the day),
//   2. an INVERTED window (clocked in 18:03, closed 18:00) still writes hours —
//      the normal path rejects it, and that rejection is what cost EMP-001 7/04,
//   3. the never-overwrite gate still holds (office-keyed rows win),
//   4. the rows are tagged so the office can spot them.
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

const { autofillWorkingHoursFromPunch } = await import(
  pathToFileURL(resolve(process.cwd(), "src/api/lib/punch-autofill.ts")).href
);

// Mock DB: no existing entries unless supplied, no pay-rule versions (helper
// falls back to defaults), no dept scans. Records every INSERT.
function mockDb({ existingEntries = [], scans = [] } = {}) {
  const inserts = [];
  function stmt(sql) {
    let bound = [];
    const api = {
      bind(...args) {
        bound = args;
        return api;
      },
      async all() {
        if (sql.includes("FROM working_hour_entries")) {
          return { results: existingEntries };
        }
        if (sql.includes("FROM dept_scan_events")) return { results: scans };
        return { results: [] };
      },
      async first() {
        return null;
      },
      async run() {
        if (sql.startsWith("INSERT INTO working_hour_entries")) {
          inserts.push({
            date: bound[3],
            departmentCode: bound[4],
            category: bound[5],
            hours: bound[6],
            notes: bound[7],
          });
        }
        return {};
      },
    };
    return api;
  }
  return { prepare: (sql) => stmt(sql), inserts, batch: async () => {} };
}

const BASE = {
  attendanceId: "att-1",
  workerId: "worker-1",
  date: "2026-07-08",
  homeDeptCode: "FAB_CUT",
};

test("forgotten punch: fixedHours wins over the punch window", async () => {
  const db = mockDb();
  // Clocked in 09:30 (90 min late) and auto-closed at 18:00. The punch maths
  // would give ~7.5h and dock the rest; the contracted day is 9h.
  const r = await autofillWorkingHoursFromPunch(db, {
    ...BASE,
    clockIn: "09:30",
    clockOut: "18:00",
    fixedHours: 9,
  });
  assert.equal(r.created, 1);
  assert.equal(db.inserts.reduce((s, i) => s + i.hours, 0), 9);
});

test("forgotten punch: an INVERTED window still writes the standard day", async () => {
  const db = mockDb();
  // EMP-001, 2026-07-04: forgot the morning punch, clocked in at 18:03, cron
  // closed it at 18:00. outMin <= inMin — the normal path bails out here.
  const r = await autofillWorkingHoursFromPunch(db, {
    ...BASE,
    date: "2026-07-04",
    clockIn: "18:03",
    clockOut: "18:00",
    fixedHours: 9,
  });
  assert.equal(r.created, 1);
  assert.equal(db.inserts[0].hours, 9);
  assert.equal(db.inserts[0].departmentCode, "FAB_CUT");
});

test("a 7.5h worker gets 7.5h, not the factory-wide 9h", async () => {
  const db = mockDb();
  // ANN (EMP-004) — every one of her 2026-07 punches was a forgotten punch-out.
  await autofillWorkingHoursFromPunch(db, {
    ...BASE,
    homeDeptCode: "FAB_SEW",
    clockIn: "08:07",
    clockOut: "18:00",
    fixedHours: 7.5,
  });
  assert.equal(db.inserts.reduce((s, i) => s + i.hours, 0), 7.5);
});

test("rows are tagged as a no-punch-out standard shift", async () => {
  const db = mockDb();
  await autofillWorkingHoursFromPunch(db, {
    ...BASE,
    clockIn: "07:34",
    clockOut: "18:00",
    fixedHours: 9,
  });
  assert.match(db.inserts[0].notes, /no punch-out — standard shift/);
});

test("never overwrites office-keyed hours", async () => {
  const db = mockDb({ existingEntries: [{ hours: 6, notes: "" }] });
  const r = await autofillWorkingHoursFromPunch(db, {
    ...BASE,
    clockIn: "07:34",
    clockOut: "18:00",
    fixedHours: 9,
  });
  assert.equal(r.created, 0);
  assert.equal(db.inserts.length, 0);
});

test("without fixedHours an invalid window is still rejected (normal punch-out)", async () => {
  const db = mockDb();
  const r = await autofillWorkingHoursFromPunch(db, {
    ...BASE,
    clockIn: "18:03",
    clockOut: "18:00",
  });
  assert.equal(r.created, 0);
  assert.equal(db.inserts.length, 0);
});

test("a normal punch-out is unchanged by the new parameter", async () => {
  const db = mockDb();
  // 08:00 → 18:00, 1h unpaid lunch = 9h, no OT.
  const r = await autofillWorkingHoursFromPunch(db, {
    ...BASE,
    clockIn: "08:00",
    clockOut: "18:00",
  });
  assert.equal(r.created, 1);
  assert.equal(db.inserts[0].hours, 9);
  assert.doesNotMatch(db.inserts[0].notes, /no punch-out/);
});
