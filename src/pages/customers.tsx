import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { formatCurrency, formatRM } from "@/lib/utils";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import type { Customer } from "@/lib/mock-data";
import generateCustomerQuotationPdf from "@/lib/generate-customer-quotation-pdf";
import {
  Plus,
  Building2,
  Phone,
  Mail,
  X,
  Loader2,
  MapPin,
  Users,
  Eye,
  Pencil,
  Trash2,
  RefreshCw,
  Warehouse,
  Package,
  Search,
  Check,
  FileDown,
} from "lucide-react";

// =====================================================================
// Customer Products types (per-customer SKU assignments with price overrides)
// =====================================================================
type CustomerProduct = {
  id: string;
  customerId: string;
  productId: string;
  productCode: string;
  productName: string;
  category: string;
  basePriceSen: number;
  price1Sen: number | null;
  // Backend returns an array of { height, priceSen } objects — matches the
  // shape of products.seatHeightPrices after migration 0031 (string heights).
  seatHeightPrices: Array<{ height: string; priceSen: number }> | null;
  notes: string | null;
  hasPendingPriceChange?: boolean;
};

type PriceHistoryRow = {
  id: string;
  basePriceSen: number | null;
  price1Sen: number | null;
  seatHeightPrices: Array<{ height: string; priceSen: number }>;
  effectiveFrom: string;
  notes: string;
  created_at: string;
};

type ProductOption = {
  id: string;
  code: string;
  name: string;
  category: string;
  basePriceSen: number;
  price1Sen?: number | null;
};

// ---------- State badge colours ----------
const stateBadgeColors: Record<string, string> = {
  KL: "bg-[#E0EDF0] text-[#3E6570] border-[#A8CAD2]",
  PG: "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]",
  SRW: "bg-[#FBE4CE] text-[#B8601A] border-[#E8B786]",
  SBH: "bg-[#F1E6F0] text-[#6B4A6D] border-[#D1B7D0]",
  JB: "bg-[#F9E1DA] text-[#9A3A2D] border-[#E8B2A1]",
};

