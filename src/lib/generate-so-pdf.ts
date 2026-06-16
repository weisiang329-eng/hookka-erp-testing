// Sales Order PDF — thin wrapper over the shared renderer.
//
// Implementation lives in src/lib/generate-order-pdf.ts (closes DUP-005 in
// bug_audit_duplicate_logic.md — this file used to be a 460-line copy of
// generate-co-pdf.ts with 8 lines of meaningful diff). All layout / surcharge
// rendering / letterhead / totals tweaks should be made in the shared file
// so SO + CO never drift.
import type { SalesOrder, Customer } from "@/lib/mock-data";
import type jsPDF from "jspdf";
import { generateOrderPdf } from "./generate-order-pdf";

// The SO layout config — shared by the single download and the bulk merge so
// they never drift. Typed off generateOrderPdf's own param so no cast is needed.
const soVariant = (
  order: SalesOrder,
): Parameters<typeof generateOrderPdf>[2] => ({
  title: "SALES ORDER",
  documentNumber: order.companySOId,
  documentDate: order.companySODate,
  customerRefRows: [
    ["Customer PO", order.customerPOId || "-"],
    ["Customer SO", order.customerSOId || "-"],
  ],
  filename: order.companySOId,
});

export function generateSOPdf(order: SalesOrder, customer?: Customer | null) {
  generateOrderPdf(order, customer ?? null, soVariant(order));
}

// Merge several sales orders into ONE downloadable PDF (Sales Orders list →
// bulk "Download PDF"). Each order renders with the SAME layout as the single
// download, then merge-pdf stitches them into one file.
export async function generateCombinedSOPdf(
  items: { order: SalesOrder; customer?: Customer | null }[],
  filename = "SalesOrders.pdf",
): Promise<void> {
  if (items.length === 0) return;
  const docs = items
    .map(({ order, customer }) =>
      generateOrderPdf(order, customer ?? null, soVariant(order), {
        returnDoc: true,
      }),
    )
    .filter((d): d is jsPDF => !!d);
  const { downloadMergedPdf } = await import("./merge-pdf");
  await downloadMergedPdf(docs, filename);
}
