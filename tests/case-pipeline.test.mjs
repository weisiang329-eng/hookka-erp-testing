// ---------------------------------------------------------------------------
// case-pipeline.test.mjs — the pure Service Case pipeline derivation
// (src/lib/case-pipeline.ts). Pins computeCasePipeline's stage + enteredAt
// for each step along the chain, and the caseDaysOpen / caseStageDays day
// math (frozen at closedAt for closed cases).
//
// The derivation is the SINGLE source the list page (Stage / Status Days
// columns) and the detail-page stepper both consume — these tests guard it
// against drift.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

try {
  register("tsx/esm", pathToFileURL("./"));
} catch {
  /* native type-stripping on Node 22+ */
}

const lib = await import(
  pathToFileURL(resolve(process.cwd(), "src/lib/case-pipeline.ts")).href
);
const { computeCasePipeline, caseDaysOpen, caseStageDays, CASE_PIPELINE_STEPS } = lib;

// A blank case skeleton — override per test. createdAt is the floor.
const CREATED = "2026-06-01T00:00:00.000Z";
function base(overrides = {}) {
  return {
    caseStatus: "OPEN",
    createdAt: CREATED,
    investigatingAt: null,
    closedAt: null,
    orders: [],
    dos: [],
    pos: [],
    svOrderIds: [],
    ...overrides,
  };
}

const DAY = 86400000;

test("steps list is the canonical 8 in order", () => {
  assert.deepEqual([...CASE_PIPELINE_STEPS], [
    "Opened",
    "Investigating",
    "Service Order",
    "Repair in progress",
    "Repair done",
    "Delivery arranged",
    "Delivered",
    "Closed",
  ]);
});

test("opened-only → index 0, enteredAt = createdAt", () => {
  const p = computeCasePipeline(base());
  assert.equal(p.index, 0);
  assert.equal(p.label, "Opened");
  assert.equal(p.enteredAt, CREATED);
  assert.deepEqual(p.doneFlags, [true, false, false, false, false, false, false, false]);
});

test("IN_PROGRESS with no orders → Investigating, enteredAt = investigatingAt", () => {
  const inv = "2026-06-03T08:00:00.000Z";
  const p = computeCasePipeline(base({ caseStatus: "IN_PROGRESS", investigatingAt: inv }));
  assert.equal(p.index, 1);
  assert.equal(p.label, "Investigating");
  assert.equal(p.enteredAt, inv);
});

test("Investigating falls back to createdAt when investigatingAt is null", () => {
  const p = computeCasePipeline(base({ caseStatus: "IN_PROGRESS" }));
  assert.equal(p.index, 1);
  assert.equal(p.enteredAt, CREATED);
});

test("has an order → Service Order, enteredAt = earliest order createdAt", () => {
  const o1 = "2026-06-05T00:00:00.000Z";
  const o2 = "2026-06-06T00:00:00.000Z";
  const p = computeCasePipeline(
    base({
      caseStatus: "IN_PROGRESS",
      orders: [
        { isSv: true, status: "PENDING", createdAt: o2 },
        { isSv: true, status: "DRAFT", createdAt: o1 },
      ],
      svOrderIds: ["sv1", "sv2"],
    }),
  );
  assert.equal(p.index, 2);
  assert.equal(p.label, "Service Order");
  assert.equal(p.enteredAt, o1); // earliest
});

test("PO job card with a completedDate → Repair in progress, enteredAt = that date", () => {
  const done = "2026-06-08T00:00:00.000Z";
  const p = computeCasePipeline(
    base({
      caseStatus: "IN_PROGRESS",
      orders: [{ isSv: true, status: "IN_PRODUCTION", createdAt: "2026-06-05T00:00:00.000Z" }],
      pos: [{ salesOrderId: "sv1", jobCards: [{ completedDate: done }] }],
      svOrderIds: ["sv1"],
    }),
  );
  assert.equal(p.index, 3);
  assert.equal(p.label, "Repair in progress");
  assert.equal(p.enteredAt, done);
});

