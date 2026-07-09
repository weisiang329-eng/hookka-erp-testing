import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
try { register("tsx/esm", pathToFileURL("./")); } catch {}
const m = await import(pathToFileURL(resolve(process.cwd(), "src/lib/supplier-payment-alloc.ts")).href);

test("computeAlloc — MYR partial: booked=bank, no fx", () => {
  const r = m.computeAlloc({ outstandingBookedSen: 100000, isForeign: false, fxRate: 1, payMyrSen: 40000, full: false });
  assert.deepEqual(r, { ok: true, bookedSen: 40000, bankSen: 40000, fxDiffSen: 0 });
});

test("computeAlloc — MYR over outstanding → error", () => {
  const r = m.computeAlloc({ outstandingBookedSen: 30000, isForeign: false, fxRate: 1, payMyrSen: 40000, full: false });
  assert.equal(r.ok, false);
});

test("computeAlloc — foreign partial: 300 USD @ book 4.5 / pay 4.6 → loss 30", () => {
  const r = m.computeAlloc({ outstandingBookedSen: 450000, isForeign: true, fxRate: 4.5, foreignSen: 30000, payRate: 4.6, full: false });
  assert.deepEqual(r, { ok: true, bookedSen: 135000, bankSen: 138000, fxDiffSen: -3000 });
});

test("computeAlloc — foreign FULL settle uses outstanding for booked (no cent residue)", () => {
  const r = m.computeAlloc({ outstandingBookedSen: 450000, isForeign: true, fxRate: 4.5, foreignSen: 100000, payRate: 4.6, full: true });
  assert.equal(r.ok, true);
  assert.equal(r.bookedSen, 450000);
  assert.equal(r.bankSen, 460000);
  assert.equal(r.fxDiffSen, -10000);
});

