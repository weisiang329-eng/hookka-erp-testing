// ---------------------------------------------------------------------------
// BatchImportDialog — generic Excel/CSV batch import flow.
//
// Flow: Download template → user fills it → upload → validate → preview
//       (new vs update vs errors) → confirm → run onImport.
//
// The dialog is dumb about data — it only knows:
//   - column schema for the template
//   - which column is the primary key
//   - how to tell if a key already exists (for new-vs-update preview)
//
// The page owns create/update logic via `onImport(rows)`.
// ---------------------------------------------------------------------------
import * as React from "react";
// xlsx is a 421KB module; dynamic-imported inside the parseFile and
// downloadTemplate handlers so every page that uses BatchImportDialog
// stops dragging it in on mount. We only need the .utils namespace
// (sheet_to_json, aoa_to_sheet, book_*, writeFile) — type-only for the
// module shape so we keep IntelliSense.
import type * as XlsxNs from "xlsx";
type XLSXModule = typeof XlsxNs;
import {
  Download, Upload, X, Check, AlertTriangle,
  FileSpreadsheet, ArrowLeft,
} from "lucide-react";
import { Button } from "./button";
import { Card, CardHeader, CardTitle, CardContent } from "./card";
import { cn } from "@/lib/utils";

export type ImportColumnType = "string" | "number" | "boolean";

export type ImportColumn = {
  /** Field name in the row object passed to onImport. */
  key: string;
  /** Column header shown in the downloaded template. */
  label: string;
  /** Marks this as a required field — blank rows fail validation. */
  required?: boolean;
  /** Accepted values. Case-insensitive on input. */
  enum?: string[];
  /** Type coercion for the parsed value. Defaults to "string". */
  type?: ImportColumnType;
  /** Example value shown as the second row in the template. */
  example?: string | number;
  /** Free-text help shown below the field in the legend. */
  help?: string;
};

export type ImportRow = Record<string, unknown>;

type RowCategory = "new" | "update" | "error";

type ParsedRow = {
  idx: number;             // original row number in the file (1-indexed)
  values: ImportRow;       // coerced field values
  errors: string[];        // validation messages
  keyValue: string;        // value of the key column
  category: RowCategory;
};

export interface BatchImportDialogProps {
  open: boolean;
  onClose: () => void;
  /** Dialog title, e.g. "Batch Import Finished Products". */
  title: string;
  /** Short description shown in the intro step. */
  description?: string;
  /** File name for the downloaded template (include .xlsx extension). */
  templateFilename: string;
  /** Column schema. ORDER determines template column order. */
  columns: ImportColumn[];
  /** Which column is the matching key (e.g. "code" for FG, "itemCode" for RM). */
  keyColumn: string;
  /** Given a key value from a row, return true if a record with that key
   *  already exists (row becomes UPDATE) or false (row becomes NEW). */
  isExistingKey: (key: string) => boolean;
  /** Called with the full set of valid rows when user confirms. Should
   *  return a summary message (or throw for aborted imports). */
  onImport: (rows: ImportRow[]) => Promise<{ created: number; updated: number }> | { created: number; updated: number };
  /** Optional: current rows to enable "Export Current Data" round-trip.
   *  Each row should have the same keys as `columns`. Users export, edit
   *  in Excel, re-upload — matched rows become UPDATE, new keys become NEW. */
  currentRows?: ImportRow[];
  /** Filename for the exported data file. Defaults to
   *  templateFilename with "-template" replaced by "-export". */
  exportFilename?: string;
}

type Step = "intro" | "preview" | "done";