test("Repair in progress enteredAt = EARLIEST completed date (first dept to finish)", () => {
  const first = "2026-06-08T00:00:00.000Z";
  const second = "2026-06-10T00:00:00.000Z";
  const p = computeCasePipeline(
    base({
      caseStatus: "IN_PROGRESS",
      orders: [{ isSv: true, status: "IN_PRODUCTION", createdAt: "2026-06-05T00:00:00.000Z" }],
      // Two depts done but the SV order isn't READY_TO_SHIP yet → still "in
      // progress" (not all depts done from the order's POV). enteredAt picks
      // the FIRST completion.
      pos: [
        { salesOrderId: "sv1", jobCards: [{ completedDate: second }, { completedDate: first }] },
      ],
      svOrderIds: ["sv1"],
    }),
  );
  assert.equal(p.index, 3);
  assert.equal(p.enteredAt, first);
});

test("READY_TO_SHIP SV order → Repair done, enteredAt = latest completed date", () => {
  const first = "2026-06-08T00:00:00.000Z";
  const last = "2026-06-11T00:00:00.000Z";
  const p = computeCasePipeline(
    base({
      caseStatus: "IN_PROGRESS",
      orders: [{ isSv: true, status: "READY_TO_SHIP", createdAt: "2026-06-05T00:00:00.000Z" }],
      pos: [{ salesOrderId: "sv1", jobCards: [{ completedDate: first }, { completedDate: last }] }],
      svOrderIds: ["sv1"],
    }),
  );
  assert.equal(p.index, 4);
  assert.equal(p.label, "Repair done");
  assert.equal(p.enteredAt, last); // all depts finished = the last one
});

test("Repair done with no completion dates falls back to order createdAt", () => {
  const oc = "2026-06-05T00:00:00.000Z";
  const p = computeCasePipeline(
    base({
      caseStatus: "IN_PROGRESS",
      // Legacy service_order READY_TO_SHIP, no POs / job cards on the case.
      orders: [{ isSv: false, status: "READY_TO_SHIP", createdAt: oc }],
      svOrderIds: [],
    }),
  );
  assert.equal(p.index, 4);
  assert.equal(p.enteredAt, oc); // fell back down the chain to Service Order ts
});

test("a delivery order present → Delivery arranged, enteredAt = earliest DO createdAt", () => {
  const doCreated = "2026-06-12T00:00:00.000Z";
  const p = computeCasePipeline(
    base({
      caseStatus: "IN_PROGRESS",
      orders: [{ isSv: true, status: "READY_TO_SHIP", createdAt: "2026-06-05T00:00:00.000Z" }],
      dos: [{ salesOrderId: "sv1", status: "DRAFT", createdAt: doCreated }],
      svOrderIds: ["sv1"],
    }),
  );
  assert.equal(p.index, 5);
  assert.equal(p.label, "Delivery arranged");
  assert.equal(p.enteredAt, doCreated);
});

test("Delivery arranged enteredAt falls back to dispatchedAt when createdAt absent", () => {
  const disp = "2026-06-12T09:00:00.000Z";
  const p = computeCasePipeline(
    base({
      caseStatus: "IN_PROGRESS",
      orders: [{ isSv: true, status: "SHIPPED", createdAt: "2026-06-05T00:00:00.000Z" }],
      dos: [{ salesOrderId: "sv1", status: "IN_TRANSIT", createdAt: null, dispatchedAt: disp }],
      svOrderIds: ["sv1"],
    }),
  );
  assert.equal(p.index, 5);
  assert.equal(p.enteredAt, disp);
});

test("DO DELIVERED → Delivered, enteredAt = deliveredAt", () => {
  const delivered = "2026-06-13T00:00:00.000Z";
  const p = computeCasePipeline(
    base({
      caseStatus: "IN_PROGRESS",
      orders: [{ isSv: true, status: "DELIVERED", createdAt: "2026-06-05T00:00:00.000Z" }],
      dos: [
        {
          salesOrderId: "sv1",
          status: "DELIVERED",
          createdAt: "2026-06-12T00:00:00.000Z",
          dispatchedAt: "2026-06-12T10:00:00.000Z",
          deliveredAt: delivered,
        },
      ],
      svOrderIds: ["sv1"],
    }),
  );
  assert.equal(p.index, 6);
  assert.equal(p.label, "Delivered");
  assert.equal(p.enteredAt, delivered);
});

