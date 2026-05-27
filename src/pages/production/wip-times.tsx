// ---------------------------------------------------------------------------
// /production/wip-times — BOM-canonical WIP times, deduplicated.
//
// One row per (resolved wipLabel × department). Variant tokens like
// `{DIVAN_HEIGHT}`, `{SIZE}` resolved from products.sizeLabel / sizeCode +
// defaultVariants. After resolution, shared WIPs (e.g. `Divan- 6FT Frame`
// across every King-size bedframe) collapse into a single row with min–max
// minutes + # products. Per Wei Siang 2026-05-11 "如果相同的 wip 出来就
// 不需要 show 一次可以了".
//
// Source: /api/wip-times — BOM templates ONLY, never job_cards. See
// routes/wip-times.ts for the rationale.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { DataGrid, type Column } from "@/components/ui/data-grid";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Clock, Download, Upload, AlertTriangle, Pencil, X, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { csrfHeaders } from "@/lib/csrf";
import { DEPARTMENTS } from "./utils";
import { useUrlState, useUrlStateBool } from "@/lib/use-url-state";
import type * as XlsxNs from "xlsx";
type XLSXModule = typeof XlsxNs;

type WipTimeRow = {
  wipLabel: string;
  departmentCode: string;
  wipType: string;
  itemCategory: string;
  itemCategories: string;
  bomMinMinutes: number;
  bomMaxMinutes: number;
  bomAvgMinutes: number;
  quantityMin: number;
  quantityMax: number;
  productCount: number;
  // Concrete product codes covered by this (wipLabel × dept) bucket —
  // surfaced so the Edit BOM Time dialog can list which BOMs an inline
  // edit will touch ("Will update 2 products: 5530-L(LHF), 5530-L(RHF)").
  productCodes: string[];
  hasZeroMinutes: boolean;
};

type WipTimeResponse = {
  success?: boolean;
  data?: WipTimeRow[];
};

function rowKey(r: WipTimeRow): string {
  return `${r.wipLabel}::${r.departmentCode}`;
}

const DEPT_LABEL_BY_CODE = new Map<string, string>(
  DEPARTMENTS.map((d) => [d.code, d.name]),
);

// wipType raw codes → friendly labels operators use on paper sheets.
// Matches DEFAULT_WIP_DEPT_CHAINS keys on the server.
const WIP_TYPE_LABELS: Record<string, string> = {
  DIVAN: "Divan",
  HEADBOARD: "HB",
  SOFA_BASE: "Base",
  SOFA_CUSHION: "Back Cushion",
  SOFA_ARMREST: "Armrest",
  SOFA_HEADREST: "Headrest",
  FG_MAIN: "FG",
};
// Type-filter options surfaced in the dropdown — ordered by how often they
// show up in operator conversations (HB / Divan are the biggest bedframe
// concerns, Base / Cushion / Arm for sofa).
const WIP_TYPE_OPTIONS = [
  "HEADBOARD",
  "DIVAN",
  "SOFA_BASE",
  "SOFA_CUSHION",
  "SOFA_ARMREST",
  "SOFA_HEADREST",
  "FG_MAIN",
] as const;
function wipTypeLabel(code: string): string {
  return WIP_TYPE_LABELS[code] ?? code;
}
// Pill color per wipType — keeps the table scan-able. Same palette spirit
// as the Category badges.
function wipTypePillClass(code: string): string {
  switch (code) {
    case "DIVAN":
      return "bg-[#F0E5E1] text-[#7A4A3A]";
    case "HEADBOARD":
      return "bg-[#E5EEF6] text-[#3E6570]";
    case "SOFA_BASE":
      return "bg-[#E8E5F0] text-[#574B79]";
    case "SOFA_CUSHION":
      return "bg-[#F0EBDC] text-[#7A6A3A]";
    case "SOFA_ARMREST":
      return "bg-[#E5F0E8] text-[#3A7A4A]";
    case "SOFA_HEADREST":
      return "bg-[#F0E5EC] text-[#7A3A6A]";
    default:
      return "bg-[#F0ECE9] text-[#5A5550]";
  }
}

