// ---------------------------------------------------------------------------
// invoice-price-buildup-rule — the ONE rule for an invoice line's price, held
// across the three surfaces that used to each carry their own copy of it:
// the backend resolver (src/api/lib/invoice-print-extras.ts), the invoice
// detail screen (read view + price editor) and the PDF builder.
//
// The rule (src/lib/invoice-line-price.ts):
//   the charge is invoice_items.unitPriceSen and it is authoritative;
//   the Base/Divan/Leg/T.Height/Special build-up is an EXPLANATION of it;
//   an explanation that does not sum to the charge is never displayed;
//   editing moves the explanation and the charge together — so opening the
//   editor and saving without typing must leave the charge untouched.
//
// The two symptoms this locks out, both real:
//   (A) the screen printed "Base … = RM 305" on a line whose components summed
//       to RM 307.98 — a build-up that does not add up. The PDF refused it; the
//       screen had no guard.
//   (B) pressing Edit seeded those same components, so Save WITHOUT TYPING
//       ANYTHING repriced the line RM 305 → RM 307.98.
//
// These assert BEHAVIOUR — what is displayed, and what a save would charge —
// not the shape of any implementation.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
try { register("tsx/esm", pathToFileURL("./")); } catch { /* native strip */ }

const load = (p) => import(pathToFileURL(resolve(process.cwd(), p)).href);

const {
  invoicePriceBuildUp,
  invoicePriceEditSeed,
  invoiceLineUnitSen,
} = await load("src/lib/invoice-line-price.ts");
const { buildUnifiedInvoiceData } = await load("src/lib/build-unified-doc-data.ts");
const { computeInvoicePrintExtras } = await load("src/api/lib/invoice-print-extras.ts");

// --- the lines under test -------------------------------------------------
// Every case is (what the customer is charged, what the components on file say).
const LINES = {
  // The reported bug. Charge RM 305.00; the components on file sum to RM 307.98.
  contradicted: { charge: 30500, ex: { baseSen: 30500, totalHeightSen: 298 } },
  // The same disease with a zero base — "Base 0 … = RM 305".
  zeroBase: { charge: 30500, ex: { baseSen: 0, divanSen: 13000, legSen: 5000 } },
  // A healthy itemised line: 830.00 + 80.00 T.Height = 910.00.
  itemised: { charge: 91000, ex: { baseSen: 83000, totalHeightSen: 8000 } },
  // Combo-redistributed sofa: base IS the charge, nothing separately priced.
  noSurcharge: { charge: 109424, ex: { baseSen: 109424 } },
  // Legacy row with no PO link — nothing resolved at all (~7.4% of lines).
  unresolved: { charge: 30500, ex: undefined },
};

// The invoice detail screen shows a build-up iff the shared rule returns rows.
const screenShowsBuildUp = (l) => invoicePriceBuildUp(l.ex, l.charge) !== undefined;

// The PDF shows one iff the built document carries a priceBreakdown.
function pdfLine(l) {
  const data = buildUnifiedInvoiceData({
    invoiceNo: "INV-RULE-001",
    docDate: "2026-08-07",
    customerName: "Test",
    items: [
      {
        id: "i1",
        productCode: "P1",
        productName: "Line",
        quantity: 1,
        priceSen: l.charge,
        lineTotalSen: l.charge,
        extra: l.ex,
      },
    ],
    subtotalSen: l.charge,
    totalSen: l.charge,
  });
  return data.groups.flatMap((g) => g.items)[0];
}

// ---------------------------------------------------------------------------
// (A) a build-up that does not reconcile is not displayed
// ---------------------------------------------------------------------------

test("screen: a build-up that does not sum to the charge is not displayed", () => {
  assert.equal(screenShowsBuildUp(LINES.contradicted), false);
  assert.equal(screenShowsBuildUp(LINES.zeroBase), false);
});

test("screen: what IS displayed instead is the charged price, unchanged", () => {
  // Nothing on a read path may move the charge — the line still reads RM 305.00.
  const l = LINES.contradicted;
  assert.equal(invoicePriceBuildUp(l.ex, l.charge), undefined);
  assert.notEqual(invoiceLineUnitSen(l.ex), l.charge, "fixture really is contradictory");
});

test("screen: a build-up that DOES reconcile is still itemised, ending in the charge", () => {
  const rows = invoicePriceBuildUp(LINES.itemised.ex, LINES.itemised.charge);
  assert.ok(rows, "healthy line keeps its itemisation");
  assert.deepEqual(rows.map((r) => r.label), ["Base", "+ T.Height", "="]);
  assert.equal(rows.at(-1).sen, LINES.itemised.charge);
});

