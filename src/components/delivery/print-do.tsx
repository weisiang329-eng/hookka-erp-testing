"use client";

import React, { forwardRef } from "react";

type PrintDOItem = {
  id: string;
  salesOrderNo: string;
  poNo: string;
  productCode: string;
  productName: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  itemM3: number;
  rackingNumber: string;
};

type PrintDOData = {
  doNo: string;
  companySO: string;
  customerPOId: string;
  customerName: string;
  hubBranch: string;
  deliveryAddress: string;
  contactPerson: string;
  contactPhone: string;
  driverName: string;
  vehicleNo: string;
  dispatchDate: string | null;
  items: PrintDOItem[];
  totalM3: number;
  remarks: string;
};

type PrintMode = "do" | "packing-list";

interface PrintDOProps {
  data: PrintDOData;
  mode: PrintMode;
}

const PrintDO = forwardRef<HTMLDivElement, PrintDOProps>(({ data, mode }, ref) => {
  const title = mode === "do" ? "DELIVERY ORDER" : "PACKING LIST";
  const totalQty = data.items.reduce((s, i) => s + i.quantity, 0);

  return (
    <div ref={ref} className="print-do-container">
      <style>{`
        @media print {
          /* Kill ALL page / body background colors so printer uses paper-white only */
          html, body { background: #ffffff !important; }
          body * { visibility: hidden; }
          .print-do-container, .print-do-container * { visibility: visible; }
          .print-do-container {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
            background: #ffffff !important;
          }
          /* Headers must print as outlined cells — no gray fill, saves ink */
          .print-do-container th { background: #ffffff !important; border: 1px solid #000 !important; }
          .print-do-container tfoot tr { background: #ffffff !important; }
          @page { margin: 15mm; size: A4; background: #ffffff; }
        }
        .print-do-container {
          font-family: Arial, Helvetica, sans-serif;
          color: #000;
          background: #ffffff;
          font-size: 11px;
          line-height: 1.4;
          max-width: 210mm;
          margin: 0 auto;
          padding: 10mm;
        }
        .print-do-container table {
          width: 100%;
          border-collapse: collapse;
          background: #ffffff;
        }
        .print-do-container th,
        .print-do-container td {
          border: 1px solid #000;
          padding: 4px 6px;
          text-align: left;
          font-size: 10px;
          font-family: Arial, Helvetica, sans-serif;
        }
        .print-do-container th {
          background: #ffffff;
          font-weight: bold;
          font-size: 9px;
          text-transform: uppercase;
        }
        .print-do-container .text-right { text-align: right; }
        .print-do-container .text-center { text-align: center; }
        /* Unified font for all IDs / codes / dates / numbers — no monospace mix */
        .print-do-container .font-mono { font-family: Arial, Helvetica, sans-serif; }
        .print-do-container .no-border { border: none; }
        .print-do-container .header-row td { border: none; padding: 2px 0; }
      `}</style>

      {/* Company Header */}
      <div style={{ textAlign: "center", marginBottom: "8mm", borderBottom: "2px solid #000", paddingBottom: "4mm" }}>
        <h1 style={{ fontSize: "18px", fontWeight: "bold", margin: "0 0 2px 0" }}>HOOKKA INDUSTRIES SDN BHD</h1>
        <p style={{ fontSize: "9px", margin: "0", color: "#333" }}>
          Lot 7585, Jalan Perindustrian Bukit Minyak 7, Taman Perindustrian Bukit Minyak, 14100 Simpang Ampat, Penang
        </p>
        <p style={{ fontSize: "9px", margin: "0", color: "#333" }}>
          Tel: 04-505 8383 | SSM: 1172488-U
        </p>
        <h2 style={{ fontSize: "16px", fontWeight: "bold", margin: "6px 0 0 0", letterSpacing: "2px" }}>{title}</h2>
      </div>

      {/* Document Info */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6mm" }}>
        <div style={{ width: "55%" }}>
          <table className="no-border" style={{ border: "none" }}>
            <tbody>
              <tr className="header-row">
                <td style={{ width: "100px", fontWeight: "bold", border: "none", padding: "2px 0" }}>Customer:</td>
                <td style={{ border: "none", padding: "2px 0", fontWeight: "bold" }}>{data.customerName}</td>
              </tr>
              <tr className="header-row">
                <td style={{ fontWeight: "bold", border: "none", padding: "2px 0" }}>Address:</td>
                <td style={{ border: "none", padding: "2px 0", fontSize: "9px" }}>{data.deliveryAddress || "-"}</td>
              </tr>
              <tr className="header-row">
                <td style={{ fontWeight: "bold", border: "none", padding: "2px 0" }}>Contact:</td>
                <td style={{ border: "none", padding: "2px 0" }}>{data.contactPerson || "-"} {data.contactPhone ? `(${data.contactPhone})` : ""}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div style={{ width: "40%", textAlign: "right" }}>
          <table className="no-border" style={{ border: "none", marginLeft: "auto" }}>
            <tbody>
              <tr className="header-row">
                <td style={{ fontWeight: "bold", border: "none", padding: "2px 0", textAlign: "right" }}>DO No.:</td>
                <td style={{ border: "none", padding: "2px 0", fontWeight: "bold" }}>{data.doNo}</td>
              </tr>
              <tr className="header-row">
                <td style={{ fontWeight: "bold", border: "none", padding: "2px 0", textAlign: "right" }}>SO No.:</td>
                <td style={{ border: "none", padding: "2px 0" }}>{data.companySO}</td>
              </tr>
              <tr className="header-row">
                <td style={{ fontWeight: "bold", border: "none", padding: "2px 0", textAlign: "right" }}>Cust PO:</td>
                <td style={{ border: "none", padding: "2px 0" }}>{data.customerPOId || "-"}</td>
              </tr>
              <tr className="header-row">
                <td style={{ fontWeight: "bold", border: "none", padding: "2px 0", textAlign: "right" }}>Date:</td>
                <td style={{ border: "none", padding: "2px 0" }}>
                  {data.dispatchDate
                    ? new Date(data.dispatchDate).toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" })
                    : new Date().toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" })}
                </td>
              </tr>
              <tr className="header-row">
                <td style={{ fontWeight: "bold", border: "none", padding: "2px 0", textAlign: "right" }}>Driver:</td>
                <td style={{ border: "none", padding: "2px 0" }}>{data.driverName || "-"}</td>
              </tr>
              <tr className="header-row">
                <td style={{ fontWeight: "bold", border: "none", padding: "2px 0", textAlign: "right" }}>Vehicle:</td>
                <td style={{ border: "none", padding: "2px 0" }}>{data.vehicleNo || "-"}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Items Table */}
      <table>
        <thead>
          <tr>
            <th className="text-center" style={{ width: "30px" }}>No.</th>
            <th>SO No.</th>
            <th>Product Code</th>
            <th>Product Name</th>
            <th>Size</th>
            <th>Fabric</th>
            <th className="text-right" style={{ width: "40px" }}>Qty</th>
            <th className="text-right" style={{ width: "50px" }}>M&sup3;</th>
            {mode === "packing-list" && <th>Rack No.</th>}
          </tr>
        </thead>
        <tbody>
          {data.items.map((item, idx) => (
            <tr key={item.id}>
              <td className="text-center">{idx + 1}</td>
              <td style={{ fontSize: "10px" }}>{item.salesOrderNo || "-"}</td>
              <td style={{ fontSize: "10px" }}>{item.productCode}</td>
              <td>{item.productName}</td>
              <td>{item.sizeLabel}</td>
              <td>{item.fabricCode}</td>
              <td className="text-right">{item.quantity}</td>
              <td className="text-right">{(item.itemM3 * item.quantity).toFixed(2)}</td>
              {mode === "packing-list" && <td>{item.rackingNumber || "-"}</td>}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ fontWeight: "bold", background: "#ffffff" }}>
            <td colSpan={mode === "packing-list" ? 6 : 5} className="text-right" style={{ fontWeight: "bold" }}>Total:</td>
            <td className="text-right" style={{ fontWeight: "bold" }}>{totalQty}</td>
            <td className="text-right" style={{ fontWeight: "bold" }}>{data.totalM3.toFixed(2)}</td>
            {mode === "packing-list" && <td></td>}
          </tr>
        </tfoot>
      </table>

      {/* Remarks */}
      {data.remarks && (
        <div style={{ marginTop: "4mm" }}>
          <p style={{ fontWeight: "bold", fontSize: "10px" }}>Remarks:</p>
          <p style={{ fontSize: "10px", whiteSpace: "pre-wrap" }}>{data.remarks}</p>
        </div>
      )}

      {/* Signature Section */}
      <div style={{ marginTop: "15mm", display: "flex", justifyContent: "space-between" }}>
        <div style={{ width: "45%", textAlign: "center" }}>
          <div style={{ borderBottom: "1px solid #000", height: "25mm", marginBottom: "2mm" }}></div>
          <p style={{ fontWeight: "bold", fontSize: "10px" }}>Prepared By</p>
          <p style={{ fontSize: "9px", color: "#666" }}>Name / Date / Stamp</p>
        </div>
        <div style={{ width: "45%", textAlign: "center" }}>
          <div style={{ borderBottom: "1px solid #000", height: "25mm", marginBottom: "2mm" }}></div>
          <p style={{ fontWeight: "bold", fontSize: "10px" }}>Received By</p>
          <p style={{ fontSize: "9px", color: "#666" }}>Name / Date / Stamp</p>
        </div>
      </div>
    </div>
  );
});

PrintDO.displayName = "PrintDO";

export default PrintDO;
export type { PrintDOData, PrintDOItem, PrintMode };
