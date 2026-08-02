// ---------------------------------------------------------------------------
// settle-period-punch.test.mjs — the FULL-AUTO month-settle contract (owner
// 2026-07-04 (A): the manual Keep-pay/Deduct backlog is retired; EVERY
// under-settled day auto-docks its shortfall — from the punch shift rules AND
// from under-logged Working Hours).
//
// Pins:
//   • computeUnderLoggedShortfallHours — the To-fill maths (expected − logged;
//     0 logged = absence, not under-logged).
//   • maybeApplyAutoDayDock — the shared guard/apply core used by both the punch
//     path and the under-logged path (MANUAL never overridden, finalised month
//     skipped, full day clears stale AUTO).
//   • A unified month batch (max(punchShort, loggedShort) per day) matching the
//     POST /settle-period loop: full days dock nothing, short punch OR under-log
//     docks the shortfall, an absence (nothing recorded) is skipped, a MANUAL
//     pick survives, an approved month is untouched, and a re-run is idempotent.
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

// A stateful in-memory mock that PERSISTS docks so a batch loop behaves like the
// real DB (a second pass sees the first pass's rows).
// loggedByKey — "worker|date" → the day's working_hour_entries total. Anything
// not listed defaults to a normal logged day, because a day with ZERO logged
// hours is an ABSENCE (already charged in full by the payroll engine) and the
// "never charge one day twice" guard refuses to dock it — see BUG-2026-08-01-005.
function mockDb({ locked = false, loggedByKey = null } = {}) {
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
        if (sql.includes("FROM working_hour_entries")) {
          const [wid, date] = bound;
          return { h: loggedByKey ? (loggedByKey[`${wid}|${date}`] ?? 8) : 8 };
        }
        if (sql.includes("FROM payslips")) return { c: locked ? 1 : 0 };
        return null;
      },
      async all() {
        return { results: [] };
      },
      async run() {
        if (sql.startsWith("DELETE")) {
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

test.beforeEach(() => dock._resetDeductionSourceMigForTests());

// ── computeUnderLoggedShortfallHours (pure To-fill maths) ────────────────────

test("under-logged shortfall = expected − logged on a partial day", () => {
  assert.equal(dock.computeUnderLoggedShortfallHours(7, 9), 2);
  assert.equal(dock.computeUnderLoggedShortfallHours(8.5, 9), 0.5);
  assert.equal(dock.computeUnderLoggedShortfallHours(4.7, 9), 4.3); // ZAW LIN-style
});

test("a full or over day is not under-logged (0)", () => {
  assert.equal(dock.computeUnderLoggedShortfallHours(9, 9), 0);
  assert.equal(dock.computeUnderLoggedShortfallHours(11, 9), 0); // OT day — never docks
});

test("zero logged is an ABSENCE, not under-logged (0 — salary deduction handles it)", () => {
  assert.equal(dock.computeUnderLoggedShortfallHours(0, 9), 0);
});

// ── maybeApplyAutoDayDock (shared guard/apply core) ─────────────────────────

test("applies an AUTO dock for a pre-computed shortfall", async () => {
  const db = mockDb();
  const r = await dock.maybeApplyAutoDayDock(db, {
    workerId: "W1",
    date: "2026-06-03",
    shortfallHours: 4.3,
    note: "Auto: short 4.3h (from unlogged hours)",
  });
  assert.equal(r.applied, true);
  assert.equal(r.hours, 4.3);
  assert.equal(db.__docks.get("W1|2026-06-03").source, dock.AUTO_DOCK_SOURCE);
});

test("a MANUAL dock is never overridden by the day-dock core", async () => {
  const db = mockDb();
  db.__docks.set("W1|2026-06-03", { id: "phd-m", workerId: "W1", date: "2026-06-03", hours: 1, source: "MANUAL" });
  const r = await dock.maybeApplyAutoDayDock(db, {
    workerId: "W1", date: "2026-06-03", shortfallHours: 4.2, note: "x",
  });
  assert.equal(r.applied, false);
  assert.equal(r.reason, "manual-exists");
  assert.equal(db.__docks.get("W1|2026-06-03").hours, 1);
});

test("a finalised month is never touched", async () => {
  const db = mockDb({ locked: true });
  const r = await dock.maybeApplyAutoDayDock(db, {
    workerId: "W1", date: "2026-05-03", shortfallHours: 4.2, note: "x",
  });
  assert.equal(r.applied, false);
  assert.equal(r.reason, "period-locked");
});

test("below-noise shortfall clears a stale AUTO dock and writes nothing", async () => {
  const db = mockDb();
  db.__docks.set("W1|2026-06-03", { id: "phd-a", workerId: "W1", date: "2026-06-03", hours: 2, source: "AUTO" });
  const r = await dock.maybeApplyAutoDayDock(db, {
    workerId: "W1", date: "2026-06-03", shortfallHours: 0, note: "Auto: full day",
  });
  assert.equal(r.applied, false);
  assert.equal(r.reason, "no-shortfall");
  assert.equal(db.__docks.has("W1|2026-06-03"), false);
});

// ── The unified per-day batch the POST /settle-period route runs ────────────
// For each working day, dock = max(punch shortfall, under-logged shortfall).
// Nothing recorded (no punch, 0 logged) = absence → skipped.
async function settleMonth(db, rows) {
  const tally = { applied: 0, "no-shortfall": 0, "period-locked": 0, "manual-exists": 0, "punch-source": 0, "logged-source": 0 };
  let dockedHours = 0;
  for (const row of rows) {
    const punchShort = row.clockIn && row.clockOut
      ? dock.computePunchShortfallHours(row.clockIn, row.clockOut).shortfallHours
      : 0;
    const loggedShort = (row.logged ?? 0) > 0
      ? dock.computeUnderLoggedShortfallHours(row.logged, row.expected ?? 9)
      : 0;
    const hasPunch = !!(row.clockIn && row.clockOut);
    const hasLogged = (row.logged ?? 0) > 0;
    if (!hasPunch && !hasLogged) continue; // absence — skip
    const shortfall = Math.max(punchShort, loggedShort);
    const source = punchShort >= loggedShort ? "from punch" : "from unlogged hours";
    const r = await dock.maybeApplyAutoDayDock(db, {
      workerId: row.workerId, date: row.date, shortfallHours: shortfall,
      note: shortfall > 0 ? `Auto: short ${shortfall}h (${source})` : "Auto: full day",
    });
    tally[r.reason] = (tally[r.reason] ?? 0) + 1;
    if (r.applied) {
      dockedHours += r.hours ?? 0;
      tally[source === "from punch" ? "punch-source" : "logged-source"] += 1;
    }
  }
  return { ...tally, dockedHours: Math.round(dockedHours * 100) / 100 };
}

test("a mixed month settles: full days dock nothing; short PUNCH or under-LOG docks", async () => {
  const db = mockDb();
  const rows = [
    { workerId: "W1", date: "2026-06-01", clockIn: "08:00", clockOut: "18:00", logged: 9, expected: 9 }, // full → 0
    // 08:24 = 24 real minutes late (0.4h). 08:12 used to sit past the old
    // 10-min grace and ceil to 0.25h; with the 15-min grace it is on-time, so
    // the case needs a punch that is genuinely late to still exercise the
    // punch-vs-logged tie-break.
    { workerId: "W1", date: "2026-06-02", clockIn: "08:24", clockOut: "18:00", logged: 8.6, expected: 9 }, // punch 0.4, log 0.4 → 0.4
    { workerId: "W1", date: "2026-06-03", clockIn: null, clockOut: null, logged: 7, expected: 9 }, // no punch, under-log 2 → 2 (logged-source)
    { workerId: "W1", date: "2026-06-04", clockIn: null, clockOut: null, logged: 0, expected: 9 }, // absence → skip
    { workerId: "W1", date: "2026-06-05", clockIn: "08:00", clockOut: "16:00", logged: 6, expected: 9 }, // punch 2.0, log 3.0 → 3 (logged wins)
  ];
  const res = await settleMonth(db, rows);
  assert.equal(res.applied, 3);            // 0.25 + 2 + 3
  assert.equal(res["no-shortfall"], 1);    // the full day
  assert.equal(res.dockedHours, 5.4);      // 0.4 + 2 + 3
  assert.equal(res["punch-source"], 1);    // 06-02 (0.4, tie → punch)
  assert.equal(res["logged-source"], 2);   // 06-03 (2) + 06-05 (3, logged 6/9 beats punch 2)
  assert.equal(db.__docks.has("W1|2026-06-04"), false); // absence never docked
  assert.equal(db.__docks.get("W1|2026-06-03").hours, 2);
  assert.equal(db.__docks.get("W1|2026-06-05").hours, 3);
});

test("ZAW-LIN style under-logged day auto-docks (no punch, logged < expected)", async () => {
  const db = mockDb();
  const res = await settleMonth(db, [
    { workerId: "ZAW", date: "2026-06-10", clockIn: null, clockOut: null, logged: 4.7, expected: 9 },
  ]);
  assert.equal(res.applied, 1);
  assert.equal(res["logged-source"], 1);
  assert.equal(res.dockedHours, 4.3); // 9 − 4.7
  assert.equal(db.__docks.get("ZAW|2026-06-10").hours, 4.3);
});

test("re-running the month settle is idempotent", async () => {
  const db = mockDb();
  const rows = [
    { workerId: "W1", date: "2026-06-02", clockIn: "08:12", clockOut: "18:00", logged: 8.75, expected: 9 },
    { workerId: "W1", date: "2026-06-03", clockIn: null, clockOut: null, logged: 7, expected: 9 },
  ];
  const first = await settleMonth(db, rows);
  const second = await settleMonth(db, rows);
  assert.deepEqual(first, second);
  assert.equal(db.__docks.size, 2);
});

test("a MANUAL Keep-pay/Deduct pick survives the month settle", async () => {
  const db = mockDb();
  db.__docks.set("W1|2026-06-03", { id: "phd-m", workerId: "W1", date: "2026-06-03", hours: 0.5, source: "MANUAL" });
  const res = await settleMonth(db, [
    { workerId: "W1", date: "2026-06-03", clockIn: null, clockOut: null, logged: 5, expected: 9 }, // would be 4h AUTO
  ]);
  assert.equal(res["manual-exists"], 1);
  assert.equal(res.applied, 0);
  assert.equal(db.__docks.get("W1|2026-06-03").hours, 0.5);
  assert.equal(db.__docks.get("W1|2026-06-03").source, "MANUAL");
});

test("an approved month is untouched — every day skips (period-locked)", async () => {
  const db = mockDb({ locked: true });
  const res = await settleMonth(db, [
    { workerId: "W1", date: "2026-05-02", clockIn: null, clockOut: null, logged: 5, expected: 9 },
    { workerId: "W2", date: "2026-05-02", clockIn: "08:00", clockOut: "17:00", logged: 8, expected: 9 },
  ]);
  assert.equal(res["period-locked"], 2);
  assert.equal(res.applied, 0);
  assert.equal(db.__docks.size, 0);
});

test("a corrected under-log (now full) clears its stale AUTO dock on re-settle", async () => {
  const db = mockDb();
  await settleMonth(db, [{ workerId: "W1", date: "2026-06-03", logged: 7, expected: 9 }]);
  assert.equal(db.__docks.get("W1|2026-06-03").hours, 2);
  const res = await settleMonth(db, [{ workerId: "W1", date: "2026-06-03", logged: 9, expected: 9 }]);
  assert.equal(res["no-shortfall"], 1);
  assert.equal(db.__docks.has("W1|2026-06-03"), false);
});
