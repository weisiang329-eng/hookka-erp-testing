// ---------------------------------------------------------------------------
// GRN Create — full-page form.
//
// Replaces the cramped GRNFormDialog modal (grn.tsx) for the "Create GRN"
// toolbar button. Layout matches src/pages/procurement/create.tsx (New PO)
// so Procurement's three create flows — PO / GRN / PI — all look unified:
//   • Top header strip (back arrow + title + Cancel/Save buttons)
//   • 1-2 column grid: GRN Details card (left, lg:col-span-2) +
//     Summary card (right)
//   • Items card spans full width below
//
// The GRNFormDialog modal is KEPT in grn.tsx because detail.tsx (the PO
// detail page) still uses it via the "Receive Goods" button with lockedPoId.
// This page is only wired to the GRN list's "Create GRN" / "Scan GRN"
// toolbar buttons.
//
// Query params
//   ?poId=<id>   — pre-select a PO (mirrors lockedPoId in the modal);
//                  forces "From Purchase Order" mode and locks the toggle.
//   ?scan=1      — auto-open the scan modal once a PO is selected
// ---------------------------------------------------------------------------

import React, { useState, useEffect, useRef, useMemo, Suspense } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import type { PurchaseOrder, Supplier } from "@/types";
import { ArrowLeft, Save, ScanLine, Plus, Trash2 } from "lucide-react";
import {
  ScanSupplierModal,
  type SupplierExtraction,
} from "@/components/scan-supplier-modal";

// ── Types ──────────────────────────────────────────────────────────────────

/** PO-mode line — keyed by PO item index, fields derived from PO on submit */
type POItemEntry = {
  poItemIndex: number;
  receivedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  rejectionReason: string;
};

/** Manual-mode line — all fields supplied by the operator */
type ManualItemEntry = {
  id: number; // local row id for React key
  materialName: string;
  materialCode: string;
  receivedQty: number;
  acceptedQty: number; // auto = receivedQty − rejectedQty
  rejectedQty: number;
  rejectionReason: string;
  unitPriceSen: number; // stored in sen (MoneyInput × 100)
};

type GRNMode = "po" | "manual";

let nextRowId = 1;
function newManualRow(): ManualItemEntry {
  return {
    id: nextRowId++,
    materialName: "",
    materialCode: "",
    receivedQty: 0,
    acceptedQty: 0,
    rejectedQty: 0,
    rejectionReason: "",
    unitPriceSen: 0,
  };
}

// ── Page wrapper (Suspense boundary) ──────────────────────────────────────

export default function GRNCreatePageWrapper() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64 text-[#9CA3AF]">
          Loading...
        </div>
      }
    >
      <GRNCreatePage />
    </Suspense>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

