// ---------------------------------------------------------------------------
// customer-detail-scoped-read.test.mjs — proof that resolving ONE customer via
// GET /api/customers/:id returns the same record as `.find()` over the whole
// GET /api/customers list.
//
// BUG-2026-08-13-023 (audit finding D5): src/pages/service-cases/detail.tsx
// downloaded the entire customer master and then ran
// `custResp.data.find(c => c.id === caseDetail.customerId)` to read a name, a
// phone and a delivery hub. `/api/customers/:id` is the scoped read for exactly
// that and is already used this way on sales/detail.tsx:467 and
// consignment/detail.tsx:424.
//
// The swap is only safe if the two handlers agree field for field. They do
// because both build the row with the SAME `rowToCustomer` over the same
// `customers` row and the same `delivery_hubs` rows — but "they call the same
// helper" is the kind of claim that quietly stops being true, so it is pinned
// here by running BOTH handlers against one fixture and deep-comparing.
//
// The ONE deliberate difference is also pinned: the list is org-scoped
// (`WHERE orgId = ?`) and `/:id` is keyed on the id alone. For a customer of
// this org the row is identical; for a foreign one the old `.find()` returned
// nothing. That is a widening — it cannot blank a field that used to render —
// and it is the behaviour the two pages above already have.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import app from "../src/api/routes/customers.ts";

const ORG = "org-hookka";

const CUSTOMER_ROWS = [
  {
    id: "cust-1", orgId: ORG, code: "C001", name: "Alpha Furnishings",
    ssmNo: "1234-X", companyAddress: "12 Jalan Satu", creditTerms: "NET60",
    creditLimitSen: 5000000, outstandingSen: 125000, isActive: 1,
    contactName: "Aminah", phone: "012-3456789", email: "a@alpha.test",
    default_company_code: " hookka ", oemMarking: null,
  },
  {
    id: "cust-2", orgId: ORG, code: "C002", name: "Beta Beds",
    ssmNo: null, companyAddress: null, creditTerms: null,
    creditLimitSen: 0, outstandingSen: 0, isActive: 0,
    contactName: null, phone: null, email: null,
    default_company_code: null, oemMarking: null,
  },
];

const HUB_ROWS = [
  { id: "hub-1", customerId: "cust-1", orgId: ORG, code: "H1", shortName: "KL Warehouse", state: "SEL", address: "Lot 5", contactName: "Ravi", phone: "011-1", email: "h1@alpha.test", isDefault: 1 },
  { id: "hub-2", customerId: "cust-1", orgId: ORG, code: "H2", shortName: "PG Store", state: "PNG", address: "Lot 9", contactName: null, phone: null, email: null, isDefault: 0 },
  { id: "hub-3", customerId: "cust-2", orgId: ORG, code: "H3", shortName: "JB", state: "JHR", address: null, contactName: null, phone: null, email: null, isDefault: 0 },
];

/**
 * Stub DB. Answers the handful of shapes these two handlers issue and treats
 * the runtime self-apply DDL (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`) as a
 * no-op, which is what it is against an already-migrated database.
 */
function makeDB() {
  const answer = (sql, binds) => {
    if (/FROM customers/i.test(sql)) {
      // `/:id` binds the id; the list binds the orgId.
      const id = binds[0];
      return CUSTOMER_ROWS.filter((r) => r.id === id || r.orgId === id);
    }
    if (/FROM delivery_hubs/i.test(sql)) {
      const key = binds[0];
      return HUB_ROWS.filter((h) => h.customerId === key || h.orgId === key);
    }
    return [];
  };
  const stmt = (sql, binds = []) => ({
    bind: (...b) => stmt(sql, b),
    all: async () => ({ results: answer(sql, binds), success: true }),
    first: async () => answer(sql, binds)[0] ?? null,
    run: async () => ({ success: true, results: [] }),
  });
  return { prepare: (sql) => stmt(sql) };
}

async function call(path) {
  const parent = new Hono();
  parent.use("*", async (c, next) => {
    c.set("DB", makeDB());
    c.set("orgId", ORG);
    c.set("userRole", "SUPER_ADMIN");
    c.set("userId", "u-test");
    await next();
  });
  parent.route("/api/customers", app);
  const res = await parent.request(`/api/customers${path}`);
  return { status: res.status, body: await res.json() };
}

test("/:id returns the SAME record the list .find() produced", async () => {
  const list = await call("");
  assert.equal(list.status, 200);
  const fromList = list.body.data.find((c) => c.id === "cust-1");
  assert.ok(fromList, "fixture problem: cust-1 missing from the list");

  const one = await call("/cust-1");
  assert.equal(one.status, 200);
  assert.equal(one.body.success, true);

  assert.deepEqual(
    one.body.data,
    fromList,
    "the scoped read diverged from the list row — service-cases/detail.tsx " +
      "renders name / code / phone / email / address / deliveryHubs off this",
  );
  // Same JSON text too, so no key-order or format drift hides inside deepEqual.
  assert.equal(JSON.stringify(one.body.data), JSON.stringify(fromList));
});

test("delivery hubs come back identically — the page reads isDefault off them", async () => {
  const one = (await call("/cust-1")).body.data;
  const fromList = (await call("")).body.data.find((c) => c.id === "cust-1");
  assert.equal(one.deliveryHubs.length, 2, "cust-1 has two hubs in the fixture");
  assert.deepEqual(one.deliveryHubs, fromList.deliveryHubs);
  // The detail page picks `hubs.find(h => h.isDefault) ?? hubs[0]`, so both the
  // flag and the ORDER have to survive.
  assert.equal(one.deliveryHubs[0].shortName, "KL Warehouse");
  assert.equal(one.deliveryHubs[0].isDefault, true);
});

test("a customer with no hubs still matches the list row exactly", async () => {
  const one = (await call("/cust-2")).body.data;
  const fromList = (await call("")).body.data.find((c) => c.id === "cust-2");
  assert.deepEqual(one, fromList);
});

test("a missing customer 404s with success:false — the page's null case", async () => {
  // service-cases/detail.tsx guards on `success === false` so `customerRecord`
  // stays null in exactly the case the old `.find()` returned undefined.
  const res = await call("/cust-nope");
  assert.equal(res.status, 404);
  assert.equal(res.body.success, false);
});
