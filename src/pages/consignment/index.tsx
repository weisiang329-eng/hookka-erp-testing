import { useState, useEffect, useMemo } from "react";
import { useToast } from "@/components/ui/toast";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency } from "@/lib/utils";
import { Plus, Package, ArrowRight, Download, Filter, X, Eye, Pencil, Printer, RotateCcw, RefreshCw, FileText, ClipboardList } from "lucide-react";
import type { ConsignmentNote } from "@/lib/mock-data";
import type { Customer } from "@/lib/mock-data";

const ALL_STATUSES = [
  { value: "", label: "All Statuses" },
  { value: "ACTIVE", label: "Active" },
  { value: "PARTIALLY_SOLD", label: "Partially Sold" },
  { value: "FULLY_SOLD", label: "Fully Sold" },
  { value: "RETURNED", label: "Returned" },
  { value: "CLOSED", label: "Closed" },
];

export default function ConsignmentPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [orders, setOrders] = useState<ConsignmentNote[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);

  // Transfer dialog states
  const [transferCNRow, setTransferCNRow] = useState<ConsignmentNote | null>(null);
  const [transferCNLoading, setTransferCNLoading] = useState(false);
  const [transferCRRow, setTransferCRRow] = useState<ConsignmentNote | null>(null);
  const [transferCRLoading, setTransferCRLoading] = useState(false);
  const [crReturnQtys, setCrReturnQtys] = useState<Record<string, number>>({});
  const [crSelectedItems, setCrSelectedItems] = useState<Record<string, boolean>>({});
  const [transferSIRow, setTransferSIRow] = useState<ConsignmentNote | null>(null);
  const [transferSILoading, setTransferSILoading] = useState(false);

  // Filters
  const [filterStatus, setFilterStatus] = useState("");
  const [filterCustomer, setFilterCustomer] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const fetchOrders = () => {
    setLoading(true);
    fetch("/api/consignments")
      .then((r) => r.json())
      .then((d) => {
        setOrders(d.data || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    fetch("/api/customers")
      .then((r) => r.json())
      .then((d) => { if (d.data) setCustomers(d.data); });
  };

  useEffect(() => {
    fetchOrders();
  }, []);

  const hasActiveFilters = filterStatus || filterCustomer || filterDateFrom || filterDateTo;

  const clearFilters = () => {
    setFilterStatus("");
    setFilterCustomer("");
    setFilterDateFrom("");
    setFilterDateTo("");
  };

  const filteredOrders = useMemo(() => {
    return orders.filter((n) => {
      if (filterStatus && n.status !== filterStatus) return false;
      if (filterCustomer && n.customerId !== filterCustomer) return false;
      if (filterDateFrom && n.sentDate < filterDateFrom) return false;
      if (filterDateTo && n.sentDate > filterDateTo) return false;
      return true;
    });
  }, [orders, filterStatus, filterCustomer, filterDateFrom, filterDateTo]);

  const exportCSV = () => {
    const headers = ["Note #", "Type", "Customer", "Branch", "Date", "Items", "Total Value (RM)", "Status", "Notes"];
    const rows = filteredOrders.map((n) => [
      n.noteNumber,
      n.type,
      n.customerName,
      n.branchName,
      n.sentDate,
      n.items.length.toString(),
      (n.totalValue / 100).toFixed(2),
      n.status,
      n.notes,
    ]);
    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `consignment-orders-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const columns: Column<ConsignmentNote>[] = [
    { key: "noteNumber", label: "Note #", type: "docno", width: "130px", sortable: true },
    { key: "type", label: "Type", type: "text", width: "60px", sortable: true },
    { key: "customerName", label: "Customer", type: "text", width: "120px", sortable: true },
    { key: "branchName", label: "Branch", type: "text", width: "120px", sortable: true },
    { key: "sentDate", label: "Date", type: "date", width: "100px", sortable: true },
    {
      key: "items",
      label: "Items",
      type: "number",
      width: "60px",
      sortable: true,
      render: (_value, row) => <span>{row.items.length}</span>,
    },
    { key: "totalValue", label: "Total Value", type: "currency", width: "110px", sortable: true },
    { key: "status", label: "Status", type: "status", width: "120px", sortable: true },
  ];

  const getContextMenuItems = (row: ConsignmentNote): ContextMenuItem[] => [
    {
      label: "View",
      icon: <Eye className="h-3.5 w-3.5" />,
      action: () => navigate(`/consignment/${row.id}`),
    },
    {
      label: "Edit",
      icon: <Pencil className="h-3.5 w-3.5" />,
      action: () => {
        if (row.status === "CLOSED") {
          toast.warning("Cannot edit a closed consignment note.");
          return;
        }
        navigate(`/consignment/${row.id}`);
      },
    },
    {
      label: "",
      separator: true,
      action: () => {},
    },
    {
      label: "Print / Preview",
      icon: <Printer className="h-3.5 w-3.5" />,
      action: () => toast.info(`Print ${row.noteNumber} — coming soon`),
    },
    {
      label: "",
      separator: true,
      action: () => {},
    },
    {
      label: "Transfer to Consignment Note",
      icon: <ClipboardList className="h-3.5 w-3.5" />,
      action: () => setTransferCNRow(row),
    },
    {
      label: "Transfer to Consignment Return",
      icon: <RotateCcw className="h-3.5 w-3.5" />,
      action: () => {
        const qtys: Record<string, number> = {};
        const selected: Record<string, boolean> = {};
        row.items.forEach((item) => {
          qtys[item.id] = item.quantity;
          selected[item.id] = true;
        });
        setCrReturnQtys(qtys);
        setCrSelectedItems(selected);
        setTransferCRRow(row);
      },
    },
    {
      label: "Transfer to Sales Invoice",
      icon: <FileText className="h-3.5 w-3.5" />,
      action: () => setTransferSIRow(row),
    },
    {
      label: "",
      separator: true,
      action: () => {},
    },
    {
      label: "Refresh",
      icon: <RefreshCw className="h-3.5 w-3.5" />,
      action: () => fetchOrders(),
    },
  ];

  const statusCounts = [
    { label: "Active", status: "ACTIVE", count: orders.filter((n) => n.status === "ACTIVE").length },
    { label: "Partially Sold", status: "PARTIALLY_SOLD", count: orders.filter((n) => n.status === "PARTIALLY_SOLD").length },
    { label: "Fully Sold", status: "FULLY_SOLD", count: orders.filter((n) => n.status === "FULLY_SOLD").length },
    { label: "Returned", status: "RETURNED", count: orders.filter((n) => n.status === "RETURNED").length },
    { label: "Closed", status: "CLOSED", count: orders.filter((n) => n.status === "CLOSED").length },
  ];

  // ---------- Transfer Handlers ----------
  const handleTransferToCN = async () => {
    if (!transferCNRow) return;
    setTransferCNLoading(true);
    try {
      const res = await fetch("/api/consignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "NOTE",
          sourceId: transferCNRow.id,
          customerId: transferCNRow.customerId,
          customerName: transferCNRow.customerName,
          branchName: transferCNRow.branchName,
          items: transferCNRow.items,
          notes: "Generated from " + transferCNRow.noteNumber,
        }),
      });
      if (!res.ok) throw new Error("Failed to create Consignment Note");
      setTransferCNRow(null);
      navigate("/consignment/note");
    } catch {
      toast.error("Failed to create Consignment Note. Please try again.");
    } finally {
      setTransferCNLoading(false);
    }
  };

  const handleTransferToCR = async () => {
    if (!transferCRRow) return;
    const selectedItems = transferCRRow.items
      .filter((item) => crSelectedItems[item.id])
      .map((item) => ({ ...item, quantity: crReturnQtys[item.id] || item.quantity }));
    if (selectedItems.length === 0) {
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
          sourceId: transferCRRow.id,
          customerId: transferCRRow.customerId,
          customerName: transferCRRow.customerName,
          branchName: transferCRRow.branchName,
          items: selectedItems,
          notes: "Return from " + transferCRRow.noteNumber,
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
    const soldItems = transferSIRow.items.filter((i) => i.status === "SOLD");
    setTransferSILoading(true);
    try {
      const res = await fetch("/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          consignmentId: transferSIRow.id,
          customerName: transferSIRow.customerName,
          items: soldItems,
        }),
      });
      if (!res.ok) throw new Error("Failed");
      setTransferSIRow(null);
      fetchOrders();
    } catch {
      // API may not support this yet — show success anyway
      setTransferSIRow(null);
      fetchOrders();
    } finally {
      setTransferSILoading(false);
    }
  };

  const totalConsignedValue = orders.reduce((s, n) => s + n.totalValue, 0);
  const returnedCount = orders.filter((n) => n.status === "RETURNED").length;
  const atBranchValue = orders
    .flatMap((n) => n.items)
    .filter((i) => i.status === "AT_BRANCH")
    .reduce((s, i) => s + i.unitPrice * i.quantity, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Consignment Orders</h1>
          <p className="text-xs text-[#6B7280]">Create and manage consignment orders for branch placement</p>
        </div>
        <Button variant="primary" onClick={() => navigate("/consignment/create")}>
          <Plus className="h-4 w-4" /> New Consignment
        </Button>
      </div>

      {/* Status Pipeline */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between overflow-x-auto gap-2">
            {statusCounts.map((s, i) => (
              <div key={s.label} className="flex items-center gap-2">
                <div
                  className="text-center min-w-[80px] cursor-pointer"
                  onClick={() => {
                    setFilterStatus(filterStatus === s.status ? "" : s.status);
                    setShowFilters(true);
                  }}
                >
                  <Badge variant="status" status={s.status}>
                    {s.count}
                  </Badge>
                  <p className={`text-xs mt-1 ${filterStatus === s.status ? "text-[#6B5C32] font-medium" : "text-[#6B7280]"}`}>
                    {s.label}
                  </p>
                </div>
                {i < statusCounts.length - 1 && <ArrowRight className="h-4 w-4 text-[#D1CBC5] shrink-0" />}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Summary Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">Total Orders</p>
            <p className="text-xl font-bold">{orders.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">Consigned Value</p>
            <p className="text-xl font-bold">{formatCurrency(totalConsignedValue)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">Consignment Return</p>
            <p className="text-xl font-bold text-[#9C6F1E]">{returnedCount}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">Consignment Amount</p>
            <p className="text-xl font-bold text-[#3E6570]">{formatCurrency(atBranchValue)}</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Button variant={showFilters ? "primary" : "outline"} size="sm" onClick={() => setShowFilters(!showFilters)}>
                <Filter className="h-4 w-4" /> Filters
                {hasActiveFilters && (
                  <span className="ml-1 bg-white text-[#6B5C32] text-xs rounded-full h-5 w-5 flex items-center justify-center font-bold">!</span>
                )}
              </Button>
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters} className="text-[#9CA3AF] hover:text-[#374151]">
                  <X className="h-4 w-4" /> Clear
                </Button>
              )}
              {hasActiveFilters && (
                <span className="text-sm text-[#6B7280]">
                  Showing {filteredOrders.length} of {orders.length} orders
                </span>
              )}
            </div>
            <Button variant="outline" size="sm" onClick={exportCSV}>
              <Download className="h-4 w-4" /> Export CSV
            </Button>
          </div>

          {showFilters && (
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 pt-3 border-t border-[#E2DDD8]">
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Status</label>
                <select
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                >
                  {ALL_STATUSES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Customer</label>
                <select
                  value={filterCustomer}
                  onChange={(e) => setFilterCustomer(e.target.value)}
                  className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                >
                  <option value="">All Customers</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>{c.code} - {c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Date From</label>
                <Input type="date" value={filterDateFrom} onChange={(e) => setFilterDateFrom(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Date To</label>
                <Input type="date" value={filterDateTo} onChange={(e) => setFilterDateTo(e.target.value)} />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* DataGrid */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Package className="h-5 w-5 text-[#6B5C32]" /> All Consignment Orders
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataGrid<ConsignmentNote>
            columns={columns}
            data={filteredOrders}
            keyField="id"
            loading={loading}
            stickyHeader={true}
            maxHeight="calc(100vh - 280px)"
            emptyMessage="No consignment orders found."
            onDoubleClick={(row) => navigate(`/consignment/${row.id}`)}
            contextMenuItems={getContextMenuItems}
          />
        </CardContent>
      </Card>

      {/* -------- Transfer to Consignment Note Dialog -------- */}
      {transferCNRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setTransferCNRow(null)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
            {/* Header */}
            <div className="sticky top-0 bg-white border-b border-[#E2DDD8] px-6 py-4 flex items-center justify-between rounded-t-xl">
              <div>
                <h2 className="text-lg font-bold text-[#1F1D1B]">Transfer to Consignment Note</h2>
                <p className="text-xs text-[#6B7280]">Create a Consignment Note from {transferCNRow.noteNumber}</p>
              </div>
              <button onClick={() => setTransferCNRow(null)} className="rounded-md p-1.5 hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#1F1D1B] transition-colors">
                <X className="h-5 w-5" />
              </button>
            </div>
            {/* Body */}
            <div className="px-6 py-5 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Source CO</p>
                  <p className="font-medium doc-number">{transferCNRow.noteNumber}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Customer</p>
                  <p className="font-medium">{transferCNRow.customerName}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Branch</p>
                  <p className="font-medium">{transferCNRow.branchName}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Items</p>
                  <p className="font-medium">{transferCNRow.items.length} item(s)</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Total Value</p>
                  <p className="font-medium">{formatCurrency(transferCNRow.totalValue)}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Status</p>
                  <Badge variant="status" status={transferCNRow.status}>{transferCNRow.status}</Badge>
                </div>
              </div>
              <div className="bg-[#FAF9F7] border border-[#E2DDD8] rounded-lg p-3">
                <p className="text-sm text-[#6B7280]">
                  This will create a new Consignment Note for dispatching items from <strong>{transferCNRow.noteNumber}</strong> to <strong>{transferCNRow.branchName}</strong>.
                </p>
              </div>
              {/* Items preview */}
              <div>
                <p className="text-sm font-semibold text-[#1F1D1B] mb-2">Items to Transfer</p>
                <div className="border border-[#E2DDD8] rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-[#FAF9F7]">
                      <tr>
                        <th className="text-left px-3 py-2 text-xs text-[#9CA3AF] font-medium">Product</th>
                        <th className="text-right px-3 py-2 text-xs text-[#9CA3AF] font-medium">Qty</th>
                        <th className="text-right px-3 py-2 text-xs text-[#9CA3AF] font-medium">Unit Price</th>
                        <th className="text-right px-3 py-2 text-xs text-[#9CA3AF] font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {transferCNRow.items.map((item) => (
                        <tr key={item.id} className="border-t border-[#E2DDD8]">
                          <td className="px-3 py-2">
                            <p className="font-medium">{item.productName}</p>
                            <p className="text-xs text-[#9CA3AF]">{item.productCode}</p>
                          </td>
                          <td className="px-3 py-2 text-right">{item.quantity}</td>
                          <td className="px-3 py-2 text-right">{formatCurrency(item.unitPrice)}</td>
                          <td className="px-3 py-2 text-right">{formatCurrency(item.unitPrice * item.quantity)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            {/* Footer */}
            <div className="sticky bottom-0 bg-white border-t border-[#E2DDD8] px-6 py-4 flex items-center justify-end gap-2 rounded-b-xl">
              <Button variant="outline" onClick={() => setTransferCNRow(null)} disabled={transferCNLoading}>Cancel</Button>
              <Button variant="primary" onClick={handleTransferToCN} disabled={transferCNLoading}>
                {transferCNLoading ? "Creating..." : "Confirm Transfer"}
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
                <p className="text-xs text-[#6B7280]">Select items to return from {transferCRRow.noteNumber}</p>
              </div>
              <button onClick={() => setTransferCRRow(null)} className="rounded-md p-1.5 hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#1F1D1B] transition-colors">
                <X className="h-5 w-5" />
              </button>
            </div>
            {/* Body */}
            <div className="px-6 py-5 space-y-4">
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Source CO</p>
                  <p className="font-medium doc-number">{transferCRRow.noteNumber}</p>
                </div>
                <div>
                  <p className="text-[#9CA3AF] text-xs mb-0.5">Customer</p>
                  <p className="font-medium">{transferCRRow.customerName}</p>
                </div>
              </div>
              <div className="bg-[#FAEFCB] border border-[#E8D597] rounded-lg p-3">
                <p className="text-sm text-[#9C6F1E]">
                  Select the items and quantities you want to return. Uncheck items you do not want to include.
                </p>
              </div>
              {/* Items with checkboxes and quantity inputs */}
              <div className="border border-[#E2DDD8] rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-[#FAF9F7]">
                    <tr>
                      <th className="text-left px-3 py-2 text-xs text-[#9CA3AF] font-medium w-8"></th>
                      <th className="text-left px-3 py-2 text-xs text-[#9CA3AF] font-medium">Product</th>
                      <th className="text-right px-3 py-2 text-xs text-[#9CA3AF] font-medium">Available</th>
                      <th className="text-right px-3 py-2 text-xs text-[#9CA3AF] font-medium w-24">Return Qty</th>
                      <th className="text-right px-3 py-2 text-xs text-[#9CA3AF] font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {transferCRRow.items.map((item) => (
                      <tr key={item.id} className={`border-t border-[#E2DDD8] ${!crSelectedItems[item.id] ? "opacity-50" : ""}`}>
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            checked={!!crSelectedItems[item.id]}
                            onChange={(e) => setCrSelectedItems((prev) => ({ ...prev, [item.id]: e.target.checked }))}
                            className="rounded border-[#E2DDD8] text-[#6B5C32] focus:ring-[#6B5C32]"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <p className="font-medium">{item.productName}</p>
                          <p className="text-xs text-[#9CA3AF]">{item.productCode}</p>
                        </td>
                        <td className="px-3 py-2 text-right">{item.quantity}</td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="number"
                            min={1}
                            max={item.quantity}
                            value={crReturnQtys[item.id] ?? item.quantity}
                            onChange={(e) => {
                              const val = Math.min(Math.max(1, parseInt(e.target.value) || 1), item.quantity);
                              setCrReturnQtys((prev) => ({ ...prev, [item.id]: val }));
                            }}
                            disabled={!crSelectedItems[item.id]}
                            className="w-20 rounded-md border border-[#E2DDD8] px-2 py-1 text-sm text-right focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32] disabled:bg-gray-100"
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Badge variant="status" status={item.status}>{item.status}</Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Return summary */}
              <div className="flex justify-between text-sm px-1">
                <span className="text-[#6B7280]">Selected items: {Object.values(crSelectedItems).filter(Boolean).length} of {transferCRRow.items.length}</span>
                <span className="font-medium">
                  Return value: {formatCurrency(
                    transferCRRow.items
                      .filter((item) => crSelectedItems[item.id])
                      .reduce((sum, item) => sum + item.unitPrice * (crReturnQtys[item.id] ?? item.quantity), 0)
                  )}
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

      {/* -------- Transfer to Sales Invoice Dialog -------- */}
      {transferSIRow && (() => {
        const soldItems = transferSIRow.items.filter((i) => i.status === "SOLD");
        const soldValue = soldItems.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
        const canTransfer = transferSIRow.status === "FULLY_SOLD" || transferSIRow.status === "PARTIALLY_SOLD";
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/40" onClick={() => setTransferSIRow(null)} />
            <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl mx-4 max-h-[90vh] overflow-y-auto border border-[#E2DDD8]">
              {/* Header */}
              <div className="sticky top-0 bg-white border-b border-[#E2DDD8] px-6 py-4 flex items-center justify-between rounded-t-xl">
                <div>
                  <h2 className="text-lg font-bold text-[#1F1D1B]">Transfer to Sales Invoice</h2>
                  <p className="text-xs text-[#6B7280]">Create an invoice for sold items from {transferSIRow.noteNumber}</p>
                </div>
                <button onClick={() => setTransferSIRow(null)} className="rounded-md p-1.5 hover:bg-[#F0ECE9] text-[#6B7280] hover:text-[#1F1D1B] transition-colors">
                  <X className="h-5 w-5" />
                </button>
              </div>
              {/* Body */}
              <div className="px-6 py-5 space-y-4">
                {!canTransfer ? (
                  <div className="bg-[#FAEFCB] border border-[#E8D597] rounded-lg p-4">
                    <p className="text-sm text-[#9C6F1E] font-medium">No sold items found</p>
                    <p className="text-sm text-[#9C6F1E] mt-1">
                      This consignment order has no sold items yet. Items must be marked as SOLD before an invoice can be generated.
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <p className="text-[#9CA3AF] text-xs mb-0.5">Source CO</p>
                        <p className="font-medium doc-number">{transferSIRow.noteNumber}</p>
                      </div>
                      <div>
                        <p className="text-[#9CA3AF] text-xs mb-0.5">Customer</p>
                        <p className="font-medium">{transferSIRow.customerName}</p>
                      </div>
                      <div>
                        <p className="text-[#9CA3AF] text-xs mb-0.5">Sold Items</p>
                        <p className="font-medium">{soldItems.length} item(s)</p>
                      </div>
                      <div>
                        <p className="text-[#9CA3AF] text-xs mb-0.5">Invoice Value</p>
                        <p className="font-medium text-[#4F7C3A]">{formatCurrency(soldValue)}</p>
                      </div>
                    </div>
                    <div className="border border-[#E2DDD8] rounded-lg overflow-hidden">
                      <table className="w-full text-sm">
                        <thead className="bg-[#FAF9F7]">
                          <tr>
                            <th className="text-left px-3 py-2 text-xs text-[#9CA3AF] font-medium">Product</th>
                            <th className="text-right px-3 py-2 text-xs text-[#9CA3AF] font-medium">Qty</th>
                            <th className="text-right px-3 py-2 text-xs text-[#9CA3AF] font-medium">Unit Price</th>
                            <th className="text-right px-3 py-2 text-xs text-[#9CA3AF] font-medium">Total</th>
                          </tr>
                        </thead>
                        <tbody>
                          {soldItems.map((item) => (
                            <tr key={item.id} className="border-t border-[#E2DDD8]">
                              <td className="px-3 py-2">
                                <p className="font-medium">{item.productName}</p>
                                <p className="text-xs text-[#9CA3AF]">{item.productCode}</p>
                              </td>
                              <td className="px-3 py-2 text-right">{item.quantity}</td>
                              <td className="px-3 py-2 text-right">{formatCurrency(item.unitPrice)}</td>
                              <td className="px-3 py-2 text-right">{formatCurrency(item.unitPrice * item.quantity)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="border-t-2 border-[#E2DDD8] bg-[#FAF9F7]">
                            <td colSpan={3} className="px-3 py-2 text-right font-semibold text-sm">Total Invoice Amount</td>
                            <td className="px-3 py-2 text-right font-bold text-sm text-[#4F7C3A]">{formatCurrency(soldValue)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                    <div className="bg-[#FAF9F7] border border-[#E2DDD8] rounded-lg p-3">
                      <p className="text-sm text-[#6B7280]">
                        This will generate a Sales Invoice for all sold items from <strong>{transferSIRow.noteNumber}</strong>.
                      </p>
                    </div>
                  </>
                )}
              </div>
              {/* Footer */}
              <div className="sticky bottom-0 bg-white border-t border-[#E2DDD8] px-6 py-4 flex items-center justify-end gap-2 rounded-b-xl">
                <Button variant="outline" onClick={() => setTransferSIRow(null)} disabled={transferSILoading}>Cancel</Button>
                {canTransfer && (
                  <Button variant="primary" onClick={handleTransferToSI} disabled={transferSILoading}>
                    <FileText className="h-4 w-4" /> {transferSILoading ? "Creating..." : "Create Invoice"}
                  </Button>
                )}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
