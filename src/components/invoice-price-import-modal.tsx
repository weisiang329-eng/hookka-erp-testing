// ---------------------------------------------------------------------------
// invoice-price-import-modal — the screen for the Detail Listing round trip.
//
// Three states, and the middle one is the point:
//
//   pick a file  →  SEE THE PLAN  →  apply
//
// There is no path from the file picker to a write. The preview is not a
// courtesy; it is the step whose absence let the price editor zero 112 lines on
// 2026-08-20 (BUG-2026-08-20-158) — it wrote the instant the button was pressed
// and nobody ever saw what it was about to do.
//
// The plan shown here comes from the SERVER, judged against the database as it
// stands. Nothing about what will change is decided in this file — that would
// be a second opinion, and two opinions about money is one too many.
// ---------------------------------------------------------------------------

import { useState } from "react";
import { X, Upload, AlertTriangle, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { readImportSheet } from "@/lib/invoice-price-import-sheet";
import type { ImportRow } from "@/lib/invoice-price-import";

type PlannedChange = {
  lineId: string;
  invoiceNo: string;
  before: { base: number; divan: number; leg: number; totalHeight: number; special: number; discount: number; unit: number };
  after: { base: number; divan: number; leg: number; totalHeight: number; special: number; discount: number; unit: number };
  touched: string[];
  makesFree: boolean;
};
type Rejection = { row: number; lineId: string; invoiceNo: string; reason: string };
type Plan = {
  rows: number;
  willChange: number;
  unchanged: number;
  refused: number;
  makesFree: number;
  invoices: string[];
  changes: PlannedChange[];
  rejections: Rejection[];
};

const rm = (sen: number) => (Math.round(Number(sen) || 0) / 100).toFixed(2);

export function InvoicePriceImportModal({
  open,
  onClose,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<{ applied: number; invoices: { invoiceNo: string; totalSen: number }[] } | null>(null);

  if (!open) return null;

  const reset = () => {
    setFileName("");
    setRows(null);
    setIgnored([]);
    setPlan(null);
    setError("");
    setApplied(null);
  };

  const pickFile = async (file: File) => {
    reset();
    setFileName(file.name);
    setBusy(true);
    try {
      // Dynamic-imported for the same reason the export does it: xlsx is large
      // and nobody who is not importing should pay for it.
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      // `defval: ""` matters: without it xlsx OMITS empty cells, and a row that
      // skipped a column would arrive shorter than the header. Blank must stay
      // blank all the way to the planner, where it means "do not touch".
      const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true }) as unknown[][];
      const read = readImportSheet(aoa);
      if (!read.ok) {
        setError(read.error);
        return;
      }
      setRows(read.rows);
      setIgnored(read.ignoredColumns);

      const res = await fetch("/api/invoices/import-line-prices", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows: read.rows }),
      });
      const j = (await res.json()) as Plan & { success?: boolean; error?: string };
      if (!res.ok || j.success === false) {
        setError(j.error || `Preview failed (HTTP ${res.status})`);
        return;
      }
      setPlan(j);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that file.");
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!rows || !plan) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/invoices/import-line-prices?execute=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rows }),
      });
      const j = (await res.json()) as {
        success?: boolean;
        error?: string;
        applied?: number;
        invoices?: { invoiceNo: string; totalSen: number }[];
      };
      if (!res.ok || !j.success) {
        setError(j.error || `Import failed (HTTP ${res.status})`);
        return;
      }
      setApplied({ applied: j.applied ?? 0, invoices: j.invoices ?? [] });
      onApplied();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  };

  const canApply = !!plan && plan.refused === 0 && plan.willChange > 0 && !busy;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[88vh] w-full max-w-4xl flex-col rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-[#E2DDD8] px-5 py-3">
          <h2 className="text-base font-semibold text-[#1F1D1B]">Import prices from a Detail Listing</h2>
          <button onClick={onClose} className="rounded p-1 text-[#6B7280] hover:bg-[#F0ECE9]" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* ---- step 1: the file ---- */}
          {!applied && (
            <div className="mb-4">
              <label className="flex cursor-pointer items-center gap-3 rounded border border-dashed border-[#C9C2BB] px-4 py-3 hover:bg-[#FAF8F6]">
                <Upload className="h-4 w-4 text-[#6B7280]" />
                <span className="text-sm text-[#4B5563]">
                  {fileName || "Choose the edited Detail Listing (.xlsx or .csv)"}
                </span>
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void pickFile(f);
                    e.target.value = "";
                  }}
                />
              </label>
              <p className="mt-2 text-[11px] leading-relaxed text-[#9CA3AF]">
                A blank cell means <strong>leave that component alone</strong>. To price something at
                nothing, type an explicit 0 — those lines are listed separately below before anything
                is written.
              </p>
            </div>
          )}

          {error && (
            <div className="mb-4 flex gap-2 rounded border border-[#E7C3BC] bg-[#FBF0EE] px-3 py-2 text-sm text-[#9B3221]">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {busy && <p className="text-sm text-[#6B7280]">Working…</p>}

          {/* ---- step 3: what happened ---- */}
          {applied && (
            <div className="rounded border border-[#BFE0CD] bg-[#EFF7F2] px-4 py-3">
              <p className="flex items-center gap-2 text-sm font-semibold text-[#1F6B4F]">
                <Check className="h-4 w-4" /> {applied.applied} line(s) updated
              </p>
              <table className="mt-3 w-full text-sm">
                <tbody>
                  {applied.invoices.map((inv) => (
                    <tr key={inv.invoiceNo}>
                      <td className="py-1 font-mono text-[#4B5563]">{inv.invoiceNo}</td>
                      <td className="py-1 text-right tabular-nums text-[#1F1D1B]">RM {rm(inv.totalSen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* ---- step 2: THE PLAN ---- */}
          {plan && !applied && (
            <>
              <div className="mb-4 grid grid-cols-2 gap-px overflow-hidden rounded border border-[#E2DDD8] bg-[#E2DDD8] sm:grid-cols-4">
                {[
                  ["Will change", plan.willChange, "text-[#1F6B4F]"],
                  ["Unchanged", plan.unchanged, "text-[#6B7280]"],
                  ["Refused", plan.refused, plan.refused ? "text-[#9B3221]" : "text-[#6B7280]"],
                  ["Becomes free", plan.makesFree, plan.makesFree ? "text-[#9B3221]" : "text-[#6B7280]"],
                ].map(([label, value, tone]) => (
                  <div key={String(label)} className="bg-white px-3 py-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-[#9CA3AF]">{label}</p>
                    <p className={`text-xl font-bold tabular-nums ${tone}`}>{value}</p>
                  </div>
                ))}
              </div>

              {ignored.length > 0 && (
                <p className="mb-3 text-[11px] text-[#9CA3AF]">
                  Columns read but not used: {ignored.join(", ")}
                </p>
              )}

              {plan.refused > 0 && (
                <div className="mb-4">
                  <p className="mb-1 text-sm font-semibold text-[#9B3221]">
                    {plan.refused} row(s) cannot be applied — so none will be
                  </p>
                  <p className="mb-2 text-[11px] text-[#6B7280]">
                    Fix these in the sheet (or delete those rows) and import again. A half-applied
                    file would leave you unable to tell which half landed.
                  </p>
                  <div className="max-h-48 overflow-y-auto rounded border border-[#E2DDD8]">
                    <table className="w-full text-[12px]">
                      <tbody>
                        {plan.rejections.map((r, i) => (
                          <tr key={i} className="border-b border-[#F0ECE9] last:border-0">
                            <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[#9B3221]">row {r.row}</td>
                            <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[#6B7280]">{r.invoiceNo}</td>
                            <td className="px-2 py-1.5 text-[#4B5563]">{r.reason}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {plan.willChange > 0 && (
                <div>
                  <p className="mb-2 text-sm font-semibold text-[#1F1D1B]">
                    {plan.willChange} line(s) across {plan.invoices.length} invoice(s)
                  </p>
                  <div className="max-h-72 overflow-y-auto rounded border border-[#E2DDD8]">
                    <table className="w-full text-[12px]">
                      <thead className="sticky top-0 bg-[#F5F3F1]">
                        <tr className="text-[10px] uppercase tracking-wide text-[#9CA3AF]">
                          <th className="px-2 py-1.5 text-left">Invoice</th>
                          <th className="px-2 py-1.5 text-left">Changing</th>
                          <th className="px-2 py-1.5 text-right">Unit now</th>
                          <th className="px-2 py-1.5 text-right">Unit after</th>
                        </tr>
                      </thead>
                      <tbody>
                        {plan.changes.map((ch) => (
                          <tr
                            key={ch.lineId}
                            className={`border-b border-[#F0ECE9] last:border-0 ${ch.makesFree ? "bg-[#FBF0EE]" : ""}`}
                          >
                            <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[#4B5563]">{ch.invoiceNo}</td>
                            <td className="px-2 py-1.5 text-[#6B7280]">{ch.touched.join(", ")}</td>
                            <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums text-[#6B7280]">
                              {rm(ch.before.unit)}
                            </td>
                            <td
                              className={`whitespace-nowrap px-2 py-1.5 text-right font-semibold tabular-nums ${
                                ch.makesFree ? "text-[#9B3221]" : "text-[#1F6B4F]"
                              }`}
                            >
                              {rm(ch.after.unit)}
                              {ch.makesFree && " — free"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[#E2DDD8] px-5 py-3">
          <p className="text-[11px] text-[#9CA3AF]">
            {applied ? "Done." : "Nothing is written until you press Apply."}
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {applied ? "Close" : "Cancel"}
            </Button>
            {!applied && (
              <Button onClick={() => void apply()} disabled={!canApply}>
                {plan?.makesFree
                  ? `Apply — ${plan.makesFree} line(s) become free`
                  : `Apply ${plan?.willChange ?? 0} change(s)`}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
