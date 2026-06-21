// ---------------------------------------------------------------------------
// New Purchase Invoice — full-page form.
//
// Converts the PIFormDialog modal (src/pages/procurement/pi.tsx) into a
// dedicated route, matching the PO create page layout:
//   • Top header strip (back arrow + title + Cancel/Save buttons)
//   • 1-2 column grid: Invoice Details card (left, lg:col-span-2) +
//     Summary card (right)
//   • Invoice Items card spans full width below — full-width line table
//
// Query params:
//   ?scan=1  — auto-open the scan modal on mount (replaces autoScan prop)
//
// All PI form logic (line entry, string-state money fields, OCR apply, POST
// /api/purchase-invoices, cache invalidation) is ported verbatim from
// PIFormDialog. The backend endpoint is unchanged.
// ---------------------------------------------------------------------------

import React, { useState, useEffect, useMemo, Suspense } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { formatCurrency } from "@/lib/utils";
import type { Supplier, RawMaterial, SupplierMaterialBinding } from "@/types";
import { MaterialPicker, type MaterialOption } from "@/components/material-picker";
import { ArrowLeft, Plus, Save, Trash2, FolderInput } from "lucide-react";
import {
  ScanSupplierModal,
  type SupplierExtraction,
} from "@/components/scan-supplier-modal";
import {
  ConvertToPIModal,
  type ConvertToPIResult,
} from "@/components/convert-to-pi-modal";

// ── Source-doc shapes (minimal fields we need for pre-fill) ────────────────
type POItemShape = {
  materialName: string;
  supplierSKU?: string | null;
  quantity: number;
  unitPriceSen: number;
};
type POShape = {
  id: string;
  poNo: string;
  supplierId: string;
  supplierName: string;
  items: POItemShape[];
};
type GRNItemShape = {
  id: string; // grn_items row id == grnItemId
  materialCode?: string | null;
  materialName: string;
  acceptedQty: number;
  availableQty?: number;
  unitPrice: number; // sen
};
type GRNShape = {
  id: string;
  grnNumber: string;
  poId: string | null;
  supplierId: string;
  supplierName: string;
  items: GRNItemShape[];
};

// ── Line-item draft type — mirrors PIFormDialog exactly ───────────────────
type PILineDraft = {
  materialCode: string;
  materialName: string;
  supplierSku: string;
  qty: number;
  // NOTE: unitPriceRM is a NUMBER (not a string). The original modal stored
  // it as number, parsed at submit via Math.round(unitPriceRM * 100). Kept
  // identical — do NOT convert to MoneyInput / string state.
  unitPriceRM: number;
  // Convert-chain: set ONLY when this line was picked from a GRN line. Sent in
  // the POST so the backend increments grn_items.invoiced_qty and runs the
  // line-level availability guard. null = manual / PO-source line.
  grnItemId?: string | null;
};

function emptyPILine(): PILineDraft {
  return {
    materialCode: "",
    materialName: "",
    supplierSku: "",
    qty: 1,
    unitPriceRM: 0,
    grnItemId: null,
  };
}

export default function CreatePurchaseInvoicePageWrapper() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64 text-[#9CA3AF]">
          Loading...
        </div>
      }
    >
      <CreatePurchaseInvoicePage />
    </Suspense>
  );
}

