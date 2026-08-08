import { useState, useCallback, useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { PageSkeleton } from "@/components/ui/skeleton";
import { DataGrid } from "@/components/ui/data-grid";
import type { Column, ContextMenuItem } from "@/components/ui/data-grid";
import { StatusTabStrip } from "@/components/ui/status-tab-strip";
import { tabTotals } from "@/lib/status-tab-strip";
import { formatCurrency, cn } from "@/lib/utils";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import type { Supplier, PurchaseOrder, SupplierMaterialBinding, RawMaterial } from "@/types";
import { useUrlState, useUrlBatch } from "@/lib/use-url-state";
import { useSessionState } from "@/lib/use-session-state";
import { matchesCompanyFilter } from "@/lib/company-dimension";
import { buildPoDetailListingAoa } from "@/lib/doc-detail-listings";
import {
  Plus, ShoppingBag, Truck, Trash2, X, Package,
  FileText, Download, Filter, AlertTriangle,
  Eye, Pencil, Printer, RefreshCw, TrendingDown, ChevronDown, ChevronUp,
  ClipboardCheck,
} from "lucide-react";

// PO statuses that the bulk Convert-to-GRN action accepts. Mirrors the
// `eligiblePOs` filter in the manual GRNFormDialog (procurement/grn.tsx) plus
// IN_TRANSIT, which is the post-shipped / pre-arrival state where the typical
// "all goods arrived" full-receipt happens. DRAFT / CANCELLED / RECEIVED /
// CLOSED are intentionally excluded — DRAFT hasn't been sent, CANCELLED is
// dead, RECEIVED / CLOSED are already done.
const BULK_GRN_ELIGIBLE_STATUSES = new Set([
  "SUBMITTED",
  "CONFIRMED",
  "IN_TRANSIT",
  "PARTIAL_RECEIVED",
]);
// generatePurchaseOrderPdf is dynamic-imported at the click handler so the
// 1MB jspdf vendor chunk only ships when the user actually prints a PO.



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

function POFormDialog({
  onSave,
  onSplitBySupplier,
  onClose,
  rawMaterials,
  supplierMaterialBindings,
  allSuppliers,
  prefillItems,
}: {
  onSave: (data: Record<string, unknown>) => void;
  onSplitBySupplier: (groups: Record<string, unknown>[]) => Promise<void>;
  onClose: () => void;
  rawMaterials: RawMaterial[];
  supplierMaterialBindings: SupplierMaterialBinding[];
  allSuppliers: Supplier[];
  // 2.5 — when the modal is opened from the low-stock reorder banner,
  // prefillItems is an array of POLineItem rows (already RM-bound, qty
  // suggested per max-balance). Plain Create-PO opens with [].
  prefillItems?: POLineItem[];
}) {
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<POLineItem[]>(prefillItems ?? []);
  const [rmSearch, setRmSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("ALL");

  // Active supplier id set — drives all dropdowns. INACTIVE / BLACKLISTED
  // suppliers are filtered out everywhere so the operator can never auto-pick
  // or manually pick a deactivated vendor (which would silently fail later
  // when the email-PO step runs against a dead address). Status check
  // matches procurement/maintenance.tsx's SupplierStatus union.
  const activeSupplierIds = useMemo(
    () => new Set(allSuppliers.filter((s) => s.status === "ACTIVE").map((s) => s.id)),
    [allSuppliers],
  );

  /** For a given RM code, return supplier bindings whose supplier is ACTIVE. */
  const getBindingsForRM = useCallback(
    (materialCode: string): SupplierMaterialBinding[] =>
      supplierMaterialBindings.filter(
        (b) => b.materialCode === materialCode && activeSupplierIds.has(b.supplierId),
      ),
    [supplierMaterialBindings, activeSupplierIds],
  );

  /** For a given RM code, return the main-supplier binding (or first available).
   *  Both candidates are already filtered to ACTIVE suppliers via
   *  getBindingsForRM, so we never auto-pick a deactivated vendor. */
  const getMainBinding = useCallback(
    (materialCode: string): SupplierMaterialBinding | undefined => {
      const bindings = getBindingsForRM(materialCode);
      return bindings.find((b) => b.isMainSupplier) ?? bindings[0];
    },
    [getBindingsForRM],
  );

  /** Resolve supplier name from id. */
  const resolveSupplierName = useCallback(
    (supplierId: string): string => {
      const sup = allSuppliers.find((s) => s.id === supplierId);
      return sup ? `${sup.code} - ${sup.name}` : supplierId;
    },
    [allSuppliers],
  );

  /** Suppliers list shown in the unbound-RM dropdown — ACTIVE only. */
  const activeSuppliers = useMemo(
    () => allSuppliers.filter((s) => s.status === "ACTIVE"),
    [allSuppliers],
  );

  // Active raw materials for the RM selector dropdown
  const activeRMs = useMemo(
    () => rawMaterials.filter((rm) => rm.isActive),
    [rawMaterials]
  );

  // Distinct categories with counts. Sorted alpha so the chip row is stable
  // regardless of RM insertion order. "(uncategorised)" is the bucket for RMs
  // with empty itemGroup so they don't silently disappear under the ALL chip
  // when the user filters down.
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const rm of activeRMs) {
      const cat = rm.itemGroup?.trim() || "(uncategorised)";
      counts[cat] = (counts[cat] ?? 0) + 1;
    }
    return counts;
  }, [activeRMs]);

  const categories = useMemo(
    () => Object.keys(categoryCounts).sort((a, b) => a.localeCompare(b)),
    [categoryCounts]
  );

  // Group categories by family prefix so the chip strip reads as 3 short
  // rows (Bedframe / Sofa / Common) instead of one cluttered wrap. Within
  // each group, sort by count desc so the operator's eye and finger land
  // on the heavy-traffic categories first. Anything starting with B.* or
  // B-* is bedframe; S.* / S-* is sofa; everything else is common.
  const groupedCategories = useMemo(() => {
    const isBedframe = (c: string) => /^B[.-]/i.test(c);
    const isSofa = (c: string) => /^S[.-]/i.test(c);
    const byCountDesc = (a: string, b: string) =>
      (categoryCounts[b] ?? 0) - (categoryCounts[a] ?? 0) || a.localeCompare(b);
    return {
      bedframe: categories.filter(isBedframe).sort(byCountDesc),
      sofa: categories.filter(isSofa).sort(byCountDesc),
      common: categories.filter((c) => !isBedframe(c) && !isSofa(c)).sort(byCountDesc),
    };
  }, [categories, categoryCounts]);

  // Filtered RM list — category chip + text search compose. Sorted by code so
  // browsing without a query is predictable.
  const filteredRMs = useMemo(() => {
    const q = rmSearch.trim().toLowerCase();
    return activeRMs
      .filter((rm) => {
        if (selectedCategory !== "ALL") {
          const cat = rm.itemGroup?.trim() || "(uncategorised)";
          if (cat !== selectedCategory) return false;
        }
        if (!q) return true;
        return (
          rm.itemCode.toLowerCase().includes(q) ||
          rm.description.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => a.itemCode.localeCompare(b.itemCode));
  }, [activeRMs, rmSearch, selectedCategory]);

  const addItemFromRM = (rmItemCode: string, qtyOverride?: number) => {
    const rm = rawMaterials.find((r) => r.itemCode === rmItemCode);
    if (!rm) return;

    const mainBinding = getMainBinding(rmItemCode);

    // qtyOverride lets external triggers (e.g. shortage chip on Fabric
    // Module) seed the line with a specific quantity instead of the
    // binding's MOQ default. Falls back to MOQ when no override.
    const defaultQty = mainBinding?.moq ?? 1;
    const seedQty =
      qtyOverride != null && Number.isFinite(qtyOverride) && qtyOverride > 0
        ? Math.max(qtyOverride, mainBinding?.moq ?? 1)
        : defaultQty;

    // No binding for this RM → leave supplierId empty. The line will render
    // an inline supplier dropdown (allSuppliers) and the Create button stays
    // disabled until the user picks one. See pickSupplierForUnbound below.
    const newItem: POLineItem = {
      rmCode: rm.itemCode,
      rmDescription: rm.description,
      supplierId: mainBinding?.supplierId ?? "",
      supplierName: mainBinding ? resolveSupplierName(mainBinding.supplierId) : "",
      supplierSku: mainBinding?.supplierSku ?? "",
      quantity: seedQty,
      unitPriceSen: mainBinding?.unitPrice ?? 0,
      unit: rm.baseUOM,
      leadTimeDays: mainBinding?.leadTimeDays ?? 0,
      moq: mainBinding?.moq ?? 0,
      materialCategory: rm.itemGroup,
    };

    setItems((prev) => [...prev, newItem]);
    setRmSearch("");
    // Scroll the newly-added line into view so the operator sees the row land
    // (esp. important when the RM has no main binding — the inline supplier
    // dropdown sits on the new row and would otherwise be hidden below the
    // modal scroll fold). Defer to the next paint so the row is in the DOM.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const lines = document.querySelectorAll('[data-po-line-row="true"]');
        const last = lines[lines.length - 1] as HTMLElement | undefined;
        if (last) last.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  };

  /** Set supplier on a line that has no binding yet — picked from allSuppliers
   *  rather than the (empty) supplierMaterialBindings list. supplierSku is
   *  left blank so the operator can fill it on the supplier-side later, or
   *  add a permanent binding via Maintenance. */
  const pickSupplierForUnbound = (idx: number, supplierId: string) => {
    if (!supplierId) return;
    const updated = [...items];
    updated[idx] = {
      ...updated[idx],
      supplierId,
      supplierName: resolveSupplierName(supplierId),
    };
    setItems(updated);
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

  const updateItemPrice = (idx: number, priceSen: number) => {
    const updated = [...items];
    updated[idx] = { ...updated[idx], unitPriceSen: priceSen };
    setItems(updated);
  };

  /** Swap the RM on an existing line — operator types a different rmCode in
   *  the inline picker. Re-resolves binding (supplier / supplierSku /
   *  unitPriceSen / leadTimeDays / moq / category) from the new RM. Preserves
   *  the operator's already-typed quantity (so changing PC151-01 → PC151-02
   *  doesn't reset the qty they painstakingly entered). No-op when the new
   *  rmCode doesn't match an active RM. */
  const swapItemRM = (idx: number, newRmCode: string) => {
    const trimmed = newRmCode.trim();
    if (!trimmed) return;
    const rm = rawMaterials.find((r) => r.itemCode === trimmed);
    if (!rm) return;
    const current = items[idx];
    if (current.rmCode === trimmed) return; // no-op
    const mainBinding = getMainBinding(trimmed);
    const updated = [...items];
    updated[idx] = {
      rmCode: rm.itemCode,
      rmDescription: rm.description,
      supplierId: mainBinding?.supplierId ?? "",
      supplierName: mainBinding
        ? resolveSupplierName(mainBinding.supplierId)
        : "",
      supplierSku: mainBinding?.supplierSku ?? "",
      // Keep the operator-entered quantity. If qty was 0 (default), seed
      // from the new binding's MOQ so the line is still actionable.
      quantity:
        current.quantity > 0 ? current.quantity : mainBinding?.moq ?? 1,
      unitPriceSen: mainBinding?.unitPrice ?? 0,
      unit: rm.baseUOM,
      leadTimeDays: mainBinding?.leadTimeDays ?? 0,
      moq: mainBinding?.moq ?? 0,
      materialCategory: rm.itemGroup,
    };
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
  // Any line that came from an RM with no binding and the operator hasn't
  // picked a supplier yet. Blocks Create PO submission.
  const hasUnboundLines = items.some((it) => !it.supplierId);
  const unboundCount = items.filter((it) => !it.supplierId).length;
  // Distinct populated supplier ids — used for the Split-by-Supplier helper
  // and the destructive mixed-supplier notice.
  const distinctSupplierIds = useMemo(
    () => Array.from(new Set(items.map((it) => it.supplierId).filter(Boolean))),
    [items],
  );
  const distinctSupplierCount = distinctSupplierIds.length;
  const [splitting, setSplitting] = useState(false);

  /** Build one POST payload per supplier and hand the list to the parent
   *  page's onSplitBySupplier handler, which loops sequentially with a
   *  200ms gap so generatePoNo stays deterministic. */
  const handleSplitClick = async () => {
    if (splitting) return;
    if (items.length === 0 || hasUnboundLines) return;
    if (distinctSupplierCount < 2) return;

    const bySupplier = new Map<string, POLineItem[]>();
    for (const it of items) {
      const list = bySupplier.get(it.supplierId) ?? [];
      list.push(it);
      bySupplier.set(it.supplierId, list);
    }

    const groups: Record<string, unknown>[] = [];
    for (const [sid, lines] of bySupplier) {
      groups.push({
        supplierId: sid,
        supplierName: lines[0].supplierName,
        expectedDate,
        notes,
        items: lines.map((it) => ({
          materialCategory: it.materialCategory,
          materialCode: it.rmCode,
          materialName: it.rmDescription,
          supplierSKU: it.supplierSku,
          quantity: it.quantity,
          unitPriceSen: it.unitPriceSen,
          unit: it.unit,
        })),
      });
    }

    setSplitting(true);
    try {
      await onSplitBySupplier(groups);
    } finally {
      setSplitting(false);
    }
  };

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
        materialCode: it.rmCode,
        materialName: it.rmDescription,
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
          {/* Header fields. Supplier is picked per line item below — no
              top-level supplier display (operator found it redundant and
              misleading mid-edit). 'Split by Supplier' button below still
              handles mixed-supplier carts. */}
          <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Delivery Date</label>
              <Input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
            </div>
            <div className="col-span-2 max-md:col-span-1">
              <label className="block text-sm font-medium text-[#374151] mb-1">Notes</label>
              <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Order notes..." />
            </div>
          </div>

          {/* Add item: RM code selector */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-[#374151]">Order Items</label>
            </div>

            {/* RM picker — category chips + always-visible product list. The
                operator can either click a category to narrow, type to search,
                or both compose. List stays open so RMs can be browsed without
                remembering codes. */}
            <div className="mb-3 space-y-2">
              <label className="block text-xs text-[#6B7280]">Add material — pick a category or search by code/description</label>

              {/* Category chips — grouped Bedframe / Sofa / Common, sorted by
                  count desc within each row. Tiny grey label on the left
                  anchors the family. Low-count chips (<5) fade so the heavy
                  categories pop without hiding the long-tail entirely. */}
              {(() => {
                const renderChip = (cat: string) => {
                  const active = selectedCategory === cat;
                  const count = cat === "ALL" ? activeRMs.length : (categoryCounts[cat] ?? 0);
                  const lowVolume = !active && cat !== "ALL" && count < 5;
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setSelectedCategory(cat)}
                      className={
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border transition-colors " +
                        (active
                          ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                          : lowVolume
                            ? "bg-white text-[#9CA3AF] border-[#EDE8E3] hover:bg-[#F0ECE9] hover:text-[#1F1D1B]"
                            : "bg-white text-[#1F1D1B] border-[#E2DDD8] hover:bg-[#F0ECE9]")
                      }
                      aria-pressed={active}
                    >
                      <span>{cat === "ALL" ? "All" : cat}</span>
                      <span
                        className={`text-[10px] tabular-nums ${
                          active ? "text-white/75" : "text-[#9CA3AF]"
                        }`}
                      >
                        {count}
                      </span>
                    </button>
                  );
                };
                const labelCls = "shrink-0 text-[10px] font-medium uppercase tracking-wide text-[#9CA3AF] w-12";
                const rowCls = "flex flex-wrap items-center gap-1.5";
                return (
                  <div className="space-y-1.5">
                    <div className={rowCls}>
                      <span className={labelCls}>All</span>
                      {renderChip("ALL")}
                    </div>
                    {groupedCategories.bedframe.length > 0 && (
                      <div className={rowCls}>
                        <span className={labelCls}>Bedframe</span>
                        {groupedCategories.bedframe.map(renderChip)}
                      </div>
                    )}
                    {groupedCategories.sofa.length > 0 && (
                      <div className={rowCls}>
                        <span className={labelCls}>Sofa</span>
                        {groupedCategories.sofa.map(renderChip)}
                      </div>
                    )}
                    {groupedCategories.common.length > 0 && (
                      <div className={rowCls}>
                        <span className={labelCls}>Common</span>
                        {groupedCategories.common.map(renderChip)}
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Search box */}
              <Input
                className="h-9 text-sm"
                value={rmSearch}
                onChange={(e) => setRmSearch(e.target.value)}
                placeholder="Search by RM code or description..."
              />

              {/* Always-visible product list — bounded scroll. Cap at 30 rows
                  so the modal doesn't grow unbounded; chip + search narrow. */}
              <div className="max-h-64 overflow-y-auto bg-white border border-[#E2DDD8] rounded-md">
                {filteredRMs.length === 0 ? (
                  <div className="px-3 py-4 text-sm text-[#9CA3AF] text-center">
                    No materials match this filter
                  </div>
                ) : (
                  <>
                    {filteredRMs.slice(0, 30).map((rm) => (
                      <button
                        key={rm.id}
                        type="button"
                        className="w-full text-left px-3 py-2 text-sm hover:bg-[#FAF9F7] border-b border-[#E2DDD8] last:border-b-0 flex items-center gap-2"
                        onClick={() => addItemFromRM(rm.itemCode)}
                      >
                        <Plus className="h-3 w-3 text-[#6B5C32] flex-shrink-0" />
                        <span className="font-medium text-[#1F1D1B] flex-shrink-0">{rm.itemCode}</span>
                        <span className="text-[#6B7280] truncate">{rm.description}</span>
                        <span className="text-[#9CA3AF] ml-auto flex-shrink-0">({rm.baseUOM})</span>
                      </button>
                    ))}
                    {filteredRMs.length > 30 && (
                      <div className="px-3 py-2 text-xs text-[#9CA3AF] bg-[#FAF9F7]">
                        Showing 30 of {filteredRMs.length}. Pick a category or refine search to narrow.
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>

            {items.length > 0 && (
              <div className="space-y-2">
                {items.map((item, idx) => {
                  const bindings = getBindingsForRM(item.rmCode);
                  // 2.5 — sub-header on category change. Rendered only
                  // when the previous line had a different category, so
                  // ungrouped flows (one-by-one add via search) just see
                  // a single header at top. Drives the "all fabrics low"
                  // visual when the modal is opened from the low-stock
                  // reorder banner.
                  const prevCategory = idx > 0 ? items[idx - 1].materialCategory : null;
                  const showCategoryHeader = idx === 0 || prevCategory !== item.materialCategory;
                  return (
                    <div key={idx}>
                      {showCategoryHeader && (
                        <div className="text-xs font-semibold uppercase tracking-wide text-[#6B5C32] pl-1 pb-1">
                          {item.materialCategory || "(uncategorised)"}
                        </div>
                      )}
                    <div data-po-line-row="true" className="p-3 bg-[#FAF9F7] rounded border border-[#E2DDD8] overflow-x-auto">
                      {/* Row 1: RM code, description, supplier switcher */}
                      <div className="grid grid-cols-8 gap-2 items-end" style={{ minWidth: "560px" }}>
                        <div className="col-span-2">
                          <label className="block text-xs text-[#6B7280] mb-1">RM Code</label>
                          {/* Editable RM picker — type or pick from datalist
                              autocomplete. swapItemRM commits on blur if the
                              new code resolves to an active RM; otherwise
                              the field reverts (uncontrolled input via key
                              forces re-render to current value). Keeps the
                              operator's qty so they don't lose their typing. */}
                          <input
                            key={`rm-${idx}-${item.rmCode}`}
                            type="text"
                            list={`rm-options-${idx}`}
                            defaultValue={item.rmCode}
                            onFocus={(e) => e.currentTarget.select()}
                            onBlur={(e) => {
                              const v = e.currentTarget.value.trim();
                              if (v && v !== item.rmCode) {
                                const found = rawMaterials.find(
                                  (r) => r.itemCode === v,
                                );
                                if (found) {
                                  swapItemRM(idx, v);
                                } else {
                                  // Unknown RM — restore previous value.
                                  e.currentTarget.value = item.rmCode;
                                }
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.currentTarget.blur();
                              }
                            }}
                            className="h-8 w-full px-2 text-xs font-medium text-[#1F1D1B] bg-white rounded border border-[#E2DDD8] focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
                          />
                          <datalist id={`rm-options-${idx}`}>
                            {activeRMs.map((rm) => (
                              <option key={rm.itemCode} value={rm.itemCode}>
                                {rm.description}
                              </option>
                            ))}
                          </datalist>
                        </div>
                        <div className="col-span-2">
                          <label className="block text-xs text-[#6B7280] mb-1">Description</label>
                          <div className="h-8 flex items-center px-2 text-xs text-[#374151] bg-white rounded border border-[#E2DDD8] truncate" title={item.rmDescription}>
                            {item.rmDescription}
                          </div>
                        </div>
                        <div className="col-span-2">
                          <label className="block text-xs text-[#6B7280] mb-1">
                            Supplier
                            {bindings.length === 0 && (
                              <span className="ml-1 text-[#9A3A2D]">*</span>
                            )}
                          </label>
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
                            // No binding for this RM — let the operator pick
                            // any supplier from allSuppliers. Line stays
                            // "incomplete" (Create disabled) until populated.
                            <select
                              className={`flex h-8 w-full rounded border bg-white px-2 text-xs ${
                                item.supplierId
                                  ? "border-[#E2DDD8]"
                                  : "border-[#9A3A2D] focus:ring-[#9A3A2D]/30"
                              }`}
                              value={item.supplierId}
                              onChange={(e) => pickSupplierForUnbound(idx, e.target.value)}
                            >
                              <option value="">Pick supplier…</option>
                              {activeSuppliers.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.code} - {s.name}
                                </option>
                              ))}
                            </select>
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
                      <div className="grid grid-cols-8 gap-2 items-end mt-2" style={{ minWidth: "560px" }}>
                        <div>
                          <label className="block text-xs text-[#6B7280] mb-1">Qty</label>
                          {/* Empty-string fallback so a 0 default doesn't stick after a backspace.
                              `Number("") === 0`, so internally a cleared field still maps to qty=0;
                              UI shows blank instead of "0" so the operator can type freely. */}
                          <Input
                            className="h-8 text-xs"
                            type="number"
                            onFocus={(e) => e.currentTarget.select()}
                            min={0}
                            value={item.quantity === 0 ? "" : item.quantity}
                            onChange={(e) => updateItemQty(idx, Number(e.target.value) || 0)}
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-[#6B7280] mb-1">Price (RM)</label>
                          <MoneyInput
                            className="h-8 text-xs"
                            value={item.unitPriceSen === 0 ? null : item.unitPriceSen / 100}
                            onChange={(rm) => {
                              const sen = rm !== null && rm >= 0 ? Math.round(rm * 100) : 0;
                              updateItemPrice(idx, sen);
                            }}
                          />
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
                    </div>
                  );
                })}
                <div className="text-right text-sm font-semibold text-[#1F1D1B] pr-2">
                  Total: {formatCurrency(subtotal)}
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2 pt-4 border-t border-[#E2DDD8]">
            {hasUnboundLines && (
              <p className="text-xs text-[#9A3A2D] text-right">
                Pick supplier for unbound material{unboundCount === 1 ? "" : "s"} ({unboundCount})
              </p>
            )}
            <div className="flex justify-end gap-3">
              <Button type="button" variant="outline" onClick={onClose} disabled={splitting}>Cancel</Button>
              {hasMixedSuppliers && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleSplitClick}
                  disabled={hasUnboundLines || splitting}
                  title={
                    hasUnboundLines
                      ? "Pick supplier for unbound material(s)"
                      : `Split into ${distinctSupplierCount} POs grouped by supplier`
                  }
                >
                  {splitting ? "Splitting…" : `Split by Supplier (${distinctSupplierCount})`}
                </Button>
              )}
              <Button
                type="submit"
                variant="primary"
                disabled={items.length === 0 || hasUnboundLines || hasMixedSuppliers || splitting}
                title={
                  hasUnboundLines
                    ? "Pick supplier for unbound material(s)"
                    : hasMixedSuppliers
                      ? "Lines belong to multiple suppliers — use Split by Supplier"
                      : items.length === 0
                        ? "Add at least one item"
                        : undefined
                }
              >
                Create PO
              </Button>
            </div>
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
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const navigate = useNavigate();

  // Dialog
  const [showPOForm, setShowPOForm] = useState(false);
  // 2.5 — when the operator clicks the low-stock banner we open the
  // same modal pre-populated with low-stock RMs. Cleared on close so
  // a regular "+ New PO" click doesn't inherit the prefill.
  const [poFormPrefill, setPoFormPrefill] = useState<POLineItem[] | null>(null);
  const closePOForm = useCallback(() => {
    setShowPOForm(false);
    setPoFormPrefill(null);
  }, []);

  // Filters — URL-synced so refresh / share-link land on the same view
  const [filterStatus, setFilterStatus] = useUrlState<string>("status", "");
  const [filterSupplier, setFilterSupplier] = useUrlState<string>("supplier", "");
  // Multi-Company Phase 2 — company (purchase-org) filter. Default "" = ALL
  // companies (today's view, nothing hidden). Narrows to one org code.
  const [filterCompany, setFilterCompany] = useUrlState<string>("company", "");
  const [filterDateFrom, setFilterDateFrom] = useUrlState<string>("from", "");
  const [filterDateTo, setFilterDateTo] = useUrlState<string>("to", "");
  // Show/hide filter panel — sessionStorage so closing the tab forgets,
  // but a refresh keeps the panel open if user had it open.
  const [showFilters, setShowFilters] = useSessionState<boolean>("procurement:showFilters", false);
  // Tab: all POs are Confirmed (no Drafts) — shell mirrors SO list structure
  const [tab, setTab] = useUrlState<"DRAFT" | "CONFIRMED">("tab", "CONFIRMED");
  // 4.2 — when the aging widget is clicked, only show POs whose
  // expectedDate has passed and that aren't already received / closed /
  // cancelled. Toggles off when the user clicks the widget again.
  const [filterOverdueOnly, setFilterOverdueOnly] = useState(false);
  const [gridSearch, setGridSearch] = useState("");

  // Server-side pagination for the PO list. The grid shows one 200-row page at
  // a time UNLESS a filter/search is active — then we drop pagination and pull
  // the whole dataset so the client-side filter/search can see EVERY PO, never
  // just the current page (the search-safe rule; mirrors sales/index.tsx). The
  // summary widgets read the separate /stats payload so their counts stay
  // whole-dataset regardless of which page the grid is on. 2026-08-01.
  const PO_PAGE_SIZE = 200;
  const [poPage, setPoPage] = useState(1);
  const poFiltersActive = !!(
    filterStatus ||
    filterSupplier ||
    filterCompany ||
    filterDateFrom ||
    filterDateTo ||
    filterOverdueOnly ||
    gridSearch.trim()
  );

  const { data: supResp, loading: supLoading, refresh: refreshSuppliers } = useCachedJson<{ success?: boolean; data?: Supplier[] }>("/api/suppliers");
  // Purchase Company letterhead registry — print each PO under its supplier's
  // buying company (HOOKKA / OHANA / any sister co); accounting stays HOOKKA.
  const { data: orgsResp } = useCachedJson<{ organisations?: Array<{ code?: string; name?: string; regNo?: string; tin?: string; address?: string; phone?: string; email?: string }> }>("/api/organisations");
  const { data: poResp, loading: poLoading, refresh: refreshPOs } = useCachedJson<{ success?: boolean; data?: PurchaseOrder[]; total?: number; page?: number; limit?: number }>(
    poFiltersActive
      ? // Any filter/search active → whole dataset (no page params), so the
        // client-side filter/search below sees every PO.
        "/api/purchase-orders"
      : `/api/purchase-orders?page=${poPage}&limit=${PO_PAGE_SIZE}`,
  );
  // Whole-dataset PO header rows (no line items) — drives the summary widgets so
  // their counts never shrink to just the current page. Cheap: items excluded.
  const { data: poStatsResp } = useCachedJson<{ success?: boolean; data?: PurchaseOrder[]; total?: number }>(
    "/api/purchase-orders/stats",
  );
  const { data: invResp, loading: invLoading, refresh: refreshInventory } = useCachedJson<{ success?: boolean; data?: { rawMaterials?: RawMaterial[] } }>("/api/inventory");
  const { data: bindingsResp, loading: bindingsLoading, refresh: refreshBindings } = useCachedJson<{ success?: boolean; data?: SupplierMaterialBinding[] } | SupplierMaterialBinding[]>("/api/supplier-materials");
  // 2.6 — forward-looking shortage forecast based on open SOs + BOM walk.
  // Lazy-fetched on first render; the card stays hidden if no shortages.
  type ShortageRow = {
    itemCode: string;
    description: string;
    itemGroup: string;
    balanceQty: number;
    neededQty: number;
    incomingQty: number;
    shortBy: number;
    criticalSOs: string[];
  };
  const { data: forecastResp } = useCachedJson<{ success?: boolean; data?: ShortageRow[]; horizonDate?: string }>(
    "/api/inventory/shortage-forecast",
  );

  // 4.1 — supplier OTR map. Single fetch, used by both the procurement
  // table column and any future widgets. Server-side endpoint computes OTR
  // live from purchase_orders so it stays in sync without a cron.
  type OtrMap = Record<string, { onTimeRate: number; totalPOs: number; onTimeCount: number }>;
  const { data: otrResp } = useCachedJson<{ success?: boolean; data?: OtrMap }>(
    "/api/supplier-scorecards/summary",
  );
  const otrMap: OtrMap = useMemo(
    () => (otrResp?.success ? otrResp.data ?? {} : {}),
    [otrResp],
  );

  const allSuppliers: Supplier[] = useMemo(
    () => (supResp?.success ? supResp.data ?? [] : Array.isArray(supResp) ? supResp : []),
    [supResp]
  );
  const purchaseOrders: PurchaseOrder[] = useMemo(
    () => (poResp?.success ? poResp.data ?? [] : Array.isArray(poResp) ? poResp : []),
    [poResp]
  );
  // Whole-dataset PO header rows for the summary widgets (counts + aging), so a
  // paginated grid page never makes the widget numbers shrink. Falls back to
  // the (possibly paginated) list only until /stats lands.
  const poStatsRows: PurchaseOrder[] = useMemo(
    () => (poStatsResp?.success ? poStatsResp.data ?? [] : purchaseOrders),
    [poStatsResp, purchaseOrders],
  );
  const poTotalCount = poStatsResp?.total ?? poStatsRows.length;
  const poTotalPages = Math.max(1, Math.ceil(poTotalCount / PO_PAGE_SIZE));
  // Clamp the page if the dataset shrank (a delete/filter left us past the last
  // page) so we never request an empty out-of-range page.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clamp only; guarded so it self-terminates (no render loop)
    if (poPage > poTotalPages) setPoPage(poTotalPages);
  }, [poPage, poTotalPages]);
  const rawMaterials: RawMaterial[] = useMemo(
    () => (invResp?.success ? invResp.data?.rawMaterials ?? [] : []),
    [invResp]
  );
  const supplierMaterialBindings: SupplierMaterialBinding[] = useMemo(() => {
    const bindings = (bindingsResp as { data?: SupplierMaterialBinding[] } | undefined)?.data ?? bindingsResp;
    return Array.isArray(bindings) ? bindings : [];
  }, [bindingsResp]);
  const shortageRows: ShortageRow[] = useMemo(
    () => (forecastResp?.success ? forecastResp.data ?? [] : []),
    [forecastResp],
  );
  const forecastHorizon = forecastResp?.horizonDate ?? "";
  const [shortagePanelOpen, setShortagePanelOpen] = useState(false);

  // Multi-select PO rows for the bulk Convert-to-GRN action. Mirrored back
  // from the DataGrid via `onSelectionChange` so the toolbar button can
  // gate on count + per-row eligibility (status check). Cleared after a
  // successful bulk run so the operator doesn't accidentally re-trigger
  // on the same set.
  const [selectedPOs, setSelectedPOs] = useState<PurchaseOrder[]>([]);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [bulkGrnRunning, setBulkGrnRunning] = useState(false);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);

  // Bulk DRAFT → SUBMITTED — mirrors the Sales Order bulk-confirm UX. POs
  // transition DRAFT → SUBMITTED via PUT /api/purchase-orders/:id; later
  // states (CONFIRMED / RECEIVED / etc.) are reached through the normal
  // detail-page actions.
  const bulkSubmitDrafts = useCallback(async () => {
    const drafts = selectedPOs.filter((p) => p.status === "DRAFT");
    if (drafts.length === 0) return;
    if (
      !(await confirm({
        title: "Submit drafts",
        message: `Submit ${drafts.length} draft purchase order(s)? They will move to SUBMITTED and be ready for supplier acknowledgement.`,
        danger: false,
      }))
    )
      return;
    setBulkSubmitting(true);
    let ok = 0;
    let fail = 0;
    const errors: string[] = [];
    for (const po of drafts) {
      try {
        const res = await fetch(`/api/purchase-orders/${po.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "SUBMITTED" }),
        });
        const text = await res.text();
        let d: { success?: boolean; error?: string } = {};
        try { d = JSON.parse(text); } catch { d = { error: text.slice(0, 200) }; }
        if (res.ok && d.success) ok++;
        else {
          fail++;
          if (errors.length < 3) errors.push(`${po.poNo}: ${d.error || `HTTP ${res.status}`}`);
        }
      } catch (e) {
        fail++;
        if (errors.length < 3) errors.push(`${po.poNo}: ${(e as Error).message}`);
      }
    }
    setBulkSubmitting(false);
    setSelectedPOs([]);
    invalidateCachePrefix("/api/purchase-orders");
    refreshPOs();
    if (fail > 0) {
      toast.error(`Submitted: ${ok} · Failed: ${fail}${errors.length ? " — " + errors[0] : ""}`);
    } else {
      toast.success(`Submitted ${ok} order${ok !== 1 ? "s" : ""} successfully.`);
    }
    if (ok > 0) setTab("CONFIRMED");
  }, [selectedPOs, confirm, toast, refreshPOs, setTab]);

  const loading = supLoading || poLoading || invLoading || bindingsLoading;

  // ---------------------------------------------------------------------------
  // Deep-link prefill from /procurement?prefillRm=<itemCode>&qty=<n>
  //
  // Used by the Fabric Module's negative-shortage chip — operator clicks
  // "−57.8" on PC151-10 → lands here with prefillRm=PC151-10&qty=58 (rounded
  // up). The effect waits for rawMaterials + bindings to load, builds one
  // POLineItem with the shortage qty seeded, opens the modal, and clears
  // the URL params so a refresh doesn't re-fire the prefill.
  // ---------------------------------------------------------------------------
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const prefillRm = searchParams.get("prefillRm");
    const qtyStr = searchParams.get("qty");
    if (!prefillRm) return;
    if (rawMaterials.length === 0) return; // wait for inventory load
    const rm = rawMaterials.find((r) => r.itemCode === prefillRm);
    if (!rm) {
      // RM not found — clear params so we don't loop, surface a toast.
      setSearchParams({}, { replace: true });
      toast.error(`Raw material ${prefillRm} not found`);
      return;
    }
    const bindings = supplierMaterialBindings.filter(
      (b) => b.materialCode === prefillRm,
    );
    const mainBinding =
      bindings.find((b) => b.isMainSupplier) ?? bindings[0];
    const qty = qtyStr ? Math.max(1, Math.ceil(Number(qtyStr) || 0)) : 1;
    const seedQty = mainBinding?.moq
      ? Math.max(qty, mainBinding.moq)
      : qty;
    const supplierName = mainBinding
      ? (() => {
          const sup = allSuppliers.find((s) => s.id === mainBinding.supplierId);
          return sup ? `${sup.code} - ${sup.name}` : mainBinding.supplierId;
        })()
      : "";
    const prefillItem: POLineItem = {
      rmCode: rm.itemCode,
      rmDescription: rm.description,
      supplierId: mainBinding?.supplierId ?? "",
      supplierName,
      supplierSku: mainBinding?.supplierSku ?? "",
      quantity: seedQty,
      unitPriceSen: mainBinding?.unitPrice ?? 0,
      unit: rm.baseUOM,
      leadTimeDays: mainBinding?.leadTimeDays ?? 0,
      moq: mainBinding?.moq ?? 0,
      materialCategory: rm.itemGroup,
    };
    // One-shot prefill from URL params — the alternative (subscribe to
    // an external store) would be heavier than the cascade penalty from
    // these three setState calls, which only run once on mount when the
    // user arrives via the Fabric Module shortage chip.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPoFormPrefill([prefillItem]);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShowPOForm(true);
    setSearchParams({}, { replace: true });
  }, [
    searchParams,
    rawMaterials,
    supplierMaterialBindings,
    allSuppliers,
    setSearchParams,
    toast,
  ]);

  const fetchData = useCallback(() => {
    refreshSuppliers();
    refreshPOs();
    refreshInventory();
    refreshBindings();
  }, [refreshSuppliers, refreshPOs, refreshInventory, refreshBindings]);

  // ---- PO CRUD ----
  // Returns true on success so callers (e.g. Split-by-Supplier loop) can
  // know whether to keep going. Error path surfaces server's `data.error`
  // via toast and keeps the modal open for correction.
  const handleCreatePO = async (data: Record<string, unknown>): Promise<boolean> => {
    try {
      const res = await fetch("/api/purchase-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!res.ok || !body.success) {
        toast.error(body.error || `Failed to create PO (HTTP ${res.status})`);
        return false;
      }
      invalidateCachePrefix("/api/purchase-orders");
      invalidateCachePrefix("/api/grn");
      // Fabric Module reads PO Outstanding live off purchase_order_items
      // (see src/api/lib/fabric-usage.ts computeFabricMetrics). Without
      // this invalidation, the page keeps showing the pre-PO outstanding
      // count from the SPA cache until the next manual refresh.
      invalidateCachePrefix("/api/fabric-tracking");
      refreshPOs();
      closePOForm();
      toast.success("Purchase order created");
      return true;
    } catch (err) {
      console.error("Failed to create PO:", err);
      toast.error(err instanceof Error ? err.message : "Network error creating PO");
      return false;
    }
  };

  /** Sequentially POST one PO per supplier group with a 200ms gap so
   *  generatePoNo (YYMM scan + max+1) stays deterministic across the
   *  batch. On all-success: close modal + single summary toast. On any
   *  failure: toast per-supplier error, keep modal open with un-created
   *  groups still visible (we only refresh the list, never close the
   *  modal manually here — handleCreatePO already closed on success
   *  per-call, but split mode bypasses that close until the whole
   *  batch settles). */
  const handleSplitBySupplier = async (groups: Record<string, unknown>[]) => {
    if (!groups.length) return;
    let okCount = 0;
    const failures: { supplierName: string; error: string }[] = [];

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      try {
        const res = await fetch("/api/purchase-orders", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(g),
        });
        const body = await res.json().catch(() => ({})) as { success?: boolean; error?: string };
        if (!res.ok || !body.success) {
          failures.push({
            supplierName: String(g.supplierName ?? "(unknown)"),
            error: body.error || `HTTP ${res.status}`,
          });
        } else {
          okCount++;
        }
      } catch (err) {
        failures.push({
          supplierName: String(g.supplierName ?? "(unknown)"),
          error: err instanceof Error ? err.message : "Network error",
        });
      }
      if (i < groups.length - 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    invalidateCachePrefix("/api/purchase-orders");
    invalidateCachePrefix("/api/grn");
    refreshPOs();

    if (failures.length === 0) {
      toast.success(`Created ${okCount} POs across ${groups.length} suppliers`);
      closePOForm();
    } else {
      for (const f of failures) {
        toast.error(`${f.supplierName}: ${f.error}`);
      }
      if (okCount > 0) {
        toast.warning(`${okCount}/${groups.length} POs created — fix the rest and retry`);
      }
    }
  };


  // ---- Bulk Convert-to-GRN ----
  // Per-PO eligibility: status must be one of the BULK_GRN_ELIGIBLE_STATUSES
  // AND there must be at least one line still outstanding (otherwise we'd
  // POST an empty GRN, which the backend rejects). Returns null when OK,
  // or a short reason string the toolbar tooltip surfaces.
  const reasonPOIneligible = useCallback(
    (po: PurchaseOrder): string | null => {
      if (!BULK_GRN_ELIGIBLE_STATUSES.has(po.status)) {
        return `Cannot convert: PO ${po.poNo} is ${po.status}`;
      }
      const outstanding = po.items.reduce(
        (s, it) => s + Math.max(0, it.quantity - (it.receivedQty || 0)),
        0,
      );
      if (outstanding <= 0) {
        return `Cannot convert: PO ${po.poNo} has no outstanding qty`;
      }
      return null;
    },
    [],
  );

  const ineligibleReason = useMemo(() => {
    for (const po of selectedPOs) {
      const r = reasonPOIneligible(po);
      if (r) return r;
    }
    return null;
  }, [selectedPOs, reasonPOIneligible]);

  // Sequentially: POST a full-receipt GRN per PO (using outstanding qty so
  // PARTIAL_RECEIVED top-ups also work), then PUT it to POSTED so the
  // backend cascade fires (post to stock, bump PO line receivedQty,
  // transition PO to RECEIVED, delete goods_in_transit row). Stops on
  // first failure with a toast naming the offending PO; already-POSTED
  // GRNs stay (operator finishes the rest manually). Final toast reports
  // count of GRNs and items received.
  // Bulk "Download PDF" — merge every selected PO into one file. Each PO keeps
  // its supplier's letterhead (HOOKKA / OHANA / sister co.) the same way the
  // single Print/Preview action resolves it.
  const downloadSelectedPdf = async () => {
    if (selectedPOs.length === 0 || downloadingPdf) return;
    setDownloadingPdf(true);
    try {
      const { generateCombinedPurchaseOrderPdf, letterheadForPurchaseOrg } = await import(
        "@/lib/generate-purchase-order-pdf"
      );
      await generateCombinedPurchaseOrderPdf(
        selectedPOs.map((po) => {
          const sup = allSuppliers.find((s) => s.id === po.supplierId);
          const purchaseOrgCode = sup?.purchaseOrgCode || "HOOKKA";
          return {
            po: { ...po, purchaseOrgCode },
            letterhead: letterheadForPurchaseOrg(purchaseOrgCode, orgsResp?.organisations),
          };
        }),
        `PurchaseOrders-${selectedPOs.length}.pdf`,
      );
    } catch {
      /* best-effort; button returns to idle on failure */
    } finally {
      setDownloadingPdf(false);
    }
  };

  const handleBulkConvertToGRN = useCallback(async () => {
    if (selectedPOs.length === 0 || bulkGrnRunning) return;
    if (ineligibleReason) {
      toast.error(ineligibleReason);
      return;
    }
    if (!(await confirm({ title: "Create GRN?", message: `Create GRN for ${selectedPOs.length} PO${selectedPOs.length === 1 ? "" : "s"} and clear In Transit?`, danger: false }))) {
      return;
    }
    setBulkGrnRunning(true);
    let grnsCreated = 0;
    let itemsReceived = 0;
    try {
      for (const po of selectedPOs) {
        // Build full-receipt items from outstanding qty per line. Skip
        // already-fully-received lines so we don't violate the 110%
        // over-receipt guard on PARTIAL_RECEIVED top-ups.
        const items = po.items
          .map((it, idx) => {
            const outstanding = Math.max(
              0,
              it.quantity - (it.receivedQty || 0),
            );
            return outstanding > 0
              ? {
                  poItemIndex: idx,
                  receivedQty: outstanding,
                  acceptedQty: outstanding,
                  rejectedQty: 0,
                  rejectionReason: null,
                }
              : null;
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);
        if (items.length === 0) continue;

        const createRes = await fetch("/api/grn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            poId: po.id,
            items,
            receivedBy: "Bulk Convert",
            notes: `Auto-created from bulk Convert to GRN (${po.poNo})`,
            qcStatus: "PENDING",
          }),
        });
        const createBody = (await createRes.json().catch(() => ({}))) as {
          success?: boolean;
          error?: string;
          data?: { id?: string };
        };
        if (!createRes.ok || !createBody.success || !createBody.data?.id) {
          toast.error(`PO ${po.poNo}: ${createBody.error || `Failed to create GRN (HTTP ${createRes.status})`}`);
          break;
        }

        // Flip to POSTED so the cascade runs. cascadePOStatusAfterGRNPost
        // bumps purchase_order_items.receivedQty, transitions the PO, and
        // deletes the goods_in_transit row.
        const postRes = await fetch(`/api/grn/${createBody.data.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "POSTED" }),
        });
        const postBody = (await postRes.json().catch(() => ({}))) as {
          success?: boolean;
          error?: string;
        };
        if (!postRes.ok || !postBody.success) {
          toast.error(`PO ${po.poNo}: ${postBody.error || `Failed to post GRN (HTTP ${postRes.status})`}`);
          break;
        }

        grnsCreated += 1;
        itemsReceived += items.length;
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error during bulk Convert to GRN");
    } finally {
      setBulkGrnRunning(false);
      // Always invalidate / refresh — even on a partial run, the GRNs we
      // did create need to land in the cache so the operator's next view
      // reflects reality.
      invalidateCachePrefix("/api/purchase-orders");
      invalidateCachePrefix("/api/grn");
      invalidateCachePrefix("/api/inventory");
      invalidateCachePrefix("/api/raw-materials");
      invalidateCachePrefix("/api/goods-in-transit");
      refreshPOs();
      if (grnsCreated > 0) {
        toast.success(`${grnsCreated} GRN${grnsCreated === 1 ? "" : "s"} created, ${itemsReceived} item${itemsReceived === 1 ? "" : "s"} received`);
        setSelectedPOs([]);
      }
    }
  }, [selectedPOs, bulkGrnRunning, ineligibleReason, toast, refreshPOs]);

  // ---- Filters ----
  const hasActiveFilters = filterStatus || filterSupplier || filterCompany || filterDateFrom || filterDateTo || filterOverdueOnly || gridSearch.trim();

  const clearFilters = () => {
    setSearchParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        out.delete("status");
        out.delete("supplier");
        out.delete("company");
        out.delete("from");
        out.delete("to");
        return out;
      },
      { replace: true },
    );
    setFilterOverdueOnly(false);
  };

  // Quick date presets — atomic batch so both keys land in one navigation
  const setUrlBatch = useUrlBatch();
  const applyDatePreset = (preset: "this-month" | "last-month" | "this-year") => {
    const now = new Date();
    const fmt = (d: Date) => d.toISOString().split("T")[0];
    let fromStr = "";
    let toStr = "";
    if (preset === "this-month") {
      fromStr = fmt(new Date(now.getFullYear(), now.getMonth(), 1));
      toStr = fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0));
    } else if (preset === "last-month") {
      fromStr = fmt(new Date(now.getFullYear(), now.getMonth() - 1, 1));
      toStr = fmt(new Date(now.getFullYear(), now.getMonth(), 0));
    } else {
      fromStr = fmt(new Date(now.getFullYear(), 0, 1));
      toStr = fmt(new Date(now.getFullYear(), 11, 31));
    }
    setUrlBatch({ from: fromStr, to: toStr });
  };

  // 4.2 — overdue predicate. Reused both by the widget aggregation below
  // and the filter pipeline so "click widget to filter" matches the widget
  // count exactly.
  const todayStr = useMemo(() => new Date().toISOString().split("T")[0], []);
  const isOverdue = useCallback(
    (po: PurchaseOrder): boolean => {
      if (!po.expectedDate) return false;
      const exp = po.expectedDate.split("T")[0];
      if (exp >= todayStr) return false;
      return !["RECEIVED", "CLOSED", "CANCELLED"].includes(po.status);
    },
    [todayStr],
  );
  const daysLate = useCallback(
    (po: PurchaseOrder): number => {
      if (!po.expectedDate) return 0;
      const exp = new Date(po.expectedDate.split("T")[0]).getTime();
      const now = new Date(todayStr).getTime();
      if (!Number.isFinite(exp) || !Number.isFinite(now)) return 0;
      return Math.max(0, Math.floor((now - exp) / 86400000));
    },
    [todayStr],
  );

  // Base filter (status + supplier + date + overdue) — without tab
  const filteredOrdersByUserFilters = useMemo(() => {
    return purchaseOrders.filter(po => {
      if (filterOverdueOnly && !isOverdue(po)) return false;
      if (filterStatus && po.status !== filterStatus) return false;
      if (filterSupplier && po.supplierId !== filterSupplier) return false;
      // Multi-Company Phase 2 — company filter. "" = ALL (default, nothing
      // hidden). Pre-column rows read as HOOKKA (server default).
      if (!matchesCompanyFilter(po.purchaseOrgCode, filterCompany)) return false;
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
  }, [purchaseOrders, filterStatus, filterSupplier, filterCompany, filterDateFrom, filterDateTo, filterOverdueOnly, isOverdue]);

  // Tab filter — DRAFT shows only DRAFT POs, CONFIRMED shows everything else
  const filteredOrders = useMemo(() => {
    return filteredOrdersByUserFilters.filter(po => {
      if (tab === "DRAFT" && po.status !== "DRAFT") return false;
      if (tab === "CONFIRMED" && po.status === "DRAFT") return false;
      return true;
    });
  }, [filteredOrdersByUserFilters, tab]);

  // ---- Status tab strip (count + money per state) ------------------------
  // The rows the two tabs are computed over. Under a filter that is the
  // filtered set, so the badge and the RM figure describe the same POs the grid
  // is showing; with no filter it is the whole-dataset /stats payload, so
  // neither shrinks to the current 200-row page. `gridSearch` is deliberately
  // not in the toggle — the DataGrid applies it internally and the arrays here
  // never see it, so switching source on it would make the strip lie.
  const poTabSource = useMemo(
    () =>
      (filterStatus || filterSupplier || filterCompany || filterDateFrom || filterDateTo || filterOverdueOnly)
        ? filteredOrdersByUserFilters
        : poStatsRows,
    [
      filterStatus, filterSupplier, filterCompany, filterDateFrom, filterDateTo,
      filterOverdueOnly, filteredOrdersByUserFilters, poStatsRows,
    ],
  );
  // Money = the PO's ORDERED value (its own totalSen, the grid's "Total"
  // column) — what the company has committed to spend in that state. A PO with
  // no priced lines contributes nothing rather than zero, so a Draft backlog
  // that has not been priced yet shows its count alone.
  const draftTab = useMemo(
    () => tabTotals(poTabSource.filter(po => po.status === "DRAFT"), po => po.totalSen),
    [poTabSource],
  );
  const confirmedTab = useMemo(
    () => tabTotals(poTabSource.filter(po => po.status !== "DRAFT"), po => po.totalSen),
    [poTabSource],
  );
  const draftCount = draftTab.count;
  const confirmedCount = confirmedTab.count;

  // 4.2 — aging buckets across overdue POs (count of yellow / orange / red).
  // The widget surfaces an aggregate color = the worst bucket present.
  const overduePoList = useMemo(
    () => poStatsRows.filter(isOverdue),
    [poStatsRows, isOverdue],
  );
  const agingBuckets = useMemo(() => {
    let yellow = 0;
    let orange = 0;
    let red = 0;
    for (const po of overduePoList) {
      const d = daysLate(po);
      if (d >= 31) red += 1;
      else if (d >= 8) orange += 1;
      else if (d >= 1) yellow += 1;
    }
    return { yellow, orange, red };
  }, [overduePoList, daysLate]);
  const overdueWidgetTone =
    agingBuckets.red > 0
      ? { bg: "bg-red-50", border: "border-red-200", text: "text-red-700", subtle: "text-red-500" }
      : agingBuckets.orange > 0
        ? { bg: "bg-orange-50", border: "border-orange-200", text: "text-orange-700", subtle: "text-orange-500" }
        : agingBuckets.yellow > 0
          ? { bg: "bg-amber-50", border: "border-amber-200", text: "text-amber-700", subtle: "text-amber-500" }
          : { bg: "bg-[#F0ECE9]", border: "border-[#E2DDD8]", text: "text-[#1F1D1B]", subtle: "text-[#9CA3AF]" };

  // ---- Summary stats ----
  // Note: 4.2 widget consumes overduePoList from the filter section above.
  const pendingDelivery = poStatsRows.filter((po) => ["SUBMITTED", "CONFIRMED"].includes(po.status)).length;
  const totalOutstandingQty = purchaseOrders
    .filter((po) => !["RECEIVED", "CANCELLED"].includes(po.status))
    .reduce((sum, po) => sum + po.items.reduce((s, it) => s + Math.max(0, it.quantity - (it.receivedQty || 0)), 0), 0);

  // ---- 2.5: Low-stock RMs grouped by category ----
  // Active raw_materials below minStock — feeds both the banner count and
  // the "Create from low stock" prefill payload. RMs with minStock=0 are
  // excluded (no reorder threshold set yet).
  const lowStockRMs = useMemo(() => {
    return rawMaterials
      .filter(
        (rm) =>
          rm.isActive &&
          (rm.minStock ?? 0) > 0 &&
          (rm.balanceQty ?? 0) <= (rm.minStock ?? 0),
      )
      .sort((a, b) => {
        // Group by itemGroup first so the modal renders FABRIC, FOAM, ...
        // contiguously; then alphabetical inside each group.
        const ga = a.itemGroup || "";
        const gb = b.itemGroup || "";
        if (ga !== gb) return ga.localeCompare(gb);
        return a.itemCode.localeCompare(b.itemCode);
      });
  }, [rawMaterials]);

  // Resolve supplier display name for prefill — same shape as the modal's
  // resolveSupplierName so the visual UX is identical.
  const resolveSupplierNameLocal = useCallback(
    (sid: string) => {
      const sup = allSuppliers.find((s) => s.id === sid);
      return sup ? `${sup.code} - ${sup.name}` : sid;
    },
    [allSuppliers],
  );

  // Build the prefill payload: one POLineItem per low-stock RM.
  // Suggested qty = max(maxStock - balanceQty, MOQ). Falls back to MOQ
  // when maxStock is unset or below balance.
  const buildLowStockPrefill = useCallback((): POLineItem[] => {
    return lowStockRMs.map((rm) => {
      const bindings = supplierMaterialBindings.filter(
        (b) => b.materialCode === rm.itemCode,
      );
      const main = bindings.find((b) => b.isMainSupplier) ?? bindings[0];
      const moq = main?.moq ?? 1;
      const refill = Math.max((rm.maxStock ?? 0) - (rm.balanceQty ?? 0), moq);
      const sid = main?.supplierId ?? "";
      return {
        rmCode: rm.itemCode,
        rmDescription: rm.description,
        supplierId: sid,
        supplierName: sid ? resolveSupplierNameLocal(sid) : "",
        supplierSku: main?.supplierSku ?? "",
        quantity: refill,
        unitPriceSen: main?.unitPrice ?? 0,
        unit: rm.baseUOM,
        leadTimeDays: main?.leadTimeDays ?? 0,
        moq,
        materialCategory: rm.itemGroup,
      };
    });
  }, [lowStockRMs, supplierMaterialBindings, resolveSupplierNameLocal]);

  const openLowStockReorder = () => {
    if (lowStockRMs.length === 0) return;
    setPoFormPrefill(buildLowStockPrefill());
    setShowPOForm(true);
  };

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

  // Purchase company display map: org code → legal name. Built off the
  // /api/organisations registry so badges read "Hookka Industries" instead
  // of raw "HOOKKA". Falls back to the code when no name is registered.
  const orgNameByCode = useMemo(() => {
    const out: Record<string, string> = {};
    for (const o of orgsResp?.organisations ?? []) {
      if (o.code) out[o.code] = o.name || o.code;
    }
    return out;
  }, [orgsResp]);
  // Multi-Company Phase 2 — active companies for the company filter dropdown.
  const activeOrgs = useMemo(
    () => (orgsResp?.organisations ?? []).filter((o) => o.code),
    [orgsResp],
  );

  // ---- Columns ----
  const poGridColumns: Column<PurchaseOrder>[] = useMemo(() => [
    { key: "poNo", label: "PO No", type: "docno", width: "120px", sortable: true },
    { key: "supplierName", label: "Supplier", type: "text", sortable: true },
    {
      key: "purchaseOrgCode",
      label: "Purchase co",
      type: "text",
      width: "120px",
      sortable: true,
      render: (_v: unknown, row: PurchaseOrder) => {
        const code = row.purchaseOrgCode || "HOOKKA";
        const label = orgNameByCode[code] || code;
        return (
          <span
            className="inline-flex items-center rounded px-2 py-0.5 text-xs font-medium bg-[#F0ECE9] text-[#6B5C32]"
            title={code}
          >
            {label}
          </span>
        );
      },
    },
    {
      key: "supplierOtr",
      label: "Supplier OTR%",
      type: "number",
      width: "110px",
      align: "right" as const,
      sortable: false,
      render: (_v: unknown, row: PurchaseOrder) => {
        const stat = otrMap[row.supplierId];
        if (!stat || stat.totalPOs === 0) {
          return <span className="text-[#9CA3AF]">—</span>;
        }
        const rate = stat.onTimeRate;
        const tone =
          rate >= 90
            ? "text-[#4F7C3A]"
            : rate >= 75
              ? "text-[#9C6F1E]"
              : "text-[#9A3A2D]";
        return (
          <span className={`font-medium ${tone}`} title={`${stat.onTimeCount}/${stat.totalPOs} on time`}>
            {rate.toFixed(0)}%
          </span>
        );
      },
    },
    { key: "orderDate", label: "Order Date", type: "date", width: "110px", sortable: true },
    { key: "expectedDate", label: "Expected Date", type: "date", width: "110px", sortable: true },
    { key: "items.length", label: "Items", type: "number", width: "70px", align: "right", sortable: true,
      render: (_v: unknown, row: PurchaseOrder) => <span>{row.items.length}</span>,
    },
    {
      key: "orderedQty",
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
      key: "outstandingQty",
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
  ], [otrMap, orgNameByCode]);

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
        action: async () => {
          const { generatePurchaseOrderPdf, letterheadForPurchaseOrg } = await import("@/lib/generate-purchase-order-pdf");
          // Print under the supplier's Purchase Company (HOOKKA / OHANA / any
          // sister co in the registry). Accounting stays HOOKKA.
          const sup = allSuppliers.find((s) => s.id === row.supplierId);
          const purchaseOrgCode = sup?.purchaseOrgCode || "HOOKKA";
          const lh = letterheadForPurchaseOrg(purchaseOrgCode, orgsResp?.organisations);
          generatePurchaseOrderPdf({ ...row, purchaseOrgCode }, lh);
        },
      },
      { label: "", separator: true, action: () => {} },
      {
        label: "Refresh",
        icon: <RefreshCw className="h-3.5 w-3.5" />,
        action: () => fetchData(),
      },
    ];
  }, [navigate, fetchData, allSuppliers]);

  if (loading) {
    // Shaped page skeleton instead of a bare centered spinner — fixes the
    // "整页空白转圈" feel on cold load. Display-only; no data path touched.
    return <PageSkeleton />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Purchase Orders</h1>
          <p className="text-xs text-[#6B7280]">Create and manage purchase orders using internal material codes</p>
        </div>
        {/* Toolbar entry routes to the full-page form. The modal-based
            POFormDialog below is retained for the deep-link prefill case
            (Fabric Module shortage chip → /procurement?prefillRm=…) and
            the Low-Stock reorder banner ("Create PO from Low Stock"),
            both of which open with seeded line items where the compact
            modal still feels right. Plain "New PO" gets the breathing
            room of the full page. */}
        <Button variant="primary" onClick={() => navigate("/procurement/create")}>
          <Plus className="h-4 w-4" /> New Purchase Order
        </Button>
      </div>

      {/* Summary Cards — gold card style: colored icon-box LEFT + text-2xl number */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#F0ECE9] p-2.5 shrink-0">
              <FileText className="h-5 w-5 text-[#6B5C32]" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-[#1F1D1B]">{poTotalCount}</p>
              <p className="text-xs text-[#6B7280]">Total POs</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#E0EDF0] p-2.5 shrink-0">
              <Truck className="h-5 w-5 text-[#3E6570]" />
            </div>
            <div className="min-w-0">
              <p className="text-2xl font-bold text-[#3E6570]">{pendingDelivery}</p>
              <p className="text-xs text-[#6B7280]">Pending Delivery</p>
            </div>
          </CardContent>
        </Card>
        {/* 4.2 — Aging widget. Click toggles the overdue-only filter on the
            PO table below. Background colour is graded by the most-overdue
            PO in the set (yellow 1-7d / orange 8-30d / red 30d+). The
            inline aging-bar shows the count distribution. */}
        <Card
          className={cn(
            "cursor-pointer transition-colors",
            overduePoList.length > 0 ? `${overdueWidgetTone.bg} ${overdueWidgetTone.border}` : "",
            filterOverdueOnly ? "ring-2 ring-[#6B5C32]" : "",
          )}
          onClick={() => {
            if (overduePoList.length === 0) return;
            setFilterOverdueOnly((v) => !v);
          }}
          title={
            overduePoList.length === 0
              ? "No overdue POs"
              : filterOverdueOnly
                ? "Click to clear overdue filter"
                : "Click to filter the table to overdue POs only"
          }
        >
          <CardContent className="p-4 flex items-center gap-3">
            <div className={cn(
              "rounded-lg p-2.5 shrink-0",
              overduePoList.length > 0 ? `${overdueWidgetTone.bg} border ${overdueWidgetTone.border}` : "bg-[#F0ECE9]",
            )}>
              <AlertTriangle className={cn("h-5 w-5", overduePoList.length > 0 ? overdueWidgetTone.text : "text-[#E2DDD8]")} />
            </div>
            <div className="min-w-0">
              <p className={cn("text-2xl font-bold", overduePoList.length > 0 ? overdueWidgetTone.text : "text-[#1F1D1B]")}>
                {overduePoList.length}
              </p>
              <p className="text-xs text-[#6B7280]">Overdue POs</p>
              {overduePoList.length > 0 && (
                <p className={cn("mt-0.5 text-[11px]", overdueWidgetTone.subtle)}>
                  {agingBuckets.yellow} yellow · {agingBuckets.orange} orange · {agingBuckets.red} red
                </p>
              )}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#FAEFCB] p-2.5 shrink-0">
              <Package className="h-5 w-5 text-[#9C6F1E]" />
            </div>
            <div className="min-w-0">
              <p className={cn("text-2xl font-bold", totalOutstandingQty > 0 ? "text-[#9C6F1E]" : "text-[#1F1D1B]")}>{totalOutstandingQty}</p>
              <p className="text-xs text-[#6B7280]">Outstanding Qty</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 2.5 + 2.6 — reorder banner (current minStock breach) and forecast
          card (BOM-driven projection). Side-by-side at md+. The two answer
          different questions: "what's already low" vs "what will be short
          for committed SOs". */}
      <div className={`grid gap-3 ${shortageRows.length > 0 && lowStockRMs.length > 0 ? "md:grid-cols-2" : ""}`}>
      {lowStockRMs.length > 0 && (
        <Card className="border-[#9C6F1E]/30 bg-[#FEF8EC]">
          <CardContent className="p-3 flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-[#9C6F1E] mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-semibold text-[#1F1D1B]">
                  {lowStockRMs.length} raw material{lowStockRMs.length === 1 ? "" : "s"} below minStock
                </p>
                <p className="text-xs text-[#6B7280] mt-0.5">
                  Click to open a draft PO pre-populated with these items, grouped by category.
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={openLowStockReorder}>
              Create PO from Low Stock
            </Button>
          </CardContent>
        </Card>
      )}

      {/* 2.6 — Forecasted shortages card. Click expands a panel with the
          top shortages by qty short. Hidden when no shortages so the page
          stays calm. */}
      {shortageRows.length > 0 && (
        <Card className="border-[#9A3A2D]/30 bg-[#FBEEE9]">
          <CardContent className="p-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-start gap-3">
                <TrendingDown className="h-5 w-5 text-[#9A3A2D] mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm font-semibold text-[#1F1D1B]">
                    Forecasted shortages: {shortageRows.length} item{shortageRows.length === 1 ? "" : "s"} short before {forecastHorizon || "+14 days"}
                  </p>
                  <p className="text-xs text-[#6B7280] mt-0.5">
                    BOM-driven projection across CONFIRMED + IN_PRODUCTION sales orders, after current balance + open POs.
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShortagePanelOpen((v) => !v)}
              >
                {shortagePanelOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                {shortagePanelOpen ? "Hide" : "View"} Top Shortages
              </Button>
            </div>
            {shortagePanelOpen && (
              <div className="mt-3 pt-3 border-t border-[#9A3A2D]/20">
                <div className="rounded-md border border-[#E2DDD8] overflow-hidden bg-white">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                        <th className="h-9 px-3 text-left font-medium text-[#374151]">Item</th>
                        <th className="h-9 px-3 text-left font-medium text-[#374151]">Group</th>
                        <th className="h-9 px-3 text-right font-medium text-[#374151]">On hand</th>
                        <th className="h-9 px-3 text-right font-medium text-[#374151]">Needed</th>
                        <th className="h-9 px-3 text-right font-medium text-[#374151]">Incoming</th>
                        <th className="h-9 px-3 text-right font-medium text-[#374151]">Short by</th>
                        <th className="h-9 px-3 text-left font-medium text-[#374151]">Critical SOs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shortageRows.slice(0, 25).map((row) => (
                        <tr key={row.itemCode} className="border-b border-[#E2DDD8] last:border-b-0">
                          <td className="h-9 px-3">
                            <span className="font-medium text-[#6B5C32]">{row.itemCode}</span>
                            <span className="text-[#6B7280] ml-1">{row.description}</span>
                          </td>
                          <td className="h-9 px-3 text-[#6B7280]">{row.itemGroup}</td>
                          <td className="h-9 px-3 text-right text-[#4B5563]">{row.balanceQty}</td>
                          <td className="h-9 px-3 text-right text-[#4B5563]">{row.neededQty}</td>
                          <td className="h-9 px-3 text-right text-[#4B5563]">{row.incomingQty}</td>
                          <td className="h-9 px-3 text-right font-bold text-[#9A3A2D]">{row.shortBy}</td>
                          <td className="h-9 px-3 text-[#6B7280] truncate max-w-[200px]" title={row.criticalSOs.join(", ")}>
                            {row.criticalSOs.slice(0, 3).join(", ")}
                            {row.criticalSOs.length > 3 ? ` +${row.criticalSOs.length - 3}` : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {shortageRows.length > 25 && (
                  <p className="text-xs text-[#6B7280] mt-2">
                    Showing 25 of {shortageRows.length} shortage rows. Refer to MRP for the full plan.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between flex-wrap gap-3 mb-3">
            <div className="flex items-center gap-2 flex-wrap">
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
                  Showing {filteredOrders.length} of {poTotalCount} orders
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {/* Bulk Convert to GRN — appears as soon as any PO row is
                  selected, so the operator's first checkbox click reveals
                  the action. Disabled (with tooltip) when any selected PO
                  isn't in an eligible status, instead of silently filtering
                  the bad rows — surfaces the constraint up front. */}
              {selectedPOs.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={downloadingPdf}
                  onClick={downloadSelectedPdf}
                >
                  <Download className="h-4 w-4" />{" "}
                  {downloadingPdf
                    ? "Preparing…"
                    : `Download PDF (${selectedPOs.length})`}
                </Button>
              )}
              {selectedPOs.length > 0 && (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleBulkConvertToGRN}
                  disabled={!!ineligibleReason || bulkGrnRunning}
                  title={
                    ineligibleReason
                      ? ineligibleReason
                      : `Create full-receipt GRN for ${selectedPOs.length} PO${selectedPOs.length === 1 ? "" : "s"} and clear In Transit`
                  }
                >
                  <ClipboardCheck className="h-4 w-4" />
                  {bulkGrnRunning
                    ? "Converting…"
                    : `Convert ${selectedPOs.length} to GRN`}
                </Button>
              )}
            </div>
          </div>

          {showFilters && (
            <>
              <div className="flex flex-wrap items-center gap-2 pt-3 pb-1 border-t border-[#E2DDD8]">
                <span className="text-xs text-[#9CA3AF]">Quick:</span>
                <Button variant="outline" size="sm" onClick={() => applyDatePreset("this-month")}>
                  This Month
                </Button>
                <Button variant="outline" size="sm" onClick={() => applyDatePreset("last-month")}>
                  Last Month
                </Button>
                <Button variant="outline" size="sm" onClick={() => applyDatePreset("this-year")}>
                  This Year
                </Button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 pt-2">
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
                  {/* Multi-Company Phase 2 — company filter. Default "All
                      Companies" shows every PO (nothing hidden). */}
                  <label className="block text-xs text-[#9CA3AF] mb-1">Company</label>
                  <select
                    value={filterCompany}
                    onChange={(e) => setFilterCompany(e.target.value)}
                    className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                  >
                    <option value="">All Companies</option>
                    {activeOrgs.map((o) => (
                      <option key={o.code} value={o.code}>{o.name || o.code}</option>
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
            </>
          )}
        </CardContent>
      </Card>

      {/* Purchase Orders */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <ShoppingBag className="h-5 w-5 text-[#6B5C32]" />
              Purchase Orders
            </CardTitle>
            {/* Draft / Confirmed toggle — mirrors SO list shell.
                POs are all Confirmed (no DRAFT workflow); the Draft tab shows
                the real count so if any slip through they're visible. */}
            <StatusTabStrip
              value={tab}
              onChange={(k) => { setTab(k as "DRAFT" | "CONFIRMED"); setSelectedPOs([]); }}
              moneyLabel="Ordered value"
              ariaLabel="Purchase order status"
              tabs={[
                {
                  key: "DRAFT",
                  label: "Draft",
                  count: draftCount,
                  valueSen: draftTab.valueSen,
                  activeClass: "bg-[#FAEFCB] text-[#9C6F1E] font-medium shadow-sm",
                },
                {
                  key: "CONFIRMED",
                  label: "Confirmed",
                  count: confirmedCount,
                  valueSen: confirmedTab.valueSen,
                  activeClass: "bg-[#E0EDF0] text-[#3E6570] font-medium shadow-sm",
                },
              ]}
            />
          </div>
        </CardHeader>
        <CardContent>
          {tab === "DRAFT" && selectedPOs.length > 0 && (
            <div className="mb-3 flex items-center justify-between rounded-md border border-[#E8D597] bg-[#FAEFCB] px-3 py-2 text-sm">
              <span className="text-[#9C6F1E]">
                {selectedPOs.filter((p) => p.status === "DRAFT").length} draft PO(s) selected
              </span>
              <Button
                variant="primary"
                size="sm"
                disabled={bulkSubmitting}
                onClick={bulkSubmitDrafts}
              >
                <ClipboardCheck className="h-4 w-4" />{" "}
                {bulkSubmitting
                  ? "Submitting..."
                  : `Submit ${selectedPOs.filter((p) => p.status === "DRAFT").length} drafts`}
              </Button>
            </div>
          )}
          <DataGrid<PurchaseOrder>
            columns={poGridColumns}
            data={filteredOrders}
            keyField="id"
            loading={loading}
            stickyHeader={true}
            virtualize
            selectable={true}
            onSelectionChange={setSelectedPOs}
            onDoubleClick={(row) => navigate(`/procurement/${row.id}`)}
            contextMenuItems={poGridContextMenu}
            maxHeight="calc(100vh - 300px)"
            emptyMessage={tab === "DRAFT" ? "No draft purchase orders." : "No purchase orders found."}
            onSearchChange={setGridSearch}
            gridId="purchase-orders-list"
            exportName="purchase-orders"
            exportSheetLabel="Purchase Orders"
            detailExport={{ label: "Detail Listing", build: (rows) => buildPoDetailListingAoa(rows) }}
          />
          {/* Server-side page controls — only in the default (unfiltered) view.
              When a filter/search is active the whole dataset is loaded and the
              grid shows every match, so paging would be meaningless (and is
              hidden). */}
          {!poFiltersActive && poTotalPages > 1 && (
            <div className="flex items-center justify-center gap-3 py-3 border-t border-[#F0ECE9]">
              <Button
                variant="outline"
                size="sm"
                disabled={poPage <= 1 || poLoading}
                onClick={() => setPoPage((p) => Math.max(1, p - 1))}
              >
                ← Prev
              </Button>
              <span className="text-sm text-[#6B7280]">
                Page {poPage} / {poTotalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={poPage >= poTotalPages || poLoading}
                onClick={() => setPoPage((p) => Math.min(poTotalPages, p + 1))}
              >
                Next →
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* PO Form Dialog */}
      {showPOForm && (
        <POFormDialog
          onSave={handleCreatePO}
          onSplitBySupplier={handleSplitBySupplier}
          onClose={closePOForm}
          rawMaterials={rawMaterials}
          supplierMaterialBindings={supplierMaterialBindings}
          allSuppliers={allSuppliers}
          prefillItems={poFormPrefill ?? undefined}
        />
      )}

    </div>
  );
}