function StateBadge({ state }: { state: string }) {
  if (!state) return null;
  const colors = stateBadgeColors[state] || "bg-gray-100 text-gray-700 border-gray-300";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${colors}`}>
      {state}
    </span>
  );
}

// =====================================================================
// Customer Products Panel — shown inside the expanded-customer detail.
// Lists SKUs assigned to this customer with per-customer price overrides.
// =====================================================================
function CustomerProductsPanel({ customerId, customerName, customer }: { customerId: string; customerName: string; customer: Customer }) {
  const { data: resp, refresh } = useCachedJson<{ success?: boolean; data?: CustomerProduct[] }>(
    customerId ? `/api/customer-products?customerId=${customerId}` : null
  );
  const rows: CustomerProduct[] = useMemo(
    () => (resp?.success ? resp.data ?? [] : Array.isArray(resp) ? (resp as CustomerProduct[]) : []),
    [resp]
  );

  const { data: productsResp } = useCachedJson<{ success?: boolean; data?: ProductOption[] }>("/api/products");
  const allProducts: ProductOption[] = useMemo(
    () => (productsResp?.success ? productsResp.data ?? [] : Array.isArray(productsResp) ? (productsResp as ProductOption[]) : []),
    [productsResp]
  );

  const [query, setQuery] = useState("");
  const [categoryTab, setCategoryTab] = useState<"ALL" | "BEDFRAME" | "SOFA" | "ACCESSORY">("ALL");
  const [showAssign, setShowAssign] = useState(false);
  const [assignQuery, setAssignQuery] = useState("");
  const [assignPicked, setAssignPicked] = useState<Set<string>>(new Set());
  const [assignSaving, setAssignSaving] = useState(false);

  // Inline edit form state
  const [editId, setEditId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    basePriceRm: string;
    price1Rm: string;
    seatHeightsJson: string;
    notes: string;
    effectiveFrom: string;
  }>({
    basePriceRm: "",
    price1Rm: "",
    seatHeightsJson: "",
    notes: "",
    effectiveFrom: "",
  });
  const [editSaving, setEditSaving] = useState(false);

  // Price-history disclosure: history rows keyed by cpId, plus open/loading state.
  const [historyOpenId, setHistoryOpenId] = useState<string | null>(null);
  const [historyRows, setHistoryRows] = useState<PriceHistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const todayIso = () => new Date().toISOString().slice(0, 10);

  const loadHistory = async (cpId: string) => {
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/customer-products/${cpId}/price-history`);
      const j = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        data?: PriceHistoryRow[];
      };
      setHistoryRows(j.success ? j.data ?? [] : []);
    } finally {
      setHistoryLoading(false);
    }
  };

  const toggleHistory = async (cpId: string) => {
    if (historyOpenId === cpId) {
      setHistoryOpenId(null);
      setHistoryRows([]);
      return;
    }
    setHistoryOpenId(cpId);
    await loadHistory(cpId);
  };

  const deleteHistoryRow = async (rowId: string, cpId: string) => {
    if (!confirm("Delete this price history entry?")) return;
    const res = await fetch(`/api/customer-products/price-row/${rowId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert((j as { error?: string }).error || `Failed to delete (HTTP ${res.status})`);
      return;
    }
    invalidateCachePrefix("/api/customer-products");
    await loadHistory(cpId);
    refresh();
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (categoryTab !== "ALL" && r.category !== categoryTab) return false;
      if (!q) return true;
      return r.productCode.toLowerCase().includes(q) || r.productName.toLowerCase().includes(q);
    });
  }, [rows, query, categoryTab]);

  // Counts come from the full assignment list so numbers stay stable as the user types/tabs.
  const categoryTabs: { key: "ALL" | "BEDFRAME" | "SOFA" | "ACCESSORY"; label: string }[] = [
    { key: "ALL", label: "All" },
    { key: "BEDFRAME", label: "Bedframe" },
    { key: "SOFA", label: "Sofa" },
    { key: "ACCESSORY", label: "Accessory" },
  ];
  const categoryCounts = useMemo(() => {
    const c = { ALL: rows.length, BEDFRAME: 0, SOFA: 0, ACCESSORY: 0 } as Record<"ALL" | "BEDFRAME" | "SOFA" | "ACCESSORY", number>;
    for (const r of rows) {
      if (r.category === "BEDFRAME" || r.category === "SOFA" || r.category === "ACCESSORY") {
        c[r.category] += 1;
      }
    }
    return c;
  }, [rows]);

  const assignedIds = useMemo(() => new Set(rows.map((r) => r.productId)), [rows]);
  const assignOptions = useMemo(() => {
    const q = assignQuery.trim().toLowerCase();
    return allProducts
      .filter((p) => !assignedIds.has(p.id))
      .filter((p) => !q || p.code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q))
      .slice(0, 100);
  }, [allProducts, assignedIds, assignQuery]);

  const openEdit = (row: CustomerProduct) => {
    setEditId(row.id);
    setEditForm({
      basePriceRm: (row.basePriceSen / 100).toFixed(2),
      price1Rm: row.price1Sen != null ? (row.price1Sen / 100).toFixed(2) : "",
      seatHeightsJson: row.seatHeightPrices ? JSON.stringify(row.seatHeightPrices) : "",
      notes: row.notes ?? "",
      effectiveFrom: todayIso(),
    });
  };

  // Save now appends a new price-history row (POST /:cpId/prices). The legacy
  // override columns on customer_products stay untouched — the history table is
  // the new authoritative source for price resolution.
  const saveEdit = async () => {
    if (!editId) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(editForm.effectiveFrom)) {
      alert("Effective From date is required (YYYY-MM-DD).");
      return;
    }
    setEditSaving(true);
    try {
      const body: Record<string, unknown> = {
        effectiveFrom: editForm.effectiveFrom,
      };
      if (editForm.basePriceRm !== "")
        body.basePriceSen = Math.round(Number(editForm.basePriceRm) * 100);
      if (editForm.price1Rm !== "")
        body.price1Sen = Math.round(Number(editForm.price1Rm) * 100);
      else body.price1Sen = null;
      if (editForm.seatHeightsJson.trim()) {
        try {
          body.seatHeightPrices = JSON.parse(editForm.seatHeightsJson);
        } catch {
          alert(
            'Seat-height prices must be valid JSON (e.g. [{"height":"24","priceSen":51700}]).',
          );
          setEditSaving(false);
          return;
        }
      } else {
        body.seatHeightPrices = null;
      }
      body.notes = editForm.notes || null;
      const res = await fetch(`/api/customer-products/${editId}/prices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert((j as { error?: string }).error || `Failed to save (HTTP ${res.status})`);
        return;
      }
      invalidateCachePrefix("/api/customer-products");
      refresh();
      // Refresh open history panel if this row is the one being inspected.
      if (historyOpenId === editId) await loadHistory(editId);
      setEditId(null);
    } finally {
      setEditSaving(false);
    }
  };

  const handleRemove = async (row: CustomerProduct) => {
    if (!confirm(`Remove "${row.productCode} ${row.productName}" from ${customerName}?`)) return;
    const res = await fetch(`/api/customer-products/${row.id}`, { method: "DELETE" });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert((j as { error?: string }).error || `Failed to remove (HTTP ${res.status})`);
      return;
    }
    invalidateCachePrefix("/api/customer-products");
    refresh();
  };

  const toggleAssignPick = (id: string) => {
    setAssignPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submitAssign = async () => {
    if (assignPicked.size === 0) return;
    setAssignSaving(true);
    try {
      const res = await fetch("/api/customer-products/bulk-assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, productIds: Array.from(assignPicked) }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert((j as { error?: string }).error || `Failed to assign (HTTP ${res.status})`);
        return;
      }
      invalidateCachePrefix("/api/customer-products");
      refresh();
      setAssignPicked(new Set());
      setAssignQuery("");
      setShowAssign(false);
    } finally {
      setAssignSaving(false);
    }
  };

  const formatSeatHeights = (sh: Array<{ height: string; priceSen: number }> | null) => {
    if (!sh || sh.length === 0) return "—";
    return sh
      .map((t) => `${t.height}":${(t.priceSen / 100).toFixed(0)}`)
      .join(" ");
  };

  // Exports the full assignment list (ignores the category tab + search filter)
  // because a quotation is per-customer contract scope, not UI view.
  const handleExportQuotation = () => {
    const defaultHub = customer.deliveryHubs?.find((h) => h.isDefault) ?? customer.deliveryHubs?.[0];
    const doc = generateCustomerQuotationPdf({
      customer: {
        name: customer.name,
        address: defaultHub?.address ?? customer.companyAddress ?? null,
        phone: defaultHub?.phone ?? customer.phone ?? null,
        email: defaultHub?.email ?? customer.email ?? null,
      },
      products: rows.map((r) => ({
        code: r.productCode,
        name: r.productName,
        category: r.category,
        basePriceSen: r.basePriceSen,
        price1Sen: r.price1Sen,
        seatHeightPrices: r.seatHeightPrices,
      })),
    });
    const d = new Date();
    const yyyymmdd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const safeName = customerName.replace(/[^a-zA-Z0-9_-]+/g, "_");
    doc.save(`Quotation-${safeName}-${yyyymmdd}.pdf`);
  };

  return (
    <Card className="border-[#6B5C32] border-2">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Package className="h-5 w-5 text-[#6B5C32]" />
            Customer Products — {customerName} ({rows.length})
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={rows.length === 0} onClick={handleExportQuotation}>
              <FileDown className="h-4 w-4 mr-1" />
              Export Quotation PDF
            </Button>
            <Button variant="primary" size="sm" onClick={() => setShowAssign(true)}>
              <Plus className="h-4 w-4 mr-1" />
              Assign SKU
            </Button>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap mt-3">
          {categoryTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setCategoryTab(tab.key)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                categoryTab === tab.key
                  ? "bg-[#111827] text-white"
                  : "bg-white text-[#6B7280] border border-[#E2DDD8] hover:bg-[#F3F4F6]"
              }`}
            >
              {tab.label} ({categoryCounts[tab.key]})
            </button>
          ))}
        </div>
        <div className="mt-2">
          <div className="relative w-48">
            <Search className="h-3.5 w-3.5 text-[#9CA3AF] absolute left-2.5 top-1/2 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search SKUs..."
              className="h-8 pl-8"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Assign SKU modal — full-screen overlay. The old inline expand didn't scale for bulk assign. */}
        <AssignSkuModal
          open={showAssign}
          customerName={customerName}
          candidates={allProducts.filter((p) => !assignedIds.has(p.id))}
          picked={assignPicked}
          togglePick={toggleAssignPick}
          setPicked={setAssignPicked}
          saving={assignSaving}
          onClose={() => { setShowAssign(false); setAssignPicked(new Set()); setAssignQuery(""); }}
          onSubmit={submitAssign}
        />

        {rows.length === 0 ? (
          <div className="py-8 text-center space-y-3">
            <p className="text-sm text-[#9CA3AF]">
              No SKUs assigned. Pillows and bedframes assigned to this customer will show here.
            </p>
            <Button variant="primary" size="sm" onClick={() => setShowAssign(true)}>
              <Plus className="h-4 w-4 mr-1" /> Assign SKU
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                  <th className="text-left font-medium py-2 px-2">Code</th>
                  <th className="text-left font-medium py-2 px-2">Name</th>
                  <th className="text-left font-medium py-2 px-2">Category</th>
                  <th className="text-right font-medium py-2 px-2">Base Price</th>
                  <th className="text-right font-medium py-2 px-2">Price 1</th>
                  <th className="text-left font-medium py-2 px-2">Seat Heights</th>
                  <th className="text-right font-medium py-2 px-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  editId === row.id ? (
                    <tr key={row.id} className="border-b border-[#E2DDD8] bg-[#FAF9F7]">
                      <td colSpan={7} className="p-3">
                        <div className="space-y-3">
                          <div className="flex items-center gap-2">
                            <span className="doc-number text-xs text-[#1F1D1B]">{row.productCode}</span>
                            <span className="text-xs text-[#6B7280]">{row.productName}</span>
                            <Badge className="text-[10px]">{row.category}</Badge>
                          </div>
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                            <div>
                              <label className="block text-xs text-[#6B7280] mb-1">Base Price (RM)</label>
                              <Input
                                type="number"
                                step="0.01"
                                value={editForm.basePriceRm}
                                onChange={(e) => setEditForm((f) => ({ ...f, basePriceRm: e.target.value }))}
                                className="h-8"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-[#6B7280] mb-1">Price 1 (RM) — optional</label>
                              <Input
                                type="number"
                                step="0.01"
                                value={editForm.price1Rm}
                                onChange={(e) => setEditForm((f) => ({ ...f, price1Rm: e.target.value }))}
                                placeholder="leave blank to clear"
                                className="h-8"
                              />
                            </div>
                            <div>
                              <label className="block text-xs text-[#6B7280] mb-1">Effective From</label>
                              <Input
                                type="date"
                                value={editForm.effectiveFrom}
                                onChange={(e) => setEditForm((f) => ({ ...f, effectiveFrom: e.target.value }))}
                                className="h-8"
                              />
                            </div>
                            {row.category === "SOFA" && (
                              <div className="sm:col-span-3">
                                <label className="block text-xs text-[#6B7280] mb-1">
                                  Seat-Height Prices (JSON) — sofa only
                                </label>
                                <Input
                                  value={editForm.seatHeightsJson}
                                  onChange={(e) => setEditForm((f) => ({ ...f, seatHeightsJson: e.target.value }))}
                                  placeholder='e.g. [{"height":"24","priceSen":51700}]'
                                  className="h-8"
                                />
                              </div>
                            )}
                            <div className="sm:col-span-3">
                              <label className="block text-xs text-[#6B7280] mb-1">Notes</label>
                              <Input
                                value={editForm.notes}
                                onChange={(e) => setEditForm((f) => ({ ...f, notes: e.target.value }))}
                                className="h-8"
                              />
                            </div>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <button
                              type="button"
                              onClick={() => toggleHistory(row.id)}
                              className="text-xs text-[#6B5C32] underline hover:text-[#1F1D1B]"
                            >
                              {historyOpenId === row.id ? "Hide price history" : "Price history"}
                            </button>
                            <div className="flex justify-end gap-2">
                              <Button variant="outline" size="sm" onClick={() => setEditId(null)}>Cancel</Button>
                              <Button variant="primary" size="sm" disabled={editSaving} onClick={saveEdit}>
                                {editSaving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : null}
                                Save
                              </Button>
                            </div>
                          </div>
                          {historyOpenId === row.id && (
                            <div className="mt-2 border border-[#E2DDD8] rounded-md bg-white">
                              <div className="px-3 py-2 border-b border-[#E2DDD8] text-xs text-[#6B7280]">
                                Price history ({historyRows.length})
                              </div>
                              {historyLoading ? (
                                <div className="p-4 text-xs text-[#9CA3AF] flex items-center gap-2">
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
                                </div>
                              ) : historyRows.length === 0 ? (
                                <div className="p-4 text-xs text-[#9CA3AF]">No history yet.</div>
                              ) : (
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="bg-[#FAF9F7] text-[#6B7280]">
                                      <th className="text-left py-1.5 px-2 font-medium">Effective From</th>
                                      <th className="text-right py-1.5 px-2 font-medium">Base (RM)</th>
                                      <th className="text-right py-1.5 px-2 font-medium">Price 1 (RM)</th>
                                      <th className="text-left py-1.5 px-2 font-medium">Seat Heights</th>
                                      <th className="text-left py-1.5 px-2 font-medium">Notes</th>
                                      <th className="text-right py-1.5 px-2 font-medium">Status</th>
                                      <th className="text-right py-1.5 px-2 font-medium"></th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {historyRows.map((h) => {
                                      const isPending = h.effectiveFrom > todayIso();
                                      return (
                                        <tr key={h.id} className="border-t border-[#E2DDD8]">
                                          <td className="py-1.5 px-2 doc-number">{h.effectiveFrom}</td>
                                          <td className="py-1.5 px-2 text-right tabular-nums">
                                            {h.basePriceSen != null ? (h.basePriceSen / 100).toFixed(2) : "—"}
                                          </td>
                                          <td className="py-1.5 px-2 text-right tabular-nums">
                                            {h.price1Sen != null ? (h.price1Sen / 100).toFixed(2) : "—"}
                                          </td>
                                          <td className="py-1.5 px-2 text-[#6B7280]">
                                            {formatSeatHeights(h.seatHeightPrices?.length ? h.seatHeightPrices : null)}
                                          </td>
                                          <td className="py-1.5 px-2 text-[#6B7280]">{h.notes || "—"}</td>
                                          <td className="py-1.5 px-2 text-right">
                                            {isPending ? (
                                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#FBE4CE] text-[#B8601A] border border-[#E8B786]">
                                                Pending
                                              </span>
                                            ) : (
                                              <span className="text-[10px] text-[#9CA3AF]">Active</span>
                                            )}
                                          </td>
                                          <td className="py-1.5 px-2 text-right">
                                            <button
                                              onClick={() => deleteHistoryRow(h.id, row.id)}
                                              className="p-1 rounded hover:bg-[#F9E1DA]"
                                              title="Delete history row"
                                            >
                                              <Trash2 className="h-3 w-3 text-[#9A3A2D]" />
                                            </button>
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              )}
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={row.id} className="border-b border-[#E2DDD8] hover:bg-[#FAF9F7]">
                      <td className="py-2 px-2 doc-number text-xs text-[#1F1D1B]">{row.productCode}</td>
                      <td className="py-2 px-2 text-[#1F1D1B]">{row.productName}</td>
                      <td className="py-2 px-2"><Badge className="text-[10px]">{row.category}</Badge></td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        <span className="inline-flex items-center gap-1.5">
                          {formatRM(row.basePriceSen)}
                          {row.hasPendingPriceChange && (
                            <span
                              title="A future-dated price change is queued"
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium bg-[#FBE4CE] text-[#B8601A] border border-[#E8B786]"
                            >
                              Pending
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums text-[#6B7280]">
                        {row.price1Sen != null ? formatRM(row.price1Sen) : "—"}
                      </td>
                      <td className="py-2 px-2 text-xs text-[#6B7280]">{formatSeatHeights(row.seatHeightPrices)}</td>
                      <td className="py-2 px-2 text-right">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => openEdit(row)}
                            className="p-1.5 rounded hover:bg-[#E2DDD8]"
                            title="Edit"
                          >
                            <Pencil className="h-3.5 w-3.5 text-[#6B5C32]" />
                          </button>
                          <button
                            onClick={() => handleRemove(row)}
                            className="p-1.5 rounded hover:bg-[#F9E1DA]"
                            title="Remove"
                          >
                            <Trash2 className="h-3.5 w-3.5 text-[#9A3A2D]" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                ))}
                {filtered.length === 0 && rows.length > 0 && (
                  <tr>
                    <td colSpan={7} className="py-4 text-center text-xs text-[#9CA3AF]">
                      {categoryTab !== "ALL"
                        ? "No SKUs in this category"
                        : `No SKUs match "${query}".`}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// =====================================================================
// AssignSkuModal — full-screen overlay for bulk-assigning unassigned SKUs
// to a customer. Replaces the earlier inline expand, which didn't scale
// once customers had dozens of candidate SKUs to pick from.
// =====================================================================
type ModalCategory = "ALL" | "BEDFRAME" | "SOFA" | "ACCESSORY";

function AssignSkuModal({
  open,
  customerName,
  candidates,
  picked,
  togglePick,
  setPicked,
  saving,
  onClose,
  onSubmit,
}: {
  open: boolean;
  customerName: string;
  candidates: ProductOption[];
  picked: Set<string>;
  togglePick: (id: string) => void;
  setPicked: (next: Set<string>) => void;
  saving: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const [modalTab, setModalTab] = useState<ModalCategory>("ALL");
  const [modalQuery, setModalQuery] = useState("");

  // Reset local state on every open so stale tab/search never bleed across customers.
  useEffect(() => {
    if (open) {
      setModalTab("ALL");
      setModalQuery("");
    }
  }, [open]);

  // ESC closes the modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const tabs: { key: ModalCategory; label: string }[] = [
    { key: "ALL", label: "All" },
    { key: "BEDFRAME", label: "Bedframe" },
    { key: "SOFA", label: "Sofa" },
    { key: "ACCESSORY", label: "Accessory" },
  ];

  const tabCounts = useMemo(() => {
    const c: Record<ModalCategory, number> = { ALL: candidates.length, BEDFRAME: 0, SOFA: 0, ACCESSORY: 0 };
    for (const p of candidates) {
      if (p.category === "BEDFRAME" || p.category === "SOFA" || p.category === "ACCESSORY") {
        c[p.category] += 1;
      }
    }
    return c;
  }, [candidates]);

  const visible = useMemo(() => {
    const q = modalQuery.trim().toLowerCase();
    return candidates.filter((p) => {
      if (modalTab !== "ALL" && p.category !== modalTab) return false;
      if (!q) return true;
      return p.code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q);
    });
  }, [candidates, modalTab, modalQuery]);

  const selectAllVisible = () => {
    const next = new Set(picked);
    for (const p of visible) next.add(p.id);
    setPicked(next);
  };
  const clearSelection = () => setPicked(new Set());

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl flex flex-col w-[80vw] h-[80vh] max-w-6xl mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
          <h2 className="text-lg font-semibold text-[#1F1D1B]">Assign SKUs to {customerName}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-[#E2DDD8]" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Sub-header: tabs + search + bulk shortcuts */}
        <div className="px-6 py-3 border-b border-[#E2DDD8] space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setModalTab(t.key)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  modalTab === t.key
                    ? "bg-[#111827] text-white"
                    : "bg-white text-[#6B7280] border border-[#E2DDD8] hover:bg-[#F3F4F6]"
                }`}
              >
                {t.label} ({tabCounts[t.key]})
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px] max-w-md">
              <Search className="h-3.5 w-3.5 text-[#9CA3AF] absolute left-2.5 top-1/2 -translate-y-1/2" />
              <Input
                value={modalQuery}
                onChange={(e) => setModalQuery(e.target.value)}
                placeholder="Search by code or name..."
                className="h-8 pl-8"
                autoFocus
              />
            </div>
            <Button variant="outline" size="sm" onClick={selectAllVisible} disabled={visible.length === 0}>
              Select All visible
            </Button>
            <Button variant="outline" size="sm" onClick={clearSelection} disabled={picked.size === 0}>
              Clear
            </Button>
            <span className="text-xs text-[#6B7280] ml-auto">{picked.size} selected</span>
          </div>
        </div>

        {/* Body: scrollable grid of SKU rows */}
        <div className="flex-1 overflow-y-auto px-6 py-3">
          {candidates.length === 0 ? (
            <p className="text-sm text-[#9CA3AF] py-12 text-center">
              All SKUs are already assigned to this customer.
            </p>
          ) : visible.length === 0 ? (
            <p className="text-sm text-[#9CA3AF] py-12 text-center">
              No SKUs match the current filter.
            </p>
          ) : (
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {visible.map((p) => {
                const isPicked = picked.has(p.id);
                return (
                  <li
                    key={p.id}
                    onClick={() => togglePick(p.id)}
                    className={`flex items-center gap-3 px-3 py-2 border rounded cursor-pointer transition-colors ${
                      isPicked
                        ? "bg-[#F4F0E8] border-[#6B5C32]"
                        : "bg-white border-[#E2DDD8] hover:bg-[#FAF9F7]"
                    }`}
                  >
                    <div className={`h-4 w-4 rounded border flex items-center justify-center flex-shrink-0 ${isPicked ? "bg-[#6B5C32] border-[#6B5C32]" : "border-[#C8C2BB]"}`}>
                      {isPicked && <Check className="h-3 w-3 text-white" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="doc-number text-xs text-[#1F1D1B]">{p.code}</span>
                        <Badge className="text-[10px]">{p.category}</Badge>
                      </div>
                      <p className="text-xs text-[#6B7280] truncate">{p.name}</p>
                    </div>
                    <span className="text-xs tabular-nums text-[#6B7280] flex-shrink-0">{formatRM(p.basePriceSen)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2DDD8]">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={picked.size === 0 || saving}
            onClick={onSubmit}
          >
            {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
            Assign {picked.size} item{picked.size === 1 ? "" : "s"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// Main Page
// =====================================================================
export default function CustomersPage() {
  const { data: customersResp, loading, refresh: refreshCustomers } = useCachedJson<{ success?: boolean; data?: Customer[] }>("/api/customers");
  const initialCustomers: Customer[] = useMemo(
    () => (customersResp?.success ? customersResp.data ?? [] : Array.isArray(customersResp) ? customersResp : []),
    [customersResp]
  );
  const [data, setData] = useState<Customer[]>([]);
  const [expandedCustomer, setExpandedCustomer] = useState<string | null>(null);

  // add-form state
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ code: "", name: "", contactName: "", phone: "", email: "", creditTerms: "NET30", creditLimitSen: 0 });
  const [addSaving, setAddSaving] = useState(false);

  // edit customer dialog state
  const [editCustomer, setEditCustomer] = useState<Customer | null>(null);
  const [editCustForm, setEditCustForm] = useState({ name: "", ssmNo: "", companyAddress: "", contactName: "", phone: "", email: "", creditTerms: "", creditLimitSen: 0 });

  // add/edit hub form state
  const [showAddHub, setShowAddHub] = useState(false);
  const [editHubId, setEditHubId] = useState<string | null>(null);
  const [hubForm, setHubForm] = useState({ shortName: "", code: "", state: "KL", contactName: "", phone: "", email: "", address: "" });

  // ---------- Fetch ----------
  const fetchCustomers = () => {
    invalidateCachePrefix("/api/customers");
    refreshCustomers();
  };

  useEffect(() => {
    setData(initialCustomers);
  }, [initialCustomers]);

  // ---------- Add ----------
  const handleAdd = async () => {
    setAddSaving(true);
    try {
      const res = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addForm),
      });
      const json = await res.json();
      if (json.success) {
        setData((prev) => [...prev, json.data]);
        invalidateCachePrefix("/api/customers");
        setAddForm({ code: "", name: "", contactName: "", phone: "", email: "", creditTerms: "NET30", creditLimitSen: 0 });
        setShowAdd(false);
      }
    } finally {
      setAddSaving(false);
    }
  };

  // ---------- Delete ----------
  const handleDelete = async (customer: Customer) => {
    if (!confirm(`Delete customer "${customer.name}"?`)) return;
    try {
      const res = await fetch(`/api/customers/${customer.id}`, { method: "DELETE" });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json: any = await res.json().catch(() => ({}));
      // res.ok guard — a failed DELETE (foreign-key block, 401, 500) would
      // otherwise let the row disappear from the list locally while the
      // customer stays in the DB. On next reload it reappears "zombie" style.
      if (!res.ok) {
        alert(json?.error || `Failed to delete customer (HTTP ${res.status})`);
        return;
      }
      if (json.success) {
        setData((prev) => prev.filter((c) => c.id !== customer.id));
        invalidateCachePrefix("/api/customers");
      } else {
        alert(json.error || "Failed to delete customer");
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : "Network error — customer not deleted");
    }
  };

  // ---------- Persist customer to API ----------
  const persistCustomer = async (updated: Customer) => {
    setData((prev) => prev.map((c) => c.id === updated.id ? updated : c));
    await fetch(`/api/customers/${updated.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updated),
    });
    invalidateCachePrefix("/api/customers");
  };

  // ---------- Edit Customer ----------
  const openEditCustomer = (cust: Customer) => {
    setEditCustomer(cust);
    setEditCustForm({
      name: cust.name,
      ssmNo: cust.ssmNo || "",
      companyAddress: cust.companyAddress || "",
      contactName: cust.contactName,
      phone: cust.phone,
      email: cust.email,
      creditTerms: cust.creditTerms,
      creditLimitSen: cust.creditLimitSen,
    });
  };

  const saveEditCustomer = () => {
    if (!editCustomer) return;
    const updated = { ...editCustomer, ...editCustForm };
    persistCustomer(updated);
    setEditCustomer(null);
  };

  // ---------- KPI calculations ----------
  const totalCustomers = data.length;
  const totalHubs = data.reduce((s, c) => s + (c.deliveryHubs?.length || 0), 0);
  const totalOutstanding = data.reduce((s, c) => s + c.outstandingSen, 0);
  const totalCreditLimit = data.reduce((s, c) => s + c.creditLimitSen, 0);

  // ---------- Columns ----------
  const columns: Column<Customer>[] = [
    {
      key: "code",
      label: "Creditor Code",
      type: "docno",
      width: "120px",
      sortable: true,
    },
    {
      key: "name",
      label: "Customer Name",
      width: "200px",
      sortable: true,
      render: (_value, row) => (
        <div>
          <p className="font-medium text-[#1F1D1B]">{row.name}</p>
          <p className="text-xs text-[#9CA3AF]">{row.contactName}</p>
        </div>
      ),
    },
    {
      key: "deliveryHubs" as keyof Customer,
      label: "Delivery Hubs",
      width: "200px",
      sortable: false,
      render: (_value, row) => {
        const hubs = row.deliveryHubs || [];
        if (hubs.length === 0) return <span className="text-xs text-[#9CA3AF]">No hubs</span>;
        return (
          <div className="flex flex-col gap-0.5">
            {hubs.map((h) => (
              <div key={h.id} className="flex items-center gap-1.5 text-xs">
                <StateBadge state={h.state} />
                <span className="text-[#1F1D1B]">{h.shortName}</span>
              </div>
            ))}
          </div>
        );
      },
    },
    {
      key: "contactName",
      label: "PIC",
      width: "150px",
      sortable: true,
      render: (_value, row) => {
        const hubs = row.deliveryHubs || [];
        if (hubs.length <= 1) return <span className="text-sm">{row.contactName}</span>;
        return (
          <div className="flex flex-col gap-0.5">
            {hubs.map((h) => (
              <span key={h.id} className="text-xs text-[#1F1D1B]">{h.contactName}</span>
            ))}
          </div>
        );
      },
    },
    {
      key: "phone",
      label: "PIC Contact",
      width: "200px",
      render: (_value, row) => {
        const hubs = row.deliveryHubs || [];
        if (hubs.length <= 1) {
          return (
            <div className="space-y-0.5">
              <div className="flex items-center gap-1 text-xs text-[#6B7280]">
                <Phone className="h-3 w-3" />
                {row.phone}
              </div>
              {row.email && (
                <div className="flex items-center gap-1 text-xs text-[#6B7280]">
                  <Mail className="h-3 w-3" />
                  {row.email}
                </div>
              )}
            </div>
          );
        }
        return (
          <div className="flex flex-col gap-0.5">
            {hubs.map((h) => (
              <div key={h.id} className="flex items-center gap-1 text-xs text-[#6B7280]">
                <Phone className="h-3 w-3" />
                {h.phone}
              </div>
            ))}
          </div>
        );
      },
    },
    {
      key: "creditTerms",
      label: "Terms",
      width: "80px",
      sortable: true,
      align: "center",
      render: (_value, row) => <Badge>{row.creditTerms}</Badge>,
    },
    {
      key: "creditLimitSen",
      label: "Credit Limit",
      type: "currency",
      width: "130px",
      sortable: true,
      align: "right",
    },
    {
      key: "outstandingSen",
      label: "Outstanding",
      width: "140px",
      sortable: true,
      align: "right",
      render: (_value, row) => {
        const pct = row.creditLimitSen > 0
          ? (row.outstandingSen / row.creditLimitSen) * 100
          : 0;
        return (
          <div>
            <span className={`font-medium tabular-nums ${pct > 80 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>
              {formatRM(row.outstandingSen)}
            </span>
            <div className="mt-1 h-1 w-full rounded-full bg-[#E2DDD8]">
              <div
                className={`h-1 rounded-full ${
                  pct > 80 ? "bg-[#9A3A2D]" : pct > 50 ? "bg-[#9C6F1E]" : "bg-[#4F7C3A]"
                }`}
                style={{ width: `${Math.min(pct, 100)}%` }}
              />
            </div>
          </div>
        );
      },
    },
  ];

  // ---------- Context menu ----------
  const contextMenuItems: ContextMenuItem[] = [
    {
      label: "View",
      icon: <Eye className="h-3.5 w-3.5" />,
      action: (row: Customer) => setExpandedCustomer(expandedCustomer === row.id ? null : row.id),
    },
    {
      label: "Edit",
      icon: <Pencil className="h-3.5 w-3.5" />,
      action: (row: Customer) => openEditCustomer(row),
    },
    { label: "", separator: true, action: () => {} },
    {
      label: "Delete",
      icon: <Trash2 className="h-3.5 w-3.5" />,
      danger: true,
      action: (row: Customer) => handleDelete(row),
    },
    { label: "", separator: true, action: () => {} },
    {
      label: "Refresh",
      icon: <RefreshCw className="h-3.5 w-3.5" />,
      action: () => fetchCustomers(),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Customers</h1>
          <p className="text-xs text-[#6B7280]">
            Manage customer accounts, delivery hubs, and credit
          </p>
        </div>
        <Button
          variant="primary"
          onClick={() => {
            setShowAdd((v) => !v);
          }}
        >
          {showAdd ? (
            <>
              <X className="h-4 w-4" />
              Cancel
            </>
          ) : (
            <>
              <Plus className="h-4 w-4" />
              Add Customer
            </>
          )}
        </Button>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">Total Customers</p>
            <p className="text-xl font-bold text-[#1F1D1B]">{totalCustomers}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">Delivery Hubs</p>
            <p className="text-xl font-bold text-[#1F1D1B]">{totalHubs}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">Total Outstanding</p>
            <p className="text-xl font-bold text-[#1F1D1B]">
              {formatCurrency(totalOutstanding)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-[#6B7280]">Total Credit Limit</p>
            <p className="text-xl font-bold text-[#1F1D1B]">
              {formatCurrency(totalCreditLimit)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Add Customer Form */}
      {showAdd && (
        <Card className="border-[#6B5C32] border-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">New Customer</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label className="text-xs font-medium text-[#374151] mb-1 block">Creditor Code *</label>
                <Input value={addForm.code} onChange={(e) => setAddForm({ ...addForm, code: e.target.value })} placeholder="e.g. 300-X" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#374151] mb-1 block">Customer Name *</label>
                <Input value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} placeholder="Company name" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#374151] mb-1 block">PIC</label>
                <Input value={addForm.contactName} onChange={(e) => setAddForm({ ...addForm, contactName: e.target.value })} placeholder="e.g. Purchasing" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#374151] mb-1 block">PIC Contact</label>
                <Input value={addForm.phone} onChange={(e) => setAddForm({ ...addForm, phone: e.target.value })} placeholder="011-6151 1613" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#374151] mb-1 block">PIC Email</label>
                <Input value={addForm.email} onChange={(e) => setAddForm({ ...addForm, email: e.target.value })} placeholder="email@example.com" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#374151] mb-1 block">Credit Terms</label>
                <Input value={addForm.creditTerms} onChange={(e) => setAddForm({ ...addForm, creditTerms: e.target.value })} placeholder="NET30" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#374151] mb-1 block">Credit Limit (RM)</label>
                <Input type="number" value={addForm.creditLimitSen / 100} onChange={(e) => setAddForm({ ...addForm, creditLimitSen: Math.round(Number(e.target.value) * 100) })} placeholder="0.00" />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button variant="primary" disabled={!addForm.code || !addForm.name || addSaving} onClick={handleAdd}>
                {addSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Create Customer
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Customer List */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-[#6B5C32]" />
            All Customers
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataGrid<Customer>
            columns={columns}
            data={data}
            keyField="id"
            gridId="customers"
            loading={loading}
            stickyHeader={true}
            emptyMessage="No customers found."
            onRowClick={(row) => setExpandedCustomer(expandedCustomer === row.id ? null : row.id)}
            contextMenuItems={contextMenuItems}
          />
        </CardContent>
      </Card>

      {/* Expanded Customer Detail (Delivery Hubs + Customer Products) */}
      {expandedCustomer && (() => {
        const cust = data.find((c) => c.id === expandedCustomer);
        if (!cust) return null;
        return (
          <>
          <Card className="border-[#6B5C32] border-2">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Warehouse className="h-5 w-5 text-[#6B5C32]" />
                  {cust.name} — Delivery Hubs ({cust.deliveryHubs?.length || 0})
                </CardTitle>
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => openEditCustomer(cust)}>
                    <Pencil className="h-4 w-4 mr-1" /> Edit
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => { setShowAddHub(true); setHubForm({ shortName: "", code: "", state: "KL", contactName: "", phone: "", email: "", address: "" }); }}>
                    <Plus className="h-4 w-4 mr-1" /> Add Hub
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setExpandedCustomer(null)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="flex items-center gap-4 mt-2 text-sm text-[#6B7280]">
                <span>Credit Limit: <strong className="text-[#1F1D1B]">{formatRM(cust.creditLimitSen)}</strong></span>
                <span>Outstanding: <strong className="text-[#1F1D1B]">{formatRM(cust.outstandingSen)}</strong></span>
                <span>Terms: <Badge>{cust.creditTerms}</Badge></span>
              </div>
            </CardHeader>
            <CardContent>
              {(!cust.deliveryHubs || cust.deliveryHubs.length === 0) ? (
                <p className="text-sm text-[#9CA3AF] py-4 text-center">No delivery hubs configured</p>
              ) : (
                <div className="space-y-2">
                  {cust.deliveryHubs.map((hub) => (
                    editHubId === hub.id ? (
                      <div key={hub.id} className="p-4 rounded-lg border-2 border-[#6B5C32]/30 bg-[#FAF9F7] space-y-3">
                        <h3 className="text-sm font-semibold text-[#6B5C32]">Edit Hub — {hub.shortName}</h3>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                          <div>
                            <label className="block text-xs text-[#6B7280] mb-1">Hub Name *</label>
                            <Input value={hubForm.shortName} onChange={(e) => setHubForm(f => ({ ...f, shortName: e.target.value }))} className="h-8" />
                          </div>
                          <div>
                            <label className="block text-xs text-[#6B7280] mb-1">Hub Code</label>
                            <Input value={hubForm.code} onChange={(e) => setHubForm(f => ({ ...f, code: e.target.value }))} className="h-8" />
                          </div>
                          <div>
                            <label className="block text-xs text-[#6B7280] mb-1">State *</label>
                            <select value={hubForm.state} onChange={(e) => setHubForm(f => ({ ...f, state: e.target.value }))} className="w-full h-8 rounded border border-[#E2DDD8] px-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20">
                              {["KL","PG","JB","SRW","SBH","IPH","MLK","KCH","KB","KT"].map(s => <option key={s} value={s}>{s}</option>)}
                            </select>
                          </div>
                          <div>
                            <label className="block text-xs text-[#6B7280] mb-1">Contact Name</label>
                            <Input value={hubForm.contactName} onChange={(e) => setHubForm(f => ({ ...f, contactName: e.target.value }))} className="h-8" />
                          </div>
                          <div>
                            <label className="block text-xs text-[#6B7280] mb-1">Phone</label>
                            <Input value={hubForm.phone} onChange={(e) => setHubForm(f => ({ ...f, phone: e.target.value }))} className="h-8" />
                          </div>
                          <div>
                            <label className="block text-xs text-[#6B7280] mb-1">Email</label>
                            <Input value={hubForm.email} onChange={(e) => setHubForm(f => ({ ...f, email: e.target.value }))} className="h-8" />
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs text-[#6B7280] mb-1">Address *</label>
                          <Input value={hubForm.address} onChange={(e) => setHubForm(f => ({ ...f, address: e.target.value }))} />
                        </div>
                        <div className="flex justify-end gap-2">
                          <Button variant="outline" size="sm" onClick={() => setEditHubId(null)}>Cancel</Button>
                          <Button variant="primary" size="sm" onClick={() => {
                            const cust = data.find(c => c.id === expandedCustomer);
                            if (cust) {
                              persistCustomer({ ...cust, deliveryHubs: cust.deliveryHubs.map(h => h.id === editHubId ? { ...h, ...hubForm } : h) });
                            }
                            setEditHubId(null);
                          }}>Save</Button>
                        </div>
                      </div>
                    ) : (
                      <div key={hub.id} className="flex items-center gap-4 p-3 rounded-lg border border-[#E2DDD8] hover:bg-[#FAF9F7] group">
                        <StateBadge state={hub.state} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm text-[#1F1D1B]">{hub.shortName}</span>
                            <span className="text-xs text-[#9CA3AF] doc-number">{hub.code}</span>
                            <StateBadge state={hub.state} />
                            {hub.isDefault && <Badge className="bg-[#6B5C32]/10 text-[#6B5C32] border-[#6B5C32]/20 text-[10px]">Default</Badge>}
                          </div>
                          <div className="flex items-center gap-3 mt-0.5 text-xs text-[#6B7280]">
                            <span className="flex items-center gap-1"><Users className="h-3 w-3" />{hub.contactName}</span>
                            <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{hub.phone}</span>
                            {hub.email && <span className="flex items-center gap-1"><Mail className="h-3 w-3" />{hub.email}</span>}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-1 text-xs text-[#6B7280] max-w-xs text-right">
                            <MapPin className="h-3 w-3 flex-shrink-0" />
                            <span className="line-clamp-2">{hub.address}</span>
                          </div>
                          <button
                            onClick={() => {
                              setEditHubId(hub.id);
                              setHubForm({ shortName: hub.shortName, code: hub.code, state: hub.state, contactName: hub.contactName, phone: hub.phone, email: hub.email || "", address: hub.address });
                            }}
                            className="p-1.5 rounded hover:bg-[#E2DDD8] opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <Pencil className="h-3.5 w-3.5 text-[#6B5C32]" />
                          </button>
                          <button
                            onClick={() => {
                              if (!confirm(`Delete hub "${hub.shortName}"?`)) return;
                              const cust = data.find(c => c.id === expandedCustomer);
                              if (cust) {
                                persistCustomer({ ...cust, deliveryHubs: cust.deliveryHubs.filter(h => h.id !== hub.id) });
                              }
                            }}
                            className="p-1.5 rounded hover:bg-[#F9E1DA] opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <Trash2 className="h-3.5 w-3.5 text-[#9A3A2D]" />
                          </button>
                        </div>
                      </div>
                    )
                  ))}
                </div>
              )}
              {/* Add Hub Form */}
              {showAddHub && (
                <div className="mt-3 p-4 rounded-lg border-2 border-dashed border-[#6B5C32]/30 bg-[#FAF9F7] space-y-3">
                  <h3 className="text-sm font-semibold text-[#6B5C32]">Add New Hub</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1">Hub Name *</label>
                      <Input value={hubForm.shortName} onChange={(e) => setHubForm(f => ({ ...f, shortName: e.target.value }))} placeholder="e.g. Houzs JB" className="h-8" />
                    </div>
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1">Hub Code *</label>
                      <Input value={hubForm.code} onChange={(e) => setHubForm(f => ({ ...f, code: e.target.value }))} placeholder="e.g. 300-H005" className="h-8" />
                    </div>
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1">State *</label>
                      <select
                        value={hubForm.state}
                        onChange={(e) => setHubForm(f => ({ ...f, state: e.target.value }))}
                        className="w-full h-8 rounded border border-[#E2DDD8] px-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20"
                      >
                        <option value="KL">KL</option>
                        <option value="PG">PG</option>
                        <option value="JB">JB</option>
                        <option value="SRW">SRW</option>
                        <option value="SBH">SBH</option>
                        <option value="IPH">IPH</option>
                        <option value="MLK">MLK</option>
                        <option value="KCH">KCH</option>
                        <option value="KB">KB</option>
                        <option value="KT">KT</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1">Contact Name</label>
                      <Input value={hubForm.contactName} onChange={(e) => setHubForm(f => ({ ...f, contactName: e.target.value }))} placeholder="PIC name" className="h-8" />
                    </div>
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1">Phone</label>
                      <Input value={hubForm.phone} onChange={(e) => setHubForm(f => ({ ...f, phone: e.target.value }))} placeholder="e.g. 012-345 6789" className="h-8" />
                    </div>
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1">Email</label>
                      <Input value={hubForm.email} onChange={(e) => setHubForm(f => ({ ...f, email: e.target.value }))} placeholder="email@example.com" className="h-8" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Address *</label>
                    <Input value={hubForm.address} onChange={(e) => setHubForm(f => ({ ...f, address: e.target.value }))} placeholder="Full delivery address" />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setShowAddHub(false)}>Cancel</Button>
                    <Button variant="primary" size="sm" disabled={!hubForm.shortName || !hubForm.code || !hubForm.address} onClick={() => {
                      const newHub = { id: `hub-${Date.now()}`, ...hubForm, isDefault: false };
                      const cust = data.find(c => c.id === expandedCustomer);
                      if (cust) {
                        persistCustomer({ ...cust, deliveryHubs: [...(cust.deliveryHubs || []), newHub] });
                      }
                      setShowAddHub(false);
                    }}>Save Hub</Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          <CustomerProductsPanel customerId={cust.id} customerName={cust.name} customer={cust} />
          </>
        );
      })()}

      {/* Edit Customer Dialog */}
      {editCustomer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-lg mx-4">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
              <h2 className="text-lg font-semibold text-[#1F1D1B]">Edit Customer — {editCustomer.code}</h2>
              <button onClick={() => setEditCustomer(null)} className="p-1 rounded hover:bg-[#E2DDD8]">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <h3 className="text-sm font-semibold text-[#6B5C32]">Company Information</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Customer Name *</label>
                  <Input value={editCustForm.name} onChange={(e) => setEditCustForm(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">SSM No.</label>
                  <Input value={editCustForm.ssmNo} onChange={(e) => setEditCustForm(f => ({ ...f, ssmNo: e.target.value }))} placeholder="e.g. 201901012345" />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-[#6B7280] mb-1">Company Address</label>
                  <Input value={editCustForm.companyAddress} onChange={(e) => setEditCustForm(f => ({ ...f, companyAddress: e.target.value }))} placeholder="Registered company address" />
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">PIC</label>
                  <Input value={editCustForm.contactName} onChange={(e) => setEditCustForm(f => ({ ...f, contactName: e.target.value }))} />
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Phone</label>
                  <Input value={editCustForm.phone} onChange={(e) => setEditCustForm(f => ({ ...f, phone: e.target.value }))} />
                </div>
                <div className="col-span-2">
                  <label className="block text-xs text-[#6B7280] mb-1">Email</label>
                  <Input value={editCustForm.email} onChange={(e) => setEditCustForm(f => ({ ...f, email: e.target.value }))} />
                </div>
              </div>
              <h3 className="text-sm font-semibold text-[#6B5C32] pt-2">Credit & Terms</h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Credit Terms</label>
                  <select
                    value={editCustForm.creditTerms}
                    onChange={(e) => setEditCustForm(f => ({ ...f, creditTerms: e.target.value }))}
                    className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20"
                  >
                    <option value="COD">COD</option>
                    <option value="NET15">NET15</option>
                    <option value="NET30">NET30</option>
                    <option value="NET45">NET45</option>
                    <option value="NET60">NET60</option>
                    <option value="NET90">NET90</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[#6B7280] mb-1">Credit Limit (RM)</label>
                  <Input type="number" value={editCustForm.creditLimitSen / 100} onChange={(e) => setEditCustForm(f => ({ ...f, creditLimitSen: Math.round(Number(e.target.value) * 100) }))} />
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2DDD8]">
              <Button variant="outline" onClick={() => setEditCustomer(null)}>Cancel</Button>
              <Button variant="primary" onClick={saveEditCustomer} disabled={!editCustForm.name}>Save Changes</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
