// ---------------------------------------------------------------------------
// on-time-delivery.test.mjs — BUG-2026-08-13-140.
//
// The Hookka Report's "On-time delivery %" did not measure delivery, and did
// not measure it against anything the customer agreed to. It scored
// `delivery_orders.dispatched_at` against `delivery_orders.hookka_expected_dd`
// — our OWN back-derived internal target — over a population that required
// `dispatched_at IS NOT NULL`, so an order never dispatched at all could not
// pull it down. `kpi-metrics.ts:18-19` had already written the rule this broke:
// "`hookka_expected_dd` is OUR internal estimate and must never be scored
// against".
//
// Owner's rule, 2026-08-14, verbatim:
//   「基本上就是看我们送货的时间减掉我们顾客的 delivery date，
//     就会知道有没有 on-time delivery 了」
//
// So: `delivery_orders.delivered_at` vs `sales_orders.customer_delivery_date`,
// per sales order, last delivery counts — and every order that cannot be judged
// is EXCLUDED AND COUNTED, because a percentage over an incomplete population
// must publish its coverage (BUG-2026-08-13-096).
//
// Part BEHAVIOURAL (the verdict logic, against fabricated rows) and part
// STRUCTURAL (the wiring and the printed coverage — a plausible percentage is
// exactly what the bug produced, so only the source can pin those). Every
// assertion here was proved RED by reintroducing the removed expression and
// asserting the file's bytes changed on disk first.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  summarizeOnTimeRows,
  EMPTY_ON_TIME,
} from "../src/api/lib/on-time-delivery.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
// CRLF-normalised + BOM-stripped: this repo's files are CRLF, and a literal \n
// anchor silently matches nothing — five false all-clears in one week.
const read = (rel) =>
  readFileSync(join(root, rel), "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
function stripComments(src) {
  return src
    .replace(/^[ \t]*\{?\/\*[\s\S]*?\*\/\}?[ \t]*$/gm, "")
    .split("\n")
    .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

const AGG = "src/api/lib/operations-report.ts";
const MOD = "src/api/lib/on-time-delivery.ts";
const EDITIONS = "src/pages/hookka-report-editions.tsx";

const row = (o) => ({
  soId: o.soId ?? "so-1",
  customerDeliveryDate: o.due ?? null,
  lastDeliveredOn: o.delivered ?? null,
  openLegs: o.openLegs ?? 0,
});

// ===========================================================================
// The verdict: delivered_at vs the customer's date
// ===========================================================================

test("delivered before the customer's date is on time; after it is late", () => {
  const r = summarizeOnTimeRows([
    row({ soId: "a", due: "2026-08-10", delivered: "2026-08-08" }),
    row({ soId: "b", due: "2026-08-10", delivered: "2026-08-12" }),
  ]);
  assert.equal(r.onTime, 1);
  assert.equal(r.late, 1);
  assert.equal(r.judged, 2);
  assert.equal(r.onTimePct, 50);
});

test("delivering ON the promised day is ON TIME", () => {
  // The customer asked for that date, not for the day before it. An off-by-one
  // here turns a perfect record into a 0%.
  const r = summarizeOnTimeRows([
    row({ due: "2026-08-10", delivered: "2026-08-10" }),
  ]);
  assert.equal(r.onTime, 1);
  assert.equal(r.late, 0);
  assert.equal(r.onTimePct, 100);
});

test("a full ISO timestamp is compared on its date part only", () => {
  // deliveredAt is a timestamp; customer_delivery_date is a day. Comparing the
  // raw strings would make "2026-08-10T18:00:00Z" > "2026-08-10" — late, for a
  // delivery that arrived on the promised day.
  const r = summarizeOnTimeRows([
    {
      soId: "a",
      customerDeliveryDate: "2026-08-10",
      lastDeliveredOn: "2026-08-10T18:00:00.000Z",
      openLegs: 0,
    },
  ]);
  assert.equal(r.late, 0, "an evening arrival on the promised day is on time");
  assert.equal(r.onTime, 1);
});

// ===========================================================================
// The exclusions — each one counted, none of them silently on-time
// ===========================================================================

test("an order not yet fully delivered is EXCLUDED, not counted as late", () => {
  // Not-yet-delivered is not a failure: the delivery has not finished, so there
  // is nothing to score. Counting it late invents failures; counting it on time
  // hides them.
  const r = summarizeOnTimeRows([
    row({ soId: "a", due: "2026-08-01", delivered: "2026-08-05", openLegs: 1 }),
  ]);
  assert.equal(r.judged, 0);
  assert.equal(r.late, 0, "an unfinished delivery must not be scored as late");
  assert.equal(r.onTime, 0);
  assert.equal(r.excludedNotDelivered, 1);
  assert.equal(r.onTimePct, null, "nothing judgeable ⇒ null, never 0 and never 100");
});

test("a PART-delivery is the not-fully-delivered case, not a free pass", () => {
  // The first lorry landing early must not certify the order. It has an open
  // leg, so it is excluded until the last piece arrives — at which point the
  // LAST date is the one judged.
  const partial = summarizeOnTimeRows([
    row({ soId: "a", due: "2026-08-10", delivered: "2026-08-02", openLegs: 2 }),
  ]);
  assert.equal(partial.onTime, 0, "an early first drop cannot score the order");
  assert.equal(partial.excludedNotDelivered, 1);

  const finished = summarizeOnTimeRows([
    row({ soId: "a", due: "2026-08-10", delivered: "2026-08-14", openLegs: 0 }),
  ]);
  assert.equal(finished.late, 1, "the LAST delivery is what the customer waited for");
});

test("an order with no customer delivery date is EXCLUDED and counted", () => {
  const r = summarizeOnTimeRows([
    row({ soId: "a", due: null, delivered: "2026-08-05" }),
    row({ soId: "b", due: "  ", delivered: "2026-08-05" }),
  ]);
  assert.equal(r.judged, 0);
  assert.equal(r.excludedNoCustomerDate, 2, "blank and null are both 'no promise'");
  assert.equal(r.onTimePct, null);
});

// ===========================================================================
// Coverage — the population is published, always
// ===========================================================================

test("coverage is judged ÷ everything the metric looked at", () => {
  const r = summarizeOnTimeRows([
    row({ soId: "a", due: "2026-08-10", delivered: "2026-08-09" }),
    row({ soId: "b", due: "2026-08-10", delivered: "2026-08-11" }),
    row({ soId: "c", due: null, delivered: "2026-08-09" }),
    row({ soId: "d", due: "2026-08-10", delivered: "2026-08-09", openLegs: 1 }),
  ]);
  assert.equal(r.judged, 2);
  assert.equal(r.population, 4);
  assert.equal(r.coveragePct, 50, "half the orders could not be judged — say so");
  assert.equal(r.onTimePct, 50);
});

test("an empty period publishes nulls, not a perfect score", () => {
  const r = summarizeOnTimeRows([]);
  assert.equal(r.onTimePct, null);
  assert.equal(r.coveragePct, null);
  assert.equal(r.population, 0);
  assert.equal(EMPTY_ON_TIME.onTimePct, null, "the failure fallback is null too");
});

// ===========================================================================
// STRUCTURAL — the wiring, which no behavioural test can reach
// ===========================================================================

test("the report no longer scores our own internal target", () => {
  const agg = stripComments(read(AGG));
  assert.ok(
    !/hookka_expected_dd/.test(agg),
    "operations-report must not read hookka_expected_dd at all — it is OUR " +
      "estimate, back-derived from the customer's date, and scoring it is " +
      "marking our own homework (kpi-metrics.ts:18-19)",
  );
  assert.ok(
    !/dispatchedAt <= r\.expectedDd|r\.dispatchedAt <= r\.expectedDd/.test(agg),
    "the dispatch-vs-estimate comparison is back",
  );
  assert.ok(
    /collectOnTimeDelivery\(db, p\.startYmd, p\.endYmd\)/.test(agg),
    "the delivery section must take its on-time figure from the shared module",
  );
  assert.ok(
    /onTimePct: onTime\.onTimePct/.test(agg),
    "and publish that module's percentage, not a locally recomputed one",
  );
});

test("the metric reads delivered_at against the customer's own date", () => {
  const mod = stripComments(read(MOD));
  assert.ok(
    /d\.deliveredAt/.test(mod),
    "the actual arrival is delivery_orders.deliveredAt",
  );
  assert.ok(
    /so\.customerDeliveryDate/.test(mod),
    "the promise is sales_orders.customerDeliveryDate — the customer's date",
  );
  assert.ok(
    !/hookkaExpectedDd|hookka_expected_dd/.test(mod),
    "our internal estimate must never appear in this module",
  );
  // The join path kpi-metrics.ts measured: delivery_orders.sales_order_id is
  // set on only ~half the DOs, so joining on it drops half the shipments.
  assert.ok(
    /JOIN delivery_order_items di ON di\.deliveryOrderId = d\.id/.test(mod) &&
      /JOIN production_orders po ON po\.id = di\.productionOrderId/.test(mod),
    "must use the production-order join path, the only one that resolves",
  );
  assert.ok(
    !/d\.salesOrderId/.test(mod),
    "delivery_orders.salesOrderId is populated on only ~166 of 361 DOs",
  );
});

test("the printed report publishes the coverage beside the percentage", () => {
  const strip = stripComments(read(EDITIONS));
  assert.ok(
    /r\.delivery\.onTime/.test(strip),
    "the edition must read the coverage object, not just the bare percentage",
  );
  for (const field of ["judged", "excludedNotDelivered", "excludedNoCustomerDate"]) {
    assert.ok(
      strip.includes(`ot.${field}`),
      `the printed report drops \`${field}\`: the reader cannot then tell a ` +
        `100% over four orders from a 100% over four hundred`,
    );
  }
  assert.ok(
    /On-Time Delivery at/.test(strip) && /"On-time delivery"/.test(strip),
    "both prints of this figure must say DELIVERY — it is not production " +
      "timeliness, and it used to be labelled as though the two agreed",
  );
});
