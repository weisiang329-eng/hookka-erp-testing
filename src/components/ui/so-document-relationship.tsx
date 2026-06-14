import { useMemo } from "react";
import { useCachedJson } from "@/lib/cached-fetch";
import DocumentFlowDiagram, { type DocNode } from "./document-flow-diagram";

// ---------------------------------------------------------------------------
// Reusable Document Relationship graph for ANY document in a Sales-Order chain.
//
// Give it the SO id that anchors the chain and (optionally) the doc number of
// the page you're viewing — that node is highlighted as "current". It fetches
// the same /api/sales-orders/:id payload the SO detail page uses (linkedDOs /
// invoices / payments / POs, resolved server-side incl. consolidated DOs) and
// renders the shared DocumentFlowDiagram. This is what lets the DO and Invoice
// detail pages show the SAME relationship graph — "click into any document and
// see how it connects" — without each page re-implementing the assembly.
//
// Renders nothing until the chain loads (or if there's no SO to anchor on), so
// it's safe to drop in unconditionally.
// ---------------------------------------------------------------------------

const DO_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Pending Dispatch",
  LOADED: "Dispatched",
  IN_TRANSIT: "In Transit",
  DELIVERED: "Delivered",
  INVOICED: "Invoiced",
  CLOSED: "Closed",
};

interface SoChainResp {
  success?: boolean;
  data?: { id: string; companySOId?: string; status?: string };
  linkedDOs?: { id: string; doNo: string; status: string }[];
  linkedInvoices?: { id: string; invoiceNo: string; status: string }[];
  linkedPayments?: { id: string; receiptNumber: string; status: string }[];
  linkedPOs?: { id: string; poNo: string; status: string }[];
}

export function SoDocumentRelationship({
  soId,
  currentDocNo,
}: {
  soId?: string | null;
  currentDocNo?: string;
}) {
  const { data } = useCachedJson<SoChainResp>(
    soId ? `/api/sales-orders/${soId}` : null,
  );

  const flow = useMemo(() => {
    if (!data?.success || !data.data) return null;
    const so = data.data;
    const soNo = so.companySOId ?? "";
    const nodes: DocNode[] = [
      {
        type: "SO",
        label: "Sales Order",
        docNo: soNo,
        status: so.status,
        isCurrent: !!currentDocNo && currentDocNo === soNo,
        href: `/sales/${so.id}`,
      },
    ];
    for (const d of data.linkedDOs ?? []) {
      nodes.push({
        type: "DO",
        label: "Delivery Order",
        docNo: d.doNo,
        status: DO_STATUS_LABEL[d.status] ?? d.status,
        isCurrent: !!currentDocNo && currentDocNo === d.doNo,
        href: `/delivery/${d.id}`,
      });
    }
    for (const inv of data.linkedInvoices ?? []) {
      nodes.push({
        type: "INVOICE",
        label: "Invoice",
        docNo: inv.invoiceNo,
        status: inv.status,
        isCurrent: !!currentDocNo && currentDocNo === inv.invoiceNo,
        href: `/invoices/${inv.id}`,
      });
    }
    for (const p of data.linkedPayments ?? []) {
      nodes.push({
        type: "AR_PAYMENT",
        label: "AR Payment",
        docNo: p.receiptNumber,
        status: p.status,
        href: `/invoices/payments`,
      });
    }
    const pos = data.linkedPOs ?? [];
    const purchaseFlow: DocNode[] | undefined =
      pos.length > 0
        ? [
            {
              type: "PRODUCTION",
              label: "Production Order",
              docNo: pos[0].poNo,
              status: pos[0].status,
            },
          ]
        : undefined;
    return { soNo, nodes, purchaseFlow, hasPo: pos.length > 0 };
  }, [data, currentDocNo]);

  if (!flow) return null;

  return (
    <DocumentFlowDiagram
      title={`Document Relationship — ${flow.soNo}`}
      salesFlow={flow.nodes}
      purchaseFlow={flow.purchaseFlow}
      crossLinks={
        flow.hasPo
          ? [{ fromRow: "sales", fromIdx: 0, toRow: "purchase", toIdx: 0, type: "full" }]
          : undefined
      }
    />
  );
}