test("PDF: refuses the same non-reconciling lines the screen refuses", () => {
  assert.equal(pdfLine(LINES.contradicted).priceBreakdown, undefined);
  assert.equal(pdfLine(LINES.zeroBase).priceBreakdown, undefined);
  assert.ok(pdfLine(LINES.itemised).priceBreakdown);
  assert.equal(pdfLine(LINES.contradicted).priceSen, LINES.contradicted.charge);
});

// ---------------------------------------------------------------------------
// (B) a no-op Save does not change the charged amount
// ---------------------------------------------------------------------------

// The invoice detail editor round-trips sen → RM string → sen. Mirrored here so
// the test measures what a real no-op Save would actually charge.
const toRm = (sen) => (Math.round(Number(sen) || 0) / 100).toFixed(2);
const toSen = (s) => Math.max(0, Math.round((Number(s) || 0) * 100));

/** Open the editor on a line, type nothing, press Save → the unit it writes. */
function noOpSaveCharges(l) {
  const seed = invoicePriceEditSeed(l.ex, l.charge);
  const draft = {
    base: toRm(seed.baseSen),
    divan: toRm(seed.divanSen),
    leg: toRm(seed.legSen),
    special: toRm(seed.specialSen),
    totalHeight: toRm(seed.totalHeightSen),
  };
  // Exactly what saveEditPrices sends, and what the backend priceEdits handler
  // stores as the new unitPriceSen.
  return invoiceLineUnitSen({
    baseSen: toSen(draft.base),
    divanSen: toSen(draft.divan),
    legSen: toSen(draft.leg),
    specialSen: toSen(draft.special),
    totalHeightSen: toSen(draft.totalHeight),
  });
}

test("Edit → Save with nothing typed charges exactly what was already charged", () => {
  for (const [name, l] of Object.entries(LINES)) {
    assert.equal(noOpSaveCharges(l), l.charge, `${name}: a no-op Save must not reprice`);
  }
});

test("the RM 305 → RM 307.98 silent reprice specifically cannot happen", () => {
  const l = LINES.contradicted;
  assert.equal(noOpSaveCharges(l), 30500);
  assert.notEqual(noOpSaveCharges(l), 30798);
});

test("a no-op Save is a no-op at any charge, including odd cents and zero", () => {
  for (const charge of [0, 1, 99, 30500, 30798, 109424, 1_000_003]) {
    for (const ex of [undefined, { baseSen: 1 }, { baseSen: 0, divanSen: 777 }]) {
      assert.equal(noOpSaveCharges({ charge, ex }), charge, `charge ${charge}`);
    }
  }
});

test("typing DOES move the charge — the guard must not freeze the editor", () => {
  const seed = invoicePriceEditSeed(LINES.itemised.ex, LINES.itemised.charge);
  const typed = { ...seed, legSen: 5000 };
  assert.equal(invoiceLineUnitSen(typed), LINES.itemised.charge + 5000);
});

// ---------------------------------------------------------------------------
// backend, frontend and PDF agree on the same line
// ---------------------------------------------------------------------------

// Minimal stub of the D1/PG handle computeInvoicePrintExtras talks to: route by
// the table named in the SQL. No delivery order, so the code takes its legacy
// code-keyed fallback — the exact path the ~7.4% of unlinked rows take.
function stubDb(tables) {
  const pick = (sql) => {
    if (sql.includes("FROM invoices")) return tables.invoices;
    if (sql.includes("FROM sales_order_items")) return tables.sales_order_items;
    if (sql.includes("FROM sales_orders")) return tables.sales_orders;
    if (sql.includes("FROM invoice_items")) return tables.invoice_items;
    return [];
  };
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async all() { return { results: pick(sql) ?? [] }; },
            async first() { return (pick(sql) ?? [])[0] ?? null; },
          };
        },
      };
    },
  };
}

/** Resolve one line through the real backend resolver. */
async function backendLine(l) {
  const db = stubDb({
    invoices: [{ id: "INV1", salesOrderId: "SO1", deliveryOrderId: null }],
    sales_orders: [
      { id: "SO1", companySO: "SO-1", companySOId: "SO-1", customerPO: "PO-1", customerSO: "CS-1", customerSOId: "CS-1", reference: "R1" },
    ],
    sales_order_items: [
      {
        salesOrderId: "SO1",
        productCode: "P1",
        fabricCode: "F1",
        sizeLabel: "K",
        itemCategory: "BEDFRAME",
        gapInches: null, divanHeightInches: null, legHeightInches: null,
        specialOrder: null,
        basePriceSen: l.ex?.baseSen ?? 0,
        divanPriceSen: l.ex?.divanSen ?? 0,
        legPriceSen: l.ex?.legSen ?? 0,
        specialOrderPriceSen: l.ex?.specialSen ?? 0,
        totalHeightPriceSen: l.ex?.totalHeightSen ?? 0,
        // The SALES ORDER's own unit — deliberately NOT the invoice's charge.
        unitPriceSen: invoiceLineUnitSen(l.ex ?? {}),
      },
    ],
    invoice_items: [
      {
        id: "ii1",
        productCode: "P1", fabricCode: "F1", sizeLabel: "K",
        basePriceSen: null, divanPriceSen: null, legPriceSen: null,
        specialOrderPriceSen: null, totalHeightPriceSen: null,
        unitPriceSen: l.charge,
        priceEdited: 0,
      },
    ],
  });
  const out = await computeInvoicePrintExtras(db, "INV1");
  return out.items.ii1;
}

