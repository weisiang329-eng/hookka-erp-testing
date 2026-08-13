// ---------------------------------------------------------------------------
// production-report-summary.test.mjs — the Reports › Production aggregate,
// run as SQL against a REAL engine.
//
// BUG-2026-08-13-005. The tab used to download every production order with
// every job card (30,012 ms on prod, killed by the 30 s global abort) and add
// it up in the browser. The arithmetic now lives in
// `GET /api/production-orders/report-summary?from=&to=`, so it needs the same
// standard of proof the client loop never had: the route's OWN SQL executed
// against node:sqlite through a D1-shaped shim, asserting numbers rather than
// source shape.
//
// The properties under test, in the order they burned somebody:
//   * the window is honoured on BOTH sides — an order outside it contributes
//     nothing, to any of the four sections;
//   * a completed card with NO recorded duration is counted in `completedCards`
//     and `stdMinutes` but enters NEITHER side of the measured ratio (that
//     fallback is what pinned every department at ~100%, BUG-2026-08-13-004);
//   * a card whose recording EQUALS its estimate is measured but not
//     `distinct` — on prod all 4,289 populated values are exactly that, so a
//     ratio over them is 100% by construction and must not be published;
//   * a genuinely different recording IS distinct, and the ratio it produces
//     is not 100%;
//   * `from`/`to` are mandatory — the endpoint must never be able to become
//     the unbounded scan it replaced.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";

// node:sqlite is Node 22+; the deploy workflow pins 20. Skip cleanly rather
// than failing the build (same rationale as tests/notifications-scope.test.mjs).
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  /* older Node — every case below skips */
}
const needsSqlite = DatabaseSync
  ? {}
  : { skip: "node:sqlite requires Node 22+ (this runtime is older)" };

const { default: productionOrders } = await import(
  "../src/api/routes/production-orders.ts"
);

// snake_case → camelCase, mirroring db-pg.ts's `transform.column.from`. The
// SQL aliases are snake_case on purpose (an unquoted mixed-case alias folds to
// lower case in Postgres — tests/sql-identifier-safety.test.mjs); this is the
// rewrite that turns them back.
const toCamel = (s) => s.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());

const TODAY = new Date().toISOString().slice(0, 10);
const daysAgo = (n) =>
  new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

