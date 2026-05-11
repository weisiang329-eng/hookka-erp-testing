// ---------------------------------------------------------------------------
// /production/wip-times — WIP catalog reference page (BOM-canonical times).
//
// For dept supervisors + planners. Pick a Department or Category and see
// every WIP defined in BOM with its canonical per-unit production time,
// the number of products that use it, and a ⚠️ flag where BOM hasn't set
// a time yet.
//
// Source: /api/wip-times — walks ACTIVE bom_templates' wipComponents JSON
// trees and aggregates by (wipLabel × departmentCode). See routes/wip-times.ts
// for why BOM not job_cards: fabric cutting is merged across WIPs so JC totals
// don't reflect per-WIP truth, BOM does.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useCachedJson } from "@/lib/cached-fetch";
import { DataGrid, type Column } from "@/components/ui/data-grid";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Clock, Download, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DEPARTMENTS } from "./utils";
import { useUrlState } from "@/lib/use-url-state";
// xlsx is a 421KB module — dynamic-imported inside the export handler so
// page mount doesn't pull it in. Matches the BatchImportDialog pattern.
import type * as XlsxNs from "xlsx";
type XLSXModule = typeof XlsxNs;

type WipTimeRow = {
  wipLabel: string;
  departmentCode: string;
  // Primary category for the badge (first alphabetically when a WIP spans
  // categories — single-category WIPs just have this one).
  itemCategory: string;
  // Comma-joined list of distinct categories this WIP runs under. Most
  // rows have one category, but cross-category WIPs (rare) show both —
  // e.g. "BEDFRAME, SOFA". Frontend prefers this for the cell text.
  itemCategories: string;
  // BOM minutes — min/max bracket the spread across contributing BOMs,
  // avg is the arithmetic mean. UI shows range when min != max, single
  // value when flat.
  bomMinMinutes: number;
  bomMaxMinutes: number;
  bomAvgMinutes: number;
  // # of distinct products whose BOM contains this (wipLabel, dept).
  productCount: number;
  // True if ANY BOM with this WIP has minutes=0 — surfaces gaps in BOM
  // data so they can be filled in (e.g. Back Cushion / Arm currently
  // have no time set in BOM).
  hasZeroMinutes: boolean;
};

type WipTimeResponse = {
  success?: boolean;
  data?: WipTimeRow[];
};

// Stable composite key for DataGrid — wipLabel alone isn't unique because
// the same WIP runs in two depts (e.g. FAB_CUT + FAB_SEW) with their own
// minutes.
function rowKey(r: WipTimeRow): string {
  return `${r.wipLabel}::${r.departmentCode}`;
}

// Map departmentCode → human label so the column reads "Fab Sew" instead of
// "FAB_SEW". Falls back to the raw code for any dept not in the seed list.
const DEPT_LABEL_BY_CODE = new Map<string, string>(
  DEPARTMENTS.map((d) => [d.code, d.name]),
);

