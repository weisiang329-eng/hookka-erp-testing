import { Printer, FileSpreadsheet, X } from "lucide-react";
import { exportReportCsv, exportReportXlsx } from "@/lib/export-report";

export function BatchActionsBar(props: {
  count: number;
  onClear: () => void;
  onPrint?: () => void;
  exportName: string; // base filename, no extension
  exportAoa: () => (string | number)[][]; // header row + selected body rows
}) {
  if (props.count === 0) return null;
  return (
    <div className="flex items-center gap-2 rounded-md border border-[#E2DDD8] bg-[#FAF8F5] px-3 py-2 text-sm mb-2">
      <span className="font-medium text-[#1F1D1B]">{props.count} selected</span>
      <div className="flex-1" />
      {props.onPrint && (
        <button
          onClick={props.onPrint}
          className="inline-flex items-center gap-1 rounded-md border border-[#E2DDD8] bg-white px-2.5 py-1 text-[#6B5C32] hover:text-[#1F1D1B]"
        >
          <Printer className="h-3.5 w-3.5" /> Print / PDF
        </button>
      )}
      <button
        onClick={() => exportReportCsv(`${props.exportName}.csv`, props.exportAoa())}
        className="inline-flex items-center gap-1 rounded-md border border-[#E2DDD8] bg-white px-2.5 py-1 text-[#3E6570] hover:text-[#1F1D1B]"
      >
        CSV
      </button>
      <button
        onClick={() => void exportReportXlsx(`${props.exportName}.xlsx`, props.exportName.slice(0, 31), props.exportAoa())}
        className="inline-flex items-center gap-1 rounded-md border border-[#E2DDD8] bg-white px-2.5 py-1 text-[#27500A] hover:text-[#1F1D1B]"
      >
        <FileSpreadsheet className="h-3.5 w-3.5" /> Excel
      </button>
      <button onClick={props.onClear} className="inline-flex items-center gap-1 text-[#6B7280] hover:text-[#1F1D1B]">
        <X className="h-3.5 w-3.5" /> Clear
      </button>
    </div>
  );
}
