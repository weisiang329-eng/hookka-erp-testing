// ---------------------------------------------------------------------------
// /production/wip-times — WIP catalog reference page.
//
// For dept supervisors + planners. Pick a Department or Category and see
// every WIP we've ever processed with its average production time, the
// number of historical job_cards backing the average, and the most recent
// completion date.
//
// Source: /api/wip-times — aggregates job_cards.estMinutes by
// (wipLabel × departmentCode × itemCategory). See routes/wip-times.ts for
// the rationale on using actual JC estMinutes rather than the BOM master.
// ---------------------------------------------------------------------------
import { useMemo } from "react";
import { useCachedJson } from "@/lib/cached-fetch";
import { DataGrid, type Column } from "@/components/ui/data-grid";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Clock } from "lucide-react";
import { DEPARTMENTS } from "./utils";
import { formatDateDMY } from "@/lib/utils";
import { useUrlState } from "@/lib/use-url-state";

type WipTimeRow = {
  wipLabel: string;
  departmentCode: string;
  itemCategory: string;
  avgMinutes: number;
  jcCount: number;
  lastCompletedDate: string | null;
};

type WipTimeResponse = {
  success?: boolean;
  data?: WipTimeRow[];
};

// Stable composite key for DataGrid — wipLabel alone isn't unique because
// the same WIP can appear under two depts (e.g. FAB_CUT cuts + FAB_SEW
// sews) with their own avg time.
function rowKey(r: WipTimeRow): string {
  return `${r.wipLabel}::${r.departmentCode}::${r.itemCategory}`;
}

// Map departmentCode → human label so the column reads "Fab Sew" instead of
// "FAB_SEW". Falls back to the raw code for any dept not in the seed list
// (shouldn't happen in practice — DEPARTMENTS covers every production dept).
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
  // URL-backed so a planner can deep-link to "Fab Sew + Sofa" and share it.
  const [dept, setDept] = useUrlState<string>("dept", "");
  const [category, setCategory] = useUrlState<string>("category", "");

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (dept) params.set("dept", dept);
    if (category) params.set("category", category);
    const qs = params.toString();
    return qs ? `/api/wip-times?${qs}` : "/api/wip-times";
  }, [dept, category]);

  const { data: resp, loading } = useCachedJson<WipTimeResponse>(url);
  // Inject a composite `_key` per row so DataGrid (which wants a string
  // keyField, not a function) gets a stable per-row identity. wipLabel
  // alone isn't unique — the same WIP can land in two depts (Fab Cut +
  // Fab Sew) with their own avg times.
  const rows: (WipTimeRow & { _key: string })[] = useMemo(
    () =>
      (resp?.data ?? []).map((r) => ({
        ...r,
        _key: rowKey(r),
      })),
    [resp],
  );

  // Totals strip — sum of JCs aggregated + arithmetic mean of the per-WIP
  // averages so the planner has a one-glance answer to "how many WIPs am
  // I looking at and what's the typical run time?".
  const totals = useMemo(() => {
    if (rows.length === 0) {
      return { wips: 0, jcs: 0, avgOfAvgs: 0 };
    }
    const jcs = rows.reduce((s, r) => s + r.jcCount, 0);
    const sumAvgs = rows.reduce((s, r) => s + r.avgMinutes, 0);
    return {
      wips: rows.length,
      jcs,
      avgOfAvgs: Math.round(sumAvgs / rows.length),
    };
  }, [rows]);

  const columns: Column<WipTimeRow & { _key: string }>[] = useMemo(
    () => [
      {
        key: "wipLabel",
        label: "WIP",
        sortable: true,
        width: "320px",
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
        key: "itemCategory",
        label: "Category",
        sortable: true,
        width: "120px",
        render: (_v, r) => (
          <span
            className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded uppercase tracking-wide ${
              r.itemCategory === "SOFA"
                ? "bg-[#E5EEF6] text-[#3E6570]"
                : r.itemCategory === "BEDFRAME"
                  ? "bg-[#F0E5E1] text-[#7A4A3A]"
                  : "bg-[#F0ECE9] text-[#5A5550]"
            }`}
          >
            {r.itemCategory || "—"}
          </span>
        ),
      },
      {
        key: "avgMinutes",
        label: "Avg Production Time",
        sortable: true,
        align: "right",
        width: "180px",
        render: (_v, r) => (
          <span className="tabular-nums font-semibold text-[#1F1D1B]">
            {fmtMinutes(r.avgMinutes)}
          </span>
        ),
      },
      {
        key: "jcCount",
        label: "Sample (JCs)",
        sortable: true,
        align: "right",
        width: "120px",
        render: (_v, r) => (
          <span className="tabular-nums text-[#8A8680]">
            {r.jcCount.toLocaleString()}
          </span>
        ),
      },
      {
        key: "lastCompletedDate",
        label: "Last Completed",
        sortable: true,
        width: "150px",
        render: (_v, r) => (
          <span className="text-xs text-[#8A8680] tabular-nums">
            {r.lastCompletedDate ? formatDateDMY(r.lastCompletedDate) : "—"}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1F1D1B] flex items-center gap-2">
            <Clock className="h-6 w-6 text-[#6B5C32]" />
            WIP Production Times
          </h1>
          <p className="text-sm text-[#6B7280] mt-1">
            Average production time per WIP, aggregated from every job card
            we've completed. Pick a department or category to scope the list.
          </p>
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
      <div className="grid gap-3 grid-cols-3">
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
              {totals.jcs.toLocaleString()}
            </p>
            <p className="text-xs text-[#6B7280] mt-0.5">
              Total job cards aggregated
            </p>
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
            emptyMessage="No completed job cards yet for this scope. Once orders run through the floor, their estMinutes show up here."
          />
        </CardContent>
      </Card>
    </div>
  );
}
