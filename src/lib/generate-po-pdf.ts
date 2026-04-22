import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

// Department colors matching the app
const DEPT_COLORS: Record<string, [number, number, number]> = {
  FAB_CUT: [59, 130, 246],
  FAB_SEW: [99, 102, 241],
  WOOD_CUT: [245, 158, 11],
  FOAM: [139, 92, 246],
  FRAMING: [249, 115, 22],
  WEBBING: [16, 185, 129],
  UPHOLSTERY: [244, 63, 94],
  PACKING: [6, 182, 212],
};

type JobCard = {
  id: string;
  departmentCode: string;
  departmentName: string;
  status: string;
  dueDate: string;
  pic1Name: string;
  pic2Name: string;
  completedDate: string | null;
  estMinutes: number;
  actualMinutes: number | null;
  category: string;
  overdue: string;
};

type ProductionOrder = {
  id: string;
  poNo: string;
  companySOId: string;
  customerName: string;
  customerState: string;
  customerPOId: string;
  productCode: string;
  productName: string;
  itemCategory: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  specialOrder: string;
  notes: string;
  jobCards: JobCard[];
};

function fmtDate(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" });
}

// Generate a single job card PDF for one department
export function generateJobCardPdf(order: ProductionOrder, deptCode: string) {
  const jobCard = order.jobCards.find((j) => j.departmentCode === deptCode);
  if (!jobCard) return;

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 15;
  let y = margin;

  // --- Header ---
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text(jobCard.departmentName.toUpperCase(), margin, 12);
  doc.setFontSize(10);
  doc.text("JOB CARD", margin, 19);
  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text("HOOKKA INDUSTRIES SDN BHD", margin, 24);

  // PO Number on right
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text(order.poNo, pageW - margin, 12, { align: "right" });
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text(`SO: ${order.companySOId}`, pageW - margin, 19, { align: "right" });

  // Category as plain text
  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text(`CAT: ${jobCard.category}`, pageW - margin, 24, { align: "right" });

  // Divider line
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.5);
  doc.line(margin, 28, pageW - margin, 28);

  y = 33;
  doc.setTextColor(31, 29, 27);

  // --- Product Info Box ---
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("PRODUCT DETAILS", margin + 3, y + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(margin, y + 7, pageW - margin, y + 7);
  y += 10;

  const productFields = [
    ["Product", `${order.productName} (${order.productCode})`],
    ["Category", order.itemCategory],
    ["Size", order.sizeLabel],
    ["Fabric", order.fabricCode],
    ["Quantity", String(order.quantity)],
  ];

  doc.setFontSize(9);
  for (const [label, value] of productFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(107, 114, 128);
    doc.text(label, margin + 3, y);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    doc.text(String(value), margin + 35, y);
    y += 6;
  }

  // --- Customizations ---
  const customizations: string[] = [];
  if (order.gapInches) customizations.push(`Gap: ${order.gapInches}"`);
  if (order.divanHeightInches) customizations.push(`Divan Height: ${order.divanHeightInches}"`);
  if (order.legHeightInches) customizations.push(`Leg Height: ${order.legHeightInches}"`);
  if (order.specialOrder) customizations.push(`Special: ${order.specialOrder.replace(/_/g, " ")}`);

  if (customizations.length > 0) {
    y += 2;
    // White background with bold outline — no ink-heavy yellow fill
    doc.setDrawColor(0, 0, 0);
    doc.setLineWidth(0.4);
    doc.rect(margin, y, pageW - margin * 2, 8 + customizations.length * 5, "S");
    doc.setLineWidth(0.2);
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0, 0, 0);
    doc.text("CUSTOMIZATIONS", margin + 3, y + 5);
    y += 8;
    doc.setFont("helvetica", "normal");
    for (const c of customizations) {
      doc.text(`• ${c}`, margin + 5, y);
      y += 5;
    }
    y += 2;
  }

  y += 5;

  // --- Customer Info ---
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("ORDER INFO", margin + 3, y + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(margin, y + 7, pageW - margin, y + 7);
  y += 10;

  const orderFields = [
    ["Customer", `${order.customerName} (${order.customerState})`],
    ["Customer PO", order.customerPOId || "-"],
    ["Due Date", fmtDate(jobCard.dueDate)],
    ["Est. Time", `${jobCard.estMinutes} min`],
  ];

  doc.setFontSize(9);
  for (const [label, value] of orderFields) {
    doc.setFont("helvetica", "normal");
    doc.setTextColor(107, 114, 128);
    doc.text(label, margin + 3, y);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(31, 29, 27);
    doc.text(String(value), margin + 35, y);
    y += 6;
  }

  y += 5;

  // --- Worker Assignment Box ---
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("WORKER ASSIGNMENT", margin + 3, y + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(margin, y + 7, pageW - margin, y + 7);
  y += 10;

  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(107, 114, 128);
  doc.text("PIC 1:", margin + 3, y);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text(jobCard.pic1Name || "___________________", margin + 25, y);

  doc.setFont("helvetica", "normal");
  doc.setTextColor(107, 114, 128);
  doc.text("PIC 2:", pageW / 2, y);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(31, 29, 27);
  doc.text(jobCard.pic2Name || "___________________", pageW / 2 + 22, y);
  y += 10;

  // --- Sign-off Section ---
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(0, 0, 0);
  doc.text("COMPLETION", margin + 3, y + 5);
  doc.setDrawColor(180, 180, 180);
  doc.line(margin, y + 7, pageW - margin, y + 7);
  y += 12;

  // Completion fields with blank lines for writing
  const completionFields = [
    "Start Date / Time: _______________________________",
    "End Date / Time:   _______________________________",
    "Actual Time (min): _______________________________",
    "QC Passed:  [ ] Yes   [ ] No   Remarks: __________",
  ];

  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(31, 29, 27);
  for (const field of completionFields) {
    doc.text(field, margin + 3, y);
    y += 8;
  }

  y += 5;

  // --- Notes ---
  if (order.notes) {
    doc.setDrawColor(200, 200, 200);
    doc.rect(margin, y, pageW - margin * 2, 15, "S");
    doc.setFontSize(7);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(0, 0, 0);
    doc.text("NOTES", margin + 3, y + 4);
    doc.setFont("helvetica", "normal");
    doc.setTextColor(80, 80, 80);
    doc.text(order.notes, margin + 3, y + 9, { maxWidth: pageW - margin * 2 - 6 });
  }

  // --- Footer ---
  const footerY = doc.internal.pageSize.getHeight() - 12;
  doc.setDrawColor(226, 221, 216);
  doc.line(margin, footerY - 3, pageW - margin, footerY - 3);
  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(156, 163, 175);
  doc.text(`HOOKKA INDUSTRIES  |  ${jobCard.departmentName} Job Card  |  ${order.poNo}`, margin, footerY);
  doc.text(`Printed: ${new Date().toLocaleDateString("en-MY")}`, pageW - margin, footerY, { align: "right" });

  doc.save(`${order.poNo}-${deptCode}.pdf`);
}

// Generate a full production order PDF with all 8 departments
export function generateFullPOPdf(order: ProductionOrder) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 10;
  let y = margin;

  // Header
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(14);
  doc.setFont("helvetica", "bold");
  doc.text("PRODUCTION ORDER", margin, 10);
  doc.setFontSize(10);
  doc.text(order.poNo, margin, 17);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(80, 80, 80);
  doc.text(`${order.productName} (${order.productCode})  |  ${order.sizeLabel}  |  Fabric: ${order.fabricCode}  |  Qty: ${order.quantity}`, pageW / 3, 10);
  doc.text(`Customer: ${order.customerName}  |  SO: ${order.companySOId}  |  PO: ${order.customerPOId || "-"}`, pageW / 3, 17);

  // Divider line
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.5);
  doc.line(margin, 21, pageW - margin, 21);

  y = 26;

  // Department tracking table
  const deptData = order.jobCards.map((jc) => [
    jc.departmentName,
    jc.category,
    jc.status.replace(/_/g, " "),
    fmtDate(jc.dueDate),
    jc.pic1Name || "-",
    jc.pic2Name || "-",
    jc.completedDate ? fmtDate(jc.completedDate) : "",
    jc.actualMinutes ? `${jc.actualMinutes} min` : "",
    jc.overdue === "OVERDUE" ? "OVERDUE" : "",
  ]);

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [["Department", "CAT", "Status", "Due Date", "PIC 1", "PIC 2", "Completed", "Actual Time", "Overdue"]],
    body: deptData,
    styles: {
      fontSize: 8,
      cellPadding: 2.5,
      textColor: [31, 29, 27],
      lineColor: [226, 221, 216],
      lineWidth: 0.3,
    },
    headStyles: {
      fillColor: [255, 255, 255],
      textColor: [0, 0, 0],
      fontSize: 8,
      fontStyle: "bold",
      lineColor: [0, 0, 0],
      lineWidth: 0.3,
    },
    bodyStyles: {},
    didParseCell: (data) => {
      if (data.section === "body" && data.column.index === 0) {
        const deptCode = order.jobCards[data.row.index]?.departmentCode;
        const c = DEPT_COLORS[deptCode];
        if (c) {
          data.cell.styles.textColor = c;
          data.cell.styles.fontStyle = "bold";
        }
      }
      if (data.section === "body" && data.column.index === 2) {
        const status = order.jobCards[data.row.index]?.status;
        if (status === "COMPLETED") data.cell.styles.textColor = [22, 163, 74];
        else if (status === "IN_PROGRESS") data.cell.styles.textColor = [59, 130, 246];
        else if (status === "BLOCKED") data.cell.styles.textColor = [220, 38, 38];
      }
      if (data.section === "body" && data.column.index === 8) {
        const val = data.cell.raw;
        if (val === "OVERDUE") data.cell.styles.textColor = [220, 38, 38];
      }
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  y = (doc as any).lastAutoTable.finalY + 8;

  // Customizations
  const customizations: string[] = [];
  if (order.gapInches) customizations.push(`Gap: ${order.gapInches}"`);
  if (order.divanHeightInches) customizations.push(`Divan Height: ${order.divanHeightInches}"`);
  if (order.legHeightInches) customizations.push(`Leg Height: ${order.legHeightInches}"`);
  if (order.specialOrder) customizations.push(`Special: ${order.specialOrder.replace(/_/g, " ")}`);
  if (order.notes) customizations.push(`Notes: ${order.notes}`);

  if (customizations.length > 0) {
    doc.setFontSize(8);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(107, 114, 128);
    doc.text("Customizations & Notes:", margin, y);
    y += 4;
    doc.setFont("helvetica", "normal");
    doc.setTextColor(31, 29, 27);
    for (const c of customizations) {
      doc.text(`• ${c}`, margin + 3, y);
      y += 4;
    }
  }

  // Footer
  const footerY = doc.internal.pageSize.getHeight() - 8;
  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(156, 163, 175);
  doc.text(`HOOKKA INDUSTRIES SDN BHD  |  Production Order ${order.poNo}`, margin, footerY);
  doc.text(`Printed: ${new Date().toLocaleDateString("en-MY")}`, pageW - margin, footerY, { align: "right" });

  doc.save(`${order.poNo}-FULL.pdf`);
}
