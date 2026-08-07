// ---------------------------------------------------------------------------
// invoice-price-by-po.test.mjs — BUG-2026-07-17-001, the PRICE half.
//
// The refs half was closed 2026-08-02 by resolving through the invoice line's
// own `invoice_items.production_order_id` (refByPo). The price build-up was
// left on the old first-one-wins `code|fabric|size` maps, so on a CONSOLIDATED
// delivery order a line could print a build-up taken off a DIFFERENT variant's
// sales-order row while the charged `unitPriceSen` came from the correct one —
// "Base 0 … = RM 305" on a line that turns into RM 308 the moment you press
// Edit (the editor seeds its components from that same guessed row).
//
// Two pins here:
//   1. computeInvoicePrintExtras resolves the build-up via priceByPo, so each
//      consolidated line gets ITS OWN sales order's figures; lines with no PO
//      link still fall through to the legacy maps.
//   2. Source-level structural pins on the invoice detail page (house style —
//      no DOM render): the edit view's three live sums + the discount base all
//      include T.Height, and the read view only itemises a build-up that
//      reconciles to the charged unit.
// ---------------------------------------------------------------------------
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeInvoicePrintExtras } from "../src/api/lib/invoice-print-extras.ts";
import { invoicePriceBreakdown } from "../src/lib/build-unified-doc-data.ts";

// ===========================================================================
// Fixture — one consolidated DO, two source SOs, the SAME product+fabric+size
// priced differently. This is the 152-DO shape from the bug entry.
// ===========================================================================
const CODE = "1013-(K)";
const FAB = "PC151-01";
const SIZE = "6FT";

// so-1 charges RM 305.00, so-2 charges RM 308.00 for the same variant.
const soItem = (salesOrderId, base, divan, leg, th) => ({
  salesOrderId,
  productCode: CODE,
  fabricCode: FAB,
  sizeLabel: SIZE,
  itemCategory: "BEDFRAME",
  gapInches: 12,
  divanHeightInches: 8,
  legHeightInches: 1,
  specialOrder: null,
  basePriceSen: base,
  divanPriceSen: divan,
  legPriceSen: leg,
  specialOrderPriceSen: 0,
  totalHeightPriceSen: th,
  unitPriceSen: base + divan + leg + th,
});

// so-1 FIRST in every result set — that is what first-one-wins would grab.
const SO_ITEMS = [
  soItem("so-1", 27500, 2000, 1000, 0), // = 30500
  soItem("so-2", 28800, 2000, 0, 0), //   = 30800
];

const DO_LINES = [
  { productionOrderId: "po-A", salesOrderId: "so-1", salesOrderNo: "SO-A", companySOId: "CSO-A" },
  { productionOrderId: "po-B", salesOrderId: "so-2", salesOrderNo: "SO-B", companySOId: "CSO-B" },
];

const doRefRow = (l) => ({
  productionOrderId: l.productionOrderId,
  productCode: CODE,
  fabricCode: FAB,
  sizeLabel: SIZE,
  salesOrderNo: l.salesOrderNo,
  customerPOId: `PO-${l.productionOrderId}`,
  customerReference: null,
  salesOrderId: l.salesOrderId,
  companySOId: l.companySOId,
  poProductCode: CODE,
  poFabricCode: FAB,
  poSizeLabel: SIZE,
  poGapInches: 12,
  poDivanHeightInches: 8,
  poLegHeightInches: 1,
});

const invItem = (id, productionOrderId) => ({
  id,
  productCode: CODE,
  fabricCode: FAB,
  sizeLabel: SIZE,
  basePriceSen: null,
  divanPriceSen: null,
  legPriceSen: null,
  specialOrderPriceSen: null,
  totalHeightPriceSen: null,
  priceEdited: 0,
  production_order_id: productionOrderId,
});

function makeDb({ invoiceItems }) {
  const route = (sql) => {
    if (sql.includes("FROM invoices WHERE id"))
      return [{ id: "inv-1", salesOrderId: null, deliveryOrderId: "do-1" }];
    if (sql.includes("po.customerReference AS r")) return [{ r: null }];
    if (sql.includes('po.productCode AS "poProductCode"')) return DO_LINES.map(doRefRow);
    if (sql.includes("di.salesOrderNo") && sql.includes("po.companySOId"))
      return DO_LINES.map((l) => ({
        salesOrderId: l.salesOrderId,
        companySOId: l.companySOId,
        salesOrderNo: l.salesOrderNo,
      }));
    if (sql.includes("FROM sales_orders"))
      return ["so-1", "so-2"].map((id) => ({
        id,
        companySO: `CSO-${id}`,
        companySOId: `CSO-${id}`,
        customerPO: `CPO-${id}`,
        customerSO: null,
        customerSOId: null,
        reference: null,
      }));
    if (sql.includes("FROM sales_order_items")) return SO_ITEMS;
    if (sql.includes("FROM invoice_items")) return invoiceItems;
    throw new Error(`unrouted SQL in fixture: ${sql.slice(0, 80)}`);
  };
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            async all() {
              return { results: route(sql) };
            },
            async first() {
              return route(sql)[0] ?? null;
            },
          };
        },
      };
    },
  };
}

// ===========================================================================
// 1. The price build-up follows the line's OWN production order
// ===========================================================================

