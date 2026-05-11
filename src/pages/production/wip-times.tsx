// ---------------------------------------------------------------------------
// /production/wip-times — paper-style WIP catalog (per product × WIP node × dept).
//
// Replaces the paper reference sheets (Sofa Fab Cut / Headboard Foam Bonding /
// Divan Framing etc.). One row per (productCode × BOM WIP node × dept), with
// WIP labels variant-resolved from each product's defaultVariants. Filter by
// department = one paper sheet's contents.
//
// Source: /api/wip-times — BOM templates only, NOT job_cards. See
// routes/wip-times.ts for the rationale.
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
// page mount doesn't pull it in.
import type * as XlsxNs from "xlsx";
type XLSXModule = typeof XlsxNs;

type WipTimeRow = {
  productCode: string;
  baseModel: string;
  category: string;
  wipLabel: string;
  wipType: string;
  quantity: number;
  departmentCode: string;
  bomMinutes: number;
  hasZeroMinutes: boolean;
};

type WipTimeResponse = {
  success?: boolean;
  data?: WipTimeRow[];
};

// Composite key — same productCode × dept can emit multiple rows (one per
// WIP node), so include wipLabel + wipType to keep DataGrid happy.
function rowKey(r: WipTimeRow, idx: number): string {
  return `${r.productCode}::${r.departmentCode}::${r.wipLabel}::${r.wipType}::${idx}`;
}

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

export default function WipTimesPage() {
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
  const rows: (WipTimeRow & { _key: string })[] = useMemo(
    () =>
      (resp?.data ?? []).map((r, idx) => ({
        ...r,
        _key: rowKey(r, idx),
      })),
    [resp],
  );

  // Totals — # rows, # distinct products, avg minutes, # ⚠️ missing.
  const totals = useMemo(() => {
    if (rows.length === 0) {
      return { rows: 0, products: 0, avgMinutes: 0, missing: 0 };
    }
    const products = new Set(rows.map((r) => r.productCode)).size;
    // Avg over non-zero rows so ⚠️ entries don't sink the number; we
    // surface the missing count separately.
    const nonZero = rows.filter((r) => r.bomMinutes > 0);
    const sumMin = nonZero.reduce((s, r) => s + r.bomMinutes, 0);
    const avgMinutes = nonZero.length > 0 ? Math.round(sumMin / nonZero.length) : 0;
    const missing = rows.filter((r) => r.hasZeroMinutes).length;
    return { rows: rows.length, products, avgMinutes, missing };
  }, [rows]);

  // -- Excel export ---------------------------------------------------------
  const handleExport = async () => {
    if (rows.length === 0 || exporting) return;
    setExporting(true);
    try {
      const XLSX: XLSXModule = await import("xlsx");

      const headerRow = [
        "Product Code",
        "Base Model",
        "Category",
        "WIP",
        "WIP Type",
        "Quantity",
        "Department",
        "BOM Minutes",
        "BOM Time",
        "BOM Missing?",
      ];

      const dataRows = rows.map((r) => [
        r.productCode,
        r.baseModel,
        r.category,
        r.wipLabel,
        r.wipType,
        r.quantity,
        DEPT_LABEL_BY_CODE.get(r.departmentCode) ?? r.departmentCode,
        r.bomMinutes,
        fmtMinutes(r.bomMinutes),
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

  const columns: Column<WipTimeRow & { _key: string }>[] = useMemo(
    () => [
      {
        key: "productCode",
        label: "Product Code",
        sortable: true,
        width: "180px",
        render: (_v, r) => (
          <span
            className="font-semibold text-[#1F1D1B] truncate block"
            title={r.productCode}
          >
            {r.productCode}
          </span>
        ),
      },
      {
        key: "wipLabel",
        label: "WIP",
        sortable: true,
        width: "320px",
        render: (_v, r) => (
          <span
            className="text-[#1F1D1B] truncate block"
            title={r.wipLabel}
          >
            {r.wipLabel}
          </span>
        ),
      },
      {
        key: "quantity",
        label: "Qty / Bed",
        sortable: true,
        align: "right",
        width: "100px",
        render: (_v, r) => (
          <span className="tabular-nums text-[#8A8680]">
            {r.quantity} PCS
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
        key: "category",
        label: "Category",
        sortable: true,
        width: "130px",
        render: (_v, r) => {
          if (!r.category) return <span className="text-[#9CA3AF]">—</span>;
          return (
            <span
              className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${
                r.category === "SOFA"
                  ? "bg-[#E5EEF6] text-[#3E6570]"
                  : r.category === "BEDFRAME"
                    ? "bg-[#F0E5E1] text-[#7A4A3A]"
                    : "bg-[#F0ECE9] text-[#5A5550]"
              }`}
            >
              {r.category}
            </span>
          );
        },
      },
      {
        key: "bomMinutes",
        label: "BOM Time",
        sortable: true,
        align: "right",
        width: "150px",
        render: (_v, r) => (
          <span className="inline-flex items-center gap-1.5 justify-end">
            {r.hasZeroMinutes && (
              <span
                title="BOM hasn't set a time for this WIP — fill it in on the product's BOM."
                className="inline-flex items-center"
              >
                <AlertTriangle className="h-3.5 w-3.5 text-[#C99A3F]" />
              </span>
            )}
            <span
              className={`tabular-nums font-semibold ${
                r.bomMinutes === 0 ? "text-[#C99A3F]" : "text-[#1F1D1B]"
              }`}
            >
              {r.bomMinutes === 0 ? "0m" : fmtMinutes(r.bomMinutes)}
            </span>
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
            BOM-canonical per-unit production times by product. One row per
            (product × WIP × department) — variant tokens like{" "}
            <span className="font-mono">{"{DIVAN_HEIGHT}"}</span> are resolved
            against each product's default variants (e.g.{" "}
            <span className="font-mono">8" Divan- K (FC)</span>). Filter by
            department to get the equivalent of one paper reference sheet. A{" "}
            <AlertTriangle className="inline h-3.5 w-3.5 text-[#C99A3F]" /> flags
            WIPs where BOM hasn't set a time yet.
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
              {totals.rows.toLocaleString()}
            </p>
            <p className="text-xs text-[#6B7280] mt-0.5">Rows in scope</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-xl font-bold text-[#1F1D1B] tabular-nums">
              {totals.products.toLocaleString()}
            </p>
            <p className="text-xs text-[#6B7280] mt-0.5">Distinct products</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 text-center">
            <p className="text-xl font-bold text-[#1F1D1B] tabular-nums">
              {fmtMinutes(totals.avgMinutes)}
            </p>
            <p className="text-xs text-[#6B7280] mt-0.5">Avg per WIP node</p>
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

      {/* Main table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">
            {dept
              ? `${DEPT_LABEL_BY_CODE.get(dept) ?? dept} — WIPs`
              : "All Departments — WIPs"}
            {category && ` · ${category}`}
            <span className="ml-2 text-xs font-normal text-[#8A7F73]">
              ({totals.rows.toLocaleString()}{" "}
              {totals.rows === 1 ? "row" : "rows"} ·{" "}
              {totals.products.toLocaleString()} products)
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
    </div>
  );
}
