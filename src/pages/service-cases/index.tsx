// ---------------------------------------------------------------------------
// Service Cases — top-level list page (parent of Service Orders).
//
// Per design 2026-04-28: every customer-facing service interaction lives
// here. A Case is just a record (issue + photos + RCA + customer); a Case
// can spawn 0..N Service Orders for the heavy resolution work
// (REPRODUCE / STOCK_SWAP / REPAIR).
//
// Navigation flow:
//   Sidebar "Service Cases" → this page → click row → /service-cases/:id
//   On the detail page, you see the case info + any spawned orders, and
//   can spawn more orders or close the case.
//
// The list renders through the shared DataGrid (2026-06-12) — same sort /
// per-column filter / Columns picker / resize behaviour and typography as
// every other module's list. Status chips above the grid pre-scope the
// rows; Export CSV downloads whatever the grid currently shows.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import {
  computeCasePipeline,
  caseDaysOpen,
  caseStageDays,
} from "@/lib/case-pipeline";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { DataGrid, type Column } from "@/components/ui/data-grid";
import { getCurrentUser } from "@/lib/auth";
import { compressImage } from "@/lib/image-compress";
import { exportToCsv } from "@/lib/export-csv";
import { formatDateDMY } from "@/lib/utils";
import { Plus, X, AlertCircle, Loader2, Download } from "lucide-react";

type CaseStatus = "OPEN" | "IN_PROGRESS" | "CLOSED" | "CANCELLED";
type SourceType = "SO" | "CO" | "EXTERNAL";

// STATUS_COLOR removed — the raw OPEN/IN_PROGRESS/CLOSED/CANCELLED status
// column is gone (the pipeline Stage is the owner's real status now). The
// status filter chips above the grid style themselves inline.

const ROOT_CAUSE_COLOR: Record<string, string> = {
  PRODUCTION: "bg-[#F4EFE3] text-[#6B5C32]",
  DESIGN: "bg-[#E0EAF4] text-[#3A5670]",
  MATERIAL: "bg-[#E8D8B2] text-[#6B5C32]",
  PROCESS: "bg-[#E2DDD8] text-[#5A5550]",
  CUSTOMER: "bg-[#F5DCDC] text-[#7A2E24]",
  TRANSPORT: "bg-[#FAF7F0] text-[#6B5C32]",
  OTHER: "bg-[#F0ECE9] text-[#5A5550]",
};

// Human labels for the (possibly several) root-cause categories on a case.
// Mirrors detail.tsx's ROOT_CAUSE_LABELS — kept local so the list page has no
// cross-page import. The joined label feeds the Category column's badges,
// sort, value filter and CSV export.
const ROOT_CAUSE_LABELS: Record<string, string> = {
  PRODUCTION: "Production / workmanship",
  DESIGN: "Design / R&D",
  MATERIAL: "Material / supplier",
  PROCESS: "Process / SOP gap",
  CUSTOMER: "Customer (not our fault)",
  TRANSPORT: "Transport / 3PL",
  SALES: "Sales / order-taking error",
  PICKING: "Picking / packing error",
  OTHER: "Other",
};

// Stage chip tint, indexed by Case Pipeline stage. Early stages are warm/
// neutral, the in-production stretch is blue, Delivered/Closed go green/grey
// — a coarse at-a-glance read of where the case sits. Falls back by index.
const STAGE_COLOR: Record<string, string> = {
  Opened: "bg-[#F4EFE3] text-[#6B5C32]",
  Investigating: "bg-[#E8D8B2] text-[#6B5C32]",
  "Service Order": "bg-[#E0EAF4] text-[#3A5670]",
  "Repair in progress": "bg-[#E0EAF4] text-[#3A5670]",
  "Repair done": "bg-[#E0EAF4] text-[#3A5670]",
  "Delivery arranged": "bg-[#DCEBDC] text-[#3A6B3A]",
  Delivered: "bg-[#DCEBDC] text-[#3A6B3A]",
  Closed: "bg-[#E2DDD8] text-[#5A5550]",
  // A cancelled case is not a stage on the chain — it is the chain stopping.
  // Red so it cannot be mistaken for progress at a glance.
  Cancelled: "bg-[#F5DCDC] text-[#7A2E24]",
};

// Service CASES can be opened against any source order status — a customer
// might complain about an order that hasn't shipped yet ("where is it?",
// "I want to change colour before it ships", "cancel my order"). Only
// Service ORDERS (rework/swap/repair, spawned later) require shipped
// status because rework only makes sense after physical handover.
//
// Cancelled/draft orders are excluded since logging a case against
// something that was never confirmed is almost always a mistake.
const EXCLUDED_SOURCE_STATUSES = new Set(["DRAFT", "CANCELLED"]);

type ServiceCaseListItem = {
  id: string;
  caseNo: string;
  sourceType: SourceType;
  sourceNo: string;
  customerName: string;
  status: CaseStatus;
  createdAt: string;
  closedAt: string;
  // First-IN_PROGRESS timestamp (migration 0168) — dates the Investigating
  // pipeline stage. "" / null until the case is first marked In Progress.
  investigatingAt?: string | null;
  rootCauseCategory: string | null;
  // Multi root causes (migration 0169) — a case can have several. Always
  // present (the GET synthesizes a one-element array from the legacy single
  // category for old cases). The Category column joins these labels; the
  // legacy rootCauseCategory above stays for back-compat.
  rootCauses?: Array<{ category: string; details?: Record<string, unknown> }>;
  // Per-category structured RCA fields (JSON). The Department column reads
  // whichever dept-name field the active category stored (see deptForCase).
  rootCauseDetails?: Record<string, unknown> | null;
  responsibleUnit: string | null;
  issueDescription: string;
  affectedProducts: Array<{ productId: string; code: string; name: string; qty?: number | null }>;
  // orders carry isSv + createdAt (rowToApi returns them) so the pipeline
  // derivation can tell SV (sales_orders) from legacy service_orders and
  // date the Service Order stage.
  orders: { id: string; serviceOrderNo: string; status: string; mode: string | null; isSv?: boolean; createdAt?: string }[];
};

type SourceOrderOption = {
  id: string;
  customerName: string;
  status: string;
  companyOrderId: string;
  // Customer-side document numbers the operator may quote instead of our
  // order id (customers report issues off THEIR paperwork — same rationale
  // as the service-order Copy-from lookup, 2026-06-11). Empty when unset.
  customerPO: string;
  customerSO: string;
  reference: string;
};

// Minimal shapes off the two bulk lists the pipeline derivation needs. One
// fetch each (cached) feeds every row — never per-row.
type DeliveryOrderApi = {
  id: string;
  salesOrderId?: string | null;
  status?: string;
  createdAt?: string | null;
  dispatchedAt?: string | null;
  deliveredAt?: string | null;
};
type ProductionOrderApi = {
  id: string;
  salesOrderId?: string | null;
  jobCards?: Array<{ completedDate?: string | null }>;
};

