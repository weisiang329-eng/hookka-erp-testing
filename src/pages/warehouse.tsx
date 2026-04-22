import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Warehouse, Grid3X3, Package, MapPin, LayoutGrid,
  ArrowDownToLine, ArrowUpFromLine, History, X, ArrowRightLeft,
  Loader2, RefreshCw,
} from "lucide-react";

// ---------- Types ----------
// A rack can hold any number of items — no limit (per user request
// "正常一个 rack 都可以放好几样东西的 暂时不需要 set limitation").
type RackItem = {
  productionOrderId?: string;
  productCode: string;
  productName?: string;
  sizeLabel?: string;
  customerName?: string;
  qty?: number;
  stockedInDate?: string;
  notes?: string;
};

type RackLocation = {
  id: string;
  rack: string;
  position: string;
  items: RackItem[];
  reserved?: boolean;
  status: "OCCUPIED" | "EMPTY" | "RESERVED"; // derived on the server
};

type StockMovement = {
  id: string;
  type: "STOCK_IN" | "STOCK_OUT" | "TRANSFER";
  rackLocationId: string;
  rackLabel: string;
  productionOrderId?: string;
  productCode: string;
  productName: string;
  quantity: number;
  reason: string;
  performedBy: string;
  createdAt: string;
};

type ProductionOrder = {
  id: string;
  poNo: string;
  productCode: string;
  productName: string;
  sizeLabel: string;
  customerName: string;
  quantity: number;
  status: string;
  stockedIn: boolean;
  rackingNumber: string;
};

type Summary = {
  total: number;
  occupied: number;
  empty: number;
  reserved: number;
  occupancyRate: number;
};

// ---------- Constants ----------
// Flat rack layout — "Rack 1" … "Rack 20", no A/B/C sub-columns.
const RACKS = Array.from({ length: 20 }, (_, i) => `Rack ${i + 1}`);

const TABS = [
  { key: "grid", label: "Rack Overview", icon: Grid3X3 },
  { key: "stockio", label: "Stock In/Out", icon: ArrowRightLeft },
  { key: "history", label: "Movement History", icon: History },
] as const;
type TabKey = typeof TABS[number]["key"];

