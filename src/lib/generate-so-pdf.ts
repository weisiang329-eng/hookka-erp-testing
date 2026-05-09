// Sales Order PDF — thin wrapper over the shared renderer.
//
// Implementation lives in src/lib/generate-order-pdf.ts (closes DUP-005 in
// bug_audit_duplicate_logic.md — this file used to be a 460-line copy of
// generate-co-pdf.ts with 8 lines of meaningful diff). All layout / surcharge
// rendering / letterhead / totals tweaks should be made in the shared file
// so SO + CO never drift.
import type { SalesOrder, Customer } from "@/lib/mock-data";
import { generateOrderPdf } from "./generate-order-pdf";

export function generateSOPdf(order: SalesOrder, customer?: Customer | null) {
  generateOrderPdf(order, customer ?? null, {
    title: "SALES ORDER",
    documentNumber: order.companySOId,
    documentDate: order.companySODate,
    customerRefRows: [
      ["Customer PO", order.customerPOId || "-"],
      ["Customer SO", order.customerSOId || "-"],
    ],
    filename: order.companySOId,
  });
}
