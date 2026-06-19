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
//   ?poId=<id>   — pre-select a PO (mirrors lockedPoId in the modal)
//   ?scan=1      — auto-open the scan modal once a PO is selected
// ---------------------------------------------------------------------------

import React, { useState, useEffect, useRef, useMemo, Suspense } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useToast } from "@/components/ui/toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import type { PurchaseOrder } from "@/types";
import { ArrowLeft, Save, ScanLine } from "lucide-react";
import {
  ScanSupplierModal,
  type SupplierExtraction,
} from "@/components/scan-supplier-modal";

// ── Types ──────────────────────────────────────────────────────────────────

type ItemEntry = {
  poItemIndex: number;
  receivedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  rejectionReason: string;
};

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

  // ── Data fetches ─────────────────────────────────────────────────────────
  const { data: poResp } = useCachedJson<
    { success?: boolean; data?: PurchaseOrder[] } | PurchaseOrder[]
  >("/api/purchase-orders");

  const purchaseOrders: PurchaseOrder[] = useMemo(
    () =>
      (poResp as { data?: PurchaseOrder[] } | undefined)?.data ??
      (Array.isArray(poResp) ? poResp : []),
    [poResp],
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

  // ── Form state ────────────────────────────────────────────────────────────
  const [selectedPO, setSelectedPO] = useState(seedPoId);
  const [receivedBy, setReceivedBy] = useState("");
  const [notes, setNotes] = useState("");
  const [itemEntries, setItemEntries] = useState<ItemEntry[]>([]);
  const [scanOpen, setScanOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const po = purchaseOrders.find((p) => p.id === selectedPO);

  // If the seed PO came from the query param but is not in the eligible list
  // (e.g. arrived from /procurement/grn/create?poId=xxx via Receive Goods on
  // the PO detail page), still show it. The real access guard stays backend.
  const isLockedPO = Boolean(seedPoId);

  // ── Auto-scan gate: mirror modal's logic exactly ──────────────────────────
  // The scan modal is only opened once a PO is selected because applyOcr
  // needs the PO's item list to match scanned lines against. Never auto-open
  // before a PO is picked.
  const autoScanFired = useRef(false);
  useEffect(() => {
    if (autoScan && po && !autoScanFired.current) {
      autoScanFired.current = true;
      setScanOpen(true);
    }
  }, [autoScan, po]);

  // ── Seed item entries when PO changes ────────────────────────────────────
  /* eslint-disable react-hooks/set-state-in-effect -- seed item entries from the selected PO when the user picks one */
  useEffect(() => {
    if (po) {
      setItemEntries(
        po.items.map((item, idx) => {
          // Seed with REMAINING qty (ordered − already-received), matching
          // the modal's logic so PARTIAL_RECEIVED top-ups don't force manual
          // subtraction on every line.
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
      setItemEntries([]);
    }
  }, [selectedPO, po]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ── Item mutator ──────────────────────────────────────────────────────────
  const updateItem = (idx: number, field: string, value: number | string) => {
    const updated = [...itemEntries];
    updated[idx] = { ...updated[idx], [field]: value };
    if (field === "receivedQty" || field === "rejectedQty") {
      const recv =
        field === "receivedQty" ? (value as number) : updated[idx].receivedQty;
      const rej =
        field === "rejectedQty" ? (value as number) : updated[idx].rejectedQty;
      updated[idx].acceptedQty = Math.max(0, recv - rej);
    }
    setItemEntries(updated);
  };

  // ── OCR apply — same logic as modal ──────────────────────────────────────
  const applyOcr = (ex: SupplierExtraction) => {
    if (!po) return;
    const norm = (s: string | null | undefined) =>
      String(s ?? "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "");
    setItemEntries((prev) => {
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
  };

  // ── Derived summary ───────────────────────────────────────────────────────
  const totalReceived = itemEntries.reduce((s, e) => s + e.receivedQty, 0);
  const totalAccepted = itemEntries.reduce((s, e) => s + e.acceptedQty, 0);
  const totalRejected = itemEntries.reduce((s, e) => s + e.rejectedQty, 0);
  const hasItems = itemEntries.some((e) => e.receivedQty > 0);

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (saving) return;
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
    setSaving(true);
    try {
      const res = await fetch("/api/grn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          poId: po.id,
          receivedBy: receivedBy.trim(),
          notes: notes.trim(),
          items: itemEntries.filter((ie) => ie.receivedQty > 0),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        data?: { id?: string };
      };
      if (!res.ok || !body.success) {
        toast.error(body.error || `Failed to create GRN (HTTP ${res.status})`);
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

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header strip — matches procurement/create + sales/create */}
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
          disabled={saving || !po || !hasItems}
          className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
          title={
            !po
              ? "Select a purchase order first"
              : !hasItems
                ? "Enter received quantities for at least one item"
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* PO selector */}
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">
                  Purchase Order *
                </label>
                {isLockedPO ? (
                  <div className="flex h-10 w-full items-center rounded-md border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2 text-sm text-[#374151]">
                    {po
                      ? `${po.poNo} - ${po.supplierName}`
                      : "Loading PO…"}
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
            <div className="flex justify-between text-sm">
              <span className="text-[#6B7280]">PO</span>
              <span className="font-medium text-right truncate max-w-[160px]">
                {po ? po.poNo : "—"}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-[#6B7280]">Supplier</span>
              <span className="font-medium text-right truncate max-w-[160px]">
                {po ? po.supplierName : "—"}
              </span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-[#6B7280]">Line Items</span>
              <span className="font-medium">{itemEntries.length}</span>
            </div>
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
              {po
                ? `Items — Enter Received Quantities (${itemEntries.length})`
                : "Items"}
            </CardTitle>
            {po && (
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
          </div>
        </CardHeader>
        <CardContent>
          {!po ? (
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
                    const entry = itemEntries[idx];
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
                              updateItem(
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
                              updateItem(
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
                                updateItem(
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
          )}
        </CardContent>
      </Card>

      {/* Scan supplier document modal */}
      <ScanSupplierModal
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        supplierId={po?.supplierId ?? null}
        supplierName={po?.supplierName ?? null}
        poContext={
          po
            ? po.items
                .map((it) =>
                  `${it.supplierSKU || ""} ${it.materialName || ""}`.trim(),
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