test("computeAlloc — foreign requires payRate>0", () => {
  const r = m.computeAlloc({ outstandingBookedSen: 450000, isForeign: true, fxRate: 4.5, foreignSen: 30000, payRate: 0, full: false });
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// REGRESSION (prod bug BUG-2026-07-01-003): the Postgres adapter camelCases
// every result column (db-pg.ts transform.column.from) regardless of how the
// SQL referenced/aliased it. GET /api/supplier-payments's row loop read
// row.payment_no (snake_case) → always undefined → every row silently
// skipped → the All Payments list + summary cards always showed empty/zero,
// even for a payment confirmed to exist and post correctly to the GL/ledger.
// Separately, the same misread on purchase_invoices' amount_sen/
// paid_amount_sen made piOutstandingSen always compute 0, which would
// reject/no-op a real allocation against a specific PI (and — in
// void/restate — always roll back "0", silently failing to undo the PI's
// paid_amount_sen). These tests feed the camelCase-only shape the live
// adapter actually produces, so they fail under the old (snake_case-read)
// logic and pass now.
// ---------------------------------------------------------------------------
test("piOutstandingSen — reads amountSen/paidAmountSen (the PG adapter camelCases the columns)", () => {
  assert.equal(m.piOutstandingSen({ amountSen: 1147600, paidAmountSen: 0 }), 1147600);
  assert.equal(m.piOutstandingSen({ amountSen: 1147600, paidAmountSen: 500000 }), 647600);
});

test("piOutstandingSen — tolerates snake_case fallback; missing fields net to 0", () => {
  assert.equal(m.piOutstandingSen({ amount_sen: 1147600, paid_amount_sen: 500000 }), 647600);
  assert.equal(m.piOutstandingSen({}), 0);
});

test("readBookedSen — reads bookedSen (the PG adapter camelCases the column)", () => {
  assert.equal(m.readBookedSen({ bookedSen: 1147600 }), 1147600);
  assert.equal(m.readBookedSen({ booked_sen: 1147600 }), 1147600, "snake_case fallback");
  assert.equal(m.readBookedSen({}), 0);
});

test("groupSupplierPaymentRows — camelCase-only rows (the real adapter shape) populate the list", () => {
  const rows = [
    {
      id: "sp-1", paymentNo: "HPV-2607-002", supplierId: "sup-1", supplierName: "ADD WOORD TRADING SDN. BHD.",
      purchaseInvoiceId: null, date: "2026-07-01", amountSen: 1147600, bookedSen: 1147600,
      piNo: null, supplierInvoiceNo: null, lifecycleState: "ACTIVE",
    },
  ];
  const groups = m.groupSupplierPaymentRows(rows);
  assert.equal(groups.length, 1, "camelCased payment_no MUST populate the list (regression guard)");
  assert.equal(groups[0].paymentNo, "HPV-2607-002");
  assert.equal(groups[0].supplierName, "ADD WOORD TRADING SDN. BHD.");
  assert.equal(groups[0].totalBankSen, 1147600);
  assert.equal(groups[0].totalBookedSen, 1147600);
  assert.equal(groups[0].lines.length, 1);
  assert.equal(groups[0].lines[0].purchaseInvoiceId, "", "null advance-line PI id normalises to empty string");
});

test("groupSupplierPaymentRows — tolerates snake_case fallback; drops rows with no payment_no", () => {
  const rows = [
    { id: "sp-1", payment_no: "HPV-2607-001", supplier_id: "sup-1", supplier_name: "S", date: "2026-07-01", amount_sen: 5000, booked_sen: 5000 },
    { id: "sp-2", date: "2026-07-01", amountSen: 100, bookedSen: 100 }, // no payment_no at all
  ];
  const groups = m.groupSupplierPaymentRows(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].paymentNo, "HPV-2607-001");
});

test("groupSupplierPaymentRows — two lines under the same payment_no sum into one group", () => {
  const rows = [
    { id: "sp-1", paymentNo: "HPV-1", supplierId: "s1", supplierName: "S", date: "d", amountSen: 300, bookedSen: 300, purchaseInvoiceId: "pi-1" },
    { id: "sp-2", paymentNo: "HPV-1", supplierId: "s1", supplierName: "S", date: "d", amountSen: 200, bookedSen: 200, purchaseInvoiceId: "pi-2" },
  ];
  const groups = m.groupSupplierPaymentRows(rows);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].totalBankSen, 500);
  assert.equal(groups[0].lines.length, 2);
});

test("restateHeadroom — PAID PI is editable when THIS payment booked it (BUG-2026-07-09-001)", () => {
  // INNOVATEX shape: face 418, paid 418 (all by the payment being restated).
  const r = m.restateHeadroom({ amountSen: 41800, paidAmountSen: 41800, status: "PAID" }, 41800);
  assert.equal(r.payable, true);
  assert.equal(r.outstandingBookedSen, 41800); // its own booking counts as available again
});

test("restateHeadroom — PAID PI stays locked for a payment that never touched it", () => {
  const r = m.restateHeadroom({ amountSen: 41800, paidAmountSen: 41800, status: "PAID" }, 0);
  assert.equal(r.payable, false);
});

test("restateHeadroom — PARTIAL_PAID adds its own old booking on top of the remaining outstanding", () => {
  // face 1000, paid 700 of which THIS payment booked 400 → headroom 300 + 400.
  const r = m.restateHeadroom({ amount_sen: 100000, paid_amount_sen: 70000, status: "PARTIAL_PAID" }, 40000);
  assert.equal(r.payable, true);
  assert.equal(r.outstandingBookedSen, 70000);
});

test("restateHeadroom — CANCELLED/DRAFT are never payable", () => {
  assert.equal(m.restateHeadroom({ amountSen: 100, paidAmountSen: 0, status: "CANCELLED" }, 100).payable, false);
  assert.equal(m.restateHeadroom({ amountSen: 100, paidAmountSen: 0, status: "DRAFT" }, 0).payable, false);
});
