import { useState, useEffect, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataGrid } from "@/components/ui/data-grid";
import type { Column, ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency } from "@/lib/utils";
import type { Supplier, PurchaseOrder, SupplierMaterialBinding } from "@/lib/mock-data";
import {
  rawMaterials,
  supplierMaterialBindings,
  suppliers as allMockSuppliers,
} from "@/lib/mock-data";
import {
  Plus, ShoppingBag, Truck, Trash2, X, Package,
  FileText, Download, Filter, AlertTriangle,
  Eye, Pencil, Printer, RefreshCw, ArrowRight,
} from "lucide-react";
import { generatePurchaseOrderPdf } from "@/lib/generate-purchase-order-pdf";



// ============================================================
// PURCHASE ORDER FORM DIALOG (Material-Centric Flow)
// ============================================================

type POLineItem = {
  rmCode: string;            // internal RM itemCode from rawMaterials
  rmDescription: string;     // RM description
  supplierId: string;        // resolved supplier id
  supplierName: string;      // resolved supplier name
  supplierSku: string;       // supplier SKU from binding
  quantity: number;
  unitPriceSen: number;
  unit: string;              // baseUOM from rawMaterial
  leadTimeDays: number;
  moq: number;
  materialCategory: string;  // kept for PO payload compatibility
};

/** For a given RM code, return all supplier bindings. */
function getBindingsForRM(materialCode: string): SupplierMaterialBinding[] {
  return supplierMaterialBindings.filter((b) => b.materialCode === materialCode);
}

/** For a given RM code, return the main-supplier binding (or first available). */
function getMainBinding(materialCode: string): SupplierMaterialBinding | undefined {
  const bindings = getBindingsForRM(materialCode);
  return bindings.find((b) => b.isMainSupplier) ?? bindings[0];
}

/** Resolve supplier name from id. */
function resolveSupplierName(supplierId: string): string {
  const sup = allMockSuppliers.find((s) => s.id === supplierId);
  return sup ? `${sup.code} - ${sup.name}` : supplierId;
}

