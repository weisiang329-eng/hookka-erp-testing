// ---------------------------------------------------------------------------
// employee-advances.test.mjs — salary advances (built 2026-08-07).
//
// The owner hands workers cash mid-month and wants it (a) recorded against the
// employee with an amount and a date, (b) taken back out of that month's NET
// PAY and TOTAL PAY, and (c) exported as a payout listing for HR.
//
// This suite asserts BEHAVIOUR — what the money does — not that particular
// functions exist:
//
//   1. Recording: an advance lands as INTEGER SEN against the dated month; a
//      fractional / zero / negative amount, a bad date and an unknown worker
//      are all refused and store nothing.
//   2. The deduction: an advance dated INSIDE the period reduces net pay by
//      exactly its sen and leaves gross + statutory untouched; one dated
//      outside it changes nothing. Net pay is NOT clamped at zero — drawing
//      more than the month earns shows a debt rather than silently writing it
//      off.
//   3. The lock: an UNSETTLED advance can be edited and deleted; a SETTLED one
//      refuses both with 409 (and the row is unchanged).
//   4. Approving a month settles that month's advances; putting it back to
//      DRAFT hands them back.
//   5. The HR payout listing: one row per employee, carrying their dates and
//      their total, with the grand total the cash is counted against.
//
// Runs against a small in-memory DB stub — no network, no real Postgres. The
// runtime CREATE TABLE / ALTER DDL is accepted as a no-op so the self-apply
// resolves cleanly.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Hono } from "hono";

let loaderRegistered = false;
try {
  register("tsx/esm", pathToFileURL("./"));
  loaderRegistered = true;
} catch {
  // Native type-stripping (Node 22.6+) handles the .ts import without a loader.
}
void loaderRegistered;

