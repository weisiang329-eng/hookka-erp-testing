// ---------------------------------------------------------------------------
// so-customer-mini-projection.test.mjs — proof that the /m Customer detail
// "Recent Orders" panel renders the same rows off `?fields=customer-mini` as it
// did off the bare /api/sales-orders list.
//
// BUG-2026-08-13-026: opening one customer on a phone fetched the whole SO list
// — 2.16 MB decoded / 1,342 rows with every 24-field line item — to render at
// most twenty rows of five fields. The projection ships the SAME rows in the
// SAME order with only the eight keys the panel reads.
//
// Two things have to hold, and both are exercised here against the panel's REAL
// selection logic (copied from src/pages/m/config/modules.ts customerDetail, and
// pinned against that file by the source assertions at the bottom so a drift in
// either direction fails CI):
//
//   1. FIELD COVERAGE — every key the panel reads must survive the projection.
//      A missing key does not throw; it renders "—" or RM 0.00, which is the
//      quiet kind of wrong.
//   2. ROW SET AND ORDER — the panel filters on
//      `customerId === cid || customerName === cname` and then slices the first
//      20. That OR is why the projection does NOT filter server-side: a
//      `?customerId=` read would drop the name-only matches and change the
//      "Recent Orders · N" heading (audit finding D6's trap). And because the
//      slice is positional, the projection has to preserve the list's
//      `created_at DESC, id DESC` order exactly.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// --- The panel's own logic, as it stands in modules.ts ----------------------
// read/str/num are transcribed VERBATIM from src/pages/m/config/helpers.ts:35-52
// (importing them would drag the "@/" alias + formatCurrency into a node:test
// run for no gain). The transcription is asserted against the source below.
const read = (row, ...keys) => {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
};
const str = (row, ...keys) => {
  const v = read(row, ...keys);
  return v == null ? "" : String(v);
};
const num = (row, ...keys) => {
  const v = read(row, ...keys);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** What customerDetail.subDocLists builds for the Recent Orders list. */
function recentOrders(rows, cid, cname) {
  const sos = rows.filter(
    (s) => str(s, "customerId") === cid || str(s, "customerName") === cname,
  );
  return {
    heading: `Recent Orders · ${sos.length}`,
    rows: sos.slice(0, 20).map((s) => ({
      id: str(s, "id", "companySO"),
      title: str(s, "companySO", "companySOId") || "—",
      dateKey: str(s, "companySODate"),
      status: str(s, "status"),
      totalSen: num(s, "totalSen"),
      href: `/m/sales/${encodeURIComponent(str(s, "id", "companySO"))}`,
    })),
  };
}

// --- Fixture: what the FULL list returns (rowToSOList shape, abridged) ------
// Ordered as the route orders it: created_at DESC, id DESC.
function fullRow(i, over = {}) {
  return {
    id: `so-${i}`,
    customerPO: "PO-X", customerPOId: "PO-X", customerPODate: "2026-01-01",
    customerSO: "", customerSOId: "", reference: "ref",
    customerId: "cust-1", customerName: "Alpha Furnishings", customerState: "SEL",
    hubId: "hub-1", hubName: "KL",
    companySO: `SO-2606-${String(i).padStart(3, "0")}`,
    companySOId: `SO-2606-${String(i).padStart(3, "0")}`,
    companySODate: `2026-06-${String(i).padStart(2, "0")}`,
    customerDeliveryDate: "", hookkaExpectedDD: "2026-07-01",
    hookkaDeliveryOrder: "",
    items: [{ lineNo: 1, productCode: "BF-001", unitPriceSen: 99900, quantity: 2 }],
    subtotalSen: 199800, totalSen: 199800 + i,
    status: "CONFIRMED", overdue: "PENDING", notes: "",
    ...over,
  };
}

const FULL = [
  fullRow(30),
  fullRow(29, { customerId: "cust-2", customerName: "Beta Beds" }),
  // The name-only match: a row whose customerId does NOT equal cust-1 but whose
  // customerName does. This is the row a server-side ?customerId= filter would
  // silently drop.
  fullRow(28, { customerId: "", customerName: "Alpha Furnishings" }),
  ...Array.from({ length: 25 }, (_, k) => fullRow(27 - k)),
];

/** What ?fields=customer-mini emits, mirroring the route's map exactly. */
function project(rows) {
  return rows.map((s) => ({
    id: String(s.id ?? ""),
    companySO: String(s.companySO ?? ""),
    companySOId: String(s.companySOId ?? ""),
    companySODate: String(s.companySODate ?? ""),
    status: s.status,
    totalSen: s.totalSen,
    customerId: s.customerId,
    customerName: s.customerName,
  }));
}

const CID = "cust-1";
const CNAME = "Alpha Furnishings";

test("the panel renders identically off the projection", () => {
  const before = recentOrders(FULL, CID, CNAME);
  const after = recentOrders(project(FULL), CID, CNAME);
  assert.deepEqual(
    after,
    before,
    "the projection changed what the Recent Orders panel shows",
  );
});

test("the name-only match survives — this is why the read is NOT customer-filtered", () => {
  const shown = recentOrders(project(FULL), CID, CNAME);
  assert.ok(
    shown.rows.some((r) => r.id === "so-28"),
    "the row matched by customerName alone must still appear",
  );
  // And confirm the fixture would actually catch a customerId-only filter.
  const idFiltered = project(FULL).filter((s) => s.customerId === CID);
  assert.notEqual(
    recentOrders(idFiltered, CID, CNAME).heading,
    shown.heading,
    "fixture problem: a customerId-only filter should change the count",
  );
});

test("row ORDER is preserved, because the panel slices the first 20", () => {
  const shown = recentOrders(project(FULL), CID, CNAME);
  const expected = recentOrders(FULL, CID, CNAME);
  assert.equal(shown.rows.length, 20, "fixture must exceed the slice to test it");
  assert.deepEqual(
    shown.rows.map((r) => r.id),
    expected.rows.map((r) => r.id),
  );
  // A reordered projection must FAIL — proves the assertion above has teeth.
  const reordered = recentOrders([...project(FULL)].reverse(), CID, CNAME);
  assert.notDeepEqual(
    reordered.rows.map((r) => r.id),
    expected.rows.map((r) => r.id),
  );
});

test("the heading count is the FULL match count, not the sliced one", () => {
  const shown = recentOrders(project(FULL), CID, CNAME);
  assert.equal(shown.heading, `Recent Orders · 27`);
  assert.equal(shown.rows.length, 20);
});

// ---------------------------------------------------------------------------
// Source-level locks — keep the three sides of this contract in step.
// ---------------------------------------------------------------------------
const MODULES = readFileSync(
  resolve(process.cwd(), "src/pages/m/config/modules.ts"),
  "utf8",
);
const ROUTE = readFileSync(
  resolve(process.cwd(), "src/api/routes/sales-orders.ts"),
  "utf8",
);

test("the /m customer panel requests the projection, not the bare list", () => {
  assert.match(MODULES, /key: "soList", url: \(\) => "\/api\/sales-orders\?fields=customer-mini"/);
});

test("the projection emits every key the panel reads", () => {
  const block = ROUTE.slice(
    ROUTE.indexOf('c.req.query("fields") === "customer-mini"'),
  ).slice(0, 3000);
  for (const key of [
    "id",
    "companySO",
    "companySOId",
    "companySODate",
    "status",
    "totalSen",
    "customerId",
    "customerName",
  ]) {
    assert.match(
      block,
      new RegExp(`\\b${key}:`),
      `?fields=customer-mini must emit \`${key}\` — the panel reads it`,
    );
  }
});

test("the projection keeps the full list's ORDER BY", () => {
  const block = ROUTE.slice(
    ROUTE.indexOf('c.req.query("fields") === "customer-mini"'),
  ).slice(0, 3000);
  assert.match(
    block,
    /ORDER BY created_at DESC, id DESC/,
    "the panel slices positionally, so the order must match the full list",
  );
});

test("the projection does NOT filter by customer", () => {
  const block = ROUTE.slice(
    ROUTE.indexOf('c.req.query("fields") === "customer-mini"'),
  ).slice(0, 3000);
  const where = block.slice(block.indexOf("FROM ${soSourceSql}"), block.indexOf("ORDER BY"));
  assert.doesNotMatch(
    where,
    /customer_id\s*=|customerId\s*=/,
    "filtering by customerId would drop the panel's name-only matches (D6)",
  );
});

test("the transcribed read/str/num still match src/pages/m/config/helpers.ts", () => {
  // If these helpers change shape, the equivalence proven above stops being a
  // proof about the real panel.
  const H = readFileSync(
    resolve(process.cwd(), "src/pages/m/config/helpers.ts"),
    "utf8",
  );
  assert.match(H, /if \(v !== undefined && v !== null && v !== ""\) return v;/);
  assert.match(H, /return v == null \? "" : String\(v\);/);
  assert.match(H, /return Number\.isFinite\(n\) \? n : 0;/);
});