function fmtMinutes(min: number): string {
  if (min <= 0) return "—";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// BOM time cell — "Xh Ym" when min == max (flat across BOMs), else the
// range PLUS the avg so the planner sees spread + central tendency at a
// glance. Per Wei Siang 2026-05-11 Q1=C "show min, max, AND avg".
// Zero-only buckets render "0m" alone — the ⚠️ badge does the talking.
function fmtBomRange(min: number, max: number, avg: number): string {
  if (max === 0 && min === 0) return "0m";
  if (min === max) return fmtMinutes(min);
  // When some BOMs filled minutes and others didn't, min=0 → render as
  // "0 – Xh Ym" so the operator sees the gap explicitly. Avg always
  // appears in parens for ranges so "is 53m closer to 30m or 1h 30m?"
  // is answered without doing math.
  const left = min === 0 ? "0m" : fmtMinutes(min);
  return `${left} – ${fmtMinutes(max)} (avg ${fmtMinutes(avg)})`;
}

export default function WipTimesPage() {
  // URL-backed so a planner can deep-link to "Fab Sew + Sofa" and share it.
  const [dept, setDept] = useUrlState<string>("dept", "");
  const [category, setCategory] = useUrlState<string>("category", "");
  const [exporting, setExporting] = useState(false);

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (dept) params.set("dept", dept);
    if (category) params.set("category", category);
    const qs = params.toString();
    return qs ? `/api/wip-times?${qs}` : "/api/wip-times";
  }, [dept, category]);

  const { data: resp, loading } = useCachedJson<WipTimeResponse>(url);
  // Inject a composite `_key` per row so DataGrid (which wants a string
  // keyField, not a function) gets a stable per-row identity.
  const rows: (WipTimeRow & { _key: string })[] = useMemo(
    () =>
      (resp?.data ?? []).map((r) => ({
        ...r,
        _key: rowKey(r),
      })),
    [resp],
  );

  // Totals strip — # WIPs, # products covered, and avg of avg minutes for
  // a one-glance "how many WIPs do we have and what's the typical recipe
  // time?". Products counts distinct codes summed across rows is misleading
  // (same product appears in many WIPs), so we surface a row-count proxy
  // instead: sum of productCount (BOM appearances).
  const totals = useMemo(() => {
    if (rows.length === 0) {
      return { wips: 0, bomAppearances: 0, avgOfAvgs: 0, missing: 0 };
    }
    const bomAppearances = rows.reduce((s, r) => s + r.productCount, 0);
    const sumAvgs = rows.reduce((s, r) => s + r.bomAvgMinutes, 0);
    const missing = rows.filter((r) => r.hasZeroMinutes).length;
    return {
      wips: rows.length,
      bomAppearances,
      avgOfAvgs: Math.round(sumAvgs / rows.length),
      missing,
    };
  }, [rows]);

  // -- Excel export ---------------------------------------------------------
  // Exports rows currently in scope (after dept/category filter). Minutes
  // go out as raw integers so Excel can sum / sort; a formatted column
  // rides alongside for humans.
  const handleExport = async () => {
    if (rows.length === 0 || exporting) return;
    setExporting(true);
    try {
      const XLSX: XLSXModule = await import("xlsx");

      const headerRow = [
        "WIP",
        "Department",
        "Category",
        "BOM Min Minutes",
        "BOM Max Minutes",
        "BOM Avg Minutes",
        "BOM Time (Range)",
        "# Products",
        "BOM Missing?",
      ];

      const dataRows = rows.map((r) => [
        r.wipLabel,
        DEPT_LABEL_BY_CODE.get(r.departmentCode) ?? r.departmentCode,
        r.itemCategories || r.itemCategory || "",
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
      XLSX.utils.book_append_sheet(wb, ws, "BOM WIP Times");

      const scopeParts: string[] = [];
      if (dept) scopeParts.push(dept.toLowerCase());
      if (category) scopeParts.push(category.toLowerCase());
      const scope = scopeParts.length > 0 ? scopeParts.join("-") : "all";
      XLSX.writeFile(wb, `wip-times-${scope}.xlsx`);
    } finally {
      setExporting(false);
    }
  };

  const columns: Column<WipTimeRow & { _key: string }>[] = useMemo(
    () => [
      {
        key: "wipLabel",
        label: "WIP",
        sortable: true,
        width: "400px",
        render: (_v, r) => (
          <span
            className="font-medium text-[#1F1D1B] truncate block"
            title={r.wipLabel}
          >
            {r.wipLabel}
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
        // 240px so "30m – 1h 30m (avg 53m)" fits without truncation
        width: "240px",
        render: (_v, r) => (
          <span className="inline-flex items-center gap-1.5 justify-end">
            {r.hasZeroMinutes && (
              <span
                title="BOM has not set a time for this WIP on at least one product — fill it in to make the canonical time accurate."
                className="inline-flex items-center"
              >
                <AlertTriangle className="h-3.5 w-3.5 text-[#C99A3F]" />
              </span>
            )}
            <span
              className={`tabular-nums font-semibold ${
                r.bomMaxMinutes === 0
                  ? "text-[#C99A3F]"
                  : "text-[#1F1D1B]"
              }`}
            >
              {fmtBomRange(r.bomMinMinutes, r.bomMaxMinutes, r.bomAvgMinutes)}
            </span>
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
            walks every active BOM template and surfaces the time written for that
            WIP. When the same WIP has different minutes across products, the cell
            shows the range plus average (e.g.{" "}
            <span className="font-mono">30m – 1h 30m (avg 53m)</span>). A ⚠️
            flags WIPs where BOM hasn't filled in a time yet — those need to be
            set on the product's BOM.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleExport}
          disabled={rows.length === 0 || exporting || loading}
          className="shrink-0 mt-1"
        >
          <Download className="h-4 w-4 mr-1.5" />
          {exporting ? "Exporting…" : "Export Excel"}
        </Button>
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
            {(dept || category) && (
              <button
                type="button"
                onClick={() => {
                  setDept("");
                  setCategory("");
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
              {totals.bomAppearances.toLocaleString()}
            </p>
            <p className="text-xs text-[#6B7280] mt-0.5">BOM appearances</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-xl font-bold text-[#1F1D1B] tabular-nums">
              {fmtMinutes(totals.avgOfAvgs)}
            </p>
            <p className="text-xs text-[#6B7280] mt-0.5">Average across WIPs</p>
          </CardContent>
        </Card>
        <Card>
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
            </p>
          </CardContent>
        </Card>
      </div>

      {/* WIP table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">
            {dept
              ? `${DEPT_LABEL_BY_CODE.get(dept) ?? dept} — WIPs`
              : "All Departments — WIPs"}
            {category && ` · ${category}`}
            <span className="ml-2 text-xs font-normal text-[#8A7F73]">
              ({totals.wips} {totals.wips === 1 ? "WIP" : "WIPs"})
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
            emptyMessage="No BOM-defined WIPs for this scope yet. Make sure the relevant products have active BOMs configured."
          />
        </CardContent>
      </Card>
    </div>
  );
}
