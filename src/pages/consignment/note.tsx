import { useState, useEffect, useMemo, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  Package,
  Truck,
  CheckCircle2,
  Eye,
  Printer,
  RefreshCw,
  ArrowRight,
  Download,
  FileText,
  PackageCheck,
  RotateCcw,
  X,
} from "lucide-react";
import type { ConsignmentNote } from "@/lib/mock-data";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CNStatus = "PENDING" | "DISPATCHED" | "DELIVERED" | "ACKNOWLEDGED";

// View-model row for the CN grid. We join each ConsignmentNote to its parent
// ConsignmentOrder on the client to show customer/branch in the table.
type ConsignmentNoteRow = {
  id: string;
  cnNo: string;
  coRef: string;              // parent CO's noteNumber (CON-YYMM-XXX)
  consignmentId: string;      // parent CO id (for drill-through)
  customerId: string;
  customerName: string;
  branchName: string;
  items: number;              // count of line items
  totalQty: number;           // sum of item qty
  totalValueSen: number;      // computed from parent CO items where possible
  dispatchDate: string | null;
  deliveredDate: string | null;
  driverName: string;
  vehicleNo: string;
  status: CNStatus;
  remarks: string;
};

// Build grid rows from ConsignmentNote records.
// ConsignmentNote serves as both the consignment order and the dispatch note,
// so we map its fields directly to ConsignmentNoteRow.
function joinCNsWithOrders(
  cns: ConsignmentNote[],
  _orders: ConsignmentNote[],
): ConsignmentNoteRow[] {
  return cns.map((cn) => {
    const totalQty = cn.items.reduce((s, i) => s + i.quantity, 0);
    const totalValueSen = cn.totalValue;
    return {
      id: cn.id,
      cnNo: cn.noteNumber,
      coRef: cn.noteNumber,
      consignmentId: cn.id,
      customerId: cn.customerId,
      customerName: cn.customerName,
      branchName: cn.branchName,
      items: cn.items.length,
      totalQty,
      totalValueSen,
      dispatchDate: cn.sentDate || null,
      deliveredDate: null,
      driverName: "",
      vehicleNo: "",
      status: (
        cn.status === "ACTIVE" ? "PENDING" :
        cn.status === "PARTIALLY_SOLD" ? "DISPATCHED" :
        cn.status === "FULLY_SOLD" ? "DELIVERED" :
        cn.status === "RETURNED" ? "DELIVERED" :
        cn.status === "CLOSED" ? "ACKNOWLEDGED" : "PENDING"
      ) as CNStatus,
      remarks: cn.notes || "",
    };
  });
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const STATUS_LABEL: Record<CNStatus, string> = {
  PENDING: "Pending",
  DISPATCHED: "Dispatched",
  DELIVERED: "Delivered",
  ACKNOWLEDGED: "Acknowledged",
};

const TAB_FILTERS: { key: string; label: string; statuses: CNStatus[] | null }[] = [
  { key: "all", label: "All", statuses: null },
  { key: "pending", label: "Pending", statuses: ["PENDING"] },
  { key: "dispatched", label: "Dispatched", statuses: ["DISPATCHED"] },
  { key: "delivered", label: "Delivered", statuses: ["DELIVERED"] },
  { key: "acknowledged", label: "Acknowledged", statuses: ["ACKNOWLEDGED"] },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ConsignmentNotePage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [cnRows, setCnRows] = useState<ConsignmentNoteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState("all");
  const [detailCN, setDetailCN] = useState<ConsignmentNoteRow | null>(null);

  // Transfer dialog states
  const [transferDORow, setTransferDORow] = useState<ConsignmentNoteRow | null>(null);
  const [transferDOLoading, setTransferDOLoading] = useState(false);
  const [transferCRRow, setTransferCRRow] = useState<ConsignmentNoteRow | null>(null);
  const [transferCRLoading, setTransferCRLoading] = useState(false);
  const [crReturnQtys, setCrReturnQtys] = useState<Record<string, number>>({});
  const [crSelectedItems, setCrSelectedItems] = useState<Record<string, boolean>>({});
  const [transferSIRow, setTransferSIRow] = useState<ConsignmentNoteRow | null>(null);
  const [transferSILoading, setTransferSILoading] = useState(false);

  // Filters
  const [filterStatus, setFilterStatus] = useState("");
  const [filterCustomer, setFilterCustomer] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");

  // ---------- Fetch ----------
  // Pull real ConsignmentNote rows from /api/consignment-notes and join them
  // client-side with their parent ConsignmentOrder so the grid can show
  // customer / branch / CO ref alongside the dispatch info.
  const fetchData = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch("/api/consignment-notes").then((r) => r.json()),
      fetch("/api/consignments").then((r) => r.json()),
    ])
      .then(([cnResp, coResp]) => {
        if (cnResp?.success && coResp?.success) {
          const cns = (cnResp.data || []) as ConsignmentNote[];
          const orders = (coResp.data || []) as ConsignmentNote[];
          setCnRows(joinCNsWithOrders(cns, orders));
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ---------- Filtered data ----------
  const filteredRows = useMemo(() => {
    let data = cnRows;

    // Tab filter
    const tabDef = TAB_FILTERS.find((t) => t.key === activeTab);
    if (tabDef && tabDef.statuses) {
      data = data.filter((d) => tabDef.statuses!.includes(d.status));
    }

    // Status filter
    if (filterStatus) {
      data = data.filter((d) => d.status === filterStatus);
    }

    // Customer filter
    if (filterCustomer) {
      data = data.filter((d) =>
        d.customerName.toLowerCase().includes(filterCustomer.toLowerCase())
      );
    }

    // Date filters
    if (filterDateFrom) {
      const from = new Date(filterDateFrom);
      data = data.filter((d) => d.dispatchDate && new Date(d.dispatchDate) >= from);
    }
    if (filterDateTo) {
      const to = new Date(filterDateTo);
      to.setHours(23, 59, 59, 999);
      data = data.filter((d) => d.dispatchDate && new Date(d.dispatchDate) <= to);
    }

    return data;
  }, [cnRows, activeTab, filterStatus, filterCustomer, filterDateFrom, filterDateTo]);

  // ---------- Summary counts ----------
  const totalNotes = cnRows.length;
  const pendingCount = cnRows.filter((d) => d.status === "PENDING").length;
  const inTransitCount = cnRows.filter((d) => d.status === "DISPATCHED").length;
  const deliveredMTD = useMemo(() => {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    return cnRows.filter(
      (d) =>
        d.status === "DELIVERED" &&
        d.deliveredDate &&
        new Date(d.deliveredDate) >= startOfMonth
    ).length;
  }, [cnRows]);

  // ---------- Export CSV ----------
  const handleExportCSV = () => {
    const headers = ["CN No.", "CO Ref", "Customer", "Branch", "Items", "Total Value", "Dispatch Date", "Status"];
    const csvRows = filteredRows.map((r) => [
      r.cnNo,
      r.coRef,
      r.customerName,
      r.branchName,
      r.items,
      (r.totalValueSen / 100).toFixed(2),
      r.dispatchDate ? formatDate(r.dispatchDate) : "",
      STATUS_LABEL[r.status],
    ]);
    const csv = [headers, ...csvRows].map((row) => row.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `consignment-notes-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ---------- Columns ----------
  const columns: Column<ConsignmentNoteRow>[] = useMemo(
    () => [
      { key: "cnNo", label: "CN No.", type: "docno", width: "120px", sortable: true },
      {
        key: "coRef",
        label: "CO Ref",
        type: "docno",
        width: "130px",
        sortable: true,
        render: (_value, row) => (
          <button
            type="button"
            className="doc-number text-[#6B5C32] hover:underline"
            onClick={(e) => {
              e.stopPropagation();
              navigate(`/consignment/${row.consignmentId}`);
            }}
            title="Open parent Consignment Order"
          >
            {row.coRef}
          </button>
        ),
      },
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
        key: "totalValueSen",
        label: "Total Value",
        type: "currency",
        width: "120px",
        sortable: true,
      },
      {
        key: "dispatchDate",
        label: "Dispatch Date",
        type: "date",
        width: "110px",
        sortable: true,
        render: (_value, row) => (
          <span>{row.dispatchDate ? formatDate(row.dispatchDate) : "-"}</span>
        ),
      },
      { key: "status", label: "Status", type: "status", width: "120px", sortable: true },
    ],
    [navigate]
  );

  // ---------- Context menu ----------
  const getContextMenuItems = useCallback(
    (row: ConsignmentNoteRow): ContextMenuItem[] => [
      {
        label: "View Details",
        icon: <Eye className="h-3.5 w-3.5" />,
        action: () => setDetailCN(row),
      },
      {
        label: "Print CN",
        icon: <Printer className="h-3.5 w-3.5" />,
        action: () => toast.info(`Printing CN: ${row.cnNo} — coming soon`),
      },
      { label: "", separator: true, action: () => {} },
      {
        label: "Transfer to Delivery Order",
        icon: <Truck className="h-3.5 w-3.5" />,
        action: () => setTransferDORow(row),
      },
      {
        label: "Transfer to Sales Invoice",
        icon: <FileText className="h-3.5 w-3.5" />,
        action: () => setTransferSIRow(row),
      },
      {
        label: "Transfer to Consignment Return",
        icon: <RotateCcw className="h-3.5 w-3.5" />,
        action: () => {
          const qtys: Record<string, number> = {};
          const selected: Record<string, boolean> = {};
          // We only have item count, not actual items, so create placeholder entries
          for (let i = 0; i < row.items; i++) {
            const key = `${row.id}-item-${i}`;
            qtys[key] = 1;
            selected[key] = true;
          }
          setCrReturnQtys(qtys);
          setCrSelectedItems(selected);
          setTransferCRRow(row);
        },
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
    all: cnRows.length,
    pending: pendingCount,
    dispatched: inTransitCount,
    delivered: cnRows.filter((d) => d.status === "DELIVERED").length,
    acknowledged: cnRows.filter((d) => d.status === "ACKNOWLEDGED").length,
  };

  // ---------- Transfer Handlers ----------
  const handleTransferToDO = async () => {
    if (!transferDORow) return;
    setTransferDOLoading(true);
    // Simulate a short delay for UX
    await new Promise((r) => setTimeout(r, 600));
    setTransferDOLoading(false);
    setTransferDORow(null);
    navigate("/delivery");
  };

  const handleTransferToCR = async () => {
    if (!transferCRRow) return;
    const selectedCount = Object.values(crSelectedItems).filter(Boolean).length;
    if (selectedCount === 0) {
      toast.warning("Please select at least one item to return.");
      return;
    }
    setTransferCRLoading(true);
    try {
      const res = await fetch("/api/consignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "RETURN",
          sourceId: transferCRRow.consignmentId,
          customerId: transferCRRow.customerId,
          customerName: transferCRRow.customerName,
          branchName: transferCRRow.branchName,
          items: Object.entries(crSelectedItems)
            .filter(([, selected]) => selected)
            .map(([key]) => ({ id: key, quantity: crReturnQtys[key] ?? 1 })),
          notes: "Return from " + transferCRRow.cnNo,
        }),
      });
      if (!res.ok) throw new Error("Failed to create Consignment Return");
      setTransferCRRow(null);
      navigate("/consignment/return");
    } catch {
      toast.error("Failed to create Consignment Return. Please try again.");
    } finally {
      setTransferCRLoading(false);
    }
  };

  const handleTransferToSI = async () => {
    if (!transferSIRow) return;
    setTransferSILoading(true);
    try {
      const invNo = `INV-${new Date().getFullYear().toString().slice(-2)}${(new Date().getMonth() + 1).toString().padStart(2, "0")}-${String(Math.floor(Math.random() * 900) + 100)}`;
      const res = await fetch("/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consignmentNoteId: transferSIRow.id,
          cnNo: transferSIRow.cnNo,
          coRef: transferSIRow.coRef,
          customerId: transferSIRow.customerId,
          customerName: transferSIRow.customerName,
          invoiceNo: invNo,
          totalSen: transferSIRow.totalValueSen,
          items: transferSIRow.items,
        }),
      });
      if (!res.ok) throw new Error("Failed");
      setTransferSIRow(null);
      navigate("/sales"); // Navigate to invoices
    } catch {
      toast.error("Failed to create Sales Invoice. Please try again.");
    } finally {
      setTransferSILoading(false);
    }
  };

  // ---------- Summary pipeline ----------
  const pipelineSteps = [
    { label: "Pending", status: "PENDING", count: pendingCount },
    { label: "Dispatched", status: "DISPATCHED", count: inTransitCount },
    { label: "Delivered", status: "DELIVERED", count: cnRows.filter((d) => d.status === "DELIVERED").length },
    { label: "Acknowledged", status: "ACKNOWLEDGED", count: cnRows.filter((d) => d.status === "ACKNOWLEDGED").length },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Consignment Notes</h1>
          <p className="text-xs text-[#6B7280]">
            Track consignment dispatches and deliveries to branches
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleExportCSV}>
            <Download className="h-4 w-4" /> Export CSV
          </Button>
          <Button
            variant="primary"
            onClick={() => toast.info("New Consignment Note — coming soon")}
          >
            <FileText className="h-4 w-4" /> New Consignment Note
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
              <p className="text-2xl font-bold text-[#6B5C32]">{loading ? "-" : totalNotes}</p>
              <p className="text-xs text-[#6B7280]">Total Notes</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-amber-50 p-2.5">
              <PackageCheck className="h-5 w-5 text-amber-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-amber-600">{loading ? "-" : pendingCount}</p>
              <p className="text-xs text-[#6B7280]">Pending Dispatch</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-blue-50 p-2.5">
              <Truck className="h-5 w-5 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-blue-600">{loading ? "-" : inTransitCount}</p>
              <p className="text-xs text-[#6B7280]">In Transit</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-green-50 p-2.5">
              <CheckCircle2 className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-green-600">{loading ? "-" : deliveredMTD}</p>
              <p className="text-xs text-[#6B7280]">Delivered (MTD)</p>
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
          <option value="DISPATCHED">Dispatched</option>
          <option value="DELIVERED">Delivered</option>
          <option value="ACKNOWLEDGED">Acknowledged</option>
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
              <FileText className="h-5 w-5 text-[#6B5C32]" /> Consignment Notes
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <DataGrid<ConsignmentNoteRow>
            columns={columns}
            data={filteredRows}
            keyField="id"
            loading={loading}
            stickyHeader
            maxHeight="calc(100vh - 280px)"
            emptyMessage="No consignment notes found."
            onDoubleClick={(row) => setDetailCN(row)}
            contextMenuItems={getContextMenuItems}
          />
        </CardContent>
      </Card>

      {/* ---------- Detail Dialog (inline, fixed inset-0 z-50) ---------- */}
      {detailCN && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setDetailCN(null)}
          />
          {/* Panel */}
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
            {/* Header */}
            <div className="sticky top-0 bg-white border-b border-[#E2DDD8] px-6 py-4 flex items-center justify-between rounded-t-xl">
              <div>
                <h2 className="text-lg font-bold text-[#1F1D1B]">{detailCN.cnNo}</h2>
                <p className="text-xs text-[#6B7280]">Consignment Note Detail</p>
              </div>
              <button
                onClick={() => setDetailCN(null)}
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
                <Badge variant="status" status={detailCN.status}>
                  {STATUS_LABEL[detailCN.status]}
                </Badge>
              </div>

              {/* Info Grid */}
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">CN Number</p>
                  <p className="font-medium doc-number">{detailCN.cnNo}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">CO Reference</p>
                  <p className="font-medium doc-number">{detailCN.coRef}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Customer</p>
                  <p className="font-medium">{detailCN.customerName}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Branch</p>
                  <p className="font-medium">{detailCN.branchName}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Items</p>
                  <p className="font-medium">{detailCN.items}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Total Value</p>
                  <p className="font-medium">{formatCurrency(detailCN.totalValueSen)}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Dispatch Date</p>
                  <p className="font-medium">
                    {detailCN.dispatchDate ? formatDate(detailCN.dispatchDate) : "-"}
                  </p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Delivered Date</p>
                  <p className="font-medium">
                    {detailCN.deliveredDate ? formatDate(detailCN.deliveredDate) : "-"}
                  </p>
                </div>
              </div>

              {/* Tracking */}
              <div className="border-t border-[#E2DDD8] pt-4">
                <h3 className="text-sm font-semibold text-[#1F1D1B] mb-3">Tracking</h3>
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold ${
                        detailCN.status !== "PENDING" ? "bg-green-500" : "bg-amber-400"
                      }`}
                    >
                      1
                    </div>
                    <div>
                      <p className="text-sm font-medium">Pending</p>
                      <p className="text-xs text-[#9CA3AF]">
                        {detailCN.status === "PENDING" ? "Awaiting dispatch" : "Completed"}
                      </p>
                    </div>
                  </div>
                  <div className="ml-4 border-l-2 border-[#E2DDD8] h-4" />
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold ${
                        detailCN.dispatchDate ? "bg-green-500" : "bg-gray-300"
                      }`}
                    >
                      2
                    </div>
                    <div>
                      <p className="text-sm font-medium">Dispatched</p>
                      <p className="text-xs text-[#9CA3AF]">
                        {detailCN.dispatchDate
                          ? formatDate(detailCN.dispatchDate)
                          : "Pending dispatch"}
                      </p>
                    </div>
                  </div>
                  <div className="ml-4 border-l-2 border-[#E2DDD8] h-4" />
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold ${
                        detailCN.deliveredDate ? "bg-green-500" : "bg-gray-300"
                      }`}
                    >
                      3
                    </div>
                    <div>
                      <p className="text-sm font-medium">Delivered</p>
                      <p className="text-xs text-[#9CA3AF]">
                        {detailCN.deliveredDate
                          ? formatDate(detailCN.deliveredDate)
                          : "Awaiting delivery"}
                      </p>
                    </div>
                  </div>
                  {detailCN.status === "ACKNOWLEDGED" && (
                    <>
                      <div className="ml-4 border-l-2 border-[#E2DDD8] h-4" />
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold bg-purple-500">
                          4
                        </div>
                        <div>
                          <p className="text-sm font-medium">Acknowledged</p>
                          <p className="text-xs text-[#9CA3AF]">Branch confirmed receipt</p>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Remarks */}
              {detailCN.remarks && (
                <div className="border-t border-[#E2DDD8] pt-4">
                  <h3 className="text-sm font-semibold text-[#1F1D1B] mb-2">Remarks</h3>
                  <p className="text-xs text-[#6B7280]">{detailCN.remarks}</p>
                </div>
              )}
            </div>

            {/* Footer Actions */}
            <div className="sticky bottom-0 bg-white border-t border-[#E2DDD8] px-6 py-4 flex items-center justify-end gap-2 rounded-b-xl">
              {(detailCN.status === "PENDING" || detailCN.status === "DISPATCHED") && (
                <Button
                  variant="primary"
                  onClick={() => {
                    setDetailCN(null);
                    setTransferDORow(detailCN);
                  }}
                >
                  <Truck className="h-4 w-4" /> Transfer to Delivery Order
                </Button>
              )}
              <Button
                variant="outline"
                onClick={() => {
                  const qtys: Record<string, number> = {};
                  const selected: Record<string, boolean> = {};
                  for (let i = 0; i < detailCN.items; i++) {
                    const key = `${detailCN.id}-item-${i}`;
                    qtys[key] = 1;
                    selected[key] = true;
                  }
                  setCrReturnQtys(qtys);
                  setCrSelectedItems(selected);
                  setDetailCN(null);
                  setTransferCRRow(detailCN);
                }}
              >
                <RotateCcw className="h-4 w-4" /> Transfer to Return
              </Button>
              <Button variant="outline" onClick={() => setDetailCN(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* -------- Transfer to Delivery Order Dialog -------- */}
      {transferDORow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setTransferDORow(null)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
            {/* Header */}
            <div className="sticky top-0 bg-white border-b border-[#E2DDD8] px-6 py-4 flex items-center justify-between rounded-t-xl">
              <div>
                <h2 className="text-lg font-bold text-[#1F1D1B]">Transfer to Delivery Order</h2>
                <p className="text-xs text-[#6B7280]">Create a DO from {transferDORow.cnNo}</p>
              </div>
              <button onClick={() => setTransferDORow(null)} className="rounded-md p-1.5 hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#1F1D1B] transition-colors">
                <X className="h-5 w-5" />
              </button>
            </div>
            {/* Body */}
            <div className="px-6 py-5 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">CN Number</p>
                  <p className="font-medium doc-number">{transferDORow.cnNo}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">CO Reference</p>
                  <p className="font-medium doc-number">{transferDORow.coRef}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Customer</p>
                  <p className="font-medium">{transferDORow.customerName}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Branch</p>
                  <p className="font-medium">{transferDORow.branchName}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Items</p>
                  <p className="font-medium">{transferDORow.items} item(s)</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Total Value</p>
                  <p className="font-medium">{formatCurrency(transferDORow.totalValueSen)}</p>
                </div>
              </div>
              <div className="bg-[#FAF9F7] border border-[#E2DDD8] rounded-lg p-3">
                <p className="text-sm text-[#6B7280]">
                  This will create a Delivery Order for dispatching CN <strong>{transferDORow.cnNo}</strong> to <strong>{transferDORow.branchName}</strong>.
                </p>
              </div>
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <p className="text-sm text-blue-800">
                  After the DO is created, you can track the dispatch from the Delivery Order page.
                </p>
              </div>
            </div>
            {/* Footer */}
            <div className="sticky bottom-0 bg-white border-t border-[#E2DDD8] px-6 py-4 flex items-center justify-end gap-2 rounded-b-xl">
              <Button variant="outline" onClick={() => setTransferDORow(null)} disabled={transferDOLoading}>Cancel</Button>
              <Button variant="primary" onClick={handleTransferToDO} disabled={transferDOLoading}>
                <Truck className="h-4 w-4" /> {transferDOLoading ? "Creating..." : "Create Delivery Order"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* -------- Transfer to Sales Invoice Dialog -------- */}
      {transferSIRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-xl w-[480px] overflow-hidden">
            <div className="px-6 py-4 border-b border-[#E2DDD8] flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-[#1F1D1B]">Transfer to Sales Invoice</h2>
                <p className="text-xs text-[#6B7280]">Create Sales Invoice from {transferSIRow.cnNo}</p>
              </div>
              <button onClick={() => setTransferSIRow(null)} className="p-1 hover:bg-gray-100 rounded">
                <X className="h-5 w-5 text-gray-400" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-gray-500">CN No:</span><p className="font-medium doc-number">{transferSIRow.cnNo}</p></div>
                <div><span className="text-gray-500">CO Ref:</span><p className="font-medium doc-number">{transferSIRow.coRef}</p></div>
                <div><span className="text-gray-500">Customer:</span><p className="font-medium">{transferSIRow.customerName}</p></div>
                <div><span className="text-gray-500">Branch:</span><p className="font-medium">{transferSIRow.branchName}</p></div>
                <div><span className="text-gray-500">Items:</span><p className="font-medium">{transferSIRow.items}</p></div>
                <div><span className="text-gray-500">Total Value:</span><p className="font-medium text-[#6B5C32]">{formatCurrency(transferSIRow.totalValueSen)}</p></div>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-800">
                <p className="font-medium">CN serves as Delivery Order</p>
                <p className="text-xs mt-1 text-amber-600">This consignment note will be used as the delivery reference for the invoice.</p>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-[#E2DDD8] flex justify-end gap-2">
              <Button variant="outline" onClick={() => setTransferSIRow(null)} disabled={transferSILoading}>Cancel</Button>
              <Button onClick={handleTransferToSI} disabled={transferSILoading} className="bg-[#6B5C32] hover:bg-[#5A4D2A] text-white">
                {transferSILoading ? "Creating..." : "Create Sales Invoice"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* -------- Transfer to Consignment Return Dialog -------- */}
      {transferCRRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setTransferCRRow(null)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
            {/* Header */}
            <div className="sticky top-0 bg-white border-b border-[#E2DDD8] px-6 py-4 flex items-center justify-between rounded-t-xl">
              <div>
                <h2 className="text-lg font-bold text-[#1F1D1B]">Transfer to Consignment Return</h2>
                <p className="text-xs text-[#6B7280]">Return items from {transferCRRow.cnNo}</p>
              </div>
              <button onClick={() => setTransferCRRow(null)} className="rounded-md p-1.5 hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#1F1D1B] transition-colors">
                <X className="h-5 w-5" />
              </button>
            </div>
            {/* Body */}
            <div className="px-6 py-5 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">CN Number</p>
                  <p className="font-medium doc-number">{transferCRRow.cnNo}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Customer</p>
                  <p className="font-medium">{transferCRRow.customerName}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Branch</p>
                  <p className="font-medium">{transferCRRow.branchName}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Total Items</p>
                  <p className="font-medium">{transferCRRow.items} item(s)</p>
                </div>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                <p className="text-sm text-amber-800">
                  Select the items and quantities you want to return from this consignment note.
                </p>
              </div>
              {/* Items with checkboxes and quantity inputs */}
              <div className="border border-[#E2DDD8] rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-[#FAF9F7]">
                    <tr>
                      <th className="text-left px-3 py-2 text-xs text-[#9CA3AF] font-medium w-8"></th>
                      <th className="text-left px-3 py-2 text-xs text-[#9CA3AF] font-medium">Item</th>
                      <th className="text-right px-3 py-2 text-xs text-[#9CA3AF] font-medium w-24">Return Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: transferCRRow.items }, (_, i) => {
                      const key = `${transferCRRow.id}-item-${i}`;
                      return (
                        <tr key={key} className={`border-t border-[#E2DDD8] ${!crSelectedItems[key] ? "opacity-50" : ""}`}>
                          <td className="px-3 py-2">
                            <input
                              type="checkbox"
                              checked={!!crSelectedItems[key]}
                              onChange={(e) => setCrSelectedItems((prev) => ({ ...prev, [key]: e.target.checked }))}
                              className="rounded border-[#E2DDD8] text-[#6B5C32] focus:ring-[#6B5C32]"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <p className="font-medium">Item {i + 1}</p>
                            <p className="text-xs text-[#9CA3AF]">From {transferCRRow.cnNo}</p>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input
                              type="number"
                              min={1}
                              value={crReturnQtys[key] ?? 1}
                              onChange={(e) => {
                                const val = Math.max(1, parseInt(e.target.value) || 1);
                                setCrReturnQtys((prev) => ({ ...prev, [key]: val }));
                              }}
                              disabled={!crSelectedItems[key]}
                              className="w-20 rounded-md border border-[#E2DDD8] px-2 py-1 text-sm text-right focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32] disabled:bg-gray-100"
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-between text-sm px-1">
                <span className="text-[#6B7280]">
                  Selected: {Object.values(crSelectedItems).filter(Boolean).length} of {transferCRRow.items} items
                </span>
              </div>
            </div>
            {/* Footer */}
            <div className="sticky bottom-0 bg-white border-t border-[#E2DDD8] px-6 py-4 flex items-center justify-end gap-2 rounded-b-xl">
              <Button variant="outline" onClick={() => setTransferCRRow(null)} disabled={transferCRLoading}>Cancel</Button>
              <Button variant="primary" onClick={handleTransferToCR} disabled={transferCRLoading}>
                <RotateCcw className="h-4 w-4" /> {transferCRLoading ? "Creating..." : "Confirm Return"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