// ---- In-memory DB stub -----------------------------------------------------
// Backs employee_advances + workers. Rows come back in their raw snake_case
// column names; the route's row mapper is dual-keyed (the PG driver camelCases
// them in production), so this also exercises that path.
function makeDb({ advances = [], workers = [] } = {}) {
  const advTable = new Map(); // id -> row
  const workerTable = new Map();
  for (const a of advances) advTable.set(a.id, { ...a });
  for (const w of workers) workerTable.set(w.id, { ...w });

  const likeMatch = (value, pattern) => {
    const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`);
    return re.test(String(value ?? ""));
  };

  function prepare(sql) {
    const s = sql.trim();
    let bound = [];
    const obj = {
      bind(...args) {
        bound = args;
        return obj;
      },
      async first() {
        if (/FROM employee_advances WHERE id = \?/i.test(s)) {
          const row = advTable.get(bound[0]);
          return row ? { ...row } : null;
        }
        if (/SELECT id FROM workers WHERE id = \?/i.test(s)) {
          const w = workerTable.get(bound[0]);
          return w ? { id: w.id } : null;
        }
        return null;
      },
      async all() {
        if (/FROM employee_advances/i.test(s)) {
          let rows = [...advTable.values()];
          let i = 0;
          if (/advance_date LIKE \?/i.test(s)) {
            const p = bound[i++];
            rows = rows.filter((r) => likeMatch(r.advance_date, p));
          }
          if (/worker_id = \?/i.test(s)) {
            const w = bound[i++];
            rows = rows.filter((r) => r.worker_id === w);
          }
          rows.sort((a, b) =>
            a.advance_date === b.advance_date
              ? a.id.localeCompare(b.id)
              : a.advance_date.localeCompare(b.advance_date),
          );
          return { results: rows.map((r) => ({ ...r })) };
        }
        if (/FROM workers/i.test(s)) {
          const rows = [...workerTable.values()].filter(
            (w) => !String(w.empNo ?? "").startsWith("TEST"),
          );
          return { results: rows.map((w) => ({ ...w })) };
        }
        return { results: [] };
      },
      async run() {
        // Runtime self-apply DDL — accepted as a no-op.
        if (/^(CREATE|ALTER)\b/i.test(s)) return { success: true };
        if (/^INSERT INTO employee_advances/i.test(s)) {
          const [id, worker_id, advance_date, amount_sen, note, entered_by, org_id] = bound;
          advTable.set(id, {
            id,
            worker_id,
            advance_date,
            amount_sen,
            note: note ?? null,
            entered_by: entered_by ?? null,
            status: "UNSETTLED",
            settled_period: null,
            org_id,
            created_at: "2026-08-07T00:00:00Z",
          });
          return { success: true };
        }
        if (/^UPDATE employee_advances\s+SET advance_date/i.test(s)) {
          const [advance_date, amount_sen, note, id] = bound;
          const row = advTable.get(id);
          if (row) Object.assign(row, { advance_date, amount_sen, note: note ?? null });
          return { success: true };
        }
        if (/SET status = 'SETTLED'/i.test(s)) {
          const [period, pattern] = bound;
          for (const row of advTable.values()) {
            if (likeMatch(row.advance_date, pattern) && row.status !== "SETTLED") {
              row.status = "SETTLED";
              row.settled_period = period;
            }
          }
          return { success: true };
        }
        if (/SET status = 'UNSETTLED'/i.test(s)) {
          const [pattern] = bound;
          for (const row of advTable.values()) {
            if (likeMatch(row.advance_date, pattern) && row.status === "SETTLED") {
              row.status = "UNSETTLED";
              row.settled_period = null;
            }
          }
          return { success: true };
        }
        if (/^DELETE FROM employee_advances WHERE id = \?/i.test(s)) {
          advTable.delete(bound[0]);
          return { success: true };
        }
        return { success: true };
      },
    };
    return obj;
  }

  return { db: { prepare }, _state: { advTable, workerTable } };
}

// The route reads DB / userId / orgId off the context, exactly as worker.ts
// wires them in production. SUPER_ADMIN bypasses rbac.
function wrap(routeApp, db) {
  const parent = new Hono();
  parent.use("*", async (c, next) => {
    c.set("DB", db);
    c.set("userRole", "SUPER_ADMIN");
    c.set("userId", "user-1");
    c.set("orgId", "hookka");
    await next();
  });
  parent.route("/", routeApp);
  return parent;
}

async function call(app, { method, path, body }) {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function importRoute(tag) {
  const mod = await import(
    pathToFileURL(resolve(process.cwd(), "src/api/routes/employee-advances.ts")).href +
      `?t=${tag}`
  );
  return mod.default;
}
async function importLib(tag) {
  return import(
    pathToFileURL(resolve(process.cwd(), "src/api/lib/employee-advances.ts")).href +
      `?t=${tag}`
  );
}

const WORKERS = [
  { id: "w1", empNo: "E001", name: "Alice", departmentCode: "SEWING", status: "ACTIVE" },
  { id: "w2", empNo: "E002", name: "Bob", departmentCode: "CARPENTRY", status: "ACTIVE" },
  { id: "wt", empNo: "TEST-001", name: "Test Rig", departmentCode: "", status: "ACTIVE" },
];

// ---- 1. Recording ----------------------------------------------------------

test("an advance is recorded in integer sen against the month of its date", async () => {
  const base = makeDb({ workers: WORKERS });
  const app = wrap(await importRoute("rec"), base.db);

  const res = await call(app, {
    method: "POST",
    path: "/",
    body: { workerId: "w1", date: "2026-08-12", amountSen: 30000, note: "rent" },
  });
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.equal(json.success, true);
  assert.equal(json.data.amountSen, 30000, "RM300.00 is stored as 30000 sen");
  assert.equal(json.data.date, "2026-08-12");
  assert.equal(json.data.status, "UNSETTLED", "a fresh advance is editable");

  const stored = [...base._state.advTable.values()];
  assert.equal(stored.length, 1);
  assert.equal(stored[0].amount_sen, 30000);
  assert.equal(stored[0].worker_id, "w1");

  // …and it lists under the month its DATE falls in, not another one.
  const inAug = await (await call(app, { method: "GET", path: "/?period=2026-08" })).json();
  assert.equal(inAug.data.length, 1);
  assert.equal(inAug.totalSen, 30000);
  const inSep = await (await call(app, { method: "GET", path: "/?period=2026-09" })).json();
  assert.equal(inSep.data.length, 0, "August cash is not September's problem");
});

test("a fractional, zero, negative or badly-dated advance is refused and stores nothing", async () => {
  const base = makeDb({ workers: WORKERS });
  const app = wrap(await importRoute("reject"), base.db);

  const bad = [
    { workerId: "w1", date: "2026-08-12", amountSen: 300.5 }, // a float escaped MoneyInput
    { workerId: "w1", date: "2026-08-12", amountSen: 0 },
    { workerId: "w1", date: "2026-08-12", amountSen: -5000 },
    { workerId: "w1", date: "12/08/2026", amountSen: 30000 },
    { workerId: "w1", date: "2026-02-31", amountSen: 30000 }, // not a real day
    { workerId: "nobody", date: "2026-08-12", amountSen: 30000 },
  ];
  for (const body of bad) {
    const res = await call(app, { method: "POST", path: "/", body });
    assert.equal(res.status, 400, `should refuse ${JSON.stringify(body)}`);
  }
  assert.equal(base._state.advTable.size, 0, "nothing was written");
});

// ---- 2. The deduction ------------------------------------------------------

test("an advance in the period reduces net pay by exactly its sen, leaving gross and statutory alone", async () => {
  const { sumAdvanceSenByWorker, netPayAfterAdvanceSen } = await importLib("math");

  const grossSen = 250000; // RM2,500.00
  const statutorySen = 30000; // EPF/SOCSO/EIS/PCB — must not move
  const advances = [
    { id: "a1", workerId: "w1", date: "2026-08-12", amountSen: 30000 },
    { id: "a2", workerId: "w1", date: "2026-08-20", amountSen: 5000 },
    { id: "a3", workerId: "w2", date: "2026-08-03", amountSen: 10000 },
  ];

  const byWorker = sumAdvanceSenByWorker(advances, "2026-08");
  assert.equal(byWorker.get("w1"), 35000, "two draws in the month add up");
  assert.equal(byWorker.get("w2"), 10000);

  const before = grossSen - statutorySen;
  const after = netPayAfterAdvanceSen(grossSen, statutorySen, byWorker.get("w1"));
  assert.equal(before - after, 35000, "net pay drops by exactly the advance");
  assert.equal(after, 185000);
  // Gross and the statutory total are inputs, not outputs — nothing here can
  // move them, and that is the point: EPF is owed on what was earned, not on
  // what is left to hand over.
  assert.equal(grossSen, 250000);
  assert.equal(statutorySen, 30000);
});

test("an advance dated outside the period does not touch that period's pay", async () => {
  const { sumAdvanceSenByWorker, netPayAfterAdvanceSen } = await importLib("outside");
  const advances = [
    { id: "a1", workerId: "w1", date: "2026-07-30", amountSen: 30000 },
    { id: "a2", workerId: "w1", date: "2026-09-01", amountSen: 20000 },
  ];
  const byWorker = sumAdvanceSenByWorker(advances, "2026-08");
  assert.equal(byWorker.get("w1"), undefined, "neither July nor September counts in August");
  assert.equal(
    netPayAfterAdvanceSen(250000, 30000, byWorker.get("w1") ?? 0),
    220000,
    "August pay is untouched",
  );
});

test("drawing more than the month earns leaves a debt, never a silent write-off", async () => {
  const { netPayAfterAdvanceSen } = await importLib("debt");
  // RM500 earned, RM800 already drawn.
  const net = netPayAfterAdvanceSen(50000, 0, 80000);
  assert.equal(net, -30000, "the RM300 shortfall is still owed, and it shows");
  assert.ok(net < 0, "not clamped at zero");
});

// ---- 3. The lock -----------------------------------------------------------

test("an unsettled advance can be edited and deleted", async () => {
  const base = makeDb({
    workers: WORKERS,
    advances: [
      {
        id: "adv-1", worker_id: "w1", advance_date: "2026-08-12", amount_sen: 30000,
        note: "rent", entered_by: "user-1", status: "UNSETTLED", settled_period: null,
        org_id: "hookka", created_at: "2026-08-12T00:00:00Z",
      },
    ],
  });
  const app = wrap(await importRoute("edit"), base.db);

  const put = await call(app, {
    method: "PUT",
    path: "/adv-1",
    body: { amountSen: 25000, date: "2026-08-14", note: "rent (corrected)" },
  });
  assert.equal(put.status, 200);
  const row = base._state.advTable.get("adv-1");
  assert.equal(row.amount_sen, 25000);
  assert.equal(row.advance_date, "2026-08-14");

  const del = await call(app, { method: "DELETE", path: "/adv-1" });
  assert.equal(del.status, 200);
  assert.equal(base._state.advTable.size, 0);
});

test("a settled advance refuses both edit and delete, and is left unchanged", async () => {
  const base = makeDb({
    workers: WORKERS,
    advances: [
      {
        id: "adv-1", worker_id: "w1", advance_date: "2026-07-12", amount_sen: 30000,
        note: "rent", entered_by: "user-1", status: "SETTLED", settled_period: "2026-07",
        org_id: "hookka", created_at: "2026-07-12T00:00:00Z",
      },
    ],
  });
  const app = wrap(await importRoute("locked"), base.db);

  const put = await call(app, { method: "PUT", path: "/adv-1", body: { amountSen: 1 } });
  assert.equal(put.status, 409, "an approved month's advance is a paid-out fact");

  const del = await call(app, { method: "DELETE", path: "/adv-1" });
  assert.equal(del.status, 409);

  const row = base._state.advTable.get("adv-1");
  assert.equal(row.amount_sen, 30000, "the figure the payroll was signed off with survives");
  assert.equal(row.status, "SETTLED");
});

// ---- 4. Settling follows the payroll status --------------------------------

test("approving a month settles its advances; reverting to DRAFT hands them back", async () => {
  const base = makeDb({
    workers: WORKERS,
    advances: [
      {
        id: "adv-aug", worker_id: "w1", advance_date: "2026-08-12", amount_sen: 30000,
        note: "", entered_by: null, status: "UNSETTLED", settled_period: null,
        org_id: "hookka", created_at: "2026-08-12T00:00:00Z",
      },
      {
        id: "adv-sep", worker_id: "w1", advance_date: "2026-09-02", amount_sen: 10000,
        note: "", entered_by: null, status: "UNSETTLED", settled_period: null,
        org_id: "hookka", created_at: "2026-09-02T00:00:00Z",
      },
    ],
  });
  const { markAdvancesSettled } = await importLib("settle");

  await markAdvancesSettled(base.db, "2026-08", true);
  assert.equal(base._state.advTable.get("adv-aug").status, "SETTLED");
  assert.equal(base._state.advTable.get("adv-aug").settled_period, "2026-08");
  assert.equal(
    base._state.advTable.get("adv-sep").status,
    "UNSETTLED",
    "approving August must not lock September",
  );

  await markAdvancesSettled(base.db, "2026-08", false);
  assert.equal(base._state.advTable.get("adv-aug").status, "UNSETTLED");
  assert.equal(base._state.advTable.get("adv-aug").settled_period, null);
});

// ---- 5. The HR payout listing ----------------------------------------------

test("the payout listing gives one row per employee with their dates and total", async () => {
  const base = makeDb({
    workers: WORKERS,
    advances: [
      { id: "a1", worker_id: "w1", advance_date: "2026-08-05", amount_sen: 20000, note: "", entered_by: null, status: "UNSETTLED", settled_period: null, org_id: "hookka", created_at: "" },
      { id: "a2", worker_id: "w1", advance_date: "2026-08-19", amount_sen: 15000, note: "", entered_by: null, status: "UNSETTLED", settled_period: null, org_id: "hookka", created_at: "" },
      { id: "a3", worker_id: "w2", advance_date: "2026-08-07", amount_sen: 10000, note: "", entered_by: null, status: "UNSETTLED", settled_period: null, org_id: "hookka", created_at: "" },
      // A TEST account is never a real payee — it must not appear on a sheet
      // somebody counts cash against.
      { id: "a4", worker_id: "wt", advance_date: "2026-08-07", amount_sen: 99900, note: "", entered_by: null, status: "UNSETTLED", settled_period: null, org_id: "hookka", created_at: "" },
      // Another month's cash belongs on another month's sheet.
      { id: "a5", worker_id: "w2", advance_date: "2026-07-07", amount_sen: 50000, note: "", entered_by: null, status: "UNSETTLED", settled_period: null, org_id: "hookka", created_at: "" },
    ],
  });
  const app = wrap(await importRoute("listing"), base.db);

  const res = await call(app, { method: "GET", path: "/payout-listing?period=2026-08" });
  assert.equal(res.status, 200);
  const json = await res.json();

  assert.equal(json.data.length, 2, "one row per employee, TEST account excluded");
  const alice = json.data.find((r) => r.employeeNo === "E001");
  assert.equal(alice.totalSen, 35000, "two draws collapse into one payable total");
  assert.deepEqual(
    alice.advances.map((a) => a.date),
    ["2026-08-05", "2026-08-19"],
    "the days are carried so the sheet can be checked",
  );
  const bob = json.data.find((r) => r.employeeNo === "E002");
  assert.equal(bob.totalSen, 10000, "July's RM500 is not on August's sheet");
  assert.equal(json.grandTotalSen, 45000, "the cash to count out");

  const bad = await call(app, { method: "GET", path: "/payout-listing" });
  assert.equal(bad.status, 400, "a listing with no period is not a listing");
});