test("consolidated line resolves its build-up via its OWN production_order_id", async () => {
  const ex = await computeInvoicePrintExtras(
    makeDb({ invoiceItems: [invItem("i1", "po-A"), invItem("i2", "po-B")] }),
    "inv-1",
  );
  // i1 came off so-1 (RM 305.00), i2 off so-2 (RM 308.00). First-one-wins gave
  // BOTH so-1's row — that is the "305 becomes 308" delta.
  assert.equal(ex.items.i1.unitSen, 30500);
  assert.equal(ex.items.i1.baseSen, 27500);
  assert.equal(ex.items.i1.legSen, 1000);
  assert.equal(ex.items.i2.unitSen, 30800);
  assert.equal(ex.items.i2.baseSen, 28800);
  assert.equal(ex.items.i2.legSen, 0);
});

test("every resolved build-up reconciles to the unit it belongs to", async () => {
  const ex = await computeInvoicePrintExtras(
    makeDb({ invoiceItems: [invItem("i1", "po-A"), invItem("i2", "po-B")] }),
    "inv-1",
  );
  for (const [id, v] of Object.entries(ex.items)) {
    assert.equal(
      v.baseSen + v.divanSen + v.legSen + v.totalHeightSen + v.specialSen,
      v.unitSen,
      `${id} must add up`,
    );
    // …and therefore the shared PDF/screen rule agrees to itemise it.
    assert.ok(invoicePriceBreakdown(v, v.unitSen), `${id} must be printable`);
  }
});

test("the per-line refs still follow the same production order (refs half stays fixed)", async () => {
  const ex = await computeInvoicePrintExtras(
    makeDb({ invoiceItems: [invItem("i1", "po-A"), invItem("i2", "po-B")] }),
    "inv-1",
  );
  assert.equal(ex.items.i1.customerPOId, "PO-po-A");
  assert.equal(ex.items.i2.customerPOId, "PO-po-B");
});

test("a line with NO production_order_id still resolves through the legacy maps", async () => {
  const ex = await computeInvoicePrintExtras(
    makeDb({ invoiceItems: [invItem("legacy", null)] }),
    "inv-1",
  );
  // Legacy = first-one-wins across the source SOs, i.e. so-1's row. Kept only
  // for rows written before invoice_items.production_order_id existed; the
  // point of the pin is that removing the guess did NOT remove the fallback.
  assert.equal(ex.items.legacy.unitSen, 30500);
  assert.equal(ex.items.legacy.baseSen, 27500);
});

test("an unknown production_order_id falls back rather than rendering nothing", async () => {
  const ex = await computeInvoicePrintExtras(
    makeDb({ invoiceItems: [invItem("orphan", "po-GONE")] }),
    "inv-1",
  );
  assert.ok(ex.items.orphan, "an orphan link must not drop the line's extras");
  assert.equal(ex.items.orphan.unitSen, 30500);
});

// ===========================================================================
// 2. Invoice detail page — structural pins
// ===========================================================================

const src = readFileSync(resolve(process.cwd(), "src/pages/invoices/detail.tsx"), "utf8");
const flat = src.replace(/\s+/g, " ");

// Slice `const <name> = ` up to the terminating `;` at the same nesting depth.
function decl(name) {
  const start = src.indexOf(`const ${name} =`);
  assert.ok(start !== -1, `${name} must exist in invoices/detail.tsx`);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === ";" && depth === 0) return src.slice(start, i + 1).replace(/\s+/g, " ");
  }
  throw new Error(`could not slice ${name}`);
}

test("edit view: the per-line live Unit includes T.Height", () => {
  const s = decl("liveUnit");
  for (const k of ["base", "divan", "leg", "special", "totalHeight"])
    assert.match(s, new RegExp(`sen\\(d\\.${k}\\)`), `liveUnit must sum ${k}`);
});

test("edit view: the header total includes T.Height", () => {
  const s = decl("liveInvoiceTotalSen");
  for (const k of ["base", "divan", "leg", "special", "totalHeight"])
    assert.match(s, new RegExp(`sen\\(dd\\.${k}\\)`), `header total must sum ${k}`);
});

test("edit view: the footer Subtotal includes T.Height", () => {
  const s = decl("liveSubtotal");
  for (const k of ["base", "divan", "leg", "special", "totalHeight"])
    assert.match(s, new RegExp(`sen\\(dd\\.${k}\\)`), `subtotal must sum ${k}`);
});

test("edit view: the discount base is the live Unit, so it inherits T.Height", () => {
  // DiscountInput computes a % off baseAmountSen. Deriving it from liveUnit is
  // what keeps a %-discount typed during edit off the FULL price.
  assert.match(flat, /baseAmountSen=\{liveUnit \* qty\}/);
});

test("read view: a build-up is itemised ONLY through the shared reconciliation rule", () => {
  assert.match(src, /import \{ invoicePriceBreakdown \} from "@\/lib\/build-unified-doc-data"/);
  assert.match(flat, /invoicePriceBreakdown\(ex, liveUnit\)/);
  // The unguarded render is gone — it is what displayed "Base 0 … = RM 305".
  assert.ok(
    !/<div>Base \{formatCurrency\(ex\.baseSen\)\}<\/div>/.test(flat),
    "the unguarded Base row must not be rendered",
  );
});

test("read view: a build-up that does not add up is suppressed, not shown", () => {
  // The rule itself (shared with the PDF): components must equal the charge.
  assert.equal(
    invoicePriceBreakdown({ baseSen: 0, divanSen: 2000, legSen: 1000 }, 30500),
    undefined,
  );
  assert.ok(invoicePriceBreakdown({ baseSen: 27500, divanSen: 2000, legSen: 1000 }, 30500));
});
