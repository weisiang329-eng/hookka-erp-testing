// ---------------------------------------------------------------------------
// New Purchase Order — full-page form.
//
// Replaces the cramped modal in src/pages/procurement/index.tsx (the modal is
// retained for the deep-link prefill case from the Fabric Module's shortage
// chip and for the "Create PO from Low Stock" banner — both seeded flows
// kept the modal's compact one-shot UX). The toolbar's "+ New Purchase
// Order" button now navigates here.
//
// Layout mirrors src/pages/sales/create.tsx + src/pages/consignment/create.tsx
// so visual style stays consistent across the three create flows:
//   • Top header strip (back arrow + title + Cancel/Save buttons)
//   • 1-2 column grid: Order Details card (left, lg:col-span-2) +
//     Summary card (right)
//   • Order Items card spans full width below — full-width line-item table
//     with generous column widths so RM Code / Description / Supplier /
//     Supplier SKU / Qty / Price / Unit / Lead / MOQ / Delete all sit on
//     one row without overflow.
//
// The line-item handlers (auto-binding, supplier resolution, RM swap,
// category-chip grouping) are ported verbatim from POFormDialog so behaviour
// is identical to the modal — only the surrounding shell + column widths
// change. Backend endpoint POST /api/purchase-orders is reused unchanged.
// ---------------------------------------------------------------------------

import React, { useState, useCallback, useEffect, useMemo, Suspense } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { formatCurrency, formatRM } from "@/lib/utils";
import type { Supplier, SupplierMaterialBinding, RawMaterial } from "@/types";
import { ArrowLeft, Plus, Save, Trash2 } from "lucide-react";

// Same shape used by the modal in procurement/index.tsx — kept identical
// so the POST payload matches what the existing /api/purchase-orders
// handler already accepts. If this drifts the supplier-binding auto-fill
// also drifts, hence the duplication is intentional.
type POLineItem = {
  rmCode: string;
  rmDescription: string;
  supplierId: string;
  supplierName: string;
  supplierSku: string;
  quantity: number;
  unitPriceSen: number;
  unit: string;
  leadTimeDays: number;
  moq: number;
  materialCategory: string;
};

// Normalise a material code for tolerant matching. A binding's materialCode is
// typed by hand in the Supplier-Material Bindings page, so trivial formatting
// diffs (case, stray/duplicated spaces) used to silently fail to match the RM's
// itemCode — the PO then showed ALL suppliers instead of the bound ones (owner
// 2026-06-18). Exact match still wins first; this only rescues near-misses.
const normMatCode = (s: string) => s.trim().toUpperCase().replace(/\s+/g, " ");

export default function CreatePurchaseOrderPageWrapper() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64 text-[#9CA3AF]">Loading...</div>}>
      <CreatePurchaseOrderPage />
    </Suspense>
  );
}