function GRNCreatePage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchParams] = useSearchParams();

  const seedPoId = searchParams.get("poId") ?? "";
  const autoScan = searchParams.get("scan") === "1";

  // If opened with ?poId= the toggle is locked to PO mode
  const isLockedPO = Boolean(seedPoId);

  // ── Data fetches ─────────────────────────────────────────────────────────
  const { data: poResp } = useCachedJson<
    { success?: boolean; data?: PurchaseOrder[] } | PurchaseOrder[]
  >("/api/purchase-orders");

  const { data: supResp } = useCachedJson<{
    success?: boolean;
    data?: Supplier[];
  }>("/api/suppliers");

  const purchaseOrders: PurchaseOrder[] = useMemo(
    () =>
      (poResp as { data?: PurchaseOrder[] } | undefined)?.data ??
      (Array.isArray(poResp) ? poResp : []),
    [poResp],
  );

  const suppliers: Supplier[] = useMemo(
    () => supResp?.data ?? [],
    [supResp],
  );

  // POs eligible for receiving — same filter as the modal
  const eligiblePOs = useMemo(
    () =>
      purchaseOrders.filter(
        (p) =>
          p.status === "CONFIRMED" ||
          p.status === "PARTIAL_RECEIVED" ||
          p.status === "SUBMITTED",
      ),
    [purchaseOrders],
  );

  // ── Mode state ────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<GRNMode>("po");

  // ── Shared form state ─────────────────────────────────────────────────────
  const [receivedBy, setReceivedBy] = useState("");
  const [notes, setNotes] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // ── PO-mode state ─────────────────────────────────────────────────────────
  const [selectedPO, setSelectedPO] = useState(seedPoId);
  const [poItemEntries, setPoItemEntries] = useState<POItemEntry[]>([]);

  const po = purchaseOrders.find((p) => p.id === selectedPO);

  // ── Manual-mode state ─────────────────────────────────────────────────────
  const [supplierId, setSupplierId] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [manualItems, setManualItems] = useState<ManualItemEntry[]>([
    newManualRow(),
  ]);

  // ── Auto-scan gate: mirror modal's logic exactly ──────────────────────────
  const autoScanFired = useRef(false);
  useEffect(() => {
    if (autoScan && po && !autoScanFired.current) {
      autoScanFired.current = true;
      setScanOpen(true);
    }
  }, [autoScan, po]);

  // ── Seed PO item entries when PO changes ──────────────────────────────────
  /* eslint-disable react-hooks/set-state-in-effect -- seed from PO */
  useEffect(() => {
    if (po) {
      setPoItemEntries(
        po.items.map((item, idx) => {
          const remaining = Math.max(0, item.quantity - (item.receivedQty || 0));
          return {
            poItemIndex: idx,
            receivedQty: remaining,
            acceptedQty: remaining,
            rejectedQty: 0,
            rejectionReason: "",
          };
        }),
      );
    } else {
      setPoItemEntries([]);
    }
  }, [selectedPO, po]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ── PO item mutator ───────────────────────────────────────────────────────
  const updatePoItem = (idx: number, field: string, value: number | string) => {
    const updated = [...poItemEntries];
    updated[idx] = { ...updated[idx], [field]: value };
    if (field === "receivedQty" || field === "rejectedQty") {
      const recv =
        field === "receivedQty" ? (value as number) : updated[idx].receivedQty;
      const rej =
        field === "rejectedQty" ? (value as number) : updated[idx].rejectedQty;
      updated[idx].acceptedQty = Math.max(0, recv - rej);
    }
    setPoItemEntries(updated);
  };

  // ── Manual item mutators ──────────────────────────────────────────────────
  const updateManualItem = (
    rowId: number,
    field: keyof ManualItemEntry,
    value: string | number,
  ) => {
    setManualItems((prev) =>
      prev.map((row) => {
        if (row.id !== rowId) return row;
        const next = { ...row, [field]: value };
        if (field === "receivedQty" || field === "rejectedQty") {
          const recv =
            field === "receivedQty" ? (value as number) : row.receivedQty;
          const rej =
            field === "rejectedQty" ? (value as number) : row.rejectedQty;
          next.acceptedQty = Math.max(0, recv - rej);
        }
        return next;
      }),
    );
  };

  const addManualRow = () =>
    setManualItems((prev) => [...prev, newManualRow()]);

  const deleteManualRow = (rowId: number) =>
    setManualItems((prev) => {
      const next = prev.filter((r) => r.id !== rowId);
      return next.length === 0 ? [newManualRow()] : next;
    });

  // ── Supplier picker handler ───────────────────────────────────────────────
  const handleSupplierChange = (id: string) => {
    setSupplierId(id);
    const s = suppliers.find((x) => x.id === id);
    setSupplierName(s?.name ?? "");
  };

  // ── OCR apply ────────────────────────────────────────────────────────────
  const applyOcr = (ex: SupplierExtraction) => {
    if (mode === "po") {
      // PO mode — match against PO lines (existing behaviour)
      if (!po) return;
      const norm = (s: string | null | undefined) =>
        String(s ?? "")
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, "");
      setPoItemEntries((prev) => {
        const next = prev.map((e) => ({ ...e }));
        for (const line of ex.lines ?? []) {
          const qty = Number(line.qty) || 0;
          if (qty <= 0) continue;
          const codeN = norm(line.supplierCode);
          const descN = norm(line.description);
          const idx = po.items.findIndex((it) => {
            const sku = norm(it.supplierSKU);
            const nm = norm(it.materialName);
            const codeHit =
              !!codeN &&
              !!sku &&
              (sku === codeN || sku.includes(codeN) || codeN.includes(sku));
            const nameHit =
              !!descN && !!nm && (nm.includes(descN) || descN.includes(nm));
            return codeHit || nameHit;
          });
          if (idx >= 0 && next[idx]) {
            const remaining = Math.max(
              0,
              po.items[idx].quantity - (po.items[idx].receivedQty || 0),
            );
            const recv = remaining > 0 ? Math.min(qty, remaining) : qty;
            next[idx] = { ...next[idx], receivedQty: recv, acceptedQty: recv };
          }
        }
        return next;
      });
    } else {
      // Manual mode — append OCR lines into the free grid
      const newRows: ManualItemEntry[] = (ex.lines ?? [])
        .filter((line) => (Number(line.qty) || 0) > 0)
        .map((line) => ({
          id: nextRowId++,
          materialName: line.description ?? "",
          materialCode: line.supplierCode ?? "",
          receivedQty: Number(line.qty) || 0,
          acceptedQty: Number(line.qty) || 0,
          rejectedQty: 0,
          rejectionReason: "",
          unitPriceSen: 0,
        }));
      if (newRows.length > 0) {
        setManualItems((prev) => {
          // Drop the initial empty placeholder row if it's still blank
          const cleaned =
            prev.length === 1 && !prev[0].materialName && prev[0].receivedQty === 0
              ? []
              : prev;
          return [...cleaned, ...newRows];
        });
      }
    }
  };

  // ── Derived summary ───────────────────────────────────────────────────────
  const activeEntries =
    mode === "po"
      ? poItemEntries
      : manualItems.map((m) => ({
          receivedQty: m.receivedQty,
          acceptedQty: m.acceptedQty,
          rejectedQty: m.rejectedQty,
        }));

  const totalReceived = activeEntries.reduce((s, e) => s + e.receivedQty, 0);
  const totalAccepted = activeEntries.reduce((s, e) => s + e.acceptedQty, 0);
  const totalRejected = activeEntries.reduce((s, e) => s + e.rejectedQty, 0);
  const hasItems =
    mode === "po"
      ? poItemEntries.some((e) => e.receivedQty > 0)
      : manualItems.some((e) => e.receivedQty > 0 && e.materialName.trim());

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (saving) return;

    if (mode === "po") {
      if (!po) {
        toast.error("Select a purchase order");
        return;
      }
      if (!receivedBy.trim()) {
        toast.error("Enter the name of the person who received the goods");
        return;
      }
      if (!hasItems) {
        toast.error("Enter received quantities for at least one item");
        return;
      }
    } else {
      if (!supplierId) {
        toast.error("Select a supplier");
        return;
      }
      if (!receivedBy.trim()) {
        toast.error("Enter the name of the person who received the goods");
        return;
      }
      const validLines = manualItems.filter(
        (m) => m.materialName.trim() && m.receivedQty > 0,
      );
      if (validLines.length === 0) {
        toast.error(
          "Add at least one line with a material name and received quantity",
        );
        return;
      }
    }

    setSaving(true);
    try {
      let body: Record<string, unknown>;

      if (mode === "po") {
        body = {
          poId: po!.id,
          receivedBy: receivedBy.trim(),
          notes: notes.trim(),
          items: poItemEntries.filter((ie) => ie.receivedQty > 0),
        };
      } else {
        const validLines = manualItems.filter(
          (m) => m.materialName.trim() && m.receivedQty > 0,
        );
        body = {
          supplierId,
          supplierName,
          receivedBy: receivedBy.trim(),
          notes: notes.trim(),
          items: validLines.map((m) => ({
            materialName: m.materialName.trim(),
            materialCode: m.materialCode.trim(),
            receivedQty: m.receivedQty,
            acceptedQty: m.acceptedQty,
            rejectedQty: m.rejectedQty,
            rejectionReason: m.rejectionReason.trim() || null,
            unitPriceSen: m.unitPriceSen,
          })),
        };
      }

      const res = await fetch("/api/grn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const resBody = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        data?: { id?: string };
      };
      if (!res.ok || !resBody.success) {
        toast.error(
          resBody.error || `Failed to create GRN (HTTP ${res.status})`,
        );
        return;
      }
      invalidateCachePrefix("/api/grn");
      invalidateCachePrefix("/api/purchase-orders");
      invalidateCachePrefix("/api/inventory");
      invalidateCachePrefix("/api/raw-materials");
      toast.success("GRN created");
      navigate("/procurement/grn");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Network error creating GRN",
      );
    } finally {
      setSaving(false);
    }
  };

  // Summary display values
  const summaryPO = mode === "po" ? (po ? po.poNo : "—") : "—";
  const summarySupplier =
    mode === "po"
      ? po
        ? po.supplierName
        : "—"
      : supplierName || "—";

  // ── Scan modal context ───────────────────────────────────────────────────
  const scanSupplierId =
    mode === "po" ? (po?.supplierId ?? null) : (supplierId || null);
  const scanSupplierName =
    mode === "po" ? (po?.supplierName ?? null) : (supplierName || null);
  const scanPoContext =
    mode === "po" && po
      ? po.items
          .map((it) =>
            `${it.supplierSKU || ""} ${it.materialName || ""}`.trim(),
          )
          .filter(Boolean)
          .join("\n")
      : undefined;

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header strip */}
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/procurement/grn")}
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-[#1F1D1B]">
            New Goods Receipt Note
          </h1>
          <p className="text-xs text-[#6B7280]">
            Procurement &rarr; GRN &rarr; New GRN
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => navigate("/procurement/grn")}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          disabled={
            saving ||
            (mode === "po" ? !po || !hasItems : !supplierId || !hasItems)
          }
          className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
          title={
            mode === "po"
              ? !po
                ? "Select a purchase order first"
                : !hasItems
                  ? "Enter received quantities for at least one item"
                  : undefined
              : !supplierId
                ? "Select a supplier first"
                : !hasItems
                  ? "Add at least one line with a material name and received quantity"
                  : undefined
          }
        >
          <Save className="h-4 w-4" />
          {saving ? "Saving..." : "Create GRN"}
        </Button>
      </div>

      {/* Top section: GRN Details (2/3) + Summary (1/3) */}
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle>GRN Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Mode toggle — hidden when ?poId= locks us to PO mode */}
            {!isLockedPO && (
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">
                  Receipt Type
                </label>
                <div className="inline-flex rounded-md border border-[#E2DDD8] overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setMode("po")}
                    className={`px-4 py-2 text-sm font-medium transition-colors ${
                      mode === "po"
                        ? "bg-[#6B5C32] text-white"
                        : "bg-white text-[#374151] hover:bg-[#FAF9F7]"
                    }`}
                  >
                    From Purchase Order
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode("manual")}
                    className={`px-4 py-2 text-sm font-medium border-l border-[#E2DDD8] transition-colors ${
                      mode === "manual"
                        ? "bg-[#6B5C32] text-white"
                        : "bg-white text-[#374151] hover:bg-[#FAF9F7]"
                    }`}
                  >
                    Manual (no PO)
                  </button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* PO selector (PO mode) or Supplier picker (Manual mode) */}
              {mode === "po" ? (
                <div>
                  <label className="block text-sm font-medium text-[#374151] mb-1.5">
                    Purchase Order *
                  </label>
                  {isLockedPO ? (
                    <div className="flex h-10 w-full items-center rounded-md border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2 text-sm text-[#374151]">
                      {po ? `${po.poNo} - ${po.supplierName}` : "Loading PO…"}
                    </div>
                  ) : eligiblePOs.length === 0 ? (
                    <div className="rounded-md border border-[#E8D597] bg-[#FAEFCB] px-3 py-2 text-xs text-[#6B5C32]">
                      <span className="font-medium">
                        No purchase orders are ready to receive.
                      </span>{" "}
                      A PO must be <b>Submitted</b> or <b>Confirmed</b> first
                      — open the PO, submit/confirm it, then come back here to
                      record the goods.
                    </div>
                  ) : (
                    <select
                      className="flex h-10 w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
                      value={selectedPO}
                      onChange={(e) => setSelectedPO(e.target.value)}
                      required
                    >
                      <option value="">Select PO…</option>
                      {eligiblePOs.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.poNo} - {p.supplierName}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              ) : (
                <div>
                  <label className="block text-sm font-medium text-[#374151] mb-1.5">
                    Supplier *
                  </label>
                  <SearchableSelect
                    value={supplierId}
                    onChange={handleSupplierChange}
                    options={suppliers.map((s) => ({
                      value: s.id,
                      label: `${s.code} - ${s.name}`,
                    }))}
                    placeholder="Search supplier…"
                  />
                </div>
              )}

              {/* Received By */}
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">
                  Received By *
                </label>
                <Input
                  value={receivedBy}
                  onChange={(e) => setReceivedBy(e.target.value)}
                  placeholder="e.g. Ahmad bin Ismail"
                />
              </div>
            </div>

            {/* Notes */}
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1.5">
                Notes
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                placeholder="Optional delivery notes, discrepancy remarks..."
              />
            </div>
          </CardContent>
        </Card>

        {/* Summary card */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {mode === "po" && (
              <div className="flex justify-between text-sm">
                <span className="text-[#6B7280]">PO</span>
                <span className="font-medium text-right truncate max-w-[160px]">
                  {summaryPO}
                </span>
              </div>
            )}
            <div className="flex justify-between text-sm">
              <span className="text-[#6B7280]">Supplier</span>
              <span className="font-medium text-right truncate max-w-[160px]">
                {summarySupplier}
              </span>
            </div>
            {mode === "po" && (
              <div className="flex justify-between text-sm">
                <span className="text-[#6B7280]">Line Items</span>
                <span className="font-medium">{poItemEntries.length}</span>
              </div>
            )}
            {mode === "manual" && (
              <div className="flex justify-between text-sm">
                <span className="text-[#6B7280]">Line Items</span>
                <span className="font-medium">
                  {manualItems.filter(
                    (m) => m.materialName.trim() && m.receivedQty > 0,
                  ).length}
                </span>
              </div>
            )}
            <hr className="border-[#E2DDD8]" />
            <div className="flex justify-between text-sm">
              <span className="text-[#6B7280]">Total Received</span>
              <span className="font-medium">{totalReceived}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-[#6B7280]">Accepted</span>
              <span className="font-medium text-[#4F7C3A]">{totalAccepted}</span>
            </div>
            {totalRejected > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-[#6B7280]">Rejected</span>
                <span className="font-medium text-[#9A3A2D]">
                  {totalRejected}
                </span>
              </div>
            )}
            <div className="text-xs text-[#9CA3AF]">Status: DRAFT</div>
          </CardContent>
        </Card>
      </div>

      {/* Items card — full width */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle>
              {mode === "po"
                ? po
                  ? `Items — Enter Received Quantities (${poItemEntries.length})`
                  : "Items"
                : "Items — Enter Lines"}
            </CardTitle>
            <div className="flex items-center gap-2">
              {/* Scan button: PO mode needs a PO selected; Manual mode available once supplier picked */}
              {(mode === "po" ? po : supplierId) && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setScanOpen(true)}
                  title="Snap/upload a supplier delivery note or invoice to auto-fill received quantities"
                >
                  <ScanLine className="h-4 w-4" /> Scan supplier document
                </Button>
              )}
              {mode === "manual" && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addManualRow}
                >
                  <Plus className="h-4 w-4" /> Add Line
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {mode === "po" ? (
            !po ? (
              <div className="rounded-md border border-dashed border-[#E2DDD8] bg-[#FAF9F7] py-10 text-center text-sm text-[#9CA3AF]">
                Select a purchase order above to load its items.
              </div>
            ) : (
              <div className="overflow-x-auto rounded-md border border-[#E2DDD8]">
                <table className="w-full text-sm">
                  <thead className="bg-[#F0ECE9] border-b border-[#E2DDD8]">
                    <tr className="text-xs uppercase tracking-wide text-[#6B7280]">
                      <th
                        className="text-left px-3 py-2 font-medium"
                        style={{ minWidth: 200 }}
                      >
                        Material
                      </th>
                      <th
                        className="text-right px-3 py-2 font-medium"
                        style={{ minWidth: 110 }}
                      >
                        Ordered
                      </th>
                      <th
                        className="text-right px-3 py-2 font-medium"
                        style={{ minWidth: 110 }}
                      >
                        Received
                      </th>
                      <th
                        className="text-right px-3 py-2 font-medium"
                        style={{ minWidth: 110 }}
                      >
                        Rejected
                      </th>
                      <th
                        className="text-right px-3 py-2 font-medium"
                        style={{ minWidth: 90 }}
                      >
                        Accepted
                      </th>
                      <th
                        className="text-left px-3 py-2 font-medium"
                        style={{ minWidth: 180 }}
                      >
                        Rejection Reason
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {po.items.map((poItem, idx) => {
                      const entry = poItemEntries[idx];
                      if (!entry) return null;
                      const alreadyReceived = poItem.receivedQty || 0;
                      const cumulative = alreadyReceived + entry.receivedQty;
                      const overReceipt = cumulative > poItem.quantity * 1.1;
                      return (
                        <tr
                          key={idx}
                          className="border-t border-[#E2DDD8] hover:bg-[#FAF9F7]"
                        >
                          <td className="px-3 py-2">
                            <div className="font-medium text-[#1F1D1B]">
                              {poItem.materialName}
                            </div>
                            <div className="text-xs text-[#9CA3AF]">
                              {poItem.supplierSKU}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <div className="text-[#374151]">
                              {poItem.quantity} {poItem.unit}
                            </div>
                            {alreadyReceived > 0 && (
                              <div className="text-[10px] text-[#6B5C32]">
                                {alreadyReceived} already received
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Input
                              type="number"
                              onFocus={(e) => e.currentTarget.select()}
                              min={0}
                              className={`w-24 text-right ml-auto ${overReceipt ? "border-[#9A3A2D]" : ""}`}
                              value={entry.receivedQty}
                              onChange={(e) =>
                                updatePoItem(
                                  idx,
                                  "receivedQty",
                                  Number(e.target.value),
                                )
                              }
                            />
                            {overReceipt && (
                              <div className="text-[10px] text-[#9A3A2D] mt-0.5">
                                Exceeds 110%
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <Input
                              type="number"
                              onFocus={(e) => e.currentTarget.select()}
                              min={0}
                              max={entry.receivedQty}
                              className="w-24 text-right ml-auto"
                              value={entry.rejectedQty}
                              onChange={(e) =>
                                updatePoItem(
                                  idx,
                                  "rejectedQty",
                                  Number(e.target.value),
                                )
                              }
                            />
                          </td>
                          <td className="px-3 py-2 text-right font-medium text-[#1F1D1B]">
                            {entry.acceptedQty}
                          </td>
                          <td className="px-3 py-2">
                            {entry.rejectedQty > 0 && (
                              <Input
                                placeholder="Reason..."
                                className="text-xs"
                                value={entry.rejectionReason}
                                onChange={(e) =>
                                  updatePoItem(
                                    idx,
                                    "rejectionReason",
                                    e.target.value,
                                  )
                                }
                              />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-[#FAF9F7] border-t border-[#E2DDD8]">
                    <tr>
                      <td
                        colSpan={2}
                        className="px-3 py-2 text-right text-sm font-medium text-[#6B7280]"
                      >
                        Totals
                      </td>
                      <td className="px-3 py-2 text-right text-sm font-bold text-[#1F1D1B]">
                        {totalReceived}
                      </td>
                      <td className="px-3 py-2 text-right text-sm font-bold text-[#9A3A2D]">
                        {totalRejected > 0 ? totalRejected : "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-sm font-bold text-[#4F7C3A]">
                        {totalAccepted}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )
          ) : (
            /* Manual mode grid */
            <div className="overflow-x-auto rounded-md border border-[#E2DDD8]">
              <table className="w-full text-sm">
                <thead className="bg-[#F0ECE9] border-b border-[#E2DDD8]">
                  <tr className="text-xs uppercase tracking-wide text-[#6B7280]">
                    <th
                      className="text-left px-3 py-2 font-medium"
                      style={{ minWidth: 200 }}
                    >
                      Material Name *
                    </th>
                    <th
                      className="text-left px-3 py-2 font-medium"
                      style={{ minWidth: 130 }}
                    >
                      Code
                    </th>
                    <th
                      className="text-right px-3 py-2 font-medium"
                      style={{ minWidth: 110 }}
                    >
                      Received
                    </th>
                    <th
                      className="text-right px-3 py-2 font-medium"
                      style={{ minWidth: 110 }}
                    >
                      Rejected
                    </th>
                    <th
                      className="text-right px-3 py-2 font-medium"
                      style={{ minWidth: 90 }}
                    >
                      Accepted
                    </th>
                    <th
                      className="text-right px-3 py-2 font-medium"
                      style={{ minWidth: 120 }}
                    >
                      Unit Price (RM)
                    </th>
                    <th
                      className="text-left px-3 py-2 font-medium"
                      style={{ minWidth: 160 }}
                    >
                      Rejection Reason
                    </th>
                    <th className="px-3 py-2" style={{ width: 44 }} />
                  </tr>
                </thead>
                <tbody>
                  {manualItems.map((row) => (
                    <tr
                      key={row.id}
                      className="border-t border-[#E2DDD8] hover:bg-[#FAF9F7]"
                    >
                      <td className="px-3 py-2">
                        <Input
                          value={row.materialName}
                          onChange={(e) =>
                            updateManualItem(
                              row.id,
                              "materialName",
                              e.target.value,
                            )
                          }
                          placeholder="e.g. Fabric — BL-400"
                          className="text-sm"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          value={row.materialCode}
                          onChange={(e) =>
                            updateManualItem(
                              row.id,
                              "materialCode",
                              e.target.value,
                            )
                          }
                          placeholder="Optional"
                          className="text-sm"
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Input
                          type="number"
                          onFocus={(e) => e.currentTarget.select()}
                          min={0}
                          value={row.receivedQty}
                          onChange={(e) =>
                            updateManualItem(
                              row.id,
                              "receivedQty",
                              Number(e.target.value),
                            )
                          }
                          className="w-24 text-right ml-auto"
                        />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Input
                          type="number"
                          onFocus={(e) => e.currentTarget.select()}
                          min={0}
                          max={row.receivedQty}
                          value={row.rejectedQty}
                          onChange={(e) =>
                            updateManualItem(
                              row.id,
                              "rejectedQty",
                              Number(e.target.value),
                            )
                          }
                          className="w-24 text-right ml-auto"
                        />
                      </td>
                      <td className="px-3 py-2 text-right font-medium text-[#1F1D1B]">
                        {row.acceptedQty}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <MoneyInput
                          value={row.unitPriceSen / 100}
                          onChange={(v) =>
                            updateManualItem(
                              row.id,
                              "unitPriceSen",
                              Math.round((v ?? 0) * 100),
                            )
                          }
                          className="w-28 ml-auto"
                          placeholder="0.00"
                        />
                      </td>
                      <td className="px-3 py-2">
                        {row.rejectedQty > 0 && (
                          <Input
                            placeholder="Reason..."
                            className="text-xs"
                            value={row.rejectionReason}
                            onChange={(e) =>
                              updateManualItem(
                                row.id,
                                "rejectionReason",
                                e.target.value,
                              )
                            }
                          />
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => deleteManualRow(row.id)}
                          className="text-[#9CA3AF] hover:text-[#9A3A2D]"
                          title="Remove line"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-[#FAF9F7] border-t border-[#E2DDD8]">
                  <tr>
                    <td
                      colSpan={2}
                      className="px-3 py-2 text-right text-sm font-medium text-[#6B7280]"
                    >
                      Totals
                    </td>
                    <td className="px-3 py-2 text-right text-sm font-bold text-[#1F1D1B]">
                      {totalReceived}
                    </td>
                    <td className="px-3 py-2 text-right text-sm font-bold text-[#9A3A2D]">
                      {totalRejected > 0 ? totalRejected : "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-sm font-bold text-[#4F7C3A]">
                      {totalAccepted}
                    </td>
                    <td colSpan={3} />
                  </tr>
                </tfoot>
              </table>
              <div className="px-3 pb-3 pt-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addManualRow}
                  className="text-[#6B5C32] border-[#6B5C32] hover:bg-[#FAF9F7]"
                >
                  <Plus className="h-4 w-4" /> Add Line
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Scan supplier document modal */}
      <ScanSupplierModal
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        supplierId={scanSupplierId}
        supplierName={scanSupplierName}
        poContext={scanPoContext}
        onApply={applyOcr}
      />
    </div>
  );
}