// Department responsible for the issue — read from the per-category RCA
// detail JSON. Each category's picker writes a different dept-name field
// (detail.tsx CategoryDetailsForm): PRODUCTION / PROCESS / PICKING write
// `departmentName`; DESIGN writes `designDeptName`. MATERIAL / TRANSPORT /
// SALES / CUSTOMER / OTHER have no department. Returns the first non-empty
// dept name found, else "" (rendered as "—").
function deptForCase(details: Record<string, unknown> | null | undefined): string {
  if (!details || typeof details !== "object") return "";
  for (const key of ["departmentName", "designDeptName"]) {
    const v = details[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

// A case can have several root-cause categories (migration 0169). Returns the
// distinct, valid category CODES in order. Falls back to the legacy single
// rootCauseCategory when the multi array is absent (old cases the GET didn't
// synthesize, or a stale client). Order preserved, duplicates dropped.
function categoryCodesForCase(c: ServiceCaseListItem): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (code: string | null | undefined) => {
    if (!code || !(code in ROOT_CAUSE_LABELS) || seen.has(code)) return;
    seen.add(code);
    out.push(code);
  };
  if (Array.isArray(c.rootCauses) && c.rootCauses.length > 0) {
    for (const rc of c.rootCauses) push(rc?.category);
  } else {
    push(c.rootCauseCategory);
  }
  return out;
}

// Joined human labels for the case's categories — "Design / R&D, Material /
// supplier". Empty → "". Shared by the Category column's sort key, value
// filter and CSV export so all three read exactly like the grid.
function categoriesLabel(codes: string[]): string {
  return codes.map((code) => ROOT_CAUSE_LABELS[code] ?? code).join(", ");
}

// Grid row = the API case + flat precomputed fields. DataGrid resolves
// sort / per-column filter / global-search values by column key, so every
// displayed value needs to live ON the row (not be derived inside render)
// for those features to see what the cell shows. Same shape feeds the CSV
// export so the download matches the grid exactly.
type CaseRow = ServiceCaseListItem & {
  source: string; // "SO-2605-198" / "EXTERNAL"
  rootCause: string; // legacy single rootCauseCategory or "" (back-compat)
  categoryCodes: string[]; // all category codes on the case (multi)
  categoriesText: string; // joined human labels (sort / filter / CSV / search)
  department: string; // responsible dept name or "" (— )
  stageLabel: string; // Case Pipeline stage label (the owner's "status")
  stageIndex: number; // 0..7 — sort key so Stage sorts in pipeline order
  affectedCount: number;
  daysOpen: number | null; // null = CANCELLED (no meaningful age)
  stageDays: number; // whole days in the CURRENT stage (frozen at close)
  ordersCount: number;
};

// Display labels shared by the cell render, the column's value-filter
// dropdown (filterAccessor) and the CSV export — one formula each so the
// filter list always reads exactly like the grid.
function daysOpenLabel(row: CaseRow): string {
  if (row.status === "CANCELLED" || row.daysOpen == null) return "—";
  if (row.status !== "CLOSED" && row.daysOpen < 1) return "today";
  return `${row.daysOpen}d`;
}

// "Status Days" label — days in the current pipeline stage. Cancelled cases
// have no meaningful stage age. Shared by the cell render, the column value
// filter, and the CSV export.
function stageDaysLabel(row: CaseRow): string {
  if (row.status === "CANCELLED") return "—";
  return `${row.stageDays}d`;
}

function ordersLabel(row: CaseRow): string {
  // Owner 2026-06-16: show WHICH service order(s) the case spawned (their
  // SV numbers), not just the count — so you can see it at a glance.
  const nos = (row.orders ?? []).map((o) => o.serviceOrderNo).filter(Boolean);
  if (nos.length === 0) return "none";
  return nos.join(", ");
}

export default function ServiceCasesListPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { data: resp, loading, refresh } = useCachedJson<{ data?: ServiceCaseListItem[] }>(
    "/api/service-cases",
  );
  const cases = useMemo(() => resp?.data ?? [], [resp]);

  // Two bulk lists (cached, one fetch each — already used across the app)
  // feed the Case Pipeline derivation for EVERY row; never fetched per-row.
  // The Stage / Status Days columns need delivery + production dates matched
  // by salesOrderId against each case's SV order ids.
  const { data: doResp } = useCachedJson<{ data?: DeliveryOrderApi[] }>("/api/delivery-orders");
  const { data: poResp } = useCachedJson<{ data?: ProductionOrderApi[] }>(
    "/api/production-orders?fields=minimal&include=jobCards",
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState<CaseStatus | "ALL">("ALL");
  // Rows currently visible in the grid (post search / column filters /
  // sort), mirrored back via onFilteredDataChange — Export CSV downloads
  // exactly what the operator sees. Same pattern as the Employees print
  // flow's onFilteredDataChange={setPrintRows}.
  const [exportRows, setExportRows] = useState<CaseRow[]>([]);

  // Status chips pre-filter the rows fed to the grid; the grid's own
  // search / per-column filters then narrow further.
  const filtered = useMemo(
    () => (statusFilter === "ALL" ? cases : cases.filter((c) => c.status === statusFilter)),
    [cases, statusFilter],
  );

  // Index DOs / POs by salesOrderId once, so each row is an O(1) lookup
  // rather than scanning the full lists per case.
  const dosBySo = useMemo(() => {
    const m = new Map<string, DeliveryOrderApi[]>();
    for (const d of doResp?.data ?? []) {
      const so = d.salesOrderId;
      if (!so) continue;
      const arr = m.get(so);
      if (arr) arr.push(d);
      else m.set(so, [d]);
    }
    return m;
  }, [doResp]);
  const posBySo = useMemo(() => {
    const m = new Map<string, ProductionOrderApi[]>();
    for (const p of poResp?.data ?? []) {
      const so = p.salesOrderId;
      if (!so) continue;
      const arr = m.get(so);
      if (arr) arr.push(p);
      else m.set(so, [p]);
    }
    return m;
  }, [poResp]);

  // One clock captured once at mount (a state initializer is allowed to call
  // Date.now — calling it during render is not). Every row's Days Open /
  // Status Days computes against this same instant.
  const [nowMs] = useState(() => Date.now());

  const rows = useMemo<CaseRow[]>(() => {
    return filtered.map((c) => {
      const svOrderIds = c.orders.filter((o) => o.isSv).map((o) => o.id);
      const caseDos = svOrderIds.flatMap((so) => dosBySo.get(so) ?? []);
      const casePos = svOrderIds.flatMap((so) => posBySo.get(so) ?? []);
      const pipe = computeCasePipeline({
        caseStatus: c.status,
        createdAt: c.createdAt,
        investigatingAt: c.investigatingAt ?? null,
        closedAt: c.closedAt || null,
        orders: c.orders.map((o) => ({
          isSv: o.isSv,
          status: o.status,
          createdAt: o.createdAt,
        })),
        dos: caseDos,
        pos: casePos,
        svOrderIds,
      });
      // closedAt freezes both durations for closed / cancelled cases.
      const frozenClose =
        c.status === "CLOSED" || c.status === "CANCELLED" ? c.closedAt || null : null;
      const categoryCodes = categoryCodesForCase(c);
      return {
        ...c,
        // sourceNo already carries its own prefix (SO-…, CO-…), so show it
        // alone for SO/CO; EXTERNAL has no number → show the type word.
        source: c.sourceNo || (c.sourceType === "EXTERNAL" ? "EXTERNAL" : c.sourceType),
        rootCause: c.rootCauseCategory ?? "",
        categoryCodes,
        categoriesText: categoriesLabel(categoryCodes),
        department: deptForCase(c.rootCauseDetails),
        // A cancelled case must READ as cancelled. The stage is derived from
        // the case's service orders, so one whose SV order had already been
        // delivered kept showing "Delivered" and the cancel was invisible
        // outside the detail page (owner 2026-08-04).
        stageLabel: pipe.cancelled ? "Cancelled" : pipe.label,
        stageIndex: pipe.index,
        affectedCount: c.affectedProducts?.length ?? 0,
        daysOpen:
          c.status === "CANCELLED" ? null : caseDaysOpen(c.createdAt, frozenClose, nowMs),
        stageDays: caseStageDays(pipe.enteredAt, frozenClose, nowMs),
        ordersCount: c.orders.length,
      };
    });
  }, [filtered, dosBySo, posBySo, nowMs]);

  const columns = useMemo<Column<CaseRow>[]>(
    () => [
      {
        key: "caseNo",
        label: "Case No",
        width: "120px",
        sortable: true,
        // Real link (open-in-new-tab works) on top of the row-click
        // navigation. Normal font — doc numbers in DataGrid cells follow
        // the delivery grids, which don't use mono.
        render: (_value, row) => (
          <Link
            to={`/service-cases/${row.id}`}
            onClick={(e) => e.stopPropagation()}
            className="font-medium text-[#6B5C32] hover:underline"
          >
            {row.caseNo}
          </Link>
        ),
      },
      { key: "customerName", label: "Customer", width: "170px", sortable: true },
      {
        key: "source",
        label: "Source",
        width: "150px",
        sortable: true,
        render: (value) => (
          <span className="text-[#6B7280]">{String(value ?? "")}</span>
        ),
      },
      {
        // Root Cause category, relabelled "Category" (owner: the category is
        // the root cause). A case can now have several (migration 0169) —
        // show the first 2 as badges + "+N" for the rest. Sort / value-filter
        // / global-search all key off the joined human label (categoriesText)
        // so the dropdown reads like the grid.
        key: "categoriesText",
        label: "Category",
        width: "170px",
        sortable: true,
        filterAccessor: (row) => row.categoriesText || "—",
        render: (_value, row) => {
          const codes = row.categoryCodes;
          if (codes.length === 0) return <span className="text-[#9CA3AF]">—</span>;
          const shown = codes.slice(0, 2);
          const extra = codes.length - shown.length;
          return (
            <div className="flex flex-wrap items-center gap-1">
              {shown.map((code) => (
                <span
                  key={code}
                  className={`text-[10px] uppercase px-2 py-0.5 rounded ${ROOT_CAUSE_COLOR[code] ?? "bg-[#F0ECE9] text-[#5A5550]"}`}
                  title={ROOT_CAUSE_LABELS[code] ?? code}
                >
                  {code}
                </span>
              ))}
              {extra > 0 ? (
                <span
                  className="text-[10px] text-[#6B7280]"
                  title={categoriesLabel(codes)}
                >
                  +{extra}
                </span>
              ) : null}
            </div>
          );
        },
      },
      {
        // Responsible department — parsed from the per-category RCA detail
        // JSON (deptForCase). Many categories have no department → "—".
        key: "department",
        label: "Department",
        width: "140px",
        sortable: true,
        filterAccessor: (row) => row.department || "—",
        render: (value) =>
          value ? (
            <span className="text-[#6B7280]">{String(value)}</span>
          ) : (
            <span className="text-[#9CA3AF]">—</span>
          ),
      },
      {
        // Case Pipeline stage = the owner's real "status". Sorts in pipeline
        // order via sortAccessor=stageIndex (not alphabetical); the value
        // filter still lists the human labels (filterAccessor).
        key: "stageLabel",
        label: "Stage",
        width: "150px",
        sortable: true,
        sortAccessor: (row) => row.stageIndex,
        filterAccessor: (row) => row.stageLabel,
        render: (_value, row) => (
          <span
            className={`text-[10px] px-2 py-0.5 rounded ${STAGE_COLOR[row.stageLabel] ?? "bg-[#F0ECE9] text-[#5A5550]"}`}
          >
            {row.stageLabel}
          </span>
        ),
      },
      {
        key: "daysOpen",
        label: "Days Open",
        width: "95px",
        sortable: true,
        filterAccessor: (row) => daysOpenLabel(row),
        // Keep the legacy colour semantics: closed = muted with final age,
        // cancelled = no age, open ≥ 7 days = red flag.
        render: (_value, row) => {
          if (row.status === "CANCELLED" || row.daysOpen == null) {
            return <span className="text-[#9CA3AF]">—</span>;
          }
          if (row.status === "CLOSED") {
            return <span className="text-[#9CA3AF]">{row.daysOpen}d</span>;
          }
          if (row.daysOpen < 1) return <span className="text-[#6B7280]">today</span>;
          const color = row.daysOpen >= 7 ? "text-[#9A3A2D]" : "text-[#6B7280]";
          return <span className={color}>{row.daysOpen}d</span>;
        },
      },
      {
        // Days the case has spent in its CURRENT pipeline stage (frozen at
        // close for closed / cancelled cases). Sorts numerically on stageDays.
        key: "stageDays",
        label: "Status Days",
        width: "100px",
        sortable: true,
        filterAccessor: (row) => stageDaysLabel(row),
        render: (_value, row) => {
          // No meaningful "current stage age" for a cancelled case.
          if (row.status === "CANCELLED") {
            return <span className="text-[#9CA3AF]">—</span>;
          }
          if (row.status === "CLOSED") {
            return <span className="text-[#9CA3AF]">{row.stageDays}d</span>;
          }
          // Stuck-in-stage flag mirrors Days Open: ≥ 7 days = red.
          const color = row.stageDays >= 7 ? "text-[#9A3A2D]" : "text-[#6B7280]";
          return <span className={color}>{row.stageDays}d</span>;
        },
      },
      {
        key: "ordersCount",
        label: "Orders",
        width: "150px",
        sortable: true,
        filterAccessor: (row) => ordersLabel(row),
        render: (_value, row) =>
          row.ordersCount > 0 ? (
            <span className="text-[#6B5C32] whitespace-normal break-words">
              {ordersLabel(row)}
            </span>
          ) : (
            <span className="text-[#9CA3AF]">none</span>
          ),
      },
      { key: "createdAt", label: "Created", type: "date", width: "100px", sortable: true },
    ],
    [],
  );

  // Downloads the rows the grid currently shows (chips + search + column
  // filters + sort all applied) with plain text values for every column.
  function handleExportCsv() {
    exportToCsv<CaseRow>({
      filename: `service-cases-${new Date().toISOString().slice(0, 10)}`,
      // Mirrors the grid columns one-for-one so the download reads like the
      // screen. Plain values: Stage label, Department string, Days Open /
      // Status Days as numbers the spreadsheet can sort / average.
      columns: [
        { header: "Case No", accessor: (r) => r.caseNo },
        { header: "Customer", accessor: (r) => r.customerName },
        { header: "Source", accessor: (r) => r.source },
        // Joined human labels for all the case's categories (multi).
        { header: "Category", accessor: (r) => r.categoriesText },
        { header: "Department", accessor: (r) => r.department },
        { header: "Stage", accessor: (r) => r.stageLabel },
        // Numeric so the spreadsheet can sort / average; blank = cancelled.
        { header: "Days Open", accessor: (r) => r.daysOpen ?? "" },
        // Numeric days-in-current-stage; blank = cancelled (no stage age).
        { header: "Status Days", accessor: (r) => (r.status === "CANCELLED" ? "" : r.stageDays) },
        { header: "Orders", accessor: (r) => ordersLabel(r) },
        { header: "Created", accessor: (r) => formatDateDMY(r.createdAt) },
      ],
      rows: exportRows,
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Service Cases</h1>
          <p className="text-xs text-[#6B7280] mt-1">
            All customer-facing service interactions. Each case can spawn 0+ Service Orders
            (REPRODUCE / STOCK_SWAP / REPAIR) for actual rework, or stay record-only for
            log-only complaints / on-site fixes.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            disabled={exportRows.length === 0}
            title="Download the rows currently shown in the grid as a CSV file"
          >
            <Download className="h-4 w-4" /> Export CSV
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setCreateOpen(true)}
            className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
          >
            <Plus className="h-4 w-4" /> New Service Case
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        {(["ALL", "OPEN", "IN_PROGRESS", "CLOSED", "CANCELLED"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            className={`px-2 py-1 rounded border ${
              statusFilter === s
                ? "border-[#6B5C32] bg-[#F4EFE3] text-[#6B5C32]"
                : "border-[#E2DDD8] hover:bg-[#FAF9F7]"
            }`}
          >
            {s} {s !== "ALL" ? `(${cases.filter((c) => c.status === s).length})` : `(${cases.length})`}
          </button>
        ))}
      </div>

      {/* Standard DataGrid (same component as Delivery / Sales / Employees)
          — brings sort, per-column filters, Columns show/hide, drag-resize
          and the shared look. valueFilterKey scopes the grid's sticky
          column-filter session per status chip so switching chips never
          inherits a stale filter that blanks the grid. */}
      <Card>
        <CardContent>
          <DataGrid<CaseRow>
            columns={columns}
            data={rows}
            keyField="id"
            gridId="service-cases"
            loading={loading}
            stickyHeader
            virtualize
            maxHeight="calc(100vh - 320px)"
            emptyMessage={
              cases.length === 0
                ? "No service cases yet — click 'New Service Case' to log the first one."
                : "No cases in this status."
            }
            valueFilterKey={statusFilter}
            onRowClick={(row) => navigate(`/service-cases/${row.id}`)}
            onFilteredDataChange={setExportRows}
          />
        </CardContent>
      </Card>

      {createOpen && (
        <CreateServiceCaseModal
          onClose={() => setCreateOpen(false)}
          onCreated={(newId) => {
            setCreateOpen(false);
            invalidateCachePrefix("/api/service-cases");
            refresh();
            toast.success("Service case opened");
            navigate(`/service-cases/${newId}`);
          }}
        />
      )}
    </div>
  );
}

// ===========================================================================
// CreateServiceCaseModal — minimal form to log a new case.
// ===========================================================================
type SalesOrderApi = {
  id: string;
  customerName: string;
  status: string;
  companySOId?: string;
  customerPO?: string;
  customerPOId?: string;
  customerSO?: string;
  customerSOId?: string;
  reference?: string;
};
type ConsignmentOrderApi = {
  id: string;
  customerName: string;
  status: string;
  companyCOId?: string;
  customerCO?: string;
  customerCOId?: string;
  reference?: string;
};

// Source-order line item shape returned by GET /api/sales-orders/:id and
// /api/consignment-orders/:id. Used for the "Which product?" picker that
// follows source-order selection on SO/CO cases (2026-04-29). The variant
// fields (size / fabric / gap / divan / leg) feed the damaged-parts lookup
// (GET /api/sales-orders/repair-components) added 2026-06-12.
type SourceOrderItemApi = {
  id: string;
  productId?: string | null;
  productCode?: string | null;
  productName?: string | null;
  quantity?: number | null;
  sizeLabel?: string | null;
  sizeCode?: string | null;
  fabricCode?: string | null;
  gapInches?: number | null;
  divanHeightInches?: number | null;
  legHeightInches?: number | null;
};

// One pickable damaged part — a top-level BOM WIP piece as served by
// GET /api/sales-orders/repair-components (the canonical BOM → WIP
// breakdown; same options the service-order Repair Scope picker shows).
type RepairComponentOption = {
  key: string;
  label: string;
  type: string;
  qty: number;
};
// One pick stored on an affectedProducts entry.
type AffectedComponentPick = { key: string; label: string; qty: number };
type SourceOrderDetailApi = {
  data?: {
    id: string;
    items?: SourceOrderItemApi[];
  };
};

export function CreateServiceCaseModal({
  onClose,
  onCreated,
  presetSourceType,
  presetSourceId,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
  presetSourceType?: "SO" | "CO";
  presetSourceId?: string;
}) {
  const { toast } = useToast();
  const user = getCurrentUser();

  const [sourceType, setSourceType] = useState<"SO" | "CO" | "EXTERNAL">(
    presetSourceType ?? "SO",
  );
  const [sourceId, setSourceId] = useState<string>(presetSourceId ?? "");
  const [sourceQuery, setSourceQuery] = useState("");
  // EXTERNAL-source customer picker — search the customer master and
  // attach { id, code, name } so the case is properly linked (not just a
  // free-text name like before). 2026-04-29 operator request.
  const [externalCustomerId, setExternalCustomerId] = useState<string>("");
  const [externalCustomerName, setExternalCustomerName] = useState("");
  const [externalCustomerCode, setExternalCustomerCode] = useState("");
  const [externalCustomerSearch, setExternalCustomerSearch] = useState("");
  const [externalRef, setExternalRef] = useState("");
  const [issueDescription, setIssueDescription] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  // Per-batch upload progress for the off-main-thread compressor — null when idle.
  const [photoUploadProgress, setPhotoUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [rootCauseCategory, setRootCauseCategory] = useState<string>("");
  // rootCauseNotes removed from create form 2026-04-28 (5W moved to Issue
  // Description). Backend field still exists for backward compat.
  const rootCauseNotes = "";
  const [submitting, setSubmitting] = useState(false);
  // Inline form-level error from the API or client-side validation.
  // Replaces the silent "button does nothing" failure mode reported by
  // operators on 2026-04-29 (Bug #13).
  const [formError, setFormError] = useState<string | null>(null);
  // Affected products picked from the source order (for SO/CO sources).
  // Stored as an array of { productId, code, name, qty?, components? } —
  // matches the backend's affected_product_ids JSON shape (migration 0077).
  // components = optional damaged-part picks (absent = all parts).
  const [affectedProducts, setAffectedProducts] = useState<Array<{
    productId: string;
    code: string;
    name: string;
    qty?: number | null;
    components?: AffectedComponentPick[];
  }>>([]);

  const { data: soResp, loading: soLoading } = useCachedJson<{ data?: SalesOrderApi[] }>("/api/sales-orders");
  const { data: coResp, loading: coLoading } = useCachedJson<{ data?: ConsignmentOrderApi[] }>("/api/consignment-orders");
  const { data: customersResp } = useCachedJson<{
    data?: Array<{ id: string; code: string; name: string; phone?: string | null }>;
  }>(sourceType === "EXTERNAL" ? "/api/customers" : null);

  // Once a SO/CO is selected, load its line items so the operator can
  // pick which product the issue is about (Bug #11). EXTERNAL cases don't
  // have a source order to pick from — affected products there are
  // recorded from the case detail page after creation.
  const sourceDetailUrl =
    sourceType === "EXTERNAL" || !sourceId
      ? null
      : sourceType === "SO"
        ? `/api/sales-orders/${sourceId}`
        : `/api/consignment-orders/${sourceId}`;
  const { data: sourceDetail, loading: sourceItemsLoading } = useCachedJson<SourceOrderDetailApi>(sourceDetailUrl);
  const sourceItems: SourceOrderItemApi[] = useMemo(() => {
    const raw = sourceDetail?.data?.items ?? [];
    // De-dup by product so the SAME product on two order lines shows as ONE
    // pickable card. Affected products are tracked per-product, so two cards
    // shared one selection and ticked together (Wei Siang 2026-06-15: "一点上面
    // 下面也跟着 tick"). Sum the quantities so the card reflects the total
    // ordered. Items without a productId stay separate (keyed by line id).
    const byProduct = new Map<string, SourceOrderItemApi>();
    for (const it of raw) {
      const key = it.productId || it.id;
      const existing = byProduct.get(key);
      if (existing) {
        existing.quantity = (existing.quantity ?? 0) + (it.quantity ?? 0);
      } else {
        byProduct.set(key, { ...it });
      }
    }
    return [...byProduct.values()];
  }, [sourceDetail]);

  // Search-then-pick — empty query shows nothing (avoids dropdown of all
  // customers). Filtered by code OR name. Results capped at 10.
  const customerMatches = useMemo(() => {
    if (sourceType !== "EXTERNAL") return [];
    const q = externalCustomerSearch.trim().toLowerCase();
    if (!q) return [];
    return (customersResp?.data ?? [])
      .filter(
        (c) =>
          c.code.toLowerCase().includes(q) ||
          c.name.toLowerCase().includes(q),
      )
      .slice(0, 10);
  }, [sourceType, externalCustomerSearch, customersResp]);

  const sourceOptions: SourceOrderOption[] = useMemo(() => {
    if (sourceType === "SO") {
      return (soResp?.data ?? [])
        .filter((s) => !EXCLUDED_SOURCE_STATUSES.has(s.status))
        .map((s) => ({
          id: s.id,
          customerName: s.customerName,
          status: s.status,
          companyOrderId: s.companySOId ?? "",
          // The create form writes the *Id variants; OCR fills the plain
          // ones — surface whichever is set so either entry path matches.
          customerPO: s.customerPOId || s.customerPO || "",
          customerSO: s.customerSOId || s.customerSO || "",
          reference: s.reference ?? "",
        }));
    }
    if (sourceType === "CO") {
      return (coResp?.data ?? [])
        .filter((s) => !EXCLUDED_SOURCE_STATUSES.has(s.status))
        .map((s) => ({
          id: s.id,
          customerName: s.customerName,
          status: s.status,
          companyOrderId: s.companyCOId ?? "",
          // COs carry the customer's CO number in the PO slot (their
          // document number); there's no customer-SO concept on COs.
          customerPO: s.customerCOId || s.customerCO || "",
          customerSO: "",
          reference: s.reference ?? "",
        }));
    }
    return [];
  }, [sourceType, soResp, coResp]);

  const selectedSource = sourceOptions.find((s) => s.id === sourceId);

  function toggleAffectedProduct(item: SourceOrderItemApi) {
    const productId = item.productId ?? "";
    if (!productId) return;
    setAffectedProducts((prev) => {
      // Unchecking removes the whole entry — its component picks go with it.
      const has = prev.some((p) => p.productId === productId);
      if (has) return prev.filter((p) => p.productId !== productId);
      return [
        ...prev,
        {
          productId,
          code: item.productCode ?? "",
          name: item.productName ?? "",
          qty: item.quantity ?? null,
        },
      ];
    });
  }

  // Damaged-part picks for one checked product. Empty list = field removed
  // (absent components = all parts, the canonical "everything" form).
  function setAffectedComponents(productId: string, components: AffectedComponentPick[]) {
    setAffectedProducts((prev) =>
      prev.map((p) =>
        p.productId === productId
          ? { ...p, components: components.length > 0 ? components : undefined }
          : p,
      ),
    );
  }

  // ---- Photo helpers (resize → base64) ----
  // Uses the shared @/lib/image-compress helper which prefers
  // createImageBitmap + OffscreenCanvas (off-main-thread) on modern browsers
  // and falls back to FileReader/canvas on older Safari / WebView.
  async function handleAddPhotos(files: FileList | null) {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    setPhotoUploadProgress({ done: 0, total: list.length });
    const results: string[] = [];
    try {
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        try {
          results.push(await compressImage(f, { maxDim: 1280, quality: 0.85 }));
        } catch {
          toast.error(`Couldn't read ${f.name}`);
        }
        setPhotoUploadProgress({ done: i + 1, total: list.length });
      }
      if (results.length > 0) {
        setPhotos((prev) => [...prev, ...results]);
      }
    } finally {
      setPhotoUploadProgress(null);
    }
  }

  async function handleSubmit() {
    // Inline validation — instead of silently disabling the button (Bug #13),
    // surface a clear inline message so the operator knows WHY they can't
    // submit yet. The button's disabled state still prevents submission;
    // we just no-op here when the form isn't ready.
    setFormError(null);
    if (sourceType === "EXTERNAL") {
      if (!externalCustomerId || !externalCustomerName.trim()) {
        setFormError("Pick a customer from the master list before opening the case.");
        return;
      }
    } else {
      if (!sourceId) {
        setFormError(
          `Pick a ${sourceType === "SO" ? "Sales Order" : "Consignment Order"} from the search results before opening the case.`,
        );
        return;
      }
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/service-cases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceType,
          sourceId: sourceType === "EXTERNAL" ? null : sourceId,
          // For EXTERNAL we now require a real customer from /api/customers
          // — backend gets both customerId and customerName (the
          // snapshot name on the case row). 2026-04-29.
          customerId: sourceType === "EXTERNAL" ? externalCustomerId : undefined,
          customerName: sourceType === "EXTERNAL" ? externalCustomerName : undefined,
          externalRef: sourceType === "EXTERNAL" ? externalRef || null : undefined,
          issueDescription: issueDescription || null,
          issuePhotos: photos,
          // Affected products picked from the source order's line items
          // (SO/CO sources only). Optional — empty array is fine if the
          // operator doesn't know the specific product yet; they can attach
          // products from the case detail page after creation.
          affectedProducts: affectedProducts.length > 0 ? affectedProducts : undefined,
          rootCauseCategory: rootCauseCategory || null,
          rootCauseNotes: rootCauseNotes || null,
          createdBy: user?.id ?? null,
          createdByName: user?.displayName ?? user?.email ?? null,
        }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string; data?: { id: string } };
      if (!res.ok || !data?.success) throw new Error(data?.error || `HTTP ${res.status}`);
      onCreated(data.data!.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to create";
      setFormError(msg);
      toast.error(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-lg shadow-xl border border-[#E2DDD8] w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-[#E2DDD8]">
          <h3 className="text-lg font-semibold text-[#1F1D1B]">New Service Case</h3>
          <button onClick={onClose} className="text-[#9CA3AF] hover:text-[#374151]">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {/* Source picker */}
          <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
            <div>
              <label className="block text-xs text-[#6B7280] mb-1">Source Order Type</label>
              <select
                value={sourceType}
                onChange={(e) => {
                  setSourceType(e.target.value as "SO" | "CO" | "EXTERNAL");
                  setSourceId("");
                  setSourceQuery("");
                  setAffectedProducts([]);
                  setFormError(null);
                }}
                disabled={!!presetSourceType}
                className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm"
              >
                <option value="SO">Sales Order</option>
                <option value="CO">Consignment Order</option>
                <option value="EXTERNAL">External / Old order (no record in system)</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-[#6B7280] mb-1">
                Source Order {selectedSource ? "" : "(search by SO# / customer)"}
              </label>
              {selectedSource ? (
                <div className="flex items-center justify-between rounded border border-[#E2DDD8] bg-[#FAF9F7] px-2 py-1.5 text-sm">
                  <div className="truncate">
                    <span className="font-medium">{selectedSource.companyOrderId}</span>{" "}
                    <span className="text-[#6B7280]">— {selectedSource.customerName}</span>{" "}
                    <span className="text-[10px] text-[#9CA3AF]">({selectedSource.status})</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      if (presetSourceId) return;
                      setSourceId("");
                      setSourceQuery("");
                      setAffectedProducts([]);
                      setFormError(null);
                    }}
                    disabled={!!presetSourceId}
                    className="ml-2 text-xs text-[#6B5C32] hover:underline disabled:text-[#9CA3AF]"
                  >
                    Change
                  </button>
                </div>
              ) : sourceType === "EXTERNAL" ? (
                <div className="space-y-1">
                  {/* Customer picker — search by code or name from the
                      customer master. Once picked, shows as a chip with a
                      Change button to clear the selection. */}
                  {externalCustomerId ? (
                    <div className="flex items-center justify-between rounded border border-[#E2DDD8] bg-[#FAF9F7] px-2 py-1.5 text-sm">
                      <div className="truncate">
                        <span className="font-medium">{externalCustomerCode}</span>
                        <span className="text-[#9CA3AF]"> — </span>
                        <span>{externalCustomerName}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setExternalCustomerId("");
                          setExternalCustomerName("");
                          setExternalCustomerCode("");
                          setExternalCustomerSearch("");
                        }}
                        className="ml-2 text-xs text-[#6B5C32] hover:underline"
                      >
                        Change
                      </button>
                    </div>
                  ) : (
                    <div className="relative">
                      <Input
                        type="text"
                        value={externalCustomerSearch}
                        onChange={(e) => setExternalCustomerSearch(e.target.value)}
                        placeholder="Search customer by code or name (required)"
                        className="h-8 text-sm"
                      />
                      {customerMatches.length > 0 && (
                        <div className="absolute z-10 mt-1 w-full rounded border border-[#E2DDD8] bg-white shadow-sm max-h-48 overflow-auto">
                          {customerMatches.map((c) => (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => {
                                setExternalCustomerId(c.id);
                                setExternalCustomerName(c.name);
                                setExternalCustomerCode(c.code);
                                setExternalCustomerSearch("");
                                setFormError(null);
                              }}
                              className="w-full text-left px-2 py-1.5 text-xs hover:bg-[#FAF7F0]"
                            >
                              <span className="text-[#6B5C32]">{c.code}</span>
                              <span className="text-[#9CA3AF]"> — </span>
                              <span>{c.name}</span>
                              {c.phone ? (
                                <span className="text-[#9CA3AF]"> ({c.phone})</span>
                              ) : null}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <Input
                    type="text"
                    value={externalRef}
                    onChange={(e) => setExternalRef(e.target.value)}
                    placeholder="External reference (paper SO#, etc. — optional)"
                    className="h-8 text-sm"
                  />
                </div>
              ) : (
                <SourceSearchPicker
                  query={sourceQuery}
                  onQueryChange={setSourceQuery}
                  options={sourceOptions}
                  onPick={(id) => {
                    setSourceId(id);
                    setAffectedProducts([]);
                    setFormError(null);
                  }}
                  loading={sourceType === "SO" ? soLoading : coLoading}
                />
              )}
            </div>
          </div>

          {/* Affected products — appears once a SO/CO is selected. Optional;
              the operator can leave it blank if they're not sure which
              product yet (they can attach products from the case detail
              page after the case is opened). One row per line item; click
              to toggle. EXTERNAL cases skip this — there's no source order
              to derive products from. (Bug #11 — 2026-04-29) */}
          {sourceType !== "EXTERNAL" && selectedSource ? (
            <div>
              <label className="block text-xs text-[#6B7280] mb-1">
                Which product has the issue?{" "}
                <span className="text-[#9CA3AF]">(optional — pick one or more lines from this order)</span>
              </label>
              {sourceItemsLoading ? (
                <div className="flex items-center gap-2 text-xs text-[#6B7280] py-2">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading order line items…
                </div>
              ) : sourceItems.length === 0 ? (
                <div className="text-xs text-[#9CA3AF] py-2">
                  This order has no line items recorded.
                </div>
              ) : (
                <div className="space-y-1 rounded border border-[#E2DDD8] bg-white max-h-72 overflow-auto">
                  {sourceItems.map((it) => {
                    const productId = it.productId ?? "";
                    const entry = productId
                      ? affectedProducts.find((p) => p.productId === productId)
                      : undefined;
                    const picked = !!entry;
                    return (
                      <div key={it.id} className="border-b border-[#F0ECE9] last:border-b-0">
                        <button
                          type="button"
                          onClick={() => toggleAffectedProduct(it)}
                          disabled={!productId}
                          className={`w-full text-left px-2 py-1.5 text-xs flex items-center gap-2 ${
                            picked ? "bg-[#F4EFE3]" : "hover:bg-[#FAF9F7]"
                          } ${!productId ? "opacity-50 cursor-not-allowed" : ""}`}
                        >
                          <span
                            className={`inline-block w-3.5 h-3.5 rounded-sm border ${
                              picked ? "bg-[#6B5C32] border-[#6B5C32]" : "border-[#9CA3AF]"
                            } flex items-center justify-center text-white text-[10px]`}
                          >
                            {picked ? "✓" : ""}
                          </span>
                          <span className="text-[#6B5C32]">{it.productCode || "—"}</span>
                          <span className="text-[#9CA3AF]"> — </span>
                          <span className="truncate">{it.productName || "(unnamed)"}</span>
                          {it.sizeLabel ? (
                            <span className="text-[#9CA3AF]"> · {it.sizeLabel}</span>
                          ) : null}
                          <span className="ml-auto text-[#6B7280]">qty {it.quantity ?? 0}</span>
                        </button>
                        {/* Damaged-parts narrowing for the checked product —
                            renders only when the BOM has pickable top-level
                            pieces (legacy/flat BOM = no component layer). */}
                        {picked && (
                          <DamagedPartsPicker
                            item={it}
                            picks={entry?.components ?? []}
                            onChange={(next) => setAffectedComponents(productId, next)}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {affectedProducts.length > 0 && (
                <div className="mt-1 text-[10px] text-[#6B5C32]">
                  {affectedProducts.length} product{affectedProducts.length === 1 ? "" : "s"} selected
                </div>
              )}
            </div>
          ) : null}

          {/* Issue — captures both customer report AND root-cause analysis.
              Operators consolidated these in 2026-04-28 per "issue description
              and why did this happen are double". One textarea, 5W template. */}
          <div>
            <label className="block text-xs text-[#6B7280] mb-1">
              Issue Description{" "}
              <span className="text-[#9CA3AF]">(use the 5W template — what happened, when, who, where, result)</span>
            </label>
            <textarea
              rows={6}
              value={issueDescription}
              onChange={(e) => setIssueDescription(e.target.value)}
              placeholder={[
                "What happened? Use the 5W template:",
                "  When  — date / time of incident (e.g. 2026-04-29 10:30)",
                "  Who   — name (e.g. 3PL driver Ahmad / sales agent Wong)",
                "  Where — location (e.g. customer's living room, KL)",
                "  What  — what they did (e.g. dropped the sofa during unloading)",
                "  Result — what problem was caused (e.g. frame cracked at left armrest)",
              ].join("\n")}
              className="w-full rounded border border-[#E2DDD8] bg-white px-2 py-1.5 text-sm"
            />
          </div>

          {/* Photos */}
          <div>
            <label className="block text-xs text-[#6B7280] mb-1">Photos ({photos.length})</label>
            {/* Native <input type="file"> renders as a tiny gray "Choose
                Files" link that operators kept missing. Wrap it in a label
                styled like a regular button so it's an obvious target. */}
            <label
              className={
                photoUploadProgress
                  ? "inline-flex items-center gap-2 rounded border border-[#E2DDD8] bg-white px-3 py-1.5 text-xs text-[#9CA3AF] cursor-not-allowed"
                  : "inline-flex items-center gap-2 cursor-pointer rounded border border-[#E2DDD8] bg-white hover:bg-[#FAF9F7] px-3 py-1.5 text-xs"
              }
            >
              <Plus className="h-3.5 w-3.5" />
              {photos.length === 0 ? "Add photos" : "Add more photos"}
              <input
                type="file"
                accept="image/*"
                multiple
                disabled={!!photoUploadProgress}
                onChange={(e) => {
                  handleAddPhotos(e.target.files);
                  // Reset value so re-selecting the same file fires onChange.
                  e.target.value = "";
                }}
                className="hidden"
              />
            </label>
            {photoUploadProgress && (
              <span className="ml-2 inline-flex items-center gap-1 text-xs text-[#6B7280]">
                <Loader2 className="h-3 w-3 animate-spin" />
                Compressing {Math.min(photoUploadProgress.done + 1, photoUploadProgress.total)} / {photoUploadProgress.total}...
              </span>
            )}
            {photos.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {photos.map((src, i) => (
                  <div key={i} className="relative">
                    <img
                      src={src}
                      alt={`photo ${i + 1}`}
                      className="h-20 w-20 rounded border border-[#E2DDD8] object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => setPhotos((p) => p.filter((_, idx) => idx !== i))}
                      className="absolute -top-1 -right-1 rounded-full bg-white border border-[#E2DDD8] p-0.5 text-[#9A3A2D] hover:text-[#7A2E24]"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Optional RCA */}
          <div>
            <label className="block text-xs text-[#6B7280] mb-1">
              Root Cause <span className="text-[#9CA3AF]">(optional — fill later if you're still gathering info)</span>
            </label>
            <select
              value={rootCauseCategory}
              onChange={(e) => setRootCauseCategory(e.target.value)}
              className="h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-sm"
            >
              <option value="">Category — not yet assigned</option>
              <option value="PRODUCTION">Production / workmanship</option>
              <option value="DESIGN">Design / R&amp;D</option>
              <option value="MATERIAL">Material / supplier</option>
              <option value="PROCESS">Process / SOP gap</option>
              <option value="CUSTOMER">Customer (not our fault)</option>
              <option value="TRANSPORT">Transport / 3PL</option>
              <option value="OTHER">Other</option>
            </select>
            {/* rootCauseNotes textarea removed 2026-04-28 — operators flagged
                it was a duplicate of Issue Description. The 5W story lives in
                the Issue Description field above. The category dropdown
                tags it for reporting. */}
          </div>

          <div className="flex items-start gap-2 text-xs text-[#3A5670] bg-[#E0EAF4] border border-[#C9D6E4] rounded p-2">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <p>
              Opening a case logs the customer issue. If it needs rework / swap / repair, spawn
              a Service Order from the case detail page after this. Cases close on their own
              timeline — you don't need a Service Order for every case.
            </p>
          </div>
        </div>

        {/* Inline form error — surfaced from client-side validation OR a
            failed POST. Replaces the silent "button does nothing" failure
            mode reported on 2026-04-29 (Bug #13). The toast still fires for
            API failures so the message is visible even after the modal
            scrolls. */}
        {formError ? (
          <div className="px-4 pb-2">
            <div className="flex items-start gap-2 text-xs text-[#7A2E24] bg-[#F5DCDC] border border-[#E4C9C9] rounded p-2">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <p>{formError}</p>
            </div>
          </div>
        ) : null}

        <div className="flex justify-end gap-2 p-4 border-t border-[#E2DDD8] bg-[#FAF9F7]">
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          {/* Button is no longer disabled when sourceOk is false (Bug #13).
              Disabling it without a visible reason was the silent-failure
              footgun operators kept hitting. Click now always fires
              handleSubmit, which surfaces an inline form error explaining
              what's missing. Still disabled while a request is in flight. */}
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            disabled={submitting}
            className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
          >
            {submitting ? "Opening…" : "Open Case"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SourceSearchPicker({
  query, onQueryChange, options, onPick, loading,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  options: SourceOrderOption[];
  onPick: (id: string) => void;
  loading?: boolean;
}) {
  const q = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!q) return [];
    // Matches our order id, customer name, AND the customer-side document
    // numbers (PO / SO / reference) — customers quote their own paperwork
    // when they report an issue (2026-06-12, mirrors the Copy-from lookup).
    return options
      .filter(
        (o) =>
          o.companyOrderId.toLowerCase().includes(q) ||
          o.customerName.toLowerCase().includes(q) ||
          o.customerPO.toLowerCase().includes(q) ||
          o.customerSO.toLowerCase().includes(q) ||
          o.reference.toLowerCase().includes(q),
      )
      .slice(0, 15);
  }, [options, q]);

  // Placeholder used to read "(N shipped)" but cases can be opened against
  // any non-DRAFT/CANCELLED order, so "shipped" was misleading. Now shows
  // the real count of selectable orders, and a loading state on first
  // mount so operators don't see "(0 ...)" while the list is still
  // fetching. (Bug #11 — 2026-04-29)
  const placeholder = loading
    ? "Loading orders…"
    : `Type SO# / customer / customer PO / reference… (${options.length} available)`;

  return (
    <div className="space-y-1">
      <Input
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 text-sm"
      />
      {q && (
        <div className="max-h-48 overflow-y-auto rounded border border-[#E2DDD8] bg-white">
          {loading ? (
            <div className="p-2 text-xs text-[#9CA3AF] flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading orders…
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-2 text-xs text-[#9CA3AF]">No matches for "{q}".</div>
          ) : (
            filtered.map((s) => {
              // Second line surfaces the customer-side refs so the operator
              // can confirm the match against the paperwork they're holding.
              const refs = [
                s.customerPO ? `PO ${s.customerPO}` : "",
                s.customerSO ? `SO ${s.customerSO}` : "",
                s.reference ? `Ref ${s.reference}` : "",
              ].filter(Boolean);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onPick(s.id)}
                  className="block w-full text-left px-2 py-1.5 text-xs hover:bg-[#F4EFE3] border-b border-[#F0ECE9] last:border-b-0"
                >
                  <span className="font-medium">{s.companyOrderId}</span>
                  <span className="text-[#6B7280]"> — {s.customerName}</span>
                  <span className="ml-1 text-[10px] text-[#9CA3AF]">({s.status})</span>
                  {refs.length > 0 && (
                    <div className="text-[10px] text-[#9CA3AF]">{refs.join(" · ")}</div>
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// DamagedPartsPicker — compact component-level narrowing under a checked
// affected product (SO/CO sources only).
// ===========================================================================
// Options come from GET /api/sales-orders/repair-components — the canonical
// BOM → WIP breakdown (the same endpoint the service-order create page's
// Repair Scope picker consumes); components are NEVER re-derived client-side.
// Empty result / failed fetch → renders nothing (legacy/flat BOM = no
// component layer, identical to before the feature). No pick = all parts.
function DamagedPartsPicker({
  item,
  picks,
  onChange,
}: {
  item: SourceOrderItemApi;
  picks: AffectedComponentPick[];
  onChange: (next: AffectedComponentPick[]) => void;
}) {
  const [options, setOptions] = useState<RepairComponentOption[] | null>(null);
  const productCode = item.productCode ?? "";
  useEffect(() => {
    if (!productCode) return;
    let cancelled = false;
    const params = new URLSearchParams({ productCode });
    if (item.sizeLabel) params.set("sizeLabel", item.sizeLabel);
    if (item.sizeCode) params.set("sizeCode", item.sizeCode);
    if (item.fabricCode) params.set("fabricCode", item.fabricCode);
    if (item.gapInches != null) params.set("gapInches", String(item.gapInches));
    if (item.divanHeightInches != null) params.set("divanHeightInches", String(item.divanHeightInches));
    if (item.legHeightInches != null) params.set("legHeightInches", String(item.legHeightInches));
    fetch(`/api/sales-orders/repair-components?${params.toString()}`)
      .then((res): Promise<{ success?: boolean; data?: RepairComponentOption[] } | null> =>
        res.ok ? res.json() : Promise.resolve(null),
      )
      .then((data) => {
        if (cancelled) return;
        if (data?.success && Array.isArray(data.data)) setOptions(data.data);
      })
      .catch(() => {
        // Endpoint unreachable — keep the picker hidden (= all parts).
      });
    return () => {
      cancelled = true;
    };
  }, [
    productCode,
    item.sizeLabel,
    item.sizeCode,
    item.fabricCode,
    item.gapInches,
    item.divanHeightInches,
    item.legHeightInches,
  ]);

  if (!options || options.length === 0) return null;

  const toggle = (opt: RepairComponentOption) => {
    const has = picks.some((p) => p.key === opt.key);
    onChange(
      has
        ? picks.filter((p) => p.key !== opt.key)
        : [
            ...picks,
            // Default to 1 damaged piece, not the full BOM count (Wei Siang
            // 2026-06-15: "为什么一点就两个" — usually only one is damaged).
            // The operator bumps it up to the /N max if more are broken.
            { key: opt.key, label: opt.label, qty: 1 },
          ],
    );
  };
  const setQty = (opt: RepairComponentOption, raw: string) => {
    const maxQty = Math.max(1, Math.floor(opt.qty) || 1);
    const n = Math.floor(Number(raw));
    const qty = Number.isFinite(n) ? Math.min(Math.max(1, n), maxQty) : maxQty;
    onChange(picks.map((p) => (p.key === opt.key ? { ...p, qty } : p)));
  };

  return (
    <div className="ml-7 mr-2 mb-1.5 rounded border border-[#E8D8B2] bg-[#FAF7F0] px-2 py-1.5">
      <div className="text-[10px] text-[#6B5C32] mb-1">
        Damaged parts (optional — all if none picked)
      </div>
      <div className="space-y-1">
        {options.map((opt) => {
          const pick = picks.find((p) => p.key === opt.key);
          const maxQty = Math.max(1, Math.floor(opt.qty) || 1);
          return (
            <div key={opt.key} className="flex items-center gap-2 text-[11px]">
              <label className="flex items-center gap-1.5 flex-1 min-w-0 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!pick}
                  onChange={() => toggle(opt)}
                  className="h-3 w-3"
                />
                <span className="truncate">{opt.label}</span>
                <span className="text-[#9CA3AF]">×{maxQty}</span>
              </label>
              {pick ? (
                <Input
                  type="number"
                  min={1}
                  max={maxQty}
                  value={pick.qty}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setQty(opt, e.target.value)}
                  className="h-6 w-14 text-[11px] px-1.5"
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Re-export the link helper consumers expect.
export { Link };