function CreatePurchaseInvoicePage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();

  // Data fetches — same endpoints as pi.tsx; cache is shared.
  const { data: supResp } = useCachedJson<{
    success?: boolean;
    data?: Supplier[];
  }>("/api/suppliers");
  const { data: invResp } = useCachedJson<{
    success?: boolean;
    data?: { rawMaterials?: RawMaterial[] };
  }>("/api/inventory");
  const { data: bindingsResp } = useCachedJson<
    { success?: boolean; data?: SupplierMaterialBinding[] } | SupplierMaterialBinding[]
  >("/api/supplier-materials");

  const suppliers: Supplier[] = useMemo(
    () => supResp?.data ?? [],
    [supResp],
  );

  const allRawMaterials: RawMaterial[] = useMemo(
    () =>
      (invResp?.success ? invResp.data?.rawMaterials ?? [] : []).filter(
        (rm) => rm.isActive,
      ),
    [invResp],
  );

  const supplierMaterialBindings: SupplierMaterialBinding[] = useMemo(() => {
    const b = (bindingsResp as { data?: SupplierMaterialBinding[] } | undefined)?.data ?? bindingsResp;
    return Array.isArray(b) ? b : [];
  }, [bindingsResp]);

  // ── Form state ────────────────────────────────────────────────────────────
  const [supplierId, setSupplierId] = useState("");
  const [invoiceDate, setInvoiceDate] = useState(
    () => new Date().toISOString().split("T")[0],
  );
  const [remarks, setRemarks] = useState("");
  const [lines, setLines] = useState<PILineDraft[]>([emptyPILine()]);
  const [scanOpen, setScanOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // ── Source PO id to include in POST body for lineage ─────────────────────
  const [sourcePurchaseOrderId, setSourcePurchaseOrderId] = useState<
    string | null
  >(null);
  // ── Source GRN id — POSTed as body.grnId; drives invoiced_qty + line guard ─
  const [sourceGrnId, setSourceGrnId] = useState<string | null>(null);

  // ── Pre-fill from ?poId or ?grnId on first mount ─────────────────────────
  useEffect(() => {
    const poId = searchParams.get("poId");
    const grnId = searchParams.get("grnId");

    if (poId) {
      fetch(`/api/purchase-orders/${poId}`)
        .then((r) => r.json())
        .then((j) => {
          const resp = j as { success?: boolean; data?: POShape };
          const po = resp.data;
          if (!po) return;
          setSupplierId(po.supplierId);
          setRemarks(`Created from PO ${po.poNo}`);
          setSourcePurchaseOrderId(po.id);
          const prefilled = po.items.map((it) => ({
            materialCode: "",
            materialName: it.materialName,
            supplierSku: it.supplierSKU ?? "",
            qty: it.quantity,
            unitPriceRM: it.unitPriceSen / 100,
            grnItemId: null,
          }));
          setLines(prefilled.length > 0 ? prefilled : [emptyPILine()]);
        })
        .catch(() => {
          // leave blank form; user will notice and can fill manually
        });
    } else if (grnId) {
      fetch(`/api/grn/${grnId}`)
        .then((r) => r.json())
        .then((j) => {
          const resp = j as { success?: boolean; data?: GRNShape };
          const grn = resp.data;
          if (!grn) return;
          setSupplierId(grn.supplierId);
          setRemarks(`From GRN ${grn.grnNumber}`);
          setSourceGrnId(grn.id);
          if (grn.poId) setSourcePurchaseOrderId(grn.poId);
          // Deep-link path: take every line that still has something to invoice
          // (availableQty, falling back to acceptedQty for pre-column rows) and
          // CARRY grnItemId so the backend increments invoiced_qty + guards.
          const prefilled = grn.items
            .map((it) => ({
              ...it,
              remaining:
                it.availableQty != null ? it.availableQty : it.acceptedQty,
            }))
            .filter((it) => it.remaining > 0)
            .map((it) => ({
              materialCode: it.materialCode ?? "",
              materialName: it.materialName,
              supplierSku: it.materialCode ?? "",
              qty: it.remaining,
              unitPriceRM: it.unitPrice / 100,
              grnItemId: it.id,
            }));
          setLines(prefilled.length > 0 ? prefilled : [emptyPILine()]);
        })
        .catch(() => {
          // leave blank form
        });
    } else if (searchParams.get("scan") === "1") {
      /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setScanOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const supplier = suppliers.find((s) => s.id === supplierId);

  // ── Supplier-filtered material picker options ─────────────────────────────
  // When a supplier is selected, narrow the catalog to materials bound to that
  // supplier via supplier_material_bindings. The picker still allows free-text
  // for off-catalog items — this only changes the suggestions list.
  // When no supplier is selected, materialOptions is empty and the picker shows
  // a "Pick a supplier first" hint instead of catalog entries.
  const materialOptions: MaterialOption[] = useMemo(() => {
    if (!supplierId) return [];
    const boundCodes = new Set(
      supplierMaterialBindings
        .filter((b) => b.supplierId === supplierId)
        .map((b) => b.materialCode.trim().toUpperCase()),
    );
    if (boundCodes.size === 0) {
      // Supplier has no bindings at all — fall back to the full catalog so the
      // operator is never left with a completely empty picker.
      return allRawMaterials.map((rm) => ({
        itemCode: rm.itemCode,
        description: rm.description,
      }));
    }
    return allRawMaterials
      .filter((rm) => boundCodes.has(rm.itemCode.trim().toUpperCase()))
      .map((rm) => ({ itemCode: rm.itemCode, description: rm.description }));
  }, [supplierId, supplierMaterialBindings, allRawMaterials]);

  // ── Line mutators — verbatim from PIFormDialog ────────────────────────────
  const updateLine = (
    idx: number,
    field: keyof PILineDraft,
    value: string | number,
  ) => {
    setLines((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next;
    });
  };

  const addLine = () => setLines((prev) => [...prev, emptyPILine()]);

  const removeLine = (idx: number) =>
    setLines((prev) =>
      prev.length === 1 ? [emptyPILine()] : prev.filter((_, i) => i !== idx),
    );

  // OCR apply — verbatim from PIFormDialog.applyOcr
  const applyOcr = (ex: SupplierExtraction) => {
    const norm = (s: string | null | undefined) =>
      String(s ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
    setLines((prev) => {
      const seed = prev.filter(
        (l) =>
          l.materialName.trim() !== "" ||
          l.supplierSku.trim() !== "" ||
          l.materialCode.trim() !== "" ||
          l.qty !== 1 ||
          l.unitPriceRM !== 0,
      );
      const next = seed.map((l) => ({ ...l }));
      for (const sl of ex.lines ?? []) {
        const qty = Number(sl.qty) || 0;
        const priceRM =
          sl.unitPrice == null || Number.isNaN(Number(sl.unitPrice))
            ? null
            : Number(sl.unitPrice);
        const codeN = norm(sl.supplierCode);
        const descN = norm(sl.description);
        const hitIdx = next.findIndex((l) => {
          const sku = norm(l.supplierSku || l.materialCode);
          const nm = norm(l.materialName);
          const codeHit =
            !!codeN &&
            !!sku &&
            (sku === codeN || sku.includes(codeN) || codeN.includes(sku));
          const nameHit =
            !!descN && !!nm && (nm.includes(descN) || descN.includes(nm));
          return codeHit || nameHit;
        });
        if (hitIdx >= 0) {
          next[hitIdx] = {
            ...next[hitIdx],
            qty: qty > 0 ? qty : next[hitIdx].qty,
            unitPriceRM: priceRM != null ? priceRM : next[hitIdx].unitPriceRM,
          };
        } else {
          next.push({
            materialCode: "",
            materialName:
              sl.description?.trim() ||
              sl.supplierCode?.trim() ||
              "(Scanned item - add name)",
            supplierSku: sl.supplierCode?.trim() || "",
            qty: qty > 0 ? qty : 1,
            unitPriceRM: priceRM != null ? priceRM : 0,
          });
        }
      }
      return next.length > 0 ? next : [emptyPILine()];
    });
  };

  // ── Convert picker handler — pre-fills the form in place from picked lines ──
  // Sets supplier, source ids (grnId for GRN-source so the backend increments
  // invoiced_qty + guards), and the line table — each GRN line carries its
  // grnItemId. No navigation: we keep the user on the form with their picks.
  const handleConvert = (res: ConvertToPIResult) => {
    setSupplierId(res.supplierId);
    setSourceGrnId(res.grnId);
    setSourcePurchaseOrderId(res.purchaseOrderId);
    setRemarks(
      res.source === "grn"
        ? `From GRN ${res.docLabel}`
        : `Created from PO ${res.docLabel}`,
    );
    setLines(
      res.lines.length > 0
        ? res.lines.map((l) => ({
            materialCode: l.materialCode,
            materialName: l.materialName,
            supplierSku: l.supplierSku,
            qty: l.qty,
            unitPriceRM: l.unitPriceRM,
            grnItemId: l.grnItemId,
          }))
        : [emptyPILine()],
    );
  };

  // ── Derived totals ────────────────────────────────────────────────────────
  const validLines = lines.filter((l) => l.materialName.trim() !== "");
  const totalRM = validLines.reduce(
    (s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPriceRM) || 0),
    0,
  );
  // totalRM is in RM — convert to sen for formatCurrency
  const totalSen = Math.round(totalRM * 100);

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!supplier) {
      toast.error("Select a supplier");
      return;
    }
    if (validLines.length === 0) {
      toast.error("Add at least one item");
      return;
    }
    if (saving) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        supplierId: supplier.id,
        supplierName: supplier.name,
        invoiceDate,
        remarks,
        items: validLines.map((l) => ({
          materialCode: l.materialCode.trim() || null,
          materialName: l.materialName.trim(),
          supplierSku: l.supplierSku.trim() || null,
          qty: Number(l.qty) || 0,
          unitPriceSen: Math.round((Number(l.unitPriceRM) || 0) * 100),
          lineType: "STOCKED" as const,
          // Convert-chain: carry the GRN source line so the backend draws down
          // grn_items.invoiced_qty and enforces the line-level guard.
          grnItemId: l.grnItemId ?? null,
        })),
      };
      if (sourcePurchaseOrderId) {
        payload.purchaseOrderId = sourcePurchaseOrderId;
      }
      // grnId tells the backend to resolve the GRN (→ its PO for the header)
      // and run the accepted−invoiced availability check per line.
      if (sourceGrnId) {
        payload.grnId = sourceGrnId;
      }
      const res = await fetch("/api/purchase-invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: string; data?: { piNo?: string } }
        | null;
      if (!res.ok || !j?.success) {
        toast.error(
          (j as { error?: string } | null)?.error || "Failed to create invoice",
        );
        return;
      }
      invalidateCachePrefix("/api/purchase-invoices");
      toast.success(
        j.data?.piNo
          ? `Invoice ${j.data.piNo} created`
          : "Purchase invoice created",
      );
      navigate("/procurement/pi");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Network error creating invoice",
      );
    } finally {
      setSaving(false);
    }
  };

  // beforeunload guard — same pattern as PO create page.
  useEffect(() => {
    const hasData =
      supplierId !== "" ||
      remarks !== "" ||
      lines.some(
        (l) =>
          l.materialName.trim() !== "" ||
          l.supplierSku.trim() !== "" ||
          l.qty !== 1 ||
          l.unitPriceRM !== 0,
      );
    if (!hasData) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [supplierId, remarks, lines]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header strip — matches PO create layout exactly */}
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/procurement/pi")}
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-[#1F1D1B]">
            New Purchase Invoice
          </h1>
          <p className="text-xs text-[#6B7280]">
            Procurement &rarr; Purchase Invoices &rarr; New
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => setConvertOpen(true)}
          title="Pick a Goods Receipt (or Purchase Order) and its lines to pre-fill this invoice"
        >
          <FolderInput className="h-4 w-4" /> Convert from GR or PO
        </Button>
        <Button
          variant="outline"
          onClick={() => navigate("/procurement/pi")}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          disabled={saving || !supplier || validLines.length === 0}
          className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
        >
          <Save className="h-4 w-4" />
          {saving ? "Saving..." : "Create Invoice"}
        </Button>
      </div>

      {/* Top section: Invoice Details (2/3) + Summary (1/3) */}
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle>Invoice Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">
                  Supplier *
                </label>
                <SearchableSelect
                  value={supplierId}
                  onChange={setSupplierId}
                  options={suppliers.map((s) => ({ value: s.id, label: `${s.code} - ${s.name}` }))}
                  placeholder="Select supplier..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">
                  Invoice Date *
                </label>
                <Input
                  type="date"
                  value={invoiceDate}
                  onChange={(e) => setInvoiceDate(e.target.value)}
                  required
                />
              </div>
            </div>

            {/* Supplier info bar — matches SO create's customer info bar style */}
            {supplier && (
              <div className="rounded-md bg-[#FAF9F7] border border-[#E2DDD8] p-3 text-sm">
                <div className="flex flex-wrap gap-x-6 gap-y-1">
                  {supplier.contactPerson && (
                    <span className="text-[#6B7280]">Contact: <span className="font-medium text-[#1F1D1B]">{supplier.contactPerson}</span></span>
                  )}
                  {supplier.phone && (
                    <span className="text-[#6B7280]">Phone: <span className="font-medium text-[#1F1D1B]">{supplier.phone}</span></span>
                  )}
                  {supplier.email && (
                    <span className="text-[#6B7280]">Email: <span className="font-medium text-[#1F1D1B]">{supplier.email}</span></span>
                  )}
                  {supplier.paymentTerms && (
                    <span className="text-[#6B7280]">Terms: <span className="font-medium text-[#1F1D1B]">{supplier.paymentTerms}</span></span>
                  )}
                  {supplier.address && (
                    <span className="text-[#6B7280]">Address: <span className="font-medium text-[#1F1D1B]">{supplier.address}</span></span>
                  )}
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1.5">
                Remarks
              </label>
              <Input
                value={remarks}
                onChange={(e) => setRemarks(e.target.value)}
                placeholder="Optional notes..."
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-[#6B7280]">Supplier</span>
              <span className="font-medium text-right max-w-[60%] truncate">
                {supplier ? `${supplier.code} - ${supplier.name}` : (
                  <span className="text-[#9CA3AF]">Not selected</span>
                )}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-[#6B7280]">Line Items</span>
              <span className="font-medium">{validLines.length}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-[#6B7280]">Invoice Date</span>
              <span className="font-medium">{invoiceDate || "-"}</span>
            </div>
            <hr className="border-[#E2DDD8]" />
            <div className="flex justify-between text-lg font-bold">
              <span>Total</span>
              <span className="text-[#6B5C32]">{formatCurrency(totalSen)}</span>
            </div>
            <div className="text-xs text-[#9CA3AF]">
              Status will be set to DRAFT
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Invoice Items — full-width table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Invoice Items ({validLines.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="border border-[#E2DDD8] rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[#F0ECE9] border-b border-[#E2DDD8]">
                <tr className="text-xs uppercase tracking-wide text-[#6B7280]">
                  <th className="text-left px-3 py-2 font-medium">
                    Description
                  </th>
                  <th
                    className="text-left px-3 py-2 font-medium"
                    style={{ width: 140 }}
                  >
                    Supplier SKU
                  </th>
                  <th
                    className="text-right px-3 py-2 font-medium"
                    style={{ width: 100 }}
                  >
                    Qty
                  </th>
                  <th
                    className="text-right px-3 py-2 font-medium"
                    style={{ width: 130 }}
                  >
                    Unit Price (RM)
                  </th>
                  <th
                    className="text-right px-3 py-2 font-medium"
                    style={{ width: 130 }}
                  >
                    Line Total
                  </th>
                  <th style={{ width: 40 }} />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, idx) => {
                  const lineTotal =
                    (Number(line.qty) || 0) * (Number(line.unitPriceRM) || 0);
                  return (
                    <tr
                      key={idx}
                      className="border-t border-[#E2DDD8] hover:bg-[#FAF9F7]"
                    >
                      {/* Description — catalog picker, filtered by supplier; free-text OK */}
                      <td className="px-2 py-1.5">
                        {!supplierId ? (
                          <input
                            disabled
                            className="h-8 w-full rounded border border-[#E2DDD8] bg-[#F9F8F6] px-2 text-xs text-[#9CA3AF] cursor-not-allowed"
                            placeholder="Pick a supplier first"
                          />
                        ) : (
                          <MaterialPicker
                            className="h-8"
                            inputClassName="h-8"
                            placeholder="Search code or name..."
                            value={line.materialName}
                            options={materialOptions}
                            onPick={(o) =>
                              setLines((prev) => {
                                const next = [...prev];
                                next[idx] = {
                                  ...next[idx],
                                  materialCode: o.itemCode,
                                  materialName: o.description,
                                };
                                return next;
                              })
                            }
                            onTyped={(text) =>
                              updateLine(idx, "materialName", text)
                            }
                          />
                        )}
                      </td>
                      {/* Supplier SKU */}
                      <td className="px-2 py-1.5">
                        <Input
                          className="h-8"
                          placeholder="SKU"
                          value={line.supplierSku}
                          onChange={(e) =>
                            updateLine(idx, "supplierSku", e.target.value)
                          }
                        />
                      </td>
                      {/* Qty */}
                      <td className="px-2 py-1.5">
                        <Input
                          type="number"
                          min={0}
                          onFocus={(e) => e.currentTarget.select()}
                          className="h-8 w-20 text-right ml-auto"
                          value={line.qty}
                          onChange={(e) =>
                            updateLine(idx, "qty", Number(e.target.value))
                          }
                        />
                      </td>
                      {/* Unit Price (RM) */}
                      <td className="px-2 py-1.5">
                        <MoneyInput
                          className="h-8 w-28 ml-auto"
                          value={line.unitPriceRM === 0 ? null : line.unitPriceRM}
                          onChange={(rm) =>
                            updateLine(idx, "unitPriceRM", rm ?? 0)
                          }
                        />
                      </td>
                      {/* Line total */}
                      <td className="px-3 py-1.5 text-right font-medium text-[#1F1D1B]">
                        {lineTotal.toLocaleString("en-MY", {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </td>
                      {/* Delete */}
                      <td className="px-1 py-1.5 text-center">
                        <button
                          type="button"
                          className="text-[#9CA3AF] hover:text-[#9A3A2D]"
                          onClick={() => removeLine(idx)}
                          title="Remove this line"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-[#F0ECE9] border-t border-[#E2DDD8]">
                  <td
                    colSpan={4}
                    className="px-3 py-2 font-semibold text-[#374151]"
                  >
                    Grand Total
                  </td>
                  <td className="px-3 py-2 text-right font-bold text-[#6B5C32]">
                    {totalRM.toLocaleString("en-MY", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={addLine}
          >
            <Plus className="h-4 w-4" /> Add line
          </Button>

          {!supplier && (
            <p className="text-xs text-[#9CA3AF]">
              Select a supplier in the Invoice Details section above before saving.
            </p>
          )}
          {supplier && validLines.length === 0 && (
            <p className="text-xs text-[#9CA3AF]">
              Add at least one item with a description before saving.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Convert from GRN / PO line-pick picker */}
      <ConvertToPIModal
        open={convertOpen}
        onClose={() => setConvertOpen(false)}
        onConfirm={handleConvert}
      />

      {/* Scan modal — wired to the same applyOcr handler */}
      <ScanSupplierModal
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        supplierId={supplier?.id ?? null}
        supplierName={supplier?.name ?? null}
        poContext={
          validLines.length > 0
            ? validLines
                .map((l) =>
                  `${l.supplierSku || ""} ${l.materialName || ""}`.trim(),
                )
                .filter(Boolean)
                .join("\n")
            : undefined
        }
        onApply={applyOcr}
      />
    </div>
  );
}