test("Delivered enteredAt falls back to dispatchedAt when deliveredAt absent", () => {
  const disp = "2026-06-13T10:00:00.000Z";
  const p = computeCasePipeline(
    base({
      caseStatus: "IN_PROGRESS",
      // Legacy order marked DELIVERED, DO has only a dispatch stamp.
      orders: [{ isSv: true, status: "INVOICED", createdAt: "2026-06-05T00:00:00.000Z" }],
      dos: [
        { salesOrderId: "sv1", status: "INVOICED", createdAt: null, dispatchedAt: disp, deliveredAt: null },
      ],
      svOrderIds: ["sv1"],
    }),
  );
  assert.equal(p.index, 6);
  assert.equal(p.enteredAt, disp);
});

test("case CLOSED → Closed, enteredAt = closedAt", () => {
  const closed = "2026-06-14T00:00:00.000Z";
  const p = computeCasePipeline(
    base({
      caseStatus: "CLOSED",
      orders: [{ isSv: true, status: "DELIVERED", createdAt: "2026-06-05T00:00:00.000Z" }],
      dos: [{ salesOrderId: "sv1", status: "DELIVERED", deliveredAt: "2026-06-13T00:00:00.000Z" }],
      svOrderIds: ["sv1"],
      closedAt: closed,
    }),
  );
  assert.equal(p.index, 7);
  assert.equal(p.label, "Closed");
  assert.equal(p.enteredAt, closed);
});

test("DOs / POs for OTHER cases' SV ids are ignored (svOrderIds filter)", () => {
  // A DO exists but its salesOrderId isn't on THIS case → must not advance it.
  const p = computeCasePipeline(
    base({
      caseStatus: "IN_PROGRESS",
      orders: [{ isSv: true, status: "PENDING", createdAt: "2026-06-05T00:00:00.000Z" }],
      dos: [{ salesOrderId: "OTHER-SO", status: "DELIVERED", deliveredAt: "2026-06-13T00:00:00.000Z" }],
      pos: [{ salesOrderId: "OTHER-SO", jobCards: [{ completedDate: "2026-06-08T00:00:00.000Z" }] }],
      svOrderIds: ["sv1"],
    }),
  );
  assert.equal(p.index, 2); // only Service Order, not advanced by the other SO's DO/PO
  assert.equal(p.label, "Service Order");
});

// --------------------------------------------------------------------------
// caseDaysOpen / caseStageDays day math
// --------------------------------------------------------------------------
test("caseDaysOpen: open case counts to `now`", () => {
  const now = new Date(CREATED).getTime() + 5 * DAY + 3600_000; // 5d 1h later
  assert.equal(caseDaysOpen(CREATED, null, now), 5); // floors partial day
});

test("caseDaysOpen: closed case is frozen at closedAt, ignoring `now`", () => {
  const closed = new Date(CREATED).getTime() + 3 * DAY;
  const closedIso = new Date(closed).toISOString();
  const wayLater = closed + 100 * DAY;
  assert.equal(caseDaysOpen(CREATED, closedIso, wayLater), 3);
});

test("caseDaysOpen: unparseable / future start → 0, never negative", () => {
  assert.equal(caseDaysOpen("", null, Date.now()), 0);
  const future = new Date(CREATED).getTime() + 10 * DAY;
  assert.equal(caseDaysOpen(new Date(future).toISOString(), null, new Date(CREATED).getTime()), 0);
});

test("caseStageDays: counts from enteredAt to `now` for an open case", () => {
  const entered = "2026-06-08T00:00:00.000Z";
  const now = new Date(entered).getTime() + 4 * DAY + 1000;
  assert.equal(caseStageDays(entered, null, now), 4);
});

test("caseStageDays: FROZEN at closedAt for a closed case", () => {
  const entered = "2026-06-08T00:00:00.000Z";
  const closed = new Date(entered).getTime() + 2 * DAY;
  const closedIso = new Date(closed).toISOString();
  const wayLater = closed + 50 * DAY;
  assert.equal(caseStageDays(entered, closedIso, wayLater), 2);
});

test("caseStageDays: null enteredAt → 0", () => {
  assert.equal(caseStageDays(null, null, Date.now()), 0);
});