function POFormDialog({
  onSave,
  onClose,
}: {
  onSave: (data: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<POLineItem[]>([]);
  const [rmSearch, setRmSearch] = useState("");

  // Active raw materials for the RM selector dropdown
  const activeRMs = useMemo(
    () => rawMaterials.filter((rm) => rm.isActive),
    []
  );

  // Filtered RM list based on search input
  const filteredRMs = useMemo(() => {
    if (!rmSearch.trim()) return activeRMs;
    const q = rmSearch.toLowerCase();
    return activeRMs.filter(
      (rm) =>
        rm.itemCode.toLowerCase().includes(q) ||
        rm.description.toLowerCase().includes(q)
    );
  }, [activeRMs, rmSearch]);

  const addItemFromRM = (rmItemCode: string) => {
    const rm = rawMaterials.find((r) => r.itemCode === rmItemCode);
    if (!rm) return;

    const mainBinding = getMainBinding(rmItemCode);

    const newItem: POLineItem = {
      rmCode: rm.itemCode,
      rmDescription: rm.description,
      supplierId: mainBinding?.supplierId ?? "",
      supplierName: mainBinding ? resolveSupplierName(mainBinding.supplierId) : "(no supplier)",
      supplierSku: mainBinding?.supplierSku ?? "",
      quantity: mainBinding?.moq ?? 1,
      unitPriceSen: mainBinding?.unitPrice ?? 0,
      unit: rm.baseUOM,
      leadTimeDays: mainBinding?.leadTimeDays ?? 0,
      moq: mainBinding?.moq ?? 0,
      materialCategory: rm.itemGroup,
    };

    setItems((prev) => [...prev, newItem]);
    setRmSearch("");
  };

  const switchSupplier = (idx: number, supplierId: string) => {
    const item = items[idx];
    const binding = supplierMaterialBindings.find(
      (b) => b.materialCode === item.rmCode && b.supplierId === supplierId
    );
    if (!binding) return;

    const updated = [...items];
    updated[idx] = {
      ...updated[idx],
      supplierId: binding.supplierId,
      supplierName: resolveSupplierName(binding.supplierId),
      supplierSku: binding.supplierSku,
      unitPriceSen: binding.unitPrice,
      leadTimeDays: binding.leadTimeDays,
      moq: binding.moq,
    };
    setItems(updated);
  };

  const updateItemQty = (idx: number, qty: number) => {
    const updated = [...items];
    updated[idx] = { ...updated[idx], quantity: qty };
    setItems(updated);
  };

  const removeItem = (idx: number) => {
    setItems(items.filter((_, i) => i !== idx));
  };

  const subtotal = items.reduce((s, i) => s + i.quantity * i.unitPriceSen, 0);

  // Derive header supplier from first line item
  const headerSupplierId = items.length > 0 ? items[0].supplierId : "";
  const headerSupplierName = items.length > 0 ? items[0].supplierName : "";
  const hasMixedSuppliers = items.length > 1 && items.some((it) => it.supplierId !== items[0].supplierId);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (items.length === 0) return;
    if (!headerSupplierId) return;

    onSave({
      supplierId: headerSupplierId,
      supplierName: headerSupplierName,
      expectedDate,
      notes,
      items: items.map((it) => ({
        materialCategory: it.materialCategory,
        materialName: `${it.rmCode} - ${it.rmDescription}`,
        supplierSKU: it.supplierSku,
        quantity: it.quantity,
        unitPriceSen: it.unitPriceSen,
        unit: it.unit,
      })),
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-[#E2DDD8]">
          <div>
            <h2 className="text-lg font-semibold text-[#1F1D1B]">New Purchase Order</h2>
            <p className="text-xs text-[#6B7280] mt-0.5">Select materials first, suppliers are auto-assigned</p>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}><X className="h-4 w-4" /></Button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Header fields */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Supplier (from line items)</label>
              <div className="flex h-10 w-full items-center rounded-md border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2 text-sm text-[#374151]">
                {items.length === 0
                  ? "Add items to determine supplier"
                  : hasMixedSuppliers
                    ? "Mixed suppliers (multiple)"
                    : headerSupplierName || "(no supplier bound)"}
              </div>
              {hasMixedSuppliers && (
                <p className="text-xs text-[#9C6F1E] mt-1">Lines have different suppliers. The PO header will use the first line's supplier.</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Expected Date</label>
              <Input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
            </div>
            <div className="col-span-2">
              <label className="block text-sm font-medium text-[#374151] mb-1">Notes</label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Order notes..." />
            </div>
          </div>

          {/* Add item: RM code selector */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-[#374151]">Order Items</label>
            </div>

            {/* RM search + dropdown */}
            <div className="relative mb-3">
              <label className="block text-xs text-[#6B7280] mb-1">Add material by RM code</label>
              <Input
                className="h-9 text-sm"
                value={rmSearch}
                onChange={(e) => setRmSearch(e.target.value)}
                placeholder="Search by RM code or description..."
              />
              {rmSearch.trim() && filteredRMs.length > 0 && (
                <div className="absolute z-10 mt-1 w-full max-h-48 overflow-y-auto bg-white border border-[#E2DDD8] rounded-md shadow-lg">
                  {filteredRMs.slice(0, 20).map((rm) => (
                    <button
                      key={rm.id}
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-[#FAF9F7] border-b border-[#E2DDD8] last:border-b-0"
                      onClick={() => addItemFromRM(rm.itemCode)}
                    >
                      <span className="font-medium text-[#1F1D1B]">{rm.itemCode}</span>
                      <span className="text-[#6B7280] ml-2">{rm.description}</span>
                      <span className="text-[#9CA3AF] ml-2">({rm.baseUOM})</span>
                    </button>
                  ))}
                  {filteredRMs.length > 20 && (
                    <div className="px-3 py-2 text-xs text-[#9CA3AF]">
                      Showing 20 of {filteredRMs.length} results. Refine your search.
                    </div>
                  )}
                </div>
              )}
              {rmSearch.trim() && filteredRMs.length === 0 && (
                <div className="absolute z-10 mt-1 w-full bg-white border border-[#E2DDD8] rounded-md shadow-lg px-3 py-2 text-sm text-[#9CA3AF]">
                  No materials found
                </div>
              )}
            </div>

            {items.length > 0 && (
              <div className="space-y-2">
                {items.map((item, idx) => {
                  const bindings = getBindingsForRM(item.rmCode);
                  return (
                    <div key={idx} className="p-3 bg-[#FAF9F7] rounded border border-[#E2DDD8]">
                      {/* Row 1: RM code, description, supplier switcher */}
                      <div className="grid grid-cols-8 gap-2 items-end">
                        <div className="col-span-2">
                          <label className="block text-xs text-[#6B7280] mb-1">RM Code</label>
                          <div className="h-8 flex items-center px-2 text-xs font-medium text-[#1F1D1B] bg-white rounded border border-[#E2DDD8]">
                            {item.rmCode}
                          </div>
                        </div>
                        <div className="col-span-2">
                          <label className="block text-xs text-[#6B7280] mb-1">Description</label>
                          <div className="h-8 flex items-center px-2 text-xs text-[#374151] bg-white rounded border border-[#E2DDD8] truncate" title={item.rmDescription}>
                            {item.rmDescription}
                          </div>
                        </div>
                        <div className="col-span-2">
                          <label className="block text-xs text-[#6B7280] mb-1">Supplier</label>
                          {bindings.length > 0 ? (
                            <select
                              className="flex h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-xs"
                              value={item.supplierId}
                              onChange={(e) => switchSupplier(idx, e.target.value)}
                            >
                              {bindings.map((b) => (
                                <option key={b.id} value={b.supplierId}>
                                  {resolveSupplierName(b.supplierId)}{b.isMainSupplier ? " (main)" : ""}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <div className="h-8 flex items-center px-2 text-xs text-[#9CA3AF] bg-white rounded border border-[#E2DDD8]">
                              No supplier bound
                            </div>
                          )}
                        </div>
                        <div>
                          <label className="block text-xs text-[#6B7280] mb-1">Supplier SKU</label>
                          <div className="h-8 flex items-center px-2 text-xs text-[#374151] bg-white rounded border border-[#E2DDD8] truncate" title={item.supplierSku}>
                            {item.supplierSku || "-"}
                          </div>
                        </div>
                        <div className="flex justify-end">
                          <Button type="button" variant="ghost" size="sm" className="h-8 text-[#9A3A2D] hover:text-[#7A2E24]" onClick={() => removeItem(idx)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                      {/* Row 2: Qty, Unit Price, Unit, Lead Time, Line Total */}
                      <div className="grid grid-cols-8 gap-2 items-end mt-2">
                        <div>
                          <label className="block text-xs text-[#6B7280] mb-1">Qty</label>
                          <Input className="h-8 text-xs" type="number" min={0} value={item.quantity} onChange={(e) => updateItemQty(idx, Number(e.target.value))} />
                        </div>
                        <div>
                          <label className="block text-xs text-[#6B7280] mb-1">Price (sen)</label>
                          <div className="h-8 flex items-center px-2 text-xs text-[#374151] bg-white rounded border border-[#E2DDD8]">
                            {item.unitPriceSen}
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs text-[#6B7280] mb-1">Unit</label>
                          <div className="h-8 flex items-center px-2 text-xs text-[#374151] bg-white rounded border border-[#E2DDD8]">
                            {item.unit}
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs text-[#6B7280] mb-1">Lead (days)</label>
                          <div className="h-8 flex items-center px-2 text-xs text-[#374151] bg-white rounded border border-[#E2DDD8]">
                            {item.leadTimeDays}
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs text-[#6B7280] mb-1">MOQ</label>
                          <div className="h-8 flex items-center px-2 text-xs text-[#374151] bg-white rounded border border-[#E2DDD8]">
                            {item.moq}
                          </div>
                        </div>
                        <div className="col-span-3 flex items-end justify-end">
                          <span className="text-xs font-medium text-[#1F1D1B]">
                            Line total: {formatCurrency(item.quantity * item.unitPriceSen)}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div className="text-right text-sm font-semibold text-[#1F1D1B] pr-2">
                  Total: {formatCurrency(subtotal)}
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-3 pt-4 border-t border-[#E2DDD8]">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={items.length === 0}>Create PO</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// PO STATUS OPTIONS
// ============================================================
const ALL_PO_STATUSES = [
  { value: "", label: "All Statuses" },
  { value: "DRAFT", label: "Draft" },
  { value: "SUBMITTED", label: "Submitted" },
  { value: "CONFIRMED", label: "Confirmed" },
  { value: "PARTIAL_RECEIVED", label: "Partial Received" },
  { value: "RECEIVED", label: "Received" },
  { value: "CANCELLED", label: "Cancelled" },
];

// ============================================================
// MAIN PROCUREMENT PAGE
// ============================================================
export default function ProcurementPage() {
  useToast();
  const navigate = useNavigate();
  const [, setSuppliers] = useState<Supplier[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrder[]>([]);
  const [loading, setLoading] = useState(true);

  // Dialog
  const [showPOForm, setShowPOForm] = useState(false);

  // Filters
  const [filterStatus, setFilterStatus] = useState("");
  const [filterSupplier, setFilterSupplier] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [supRes, poRes] = await Promise.all([
        fetch("/api/suppliers"),
        fetch("/api/purchase-orders"),
      ]);
      const supData = await supRes.json();
      const poData = await poRes.json();
      if (supData.success) setSuppliers(supData.data);
      if (poData.success) setPurchaseOrders(poData.data);
    } catch (err) {
      console.error("Failed to fetch data:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // ---- PO CRUD ----
  const handleCreatePO = async (data: Record<string, unknown>) => {
    try {
      await fetch("/api/purchase-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      setShowPOForm(false);
      fetchData();
    } catch (err) {
      console.error("Failed to create PO:", err);
    }
  };


  // ---- Filters ----
  const hasActiveFilters = filterStatus || filterSupplier || filterDateFrom || filterDateTo;

  const clearFilters = () => {
    setFilterStatus("");
    setFilterSupplier("");
    setFilterDateFrom("");
    setFilterDateTo("");
  };

  const filteredOrders = useMemo(() => {
    return purchaseOrders.filter(po => {
      if (filterStatus && po.status !== filterStatus) return false;
      if (filterSupplier && po.supplierId !== filterSupplier) return false;
      if (filterDateFrom) {
        const orderDate = po.orderDate?.split("T")[0] ?? "";
        if (orderDate < filterDateFrom) return false;
      }
      if (filterDateTo) {
        const orderDate = po.orderDate?.split("T")[0] ?? "";
        if (orderDate > filterDateTo) return false;
      }
      return true;
    });
  }, [purchaseOrders, filterStatus, filterSupplier, filterDateFrom, filterDateTo]);

  // ---- Export CSV ----
  const exportCSV = () => {
    const headers = [
      "PO No.", "Supplier", "Order Date", "Expected Date",
      "Items", "Total (RM)", "Status",
    ];
    const rows = filteredOrders.map(po => [
      po.poNo,
      po.supplierName,
      po.orderDate?.split("T")[0] ?? "",
      po.expectedDate?.split("T")[0] ?? "",
      po.items.length.toString(),
      (po.totalSen / 100).toFixed(2),
      po.status,
    ]);

    const csvContent = [headers, ...rows]
      .map(row => row.map(cell => `"${cell.replace(/"/g, '""')}"`).join(","))
      .join("\n");

    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `purchase-orders-${new Date().toISOString().split("T")[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // ---- Summary stats ----
  const today = new Date().toISOString().split("T")[0];
  const pendingDelivery = purchaseOrders.filter((po) => ["SUBMITTED", "CONFIRMED"].includes(po.status)).length;
  const overduePOs = purchaseOrders.filter((po) =>
    ["SUBMITTED", "CONFIRMED", "PARTIAL_RECEIVED"].includes(po.status) &&
    po.expectedDate && po.expectedDate < today
  ).length;
  const totalOutstandingQty = purchaseOrders
    .filter((po) => !["RECEIVED", "CANCELLED"].includes(po.status))
    .reduce((sum, po) => sum + po.items.reduce((s, it) => s + Math.max(0, it.quantity - (it.receivedQty || 0)), 0), 0);

  // ---- Status pipeline counts ----
  const statusCounts = [
    { label: "Draft", status: "DRAFT", count: purchaseOrders.filter(po => po.status === "DRAFT").length },
    { label: "Submitted", status: "SUBMITTED", count: purchaseOrders.filter(po => po.status === "SUBMITTED").length },
    { label: "Confirmed", status: "CONFIRMED", count: purchaseOrders.filter(po => po.status === "CONFIRMED").length },
    { label: "Partial Received", status: "PARTIAL_RECEIVED", count: purchaseOrders.filter(po => po.status === "PARTIAL_RECEIVED").length },
    { label: "Received", status: "RECEIVED", count: purchaseOrders.filter(po => po.status === "RECEIVED").length },
  ];

  // ---- Unique suppliers for filter dropdown ----
  const uniqueSuppliers = useMemo(() => {
    const map = new Map<string, string>();
    for (const po of purchaseOrders) {
      if (po.supplierId && po.supplierName) {
        map.set(po.supplierId, po.supplierName);
      }
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [purchaseOrders]);

  // ---- Columns ----
  const poGridColumns: Column<PurchaseOrder>[] = useMemo(() => [
    { key: "poNo", label: "PO No", type: "docno", width: "120px", sortable: true },
    { key: "supplierName", label: "Supplier", type: "text", sortable: true },
    { key: "orderDate", label: "Order Date", type: "date", width: "110px", sortable: true },
    { key: "expectedDate", label: "Expected Date", type: "date", width: "110px", sortable: true },
    { key: "items.length", label: "Items", type: "number", width: "70px", align: "right", sortable: true,
      render: (_v: unknown, row: PurchaseOrder) => <span>{row.items.length}</span>,
    },
    {
      key: "orderedQty" as any,
      label: "Ordered",
      type: "number",
      width: "80px",
      align: "right" as const,
      sortable: true,
      render: (_v: unknown, row: PurchaseOrder) => {
        const total = row.items.reduce((s, it) => s + it.quantity, 0);
        return <span>{total}</span>;
      },
    },
    {
      key: "outstandingQty" as any,
      label: "Outstanding",
      type: "number",
      width: "95px",
      align: "right" as const,
      sortable: true,
      render: (_v: unknown, row: PurchaseOrder) => {
        if (row.status === "RECEIVED" || row.status === "CANCELLED") {
          return <span className="text-[#9CA3AF]">—</span>;
        }
        const outstanding = row.items.reduce((s, it) => s + Math.max(0, it.quantity - (it.receivedQty || 0)), 0);
        if (outstanding > 0) {
          return <span className="font-semibold text-[#9C6F1E]">{outstanding}</span>;
        }
        return <span className="text-[#4F7C3A]">0</span>;
      },
    },
    { key: "totalSen", label: "Total", type: "currency", width: "120px", sortable: true },
    { key: "status", label: "Status", type: "status", width: "120px", sortable: true },
  ], []);

  const poGridContextMenu = useCallback((row: PurchaseOrder): ContextMenuItem[] => {
    return [
      {
        label: "View",
        icon: <Eye className="h-3.5 w-3.5" />,
        action: () => navigate(`/procurement/${row.id}`),
      },
      {
        label: "Edit",
        icon: <Pencil className="h-3.5 w-3.5" />,
        action: () => navigate(`/procurement/${row.id}`),
        disabled: row.status !== "DRAFT",
      },
      { label: "", separator: true, action: () => {} },
      {
        label: "Print / Preview",
        icon: <Printer className="h-3.5 w-3.5" />,
        action: () => generatePurchaseOrderPdf(row),
      },
      { label: "", separator: true, action: () => {} },
      {
        label: "Refresh",
        icon: <RefreshCw className="h-3.5 w-3.5" />,
        action: () => fetchData(),
      },
    ];
  }, [navigate, fetchData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#6B5C32]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[#1F1D1B]">Purchase Orders</h1>
          <p className="text-sm text-[#6B7280]">Create and manage purchase orders using internal material codes</p>
        </div>
        <Button variant="primary" onClick={() => setShowPOForm(true)}>
          <Plus className="h-4 w-4" /> New Purchase Order
        </Button>
      </div>

      {/* Status Pipeline */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between overflow-x-auto gap-3">
            {statusCounts.map((s, i) => (
              <div key={s.label} className="flex items-center gap-3">
                <div
                  className="text-center min-w-[100px] cursor-pointer py-1"
                  onClick={() => { setFilterStatus(filterStatus === s.status ? "" : s.status); setShowFilters(true); }}
                >
                  <div className="text-2xl font-bold mb-1">
                    <Badge variant="status" status={s.status} className="text-base px-3 py-1">{s.count}</Badge>
                  </div>
                  <p className={`text-sm mt-1 ${filterStatus === s.status ? "text-[#6B5C32] font-semibold" : "text-[#6B7280]"}`}>{s.label}</p>
                </div>
                {i < statusCounts.length - 1 && <ArrowRight className="h-5 w-5 text-[#D1CBC5] shrink-0" />}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Summary Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-[#6B7280]">Total POs</p>
              <p className="text-2xl font-bold text-[#1F1D1B]">{purchaseOrders.length}</p>
            </div>
            <FileText className="h-5 w-5 text-[#6B5C32]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-[#6B7280]">Pending Delivery</p>
              <p className="text-2xl font-bold text-[#1F1D1B]">{pendingDelivery}</p>
            </div>
            <Truck className="h-5 w-5 text-[#3E6570]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-[#6B7280]">Overdue</p>
              <p className={`text-2xl font-bold ${overduePOs > 0 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>
                {overduePOs}
              </p>
            </div>
            <AlertTriangle className={`h-5 w-5 ${overduePOs > 0 ? "text-[#9A3A2D]" : "text-[#E2DDD8]"}`} />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-[#6B7280]">Outstanding Qty</p>
              <p className={`text-2xl font-bold ${totalOutstandingQty > 0 ? "text-[#9C6F1E]" : "text-[#1F1D1B]"}`}>{totalOutstandingQty}</p>
            </div>
            <Package className="h-5 w-5 text-[#9C6F1E]" />
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Button
                variant={showFilters ? "primary" : "outline"}
                size="sm"
                onClick={() => setShowFilters(!showFilters)}
              >
                <Filter className="h-4 w-4" /> Filters
                {hasActiveFilters && <span className="ml-1 bg-white text-[#6B5C32] text-xs rounded-full h-5 w-5 flex items-center justify-center font-bold">!</span>}
              </Button>
              {hasActiveFilters && (
                <Button variant="ghost" size="sm" onClick={clearFilters} className="text-[#9CA3AF] hover:text-[#374151]">
                  <X className="h-4 w-4" /> Clear
                </Button>
              )}
              {hasActiveFilters && (
                <span className="text-sm text-[#6B7280]">
                  Showing {filteredOrders.length} of {purchaseOrders.length} orders
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
                  {ALL_PO_STATUSES.map(s => (
                    <option key={s.value} value={s.value}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Supplier</label>
                <select
                  value={filterSupplier}
                  onChange={(e) => setFilterSupplier(e.target.value)}
                  className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                >
                  <option value="">All Suppliers</option>
                  {uniqueSuppliers.map(([id, name]) => (
                    <option key={id} value={id}>{name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Date From</label>
                <Input
                  type="date"
                  value={filterDateFrom}
                  onChange={(e) => setFilterDateFrom(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Date To</label>
                <Input
                  type="date"
                  value={filterDateTo}
                  onChange={(e) => setFilterDateTo(e.target.value)}
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Purchase Orders */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <ShoppingBag className="h-5 w-5 text-[#6B5C32]" />
            Purchase Orders
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataGrid<PurchaseOrder>
            columns={poGridColumns}
            data={filteredOrders}
            keyField="id"
            loading={loading}
            stickyHeader={true}
            onDoubleClick={(row) => navigate(`/procurement/${row.id}`)}
            contextMenuItems={poGridContextMenu}
            maxHeight="calc(100vh - 300px)"
            emptyMessage="No purchase orders found."
          />
        </CardContent>
      </Card>

      {/* PO Form Dialog */}
      {showPOForm && (
        <POFormDialog
          onSave={handleCreatePO}
          onClose={() => setShowPOForm(false)}
        />
      )}

    </div>
  );
}
