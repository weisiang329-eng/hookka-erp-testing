// ---------------------------------------------------------------------------
// GRN (Goods Received Note) detail page.
//
// Phase A of the purchasing parity build. The GRN list (grn.tsx) navigated to
// /procurement/grn/:id on View / double-click, but the route was never
// registered — a dead link. This page fills it: read view (mirrors
// PurchaseInvoiceDetail) + the status-gated actions the list has, including the
// previously-missing "Post to Stock" that moves a GRN to POSTED (which commits
// rm_batches / cost_ledger / balanceQty and cascades the PO). Without it,
// standalone/CONFIRMED GRNs were stuck and could never be converted to an
// invoice.
//
// Status model (hookka's own, NOT 2990's): DRAFT → CONFIRMED → POSTED.
//   Approve:        DRAFT → CONFIRMED
//   Post to Stock:  → POSTED  (commits inventory + cascades PO; idempotent)
//   Convert to PI:  POSTED-only (reuses the GRN list's exact payload)
// ---------------------------------------------------------------------------
import { useState, useMemo } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft, FileText, Package, CheckCircle2, PackageCheck, Receipt, Printer,
  Ship, ChevronDown, ChevronUp, DollarSign, Lock, Ban,
} from "lucide-react";
import { AuditHistoryPanel } from "@/components/audit/AuditHistoryPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { ObjectPageHeader } from "@/components/ui/object-page-header";
import { PurchaseLineageBar } from "@/components/ui/purchase-lineage-bar";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { useCachedJson, invalidateCachePrefix, isUnknownOutcome } from "@/lib/cached-fetch";
import { RecordLoadError } from "@/components/ui/record-load-error";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  isGrnLineEditable,
  isGrnLineLockedByPi,
  isGrnFullyLockedByDownstreamPi,
  countGrnLinesLockedByPi,
  grnLineInvoicedQty,
  checkGrnLineQtyEdit,
  describeGrnStockDelta,
} from "@/lib/purchase-edit-rules";
import type { ArrivalState } from "@/types";

// Arrival state pipeline sequences for the stepper
const ARRIVAL_SEQUENCE: ArrivalState[] = ["NOT_ARRIVED", "IN_TRANSIT", "AT_CUSTOMS", "ARRIVED"];

// Color per arrival state
const ARRIVAL_COLORS: Record<ArrivalState, string> = {
  NOT_ARRIVED: "#9CA3AF",
  IN_TRANSIT: "#3B82F6",
  AT_CUSTOMS: "#F97316",
  ARRIVED: "#10B981",
};

// Labels for display — NOT_ARRIVED shows as "Planning" to match DO pipeline.
const ARRIVAL_LABELS: Record<ArrivalState, string> = {
  NOT_ARRIVED: "Planning",
  IN_TRANSIT: "In Transit",
  AT_CUSTOMS: "At Customs",
  ARRIVED: "Arrived",
};

// Which state does the "advance" button target?
function nextArrivalState(current: ArrivalState): ArrivalState | null {
  if (current === "NOT_ARRIVED") return "IN_TRANSIT";
  if (current === "IN_TRANSIT") return "AT_CUSTOMS";
  if (current === "AT_CUSTOMS") return "ARRIVED";
  return null; // ARRIVED is terminal
}

// Label for the advance button
function advanceLabel(current: ArrivalState): string {
  if (current === "NOT_ARRIVED") return "Mark In Transit";
  if (current === "IN_TRANSIT") return "Mark At Customs";
  if (current === "AT_CUSTOMS") return "Mark Arrived";
  return "";
}

type GRNItem = {
  id?: number | string;
  poItemIndex: number;
  materialCode: string;
  supplierSKU?: string;
  materialName: string;
  orderedQty: number;
  receivedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  rejectionReason: string | null;
  unitPrice: number; // sen
  // Convert-chain: qty already pulled into a PI off this line (read-only here;
  // a POSTED-line edit can't drop accepted below this).
  invoicedQty?: number;
};

type GRNDetail = {
  id: string;
  grnNumber: string;
  poId: string;
  poNumber: string;
  supplierId: string;
  supplierName: string;
  receiveDate: string;
  receivedBy: string;
  items: GRNItem[];
  totalAmount: number; // sen
  qcStatus: string;
  status: string;
  notes: string | null;
  // Arrival pipeline
  arrival_state: ArrivalState;
  shipping_method: string | null;
  carrier_name: string | null;
  tracking_number: string | null;
  container_number: string | null;
  expected_arrival: string | null;
  shipped_date: string | null;
  actual_arrival: string | null;
  customs_status: string | null;
  customs_clearance_date: string | null;
  shipping_cost_sen: number;
  customs_duty_sen: number;
  exchange_rate: number | null;
  currency: string | null;
  landed_cost_sen: number;
  supplier_do_no: string | null;
  // Set when the receipt was cancelled (stock reversed, PO quantity released).
  cancelled_at?: string | null;
  cancelled_reason?: string | null;
};

