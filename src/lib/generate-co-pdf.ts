// Consignment Order PDF — thin wrapper over the shared renderer.
//
// Implementation lives in src/lib/generate-order-pdf.ts (closes DUP-005 in
// bug_audit_duplicate_logic.md — this file used to be a 460-line copy of
// generate-so-pdf.ts with 8 lines of meaningful diff). All layout / surcharge
// rendering / letterhead / totals tweaks should be made in the shared file
// so SO + CO never drift.
import type { Customer } from "@/lib/mock-data";
import type { ConsignmentOrder } from "@/types";
import { generateOrderPdf } from "./generate-order-pdf";

export function generateCOPdf(order: ConsignmentOrder, customer?: Customer | null) {
  generateOrderPdf(order, customer ?? null, {
    title: "CONSIGNMENT ORDER",
    documentNumber: order.companyCOId ?? "",
    documentDate: order.companyCODate,
    customerRefRows: [
      ["Customer CO", order.customerCOId || "-"],
    ],
    filename: order.companyCOId ?? order.id,
  });
}