function makeDb(orders, cards) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE production_orders (
    id TEXT PRIMARY KEY,
    poNo TEXT,
    productName TEXT,
    status TEXT NOT NULL,
    currentDepartment TEXT,
    startDate TEXT,
    completedDate TEXT,
    targetEndDate TEXT,
    orgId TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE job_cards (
    id TEXT PRIMARY KEY,
    productionOrderId TEXT NOT NULL,
    departmentCode TEXT,
    departmentName TEXT,
    status TEXT,
    estMinutes INTEGER,
    actualMinutes INTEGER
  )`);
  const insO = db.prepare(
    `INSERT INTO production_orders
       (id, poNo, productName, status, currentDepartment, startDate,
        completedDate, targetEndDate, orgId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const o of orders) {
    insO.run(
      o.id,
      o.poNo ?? o.id,
      o.productName ?? "SOFA",
      o.status,
      o.currentDepartment ?? "FAB_CUT",
      o.startDate ?? null,
      o.completedDate ?? null,
      o.targetEndDate ?? null,
      o.orgId ?? "hookka",
    );
  }
  const insC = db.prepare(
    `INSERT INTO job_cards
       (id, productionOrderId, departmentCode, departmentName, status,
        estMinutes, actualMinutes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const c of cards) {
    insC.run(
      c.id,
      c.productionOrderId,
      c.departmentCode,
      c.departmentName ?? c.departmentCode,
      c.status ?? "COMPLETED",
      c.estMinutes ?? null,
      c.actualMinutes ?? null,
    );
  }

  return {
    prepare(sql) {
      let bound = [];
      const api = {
        bind(...args) {
          bound = args;
          return api;
        },
        async all() {
          const raw = db.prepare(sql).all(...bound);
          return {
            results: raw.map((row) =>
              Object.fromEntries(
                Object.entries(row).map(([k, v]) => [toCamel(k), v]),
              ),
            ),
            success: true,
          };
        },
        async first() {
          const raw = db.prepare(sql).get(...bound);
          if (!raw) return null;
          return Object.fromEntries(
            Object.entries(raw).map(([k, v]) => [toCamel(k), v]),
          );
        },
        async run() {
          const info = db.prepare(sql).run(...bound);
          return { success: true, meta: { changes: Number(info.changes) } };
        },
      };
      return api;
    },
  };
}

function mount(shim) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("DB", shim);
    c.set("orgId", "hookka");
    c.set("userId", "u1");
    c.set("userRole", "ADMIN");
    await next();
  });
  app.route("/api/production-orders", productionOrders);
  return app;
}

async function summary(orders, cards, from, to) {
  const res = await mount(makeDb(orders, cards)).request(
    `/api/production-orders/report-summary?from=${from}&to=${to}`,
  );
  return { status: res.status, body: await res.json() };
}

// One order inside the window and one outside it, so every assertion below
// also proves the window is doing something.
const ORDERS = [
  {
    id: "po-in-done",
    poNo: "SO-2606-001-01",
    status: "COMPLETED",
    startDate: "2026-06-20",
    completedDate: "2026-06-30",
    targetEndDate: "2026-06-25",
  },
  {
    id: "po-in-late",
    poNo: "SO-2606-002-01",
    productName: "DIVAN ONLY",
    status: "IN_PROGRESS",
    currentDepartment: "UPHOLSTERY",
    startDate: "2026-06-21",
    targetEndDate: daysAgo(3),
  },
  {
    id: "po-in-cancelled",
    status: "CANCELLED",
    startDate: "2026-06-22",
    targetEndDate: "2026-06-01",
  },
  {
    // Outside the window on the LATE side — must contribute nothing.
    id: "po-out",
    poNo: "SO-2607-999-01",
    status: "COMPLETED",
    startDate: "2026-07-30",
    completedDate: "2026-07-31",
    targetEndDate: "2026-07-01",
  },
];

const CARDS = [
  // FAB_CUT: three completed cards — one unmeasured, one measured-but-copied,
  // one genuinely measured.
  {
    id: "jc-1",
    productionOrderId: "po-in-done",
    departmentCode: "FAB_CUT",
    departmentName: "Fabric Cutting",
    estMinutes: 100,
    actualMinutes: null,
  },
  {
    id: "jc-2",
    productionOrderId: "po-in-done",
    departmentCode: "FAB_CUT",
    departmentName: "Fabric Cutting",
    estMinutes: 60,
    actualMinutes: 60, // the prod shape: a COPY of the estimate
  },
  {
    id: "jc-3",
    productionOrderId: "po-in-late",
    departmentCode: "FAB_CUT",
    departmentName: "Fabric Cutting",
    estMinutes: 40,
    actualMinutes: 80, // a real measurement: took twice as long
  },
  // WEBBING: one completed card that recorded nothing, and one still running.
  {
    id: "jc-4",
    productionOrderId: "po-in-done",
    departmentCode: "WEBBING",
    departmentName: "Webbing",
    estMinutes: 25,
    actualMinutes: 0, // explicit zero is NOT a measurement
  },
  {
    id: "jc-5",
    productionOrderId: "po-in-late",
    departmentCode: "WEBBING",
    departmentName: "Webbing",
    status: "IN_PROGRESS",
    estMinutes: 999,
    actualMinutes: 999,
  },
  // Out-of-window order's card — must not appear anywhere.
  {
    id: "jc-out",
    productionOrderId: "po-out",
    departmentCode: "PACKING",
    departmentName: "Packing",
    estMinutes: 500,
    actualMinutes: 250,
  },
];

const dept = (body, code) =>
  body.departments.find((d) => d.departmentCode === code);

test("totals count only orders whose startDate falls inside the window", needsSqlite, async () => {
  const { status, body } = await summary(
    ORDERS,
    CARDS,
    "2026-06-14",
    "2026-06-30",
  );
  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.totals.totalOrders, 3, "po-out must not be counted");
  assert.equal(body.totals.completed, 1);
  assert.equal(body.totals.inProgress, 1);
  assert.equal(body.statusCounts.CANCELLED, 1);
  // 2026-06-20 → 2026-06-30 is 10 days, over exactly one completed order.
  assert.equal(body.totals.avgCompletionDays, 10);
  assert.equal(body.totals.completedWithDates, 1);
});

test("an unmeasured completed card counts as work but never enters the ratio", needsSqlite, async () => {
  const { body } = await summary(ORDERS, CARDS, "2026-06-14", "2026-06-30");
  const fc = dept(body, "FAB_CUT");
  assert.equal(fc.departmentName, "Fabric Cutting");
  assert.equal(fc.completedCards, 3, "all three completed cards are work done");
  assert.equal(fc.stdMinutes, 200, "100 + 60 + 40 standard minutes");
  // jc-1 recorded nothing: it is absent from BOTH measured subtotals. Had its
  // estimate been substituted, measuredStdMinutes would be 200 and
  // measuredActualMinutes 200 — the estimate divided by itself.
  assert.equal(fc.measuredCards, 2);
  assert.equal(fc.measuredStdMinutes, 100, "60 + 40, NOT 200");
  assert.equal(fc.measuredActualMinutes, 140, "60 + 80, NOT 200");
  assert.notEqual(
    fc.measuredStdMinutes,
    fc.measuredActualMinutes,
    "if these are equal the fallback is back and every dept reads 100%",
  );
});

test("a recording identical to the estimate is measured but NOT distinct", needsSqlite, async () => {
  const { body } = await summary(ORDERS, CARDS, "2026-06-14", "2026-06-30");
  const fc = dept(body, "FAB_CUT");
  // jc-2 (60/60) is the prod shape — all 4,289 populated values look like it.
  // jc-3 (40/80) is a genuine measurement. Only the latter is distinct.
  assert.equal(fc.measuredDistinctCards, 1);

  // With ONLY copied recordings the page must publish nothing: build a book
  // where jc-3 is a copy too, and the ratio is exactly 100% — the number the
  // whole pair of bugs exists to keep off the screen.
  const copiedOnly = CARDS.map((c) =>
    c.id === "jc-3" ? { ...c, actualMinutes: 40 } : c,
  );
  const only = await summary(ORDERS, copiedOnly, "2026-06-14", "2026-06-30");
  const fc2 = dept(only.body, "FAB_CUT");
  assert.equal(fc2.measuredCards, 2, "they are still recorded, and still shown");
  assert.equal(fc2.measuredDistinctCards, 0, "…but none of them is a measurement");
  assert.equal(
    (fc2.measuredStdMinutes / fc2.measuredActualMinutes) * 100,
    100,
    "which is why the ratio must not be published: it is 100% by construction",
  );
});

test("an explicit zero is not a measurement, and an unfinished card is not work", needsSqlite, async () => {
  const { body } = await summary(ORDERS, CARDS, "2026-06-14", "2026-06-30");
  const web = dept(body, "WEBBING");
  assert.equal(web.completedCards, 1, "the IN_PROGRESS card is not counted");
  assert.equal(web.stdMinutes, 25, "and its 999 estimate is not counted either");
  assert.equal(web.measuredCards, 0, "actualMinutes = 0 is absence, not speed");
  assert.equal(web.measuredActualMinutes, 0);
  assert.equal(web.measuredDistinctCards, 0);
  assert.equal(
    dept(body, "PACKING"),
    undefined,
    "the out-of-window order's department must not appear at all",
  );
});

test("overdue lists only live orders past their target, with real day counts", needsSqlite, async () => {
  const { body } = await summary(ORDERS, CARDS, "2026-06-14", "2026-06-30");
  const nos = body.overdue.map((o) => o.poNo);
  assert.deepEqual(nos, ["SO-2606-002-01"]);
  const row = body.overdue[0];
  assert.equal(row.productName, "DIVAN ONLY");
  assert.equal(row.currentDepartment, "UPHOLSTERY");
  assert.equal(row.daysOverdue, 3, "whole days, measured from today");
  // COMPLETED (po-in-done, target 06-25) and CANCELLED (po-in-cancelled,
  // target 06-01) are both past their target and both correctly excluded.
});

test("a target date of TODAY is not yet overdue", needsSqlite, async () => {
  const { body } = await summary(
    [
      {
        id: "po-today",
        poNo: "SO-DUE-TODAY",
        status: "IN_PROGRESS",
        startDate: "2026-06-20",
        targetEndDate: TODAY,
      },
    ],
    [],
    "2026-06-14",
    "2026-06-30",
  );
  assert.deepEqual(
    body.overdue,
    [],
    "the old client used `new Date(target) < new Date()`, which read a due-today " +
      "order as 1 day late every afternoon",
  );
});

test("the window is mandatory — this endpoint cannot become a whole-table scan", needsSqlite, async () => {
  const app = mount(makeDb(ORDERS, CARDS));
  for (const qs of [
    "",
    "?from=2026-06-14",
    "?to=2026-06-30",
    "?from=last-week&to=today",
    "?from=2026-6-1&to=2026-06-30",
  ]) {
    const res = await app.request(
      `/api/production-orders/report-summary${qs}`,
    );
    assert.equal(res.status, 400, `"${qs}" must be refused, not scanned`);
  }
});

test("an inverted range is corrected, not silently answered with nothing", needsSqlite, async () => {
  const { body } = await summary(ORDERS, CARDS, "2026-06-30", "2026-06-14");
  assert.equal(body.range.from, "2026-06-14");
  assert.equal(body.range.to, "2026-06-30");
  assert.equal(
    body.totals.totalOrders,
    3,
    "swapped bounds must not read as an empty range — that is the very " +
      "confusion this bug was about",
  );
});
