// ---------------------------------------------------------------------------
// settle-period-punch.test.mjs — the AUTO month-settle contract (owner
// 2026-07-04: the manual Keep-pay/Deduct backlog is retired; a whole month of
// real punches settles from the shift algorithm with NO manual pick).
//
// The POST /settle-period route is a thin batch loop over the SAME per-day
// helper the live punch-out uses (maybeApplyAutoPunchDock). Rather than stand up
// a Hono context, this test drives that helper across a MONTH of punches through
// a stateful mock DB — proving the exact settlement outcomes the owner will see:
//   • a clean full day docks NOTHING,
//   • a late/short day docks its shortfall (source=AUTO),
//   • a forgotten clock-out is never docked,
//   • a day the owner already decided MANUALLY is never overridden,
//   • an already-approved month is not touched at all,
//   • re-running settles to the SAME numbers (idempotent),
//   • the per-reason tally + total docked hours match what settle-period returns.
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

// A stateful in-memory mock of the tables the helper touches. Keyed docks by
// (workerId|date); a global payslip-lock flag; records every insert/delete so a
// test can assert the resulting AUTO docks. This is a fuller mock than the
// per-day test's (it PERSISTS docks) so a batch loop behaves like the real DB:
// a second pass sees the rows the first pass wrote.
function mockDb({ locked = false } = {}) {
  const docks = new Map(); // "worker|date" -> { id, workerId, date, hours, source }
  const audit = { inserts: 0, deletes: 0 };
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
          const [wid, date] = bound;
          return docks.get(`${wid}|${date}`) ?? null;
        }
        if (sql.includes("FROM payslips")) return { c: locked ? 1 : 0 };
        return null;
      },
      async all() {
        return { results: [] };
      },
      async run() {
        if (sql.startsWith("DELETE")) {
          // DELETE ... WHERE id = ?   (stale-clear path)
          const id = bound[0];
          for (const [k, v] of docks) if (v.id === id) docks.delete(k);
          audit.deletes++;
        }
        return {};
      },
    };
    return api;
  }
  return {
    __docks: docks,
    __audit: audit,
    prepare(sql) {
      return stmt(sql);
    },
    async batch(stmts) {
      // The helper's apply path: [DELETE by (worker,date), INSERT the AUTO dock].
      for (const s of stmts) {
        if (s.__sql.startsWith("DELETE")) {
          const [wid, date] = s.bound();
          docks.delete(`${wid}|${date}`);
          audit.deletes++;
        } else if (s.__sql.startsWith("INSERT")) {
          const [id, workerId, date, hours, , source] = s.bound();
          docks.set(`${workerId}|${date}`, { id, workerId, date, hours, source });
          audit.inserts++;
        }
      }
      return [];
    },
  };
}

// The batch the route runs: for each punch, call the per-day helper and tally by
// reason. Mirrors payroll-hour-deductions.ts POST /settle-period exactly.
async function settlePeriod(db, punches) {
  const tally = {
    applied: 0,
    "no-clockout": 0,
    "invalid-times": 0,
    "no-shortfall": 0,
    "period-locked": 0,
    "manual-exists": 0,
  };
  let dockedHours = 0;
  for (const p of punches) {
    const r = await dock.maybeApplyAutoPunchDock(db, {
      workerId: p.workerId,
      date: p.date,
      clockIn: p.clockIn,
      clockOut: p.clockOut,
    });
    tally[r.reason] = (tally[r.reason] ?? 0) + 1;
    if (r.applied) dockedHours += r.hours ?? 0;
  }
  return { ...tally, dockedHours: Math.round(dockedHours * 100) / 100 };
}

test.beforeEach(() => dock._resetDeductionSourceMigForTests());

