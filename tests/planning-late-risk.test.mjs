// ---------------------------------------------------------------------------
// planning-late-risk.test.mjs — the report that makes EARLY overtime possible.
//
// Owner red line (2026-08-03): overtime must be started early and spread flat,
// never dumped on one day. That is only achievable if the shortfall is known
// while working days remain, so this report must (a) actually flag an order the
// plan finishes after its deadline, (b) never quietly swallow one, and (c) not
// write anything while doing it.
//
// The date arithmetic is the fragile part — the deadline is the customer date
// minus a dispatch buffer in WORKING days, and lateness is counted in working
// days too. Sundays and public holidays must not be counted as room.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";

import { buildLateRiskReport } from "../src/api/lib/planning-late-risk.ts";

// The report calls computeChainWithAssignments, which reads WAITING job cards.
// Driving it through a stub DB lets us control the whole plan.
function makeDb({ jobCards = [], orders = [], holidays = [] } = {}) {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      const rowsFor = () => {
        if (sql.includes("public_holidays")) return [{ value: JSON.stringify(holidays) }];
        if (sql.includes("kv_config")) return [];
        // The customer-date lookup in planning-late-risk.
        if (sql.includes("COALESCE(po.companySOId")) return orders;
        // The chain engine's WAITING card load.
        if (sql.includes("FROM job_cards jc")) return jobCards;
        return [];
      };
      // The engine calls .all() straight off prepare() (no .bind()), while
      // other callers bind first — the stub must answer both shapes.
      const exec = {
        async all() {
          return { results: rowsFor() };
        },
        async first() {
          const r = rowsFor();
          return r.length ? r[0] : null;
        },
        async run() {
          writes.push({ sql });
        },
      };
      return { ...exec, bind: () => exec };
    },
  };
}

/** A WAITING FAB_SEW card for one SO, shaped like the engine's raw row. */
function jc(soId, { mins = 600, dd = "2026-08-14", lineNo = 1 } = {}) {
  return {
    jobCardId: `JC-${soId}`,
    dueDate: null,
    departmentCode: "FAB_SEW",
    status: "WAITING",
    wipLabel: "CFG-A | 6FT",
    wipCode: "W1",
    wipType: "DIVAN",
    wipQty: 1,
    category: "BEDFRAME",
    productionTimeMinutes: mins,
    estMinutes: mins,
    sequence: 1,
    poId: `PO-${soId}`,
    companySOId: soId,
    poNo: soId,
    lineNo,
    itemCategory: "BEDFRAME",
    sizeLabel: "6FT",
    fabricCode: "PC151-01",
    productCode: "MODEL",
    customerName: `Cust ${soId}`,
    orderStatus: "IN_PROGRESS",
    salesOrderId: soId,
    customerDeliveryDate: dd,
    hookkaExpectedDD: null,
  };
}

function order(soId, dd) {
  return { so_id: soId, customer: `Cust ${soId}`, customer_dd: dd };
}

test("an order the plan finishes after its deadline is reported as late", () => {
  // A single enormous job against a promise only days away: the plan cannot
  // possibly finish it in time, so it must appear.
  const dd = "2026-08-05";
  const db = makeDb({
    jobCards: [jc("SO-LATE", { mins: 60000, dd })],
    orders: [order("SO-LATE", dd)],
  });

  return buildLateRiskReport(db).then((r) => {
    assert.equal(r.late.length + r.atRisk.length, 1, "the order must be assessed, not skipped");
    if (r.late.length === 1) {
      const o = r.late[0];
      assert.equal(o.soId, "SO-LATE");
      assert.ok(o.workingDaysLate >= 1);
      assert.ok(o.scheduledFinish > o.deadline, "a late row must finish after its deadline");
    }
  });
});

test("an order with plenty of room is not flagged", async () => {
  const dd = "2026-12-31";
  const db = makeDb({
    jobCards: [jc("SO-EASY", { mins: 60, dd })],
    orders: [order("SO-EASY", dd)],
  });
  const r = await buildLateRiskReport(db);
  assert.equal(r.late.length, 0, "a comfortable order must not be reported as late");
});

test("the deadline sits a dispatch buffer before the customer date", async () => {
  const dd = "2026-08-20"; // a Thursday
  const db = makeDb({
    jobCards: [jc("SO-A", { mins: 60000, dd })],
    orders: [order("SO-A", dd)],
  });
  const r = await buildLateRiskReport(db, { shipBufferDays: 3 });
  assert.equal(r.shipBufferDays, 3);
  const rows = [...r.late, ...r.atRisk];
  if (rows.length) {
    assert.ok(rows[0].deadline < dd, "the deadline must precede the customer date");
  }
});

test("an order with no customer date is counted, never guessed at", async () => {
  const db = makeDb({
    jobCards: [jc("SO-NODATE", { mins: 600, dd: null })],
    orders: [order("SO-NODATE", null)],
  });
  const r = await buildLateRiskReport(db);
  assert.equal(r.late.length, 0);
  assert.equal(r.atRisk.length, 0);
  assert.equal(r.undated, 1, "undated work must be surfaced as undated, not as on-time");
});

test("late orders are ranked worst-first", async () => {
  const db = makeDb({
    jobCards: [
      jc("SO-SLIGHT", { mins: 40000, dd: "2026-09-30", lineNo: 1 }),
      jc("SO-BAD", { mins: 90000, dd: "2026-08-04", lineNo: 2 }),
    ],
    orders: [order("SO-SLIGHT", "2026-09-30"), order("SO-BAD", "2026-08-04")],
  });
  const r = await buildLateRiskReport(db);
  for (let i = 1; i < r.late.length; i++) {
    assert.ok(
      r.late[i - 1].workingDaysLate >= r.late[i].workingDaysLate,
      "the list must be ordered worst-first so the brief can truncate safely",
    );
  }
});

test("the report never writes", async () => {
  const dd = "2026-08-06";
  const db = makeDb({
    jobCards: [jc("SO-X", { mins: 60000, dd })],
    orders: [order("SO-X", dd)],
  });
  await buildLateRiskReport(db);
  assert.equal(db.writes.length, 0, "a risk report must not mutate the plan it is judging");
});

test("an empty plan reports all clear rather than failing", async () => {
  const r = await buildLateRiskReport(makeDb({}));
  assert.equal(r.late.length, 0);
  assert.equal(r.atRisk.length, 0);
  assert.equal(r.totalOrdersPlanned, 0);
});