function fmtMinutes(min: number): string {
  if (min <= 0) return "—";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// "Xm" when flat across products, "Xm – Yh Zm (avg Wm)" when minutes
// vary (e.g. headboard FC ranges 30-90 across product models).
function fmtBomRange(min: number, max: number, avg: number): string {
  if (max === 0 && min === 0) return "0m";
  if (min === max) return fmtMinutes(min);
  const left = min === 0 ? "0m" : fmtMinutes(min);
  return `${left} – ${fmtMinutes(max)} (avg ${fmtMinutes(avg)})`;
}

// "2 PCS" when same across products, "1–2 PCS" when it varies (e.g. divan
// quantity differs by bed size — K has 2, S has 1).
function fmtQty(qMin: number, qMax: number): string {
  if (qMin === qMax) return `${qMin} PCS`;
  return `${qMin}–${qMax} PCS`;
}

// Inline-edit state for the BOM Time cell. Null when the dialog is closed.
type EditState = {
  wipLabel: string;
  departmentCode: string;
  bomMinMinutes: number;
  bomMaxMinutes: number;
  bomAvgMinutes: number;
  productCount: number;
  // Product codes this edit will touch — listed in the dialog so the
  // operator can see EXACTLY which products get re-stamped before they
  // click Apply.
  productCodes: string[];
  // What the user is currently typing.
  draftMinutes: string;
};

export default function WipTimesPage() {
  const [dept, setDept] = useUrlState<string>("dept", "");
  const [category, setCategory] = useUrlState<string>("category", "");
  const [wipType, setWipType] = useUrlState<string>("wipType", "");
  // Toggle that narrows the grid to rows with hasZeroMinutes=true (i.e. at
  // least one product whose BOM hasn't set a time for this WIP × dept).
  // Wired to the "⚠️ Missing BOM time" summary card so clicking it filters
  // the table to exactly that backlog — operator can punch through and
  // edit each row in place. URL-stateful so the filter survives reloads.
  const [missingOnly, setMissingOnly] = useUrlStateBool("missing", false);
  const [exporting, setExporting] = useState(false);
  const [editing, setEditing] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Import-from-Excel state. The flow is two-step:
  //   1. Operator picks a file → we parse + POST dryRun → render `importPreview`
  //   2. Operator clicks "Apply N changes" → we POST dryRun:false → toast result
  // `importItems` holds the parsed rows so step 2 doesn't re-parse the file.
  type ImportItem = { wipLabel: string; deptCode: string; minutes: number };
  type ImportPreview = {
    totalItems: number;
    validItems: number;
    applied: number;
    skipped: number;
    appliedBomCount: number;
    itemErrors: { rowIdx: number; error: string }[];
    perItem: Array<{
      wipLabel: string;
      deptCode: string;
      minutes: number;
      updatedBomCount: number;
      updatedNodeCount: number;
    }>;
  };
  const [importing, setImporting] = useState(false);
  const [importItems, setImportItems] = useState<ImportItem[] | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportPreview | null>(null);

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (dept) params.set("dept", dept);
    if (category) params.set("category", category);
    const qs = params.toString();
    return qs ? `/api/wip-times?${qs}` : "/api/wip-times";
  }, [dept, category]);

  const { data: resp, loading } = useCachedJson<WipTimeResponse>(url);
  // wipType filter is client-side — server returns wipType per row so we
  // filter in JS rather than re-fetch. Keeps the cache hit when the user
  // toggles between types within the same dept/category scope.
  const rows: (WipTimeRow & { _key: string })[] = useMemo(
    () =>
      (resp?.data ?? [])
        .filter((r) => !wipType || r.wipType === wipType)
        .filter((r) => !missingOnly || r.hasZeroMinutes)
        .map((r) => ({
          ...r,
          _key: rowKey(r),
        })),
    [resp, wipType, missingOnly],
  );

  // Totals: # WIPs in scope, sum of unique-product appearances, avg minutes
  // across WIPs (per WIP, not per appearance), # ⚠️ missing.
  const totals = useMemo(() => {
    if (rows.length === 0) {
      return { wips: 0, productAppearances: 0, avgMinutes: 0, missing: 0 };
    }
    const productAppearances = rows.reduce((s, r) => s + r.productCount, 0);
    const nonZero = rows.filter((r) => r.bomAvgMinutes > 0);
    const avgMinutes = nonZero.length
      ? Math.round(
          nonZero.reduce((s, r) => s + r.bomAvgMinutes, 0) / nonZero.length,
        )
      : 0;
    const missing = rows.filter((r) => r.hasZeroMinutes).length;
    return {
      wips: rows.length,
      productAppearances,
      avgMinutes,
      missing,
    };
  }, [rows]);

  // -- Inline edit save -----------------------------------------------------
  // PUTs the new minutes value to /api/wip-times, which finds every ACTIVE
  // BOM template containing this (wipLabel × deptCode) and overwrites the
  // matching process.minutes in their wipComponents JSON. One row in the UI
  // = N BOMs on the server (N = productCount).
  const handleSaveEdit = async () => {
    if (!editing || saving) return;
    setSaveError(null);
    const m = Number(editing.draftMinutes.trim());
    if (!Number.isFinite(m) || m < 0 || m > 1440) {
      setSaveError("Enter a number between 0 and 1440 (24h cap).");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/wip-times", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          wipLabel: editing.wipLabel,
          deptCode: editing.departmentCode,
          minutes: m,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      // Invalidate every /api/wip-times cache key — filter combos differ
      // so a prefix invalidation catches them all (with-dept, with-cat etc).
      invalidateCachePrefix("/api/wip-times");
      setEditing(null);
      // Force the page-bound useCachedJson to refetch by mutating url state
      // not strictly needed — invalidateCachePrefix already flips the cache
      // entry; the next render's useCachedJson will see the fresh fetch.
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // -- Excel export ---------------------------------------------------------
  const handleExport = async () => {
    if (rows.length === 0 || exporting) return;
    setExporting(true);
    try {
      const XLSX: XLSXModule = await import("xlsx");

      const headerRow = [
        "WIP",
        "Type",
        "WIP Type Code",
        "Department",
        "Category",
        "Qty Min",
        "Qty Max",
        "Quantity",
        "BOM Min Minutes",
        "BOM Max Minutes",
        "BOM Avg Minutes",
        "BOM Time",
        "# Products",
        "BOM Missing?",
      ];

      const dataRows = rows.map((r) => [
        r.wipLabel,
        wipTypeLabel(r.wipType),
        r.wipType,
        DEPT_LABEL_BY_CODE.get(r.departmentCode) ?? r.departmentCode,
        r.itemCategories || r.itemCategory || "",
        r.quantityMin,
        r.quantityMax,
        fmtQty(r.quantityMin, r.quantityMax),
        r.bomMinMinutes,
        r.bomMaxMinutes,
        r.bomAvgMinutes,
        fmtBomRange(r.bomMinMinutes, r.bomMaxMinutes, r.bomAvgMinutes),
        r.productCount,
        r.hasZeroMinutes ? "YES" : "",
      ]);

      const aoa: (string | number)[][] = [headerRow, ...dataRows];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = headerRow.map((h, colIdx) => {
        let maxLen = h.length + 2;
        for (const row of dataRows) {
          const len = String(row[colIdx] ?? "").length;
          if (len > maxLen) maxLen = len;
        }
        return { wch: Math.min(Math.max(maxLen, 10), 50) };
      });

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "WIP Times");

      const scopeParts: string[] = [];
      if (dept) scopeParts.push(dept.toLowerCase());
      if (category) scopeParts.push(category.toLowerCase());
      const scope = scopeParts.length > 0 ? scopeParts.join("-") : "all";
      XLSX.writeFile(wb, `wip-times-${scope}.xlsx`);
    } finally {
      setExporting(false);
    }
  };

  // -- Excel import ---------------------------------------------------------
  //
  // The operator workflow we're matching:
  //   1. Hit Export Excel → edit the 'BOM Avg Minutes' column → save.
  //   2. Hit Import Excel → pick the file.
  //   3. See preview ("Will update X products in Y BOMs") → confirm.
  //
  // Parser rules (defensive):
  //   - Header row is row 1. We find columns by name, NOT by position,
  //     so the operator can reorder/hide columns in Excel without
  //     breaking the import.
  //   - Required headers: "WIP", "WIP Type Code", "Department",
  //     "BOM Avg Minutes". The first three identify the row, the last
  //     is the value to write.
  //   - Department comes through as a human label ("Foam"). We map it
  //     back to its code via DEPARTMENTS so the backend's deptCode
  //     match still works.
  //   - Rows where BOM Avg Minutes is blank or 0 are dropped (no
  //     intent to change), so the import only writes the cells the
  //     operator actually edited.
  const DEPT_CODE_BY_LABEL = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of DEPARTMENTS) {
      m.set(d.name.toLowerCase(), d.code);
      m.set(d.code.toLowerCase(), d.code);
    }
    return m;
  }, []);

  const handleImportFile = async (file: File) => {
    setImportError(null);
    setImportPreview(null);
    setImportResult(null);
    setImporting(true);
    try {
      const XLSX: XLSXModule = await import("xlsx");
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheetName = wb.SheetNames[0];
      if (!sheetName) {
        setImportError("Workbook has no sheets");
        return;
      }
      const ws = wb.Sheets[sheetName];
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
      if (aoa.length < 2) {
        setImportError("No data rows after the header");
        return;
      }
      const headerRow = aoa[0] as unknown[];
      const headers = headerRow.map((h) =>
        typeof h === "string" ? h.trim().toLowerCase() : "",
      );
      const findCol = (...names: string[]): number => {
        for (const n of names) {
          const i = headers.indexOf(n.toLowerCase());
          if (i >= 0) return i;
        }
        return -1;
      };
      const colWip = findCol("WIP");
      const colDept = findCol("Department");
      // colWipTypeCode is read from the export header but not used for
      // matching — backend matches by (wipLabel, deptCode) already.
      // Keeping the findCol call (commented out) as documentation of the
      // exported columns the import contract is compatible with.
      // const colWipTypeCode = findCol("WIP Type Code");
      const colMinutes = findCol("BOM Avg Minutes", "BOM Minutes", "Minutes");
      if (colWip < 0 || colDept < 0 || colMinutes < 0) {
        setImportError(
          `Missing required columns. Need "WIP", "Department", and "BOM Avg Minutes" — found ${headers.filter((h) => h).join(", ") || "no headers"}.`,
        );
        return;
      }

      const items: ImportItem[] = [];
      const parseErrors: string[] = [];
      for (let i = 1; i < aoa.length; i++) {
        const row = aoa[i] as unknown[];
        if (!row || row.length === 0) continue;
        const wip = typeof row[colWip] === "string" ? (row[colWip] as string).trim() : "";
        const deptRaw =
          typeof row[colDept] === "string" ? (row[colDept] as string).trim() : "";
        const minutesRaw = row[colMinutes];
        // Blank/zero minutes = "no change intended" — skip.
        const minutes =
          typeof minutesRaw === "number"
            ? minutesRaw
            : Number(minutesRaw);
        if (!wip) continue;
        if (!Number.isFinite(minutes) || minutes <= 0) continue;
        const deptCode = DEPT_CODE_BY_LABEL.get(deptRaw.toLowerCase());
        if (!deptCode) {
          parseErrors.push(
            `Row ${i + 1}: unknown department "${deptRaw}" — must match one of ${DEPARTMENTS.map((d) => d.name).join(", ")}`,
          );
          continue;
        }
        items.push({ wipLabel: wip, deptCode, minutes });
      }

      if (items.length === 0) {
        setImportError(
          parseErrors.length > 0
            ? `No valid rows. First parse errors: ${parseErrors.slice(0, 3).join("; ")}`
            : "No rows with non-zero BOM Avg Minutes — fill in the column and try again.",
        );
        return;
      }

      // Dry-run preview — backend tells us how many BOMs / nodes would
      // actually change. This is what the confirmation dialog shows.
      const res = await fetch("/api/wip-times/bulk-import", {
        method: "POST",
        headers: csrfHeaders(),
        credentials: "include",
        body: JSON.stringify({ items, dryRun: true }),
      });
      const json = (await res.json()) as { success: boolean; error?: string } & ImportPreview;
      if (!res.ok || !json.success) {
        setImportError(json.error || `Preview failed (HTTP ${res.status})`);
        return;
      }
      setImportItems(items);
      setImportPreview(json);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const handleImportConfirm = async () => {
    if (!importItems || importItems.length === 0 || importing) return;
    setImporting(true);
    setImportError(null);
    try {
      const res = await fetch("/api/wip-times/bulk-import", {
        method: "POST",
        headers: csrfHeaders(),
        credentials: "include",
        body: JSON.stringify({ items: importItems, dryRun: false }),
      });
      const json = (await res.json()) as { success: boolean; error?: string } & ImportPreview;
      if (!res.ok || !json.success) {
        setImportError(json.error || `Apply failed (HTTP ${res.status})`);
        return;
      }
      setImportResult(json);
      setImportPreview(null);
      setImportItems(null);
      // Invalidate the wip-times cache so the page reflects the new
      // numbers without a manual refresh.
      invalidateCachePrefix("/api/wip-times");
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  };

  const cancelImport = () => {
    setImportItems(null);
    setImportPreview(null);
    setImportError(null);
    setImportResult(null);
  };

  const columns: Column<WipTimeRow & { _key: string }>[] = useMemo(
    () => [
      {
        key: "wipLabel",
        label: "WIP",
        sortable: true,
        width: "360px",
        render: (_v, r) => (
          <span
            className="font-semibold text-[#1F1D1B] truncate block"
            title={r.wipLabel}
          >
            {r.wipLabel}
          </span>
        ),
      },
      {
        key: "quantityMax",
        label: "Qty / Bed",
        sortable: true,
        align: "right",
        width: "110px",
        render: (_v, r) => (
          <span className="tabular-nums text-[#8A8680]">
            {fmtQty(r.quantityMin, r.quantityMax)}
          </span>
        ),
      },
      {
        key: "departmentCode",
        label: "Department",
        sortable: true,
        width: "150px",
        render: (_v, r) => (
          <span className="text-[#5A5550]">
            {DEPT_LABEL_BY_CODE.get(r.departmentCode) ?? r.departmentCode}
          </span>
        ),
      },
      {
        key: "wipType",
        label: "Type",
        sortable: true,
        width: "140px",
        render: (_v, r) => {
          if (!r.wipType) return <span className="text-[#9CA3AF]">—</span>;
          return (
            <span
              className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${wipTypePillClass(r.wipType)}`}
            >
              {wipTypeLabel(r.wipType)}
            </span>
          );
        },
      },
      {
        key: "itemCategories",
        label: "Category",
        sortable: true,
        width: "150px",
        render: (_v, r) => {
          const cats = (r.itemCategories || r.itemCategory)
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean);
          if (cats.length === 0)
            return <span className="text-[#9CA3AF]">—</span>;
          if (cats.length === 1) {
            const c = cats[0];
            return (
              <span
                className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${
                  c === "SOFA"
                    ? "bg-[#E5EEF6] text-[#3E6570]"
                    : c === "BEDFRAME"
                      ? "bg-[#F0E5E1] text-[#7A4A3A]"
                      : "bg-[#F0ECE9] text-[#5A5550]"
                }`}
              >
                {c}
              </span>
            );
          }
          return (
            <span className="text-[10px] font-semibold text-[#5A5550]">
              {cats.join(" · ")}
            </span>
          );
        },
      },
      {
        key: "bomMaxMinutes",
        label: "BOM Time",
        sortable: true,
        align: "right",
        // 270px — fits "30m – 1h 30m (avg 53m)" + the pencil icon.
        width: "270px",
        render: (_v, r) => (
          <span className="inline-flex items-center gap-1.5 justify-end">
            {r.hasZeroMinutes && (
              <span
                title="BOM hasn't set a time for at least one product using this WIP — click ✏️ to fill it in."
                className="inline-flex items-center"
              >
                <AlertTriangle className="h-3.5 w-3.5 text-[#C99A3F]" />
              </span>
            )}
            <span
              className={`tabular-nums font-semibold ${
                r.bomMaxMinutes === 0 ? "text-[#C99A3F]" : "text-[#1F1D1B]"
              }`}
            >
              {fmtBomRange(r.bomMinMinutes, r.bomMaxMinutes, r.bomAvgMinutes)}
            </span>
            <button
              type="button"
              title={`Edit BOM minutes for "${r.wipLabel}" — applies to all ${r.productCount} product(s) using this WIP`}
              onClick={() =>
                setEditing({
                  wipLabel: r.wipLabel,
                  departmentCode: r.departmentCode,
                  bomMinMinutes: r.bomMinMinutes,
                  bomMaxMinutes: r.bomMaxMinutes,
                  bomAvgMinutes: r.bomAvgMinutes,
                  productCount: r.productCount,
                  productCodes: r.productCodes ?? [],
                  // Seed input with current value — avg is the most useful
                  // single starting point when min == max (which is the
                  // common case); for ranges, user can replace.
                  draftMinutes: String(r.bomAvgMinutes),
                })
              }
              className="ml-1 p-1 rounded hover:bg-[#F0ECE9] text-[#8A8680] hover:text-[#6B5C32]"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </span>
        ),
      },
      {
        key: "productCount",
        label: "# Products",
        sortable: true,
        align: "right",
        width: "120px",
        render: (_v, r) => (
          <span className="tabular-nums text-[#8A8680]">
            {r.productCount.toLocaleString()}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-[#1F1D1B] flex items-center gap-2">
            <Clock className="h-6 w-6 text-[#6B5C32]" />
            WIP Production Times
          </h1>
          <p className="text-sm text-[#6B7280] mt-1">
            BOM-canonical per-unit production times. One row per WIP × department —
            same WIP across multiple products collapses into one row, with{" "}
            <span className="font-mono">Min – Max (avg)</span> minutes when
            products disagree. Variant tokens like{" "}
            <span className="font-mono">{"{SIZE}"}</span> resolve to the product's
            actual size (e.g. <span className="font-mono">Divan- 6FT Frame</span>).
            A <AlertTriangle className="inline h-3.5 w-3.5 text-[#C99A3F]" /> flags
            WIPs where BOM hasn't set a time yet.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 mt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={rows.length === 0 || exporting || loading}
          >
            <Download className="h-4 w-4 mr-1.5" />
            {exporting ? "Exporting…" : "Export Excel"}
          </Button>
          <label
            className={
              "inline-flex items-center justify-center rounded-md border border-[#E2DDD8] bg-white px-3 h-9 text-sm font-medium cursor-pointer hover:bg-[#FAF8F5] " +
              (importing ? "opacity-50 pointer-events-none" : "")
            }
            title="Edit BOM Avg Minutes in the exported Excel, then upload it back here to apply the changes."
          >
            <Upload className="h-4 w-4 mr-1.5" />
            {importing ? "Importing…" : "Import Excel"}
            <input
              type="file"
              accept=".xlsx,.xls"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                // Reset the input so picking the same file twice still
                // fires onChange (useful when an edited file is re-saved
                // under the same name).
                e.target.value = "";
                if (f) void handleImportFile(f);
              }}
            />
          </label>
        </div>
      </div>

      {/* Filter bar */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center flex-wrap gap-4">
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-[#1F1D1B]">
                Department
              </label>
              <select
                value={dept}
                onChange={(e) => setDept(e.target.value)}
                className="h-9 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              >
                <option value="">All departments</option>
                {DEPARTMENTS.map((d) => (
                  <option key={d.code} value={d.code}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-[#1F1D1B]">
                Category
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="h-9 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              >
                <option value="">All categories</option>
                <option value="SOFA">SOFA</option>
                <option value="BEDFRAME">BEDFRAME</option>
                <option value="ACCESSORY">ACCESSORY</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-[#1F1D1B]">Type</label>
              <select
                value={wipType}
                onChange={(e) => setWipType(e.target.value)}
                className="h-9 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              >
                <option value="">All types</option>
                {WIP_TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {wipTypeLabel(t)}
                  </option>
                ))}
              </select>
            </div>
            {(dept || category || wipType) && (
              <button
                type="button"
                onClick={() => {
                  setDept("");
                  setCategory("");
                  setWipType("");
                }}
                className="text-xs font-semibold text-[#6B5C32] hover:underline"
              >
                Clear filters
              </button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Totals strip */}
      <div className="grid gap-3 grid-cols-4">
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-xl font-bold text-[#1F1D1B] tabular-nums">
              {totals.wips.toLocaleString()}
            </p>
            <p className="text-xs text-[#6B7280] mt-0.5">WIPs in scope</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-xl font-bold text-[#1F1D1B] tabular-nums">
              {totals.productAppearances.toLocaleString()}
            </p>
            <p className="text-xs text-[#6B7280] mt-0.5">Product appearances</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-xl font-bold text-[#1F1D1B] tabular-nums">
              {fmtMinutes(totals.avgMinutes)}
            </p>
            <p className="text-xs text-[#6B7280] mt-0.5">Avg across WIPs</p>
          </CardContent>
        </Card>
        {/* Clickable card — toggles the missingOnly filter so the operator
            can punch through to the backlog (rows with hasZeroMinutes=true)
            in one click and edit each row inline. Highlighted while the
            filter is active so it's obvious the table is narrowed. */}
        <Card
          role="button"
          tabIndex={0}
          onClick={() => setMissingOnly(!missingOnly)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setMissingOnly(!missingOnly);
            }
          }}
          className={`cursor-pointer transition-colors ${
            missingOnly
              ? "ring-2 ring-[#C99A3F] bg-[#FDF6EC]"
              : "hover:bg-[#FAF9F7]"
          }`}
          title={
            missingOnly
              ? "Click to clear filter — show all WIPs"
              : "Click to filter table to WIPs missing BOM time"
          }
        >
          <CardContent className="p-3 text-center">
            <p
              className={`text-xl font-bold tabular-nums ${
                totals.missing > 0 ? "text-[#C99A3F]" : "text-[#1F1D1B]"
              }`}
            >
              {totals.missing.toLocaleString()}
            </p>
            <p className="text-xs text-[#6B7280] mt-0.5">
              ⚠️ Missing BOM time
              {missingOnly && " · filter on"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Edit BOM Time modal — opens when user clicks the ✏️ icon on a row.
          One row in the UI represents N BOM products (productCount), so the
          modal makes the "bulk update" cost visible before we PUT. */}
      {editing && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
          onClick={() => !saving && setEditing(null)}
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-md w-full"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-4 border-b border-[#E2DDD8] flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-[#1F1D1B]">
                  Edit BOM Time
                </h2>
                <p className="text-xs text-[#6B7280] mt-0.5">
                  Updates the per-unit minutes on every product's BOM.
                </p>
              </div>
              <button
                type="button"
                onClick={() => !saving && setEditing(null)}
                className="p-1 rounded hover:bg-[#F0ECE9] text-[#8A8680]"
                disabled={saving}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="px-5 py-4 space-y-4">
              <div>
                <p className="text-xs text-[#6B7280] uppercase tracking-wide">
                  WIP
                </p>
                <p className="font-semibold text-[#1F1D1B] mt-0.5">
                  {editing.wipLabel}
                </p>
                <p className="text-xs text-[#6B7280] mt-1">
                  Department:{" "}
                  <span className="font-medium text-[#1F1D1B]">
                    {DEPT_LABEL_BY_CODE.get(editing.departmentCode) ??
                      editing.departmentCode}
                  </span>
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3 bg-[#FAF9F7] rounded-md p-3 text-sm">
                <div>
                  <p className="text-xs text-[#6B7280]">Current BOM Time</p>
                  <p className="font-semibold text-[#1F1D1B] mt-0.5">
                    {fmtBomRange(
                      editing.bomMinMinutes,
                      editing.bomMaxMinutes,
                      editing.bomAvgMinutes,
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[#6B7280]">Will update</p>
                  <p className="font-semibold text-[#1F1D1B] mt-0.5">
                    {editing.productCount} product
                    {editing.productCount === 1 ? "" : "s"}
                  </p>
                </div>
              </div>

              {/* Concrete product list — operator can verify EXACTLY which
                  BOMs the inline edit will touch before Applying. Hidden
                  when zero codes (legacy API response shape) so the dialog
                  still works against older servers. Capped height so a
                  big bucket (e.g. "Divan 5FT" across 20 K/Q variants) doesn't
                  push Apply off-screen. */}
              {editing.productCodes.length > 0 && (
                <div className="bg-white border border-[#E2DDD8] rounded-md">
                  <div className="px-3 py-2 text-xs text-[#6B7280] border-b border-[#E2DDD8]">
                    Affected products
                  </div>
                  <div className="max-h-32 overflow-y-auto px-3 py-2 text-sm tabular-nums">
                    {editing.productCodes.map((code) => (
                      <div key={code} className="text-[#1F1D1B] py-0.5">
                        {code}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-[#1F1D1B] mb-1">
                  New BOM Time (minutes per unit)
                </label>
                <input
                  type="number"
                  min={0}
                  max={1440}
                  step={1}
                  value={editing.draftMinutes}
                  onChange={(e) =>
                    setEditing((prev) =>
                      prev ? { ...prev, draftMinutes: e.target.value } : prev,
                    )
                  }
                  className="w-full h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-base font-semibold tabular-nums focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  placeholder="0"
                  disabled={saving}
                  autoFocus
                />
                <p className="text-xs text-[#6B7280] mt-1">
                  0 – 1440 minutes (24h cap). Applies to all{" "}
                  {editing.productCount} matching BOM
                  {editing.productCount === 1 ? "" : "s"}.
                </p>
              </div>

              {saveError && (
                <div className="text-xs text-[#B91C1C] bg-[#FEF2F2] border border-[#FECACA] rounded p-2">
                  {saveError}
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-[#E2DDD8] flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setEditing(null)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleSaveEdit}
                disabled={saving}
                className="bg-[#6B5C32] text-white hover:bg-[#574B29]"
              >
                {saving
                  ? "Saving…"
                  : `Apply to ${editing.productCount} BOM${editing.productCount === 1 ? "" : "s"}`}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* WIP table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">
            {dept
              ? `${DEPT_LABEL_BY_CODE.get(dept) ?? dept} — WIPs`
              : "All Departments — WIPs"}
            {category && ` · ${category}`}
            <span className="ml-2 text-xs font-normal text-[#8A7F73]">
              ({totals.wips.toLocaleString()}{" "}
              {totals.wips === 1 ? "WIP" : "WIPs"})
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataGrid<WipTimeRow & { _key: string }>
            columns={columns}
            data={rows}
            keyField="_key"
            loading={loading}
            stickyHeader
            virtualize
            gridId="wip-times-list"
            maxHeight="calc(100vh - 360px)"
            emptyMessage="No BOM-defined WIPs for this scope yet. Make sure relevant products have active BOMs configured."
          />
        </CardContent>
      </Card>

      {/* Import preview / result / error overlay. Single dialog used by
          all three states so the operator never sees a stale modal. */}
      {(importPreview || importResult || importError) && (
        <div
          className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
          onClick={cancelImport}
        >
          <div
            className="w-full max-w-2xl bg-white rounded-lg shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-[#E2DDD8]">
              <h2 className="font-semibold text-[#1F1D1B]">
                {importResult
                  ? "Import complete"
                  : importError
                    ? "Import failed"
                    : "Confirm import"}
              </h2>
              <Button variant="ghost" size="sm" onClick={cancelImport}>
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="p-4 space-y-3 text-sm">
              {importError && (
                <p className="text-[#9A3A2D] bg-[#F9E1DA] p-3 rounded">
                  {importError}
                </p>
              )}
              {importPreview && !importResult && (
                <>
                  <p className="text-[#374151]">
                    Reviewing your changes — nothing has been written yet.
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-[#FAF8F5] p-3 rounded">
                      <div className="text-xs text-[#6B7280]">Rows in file</div>
                      <div className="text-xl font-bold">{importPreview.totalItems}</div>
                    </div>
                    <div className="bg-[#FAF8F5] p-3 rounded">
                      <div className="text-xs text-[#6B7280]">Valid rows</div>
                      <div className="text-xl font-bold">{importPreview.validItems}</div>
                    </div>
                    <div className="bg-[#EEF3E4] p-3 rounded">
                      <div className="text-xs text-[#6B7280]">WIPs that will change</div>
                      <div className="text-xl font-bold text-[#4F7C3A]">
                        {importPreview.applied}
                      </div>
                    </div>
                    <div className="bg-[#FAF8F5] p-3 rounded">
                      <div className="text-xs text-[#6B7280]">No-op (already at value)</div>
                      <div className="text-xl font-bold text-[#6B7280]">
                        {importPreview.skipped}
                      </div>
                    </div>
                  </div>
                  {importPreview.itemErrors.length > 0 && (
                    <div className="bg-[#FAEFCB] p-3 rounded text-xs text-[#9C6F1E] max-h-32 overflow-auto">
                      <div className="font-semibold mb-1">
                        {importPreview.itemErrors.length} row(s) skipped due to errors:
                      </div>
                      {importPreview.itemErrors.slice(0, 10).map((e, i) => (
                        <div key={i}>Row {e.rowIdx + 2}: {e.error}</div>
                      ))}
                      {importPreview.itemErrors.length > 10 && (
                        <div>… +{importPreview.itemErrors.length - 10} more</div>
                      )}
                    </div>
                  )}
                </>
              )}
              {importResult && (
                <div className="space-y-2">
                  <p className="text-[#4F7C3A] bg-[#EEF3E4] p-3 rounded flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 shrink-0" />
                    Imported {importResult.applied} WIP change(s) into{" "}
                    {importResult.appliedBomCount} BOM template(s).
                  </p>
                  {importResult.itemErrors.length > 0 && (
                    <div className="bg-[#FAEFCB] p-3 rounded text-xs text-[#9C6F1E]">
                      {importResult.itemErrors.length} row(s) reported errors — see browser console.
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 p-4 border-t border-[#E2DDD8]">
              {importPreview && !importResult && (
                <>
                  <Button variant="outline" size="sm" onClick={cancelImport}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleImportConfirm}
                    disabled={importing || importPreview.applied === 0}
                  >
                    {importing
                      ? "Applying…"
                      : `Apply ${importPreview.applied} change${importPreview.applied === 1 ? "" : "s"}`}
                  </Button>
                </>
              )}
              {(importResult || (importError && !importPreview)) && (
                <Button variant="primary" size="sm" onClick={cancelImport}>
                  Close
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