export default function GRNDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [busy, setBusy] = useState(false);
  // Supplier DO No. inline edit — null = read view, string = editing.
  const [supplierDoEdit, setSupplierDoEdit] = useState<string | null>(null);
  // Shipment card expansion
  const [shipmentOpen, setShipmentOpen] = useState(true);
  // Landed cost section expansion
  const [landedOpen, setLandedOpen] = useState(false);
  // Local editable shipment / landed cost fields (dirty when changed from server values)
  const [shipmentEdit, setShipmentEdit] = useState<{
    shipping_method: string;
    carrier_name: string;
    tracking_number: string;
    container_number: string;
    expected_arrival: string;
    actual_arrival: string;
    customs_status: string;
    customs_clearance_date: string;
  } | null>(null);
  const [landedEdit, setLandedEdit] = useState<{
    shipping_cost_sen: number;
    customs_duty_sen: number;
    exchange_rate: string;
    currency: string;
  } | null>(null);
  // Accepted-qty line edit (POSTED GRN) — null = read view, array of RM-string
  // accepted-qty values per line (parallel to items) = editing.
  const [qtyEdit, setQtyEdit] = useState<string[] | null>(null);

  const { data: resp, loading, error: fetchError, failure, refresh } = useCachedJson<{
    success?: boolean;
    data?: GRNDetail;
    error?: string;
  }>(id ? `/api/grn/${id}` : null);

  // Purchase Company letterhead — print the GRN under the supplier's buying
  // company (HOOKKA / OHANA / any sister co); accounting stays HOOKKA.
  const { data: supResp } = useCachedJson<{ data?: Array<{ id: string; purchaseOrgCode?: string }> }>("/api/suppliers");
  const { data: orgsResp } = useCachedJson<{ organisations?: Array<{ code?: string; name?: string; regNo?: string; tin?: string; address?: string; phone?: string; email?: string }> }>("/api/organisations");

  // Lineage: PIs raised against the parent PO (matched client-side by purchaseOrderId).
  // Same endpoint the PO detail page uses — useCachedJson dedupes in-flight requests.
  const { data: piListResp } = useCachedJson<{
    success?: boolean;
    data?: Array<{ id: string; piNo?: string; purchaseOrderId?: string | null; status?: string | null }>;
  }>("/api/purchase-invoices");

  const grn: GRNDetail | null = resp?.success ? resp.data ?? null : null;
  const error: string | null =
    fetchError ?? (resp && resp.success === false ? resp.error || "GRN not found" : null);

  const items = grn?.items ?? [];

  // PIs that reference the same PO as this GRN — derived client-side from the
  // shared PI list (no extra endpoint needed; list is small).
  const relatedPis = useMemo(
    () =>
      grn?.poId
        ? (piListResp?.data ?? []).filter((p) => p.purchaseOrderId === grn.poId)
        : [],
    [piListResp, grn],
  );

  // PUT a status transition; surface failures (verified-save spirit), and on a
  // Post-to-Stock surface the backend's unresolved-lines warning if any.
  async function setStatus(next: "CONFIRMED" | "POSTED", label: string) {
    if (!grn) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/grn/${grn.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const j = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: string; data?: { costing?: { unresolvedLines?: number } } }
        | null;
      if (!res.ok || !j?.success) {
        toast.error(j?.error || `${label} failed (${res.status})`);
        return;
      }
      const unresolved = j.data?.costing?.unresolvedLines ?? 0;
      if (next === "POSTED" && unresolved > 0) {
        toast.error(
          `Posted, but ${unresolved} line(s) had no matching raw material — that stock did NOT land. Check the item codes.`,
        );
      } else {
        toast.success(`${label} — done`);
      }
      invalidateCachePrefix("/api/grn");
      // Post-to-Stock lands inventory (raw_materials.balanceQty), so refresh the
      // inventory surfaces too — otherwise they show stale on-hand until TTL.
      if (next === "POSTED") {
        invalidateCachePrefix("/api/raw-materials");
        invalidateCachePrefix("/api/inventory");
        invalidateCachePrefix("/api/stock-value");
      }
      refresh();
    } catch {
      toast.error(`${label} failed — network error`);
    } finally {
      setBusy(false);
    }
  }

  // Save the supplier's DO number via the main PUT /api/grn/:id.
  async function saveSupplierDoNo() {
    if (!grn || supplierDoEdit === null) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/grn/${grn.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplier_do_no: supplierDoEdit.trim() || null }),
      });
      const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (!res.ok || !j?.success) {
        toast.error(j?.error || "Save Supplier DO No. failed");
        return;
      }
      toast.success("Supplier DO No. saved");
      setSupplierDoEdit(null);
      invalidateCachePrefix("/api/grn");
      refresh();
    } catch {
      toast.error("Save Supplier DO No. failed — network error");
    } finally {
      setBusy(false);
    }
  }

  // Advance the arrival state by one step via PUT /api/grn/:id/arrival
  async function advanceArrival() {
    if (!grn) return;
    const target = nextArrivalState(grn.arrival_state);
    if (!target) return;
    const label = advanceLabel(grn.arrival_state);
    setBusy(true);
    try {
      const res = await fetch(`/api/grn/${grn.id}/arrival`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ arrival_state: target }),
      });
      const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (!res.ok || !j?.success) {
        toast.error(j?.error || `${label} failed (${res.status})`);
        return;
      }
      toast.success(`${label} — done`);
      invalidateCachePrefix("/api/grn");
      refresh();
    } catch {
      toast.error(`${label} failed — network error`);
    } finally {
      setBusy(false);
    }
  }

  // Save shipment details via PUT /api/grn/:id/arrival (same state = fields-only update)
  async function saveShipment() {
    if (!grn || !shipmentEdit) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/grn/${grn.id}/arrival`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          arrival_state: grn.arrival_state, // same-state → field-only update
          shipping_method: shipmentEdit.shipping_method || null,
          carrier_name: shipmentEdit.carrier_name || null,
          tracking_number: shipmentEdit.tracking_number || null,
          container_number: shipmentEdit.container_number || null,
          expected_arrival: shipmentEdit.expected_arrival || null,
          actual_arrival: shipmentEdit.actual_arrival || null,
          customs_status: shipmentEdit.customs_status || null,
          customs_clearance_date: shipmentEdit.customs_clearance_date || null,
        }),
      });
      const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (!res.ok || !j?.success) {
        toast.error(j?.error || "Save shipment failed");
        return;
      }
      toast.success("Shipment details saved");
      setShipmentEdit(null);
      invalidateCachePrefix("/api/grn");
      refresh();
    } catch {
      toast.error("Save shipment failed — network error");
    } finally {
      setBusy(false);
    }
  }

  // Save landed cost fields via PUT /api/grn/:id/arrival
  async function saveLandedCost() {
    if (!grn || !landedEdit) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        arrival_state: grn.arrival_state,
        shipping_cost_sen: landedEdit.shipping_cost_sen,
        customs_duty_sen: landedEdit.customs_duty_sen,
        currency: landedEdit.currency || null,
      };
      const exRate = parseFloat(landedEdit.exchange_rate);
      if (Number.isFinite(exRate) && exRate > 0) {
        body.exchange_rate = exRate;
      }
      // Compute and send landed_cost_sen = product total + shipping + duty
      const productSen = grn.totalAmount;
      body.landed_cost_sen = productSen + landedEdit.shipping_cost_sen + landedEdit.customs_duty_sen;

      const res = await fetch(`/api/grn/${grn.id}/arrival`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      if (!res.ok || !j?.success) {
        toast.error(j?.error || "Save landed cost failed");
        return;
      }
      toast.success("Landed cost saved");
      setLandedEdit(null);
      invalidateCachePrefix("/api/grn");
      refresh();
    } catch {
      toast.error("Save landed cost failed — network error");
    } finally {
      setBusy(false);
    }
  }

  // Save edited accepted quantities (POSTED GRN). Validates each line with the
  // SHARED rule (same message the backend uses), shows a Confirm dialog
  // describing the stock delta in plain words, then PUTs the full items[] —
  // the backend posts the compensating rm_batches/cost_ledger movement.
  async function saveQtyEdit() {
    if (!grn || !qtyEdit) return;
    // Validate + compute per-line deltas with the shared rule.
    const deltaLines: { ref: string; delta: number }[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      // A line a PI has billed keeps its stored qty verbatim — its input is
      // rendered read-only, and pinning the value here means a stale edit
      // buffer can't smuggle a change past the (identical) backend rule.
      const newAccepted = isGrnLineLockedByPi(it) ? it.acceptedQty : parseFloat(qtyEdit[i]);
      const guard = checkGrnLineQtyEdit({
        ref: it.materialName || it.materialCode || `Line ${i + 1}`,
        oldAcceptedQty: it.acceptedQty,
        newAcceptedQty: Number.isFinite(newAccepted) ? newAccepted : NaN,
        invoicedQty: it.invoicedQty ?? 0,
      });
      if (!guard.ok) {
        toast.error(guard.error);
        return;
      }
      deltaLines.push({ ref: it.materialName || it.materialCode || `Line ${i + 1}`, delta: guard.delta });
    }
    const stockMsg = describeGrnStockDelta(deltaLines);
    if (!stockMsg) {
      toast.error("No quantities changed.");
      return;
    }
    // A POSTED GRN already has stock in — the edit moves it (confirm with the
    // stock language). A DRAFT/CONFIRMED GRN hasn't posted yet, so the edit only
    // corrects the document (no stock movement) — a lighter confirm.
    const ok = await confirm({
      title: "Adjust received quantities?",
      message:
        grn.status === "POSTED"
          ? `${stockMsg} A matching cost entry is posted so inventory and cost stay in sync. Continue?`
          : "Update the accepted quantities on this goods receipt?",
      danger: false,
    });
    if (!ok) return;

    setBusy(true);
    try {
      // Send the FULL items[] with corrected acceptedQty; other fields carried
      // through verbatim (the backend only moves accepted/received on a POSTED
      // GRN and ignores structural changes).
      const payloadItems = items.map((it, i) => ({
        poItemIndex: it.poItemIndex,
        materialCode: it.materialCode,
        materialName: it.materialName,
        orderedQty: it.orderedQty,
        receivedQty: it.receivedQty,
        acceptedQty: isGrnLineLockedByPi(it) ? it.acceptedQty : parseFloat(qtyEdit[i]) || 0,
        rejectedQty: it.rejectedQty,
        rejectionReason: it.rejectionReason,
        unitPrice: it.unitPrice,
      }));
      const res = await fetch(`/api/grn/${grn.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: payloadItems }),
      });
      const j = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: string; editAdjust?: { unresolved?: unknown[] } }
        | null;
      if (!res.ok || !j?.success) {
        toast.error(j?.error || `Save failed (${res.status})`);
        return;
      }
      const unresolved = j.editAdjust?.unresolved?.length ?? 0;
      if (unresolved > 0) {
        toast.error(
          `Saved, but ${unresolved} changed line(s) had no matching raw material — that stock delta did NOT move. Check the item codes.`,
        );
      } else {
        toast.success("Received quantities updated — stock adjusted");
      }
      setQtyEdit(null);
      invalidateCachePrefix("/api/grn");
      invalidateCachePrefix("/api/raw-materials");
      invalidateCachePrefix("/api/inventory");
      invalidateCachePrefix("/api/stock-value");
      invalidateCachePrefix("/api/purchase-invoices");
      refresh();
    } catch {
      toast.error("Save failed — network error");
    } finally {
      setBusy(false);
    }
  }

  // Cancel the receipt — reverses the posted stock and hands the quantities
  // back to the purchase order. The confirmation spells out BOTH sides (which
  // PO gets what back, what leaves stock on hand) because this is the one
  // action that moves inventory downwards without a physical goods movement.
  async function cancelReceipt() {
    if (!grn) return;
    const released = items
      .filter((it) => (it.acceptedQty ?? 0) > 0)
      .map((it) => `${it.materialName || it.materialCode}: ${it.acceptedQty}`)
      .join(", ");
    const poLabel = grn.poNumber || grn.poId;
    const lines = [
      poLabel
        ? `PO ${poLabel} gets this quantity back and becomes receivable again${released ? ` — ${released}.` : "."}`
        : `This receipt has no linked purchase order${released ? ` — ${released}.` : "."}`,
      grn.status === "POSTED"
        ? "The stock it posted is removed from on hand, and the receipt's inventory lots are reversed."
        : "No stock was posted, so nothing leaves inventory.",
      "The receipt stays on file as CANCELLED and cannot be reopened.",
    ];
    const ok = await confirm({
      title: `Cancel receipt ${grn.grnNumber}?`,
      message: lines.join(" "),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/grn/${grn.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: string; stockReversal?: { batchesRemoved?: number } }
        | null;
      if (!res.ok || !j?.success) {
        toast.error(j?.error || `Cancel failed (${res.status})`);
        return;
      }
      toast.success(`${grn.grnNumber} cancelled — stock reversed and PO quantity released`);
      invalidateCachePrefix("/api/grn");
      invalidateCachePrefix("/api/purchase-orders");
      invalidateCachePrefix("/api/raw-materials");
      invalidateCachePrefix("/api/inventory");
      invalidateCachePrefix("/api/stock-value");
      refresh();
    } catch {
      toast.error("Cancel failed — network error");
    } finally {
      setBusy(false);
    }
  }

  // Convert POSTED GRN → Purchase Invoice (DRAFT). Same payload as grn.tsx list.
  async function convertToInvoice() {
    if (!grn) return;
    const ok = await confirm({
      title: "Create Purchase Invoice?",
      message: `Create Purchase Invoice from GRN ${grn.grnNumber}? Total: ${(grn.totalAmount / 100).toFixed(2)}`,
      danger: false,
    });
    if (!ok) return;
    const currency = (
      window.prompt(
        "Invoice currency — keep MYR, or type USD / CNY for a foreign supplier invoice:",
        "MYR",
      ) || ""
    )
      .trim()
      .toUpperCase();
    if (!currency) return;
    let fxRate: number | undefined;
    if (currency !== "MYR") {
      const r = parseFloat(
        window.prompt(`Booking exchange rate — MYR per 1 ${currency} (invoice-date rate):`, "") || "",
      );
      if (!Number.isFinite(r) || r <= 0) {
        toast.error("A positive exchange rate is required for a foreign invoice");
        return;
      }
      fxRate = r;
    }
    setBusy(true);
    try {
      const today = new Date().toISOString().split("T")[0];
      const piItems = items
        .filter((it) => it.acceptedQty > 0)
        .map((it) => ({
          materialCode: it.materialCode,
          materialName: it.materialName,
          qty: it.acceptedQty,
          unitPriceSen: it.unitPrice,
          lineType: "STOCKED" as const,
        }));
      const res = await fetch("/api/purchase-invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          purchaseOrderId: grn.poId,
          supplierId: grn.supplierId,
          supplierName: grn.supplierName,
          invoiceDate: today,
          amountSen: grn.totalAmount,
          remarks: `Auto-created from GRN ${grn.grnNumber}`,
          items: piItems,
          currency,
          fxRate,
        }),
      });
      const j = (await res.json().catch(() => null)) as
        | { success?: boolean; error?: string; data?: { id: string; piNo: string } }
        | null;
      if (!res.ok || !j?.success || !j.data) {
        toast.error(j?.error || "Failed to create invoice");
        return;
      }
      invalidateCachePrefix("/api/grn");
      invalidateCachePrefix("/api/purchase-invoices");
      toast.success(`Invoice ${j.data.piNo} created from GRN ${grn.grnNumber}`);
      navigate(`/procurement/pi/${j.data.id}`);
    } catch {
      toast.error("Failed to create invoice");
    } finally {
      setBusy(false);
    }
  }

  // Print the GRN as a PDF (jspdf dynamic-imported). Map this page's GRN shape
  // onto the field names generateGRNPdf reads (grnNo / date / poRef / items).
  async function printPdf() {
    if (!grn) return;
    try {
      const [{ generateGRNPdf }, { letterheadForPurchaseOrg }] = await Promise.all([
        import("@/lib/generate-grn-pdf"),
        import("@/lib/generate-purchase-order-pdf"),
      ]);
      const sup = (supResp?.data ?? []).find((s) => s.id === grn.supplierId);
      const lh = letterheadForPurchaseOrg(sup?.purchaseOrgCode || "HOOKKA", orgsResp?.organisations);
      generateGRNPdf({
        grnNo: grn.grnNumber,
        date: grn.receiveDate,
        poRef: grn.poNumber,
        supplierName: grn.supplierName,
        remarks: grn.notes ?? "",
        items: items.map((it) => ({
          itemCode: it.materialCode,
          supplierSKU: it.supplierSKU,
          description: it.materialName,
          poQty: it.orderedQty,
          receivedQty: it.receivedQty,
          rejectedQty: it.rejectedQty,
          acceptedQty: it.acceptedQty,
        })),
      }, lh);
    } catch {
      toast.error("Could not generate the PDF.");
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#6B5C32]" />
      </div>
    );
  }

  // Unknown outcome (timeout / network / 5xx) — not an absent GRN.
  // BUG-2026-08-13-016.
  if (!grn && failure && isUnknownOutcome(failure)) {
    return (
      <RecordLoadError
        subject="GRN"
        failure={failure}
        onRetry={refresh}
        backTo="/procurement/grn"
        backLabel="Back to GRNs"
      />
    );
  }

  if (error || !grn) {
    return (
      <div className="space-y-6">
        <Link to="/procurement/grn" className="inline-flex items-center gap-2 text-sm text-[#6B5C32] hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to GRNs
        </Link>
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-[#9CA3AF]">{error || "GRN not found."}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isCancelled = grn.status === "CANCELLED";
  const isPosted = grn.status === "POSTED";
  const isConfirmed = grn.status === "CONFIRMED";
  const isArrived = grn.arrival_state === "ARRIVED";
  const advanceTarget = nextArrivalState(grn.arrival_state);
  // Per-line downstream-PI lock (owner: a conversion locks the LINE it
  // consumed, never the whole document).
  const lockedLineCount = countGrnLinesLockedByPi(items);
  const fullyLockedByPi = isGrnFullyLockedByDownstreamPi(items);

  return (
    <div className="space-y-6">
      {/* Header + actions */}
      <ObjectPageHeader
        backTo="/procurement/grn"
        title={grn.grnNumber}
        subtitle={`Supplier: ${grn.supplierName}${grn.poNumber ? ` · PO ${grn.poNumber}` : ""}`}
        badges={
          <>
            <Badge variant="status" status={grn.status} />
            <Badge variant="status" status={grn.arrival_state}>
              {ARRIVAL_LABELS[grn.arrival_state]}
            </Badge>
            {grn.qcStatus ? (
              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[#F0ECE9] text-[#6B5C32]">
                QC: {grn.qcStatus}
              </span>
            ) : null}
          </>
        }
        actions={
          <>
            <Button type="button" variant="outline" size="sm" onClick={printPdf} disabled={busy}>
              <Printer className="h-3.5 w-3.5" /> Print
            </Button>
            {/* Return received goods straight from this GRN (reverses stock; no
                Debit Note since it's not invoiced). Deep-links to the Purchase
                Returns page with this GRN preselected. */}
            {!isCancelled && (
              <Button type="button" variant="outline" size="sm" onClick={() => navigate(`/purchase-returns?grn=${encodeURIComponent(grn.id)}`)} disabled={busy}>
                <PackageCheck className="h-3.5 w-3.5" /> Create Purchase Return
              </Button>
            )}
            {/* Arrival advance button — contextual, hidden when ARRIVED */}
            {advanceTarget && !isCancelled && (
              <Button type="button" variant="outline" size="sm" onClick={advanceArrival} disabled={busy}>
                <Ship className="h-3.5 w-3.5" /> {advanceLabel(grn.arrival_state)}
              </Button>
            )}
            {/* Cancel Receipt — the way a POSTED receipt dies. Reverses the
                posted stock and releases the PO quantity; refused by the
                backend while a live PI still draws on these lines, or while
                the received stock has already been issued. */}
            {!isCancelled && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={cancelReceipt}
                disabled={busy}
                className="border-[#9A3A2D] text-[#9A3A2D] hover:bg-[#9A3A2D]/10"
              >
                <Ban className="h-3.5 w-3.5" /> Cancel Receipt
              </Button>
            )}
            {!isConfirmed && !isPosted && !isCancelled && (
              <Button type="button" variant="outline" size="sm" onClick={() => setStatus("CONFIRMED", "Approve")} disabled={busy}>
                <CheckCircle2 className="h-3.5 w-3.5" /> Approve
              </Button>
            )}
            {!isPosted && !isCancelled && (
              /* Post to Stock is DISABLED unless arrival_state === 'ARRIVED'.
                 The backend enforces this via a 409 gate; the UI mirrors it
                 with a disabled state + tooltip so the operator knows why. */
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => setStatus("POSTED", "Post to Stock")}
                disabled={busy || !isArrived}
                title={!isArrived ? "Mark arrived first before posting to stock" : undefined}
                className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <PackageCheck className="h-3.5 w-3.5" /> Post to Stock
              </Button>
            )}
            {isPosted && !isCancelled && (
              <Button type="button" variant="primary" size="sm" onClick={convertToInvoice} disabled={busy} className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]">
                <Receipt className="h-3.5 w-3.5" /> Convert to Invoice
              </Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: details */}
        <Card className="lg:col-span-1">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <FileText className="h-4 w-4 text-[#6B5C32]" /> GRN Details
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-y-3 text-sm">
              <span className="text-[#6B7280]">GRN Number</span>
              <span className="font-medium text-[#1F1D1B]">{grn.grnNumber}</span>

              <span className="text-[#6B7280]">Supplier</span>
              <span className="font-medium text-[#1F1D1B]">{grn.supplierName}</span>

              <span className="text-[#6B7280]">Linked PO</span>
              <span>
                {grn.poId ? (
                  <Link to={`/procurement/${grn.poId}`} className="text-[#6B5C32] font-medium hover:underline">
                    {grn.poNumber || grn.poId}
                  </Link>
                ) : (
                  <span className="text-[#9CA3AF]">—</span>
                )}
              </span>

              <span className="text-[#6B7280]">Receive Date</span>
              <span className="text-[#4B5563]">{grn.receiveDate ? formatDate(grn.receiveDate) : "-"}</span>

              <span className="text-[#6B7280]">Received By</span>
              <span className="text-[#4B5563]">{grn.receivedBy || "-"}</span>

              <span className="text-[#6B7280]">Supplier DO No.</span>
              <span className="text-[#4B5563]">
                {supplierDoEdit === null ? (
                  <span className="inline-flex items-center gap-2">
                    {grn.supplier_do_no || "—"}
                    <button
                      type="button"
                      className="text-xs font-medium text-[#6B5C32] underline hover:text-[#5a4d2a]"
                      onClick={() => setSupplierDoEdit(grn.supplier_do_no || "")}
                      disabled={busy}
                    >
                      Edit
                    </button>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <Input
                      value={supplierDoEdit}
                      onChange={(e) => setSupplierDoEdit(e.target.value)}
                      placeholder="Supplier's DO number"
                      className="h-7 text-sm w-40"
                    />
                    <button
                      type="button"
                      className="text-xs font-medium text-[#6B5C32] hover:underline"
                      onClick={saveSupplierDoNo}
                      disabled={busy}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="text-xs font-medium text-[#9CA3AF] hover:underline"
                      onClick={() => setSupplierDoEdit(null)}
                      disabled={busy}
                    >
                      Cancel
                    </button>
                  </span>
                )}
              </span>

              <span className="text-[#6B7280]">Status</span>
              <span><Badge variant="status" status={grn.status} /></span>

              <span className="text-[#6B7280]">Arrival</span>
              <span><Badge variant="status" status={grn.arrival_state}>{ARRIVAL_LABELS[grn.arrival_state]}</Badge></span>
            </div>

            {/* Arrival stepper */}
            <div className="pt-3 border-t border-[#E2DDD8]">
              <p className="text-xs font-medium text-[#6B7280] mb-2">Arrival Progress</p>
              <div className="flex items-center gap-1">
                {ARRIVAL_SEQUENCE.map((s, i) => {
                  const currentIdx = ARRIVAL_SEQUENCE.indexOf(grn.arrival_state);
                  const isActive = i <= currentIdx;
                  const color = ARRIVAL_COLORS[s];
                  return (
                    <div key={s} className="flex items-center">
                      <div
                        className="h-2.5 w-2.5 rounded-full transition-all"
                        style={{ backgroundColor: isActive ? color : "#E2DDD8" }}
                        title={ARRIVAL_LABELS[s]}
                      />
                      {i < ARRIVAL_SEQUENCE.length - 1 && (
                        <div
                          className="h-0.5 w-6"
                          style={{
                            backgroundColor: i < currentIdx ? ARRIVAL_COLORS[ARRIVAL_SEQUENCE[i + 1]] : "#E2DDD8",
                          }}
                        />
                      )}
                    </div>
                  );
                })}
                <span className="ml-2 text-xs text-[#6B7280]">{ARRIVAL_LABELS[grn.arrival_state]}</span>
              </div>
            </div>

            {grn.notes && (
              <div className="pt-3 border-t border-[#E2DDD8]">
                <p className="text-xs font-medium text-[#6B7280] mb-1">Notes</p>
                <p className="text-sm text-[#4B5563] whitespace-pre-wrap">{grn.notes}</p>
              </div>
            )}

            <div className="pt-3 border-t border-[#E2DDD8]">
              <div className="flex justify-between text-sm font-bold">
                <span className="text-[#6B5C32]">Total</span>
                <span className="text-[#6B5C32]">{formatCurrency(grn.totalAmount)}</span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Right: items */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Package className="h-4 w-4 text-[#6B5C32]" /> Received Items ({items.length})
              </CardTitle>
              {/* Edit accepted quantities. For a POSTED GRN the save posts a
                  compensating stock movement; for DRAFT/CONFIRMED it just
                  re-lines (pre-commit). Hidden when the status doesn't allow,
                  or when EVERY line has been billed — a partially-invoiced
                  receipt still opens, with the billed lines locked
                  individually (owner: "这种转换不是整张单锁死的"). */}
              {qtyEdit === null && items.length > 0 && isGrnLineEditable(grn.status) && !fullyLockedByPi && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setQtyEdit(items.map((it) => String(it.acceptedQty ?? 0)))}
                  disabled={busy}
                >
                  Edit Quantities
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {/* Cancelled receipts are historical records. */}
            {isCancelled && (
              <div className="mb-3 rounded-md border border-[#E2C9C4] bg-[#FBF2F0] px-3 py-2 text-sm text-[#9A3A2D]">
                This receipt was cancelled{grn.cancelled_at ? ` on ${formatDate(grn.cancelled_at)}` : ""} — its stock was
                reversed and the quantity released back to the purchase order. It is read-only.
              </div>
            )}
            {/* Per-line lock notice. The document is NOT locked: only the lines
                a purchase invoice has already billed are frozen, and the table
                marks each one. */}
            {!isCancelled && items.length > 0 && isGrnLineEditable(grn.status) && lockedLineCount > 0 && (
              <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                {fullyLockedByPi
                  ? "Every line here has been billed on a purchase invoice, so nothing is editable. Void or edit that invoice to unlock the receipt."
                  : `${lockedLineCount} of ${items.length} line(s) have been billed on a purchase invoice and are locked (marked below). The remaining lines can still be corrected.`}
              </div>
            )}
            {/* Amber banner when editing a POSTED GRN's accepted quantities —
                saving moves stock + writes a cost-ledger correction. */}
            {qtyEdit !== null && grn.status === "POSTED" && (
              <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                Editing a posted GRN will adjust stock and write a cost-ledger correction.
              </div>
            )}
            {items.length === 0 ? (
              <div className="rounded-md border border-dashed border-[#E2DDD8] p-6 text-center text-sm text-[#9CA3AF]">
                No line items on this GRN.
              </div>
            ) : (
              <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                      <th className="h-10 px-3 text-left font-medium text-[#374151]">Material</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">Ordered</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">Received</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">Accepted</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">Rejected</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">Unit Price</th>
                      <th className="h-10 px-3 text-right font-medium text-[#374151]">Line Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, idx) => {
                      // This LINE's lock — a purchase invoice has billed off it,
                      // so its quantity is frozen while its neighbours stay
                      // editable.
                      const lineLocked = isGrnLineLockedByPi(it);
                      const lineInvoiced = grnLineInvoicedQty(it);
                      return (
                      <tr key={idx} className={`border-b border-[#E2DDD8] ${idx % 2 === 1 ? "bg-[#FAF9F7]" : ""}`}>
                        <td className="h-12 px-3">
                          <div className="font-medium text-[#1F1D1B]">{it.materialName}</div>
                          <div className="text-xs text-[#6B5C32]">{it.materialCode}</div>
                          {lineLocked ? (
                            <div className="inline-flex items-center gap-1 text-xs text-amber-700">
                              <Lock className="h-3 w-3" /> Locked — {lineInvoiced} invoiced
                            </div>
                          ) : null}
                          {it.rejectedQty > 0 && it.rejectionReason ? (
                            <div className="text-xs text-[#9A3A2D]">Rejected: {it.rejectionReason}</div>
                          ) : null}
                        </td>
                        <td className="h-12 px-3 text-right text-[#4B5563]">{it.orderedQty}</td>
                        <td className="h-12 px-3 text-right text-[#4B5563]">{it.receivedQty}</td>
                        <td className="h-12 px-3 text-right font-medium text-[#1F1D1B]">
                          {qtyEdit === null || lineLocked ? (
                            it.acceptedQty
                          ) : (
                            <Input
                              type="number"
                              min={0}
                              step="any"
                              className="h-8 w-24 text-right inline-block"
                              value={qtyEdit[idx] ?? ""}
                              onChange={(e) =>
                                setQtyEdit((prev) => {
                                  if (!prev) return prev;
                                  const next = [...prev];
                                  next[idx] = e.target.value;
                                  return next;
                                })
                              }
                            />
                          )}
                        </td>
                        <td className={`h-12 px-3 text-right ${it.rejectedQty > 0 ? "text-[#9A3A2D]" : "text-[#9CA3AF]"}`}>{it.rejectedQty}</td>
                        <td className="h-12 px-3 text-right text-[#4B5563]">{formatCurrency(it.unitPrice)}</td>
                        <td className="h-12 px-3 text-right font-medium text-[#1F1D1B]">
                          {formatCurrency(
                            (qtyEdit === null || lineLocked
                              ? it.acceptedQty
                              : parseFloat(qtyEdit[idx]) || 0) * it.unitPrice,
                          )}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {/* Save / Cancel bar for the accepted-qty edit */}
            {qtyEdit !== null && (
              <div className="flex items-center justify-end gap-2 pt-3">
                {grn.status === "POSTED" && (
                  <span className="text-xs text-[#9A3A2D] mr-auto">
                    Saving will adjust stock on hand and post a matching cost entry.
                  </span>
                )}
                <Button type="button" variant="outline" size="sm" onClick={() => setQtyEdit(null)} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onClick={saveQtyEdit}
                  disabled={busy}
                  className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
                >
                  Save Quantities
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Shipment Card (PO-linked GRNs only) ────────────────────────────── */}
      {grn.poId && (
        <Card>
          <button
            className="w-full text-left cursor-pointer"
            onClick={() => setShipmentOpen(!shipmentOpen)}
          >
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Ship className="h-4 w-4 text-[#6B5C32]" /> Shipment Details
                </CardTitle>
                <div className="flex items-center gap-3">
                  <Badge variant="status" status={grn.arrival_state}>{ARRIVAL_LABELS[grn.arrival_state]}</Badge>
                  {shipmentOpen ? <ChevronUp className="h-4 w-4 text-[#6B7280]" /> : <ChevronDown className="h-4 w-4 text-[#6B7280]" />}
                </div>
              </div>
            </CardHeader>
          </button>
          {shipmentOpen && (
            <CardContent className="border-t border-[#E2DDD8] pt-4">
              {/* Read view */}
              {!shipmentEdit ? (
                <div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-4">
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold text-[#6B7280] uppercase tracking-wider">Shipping</h4>
                      <div className="space-y-1 text-sm">
                        <div className="flex gap-2"><span className="text-[#6B7280] w-28 shrink-0">Method</span><span className="font-medium">{grn.shipping_method || "—"}</span></div>
                        <div className="flex gap-2"><span className="text-[#6B7280] w-28 shrink-0">Carrier</span><span className="font-medium">{grn.carrier_name || "—"}</span></div>
                        <div className="flex gap-2"><span className="text-[#6B7280] w-28 shrink-0">Tracking #</span><span className="font-mono text-xs bg-[#F0ECE9] px-1.5 py-0.5 rounded">{grn.tracking_number || "—"}</span></div>
                        <div className="flex gap-2"><span className="text-[#6B7280] w-28 shrink-0">Container #</span><span className="font-mono text-xs bg-[#F0ECE9] px-1.5 py-0.5 rounded">{grn.container_number || "—"}</span></div>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold text-[#6B7280] uppercase tracking-wider">Timeline</h4>
                      <div className="space-y-1 text-sm">
                        <div className="flex gap-2"><span className="text-[#6B7280] w-28 shrink-0">Expected Arrival</span><span className="font-medium">{grn.expected_arrival || "—"}</span></div>
                        <div className="flex gap-2"><span className="text-[#6B7280] w-28 shrink-0">Actual Arrival</span><span className="font-medium">{grn.actual_arrival || "—"}</span></div>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <h4 className="text-xs font-semibold text-[#6B7280] uppercase tracking-wider">Customs</h4>
                      <div className="space-y-1 text-sm">
                        <div className="flex gap-2"><span className="text-[#6B7280] w-32 shrink-0">Customs Status</span><span className="font-medium">{grn.customs_status || "N/A"}</span></div>
                        <div className="flex gap-2"><span className="text-[#6B7280] w-32 shrink-0">Clearance Date</span><span className="font-medium">{grn.customs_clearance_date || "—"}</span></div>
                      </div>
                    </div>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => setShipmentEdit({
                    shipping_method: grn.shipping_method || "",
                    carrier_name: grn.carrier_name || "",
                    tracking_number: grn.tracking_number || "",
                    container_number: grn.container_number || "",
                    expected_arrival: grn.expected_arrival || "",
                    actual_arrival: grn.actual_arrival || "",
                    customs_status: grn.customs_status || "",
                    customs_clearance_date: grn.customs_clearance_date || "",
                  })}>
                    Edit Shipment Details
                  </Button>
                </div>
              ) : (
                /* Edit view */
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-[#6B7280] mb-1">Shipping Method</label>
                      <select
                        value={shipmentEdit.shipping_method}
                        onChange={(e) => setShipmentEdit(prev => prev ? { ...prev, shipping_method: e.target.value } : prev)}
                        className="flex h-10 w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                      >
                        <option value="">Select…</option>
                        <option value="SEA">SEA</option>
                        <option value="AIR">AIR</option>
                        <option value="LAND">LAND</option>
                        <option value="COURIER">COURIER</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[#6B7280] mb-1">Carrier Name</label>
                      <Input value={shipmentEdit.carrier_name} onChange={(e) => setShipmentEdit(prev => prev ? { ...prev, carrier_name: e.target.value } : prev)} placeholder="e.g. COSCO, DHL" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[#6B7280] mb-1">Tracking Number</label>
                      <Input value={shipmentEdit.tracking_number} onChange={(e) => setShipmentEdit(prev => prev ? { ...prev, tracking_number: e.target.value } : prev)} placeholder="e.g. MRKU1234567" className="font-mono" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[#6B7280] mb-1">Container Number</label>
                      <Input value={shipmentEdit.container_number} onChange={(e) => setShipmentEdit(prev => prev ? { ...prev, container_number: e.target.value } : prev)} placeholder="e.g. MSCU1234567" className="font-mono" />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[#6B7280] mb-1">Expected Arrival</label>
                      <Input type="date" value={shipmentEdit.expected_arrival} onChange={(e) => setShipmentEdit(prev => prev ? { ...prev, expected_arrival: e.target.value } : prev)} />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[#6B7280] mb-1">Actual Arrival</label>
                      <Input type="date" value={shipmentEdit.actual_arrival} onChange={(e) => setShipmentEdit(prev => prev ? { ...prev, actual_arrival: e.target.value } : prev)} />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[#6B7280] mb-1">Customs Status</label>
                      <select
                        value={shipmentEdit.customs_status}
                        onChange={(e) => setShipmentEdit(prev => prev ? { ...prev, customs_status: e.target.value } : prev)}
                        className="flex h-10 w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                      >
                        <option value="">N/A</option>
                        <option value="PENDING">PENDING</option>
                        <option value="CLEARED">CLEARED</option>
                        <option value="HELD">HELD</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[#6B7280] mb-1">Customs Clearance Date</label>
                      <Input type="date" value={shipmentEdit.customs_clearance_date} onChange={(e) => setShipmentEdit(prev => prev ? { ...prev, customs_clearance_date: e.target.value } : prev)} />
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setShipmentEdit(null)} disabled={busy}>Cancel</Button>
                    <Button type="button" size="sm" onClick={saveShipment} disabled={busy} className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]">
                      Save Shipment Details
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          )}
        </Card>
      )}

      {/* ── Landed Cost ─────────────────────────────────────────────────────── */}
      {grn.poId && (
        <Card>
          <button
            className="w-full text-left cursor-pointer"
            onClick={() => setLandedOpen(!landedOpen)}
          >
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <DollarSign className="h-4 w-4 text-[#6B5C32]" /> Landed Cost
                </CardTitle>
                <div className="flex items-center gap-3">
                  {grn.landed_cost_sen > 0 && (
                    <span className="text-sm font-medium text-green-700">{formatCurrency(grn.landed_cost_sen)}</span>
                  )}
                  {landedOpen ? <ChevronUp className="h-4 w-4 text-[#6B7280]" /> : <ChevronDown className="h-4 w-4 text-[#6B7280]" />}
                </div>
              </div>
            </CardHeader>
          </button>
          {landedOpen && (
            <CardContent className="border-t border-[#E2DDD8] pt-4">
              {!landedEdit ? (
                <div className="space-y-4">
                  {/* Cost waterfall */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between py-2 border-b border-[#E2DDD8]">
                      <span className="text-sm text-[#6B7280]">Product Cost</span>
                      <span className="text-sm font-medium text-[#1F1D1B]">{formatCurrency(grn.totalAmount)}</span>
                    </div>
                    <div className="flex items-center justify-between py-2 border-b border-[#E2DDD8]">
                      <span className="text-sm text-[#6B7280]">+ Shipping Cost</span>
                      <span className="text-sm font-medium text-blue-700">{formatCurrency(grn.shipping_cost_sen)}</span>
                    </div>
                    <div className="flex items-center justify-between py-2 border-b border-[#E2DDD8]">
                      <span className="text-sm text-[#6B7280]">+ Customs Duty</span>
                      <span className="text-sm font-medium text-orange-700">{formatCurrency(grn.customs_duty_sen)}</span>
                    </div>
                    {grn.exchange_rate && (
                      <div className="flex items-center justify-between py-2 border-b border-[#E2DDD8] bg-purple-50/50 px-2 rounded">
                        <span className="text-sm text-purple-700">Exchange Rate ({grn.currency || "?"} to MYR)</span>
                        <span className="text-sm font-bold text-purple-700">{grn.exchange_rate}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between py-3 bg-green-50 px-3 rounded-lg">
                      <span className="text-sm font-semibold text-green-800">
                        Total Landed Cost (MYR)
                        {grn.landed_cost_sen === 0 && <span className="ml-1 text-xs font-normal text-green-700">— enter costs below</span>}
                      </span>
                      <span className="text-lg font-bold text-green-800">
                        {formatCurrency(grn.landed_cost_sen > 0 ? grn.landed_cost_sen : grn.totalAmount + grn.shipping_cost_sen + grn.customs_duty_sen)}
                      </span>
                    </div>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => setLandedEdit({
                    shipping_cost_sen: grn.shipping_cost_sen,
                    customs_duty_sen: grn.customs_duty_sen,
                    exchange_rate: grn.exchange_rate != null ? String(grn.exchange_rate) : "",
                    currency: grn.currency || "",
                  })}>
                    Edit Landed Cost
                  </Button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-[#6B7280] mb-1">Shipping Cost (RM)</label>
                      <MoneyInput
                        value={landedEdit.shipping_cost_sen / 100}
                        onChange={(v) => setLandedEdit(prev => prev ? { ...prev, shipping_cost_sen: Math.round((v ?? 0) * 100) } : prev)}
                        placeholder="0.00"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[#6B7280] mb-1">Customs Duty (RM)</label>
                      <MoneyInput
                        value={landedEdit.customs_duty_sen / 100}
                        onChange={(v) => setLandedEdit(prev => prev ? { ...prev, customs_duty_sen: Math.round((v ?? 0) * 100) } : prev)}
                        placeholder="0.00"
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[#6B7280] mb-1">Currency</label>
                      <select
                        value={landedEdit.currency}
                        onChange={(e) => setLandedEdit(prev => prev ? { ...prev, currency: e.target.value } : prev)}
                        className="flex h-10 w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                      >
                        <option value="">MYR (default)</option>
                        <option value="RMB">RMB</option>
                        <option value="USD">USD</option>
                        <option value="EUR">EUR</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[#6B7280] mb-1">Exchange Rate (to MYR)</label>
                      <Input
                        type="number"
                        step="0.0001"
                        min={0}
                        value={landedEdit.exchange_rate}
                        onChange={(e) => setLandedEdit(prev => prev ? { ...prev, exchange_rate: e.target.value } : prev)}
                        placeholder="e.g. 0.65"
                      />
                    </div>
                  </div>
                  {/* Live waterfall preview */}
                  <div className="bg-[#F0ECE9] rounded-lg p-3 space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-[#6B7280]">Product Cost</span>
                      <span className="font-medium">{formatCurrency(grn.totalAmount)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#6B7280]">+ Shipping</span>
                      <span className="font-medium text-blue-700">{formatCurrency(landedEdit.shipping_cost_sen)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#6B7280]">+ Customs Duty</span>
                      <span className="font-medium text-orange-700">{formatCurrency(landedEdit.customs_duty_sen)}</span>
                    </div>
                    <div className="flex justify-between pt-1 border-t border-[#D1CBC5] font-bold">
                      <span className="text-[#6B5C32]">Landed Cost (MYR)</span>
                      <span className="text-green-700">{formatCurrency(grn.totalAmount + landedEdit.shipping_cost_sen + landedEdit.customs_duty_sen)}</span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => setLandedEdit(null)} disabled={busy}>Cancel</Button>
                    <Button type="button" size="sm" onClick={saveLandedCost} disabled={busy} className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]">
                      Save Landed Cost
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          )}
        </Card>
      )}

      {/* Document lineage: parent PO + any PIs raised from the same PO */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-[#6B7280]">Document Lineage</CardTitle>
        </CardHeader>
        <CardContent>
          <PurchaseLineageBar
            parent={
              grn.poId
                ? { type: "PO", docNo: grn.poNumber || grn.poId, href: `/procurement/${grn.poId}` }
                : null
            }
            links={[
              {
                type: "PI",
                label: relatedPis.length === 1 ? (relatedPis[0].piNo || "Invoice") : "Invoices",
                count: relatedPis.length,
                items: relatedPis.map((p) => ({
                  id: p.id,
                  docNo: p.piNo || p.id,
                  href: `/procurement/pi/${p.id}`,
                  status: p.status ?? null,
                })),
              },
            ]}
          />
        </CardContent>
      </Card>

      <AuditHistoryPanel resource="grn" resourceId={grn.id} />
    </div>
  );
}
