import { useState, useEffect, useMemo, useCallback, useDeferredValue } from "react";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency, formatDate } from "@/lib/utils";
import { useCachedJson } from "@/lib/cached-fetch";
import {
  Package,
  Search,
  CheckCircle2,
  PackageCheck,
  Eye,
  Printer,
  RefreshCw,
  ArrowRight,
  Download,
  RotateCcw,
  ArchiveRestore,
} from "lucide-react";
import type { ConsignmentNote } from "@/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CRStatus = "PENDING" | "INSPECTED" | "ACCEPTED" | "RESTOCKED";

type ConsignmentReturnRow = {
  id: string;
  crNo: string;
  coRef: string;
  consignmentId: string;
  customerId: string;
  customerName: string;
  branchName: string;
  items: number;
  returnValueSen: number;
  returnDate: string | null;
  status: CRStatus;
  remarks: string;
};

// ---------------------------------------------------------------------------
// Mock CR data generator — builds CRs from fetched consignment notes
// ---------------------------------------------------------------------------

let _crCounter = 0;

function buildMockCRs(notes: ConsignmentNote[]): ConsignmentReturnRow[] {
  const now = new Date();
  const rows: ConsignmentReturnRow[] = [];

  // Notes with RETURNED status
  const returnedNotes = notes.filter((n) => n.status === "RETURNED");
  for (const n of returnedNotes) {
    _crCounter++;
    const returnDate = new Date(now);
    returnDate.setDate(returnDate.getDate() - Math.floor(Math.random() * 10 + 1));
    const rand = Math.random();
    let status: CRStatus = "PENDING";
    if (rand > 0.75) status = "RESTOCKED";
    else if (rand > 0.5) status = "ACCEPTED";
    else if (rand > 0.25) status = "INSPECTED";

    rows.push({
      id: `cr-returned-${n.id}`,
      crNo: `CR-${String(_crCounter).padStart(5, "0")}`,
      coRef: n.noteNumber,
      consignmentId: n.id,
      customerId: n.customerId,
      customerName: n.customerName,
      branchName: n.branchName,
      items: n.items.filter((i) => i.status === "RETURNED").length || n.items.length,
      returnValueSen: n.items
        .filter((i) => i.status === "RETURNED")
        .reduce((sum, i) => sum + i.unitPrice * i.quantity, 0) || n.totalValue,
      returnDate: returnDate.toISOString(),
      status,
      remarks: n.notes,
    });
  }

  // Notes that have individual items with RETURNED status but note is not RETURNED
  const notesWithReturnedItems = notes.filter(
    (n) => n.status !== "RETURNED" && n.items.some((i) => i.status === "RETURNED")
  );
  for (const n of notesWithReturnedItems) {
    _crCounter++;
    const returnedItems = n.items.filter((i) => i.status === "RETURNED");
    const returnDate = returnedItems[0]?.returnedDate || now.toISOString();
    const rand = Math.random();
    let status: CRStatus = "PENDING";
    if (rand > 0.6) status = "INSPECTED";

    rows.push({
      id: `cr-partial-${n.id}`,
      crNo: `CR-${String(_crCounter).padStart(5, "0")}`,
      coRef: n.noteNumber,
      consignmentId: n.id,
      customerId: n.customerId,
      customerName: n.customerName,
      branchName: n.branchName,
      items: returnedItems.length,
      returnValueSen: returnedItems.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0),
      returnDate,
      status,
      remarks: n.notes,
    });
  }

  // Also include DAMAGED items as returns needing inspection
  const notesWithDamagedItems = notes.filter(
    (n) => n.items.some((i) => i.status === "DAMAGED")
  );
  for (const n of notesWithDamagedItems) {
    // Skip if already added from RETURNED check
    if (rows.some((r) => r.consignmentId === n.id)) continue;
    _crCounter++;
    const damagedItems = n.items.filter((i) => i.status === "DAMAGED");
    const returnDate = damagedItems[0]?.returnedDate || now.toISOString();

    rows.push({
      id: `cr-damaged-${n.id}`,
      crNo: `CR-${String(_crCounter).padStart(5, "0")}`,
      coRef: n.noteNumber,
      consignmentId: n.id,
      customerId: n.customerId,
      customerName: n.customerName,
      branchName: n.branchName,
      items: damagedItems.length,
      returnValueSen: damagedItems.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0),
      returnDate,
      status: "PENDING",
      remarks: `${n.notes} (Damaged items)`,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<CRStatus, string> = {
  PENDING: "Pending",
  INSPECTED: "Inspected",
  ACCEPTED: "Accepted",
  RESTOCKED: "Restocked",
};

const TAB_FILTERS: { key: string; label: string; statuses: CRStatus[] | null }[] = [
  { key: "all", label: "All", statuses: null },
  { key: "pending", label: "Pending", statuses: ["PENDING"] },
  { key: "inspected", label: "Inspected", statuses: ["INSPECTED"] },
  { key: "accepted", label: "Accepted", statuses: ["ACCEPTED"] },
  { key: "restocked", label: "Restocked", statuses: ["RESTOCKED"] },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ConsignmentReturnPage() {
  const { toast } = useToast();
  const [crRows, setCrRows] = useState<ConsignmentReturnRow[]>([]);
  const [activeTab, setActiveTab] = useState("all");
  const [detailCR, setDetailCR] = useState<ConsignmentReturnRow | null>(null);

  // Filters. The customer filter is a free-text contains-match — wrap it in
  // useDeferredValue so each keystroke updates the input synchronously but
  // the expensive crRows.filter pass runs at React's leisure (typically the
  // next idle slot). Saves ~1-2 frames per char on a 500-row consignment list.
  const [filterStatus, setFilterStatus] = useState("");
  const [filterCustomer, setFilterCustomer] = useState("");
  const deferredFilterCustomer = useDeferredValue(filterCustomer);
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");

  // ---------- Fetch ----------
  const { data: consignmentsResp, loading, refresh: fetchData } = useCachedJson<{ success?: boolean; data?: ConsignmentNote[] }>("/api/consignments");

  // crRows is mutated locally by inspect/accept/restock actions (see ~6
  // setCrRows call sites below). It needs to be a writable copy seeded from
  // the cached server snapshot; a pure derive would discard those local
  // edits.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (consignmentsResp?.success && consignmentsResp.data) {
      _crCounter = 0;
      setCrRows(buildMockCRs(consignmentsResp.data as ConsignmentNote[]));
    }
  }, [consignmentsResp]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ---------- Filtered data ----------
  const filteredRows = useMemo(() => {
    let data = crRows;

    // Tab filter
    const tabDef = TAB_FILTERS.find((t) => t.key === activeTab);
    if (tabDef && tabDef.statuses) {
      data = data.filter((d) => tabDef.statuses!.includes(d.status));
    }

    // Status filter
    if (filterStatus) {
      data = data.filter((d) => d.status === filterStatus);
    }

    // Customer filter — uses the deferred value so the input stays
    // responsive while the filter pass yields to other work.
    if (deferredFilterCustomer) {
      const needle = deferredFilterCustomer.toLowerCase();
      data = data.filter((d) =>
        d.customerName.toLowerCase().includes(needle)
      );
    }

    // Date filters
    if (filterDateFrom) {
      const from = new Date(filterDateFrom);
      data = data.filter((d) => d.returnDate && new Date(d.returnDate) >= from);
    }
    if (filterDateTo) {
      const to = new Date(filterDateTo);
      to.setHours(23, 59, 59, 999);
      data = data.filter((d) => d.returnDate && new Date(d.returnDate) <= to);
    }

    return data;
  }, [crRows, activeTab, filterStatus, deferredFilterCustomer, filterDateFrom, filterDateTo]);

  // ---------- Summary counts ----------
  const totalReturns = crRows.length;
  const pendingCount = crRows.filter((d) => d.status === "PENDING").length;
  const acceptedCount = crRows.filter((d) => d.status === "ACCEPTED").length;
  const restockedMTD = useMemo(() => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    return crRows.filter(
      (d) =>
        d.status === "RESTOCKED" &&
        d.returnDate &&
        new Date(d.returnDate) >= startOfMonth
    ).length;
  }, [crRows]);

  // ---------- Export CSV ----------
  const handleExportCSV = () => {
    const headers = ["CR No.", "CO Ref", "Customer", "Branch", "Items", "Return Value", "Return Date", "Status"];
    const csvRows = filteredRows.map((r) => [
      r.crNo,
      r.coRef,
      r.customerName,
      r.branchName,
      r.items,
      (r.returnValueSen / 100).toFixed(2),
      r.returnDate ? formatDate(r.returnDate) : "",
      STATUS_LABEL[r.status],
    ]);
    const csv = [headers, ...csvRows].map((row) => row.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `consignment-returns-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ---------- Columns ----------
  const columns: Column<ConsignmentReturnRow>[] = useMemo(
    () => [
      { key: "crNo", label: "CR No.", type: "docno", width: "120px", sortable: true },
      { key: "coRef", label: "CO Ref", type: "docno", width: "130px", sortable: true },
      {
        key: "customerName",
        label: "Customer",
        type: "text",
        sortable: true,
        render: (_value, row) => (
          <div>
            <p className="font-medium text-[#1F1D1B]">{row.customerName}</p>
          </div>
        ),
      },
      {
        key: "branchName",
        label: "Branch",
        type: "text",
        width: "120px",
        sortable: true,
      },
      {
        key: "items",
        label: "Items",
        type: "number",
        width: "70px",
        align: "right",
        sortable: true,
      },
      {
        key: "returnValueSen",
        label: "Return Value",
        type: "currency",
        width: "120px",
        sortable: true,
      },
      {
        key: "returnDate",
        label: "Return Date",
        type: "date",
        width: "110px",
        sortable: true,
        render: (_value, row) => (
          <span>{row.returnDate ? formatDate(row.returnDate) : "-"}</span>
        ),
      },
      { key: "status", label: "Status", type: "status", width: "110px", sortable: true },
    ],
    []
  );

  // ---------- Context menu ----------
  const getContextMenuItems = useCallback(
    (row: ConsignmentReturnRow): ContextMenuItem[] => [
      {
        label: "View Details",
        icon: <Eye className="h-3.5 w-3.5" />,
        action: () => setDetailCR(row),
      },
      {
        label: "Print CR",
        icon: <Printer className="h-3.5 w-3.5" />,
        action: () => toast.info(`Printing CR: ${row.crNo} — coming soon`),
      },
      {
        label: "Accept Return",
        icon: <CheckCircle2 className="h-3.5 w-3.5" />,
        action: () => {
          setCrRows((prev) =>
            prev.map((d) =>
              d.id === row.id && (d.status === "PENDING" || d.status === "INSPECTED")
                ? { ...d, status: "ACCEPTED" as CRStatus }
                : d
            )
          );
        },
        disabled: row.status !== "PENDING" && row.status !== "INSPECTED",
      },
      {
        label: "Restock Items",
        icon: <ArchiveRestore className="h-3.5 w-3.5" />,
        action: () => {
          setCrRows((prev) =>
            prev.map((d) =>
              d.id === row.id && d.status === "ACCEPTED"
                ? { ...d, status: "RESTOCKED" as CRStatus }
                : d
            )
          );
        },
        disabled: row.status !== "ACCEPTED",
      },
      { label: "", separator: true, action: () => {} },
      {
        label: "Refresh",
        icon: <RefreshCw className="h-3.5 w-3.5" />,
        action: () => fetchData(),
      },
    ],
    [fetchData]
  );

  // ---------- Tab counts ----------
  const tabCounts: Record<string, number> = {
    all: crRows.length,
    pending: pendingCount,
    inspected: crRows.filter((d) => d.status === "INSPECTED").length,
    accepted: acceptedCount,
    restocked: crRows.filter((d) => d.status === "RESTOCKED").length,
  };

  // ---------- Summary pipeline ----------
  const pipelineSteps = [
    { label: "Pending", status: "PENDING", count: pendingCount },
    { label: "Inspected", status: "INSPECTED", count: crRows.filter((d) => d.status === "INSPECTED").length },
    { label: "Accepted", status: "ACCEPTED", count: acceptedCount },
    { label: "Restocked", status: "RESTOCKED", count: crRows.filter((d) => d.status === "RESTOCKED").length },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Consignment Returns</h1>
          <p className="text-xs text-[#6B7280]">
            Track and process consignment returns from branches
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleExportCSV}>
            <Download className="h-4 w-4" /> Export CSV
          </Button>
          <Button
            variant="primary"
            onClick={() => toast.info("New Return — coming soon")}
          >
            <RotateCcw className="h-4 w-4" /> New Return
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#F0ECE9] p-2.5">
              <Package className="h-5 w-5 text-[#6B5C32]" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[#6B5C32]">{loading ? "-" : totalReturns}</p>
              <p className="text-xs text-[#6B7280]">Total Returns</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-amber-50 p-2.5">
              <Search className="h-5 w-5 text-amber-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-amber-600">{loading ? "-" : pendingCount}</p>
              <p className="text-xs text-[#6B7280]">Pending Inspection</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-blue-50 p-2.5">
              <CheckCircle2 className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-blue-600">{loading ? "-" : acceptedCount}</p>
              <p className="text-xs text-[#6B7280]">Accepted</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-green-50 p-2.5">
              <PackageCheck className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-green-600">{loading ? "-" : restockedMTD}</p>
              <p className="text-xs text-[#6B7280]">Restocked (MTD)</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Status Pipeline */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between overflow-x-auto gap-2">
            {pipelineSteps.map((s, i) => (
              <div key={s.label} className="flex items-center gap-2">
                <div
                  className="text-center min-w-[80px] cursor-pointer"
                  onClick={() => {
                    const tabKey = s.status.toLowerCase();
                    setActiveTab(activeTab === tabKey ? "all" : tabKey);
                  }}
                >
                  <Badge variant="status" status={s.status}>
                    {s.count}
                  </Badge>
                  <p
                    className={`text-xs mt-1 ${
                      activeTab === s.status.toLowerCase()
                        ? "text-[#6B5C32] font-medium"
                        : "text-[#6B7280]"
                    }`}
                  >
                    {s.label}
                  </p>
                </div>
                {i < pipelineSteps.length - 1 && (
                  <ArrowRight className="h-4 w-4 text-[#D1CBC5] shrink-0" />
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Tabs */}
      <div className="border-b border-[#E2DDD8]">
        <nav className="flex gap-6 overflow-x-auto" aria-label="Tabs">
          {TAB_FILTERS.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 pb-3 text-sm font-medium border-b-2 transition-colors cursor-pointer whitespace-nowrap ${
                activeTab === tab.key
                  ? "border-[#6B5C32] text-[#6B5C32]"
                  : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
              }`}
            >
              {tab.label}
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                  activeTab === tab.key
                    ? "bg-[#6B5C32] text-white"
                    : "bg-[#F0ECE9] text-[#6B7280]"
                }`}
              >
                {tabCounts[tab.key] ?? 0}
              </span>
            </button>
          ))}
        </nav>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="h-9 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20"
        >
          <option value="">All Statuses</option>
          <option value="PENDING">Pending</option>
          <option value="INSPECTED">Inspected</option>
          <option value="ACCEPTED">Accepted</option>
          <option value="RESTOCKED">Restocked</option>
        </select>
        <Input
          placeholder="Filter by customer..."
          value={filterCustomer}
          onChange={(e) => setFilterCustomer(e.target.value)}
          className="h-9 w-48"
        />
        <Input
          type="date"
          value={filterDateFrom}
          onChange={(e) => setFilterDateFrom(e.target.value)}
          className="h-9 w-40"
        />
        <span className="text-sm text-[#6B7280]">to</span>
        <Input
          type="date"
          value={filterDateTo}
          onChange={(e) => setFilterDateTo(e.target.value)}
          className="h-9 w-40"
        />
        {(filterStatus || filterCustomer || filterDateFrom || filterDateTo) && (
          <Button
            variant="outline"
            onClick={() => {
              setFilterStatus("");
              setFilterCustomer("");
              setFilterDateFrom("");
              setFilterDateTo("");
            }}
          >
            Clear Filters
          </Button>
        )}
      </div>

      {/* DataGrid */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <RotateCcw className="h-5 w-5 text-[#6B5C32]" /> Consignment Returns
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <DataGrid<ConsignmentReturnRow>
            columns={columns}
            data={filteredRows}
            keyField="id"
            loading={loading}
            stickyHeader
            maxHeight="calc(100vh - 280px)"
            emptyMessage="No consignment returns found."
            onDoubleClick={(row) => setDetailCR(row)}
            contextMenuItems={getContextMenuItems}
          />
        </CardContent>
      </Card>

      {/* ---------- Detail Dialog (inline, fixed inset-0 z-50) ---------- */}
      {detailCR && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setDetailCR(null)}
          />
          {/* Panel */}
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
            {/* Header */}
            <div className="sticky top-0 bg-white border-b border-[#E2DDD8] px-6 py-4 flex items-center justify-between rounded-t-xl">
              <div>
                <h2 className="text-lg font-bold text-[#1F1D1B]">{detailCR.crNo}</h2>
                <p className="text-xs text-[#6B7280]">Consignment Return Detail</p>
              </div>
              <button
                onClick={() => setDetailCR(null)}
                className="rounded-md p-1.5 hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#1F1D1B] transition-colors"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Body */}
            <div className="px-6 py-5 space-y-5">
              {/* Status */}
              <div className="flex items-center gap-3">
                <Badge variant="status" status={detailCR.status}>
                  {STATUS_LABEL[detailCR.status]}
                </Badge>
              </div>

              {/* Info Grid */}
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">CR Number</p>
                  <p className="font-medium doc-number">{detailCR.crNo}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">CO Reference</p>
                  <p className="font-medium doc-number">{detailCR.coRef}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Customer</p>
                  <p className="font-medium">{detailCR.customerName}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Branch</p>
                  <p className="font-medium">{detailCR.branchName}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Items</p>
                  <p className="font-medium">{detailCR.items}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Return Value</p>
                  <p className="font-medium">{formatCurrency(detailCR.returnValueSen)}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Return Date</p>
                  <p className="font-medium">
                    {detailCR.returnDate ? formatDate(detailCR.returnDate) : "-"}
                  </p>
                </div>
              </div>

              {/* Tracking */}
              <div className="border-t border-[#E2DDD8] pt-4">
                <h3 className="text-sm font-semibold text-[#1F1D1B] mb-3">Processing Status</h3>
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold ${
                        detailCR.status !== "PENDING" ? "bg-green-500" : "bg-amber-400"
                      }`}
                    >
                      1
                    </div>
                    <div>
                      <p className="text-sm font-medium">Pending</p>
                      <p className="text-xs text-[#9CA3AF]">
                        {detailCR.status === "PENDING" ? "Awaiting inspection" : "Completed"}
                      </p>
                    </div>
                  </div>
                  <div className="ml-4 border-l-2 border-[#E2DDD8] h-4" />
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold ${
                        detailCR.status === "INSPECTED" ? "bg-blue-500" :
                        detailCR.status === "ACCEPTED" || detailCR.status === "RESTOCKED" ? "bg-green-500" : "bg-gray-300"
                      }`}
                    >
                      2
                    </div>
                    <div>
                      <p className="text-sm font-medium">Inspected</p>
                      <p className="text-xs text-[#9CA3AF]">
                        {detailCR.status === "INSPECTED"
                          ? "Items under inspection"
                          : detailCR.status === "ACCEPTED" || detailCR.status === "RESTOCKED"
                          ? "Inspection completed"
                          : "Waiting"}
                      </p>
                    </div>
                  </div>
                  <div className="ml-4 border-l-2 border-[#E2DDD8] h-4" />
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold ${
                        detailCR.status === "ACCEPTED" ? "bg-blue-500" :
                        detailCR.status === "RESTOCKED" ? "bg-green-500" : "bg-gray-300"
                      }`}
                    >
                      3
                    </div>
                    <div>
                      <p className="text-sm font-medium">Accepted</p>
                      <p className="text-xs text-[#9CA3AF]">
                        {detailCR.status === "ACCEPTED"
                          ? "Return accepted, pending restock"
                          : detailCR.status === "RESTOCKED"
                          ? "Accepted"
                          : "Waiting"}
                      </p>
                    </div>
                  </div>
                  {detailCR.status === "RESTOCKED" && (
                    <>
                      <div className="ml-4 border-l-2 border-[#E2DDD8] h-4" />
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold bg-green-500">
                          4
                        </div>
                        <div>
                          <p className="text-sm font-medium">Restocked</p>
                          <p className="text-xs text-[#9CA3AF]">Items returned to inventory</p>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Remarks */}
              {detailCR.remarks && (
                <div className="border-t border-[#E2DDD8] pt-4">
                  <h3 className="text-sm font-semibold text-[#1F1D1B] mb-2">Remarks</h3>
                  <p className="text-xs text-[#6B7280]">{detailCR.remarks}</p>
                </div>
              )}
            </div>

            {/* Footer Actions */}
            <div className="sticky bottom-0 bg-white border-t border-[#E2DDD8] px-6 py-4 flex items-center justify-end gap-2 rounded-b-xl">
              {detailCR.status === "PENDING" && (
                <Button
                  variant="primary"
                  onClick={() => {
                    setCrRows((prev) =>
                      prev.map((d) =>
                        d.id === detailCR.id
                          ? { ...d, status: "INSPECTED" as CRStatus }
                          : d
                      )
                    );
                    setDetailCR({ ...detailCR, status: "INSPECTED" });
                  }}
                >
                  <Search className="h-4 w-4" /> Mark Inspected
                </Button>
              )}
              {detailCR.status === "INSPECTED" && (
                <Button
                  variant="primary"
                  onClick={() => {
                    setCrRows((prev) =>
                      prev.map((d) =>
                        d.id === detailCR.id
                          ? { ...d, status: "ACCEPTED" as CRStatus }
                          : d
                      )
                    );
                    setDetailCR({ ...detailCR, status: "ACCEPTED" });
                  }}
                >
                  <CheckCircle2 className="h-4 w-4" /> Accept Return
                </Button>
              )}
              {detailCR.status === "ACCEPTED" && (
                <Button
                  variant="primary"
                  onClick={() => {
                    setCrRows((prev) =>
                      prev.map((d) =>
                        d.id === detailCR.id
                          ? { ...d, status: "RESTOCKED" as CRStatus }
                          : d
                      )
                    );
                    setDetailCR({ ...detailCR, status: "RESTOCKED" });
                  }}
                >
                  <ArchiveRestore className="h-4 w-4" /> Restock Items
                </Button>
              )}
              <Button variant="outline" onClick={() => setDetailCR(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