// ---------- Component ----------
export default function WarehousePage() {
  const [activeTab, setActiveTab] = useState<TabKey>("grid");
  const [rackLocations, setRackLocations] = useState<RackLocation[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [productionOrders, setProductionOrders] = useState<ProductionOrder[]>([]);
  const [summary, setSummary] = useState<Summary>({ total: 0, occupied: 0, empty: 0, reserved: 0, occupancyRate: 0 });
  const [loading, setLoading] = useState(true);

  // Popup / modals
  const [selectedSlot, setSelectedSlot] = useState<RackLocation | null>(null);
  const [showStockInForm, setShowStockInForm] = useState(false);
  const [stockInTarget, setStockInTarget] = useState<string>(""); // rackLocationId
  const [stockOutTarget, setStockOutTarget] = useState<RackLocation | null>(null);
  const [stockOutItemIndex, setStockOutItemIndex] = useState<number>(0);
  const [stockOutReason, setStockOutReason] = useState("");

  // Stock In form fields
  const [selectedPO, setSelectedPO] = useState("");
  const [stockInNote, setStockInNote] = useState("");

  // History filters
  const [historyType, setHistoryType] = useState<string>("");
  const [historyFrom, setHistoryFrom] = useState("");
  const [historyTo, setHistoryTo] = useState("");

  const [actionLoading, setActionLoading] = useState(false);

  // ---------- Data Fetching ----------
  const fetchRackLocations = useCallback(async () => {
    try {
      const res = await fetch("/api/warehouse");
      const json = await res.json();
      if (json.success) {
        setRackLocations(json.data);
        setSummary(json.summary);
      }
    } catch (e) {
      console.error("Failed to fetch rack locations", e);
    }
  }, []);

  const fetchMovements = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (historyType) params.set("type", historyType);
      if (historyFrom) params.set("from", historyFrom);
      if (historyTo) params.set("to", historyTo);
      const res = await fetch(`/api/warehouse/movements?${params.toString()}`);
      const json = await res.json();
      if (json.success) setMovements(json.data);
    } catch (e) {
      console.error("Failed to fetch movements", e);
    }
  }, [historyType, historyFrom, historyTo]);

  const fetchProductionOrders = useCallback(async () => {
    try {
      const res = await fetch("/api/production-orders");
      const json = await res.json();
      if (json.success) {
        setProductionOrders(json.data);
      }
    } catch (e) {
      console.error("Failed to fetch production orders", e);
    }
  }, []);

  useEffect(() => {
    Promise.all([fetchRackLocations(), fetchMovements(), fetchProductionOrders()]).then(() => setLoading(false));
  }, [fetchRackLocations, fetchMovements, fetchProductionOrders]);

  // Re-fetch movements when history filters change
  useEffect(() => {
    if (!loading) fetchMovements();
  }, [historyType, historyFrom, historyTo]);

  // ---------- Actions ----------
  const handleStockIn = async () => {
    if (!stockInTarget || !selectedPO) return;
    setActionLoading(true);
    try {
      const po = productionOrders.find((p) => p.id === selectedPO);
      if (!po) return;

      // 1. Assign rack location
      await fetch("/api/warehouse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rackLocationId: stockInTarget,
          productionOrderId: po.id,
          productCode: po.productCode,
          productName: po.productName,
          sizeLabel: po.sizeLabel,
          customerName: po.customerName,
          notes: stockInNote,
        }),
      });

      // 2. Record stock movement
      await fetch("/api/warehouse/movements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "STOCK_IN",
          rackLocationId: stockInTarget,
          rackLabel: stockInTarget,
          productionOrderId: po.id,
          productCode: po.productCode,
          productName: `${po.productName} ${po.sizeLabel}`,
          quantity: po.quantity,
          reason: `Production completed - stocked in from ${po.poNo}`,
          performedBy: "Warehouse Staff",
        }),
      });

      // 3. Update production order stockedIn status
      await fetch(`/api/production-orders/${po.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rackingNumber: stockInTarget,
          stockedIn: true,
        }),
      });

      // Refresh data
      await Promise.all([fetchRackLocations(), fetchMovements(), fetchProductionOrders()]);
      setShowStockInForm(false);
      setStockInTarget("");
      setSelectedPO("");
      setStockInNote("");
    } catch (e) {
      console.error("Stock in failed", e);
    } finally {
      setActionLoading(false);
    }
  };

  const handleStockOut = async () => {
    if (!stockOutTarget) return;
    const item = stockOutTarget.items[stockOutItemIndex];
    if (!item) return;
    setActionLoading(true);
    try {
      // 1. Record stock movement for the specific item being removed.
      await fetch("/api/warehouse/movements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "STOCK_OUT",
          rackLocationId: stockOutTarget.id,
          rackLabel: stockOutTarget.id,
          productionOrderId: item.productionOrderId || "",
          productCode: item.productCode || "",
          productName: `${item.productName || ""} ${item.sizeLabel || ""}`.trim(),
          quantity: item.qty ?? 1,
          reason: stockOutReason || "Stock out",
          performedBy: "Warehouse Staff",
        }),
      });

      // 2. Remove only the selected item from the rack (by productCode).
      await fetch(
        `/api/warehouse/${stockOutTarget.id}?productCode=${encodeURIComponent(item.productCode)}`,
        { method: "DELETE" }
      );

      // Refresh data
      await Promise.all([fetchRackLocations(), fetchMovements()]);
      setStockOutTarget(null);
      setStockOutItemIndex(0);
      setStockOutReason("");
    } catch (e) {
      console.error("Stock out failed", e);
    } finally {
      setActionLoading(false);
    }
  };

  // Completed POs that are not yet stocked in
  const availablePOs = productionOrders.filter(
    (po) => po.status === "COMPLETED" && !po.stockedIn
  );

  // Racks available for stock-in: anything not explicitly reserved. Since
  // racks can hold multiple items, occupied racks are still valid targets.
  const stockInEligibleRacks = rackLocations.filter((l) => l.status !== "RESERVED");

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-[#6B5C32]" />
        <span className="ml-2 text-[#6B7280]">Loading warehouse data...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Warehouse</h1>
          <p className="text-xs text-[#6B7280]">Rack location management, stock-in/out tracking</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { fetchRackLocations(); fetchMovements(); }}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 grid-cols-2 sm:grid-cols-5">
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Total Slots</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{summary.total}</p>
            </div>
            <Grid3X3 className="h-5 w-5 text-[#6B5C32]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Occupied</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{summary.occupied}</p>
            </div>
            <Package className="h-5 w-5 text-[#3E6570]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Empty</p>
              <p className="text-xl font-bold text-[#4F7C3A]">{summary.empty}</p>
            </div>
            <MapPin className="h-5 w-5 text-[#4F7C3A]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Reserved</p>
              <p className="text-xl font-bold text-[#9C6F1E]">{summary.reserved}</p>
            </div>
            <LayoutGrid className="h-5 w-5 text-[#9C6F1E]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Occupancy</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{summary.occupancyRate}%</p>
            </div>
            <Warehouse className="h-5 w-5 text-[#6B5C32]" />
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[#E2DDD8]">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors cursor-pointer ${
                isActive
                  ? "border-[#6B5C32] text-[#6B5C32]"
                  : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* ===== TAB 1: Rack Overview ===== */}
      {activeTab === "grid" && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <Warehouse className="h-5 w-5 text-[#6B5C32]" />
              Rack Grid Layout
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {/* Legend */}
              <div className="flex items-center gap-4 text-xs text-[#6B7280]">
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded bg-[#6B5C32]" />
                  <span>Occupied ({summary.occupied})</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded bg-[#EEF3E4] border border-[#C6DBA8]" />
                  <span>Empty ({summary.empty})</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded bg-[#FAEFCB] border border-[#E8D597]" />
                  <span>Reserved ({summary.reserved})</span>
                </div>
              </div>

              {/* Grid — flat list of 20 racks, 5 per row. Each rack can show
                  multiple items; if more than 3 items we show the first 3 and
                  a "+N more" indicator. Card height auto-grows. */}
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-3 items-start">
                {RACKS.map((rackName) => {
                  const slot = rackLocations.find((s) => s.rack === rackName);
                  if (!slot) return null;

                  const bgColor =
                    slot.status === "OCCUPIED"
                      ? "bg-[#6B5C32] text-white"
                      : slot.status === "RESERVED"
                      ? "bg-[#FAEFCB] border border-[#E8D597] text-[#9C6F1E]"
                      : "bg-[#EEF3E4] border border-[#C6DBA8] text-[#4F7C3A]";

                  const VISIBLE = 3;
                  const slotItems = slot.items || [];
                  const visibleItems = slotItems.slice(0, VISIBLE);
                  const extraCount = Math.max(0, slotItems.length - VISIBLE);

                  return (
                    <div
                      key={slot.id}
                      className={`rounded-md p-3 cursor-pointer hover:opacity-80 transition-opacity min-h-[72px] ${bgColor}`}
                      onClick={() => {
                        if (slot.status === "OCCUPIED") {
                          setSelectedSlot(slot);
                        } else if (slot.status === "EMPTY") {
                          setStockInTarget(slot.id);
                          setShowStockInForm(true);
                          setActiveTab("stockio");
                        }
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold">{slot.rack}</p>
                        {slot.status === "OCCUPIED" && (
                          <span className="text-[10px] opacity-80">
                            {slotItems.length} item{slotItems.length > 1 ? "s" : ""}
                          </span>
                        )}
                      </div>
                      {slot.status === "OCCUPIED" && (
                        <div className="mt-1 space-y-0.5">
                          {visibleItems.map((it, i) => (
                            <div key={i} className="leading-tight">
                              <p className="text-[11px] truncate opacity-95">{it.productCode}</p>
                              {it.customerName && (
                                <p className="text-[10px] truncate opacity-75">{it.customerName}</p>
                              )}
                            </div>
                          ))}
                          {extraCount > 0 && (
                            <p className="text-[10px] opacity-80 pt-0.5">+{extraCount} more</p>
                          )}
                        </div>
                      )}
                      {slot.status === "RESERVED" && (
                        <p className="text-[11px] mt-0.5">Reserved</p>
                      )}
                      {slot.status === "EMPTY" && (
                        <p className="text-[11px] mt-0.5">Empty</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ===== Occupied Slot Detail Popup ===== */}
      {selectedSlot && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setSelectedSlot(null)}>
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full p-6 max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-[#1F1D1B]">{selectedSlot.rack}</h3>
              <button onClick={() => setSelectedSlot(null)} className="text-[#6B7280] hover:text-[#1F1D1B] cursor-pointer">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-[#6B7280]">Status</span>
                <Badge>{selectedSlot.status}</Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-[#6B7280]">Items on this rack</span>
                <span className="font-medium text-[#1F1D1B]">{selectedSlot.items.length}</span>
              </div>
              {/* Full list of items */}
              <div className="space-y-2 pt-2 border-t border-[#E2DDD8]">
                {selectedSlot.items.map((it, i) => (
                  <div key={i} className="rounded-md border border-[#E2DDD8] p-3 space-y-0.5 bg-[#FAF9F7]">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-[#1F1D1B]">{it.productCode}</span>
                      {typeof it.qty === "number" && (
                        <span className="text-xs text-[#6B7280]">Qty: {it.qty}</span>
                      )}
                    </div>
                    {it.productName && <p className="text-xs text-[#4B5563]">{it.productName}{it.sizeLabel ? ` - ${it.sizeLabel}` : ""}</p>}
                    {it.customerName && <p className="text-xs text-[#6B7280]">Customer: {it.customerName}</p>}
                    {it.stockedInDate && <p className="text-xs text-[#6B7280]">Stocked In: {it.stockedInDate}</p>}
                    {it.notes && <p className="text-xs text-[#6B7280]">Notes: {it.notes}</p>}
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-6 flex gap-2 justify-end">
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setStockOutTarget(selectedSlot);
                  setSelectedSlot(null);
                  setActiveTab("stockio");
                }}
              >
                <ArrowUpFromLine className="h-4 w-4" /> Stock Out
              </Button>
              <Button variant="outline" size="sm" onClick={() => setSelectedSlot(null)}>
                Close
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ===== TAB 2: Stock In/Out ===== */}
      {activeTab === "stockio" && (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Stock In Form */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-[#4F7C3A]">
                <ArrowDownToLine className="h-5 w-5" />
                Stock In
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {availablePOs.length === 0 && !showStockInForm ? (
                <p className="text-xs text-[#6B7280]">No completed production orders available for stocking in.</p>
              ) : (
                <>
                  <div>
                    <label className="block text-sm font-medium text-[#374151] mb-1">Production Order</label>
                    <select
                      className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                      value={selectedPO}
                      onChange={(e) => setSelectedPO(e.target.value)}
                    >
                      <option value="">Select a completed PO...</option>
                      {availablePOs.map((po) => (
                        <option key={po.id} value={po.id}>
                          {po.poNo} - {po.productName} {po.sizeLabel} ({po.customerName})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-[#374151] mb-1">Rack Position</label>
                    <select
                      className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                      value={stockInTarget}
                      onChange={(e) => setStockInTarget(e.target.value)}
                    >
                      <option value="">Select rack...</option>
                      {stockInEligibleRacks.map((slot) => (
                        <option key={slot.id} value={slot.id}>
                          {slot.id} ({(slot.items || []).length} item{(slot.items || []).length === 1 ? "" : "s"})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-[#374151] mb-1">Notes (optional)</label>
                    <input
                      type="text"
                      className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                      value={stockInNote}
                      onChange={(e) => setStockInNote(e.target.value)}
                      placeholder="Additional notes..."
                    />
                  </div>
                  {selectedPO && (
                    <div className="bg-[#F0ECE9] rounded-md p-3 text-sm">
                      <p className="font-medium text-[#1F1D1B]">Selected PO Details:</p>
                      {(() => {
                        const po = productionOrders.find((p) => p.id === selectedPO);
                        if (!po) return null;
                        return (
                          <div className="mt-1 space-y-0.5 text-[#4B5563]">
                            <p>PO: {po.poNo}</p>
                            <p>Product: {po.productName} - {po.sizeLabel}</p>
                            <p>Customer: {po.customerName}</p>
                            <p>Qty: {po.quantity}</p>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                  <Button
                    variant="primary"
                    className="w-full"
                    disabled={!selectedPO || !stockInTarget || actionLoading}
                    onClick={handleStockIn}
                  >
                    {actionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowDownToLine className="h-4 w-4" />}
                    Confirm Stock In
                  </Button>
                </>
              )}
            </CardContent>
          </Card>

          {/* Stock Out Form */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-[#9A3A2D]">
                <ArrowUpFromLine className="h-5 w-5" />
                Stock Out
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1">Select Occupied Rack</label>
                <select
                  className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  value={stockOutTarget?.id || ""}
                  onChange={(e) => {
                    const loc = rackLocations.find((l) => l.id === e.target.value);
                    setStockOutTarget(loc || null);
                    setStockOutItemIndex(0);
                  }}
                >
                  <option value="">Select an occupied rack...</option>
                  {rackLocations
                    .filter((l) => l.status === "OCCUPIED")
                    .map((loc) => (
                      <option key={loc.id} value={loc.id}>
                        {loc.id} ({loc.items.length} item{loc.items.length === 1 ? "" : "s"})
                      </option>
                    ))}
                </select>
              </div>
              {stockOutTarget && stockOutTarget.items.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-[#374151] mb-1">Select Item to Remove</label>
                  <select
                    className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                    value={stockOutItemIndex}
                    onChange={(e) => setStockOutItemIndex(Number(e.target.value))}
                  >
                    {stockOutTarget.items.map((it, i) => (
                      <option key={i} value={i}>
                        {it.productCode} - {it.productName || ""} {it.sizeLabel || ""} ({it.customerName || "-"})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {stockOutTarget && stockOutTarget.items[stockOutItemIndex] && (
                <div className="bg-[#F9E1DA] rounded-md p-3 text-sm border border-[#E8B2A1]">
                  <p className="font-medium text-[#9A3A2D]">Item to be released:</p>
                  <div className="mt-1 space-y-0.5 text-[#9A3A2D]">
                    <p>Rack: {stockOutTarget.id}</p>
                    <p>Product: {stockOutTarget.items[stockOutItemIndex].productName} - {stockOutTarget.items[stockOutItemIndex].sizeLabel}</p>
                    <p>Customer: {stockOutTarget.items[stockOutItemIndex].customerName}</p>
                    <p>Stocked In: {stockOutTarget.items[stockOutItemIndex].stockedInDate}</p>
                  </div>
                </div>
              )}
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1">Reason</label>
                <input
                  type="text"
                  className="w-full border border-[#E2DDD8] rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  value={stockOutReason}
                  onChange={(e) => setStockOutReason(e.target.value)}
                  placeholder="e.g. Delivered to customer, Transferred, Damaged..."
                />
              </div>
              <Button
                variant="destructive"
                className="w-full"
                disabled={!stockOutTarget || !stockOutReason || actionLoading}
                onClick={handleStockOut}
              >
                {actionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpFromLine className="h-4 w-4" />}
                Confirm Stock Out
              </Button>
            </CardContent>
          </Card>

          {/* Recent Movements */}
          <div className="lg:col-span-2">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2">
                  <History className="h-5 w-5 text-[#6B5C32]" />
                  Recent Movements
                </CardTitle>
              </CardHeader>
              <CardContent>
                <MovementTable movements={movements.slice(0, 20)} />
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {/* ===== TAB 3: Movement History ===== */}
      {activeTab === "history" && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <CardTitle className="flex items-center gap-2">
                <History className="h-5 w-5 text-[#6B5C32]" />
                Full Movement History
              </CardTitle>
              <div className="flex flex-wrap gap-2 items-center">
                <select
                  className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  value={historyType}
                  onChange={(e) => setHistoryType(e.target.value)}
                >
                  <option value="">All Types</option>
                  <option value="STOCK_IN">Stock In</option>
                  <option value="STOCK_OUT">Stock Out</option>
                  <option value="TRANSFER">Transfer</option>
                </select>
                <input
                  type="date"
                  className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  value={historyFrom}
                  onChange={(e) => setHistoryFrom(e.target.value)}
                  placeholder="From"
                />
                <input
                  type="date"
                  className="border border-[#E2DDD8] rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  value={historyTo}
                  onChange={(e) => setHistoryTo(e.target.value)}
                  placeholder="To"
                />
                {(historyType || historyFrom || historyTo) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { setHistoryType(""); setHistoryFrom(""); setHistoryTo(""); }}
                  >
                    Clear Filters
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <MovementTable movements={movements} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------- Movement Table Component ----------
function MovementTable({ movements }: { movements: StockMovement[] }) {
  if (movements.length === 0) {
    return <p className="text-sm text-[#6B7280] text-center py-8">No movements found.</p>;
  }

  return (
    <div className="rounded-md border border-[#E2DDD8] overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
              <th className="h-10 px-4 text-left font-medium text-[#374151]">Date</th>
              <th className="h-10 px-4 text-left font-medium text-[#374151]">Type</th>
              <th className="h-10 px-4 text-left font-medium text-[#374151]">Rack</th>
              <th className="h-10 px-4 text-left font-medium text-[#374151]">Product</th>
              <th className="h-10 px-4 text-left font-medium text-[#374151]">Qty</th>
              <th className="h-10 px-4 text-left font-medium text-[#374151]">Reason</th>
              <th className="h-10 px-4 text-left font-medium text-[#374151]">Performed By</th>
            </tr>
          </thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.id} className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7] transition-colors">
                <td className="h-10 px-4 text-[#4B5563] whitespace-nowrap">
                  {new Date(m.createdAt).toLocaleDateString("en-MY", { day: "2-digit", month: "short", year: "numeric" })}
                </td>
                <td className="h-10 px-4">
                  <Badge
                    className={
                      m.type === "STOCK_IN"
                        ? "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]"
                        : m.type === "STOCK_OUT"
                        ? "bg-[#F9E1DA] text-[#9A3A2D] border-[#E8B2A1]"
                        : "bg-[#E0EDF0] text-[#3E6570] border-[#A8CAD2]"
                    }
                  >
                    {m.type === "STOCK_IN" ? "IN" : m.type === "STOCK_OUT" ? "OUT" : "TRANSFER"}
                  </Badge>
                </td>
                <td className="h-10 px-4 font-medium text-[#1F1D1B]">{m.rackLabel}</td>
                <td className="h-10 px-4 text-[#4B5563]">{m.productName}</td>
                <td className="h-10 px-4 text-[#4B5563]">{m.quantity}</td>
                <td className="h-10 px-4 text-[#4B5563] max-w-[200px] truncate">{m.reason}</td>
                <td className="h-10 px-4 text-[#4B5563]">{m.performedBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
