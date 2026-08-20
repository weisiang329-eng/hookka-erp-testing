// ---------------------------------------------------------------------------
// invoice-detail-listing — the per-line "Invoice Detail Listing" export.
//
// ONE ROW PER LINE ITEM, document header fields repeated on every line, in the
// same shape as the Sales Order / PO / GRN / DO listings (so-detail-listing.ts,
// doc-detail-listings.ts). Invoices were the one module without one, and the
// reason was written down in `src/pages/invoices/index.tsx`: the list endpoint
// ships `items: []` on every row, so a per-line export needed a per-invoice
// re-fetch that nobody had built. The caller does that fetch; this file only
// maps the result, so the mapping stays unit-testable without a database.
//
// ## Two columns the other listings do not have
//
// **The price build-up.** Base / Divan / Leg / T.Height / Special. The owner's
// reason for asking (2026-08-20) was to check prices in bulk, and a Unit Price
// on its own cannot be checked — you have to open the invoice. With the
// components spelled out, `Base + Divan + Leg + T.Height + Special = Unit Price`
// is a formula in a spreadsheet column, and every line that does not add up
// sorts to the top.
//
// A component that does not apply to the line's category renders BLANK, not
// 0.00 — rule 6 of `invoice-line-price.ts`. A sofa has no divan; printing
// "0.00" there states a fact about a thing that does not exist. Blank says
// "not applicable"; zero says "it costs nothing". They are different claims.
//
// **`Line ID`.** A technical column, and the one that makes a round trip
// possible: an invoice can carry the SAME product code on several lines
// (INV-2608-031 has `1007-(Q)` four times), so invoice number + item code does
// not identify a line. Matching on this id survives the operator sorting,
// filtering or reordering the sheet in Excel — matching on row position does
// not.
// ---------------------------------------------------------------------------

import type { Aoa } from "./export-report";
import { priceComponentApplies } from "./invoice-line-price";

const rm = (sen: number | null | undefined): number => Math.round(Number(sen) || 0) / 100;
const num = (n: number | null | undefined): number => Number(n) || 0;
const day = (iso: string | null | undefined): string => (iso ? String(iso).slice(0, 10) : "");

/**
 * A component cell: blank when the component does not apply to this line's
 * category, otherwise the value in ringgit. See rule 6.
 */
const comp = (
  key: "base" | "divan" | "leg" | "totalHeight" | "special",
  category: string | null | undefined,
  sen: number | null | undefined,
): string | number => (priceComponentApplies(key, category, Number(sen) || 0) ? rm(sen) : "");

export type InvoiceDetailItem = {
  id?: string | null;
  productCode?: string | null;
  productName?: string | null;
  sizeLabel?: string | null;
  fabricCode?: string | null;
  quantity?: number | null;
  unitPriceSen?: number | null;
  discountSen?: number | null;
  totalSen?: number | null;
  basePriceSen?: number | null;
  divanPriceSen?: number | null;
  legPriceSen?: number | null;
  totalHeightPriceSen?: number | null;
  specialOrderPriceSen?: number | null;
  priceEdited?: number | null;
  /** From /print-extras — the line's category and its resolved references. */
  itemCategory?: string | null;
  customerPOId?: string | null;
  customerSOLine?: string | null;
  companySO?: string | null;
};

export type InvoiceDetailDoc = {
  id?: string | null;
  invoiceNo?: string | null;
  invoiceDate?: string | null;
  dueDate?: string | null;
  customerName?: string | null;
  customerPOId?: string | null;
  companySOId?: string | null;
  status?: string | null;
  subtotalSen?: number | null;
  totalSen?: number | null;
  paidAmount?: number | null;
  items?: InvoiceDetailItem[] | null;
};

export const INVOICE_DETAIL_HEADERS = [
  "Doc. No.", "Date", "Due Date", "Debtor Name", "Status",
  "Doc SubTotal", "Doc Total", "Paid",
  "Cust. PO", "Cust. SO Ref", "Our SO",
  "Item Code", "Detail Description", "Size", "Fabric", "Category", "Qty",
  "Base", "Divan", "Leg", "T.Height", "Special",
  "Unit Price", "Discount", "Line Total",
  "Build-up Reconciles", "Price Edited", "Line ID",
] as const;

/**
 * Does the build-up account for the charge?
 *
 * "YES" / "NO" / "" — and the blank is load-bearing. An unresolved build-up
 * (all five components zero on a line that charges something) is not a
 * mismatch, it is an absence: the components were never recorded for that line.
 * Reporting it as "NO" would send the operator hunting for an error that isn't
 * there. Today's bug was an absence read as a value; this column refuses to
 * repeat it.
 */
export function reconcilesCell(it: InvoiceDetailItem): string {
  const unit = Number(it.unitPriceSen) || 0;
  const sum =
    (Number(it.basePriceSen) || 0) +
    (Number(it.divanPriceSen) || 0) +
    (Number(it.legPriceSen) || 0) +
    (Number(it.totalHeightPriceSen) || 0) +
    (Number(it.specialOrderPriceSen) || 0);
  if (sum === 0 && unit !== 0) return "";
  return sum === unit ? "YES" : "NO";
}

export function buildInvoiceDetailListingAoa(docs: InvoiceDetailDoc[]): Aoa {
  const body: (string | number)[][] = [];
  for (const d of docs) {
    // An invoice with no lines still gets one row: dropping it silently would
    // make the export disagree with the invoice count on screen.
    const items = d.items && d.items.length > 0 ? d.items : [{} as InvoiceDetailItem];
    for (const it of items) {
      const cat = it.itemCategory;
      body.push([
        d.invoiceNo ?? "",
        day(d.invoiceDate),
        day(d.dueDate),
        d.customerName ?? "",
        d.status ?? "",
        rm(d.subtotalSen),
        rm(d.totalSen),
        rm(d.paidAmount),
        it.customerPOId ?? d.customerPOId ?? "",
        it.customerSOLine ?? "",
        it.companySO ?? d.companySOId ?? "",
        it.productCode ?? "",
        it.productName ?? "",
        it.sizeLabel ?? "",
        it.fabricCode ?? "",
        cat ?? "",
        num(it.quantity),
        comp("base", cat, it.basePriceSen),
        comp("divan", cat, it.divanPriceSen),
        comp("leg", cat, it.legPriceSen),
        comp("totalHeight", cat, it.totalHeightPriceSen),
        comp("special", cat, it.specialOrderPriceSen),
        rm(it.unitPriceSen),
        rm(it.discountSen),
        rm(it.totalSen),
        reconcilesCell(it),
        Number(it.priceEdited) === 1 ? "YES" : "",
        it.id ?? "",
      ]);
    }
  }
  return [INVOICE_DETAIL_HEADERS as unknown as string[], ...body];
}