test("backend reports the CHARGE as the line's unit, not the sales order's", async () => {
  const ex = await backendLine(LINES.contradicted);
  // The SO row's own unit is 30798; the invoice charges 30500. The resolver
  // must not hand the screen a "unit price" that is not the price charged.
  assert.equal(ex.unitSen, 30500);
});

test("backend, screen and PDF reach the same verdict on the same line", async () => {
  for (const [name, l] of Object.entries(LINES)) {
    if (!l.ex) continue; // nothing resolves → no line-level extra to compare
    const be = await backendLine(l);
    const onScreen = screenShowsBuildUp(l);
    const onPdf = pdfLine(l).priceBreakdown !== undefined;
    assert.equal(onScreen, onPdf, `${name}: screen and PDF must agree`);
    if (onScreen) {
      assert.equal(be.buildUpReconciles, true, `${name}: displayed ⇒ backend says it reconciles`);
    }
    // Whatever the verdict, all three quote the same charge.
    assert.equal(be.unitSen, l.charge, `${name}: backend charge`);
    assert.equal(pdfLine(l).priceSen, l.charge, `${name}: PDF charge`);
    assert.equal(noOpSaveCharges(l), l.charge, `${name}: editor charge`);
  }
});

test("backend flags the contradicted line as not reconciling", async () => {
  assert.equal((await backendLine(LINES.contradicted)).buildUpReconciles, false);
  assert.equal((await backendLine(LINES.zeroBase)).buildUpReconciles, false);
  assert.equal((await backendLine(LINES.itemised)).buildUpReconciles, true);
});

test("Save Prices writes the lines the operator changed, and no others", () => {
  // Owner's rule, settled 2026-08-07: "Save Prices" means save MY edits, not
  // freeze every line at whatever it currently reads.
  //
  // ---------------------------------------------------------------------
  // 2026-08-20 — THIS TEST USED TO PIN THE BUG IN PLACE. Read that twice.
  //
  // It asserted, as a REQUIREMENT:
  //
  //     assert.match(body, /if \(!was\) return true/,
  //       "no seed means treat it as edited, not skipped");
  //
  // That line is the defect. Combined with `priceDraft[id] || ZERO` it wrote
  // RM 0 into any line the editor held no values for — 112 lines across 17 SENT
  // invoices (BUG-2026-08-20-158). So the fault was not merely unnoticed: it was
  // PROTECTED. Anyone who fixed it would have turned this test red and been
  // told, by a passing-looking suite, that they had broken the rule.
  //
  // Two lessons, both cheap:
  //   1. This was a SOURCE-SHAPE assertion — it matched a regex against the
  //      component's text. A test that pins an implementation detail can pin a
  //      wrong one, and it cannot tell you which it is doing. The rule now lives
  //      in src/lib/invoice-price-edit-payload.ts and is tested BEHAVIOURALLY in
  //      tests/invoice-price-edit-no-implicit-zero.test.mjs.
  //   2. "No baseline, so assume it was edited" reads like caution and is the
  //      opposite. An absent value is not a value; the safe default is to write
  //      nothing.
  // ---------------------------------------------------------------------
  const src = readFileSync(resolve(process.cwd(), "src/pages/invoices/detail.tsx"), "utf8");

  // The component must delegate to the shared rule rather than re-deriving one.
  assert.match(
    src,
    /buildPriceEditPayload\(\{/,
    "the payload must come from @/lib/invoice-price-edit-payload, not from a local copy",
  );
  assert.doesNotMatch(
    src,
    /if \(!was\) return true/,
    "the pinned defect must not come back: a line with no baseline is UNKNOWN, not edited",
  );
  assert.doesNotMatch(
    src,
    /priceDraft\[id\] \|\| ZERO/,
    "a missing draft must never be read as a price of zero",
  );

  // The seed snapshot is still what an edit is measured against.
  assert.match(src, /setPriceSeed\(/, "the editor must snapshot what it opened with");
  assert.match(src, /setDiscountSeed\(/, "including the discounts");

  // The readback total must value untouched lines at their existing price, or
  // every partial edit would fail verification.
  assert.match(
    src,
    /: Number\(it\.unitPriceSen\) \|\| 0;/,
    "untouched lines keep their stored unit price in the expected-total check",
  );
});