export const BatchImportDialog: React.FC<BatchImportDialogProps> = ({
  open,
  onClose,
  title,
  description,
  templateFilename,
  columns,
  keyColumn,
  isExistingKey,
  onImport,
  currentRows,
  exportFilename,
}) => {
  const [step, setStep] = React.useState<Step>("intro");
  const [parsed, setParsed] = React.useState<ParsedRow[]>([]);
  const [uploadErr, setUploadErr] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [result, setResult] = React.useState<{ created: number; updated: number } | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Reset state whenever the dialog is reopened. Each field is user-mutated
  // during the import flow (parsed rows, errors, intro/confirm step), so a
  // pure derive isn't possible — we just need to clear on open->true.
  /* eslint-disable react-hooks/set-state-in-effect */
  React.useEffect(() => {
    if (open) {
      setStep("intro");
      setParsed([]);
      setUploadErr(null);
      setResult(null);
    }
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!open) return null;

  // -- Template download ----------------------------------------------------
  const handleDownloadTemplate = async () => {
    const XLSX: XLSXModule = await import("xlsx");
    const headerRow = columns.map((c) =>
      c.required ? `${c.label} *` : c.label,
    );
    const exampleRow = columns.map((c) => c.example ?? "");
    const aoa: (string | number)[][] = [headerRow, exampleRow];
    const ws = XLSX.utils.aoa_to_sheet(aoa);

    // Auto-size columns based on header length + some padding
    ws["!cols"] = columns.map((c) => ({
      wch: Math.max(c.label.length + 4, String(c.example ?? "").length + 2, 12),
    }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Template");
    XLSX.writeFile(wb, templateFilename);
  };

  // -- Export current data ---------------------------------------------------
  // Produces an Excel file with the exact same schema as the template, but
  // pre-filled with the current rows. Users edit in Excel and re-upload to
  // update in bulk — the key column matches rows back to existing records.
  const handleExportCurrent = async () => {
    if (!currentRows || currentRows.length === 0) return;
    const XLSX: XLSXModule = await import("xlsx");

    const headerRow = columns.map((c) =>
      c.required ? `${c.label} *` : c.label,
    );

    const dataRows: (string | number | boolean)[][] = currentRows.map((row) =>
      columns.map((c) => {
        const v = row[c.key];
        if (v === null || v === undefined) return "";
        if (c.type === "boolean") return v ? "TRUE" : "FALSE";
        if (c.type === "number") {
          const n = Number(v);
          return Number.isFinite(n) ? n : "";
        }
        return String(v);
      }),
    );

    const aoa: (string | number | boolean)[][] = [headerRow, ...dataRows];
    const ws = XLSX.utils.aoa_to_sheet(aoa);

    // Widen columns to fit the longest value actually present (cap at 50)
    ws["!cols"] = columns.map((c, colIdx) => {
      let maxLen = c.label.length + 4;
      for (const row of dataRows) {
        const cell = row[colIdx];
        const len = String(cell ?? "").length;
        if (len > maxLen) maxLen = len;
      }
      return { wch: Math.min(Math.max(maxLen, 12), 50) };
    });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Data");

    const fallback = templateFilename.replace(/template/gi, "export");
    const outName =
      exportFilename ||
      (fallback !== templateFilename ? fallback : `export-${templateFilename}`);
    XLSX.writeFile(wb, outName);
  };

  // -- Upload + parse --------------------------------------------------------
  const handleFile = async (file: File) => {
    setUploadErr(null);
    try {
      const XLSX: XLSXModule = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) {
        setUploadErr("File has no sheets");
        return;
      }
      // raw: false gives us strings so "K" doesn't become a Date. defval
      // ensures empty cells come through as "" not undefined.
      const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
        raw: false,
        defval: "",
      });

      // Map Excel headers ("Product Code *") back to field keys ("code").
      // Users may remove the "*" from required headers, so we match by
      // prefix after stripping the marker.
      const headerToKey = new Map<string, string>();
      for (const col of columns) {
        headerToKey.set(col.label.toLowerCase(), col.key);
        headerToKey.set(`${col.label} *`.toLowerCase(), col.key);
      }

      const rows: ParsedRow[] = rawRows.map((row, i) => {
        const values: ImportRow = {};
        const errors: string[] = [];

        // Remap row keys from "Label *" to "key"
        const remapped: Record<string, unknown> = {};
        for (const [header, v] of Object.entries(row)) {
          const k = headerToKey.get(header.trim().toLowerCase());
          if (k) remapped[k] = v;
        }

        // Apply schema: coerce types, validate required/enum
        for (const col of columns) {
          const raw = remapped[col.key];
          const str = raw === null || raw === undefined ? "" : String(raw).trim();

          if (col.required && !str) {
            errors.push(`${col.label} is required`);
            values[col.key] = "";
            continue;
          }

          if (!str) {
            values[col.key] = col.type === "number" ? 0 : col.type === "boolean" ? false : "";
            continue;
          }

          if (col.enum && col.enum.length > 0) {
            const match = col.enum.find((e) => e.toLowerCase() === str.toLowerCase());
            if (!match) {
              errors.push(
                `${col.label} must be one of: ${col.enum.join(", ")} (got "${str}")`,
              );
              values[col.key] = str;
              continue;
            }
            values[col.key] = match;
            continue;
          }

          if (col.type === "number") {
            const n = Number(str.replace(/,/g, ""));
            if (Number.isNaN(n)) {
              errors.push(`${col.label} must be a number (got "${str}")`);
              values[col.key] = 0;
            } else {
              values[col.key] = n;
            }
            continue;
          }

          if (col.type === "boolean") {
            const truthy = ["true", "yes", "y", "1", "active"].includes(str.toLowerCase());
            const falsy = ["false", "no", "n", "0", "inactive"].includes(str.toLowerCase());
            if (!truthy && !falsy) {
              errors.push(`${col.label} must be true/false (got "${str}")`);
              values[col.key] = false;
            } else {
              values[col.key] = truthy;
            }
            continue;
          }

          values[col.key] = str;
        }

        const keyValue = String(values[keyColumn] ?? "").trim();
        let category: RowCategory = "new";
        if (errors.length > 0) {
          category = "error";
        } else if (keyValue && isExistingKey(keyValue)) {
          category = "update";
        }

        return { idx: i + 2, values, errors, keyValue, category };
      });

      // Filter out obviously empty rows (no key, no other filled fields)
      const nonEmpty = rows.filter((r) => {
        const any = Object.values(r.values).some((v) => v !== "" && v !== 0 && v !== false);
        return any;
      });

      if (nonEmpty.length === 0) {
        setUploadErr("No data rows found. Did you fill in the template?");
        return;
      }

      setParsed(nonEmpty);
      setStep("preview");
    } catch (e) {
      setUploadErr(
        `Failed to parse file: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  // -- Confirm + import ------------------------------------------------------
  const handleConfirm = async () => {
    setImporting(true);
    try {
      const good = parsed.filter((r) => r.category !== "error").map((r) => r.values);
      const res = await onImport(good);
      setResult(res);
      setStep("done");
    } catch (e) {
      setUploadErr(
        `Import failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setImporting(false);
    }
  };

  const counts = {
    new: parsed.filter((r) => r.category === "new").length,
    update: parsed.filter((r) => r.category === "update").length,
    error: parsed.filter((r) => r.category === "error").length,
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 p-4">
      <Card className="w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <CardHeader className="pb-3 border-b border-[#E2DDD8] flex-shrink-0">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5 text-[#6B5C32]" />
              {title}
            </CardTitle>
            <button
              onClick={onClose}
              className="text-[#9CA3AF] hover:text-[#1F1D1B]"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </CardHeader>

        <CardContent className="overflow-y-auto flex-1 py-4">
          {step === "intro" && (
            <div className="space-y-4">
              {description && (
                <p className="text-sm text-[#6B7280]">{description}</p>
              )}

              <div className="rounded-md bg-[#FAF9F7] border border-[#E2DDD8] p-4">
                <h3 className="text-sm font-semibold text-[#1F1D1B] mb-2">
                  How it works
                </h3>
                <ol className="text-sm text-[#374151] list-decimal pl-5 space-y-1">
                  <li>
                    <span className="font-semibold">Create new rows:</span> download the blank template and fill it in.
                    {currentRows && currentRows.length > 0 && (
                      <>
                        <br />
                        <span className="font-semibold">Edit existing rows:</span> export the current data, change what you need in Excel, then re-upload.
                      </>
                    )}
                  </li>
                  <li>
                    The <code className="px-1 rounded bg-white border border-[#E2DDD8] text-xs">{columns.find(c => c.key === keyColumn)?.label || keyColumn}</code> column is the matching key —
                    existing rows get <span className="font-semibold">updated</span>, new keys get <span className="font-semibold">created</span>.
                  </li>
                  <li>Upload the filled file. You'll see a preview before anything is saved.</li>
                </ol>
              </div>

              <div>
                <h3 className="text-sm font-semibold text-[#1F1D1B] mb-2">
                  Template columns
                </h3>
                <div className="rounded-md border border-[#E2DDD8] divide-y divide-[#E2DDD8]">
                  {columns.map((c) => (
                    <div key={c.key} className="px-3 py-2 flex items-start gap-3 text-sm">
                      <span className={cn(
                        "font-mono text-xs px-2 py-0.5 rounded flex-shrink-0",
                        c.key === keyColumn
                          ? "bg-[#6B5C32] text-white"
                          : "bg-[#FAF9F7] text-[#6B5C32] border border-[#E2DDD8]",
                      )}>
                        {c.label}{c.required ? " *" : ""}
                      </span>
                      <span className="text-[#6B7280] flex-1">
                        {c.key === keyColumn && <span className="font-semibold text-[#6B5C32]">[KEY] </span>}
                        {c.help || ""}
                        {c.enum && <span className="italic"> Values: {c.enum.join(", ")}</span>}
                        {c.type === "number" && <span className="italic"> (number)</span>}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-3 pt-2 flex-wrap">
                <Button variant="outline" onClick={handleDownloadTemplate}>
                  <Download className="h-4 w-4" />
                  Download Template
                </Button>
                {currentRows && currentRows.length > 0 && (
                  <Button variant="outline" onClick={handleExportCurrent}>
                    <Download className="h-4 w-4" />
                    Export Current Data ({currentRows.length})
                  </Button>
                )}
                <Button
                  variant="primary"
                  onClick={() => inputRef.current?.click()}
                >
                  <Upload className="h-4 w-4" />
                  Upload Filled File
                </Button>
                <input
                  ref={inputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                    // Reset so re-selecting the same file re-triggers change
                    e.target.value = "";
                  }}
                />
              </div>

              {uploadErr && (
                <div className="rounded-md bg-[#FEF2F2] border border-[#FECACA] p-3 text-sm text-[#9A3A2D] flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  {uploadErr}
                </div>
              )}
            </div>
          )}

          {step === "preview" && (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setStep("intro")}
                  className="text-[#6B7280] hover:text-[#1F1D1B] flex items-center gap-1 text-sm"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Back
                </button>
                <div className="flex gap-2">
                  <span className="px-2 py-1 rounded bg-[#DCFCE7] text-[#166534] text-xs font-medium">
                    {counts.new} new
                  </span>
                  <span className="px-2 py-1 rounded bg-[#DBEAFE] text-[#1E40AF] text-xs font-medium">
                    {counts.update} update
                  </span>
                  {counts.error > 0 && (
                    <span className="px-2 py-1 rounded bg-[#FEE2E2] text-[#991B1B] text-xs font-medium">
                      {counts.error} error
                    </span>
                  )}
                </div>
              </div>

              <div className="rounded-md border border-[#E2DDD8] overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-[#FAF9F7] text-[#6B7280] border-b border-[#E2DDD8]">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium w-16">Row</th>
                        <th className="px-3 py-2 text-left font-medium w-24">Status</th>
                        {columns.map((c) => (
                          <th key={c.key} className="px-3 py-2 text-left font-medium">
                            {c.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#E2DDD8]">
                      {parsed.map((r) => (
                        <tr
                          key={r.idx}
                          className={cn(
                            r.category === "error" && "bg-[#FEF2F2]",
                            r.category === "new" && "bg-white",
                            r.category === "update" && "bg-[#F0F9FF]",
                          )}
                        >
                          <td className="px-3 py-2 text-[#9CA3AF] font-mono text-xs">
                            {r.idx}
                          </td>
                          <td className="px-3 py-2">
                            {r.category === "error" && (
                              <span className="text-[#991B1B] text-xs font-semibold">
                                Error
                              </span>
                            )}
                            {r.category === "new" && (
                              <span className="text-[#166534] text-xs font-semibold">
                                + New
                              </span>
                            )}
                            {r.category === "update" && (
                              <span className="text-[#1E40AF] text-xs font-semibold">
                                ↻ Update
                              </span>
                            )}
                          </td>
                          {columns.map((c) => (
                            <td key={c.key} className="px-3 py-2 text-[#1F1D1B]">
                              {String(r.values[c.key] ?? "")}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {counts.error > 0 && (
                <details className="rounded-md bg-[#FEF2F2] border border-[#FECACA] p-3 text-sm">
                  <summary className="text-[#9A3A2D] font-medium cursor-pointer">
                    {counts.error} row{counts.error !== 1 ? "s" : ""} have errors and will be skipped
                  </summary>
                  <ul className="mt-2 text-[#7F1D1D] list-disc pl-5 space-y-1">
                    {parsed
                      .filter((r) => r.category === "error")
                      .map((r) => (
                        <li key={r.idx}>
                          Row {r.idx}: {r.errors.join("; ")}
                        </li>
                      ))}
                  </ul>
                </details>
              )}

              {uploadErr && (
                <div className="rounded-md bg-[#FEF2F2] border border-[#FECACA] p-3 text-sm text-[#9A3A2D] flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  {uploadErr}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2 border-t border-[#E2DDD8]">
                <Button variant="outline" onClick={onClose} disabled={importing}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={handleConfirm}
                  disabled={importing || counts.new + counts.update === 0}
                >
                  <Check className="h-4 w-4" />
                  {importing
                    ? "Importing..."
                    : `Import ${counts.new + counts.update} row${counts.new + counts.update !== 1 ? "s" : ""}`}
                </Button>
              </div>
            </div>
          )}

          {step === "done" && result && (
            <div className="space-y-4 py-8 text-center">
              <div className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-[#DCFCE7] text-[#166534]">
                <Check className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-[#1F1D1B]">
                  Import complete
                </h3>
                <p className="text-sm text-[#6B7280] mt-1">
                  {result.created} created · {result.updated} updated
                </p>
              </div>
              <Button variant="primary" onClick={onClose}>
                Done
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
