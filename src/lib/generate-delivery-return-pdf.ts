// Delivery Return PDF — one shared letterhead (drawLetterhead) + a meta block
// + the returned-items table. Greyscale, matches the DO / CN document family.
import jsPDF from "jspdf";
import autoTable, { type RowInput } from "jspdf-autotable";
import { fmtDate, drawLetterhead } from "@/lib/pdf-utils";

export type DeliveryReturnPdfItem = {
  productCode?: string;
  productName?: string;
  wipLabel?: string;
  quantity?: number;
  problem?: string;
};
export type DeliveryReturnPdf = {
  returnNo: string;
  companySOId?: string;
  doNo?: string;
  customerName?: string;
  customerPOId?: string;
  returnType?: string;
  reason?: string;
  items: DeliveryReturnPdfItem[];
};

const INK: [number, number, number] = [17, 17, 17];
const MUTED: [number, number, number] = [110, 110, 110];

function typeLabel(t?: string): string {
  if (t === "PURE_RETURN") return "Pure return";
  if (t === "REPAIR_REDELIVER") return "Repair & re-deliver";
  return "—";
}

export function generateDeliveryReturnPdf(dr: DeliveryReturnPdf): void {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  let y = drawLetterhead(doc, {
    docTitle: "DELIVERY RETURN",
    docNo: dr.returnNo,
    docDate: fmtDate(new Date().toISOString()),
    statusText: typeLabel(dr.returnType),
  });
  y += 4;

  const m = 14;
  const meta: [string, string][] = [
    ["From sales order", dr.companySOId || "—"],
    ["Original DO", dr.doNo || "—"],
    ["Customer", dr.customerName || "—"],
    ["Customer PO", dr.customerPOId || "—"],
  ];
  doc.setFontSize(8);
  const colW = (doc.internal.pageSize.getWidth() - m * 2) / 2;
  meta.forEach((row, i) => {
    const col = i % 2;
    const line = Math.floor(i / 2);
    const x = m + col * colW;
    const yy = y + line * 9;
    doc.setTextColor(...MUTED);
    doc.text(row[0], x, yy);
    doc.setTextColor(...INK);
    doc.setFont("helvetica", "bold");
    doc.text(row[1], x, yy + 4);
    doc.setFont("helvetica", "normal");
  });
  y += Math.ceil(meta.length / 2) * 9 + 4;

  const body: RowInput[] = dr.items.map((it) => [
    it.productCode || "",
    it.productName || "",
    it.wipLabel || "",
    String(it.quantity ?? 1),
    it.problem || "",
  ]);
  autoTable(doc, {
    startY: y,
    head: [["Product", "Description", "WIP", "Qty", "Problem"]],
    body,
    theme: "grid",
    styles: { fontSize: 8, textColor: INK, lineColor: [200, 200, 200] },
    headStyles: { fillColor: [232, 232, 232], textColor: INK, fontStyle: "bold" },
    columnStyles: { 3: { halign: "center", cellWidth: 14 } },
    margin: { left: m, right: m },
  });

  if (dr.reason) {
    const afterY =
      (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable
        ?.finalY ?? y;
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    doc.text(`Reason: ${dr.reason}`, m, afterY + 8);
  }

  doc.save(`${dr.returnNo}.pdf`);
}
