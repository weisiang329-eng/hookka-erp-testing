// ---------------------------------------------------------------------------
// so-detail-listing — the AutoCount-style "Sales Order Detail Listing" export.
//
// Target shape (owner's dridtable.xlsx): 36 columns, ONE ROW PER LINE ITEM,
// with the document header fields (Doc No, Date, Debtor, totals, Cancelled…)
// repeated on every line, then per-line fields (Item Group, Code, Description,
// UOM, Qty, Unit Price, per-line totals). A 5-line SO becomes 5 rows.
//
// Pure so the row mapping is unit-tested. Columns the Hookka SO model doesn't
// carry (Debtor Code, Agent, tax, exemption date, creditor/PO-post) are left
// blank rather than invented — flagged in the PR so the owner can say where to
// source them.
// ---------------------------------------------------------------------------

import type { Aoa } from "./export-report";

// Structural subset of SalesOrder / SalesOrderItem — only what this export
// reads, so the lib stays decoupled and testable without the full types.
export type DetailItem = {
  itemCategory?: string | null;
  productCode?: string | null;
  productName?: string | null;
  sizeLabel?: string | null;
  fabricCode?: string | null;
  quantity?: number | null;
  gapInches?: number | null;
  divanHeightInches?: number | null;
  legHeightInches?: number | null;
  specialOrder?: string | null;
  unitPriceSen?: number | null;
  lineTotalSen?: number | null;
};
export type DetailOrder = {
  companySOId?: string | null;
  companySODate?: string | null;
  customerName?: string | null;
  customerState?: string | null;
  customerPOId?: string | null;
  reference?: string | null;
  subtotalSen?: number | null;
  totalSen?: number | null;
  status?: string | null;
  items?: DetailItem[] | null;
};

export const SO_DETAIL_HEADERS = [
  "Check", "Doc. No.", "Date", "Debtor Code", "Debtor Name", "Agent",
  "Curr. Code", "Inclusive?", "SubTotal (Ex)", "Tax", "Total", "Local Total",
  "Cancelled", "Remark 4", "Sales Exemption Expiry Date", "Processing Date",
  "Item Group", "Item Code", "Detail Description", "UOM", "Location",
  "Detail Description 2", "Qty", "Unit Price", "Discount", "Detail Tax Code",
  "Total", "Tax", "Total (Ex)", "Total (Inc)", "Creditor Code", "Post to PO",
  "BALANCE", "PAYEMENT", "Remark6", "Remark5",
] as const;

const rm = (sen: number | null | undefined): number => Math.round(Number(sen) || 0) / 100;
const day = (iso: string | null | undefined): string => {
  const s = String(iso ?? "");
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
};

/** The "Detail Description 2" spec line — divan/leg/gap/special, blank parts
 *  omitted (mirrors what the invoice shows). */
export function detailDescription2(it: DetailItem): string {
  const bits: string[] = [];
  if (it.divanHeightInches) bits.push(`div:${it.divanHeightInches}inch`);
  if (it.legHeightInches) bits.push(`leg:${it.legHeightInches}inch`);
  if (it.gapInches) bits.push(`gap:${it.gapInches}inch`);
  const sp = (it.specialOrder ?? "").trim();
  if (sp) bits.push(sp);
  return bits.join(" / ");
}

/** One AutoCount detail row per line item, header fields repeated. */
export function buildSoDetailListingAoa(orders: DetailOrder[]): Aoa {
  const body: (string | number)[][] = [];
  for (const o of orders) {
    const cancelled = String(o.status ?? "").toUpperCase() === "CANCELLED" ? "T" : "F";
    const items = o.items && o.items.length > 0 ? o.items : [{} as DetailItem];
    for (const it of items) {
      body.push([
        "", // Check
        o.companySOId ?? "",
        day(o.companySODate),
        "", // Debtor Code — not on the SO model
        o.customerName ?? "",
        "", // Agent — salesperson not carried on the SO
        "MYR",
        "", // Inclusive?
        rm(o.subtotalSen), // SubTotal (Ex)
        0, // Tax
        rm(o.totalSen), // Total
        rm(o.totalSen), // Local Total
        cancelled,
        o.reference ?? "", // Remark 4
        "", // Sales Exemption Expiry Date
        "", // Processing Date
        it.itemCategory ?? "", // Item Group
        it.productCode ?? "", // Item Code
        it.productName ?? "", // Detail Description
        "UNIT", // UOM
        o.customerState ?? "", // Location
        detailDescription2(it), // Detail Description 2
        Number(it.quantity) || 0, // Qty
        rm(it.unitPriceSen), // Unit Price
        "", // Discount
        "", // Detail Tax Code
        rm(it.lineTotalSen), // Total
        0, // Tax
        rm(it.lineTotalSen), // Total (Ex)
        rm(it.lineTotalSen), // Total (Inc)
        "", // Creditor Code
        "", // Post to PO
        "", // BALANCE
        o.customerPOId ?? "", // PAYEMENT (customer PO ref, as in the sample)
        "", // Remark6
        "", // Remark5
      ]);
    }
  }
  return [SO_DETAIL_HEADERS as unknown as string[], ...body];
}