function CreatePurchaseOrderPage() {
  const navigate = useNavigate();
  const { toast } = useToast();

  // Data fetches — same endpoints procurement/index.tsx uses, so
  // useCachedJson dedupes (the operator typically arrives here from
  // /procurement which already warmed the cache).
  const { data: supResp } = useCachedJson<{ success?: boolean; data?: Supplier[] }>("/api/suppliers");
  // perf 2026-08-13 (BUG-2026-08-13-021, audit finding D12): `?buckets=` — only
  // `rawMaterials` is read here (the line picker), so the 365-row product
  // catalogue and the WIP bucket no longer ride along.
  const { data: invResp } = useCachedJson<{ success?: boolean; data?: { rawMaterials?: RawMaterial[] } }>("/api/inventory?buckets=rawMaterials");
  const { data: bindingsResp } = useCachedJson<{ success?: boolean; data?: SupplierMaterialBinding[] } | SupplierMaterialBinding[]>("/api/supplier-materials");
  // Purchase Company registry — feeds the per-PO buying-company dropdown.
  // Same endpoint pi.tsx / index.tsx use, so the cache is warmed.
  const { data: orgsResp } = useCachedJson<{ organisations?: Array<{ code: string; name: string; isActive?: boolean }> }>("/api/organisations");

  const allSuppliers: Supplier[] = useMemo(
    () => (supResp?.success ? supResp.data ?? [] : Array.isArray(supResp) ? supResp : []),
    [supResp],
  );
  const rawMaterials: RawMaterial[] = useMemo(
    () => (invResp?.success ? invResp.data?.rawMaterials ?? [] : []),
    [invResp],
  );
  const supplierMaterialBindings: SupplierMaterialBinding[] = useMemo(() => {
    const bindings = (bindingsResp as { data?: SupplierMaterialBinding[] } | undefined)?.data ?? bindingsResp;
    return Array.isArray(bindings) ? bindings : [];
  }, [bindingsResp]);

  // ── Form state ────────────────────────────────────────────────
  const [expectedDate, setExpectedDate] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<POLineItem[]>([]);
  const [rmSearch, setRmSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<string>("ALL");
  const [saving, setSaving] = useState(false);
  // Primary supplier chosen in Order Details. Drives material picker
  // filtering — only materials offered by this supplier appear in the
  // add-material list once a supplier is selected.
  const [selectedSupplierId, setSelectedSupplierId] = useState<string>("");
  // Purchase company (HOOKKA / OHANA / sister co) that buys on this PO.
  // Prefilled from the picked supplier's default; always overridable.
  const [purchaseOrgCode, setPurchaseOrgCode] = useState<string>("HOOKKA");

  // Active Purchase Company options for the dropdown.
  const activeOrgs = useMemo(
    () => (orgsResp?.organisations ?? []).filter((o) => o.isActive !== false),
    [orgsResp],
  );

  // ── Derived: supplier helpers (ACTIVE-only filtering) ─────────
  const activeSupplierIds = useMemo(
    () => new Set(allSuppliers.filter((s) => s.status === "ACTIVE").map((s) => s.id)),
    [allSuppliers],
  );

  const activeSuppliers = useMemo(
    () => allSuppliers.filter((s) => s.status === "ACTIVE"),
    [allSuppliers],
  );

  const getBindingsForRM = useCallback(
    (materialCode: string): SupplierMaterialBinding[] => {
      const active = supplierMaterialBindings.filter((b) =>
        activeSupplierIds.has(b.supplierId),
      );
      const exact = active.filter((b) => b.materialCode === materialCode);
      if (exact.length > 0) return exact;
      // Fallback: tolerant code match so a hand-typed binding with only a case /
      // spacing diff still links to this RM (exact wins above, so a correct
      // binding is never overridden).
      const key = normMatCode(materialCode);
      return active.filter((b) => normMatCode(b.materialCode) === key);
    },
    [supplierMaterialBindings, activeSupplierIds],
  );

  const getMainBinding = useCallback(
    (materialCode: string): SupplierMaterialBinding | undefined => {
      const bindings = getBindingsForRM(materialCode);
      return bindings.find((b) => b.isMainSupplier) ?? bindings[0];
    },
    [getBindingsForRM],
  );

  const resolveSupplierName = useCallback(
    (supplierId: string): string => {
      const sup = allSuppliers.find((s) => s.id === supplierId);
      return sup ? `${sup.code} - ${sup.name}` : supplierId;
    },
    [allSuppliers],
  );

  // Returns bindings for a material sorted main-first, then by supplier name.
  // Used in the per-line supplier dropdown so the main supplier appears first
  // and the owner can compare prices at a glance.
  const getSortedBindingsForRM = useCallback(
    (materialCode: string): SupplierMaterialBinding[] => {
      const bindings = getBindingsForRM(materialCode);
      return [...bindings].sort((a, b) => {
        if (a.isMainSupplier && !b.isMainSupplier) return -1;
        if (!a.isMainSupplier && b.isMainSupplier) return 1;
        return resolveSupplierName(a.supplierId).localeCompare(
          resolveSupplierName(b.supplierId),
        );
      });
    },
    [getBindingsForRM, resolveSupplierName],
  );

  // Label shown in the per-line supplier dropdown: "CLM ETERNAL — RM 68.00"
  // so the owner can compare prices without opening a separate page.
  const supplierOptionLabel = useCallback(
    (b: SupplierMaterialBinding): string => {
      const name = resolveSupplierName(b.supplierId);
      const price = b.unitPrice > 0 ? ` — ${formatRM(b.unitPrice)}` : "";
      return `${name}${price}`;
    },
    [resolveSupplierName],
  );

  // ── Derived: RM picker (category chips + search) ──────────────
  const activeRMs = useMemo(
    () => rawMaterials.filter((rm) => rm.isActive),
    [rawMaterials],
  );

  // Set of normalised material codes offered by the selected supplier.
  // When no supplier is selected this is null (no filtering applied).
  const supplierMaterialCodes = useMemo<Set<string> | null>(() => {
    if (!selectedSupplierId) return null;
    const codes = new Set<string>();
    for (const b of supplierMaterialBindings) {
      if (b.supplierId === selectedSupplierId) {
        codes.add(normMatCode(b.materialCode));
      }
    }
    return codes;
  }, [selectedSupplierId, supplierMaterialBindings]);

  // Active RMs optionally filtered to the selected supplier's offerings.
  const pickerRMs = useMemo(() => {
    if (!supplierMaterialCodes) return activeRMs;
    return activeRMs.filter((rm) => supplierMaterialCodes.has(normMatCode(rm.itemCode)));
  }, [activeRMs, supplierMaterialCodes]);

  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const rm of pickerRMs) {
      const cat = rm.itemGroup?.trim() || "(uncategorised)";
      counts[cat] = (counts[cat] ?? 0) + 1;
    }
    return counts;
  }, [pickerRMs]);

  const categories = useMemo(
    () => Object.keys(categoryCounts).sort((a, b) => a.localeCompare(b)),
    [categoryCounts],
  );

  // Same Bedframe / Sofa / Common grouping the modal added in 8dc1644.
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

  const filteredRMs = useMemo(() => {
    const q = rmSearch.trim().toLowerCase();
    return pickerRMs
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
  }, [pickerRMs, rmSearch, selectedCategory]);

  // ── Line-item mutators ─────────────────────────────────────────
  const addItemFromRM = (rmItemCode: string) => {
    const rm = rawMaterials.find((r) => r.itemCode === rmItemCode);
    if (!rm) return;
    // When a primary supplier is selected, prefer its binding; fall back to
    // the global main binding (isMainSupplier flag) if the chosen supplier
    // has no binding for this material (shouldn't happen with filtered list,
    // but guards against stale cache or a direct search-bypass).
    const allBindings = getBindingsForRM(rmItemCode);
    const mainBinding =
      (selectedSupplierId
        ? allBindings.find((b) => b.supplierId === selectedSupplierId)
        : undefined) ?? getMainBinding(rmItemCode);
    const seedQty = mainBinding?.moq ?? 1;
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
    // Scroll the newly-added line into view — same trick as the modal,
    // but the page can grow taller so it really helps.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const lines = document.querySelectorAll('[data-po-line-row="true"]');
        const last = lines[lines.length - 1] as HTMLElement | undefined;
        if (last) last.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  };

  const pickSupplierForUnbound = (idx: number, supplierId: string) => {
    if (!supplierId) return;
    setItems((prev) => {
      const next = [...prev];
      next[idx] = {
        ...next[idx],
        supplierId,
        supplierName: resolveSupplierName(supplierId),
      };
      return next;
    });
  };

  const switchSupplier = (idx: number, supplierId: string) => {
    setItems((prev) => {
      const item = prev[idx];
      const wantCode = normMatCode(item.rmCode);
      const binding = supplierMaterialBindings.find(
        (b) => normMatCode(b.materialCode) === wantCode && b.supplierId === supplierId,
      );
      if (!binding) return prev;
      const next = [...prev];
      next[idx] = {
        ...next[idx],
        supplierId: binding.supplierId,
        supplierName: resolveSupplierName(binding.supplierId),
        supplierSku: binding.supplierSku,
        unitPriceSen: binding.unitPrice,
        leadTimeDays: binding.leadTimeDays,
        moq: binding.moq,
      };
      return next;
    });
  };

  const updateItemQty = (idx: number, qty: number) => {
    setItems((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], quantity: qty };
      return next;
    });
  };

  const updateItemPrice = (idx: number, priceSen: number) => {
    setItems((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], unitPriceSen: priceSen };
      return next;
    });
  };

  // Swap RM on an existing line (operator types a new code in the inline
  // RM picker). Same ported behaviour as the modal — preserves the
  // operator-typed quantity unless it was 0, in which case fall back to
  // the new binding's MOQ.
  const swapItemRM = (idx: number, newRmCode: string) => {
    const trimmed = newRmCode.trim();
    if (!trimmed) return;
    const rm = rawMaterials.find((r) => r.itemCode === trimmed);
    if (!rm) return;
    setItems((prev) => {
      const current = prev[idx];
      if (current.rmCode === trimmed) return prev;
      const mainBinding = getMainBinding(trimmed);
      const next = [...prev];
      next[idx] = {
        rmCode: rm.itemCode,
        rmDescription: rm.description,
        supplierId: mainBinding?.supplierId ?? "",
        supplierName: mainBinding ? resolveSupplierName(mainBinding.supplierId) : "",
        supplierSku: mainBinding?.supplierSku ?? "",
        quantity: current.quantity > 0 ? current.quantity : mainBinding?.moq ?? 1,
        unitPriceSen: mainBinding?.unitPrice ?? 0,
        unit: rm.baseUOM,
        leadTimeDays: mainBinding?.leadTimeDays ?? 0,
        moq: mainBinding?.moq ?? 0,
        materialCategory: rm.itemGroup,
      };
      return next;
    });
  };

  const removeItem = (idx: number) => {
    setItems((prev) => prev.filter((_, i) => i !== idx));
  };

  // ── Derived totals + multi-supplier detection ─────────────────
  const subtotal = items.reduce((s, i) => s + i.quantity * i.unitPriceSen, 0);
  const totalQty = items.reduce((s, i) => s + i.quantity, 0);

  const headerSupplierId = items.length > 0 ? items[0].supplierId : "";
  const headerSupplierName = items.length > 0 ? items[0].supplierName : "";
  const hasMixedSuppliers =
    items.length > 1 && items.some((it) => it.supplierId !== items[0].supplierId);
  const hasUnboundLines = items.some((it) => !it.supplierId);
  const unboundCount = items.filter((it) => !it.supplierId).length;
  const distinctSupplierIds = useMemo(
    () => Array.from(new Set(items.map((it) => it.supplierId).filter(Boolean))),
    [items],
  );
  const distinctSupplierCount = distinctSupplierIds.length;

  // ── Submit handlers ───────────────────────────────────────────
  // Owner ruling 2026-06-21: a MANUALLY-created PO goes straight to its active
  // CONFIRMED state (no Draft). PO has no OCR path, so every create here is
  // manual. The backend POST takes body.status verbatim (defaults to DRAFT
  // only when omitted) — send CONFIRMED so the PO is active on creation.
  const buildPayload = () => ({
    supplierId: headerSupplierId,
    supplierName: headerSupplierName,
    status: "CONFIRMED",
    purchaseOrgCode,
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

  const handleSave = async () => {
    if (saving) return;
    if (items.length === 0) {
      toast.error("Add at least one item");
      return;
    }
    if (hasUnboundLines) {
      toast.error(`Pick supplier for unbound material${unboundCount === 1 ? "" : "s"}`);
      return;
    }
    if (hasMixedSuppliers) {
      toast.error("Lines belong to multiple suppliers — use Split by Supplier");
      return;
    }
    if (!headerSupplierId) {
      toast.error("Supplier missing");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/purchase-orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
      });
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: { id?: string } };
      if (!res.ok || !body.success) {
        toast.error(body.error || `Failed to create PO (HTTP ${res.status})`);
        return;
      }
      invalidateCachePrefix("/api/purchase-orders");
      invalidateCachePrefix("/api/grn");
      // Fabric Module reads PO Outstanding live off purchase_order_items
      // (see src/api/lib/fabric-usage.ts computeFabricMetrics). Without
      // this invalidation, the page keeps showing the pre-PO outstanding
      // count from the SPA cache until the next manual refresh.
      invalidateCachePrefix("/api/fabric-tracking");
      toast.success("Purchase order created");
      navigate("/procurement");
    } catch (err) {
      console.error("Failed to create PO:", err);
      toast.error(err instanceof Error ? err.message : "Network error creating PO");
    } finally {
      setSaving(false);
    }
  };

  // Split-by-Supplier — sequentially POST one PO per supplier group with
  // a 200ms gap so generatePoNo stays deterministic across the batch.
  // Mirrors the modal's handleSplitBySupplier in procurement/index.tsx.
  const handleSplitBySupplier = async () => {
    if (saving) return;
    if (items.length === 0 || hasUnboundLines || distinctSupplierCount < 2) return;

    const bySupplier = new Map<string, POLineItem[]>();
    for (const it of items) {
      const list = bySupplier.get(it.supplierId) ?? [];
      list.push(it);
      bySupplier.set(it.supplierId, list);
    }

    setSaving(true);
    let okCount = 0;
    const failures: { supplierName: string; error: string }[] = [];

    const groups = Array.from(bySupplier.entries()).map(([sid, lines]) => {
      // Per-supplier Purchase company: prefer THAT supplier's default so a
      // split across companies (e.g. HOOKKA + OHANA suppliers in one cart)
      // produces correctly-companied POs. Falls back to the form-level
      // selection if the supplier has no default.
      const sup = allSuppliers.find((s) => s.id === sid);
      const supOrg = sup?.purchaseOrgCode || purchaseOrgCode || "HOOKKA";
      return ({
      supplierId: sid,
      supplierName: lines[0].supplierName,
      status: "CONFIRMED",
      purchaseOrgCode: supOrg,
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
    });

    try {
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        try {
          const res = await fetch("/api/purchase-orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(g),
          });
          const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
          if (!res.ok || !body.success) {
            failures.push({
              supplierName: g.supplierName,
              error: body.error || `HTTP ${res.status}`,
            });
          } else {
            okCount++;
          }
        } catch (err) {
          failures.push({
            supplierName: g.supplierName,
            error: err instanceof Error ? err.message : "Network error",
          });
        }
        if (i < groups.length - 1) {
          // eslint-disable-next-line no-restricted-syntax -- fixed inter-request throttle inside an async submit loop (not a React render path)
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    } finally {
      invalidateCachePrefix("/api/purchase-orders");
      invalidateCachePrefix("/api/grn");
      invalidateCachePrefix("/api/fabric-tracking");
      setSaving(false);
    }

    if (failures.length === 0) {
      toast.success(`Created ${okCount} POs across ${groups.length} suppliers`);
      navigate("/procurement");
    } else {
      for (const f of failures) toast.error(`${f.supplierName}: ${f.error}`);
      if (okCount > 0) toast.warning(`${okCount}/${groups.length} POs created — fix the rest and retry`);
    }
  };

  // beforeunload — warn the operator if they've started filling the form.
  useEffect(() => {
    if (items.length === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [items.length]);

  // ─────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header strip — matches sales/create + consignment/create. */}
      <div className="flex items-center gap-4 flex-wrap">
        <Button variant="ghost" size="icon" onClick={() => navigate("/procurement")}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-[#1F1D1B]">New Purchase Order</h1>
          <p className="text-xs text-[#6B7280]">Procurement &rarr; New PO</p>
        </div>
        <Button variant="outline" onClick={() => navigate("/procurement")} disabled={saving}>
          Cancel
        </Button>
        {hasMixedSuppliers && (
          <Button
            variant="outline"
            onClick={handleSplitBySupplier}
            disabled={saving || hasUnboundLines}
            title={
              hasUnboundLines
                ? "Pick supplier for unbound material(s)"
                : `Split into ${distinctSupplierCount} POs grouped by supplier`
            }
          >
            <Save className="h-4 w-4" />
            {saving ? "Splitting..." : `Split by Supplier (${distinctSupplierCount})`}
          </Button>
        )}
        <Button
          onClick={handleSave}
          disabled={saving || items.length === 0 || hasUnboundLines || hasMixedSuppliers}
          className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
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
          <Save className="h-4 w-4" />
          {saving ? "Saving..." : "Create Purchase Order"}
        </Button>
      </div>

      {/* Top section: Order Details (2/3) + Summary (1/3) */}
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3"><CardTitle>Order Details</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Supplier</label>
                {/* Explicit supplier picker — drives the material-add list
                    below (only materials offered by this supplier are shown).
                    The PO supplier header is still derived from line items
                    for the save payload; this field is the filter anchor. */}
                <select
                  className="w-full h-9 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                  value={selectedSupplierId}
                  onChange={(e) => {
                    const nextId = e.target.value;
                    setSelectedSupplierId(nextId);
                    // Reset picker filters when supplier changes so the
                    // operator isn't stranded in a now-empty category.
                    setSelectedCategory("ALL");
                    setRmSearch("");
                    // Prefill the Purchase company from this supplier's
                    // default — always overridable by the operator below.
                    const sup = allSuppliers.find((s) => s.id === nextId);
                    if (sup?.purchaseOrgCode) {
                      setPurchaseOrgCode(sup.purchaseOrgCode);
                    } else if (!nextId) {
                      setPurchaseOrgCode("HOOKKA");
                    }
                  }}
                  aria-label="Select supplier for this purchase order"
                >
                  <option value="">— Pick a supplier —</option>
                  {activeSuppliers.map((s) => (
                    <option key={s.id} value={s.id}>{s.code} - {s.name}</option>
                  ))}
                </select>
                {/* Status hint below the dropdown */}
                <div className="mt-1 text-xs min-h-[1.2em]">
                  {items.length > 0 && hasMixedSuppliers ? (
                    <span className="text-[#9C6F1E]">
                      Mixed ({distinctSupplierCount} suppliers) — use Split by Supplier
                    </span>
                  ) : items.length > 0 && hasUnboundLines ? (
                    <span className="text-[#9A3A2D]">
                      {unboundCount} line{unboundCount === 1 ? "" : "s"} missing supplier
                    </span>
                  ) : items.length > 0 && headerSupplierName ? (
                    <span className="text-[#6B7280]">PO supplier: <span className="font-medium text-[#1F1D1B]">{headerSupplierName}</span></span>
                  ) : null}
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Purchase company<span className="text-[#9A3A2D]"> *</span></label>
                <select
                  className="w-full h-9 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                  value={purchaseOrgCode}
                  onChange={(e) => setPurchaseOrgCode(e.target.value)}
                  aria-label="Purchase company"
                >
                  {activeOrgs.length === 0 ? (
                    <option value="HOOKKA">HOOKKA</option>
                  ) : (
                    activeOrgs.map((o) => (
                      <option key={o.code} value={o.code}>{o.name}</option>
                    ))
                  )}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Expected Delivery Date</label>
                <Input
                  type="date"
                  value={expectedDate}
                  onChange={(e) => setExpectedDate(e.target.value)}
                />
              </div>
            </div>

            {/* Supplier info bar — shown as soon as a supplier is chosen
                (either from the picker above or resolved from line items).
                Prefers selectedSupplierId so the bar appears before any
                lines are added. */}
            {(selectedSupplierId || (!hasMixedSuppliers && !hasUnboundLines && headerSupplierId)) && (() => {
              const resolvedId = selectedSupplierId || headerSupplierId;
              const sup = allSuppliers.find((s) => s.id === resolvedId);
              if (!sup) return null;
              return (
                <div className="rounded-md bg-[#FAF9F7] border border-[#E2DDD8] p-3 text-sm">
                  <div className="flex flex-wrap gap-x-6 gap-y-1">
                    {sup.contactPerson && (
                      <span className="text-[#6B7280]">Contact: <span className="font-medium text-[#1F1D1B]">{sup.contactPerson}</span></span>
                    )}
                    {sup.phone && (
                      <span className="text-[#6B7280]">Phone: <span className="font-medium text-[#1F1D1B]">{sup.phone}</span></span>
                    )}
                    {sup.email && (
                      <span className="text-[#6B7280]">Email: <span className="font-medium text-[#1F1D1B]">{sup.email}</span></span>
                    )}
                    {sup.paymentTerms && (
                      <span className="text-[#6B7280]">Terms: <span className="font-medium text-[#1F1D1B]">{sup.paymentTerms}</span></span>
                    )}
                    {sup.address && (
                      <span className="text-[#6B7280]">Address: <span className="font-medium text-[#1F1D1B]">{sup.address}</span></span>
                    )}
                  </div>
                </div>
              );
            })()}

            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1.5">Notes</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                placeholder="Order notes (delivery instructions, payment terms, special handling)..."
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3"><CardTitle>Summary</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-[#6B7280]">Supplier</span>
              <span className="font-medium text-right max-w-[60%] truncate">
                {items.length === 0 ? (
                  <span className="text-[#9CA3AF]">—</span>
                ) : hasMixedSuppliers ? (
                  <span className="text-[#9C6F1E]">{distinctSupplierCount} suppliers</span>
                ) : hasUnboundLines ? (
                  <span className="text-[#9A3A2D]">Missing</span>
                ) : (
                  headerSupplierName
                )}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-[#6B7280]">Total Qty</span>
              <span className="font-medium">{totalQty}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-[#6B7280]">Line Items</span>
              <span className="font-medium">{items.length}</span>
            </div>
            <hr className="border-[#E2DDD8]" />
            <div className="flex justify-between text-lg font-bold">
              <span>Total</span>
              <span className="text-[#6B5C32]">{formatCurrency(subtotal)}</span>
            </div>
            <div className="text-xs text-[#9CA3AF]">Status will be set to CONFIRMED</div>
          </CardContent>
        </Card>
      </div>

      {/* Order Items — full-width table */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle>Order Items ({items.length})</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* RM picker — category chips + search + scrolling list. Lifted
              from the modal verbatim; only the surrounding spacing breathes
              wider on the full page. */}
          <div className="space-y-2">
            <label className="block text-xs text-[#6B7280]">
              {selectedSupplierId
                ? `Add material — showing ${pickerRMs.length} material${pickerRMs.length === 1 ? "" : "s"} offered by this supplier`
                : "Add material — pick a supplier above to filter to their materials, or browse all"}
            </label>

            {/* Compact filter row: one category dropdown (grouped Bedframe /
                Sofa / Common) + a search box. The results list is absolutely
                positioned as a dropdown overlay so it does not push the line
                item table down when it appears. */}
            <div className="relative">
              <div className="flex flex-col sm:flex-row gap-2">
                <select
                  value={selectedCategory}
                  onChange={(e) => setSelectedCategory(e.target.value)}
                  className="h-9 w-full sm:w-60 rounded-md border border-[#E2DDD8] bg-white px-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                  aria-label="Filter materials by category"
                >
                  <option value="ALL">All categories ({pickerRMs.length})</option>
                  {groupedCategories.bedframe.length > 0 && (
                    <optgroup label="Bedframe">
                      {groupedCategories.bedframe.map((cat) => (
                        <option key={cat} value={cat}>{cat} ({categoryCounts[cat] ?? 0})</option>
                      ))}
                    </optgroup>
                  )}
                  {groupedCategories.sofa.length > 0 && (
                    <optgroup label="Sofa">
                      {groupedCategories.sofa.map((cat) => (
                        <option key={cat} value={cat}>{cat} ({categoryCounts[cat] ?? 0})</option>
                      ))}
                    </optgroup>
                  )}
                  {groupedCategories.common.length > 0 && (
                    <optgroup label="Common">
                      {groupedCategories.common.map((cat) => (
                        <option key={cat} value={cat}>{cat} ({categoryCounts[cat] ?? 0})</option>
                      ))}
                    </optgroup>
                  )}
                </select>
                <Input
                  className="h-9 text-sm flex-1"
                  value={rmSearch}
                  onChange={(e) => setRmSearch(e.target.value)}
                  placeholder="Search by RM code or description..."
                />
              </div>

              {/* Results dropdown — absolutely positioned under the search row so it
                  overlays the line-item table below rather than reflowing the page. */}
              {(rmSearch.trim() !== "" || selectedCategory !== "ALL") && (
                <div className="absolute left-0 right-0 top-full mt-1 z-20 max-h-64 overflow-y-auto bg-white border border-[#E2DDD8] rounded-md shadow-lg">
                  {filteredRMs.length === 0 ? (
                    <div className="px-3 py-4 text-sm text-[#9CA3AF] text-center">
                      No materials match this filter
                    </div>
                  ) : (
                    <>
                      {filteredRMs.slice(0, 100).map((rm) => (
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
                      {filteredRMs.length > 100 && (
                        <div className="px-3 py-2 text-xs text-[#9CA3AF] bg-[#FAF9F7]">
                          Showing 100 of {filteredRMs.length}. Refine your search to narrow further.
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Line item table — full-width, generous columns. The wrapper is
              an overflow-x-auto so very narrow viewports still scroll, but
              on a normal-width procurement screen every column fits without
              wrapping (10 numeric columns at min-width totals ~1200px). */}
          {items.length > 0 ? (
            <div className="overflow-x-auto rounded-md border border-[#E2DDD8]">
              <table className="w-full text-sm">
                <thead className="bg-[#F0ECE9] border-b border-[#E2DDD8]">
                  <tr className="text-xs uppercase tracking-wide text-[#6B7280]">
                    <th className="text-left px-3 py-2 font-medium" style={{ minWidth: 140 }}>RM Code</th>
                    <th className="text-left px-3 py-2 font-medium" style={{ minWidth: 220 }}>Description</th>
                    <th className="text-left px-3 py-2 font-medium" style={{ minWidth: 280 }}>Supplier</th>
                    <th className="text-left px-3 py-2 font-medium" style={{ minWidth: 140 }}>Supplier SKU</th>
                    <th className="text-right px-3 py-2 font-medium" style={{ minWidth: 90 }}>Qty</th>
                    <th className="text-right px-3 py-2 font-medium" style={{ minWidth: 110 }}>Price (RM)</th>
                    <th className="text-left px-3 py-2 font-medium" style={{ minWidth: 70 }}>Unit</th>
                    <th className="text-right px-3 py-2 font-medium" style={{ minWidth: 80 }}>Lead</th>
                    <th className="text-right px-3 py-2 font-medium" style={{ minWidth: 70 }}>MOQ</th>
                    <th className="text-right px-3 py-2 font-medium" style={{ minWidth: 110 }}>Line Total</th>
                    <th className="px-3 py-2" style={{ minWidth: 50 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, idx) => {
                    const bindings = getSortedBindingsForRM(item.rmCode);
                    const prevCategory = idx > 0 ? items[idx - 1].materialCategory : null;
                    const showCategoryHeader = idx === 0 || prevCategory !== item.materialCategory;
                    return (
                      // Fragment must carry a stable key — it sits inside
                      // the .map and renders 0-2 <tr> rows (category header
                      // is conditional). React-typed Fragment shorthand
                      // doesn't accept `key`, so use the long form.
                      <React.Fragment key={`line-${idx}`}>
                        {showCategoryHeader && (
                          <tr className="bg-[#FAF9F7]">
                            <td colSpan={11} className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#6B5C32]">
                              {item.materialCategory || "(uncategorised)"}
                            </td>
                          </tr>
                        )}
                        <tr
                          data-po-line-row="true"
                          className="border-t border-[#E2DDD8] hover:bg-[#FAF9F7]"
                        >
                          {/* RM Code (editable swap) */}
                          <td className="px-3 py-2">
                            <input
                              key={`rm-${idx}-${item.rmCode}`}
                              type="text"
                              list={`rm-options-${idx}`}
                              defaultValue={item.rmCode}
                              onFocus={(e) => e.currentTarget.select()}
                              onBlur={(e) => {
                                const v = e.currentTarget.value.trim();
                                if (v && v !== item.rmCode) {
                                  const found = rawMaterials.find((r) => r.itemCode === v);
                                  if (found) {
                                    swapItemRM(idx, v);
                                  } else {
                                    e.currentTarget.value = item.rmCode;
                                  }
                                }
                              }}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") e.currentTarget.blur();
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
                          </td>
                          {/* Description — read-only */}
                          <td className="px-3 py-2">
                            <div className="text-sm text-[#374151] truncate" title={item.rmDescription}>
                              {item.rmDescription}
                            </div>
                          </td>
                          {/* Supplier — bound dropdown OR free supplier picker for unbound RMs */}
                          <td className="px-3 py-2">
                            {bindings.length > 0 ? (
                              <select
                                className="flex h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-xs"
                                value={item.supplierId}
                                onChange={(e) => switchSupplier(idx, e.target.value)}
                              >
                                {bindings.map((b) => (
                                  <option key={b.id} value={b.supplierId}>
                                    {supplierOptionLabel(b)}{b.isMainSupplier ? " ★" : ""}
                                  </option>
                                ))}
                              </select>
                            ) : (
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
                          </td>
                          {/* Supplier SKU — read-only from binding */}
                          <td className="px-3 py-2">
                            <div className="text-sm text-[#374151] truncate" title={item.supplierSku}>
                              {item.supplierSku || "-"}
                            </div>
                          </td>
                          {/* Qty */}
                          <td className="px-3 py-2 text-right">
                            <Input
                              className="h-8 text-sm text-right"
                              type="number"
                              onFocus={(e) => e.currentTarget.select()}
                              min={0}
                              value={item.quantity === 0 ? "" : item.quantity}
                              onChange={(e) => updateItemQty(idx, Number(e.target.value) || 0)}
                            />
                          </td>
                          {/* Price (RM) */}
                          <td className="px-3 py-2 text-right">
                            <Input
                              className="h-8 text-sm text-right"
                              type="number"
                              step="0.01"
                              inputMode="decimal"
                              onFocus={(e) => e.currentTarget.select()}
                              min={0}
                              value={item.unitPriceSen === 0 ? "" : (item.unitPriceSen / 100).toFixed(2)}
                              onChange={(e) => {
                                const rm = parseFloat(e.target.value);
                                const sen = Number.isFinite(rm) && rm >= 0 ? Math.round(rm * 100) : 0;
                                updateItemPrice(idx, sen);
                              }}
                            />
                          </td>
                          {/* Unit */}
                          <td className="px-3 py-2 text-sm text-[#374151]">{item.unit}</td>
                          {/* Lead */}
                          <td className="px-3 py-2 text-right text-sm text-[#374151]">
                            {item.leadTimeDays}d
                          </td>
                          {/* MOQ */}
                          <td className="px-3 py-2 text-right text-sm text-[#374151]">{item.moq}</td>
                          {/* Line total */}
                          <td className="px-3 py-2 text-right text-sm font-medium amount text-[#1F1D1B]">
                            {formatCurrency(item.quantity * item.unitPriceSen)}
                          </td>
                          {/* Delete */}
                          <td className="px-3 py-2 text-right">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 text-[#9A3A2D] hover:text-[#7A2E24]"
                              onClick={() => removeItem(idx)}
                              title="Remove line"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </td>
                        </tr>
                      </React.Fragment>
                    );
                  })}
                </tbody>
                <tfoot className="bg-[#FAF9F7] border-t border-[#E2DDD8]">
                  <tr>
                    <td colSpan={9} className="px-3 py-2 text-right text-sm font-medium text-[#6B7280]">
                      TOTAL
                    </td>
                    <td className="px-3 py-2 text-right text-base font-bold text-[#6B5C32] amount">
                      {formatCurrency(subtotal)}
                    </td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-[#E2DDD8] bg-[#FAF9F7] py-10 text-center text-sm text-[#9CA3AF]">
              No items yet. Pick a category chip above or search for a raw material to add it.
            </div>
          )}

          {hasUnboundLines && (
            <p className="text-xs text-[#9A3A2D]">
              {unboundCount} line{unboundCount === 1 ? "" : "s"} need{unboundCount === 1 ? "s" : ""} a supplier picked before saving.
            </p>
          )}
          {hasMixedSuppliers && (
            <p className="text-xs text-[#9C6F1E]">
              Lines belong to {distinctSupplierCount} suppliers — use Split by Supplier (top right) to create one PO per supplier.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