test("a month of mixed punches settles: full days dock nothing, short days dock the shortfall", async () => {
  const db = mockDb();
  const punches = [
    { workerId: "W1", date: "2026-06-01", clockIn: "08:00", clockOut: "18:00" }, // full day → 0
    { workerId: "W1", date: "2026-06-02", clockIn: "08:12", clockOut: "18:00" }, // late 12m → 0.25h
    { workerId: "W1", date: "2026-06-03", clockIn: "08:00", clockOut: "17:00" }, // left 1h early → 1.0h
    { workerId: "W1", date: "2026-06-04", clockIn: "08:00", clockOut: null },     // forgot punch-out → skip
    { workerId: "W1", date: "2026-06-05", clockIn: "08:08", clockOut: "18:00" }, // within grace → 0
    { workerId: "W1", date: "2026-06-06", clockIn: "08:00", clockOut: "18:28" }, // OT-30 rule: 0 OT, full day → 0
  ];
  const res = await settlePeriod(db, punches);
  assert.equal(res.applied, 2);          // only the 0.25h + 1.0h days
  assert.equal(res["no-shortfall"], 3);  // 2 full days + within-grace day
  assert.equal(res["no-clockout"], 1);   // forgot to punch out
  assert.equal(res.dockedHours, 1.25);
  // The two AUTO docks are present with the right hours.
  assert.equal(db.__docks.get("W1|2026-06-02").hours, 0.25);
  assert.equal(db.__docks.get("W1|2026-06-02").source, dock.AUTO_DOCK_SOURCE);
  assert.equal(db.__docks.get("W1|2026-06-03").hours, 1);
  // A full day never wrote a dock.
  assert.equal(db.__docks.has("W1|2026-06-01"), false);
});

test("re-running settle-period is idempotent — same docks, same tally", async () => {
  const db = mockDb();
  const punches = [
    { workerId: "W1", date: "2026-06-02", clockIn: "08:12", clockOut: "18:00" },
    { workerId: "W1", date: "2026-06-03", clockIn: "08:00", clockOut: "17:00" },
  ];
  const first = await settlePeriod(db, punches);
  const second = await settlePeriod(db, punches);
  assert.deepEqual(first, second);
  assert.equal(db.__docks.get("W1|2026-06-02").hours, 0.25);
  assert.equal(db.__docks.get("W1|2026-06-03").hours, 1);
  // Still exactly two docks after two passes (no stacking).
  assert.equal(db.__docks.size, 2);
});

test("a MANUAL Keep-pay/Deduct decision is never overridden by settle-period", async () => {
  const db = mockDb();
  // Owner already decided this short day by hand (MANUAL).
  db.__docks.set("W1|2026-06-03", {
    id: "phd-manual",
    workerId: "W1",
    date: "2026-06-03",
    hours: 0.5,
    source: "MANUAL",
  });
  const res = await settlePeriod(db, [
    { workerId: "W1", date: "2026-06-03", clockIn: "08:00", clockOut: "17:00" }, // would be 1.0h AUTO
  ]);
  assert.equal(res["manual-exists"], 1);
  assert.equal(res.applied, 0);
  // Untouched: still the owner's 0.5h MANUAL dock.
  assert.equal(db.__docks.get("W1|2026-06-03").hours, 0.5);
  assert.equal(db.__docks.get("W1|2026-06-03").source, "MANUAL");
});

test("an approved month is not touched — every punch skips (period-locked)", async () => {
  const db = mockDb({ locked: true });
  const res = await settlePeriod(db, [
    { workerId: "W1", date: "2026-05-02", clockIn: "08:30", clockOut: "17:00" },
    { workerId: "W2", date: "2026-05-02", clockIn: "08:00", clockOut: "18:00" },
  ]);
  assert.equal(res["period-locked"], 2);
  assert.equal(res.applied, 0);
  assert.equal(db.__docks.size, 0);
});

test("a corrected punch clears its stale AUTO dock on the next settle", async () => {
  const db = mockDb();
  // First pass: a short day writes an AUTO dock.
  await settlePeriod(db, [
    { workerId: "W1", date: "2026-06-03", clockIn: "08:00", clockOut: "17:00" },
  ]);
  assert.equal(db.__docks.get("W1|2026-06-03").hours, 1);
  // Punch corrected to a full day → re-settle clears the stale AUTO row.
  const res = await settlePeriod(db, [
    { workerId: "W1", date: "2026-06-03", clockIn: "08:00", clockOut: "18:00" },
  ]);
  assert.equal(res["no-shortfall"], 1);
  assert.equal(db.__docks.has("W1|2026-06-03"), false);
});
