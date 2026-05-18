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
  // Phase-3 print redesign — bedframe build params (from production_orders
  // via the /print-extras endpoint). null = not applicable (sofa/accessory)
  // or not captured; the cell renders "-".
  gapInches?: number | null;
  divanHeightInches?: number | null;
  legHeightInches?: number | null;
  totalHeightInches?: number | null;
};

type PrintDOData = {
  doNo: string;
  companySO: string; // our (Hookka) SO
  customerSO?: string; // customer's own SO number
  customerPOId: string; // customer's PO number
  customerRef?: string; // customer's free-text reference
  customerName: string;
  deliveryBranch?: string; // destination hub / branch (state)
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

// Fixed origin warehouse (option 1A — Hookka is single-warehouse; the
// "from" branch is not modelled in the schema, so it's a static label).
const WAREHOUSE_BRANCH = "Hookka HQ — Bukit Minyak, Penang";

const PrintDO = forwardRef<HTMLDivElement, PrintDOProps>(({ data, mode }, ref) => {
  const title = mode === "do" ? "DELIVERY ORDER" : "PACKING LIST";
  const totalQty = data.items.reduce((s, i) => s + i.quantity, 0);
  const dim = (v?: number | null) =>
    v == null || v === 0 ? "-" : `${v}"`;
  const docDate = (
    data.dispatchDate ? new Date(data.dispatchDate) : new Date()
  ).toLocaleDateString("en-MY", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

  // Two-column document-info rows. Left = parties / branches. Right =
  // every reference number the floor + customer reconcile against.
  const leftInfo: Array<[string, string]> = [
    ["Customer", data.customerName || "-"],
    ["Deliver To", data.deliveryBranch || "-"],
    ["From (Warehouse)", WAREHOUSE_BRANCH],
    ["Address", data.deliveryAddress || "-"],
    [
      "Contact",
      `${data.contactPerson || "-"}${
        data.contactPhone ? ` (${data.contactPhone})` : ""
      }`,
    ],
  ];
  const rightInfo: Array<[string, string]> = [
    ["DO No.", data.doNo],
    ["Our SO", data.companySO || "-"],
    ["Customer SO", data.customerSO || "-"],
    ["Customer PO", data.customerPOId || "-"],
    ["Customer Ref", data.customerRef || "-"],
    ["Date", docDate],
    ["Driver", data.driverName || "-"],
    ["Vehicle", data.vehicleNo || "-"],
  ];

  return (
    <div ref={ref} className="print-do-container hidden print:block">
      <style>{`
        @media print {
          /* Kill ALL page / body background colors so printer uses paper-white only */
          html, body { background: #ffffff !important; }
          body * { visibility: hidden !important; }
          .print-do-container, .print-do-container * { visibility: visible !important; }
          .print-do-container {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            background: #ffffff !important;
          }
          .print-do-container th { background: #ffffff !important; border: 1px solid #000 !important; }
          .print-do-container tfoot tr { background: #ffffff !important; }
          /* Repeat the items header on every printed page; keep rows whole. */
          .print-do-container thead { display: table-header-group; }
          .print-do-container tr { page-break-inside: avoid; }
          @page { margin: 12mm; size: A4 portrait; }
        }
        .print-do-container {
          font-family: Arial, Helvetica, sans-serif;
          color: #000;
          background: #ffffff;
          font-size: 10px;
          line-height: 1.35;
          width: 186mm;
          margin: 0 auto;
          padding: 6mm;
          box-sizing: border-box;
        }
        .print-do-container .items {
          width: 100%;
          border-collapse: collapse;
          background: #ffffff;
          table-layout: fixed;
        }
        .print-do-container .items th,
        .print-do-container .items td {
          border: 1px solid #000;
          padding: 3px 4px;
          text-align: left;
          font-size: 9px;
          vertical-align: top;
          word-break: break-word;
        }
        .print-do-container .items th {
          background: #ffffff;
          font-weight: bold;
          font-size: 8px;
          text-transform: uppercase;
          text-align: center;
        }
        /* Reference codes must never wrap to a 2nd line (operator complaint) */
        .print-do-container .nowrap {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .print-do-container .text-right { text-align: right; }
        .print-do-container .text-center { text-align: center; }
        .print-do-container .info td {
          border: none;
          padding: 1.5px 0;
          font-size: 10px;
          vertical-align: top;
        }
        .print-do-container .info .lbl {
          font-weight: bold;
          width: 34mm;
          white-space: nowrap;
        }
      `}</style>

      {/* Company header — logo LEFT, company block beside it, title right */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          borderBottom: "2px solid #000",
          paddingBottom: "3mm",
          marginBottom: "4mm",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "4mm" }}>
          <img
            src="/hookka-logo.png"
            alt="Hookka"
            style={{ height: "15mm", width: "auto" }}
          />
          <div>
            <div style={{ fontSize: "15px", fontWeight: "bold" }}>
              HOOKKA INDUSTRIES SDN BHD
            </div>
            <div style={{ fontSize: "8px", color: "#333" }}>
              Lot 7585, Jalan Perindustrian Bukit Minyak 7, Taman
              Perindustrian Bukit Minyak, 14100 Simpang Ampat, Penang
            </div>
            <div style={{ fontSize: "8px", color: "#333" }}>
              Tel: 04-505 8383 &nbsp;|&nbsp; SSM: 1172488-U
            </div>
          </div>
        </div>
        <div
          style={{
            textAlign: "right",
            fontSize: "17px",
            fontWeight: "bold",
            letterSpacing: "1px",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </div>
      </div>

      {/* Document info — two columns, all reference numbers */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: "8mm",
          marginBottom: "4mm",
        }}
      >
        <table className="info" style={{ width: "55%", border: "none" }}>
          <tbody>
            {leftInfo.map(([k, v]) => (
              <tr key={k}>
                <td className="lbl">{k}</td>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <table className="info" style={{ width: "45%", border: "none" }}>
          <tbody>
            {rightInfo.map(([k, v]) => (
              <tr key={k}>
                <td className="lbl">{k}</td>
                <td style={{ fontWeight: k === "DO No." ? "bold" : "normal" }}>
                  {v}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Items */}
      <table className="items">
        <colgroup>
          <col style={{ width: "7mm" }} />
          <col style={{ width: "26mm" }} />
          <col style={{ width: "26mm" }} />
          <col />
          <col style={{ width: "16mm" }} />
          <col style={{ width: "20mm" }} />
          <col style={{ width: "12mm" }} />
          <col style={{ width: "10mm" }} />
          <col style={{ width: "10mm" }} />
          <col style={{ width: "9mm" }} />
          <col style={{ width: "13mm" }} />
          {mode === "packing-list" && <col style={{ width: "16mm" }} />}
        </colgroup>
        <thead>
          <tr>
            <th>No</th>
            <th>SO No</th>
            <th>Product Code</th>
            <th>Product / Variant</th>
            <th>Size</th>
            <th>Colour / Fabric</th>
            <th>Total H</th>
            <th>D1</th>
            <th>Gap</th>
            <th>Qty</th>
            <th>M&sup3;</th>
            {mode === "packing-list" && <th>Rack</th>}
          </tr>
        </thead>
        <tbody>
          {data.items.map((item, idx) => (
            <tr key={item.id}>
              <td className="text-center">{idx + 1}</td>
              <td className="nowrap">{item.salesOrderNo || "-"}</td>
              <td className="nowrap">{item.productCode}</td>
              <td>{item.productName}</td>
              <td>{item.sizeLabel || "-"}</td>
              <td className="nowrap">{item.fabricCode || "-"}</td>
              <td className="text-center">{dim(item.totalHeightInches)}</td>
              <td className="text-center">{dim(item.divanHeightInches)}</td>
              <td className="text-center">{dim(item.gapInches)}</td>
              <td className="text-right">{item.quantity}</td>
              <td className="text-right">
                {(item.itemM3 * item.quantity).toFixed(2)}
              </td>
              {mode === "packing-list" && (
                <td className="nowrap">{item.rackingNumber || "-"}</td>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ fontWeight: "bold" }}>
            <td
              colSpan={9}
              className="text-right"
              style={{ fontWeight: "bold" }}
            >
              Total
            </td>
            <td className="text-right" style={{ fontWeight: "bold" }}>
              {totalQty}
            </td>
            <td className="text-right" style={{ fontWeight: "bold" }}>
              {data.totalM3.toFixed(2)}
            </td>
            {mode === "packing-list" && <td></td>}
          </tr>
        </tfoot>
      </table>

      {data.remarks && (
        <div style={{ marginTop: "3mm" }}>
          <span style={{ fontWeight: "bold", fontSize: "9px" }}>Remarks: </span>
          <span style={{ fontSize: "9px", whiteSpace: "pre-wrap" }}>
            {data.remarks}
          </span>
        </div>
      )}

      {/* Signatures */}
      <div
        style={{
          marginTop: "14mm",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <div style={{ width: "45%", textAlign: "center" }}>
          <div
            style={{
              borderBottom: "1px solid #000",
              height: "20mm",
              marginBottom: "2mm",
            }}
          ></div>
          <div style={{ fontWeight: "bold", fontSize: "9px" }}>Prepared By</div>
          <div style={{ fontSize: "8px", color: "#666" }}>
            Name / Date / Stamp
          </div>
        </div>
        <div style={{ width: "45%", textAlign: "center" }}>
          <div
            style={{
              borderBottom: "1px solid #000",
              height: "20mm",
              marginBottom: "2mm",
            }}
          ></div>
          <div style={{ fontWeight: "bold", fontSize: "9px" }}>Received By</div>
          <div style={{ fontSize: "8px", color: "#666" }}>
            Name / Date / Stamp
          </div>
        </div>
      </div>
    </div>
  );
});

PrintDO.displayName = "PrintDO";

export default PrintDO;
export type { PrintDOData, PrintDOItem, PrintMode };
