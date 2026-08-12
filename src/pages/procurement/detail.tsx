import { useMemo, useState, useCallback } from "react";
import { AuditHistoryPanel } from "@/components/audit/AuditHistoryPanel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils";
// PDF generators dynamic-imported at click handlers so the 1MB jspdf
// vendor chunk only ships when the user actually downloads.
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { PurchaseLineageBar } from "@/components/ui/purchase-lineage-bar";
import type {
  PurchaseOrder,
  POItem,
  Supplier,
  RawMaterial,
  SupplierMaterialBinding,
} from "@/types";
import {
  ArrowLeft, Download, Printer, ChevronRight, Package, FileText,
  CheckCircle, Send, Lock, Pencil, Save, X, Trash2, AlertTriangle, Mail,
  GitCompare, ChevronDown, ChevronUp, Receipt,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useParams, useNavigate } from "react-router-dom";
import { ObjectPageHeader } from "@/components/ui/object-page-header";

// Status timeline steps
const STATUS_STEPS = [
  { key: "DRAFT", label: "Draft", icon: FileText },
  { key: "SUBMITTED", label: "Sent", icon: Send },
  { key: "CONFIRMED", label: "Confirmed", icon: CheckCircle },
  { key: "PARTIAL_RECEIVED", label: "Partially Received", icon: Package },
  { key: "RECEIVED", label: "Fully Received", icon: CheckCircle },
  { key: "CLOSED", label: "Closed", icon: Lock },
];

function getStepIndex(status: string): number {
  // CANCELLED is special
  if (status === "CANCELLED") return -1;
  const idx = STATUS_STEPS.findIndex((s) => s.key === status);
  return idx >= 0 ? idx : 0;
}

// Edit-mode line item shape — mirrors POFormDialog's POLineItem so the
// inline edit form is identical to creation. We carry through the
// existing item id (when present) so the PUT replace-all picks up the
// same row identity. For new POs materialCode is a real field; for old
// rows we fall back to splitting "CODE - DESCRIPTION" out of materialName.
type EditLine = {
  id?: string;
  rmCode: string;
  rmDescription: string;
  supplierId: string;
  supplierName: string;
  supplierSku: string;
  quantity: number;
  unitPriceSen: number;
  unit: string;
  materialCategory: string;
  receivedQty: number;
};

// Downstream documents, returned by GET /api/purchase-orders/:id alongside the
// PO itself (grns.poId / purchase_invoices.purchaseOrderId reverse lookups).
type LinkedGrn = {
  id: string;
  grnNumber: string;
  status: string;
  receiveDate: string | null;
  totalAmount: number;
};
type LinkedPi = {
  id: string;
  piNo: string;
  status: string;
  invoiceDate: string | null;
  amountSen: number;
};

function poItemToEditLine(it: POItem): EditLine {
  // Prefer the real materialCode field for new POs; split for old rows.
  let rmCode: string;
  let rmDescription: string;
  if (it.materialCode) {
    rmCode = it.materialCode.trim();
    rmDescription = (it.materialName || "").trim();
  } else {
    const name = it.materialName || "";
    const dashIdx = name.indexOf(" - ");
    rmCode = dashIdx > 0 ? name.slice(0, dashIdx).trim() : name.trim();
    rmDescription = dashIdx > 0 ? name.slice(dashIdx + 3).trim() : "";
  }
  return {
    id: it.id,
    rmCode,
    rmDescription,
    supplierId: "",
    supplierName: "",
    supplierSku: it.supplierSKU,
    quantity: it.quantity,
    unitPriceSen: it.unitPriceSen,
    unit: it.unit,
    materialCategory: it.materialCategory,
    receivedQty: it.receivedQty,
  };
}

export default function PurchaseOrderDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { confirm } = useConfirm();
  // GET /api/purchase-orders/:id now returns the downstream documents with the
  // PO itself (linkedGRNs / linkedPIs — two indexed reverse lookups server-side).
  // This page used to download the ENTIRE /api/grn and /api/purchase-invoices
  // lists and filter them client-side just to answer "what came off this PO";
  // both fetches are gone.
  const { data: resp, loading, error: fetchError, refresh: fetchPO } = useCachedJson<{
    success?: boolean;
    data?: PurchaseOrder;
    error?: string;
    linkedGRNs?: LinkedGrn[];
    linkedPIs?: LinkedPi[];
  }>(id ? `/api/purchase-orders/${id}` : null);
  const po: PurchaseOrder | null = useMemo(
    () => (resp?.success ? resp.data ?? null : null),
    [resp]
  );
  const error: string | null = fetchError ?? (resp && resp.success === false ? resp.error || "Purchase order not found" : null);

  // Auxiliary data needed for inline edit. Same endpoints procurement/index
  // already pulls — useCachedJson dedupes if the user navigated from there.
  const { data: supResp } = useCachedJson<{ success?: boolean; data?: Supplier[] }>("/api/suppliers");
  // Purchase Company letterhead registry — lets a PO print under the buying
  // company's own letterhead (HOOKKA / OHANA / any sister co) while accounting
  // stays HOOKKA. Lightweight JSON; no jspdf pulled into the page bundle.
  const { data: orgsResp } = useCachedJson<{ organisations?: Array<{ code?: string; name?: string; regNo?: string; tin?: string; address?: string; phone?: string; email?: string }> }>("/api/organisations");
  const { data: invResp } = useCachedJson<{ success?: boolean; data?: { rawMaterials?: RawMaterial[] } }>("/api/inventory");
  const { data: bindingsResp } = useCachedJson<{ success?: boolean; data?: SupplierMaterialBinding[] } | SupplierMaterialBinding[]>("/api/supplier-materials");

  // Document lineage for this PO: the GRNs received against it + the PIs raised
  // from it (clickable chips → their detail pages). Straight off the detail
  // response — no list download, no client-side filtering.
  const relatedGrns: LinkedGrn[] = useMemo(
    () => resp?.linkedGRNs ?? [],
    [resp],
  );
  const relatedPis: LinkedPi[] = useMemo(
    () => resp?.linkedPIs ?? [],
    [resp],
  );

  const allSuppliers: Supplier[] = useMemo(
    () => (supResp?.success ? supResp.data ?? [] : []),
    [supResp]
  );
  const rawMaterials: RawMaterial[] = useMemo(
    () => (invResp?.success ? invResp.data?.rawMaterials ?? [] : []),
    [invResp]
  );
  const supplierMaterialBindings: SupplierMaterialBinding[] = useMemo(() => {
    const bindings = (bindingsResp as { data?: SupplierMaterialBinding[] } | undefined)?.data ?? bindingsResp;
    return Array.isArray(bindings) ? bindings : [];
  }, [bindingsResp]);
  // Has a posted (or confirmed) GRN attached to this PO? Drives 2.3 —
  // gate the Mark Received button + show a Create GRN CTA when the
  // operator's at CONFIRMED / PARTIAL_RECEIVED with no GRN yet. Reads the
  // server-side reverse lookup, which is already scoped to this PO.
  const hasPostedGrn = useMemo(
    () =>
      relatedGrns.some((g) => g.status === "POSTED" || g.status === "CONFIRMED"),
    [relatedGrns],
  );

  // ------- Edit mode state -------
  const [editing, setEditing] = useState(false);
  const [editExpectedDate, setEditExpectedDate] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editLines, setEditLines] = useState<EditLine[]>([]);
  const [rmSearch, setRmSearch] = useState("");
  const [saving, setSaving] = useState(false);

  // ------- Cancel-PO modal state (2.2) -------
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);

  // ------- Delete-PO state (DRAFT-only physical delete) -------
  const [deleting, setDeleting] = useState(false);

  // ------- Email-PO state (3.1) -------
  const [emailing, setEmailing] = useState(false);

  // GRN creation from a PO now routes to the full-page /procurement/grn/create
  // (with ?poId= pre-selecting this PO), so the inline modal that used to live
  // here was removed — every GRN-create entry point is the same full page now.

  const resolveSupplierName = useCallback(
    (sid: string): string => {
      const sup = allSuppliers.find((s) => s.id === sid);
      return sup ? `${sup.code} - ${sup.name}` : sid;
    },
    [allSuppliers],
  );

  // ACTIVE supplier id set + roster — drives every dropdown and binding
  // pick on this edit screen. Mirror procurement/index.tsx so a deactivated
  // vendor never silently sneaks back onto a PO via the edit path.
  const activeSupplierIds = useMemo(
    () => new Set(allSuppliers.filter((s) => s.status === "ACTIVE").map((s) => s.id)),
    [allSuppliers],
  );
  const activeSuppliers = useMemo(
    () => allSuppliers.filter((s) => s.status === "ACTIVE"),
    [allSuppliers],
  );

  // Snapshot the current PO into edit-mode state. Called from the Edit
  // button click handler (not via useEffect) — react-hooks/set-state-in-effect
  // explicitly forbids synchronous setState chains inside an effect, and
  // the snapshot only ever needs to happen once per Edit click anyway.
  const snapshotForEdit = useCallback((source: PurchaseOrder) => {
    setEditExpectedDate(source.expectedDate ?? "");
    setEditNotes(source.notes ?? "");
    setEditLines(
      source.items.map((it) => {
        const base = poItemToEditLine(it);
        const sid = source.supplierId ?? "";
        return {
          ...base,
          supplierId: sid,
          supplierName: sid ? resolveSupplierName(sid) : "",
        };
      }),
    );
  }, [resolveSupplierName]);

  const handleAdvanceStatus = async (newStatus: string) => {
    if (!po) return;
    // 2.3 — Mirror the backend gate so the click never reaches a 412.
    // We still hit the server; a stale GRN cache here would be caught
    // by the backend's hard check.
    if (newStatus === "RECEIVED" && !hasPostedGrn) {
      toast.error("Create + post a GRN before marking received");
      return;
    }
    try {
      const body: Record<string, unknown> = { status: newStatus };
      if (newStatus === "RECEIVED") {
        body.receivedDate = new Date().toISOString().split("T")[0];
      }
      const res = await fetch(`/api/purchase-orders/${po.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({})) as {
        success?: boolean;
        error?: string;
        requiresGrn?: boolean;
      };
      if (!res.ok || !data.success) {
        if (res.status === 412 && data.requiresGrn) {
          toast.error(data.error || "Create + post a GRN before marking received");
        } else {
          toast.error(data.error || `Failed to advance status (HTTP ${res.status})`);
        }
        return;
      }
      invalidateCachePrefix("/api/purchase-orders");
      invalidateCachePrefix("/api/grn");
      fetchPO();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error advancing status");
    }
  };

  // ---- Edit-mode helpers ----
  const filteredRMs = useMemo(() => {
    const active = rawMaterials.filter((rm) => rm.isActive);
    if (!rmSearch.trim()) return active;
    const q = rmSearch.toLowerCase();
    return active.filter(
      (rm) =>
        rm.itemCode.toLowerCase().includes(q) ||
        rm.description.toLowerCase().includes(q),
    );
  }, [rawMaterials, rmSearch]);

  const addLineFromRM = (rmCode: string) => {
    const rm = rawMaterials.find((r) => r.itemCode === rmCode);
    if (!rm) return;
    // Filter bindings to ACTIVE suppliers — if the only binding is on a
    // deactivated vendor we leave supplierId blank so the operator picks
    // a live one rather than silently auto-filling a dead vendor.
    const bindings = supplierMaterialBindings.filter(
      (b) => b.materialCode === rmCode && activeSupplierIds.has(b.supplierId),
    );
    const main = bindings.find((b) => b.isMainSupplier) ?? bindings[0];
    const sid = main?.supplierId ?? "";
    setEditLines((prev) => [
      ...prev,
      {
        rmCode: rm.itemCode,
        rmDescription: rm.description,
        supplierId: sid,
        supplierName: sid ? resolveSupplierName(sid) : "",
        supplierSku: main?.supplierSku ?? "",
        quantity: main?.moq ?? 1,
        unitPriceSen: main?.unitPrice ?? 0,
        unit: rm.baseUOM,
        materialCategory: rm.itemGroup,
        receivedQty: 0,
      },
    ]);
    setRmSearch("");
  };

  const removeLine = (idx: number) => {
    setEditLines((prev) => prev.filter((_, i) => i !== idx));
  };

  const updateLine = (idx: number, patch: Partial<EditLine>) => {
    setEditLines((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  };

  const switchLineSupplier = (idx: number, sid: string) => {
    if (!sid) return;
    const line = editLines[idx];
    const binding = supplierMaterialBindings.find(
      (b) => b.materialCode === line.rmCode && b.supplierId === sid,
    );
    updateLine(idx, {
      supplierId: sid,
      supplierName: resolveSupplierName(sid),
      supplierSku: binding?.supplierSku ?? line.supplierSku,
      unitPriceSen: binding?.unitPrice ?? line.unitPriceSen,
    });
  };

  // Header supplier is derived from line items (single-supplier invariant
  // matches the create flow). Mixed-supplier blocks save.
  const headerSupplierId = editLines.length > 0 ? editLines[0].supplierId : "";
  const editHasMixed =
    editLines.length > 1 && editLines.some((l) => l.supplierId !== editLines[0].supplierId);
  const editHasUnbound = editLines.some((l) => !l.supplierId);
  const editSubtotalSen = editLines.reduce((s, l) => s + l.quantity * l.unitPriceSen, 0);

  const startEdit = () => {
    if (po) snapshotForEdit(po);
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setRmSearch("");
  };

  const saveEdits = async () => {
    if (!po) return;
    if (editLines.length === 0) {
      toast.error("PO must have at least one line item");
      return;
    }
    if (editHasUnbound) {
      toast.error("Pick a supplier for every line");
      return;
    }
    if (editHasMixed) {
      toast.error("Lines must share a single supplier");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        supplierId: headerSupplierId,
        supplierName: editLines[0].supplierName || resolveSupplierName(headerSupplierId),
        expectedDate: editExpectedDate,
        notes: editNotes,
        items: editLines.map((l) => ({
          id: l.id,
          materialCategory: l.materialCategory,
          materialCode: l.rmCode,
          materialName: l.rmDescription,
          supplierSKU: l.supplierSku,
          quantity: l.quantity,
          unitPriceSen: l.unitPriceSen,
          unit: l.unit,
          receivedQty: l.receivedQty,
        })),
      };
      const res = await fetch(`/api/purchase-orders/${po.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!res.ok || !body.success) {
        toast.error(body.error || `Failed to save (HTTP ${res.status})`);
        return;
      }
      invalidateCachePrefix("/api/purchase-orders");
      invalidateCachePrefix("/api/grn");
      fetchPO();
      toast.success("Purchase order updated");
      setEditing(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error saving PO");
    } finally {
      setSaving(false);
    }
  };

  // 2.2 — Cancel PO with reason. Append "[CANCELLED YYYY-MM-DD: <reason>]"
  // to existing notes so the cancellation reason is preserved alongside
  // any free-form notes the operator already wrote. Backend's
  // VALID_TRANSITIONS already allows CANCELLED from SUBMITTED / CONFIRMED /
  // PARTIAL_RECEIVED (purchase-orders.ts:57) — no schema change needed.
  const submitCancel = async () => {
    if (!po) return;
    const reason = cancelReason.trim();
    if (reason.length < 10) {
      toast.error("Reason must be at least 10 characters");
      return;
    }
    setCancelling(true);
    try {
      const today = new Date().toISOString().split("T")[0];
      const annotation = `[CANCELLED ${today}: ${reason}]`;
      const newNotes = po.notes ? `${po.notes}\n${annotation}` : annotation;
      const res = await fetch(`/api/purchase-orders/${po.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "CANCELLED", notes: newNotes }),
      });
      const body = await res.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!res.ok || !body.success) {
        toast.error(body.error || `Failed to cancel (HTTP ${res.status})`);
        return;
      }
      invalidateCachePrefix("/api/purchase-orders");
      invalidateCachePrefix("/api/grn");
      fetchPO();
      toast.success("Purchase order cancelled");
      setShowCancelModal(false);
      setCancelReason("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error cancelling PO");
    } finally {
      setCancelling(false);
    }
  };

  // Delete PO — physical row removal. DRAFT-only on the FE; the backend
  // DELETE /api/purchase-orders/:id endpoint cascades to PO items via FK.
  // Cancel PO (above) keeps the row but flips status; Delete is for DRAFTs
  // the operator never sent and just wants gone.
  const handleDelete = async () => {
    if (!po) return;
    const ok = await confirm({
      title: "Delete purchase order?",
      message: `Permanently delete PO ${po.poNo}? This cannot be undone.`,
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/purchase-orders/${po.id}`, {
        method: "DELETE",
      });
      const body = await res.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!res.ok || !body.success) {
        toast.error(body.error || `Failed to delete (HTTP ${res.status})`);
        return;
      }
      invalidateCachePrefix("/api/purchase-orders");
      invalidateCachePrefix("/api/grn");
      toast.success(`PO ${po.poNo} deleted`);
      navigate("/procurement");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error deleting PO");
    } finally {
      setDeleting(false);
    }
  };

  // 3.1 — Manual "Email to Supplier" send. Hits the new
  // POST /api/purchase-orders/:id/email endpoint, which enqueues to
  // outbox_emails and stamps lastEmailedAt. The cron drain
  // (.github/workflows/process-email-outbox.yml) is what actually contacts
  // Resend, so a Resend outage doesn't delay the toast.
  const sendEmail = async () => {
    if (!po) return;
    setEmailing(true);
    try {
      const res = await fetch(`/api/purchase-orders/${po.id}/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const body = await res.json().catch(() => ({})) as { success?: boolean; error?: string };
      if (!res.ok || !body.success) {
        toast.error(body.error || `Failed to email (HTTP ${res.status})`);
        return;
      }
      invalidateCachePrefix("/api/purchase-orders");
      fetchPO();
      toast.success("Queued for delivery");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error sending email");
    } finally {
      setEmailing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[#6B5C32]" />
      </div>
    );
  }

  if (error || !po) {
    return (
      <div className="space-y-6">
        <Link to="/procurement" className="inline-flex items-center gap-2 text-sm text-[#6B5C32] hover:underline">
          <ArrowLeft className="h-4 w-4" /> Back to Procurement
        </Link>
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-[#9CA3AF]">{error || "Purchase order not found."}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const currentStepIdx = getStepIndex(po.status);
  const isCancelled = po.status === "CANCELLED";
  const isDraft = po.status === "DRAFT";
  // 3.1 — Email button visible once the PO has left DRAFT. RECEIVED + CLOSED
  // included so the operator can resend "FYI for your records" copies after
  // partial-receive disputes. Excluded on CANCELLED for obvious reasons.
  const canEmail = ["SUBMITTED", "CONFIRMED", "PARTIAL_RECEIVED", "RECEIVED"].includes(
    po.status,
  );
  // 2.2 — Cancel-with-reason gate: SUBMITTED / CONFIRMED / PARTIAL_RECEIVED.
  // DRAFT keeps its existing one-click Cancel (no reason needed for a PO
  // that never left the office). RECEIVED / CLOSED / CANCELLED are terminal.
  const canCancelWithReason = ["SUBMITTED", "CONFIRMED", "PARTIAL_RECEIVED"].includes(po.status);

  // Determine available status advancement actions. 2.3 — Mark Received
  // only renders when a POSTED GRN exists for this PO; otherwise the
  // operator sees a "Create GRN" CTA (rendered separately below) that
  // routes them to the GRN flow scoped to this PO.
  const statusActions: { label: string; status: string; variant: "primary" | "outline" }[] = [];
  // DRAFT no longer has a "Send to Supplier" advance action — operator goes
  // straight to other workflow without the SUBMITTED intermediate. DRAFT POs
  // get a Delete button (physical row removal) below instead.
  if (po.status === "SUBMITTED") {
    statusActions.push({ label: "Mark Confirmed", status: "CONFIRMED", variant: "primary" });
  } else if (po.status === "CONFIRMED") {
    statusActions.push({ label: "Mark Partially Received", status: "PARTIAL_RECEIVED", variant: "outline" });
    if (hasPostedGrn) {
      statusActions.push({ label: "Mark Fully Received", status: "RECEIVED", variant: "primary" });
    }
  } else if (po.status === "PARTIAL_RECEIVED") {
    if (hasPostedGrn) {
      statusActions.push({ label: "Mark Fully Received", status: "RECEIVED", variant: "primary" });
    }
  } else if (po.status === "RECEIVED") {
    statusActions.push({ label: "Close PO", status: "CLOSED", variant: "outline" });
  }
  // CTA to start a GRN scoped to this PO. 3.2 — opens the GRN form dialog
  // inline (no navigation, current PO pre-selected) instead of routing to
  // the standalone /procurement/grn page + the operator picking the PO.
  const showCreateGrnCta =
    !hasPostedGrn && ["CONFIRMED", "PARTIAL_RECEIVED"].includes(po.status);
  // 3.2 — Receive Goods button: visible on CONFIRMED / PARTIAL_RECEIVED so
  // partial receiving works inline without a navigate. Composes with the
  // backend gate from 2.3 — Mark Received only enables once a POSTED GRN
  // exists, but you can post N partial GRNs before then via this dialog.
  const canReceiveInline =
    ["CONFIRMED", "PARTIAL_RECEIVED"].includes(po.status);

  const totalOrdered = po.items.reduce((s, i) => s + i.quantity, 0);
  const totalReceived = po.items.reduce((s, i) => s + i.receivedQty, 0);
  const receivePct = totalOrdered > 0 ? Math.round((totalReceived / totalOrdered) * 100) : 0;
  const canPrintGRN = ["PARTIAL_RECEIVED", "RECEIVED"].includes(po.status);

  // Editable until goods land. Owner ruling 2026-08-07: a CONFIRMED (or
  // SUBMITTED) PO that has received nothing yet is still editable — the PUT
  // route already permits supplier/line edits until a POSTED/CONFIRMED GRN
  // exists (purchase-orders.ts), so this gate just mirrors that server lock
  // instead of the old DRAFT-only rule. Once anything is received (posted GRN
  // or receivedQty > 0) or the PO is terminal, it locks.
  const isEditable =
    !isCancelled &&
    po.status !== "RECEIVED" &&
    po.status !== "CLOSED" &&
    !hasPostedGrn &&
    totalReceived === 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <ObjectPageHeader
        backTo="/procurement"
        title={po.poNo}
        subtitle={`Supplier: ${po.supplierName}`}
        badges={<Badge variant="status" status={po.status} />}
        actions={
          <>
            {isEditable && !editing && (
              <Button variant="outline" onClick={startEdit}>
                <Pencil className="h-4 w-4" /> Edit
              </Button>
            )}
            {canEmail && !editing && (
              <div className="flex items-center gap-2">
                {po.lastEmailedAt && (
                  <span className="text-xs text-[#6B7280]" title={po.lastEmailedAt}>
                    Last sent: {formatDateTime(po.lastEmailedAt)}
                  </span>
                )}
                <Button
                  variant="outline"
                  onClick={sendEmail}
                  disabled={emailing}
                  title={po.lastEmailedAt ? "Resend PO to supplier" : "Email PO to supplier"}
                >
                  <Mail className="h-4 w-4" /> {po.lastEmailedAt ? (emailing ? "Resending…" : "Resend Email") : (emailing ? "Sending…" : "Email to Supplier")}
                </Button>
              </div>
            )}
            <Button variant="outline" onClick={async () => {
              const { generatePurchaseOrderPdf, letterheadForPurchaseOrg } = await import("@/lib/generate-purchase-order-pdf");
              // Print under the supplier's Purchase Company letterhead (HOOKKA /
              // OHANA / any sister co in the organisations registry). Accounting
              // stays HOOKKA. Defaults to HOOKKA when no Purchase Company is set.
              const sup = allSuppliers.find((s) => s.id === po.supplierId);
              const purchaseOrgCode = sup?.purchaseOrgCode || "HOOKKA";
              const lh = letterheadForPurchaseOrg(purchaseOrgCode, orgsResp?.organisations);
              generatePurchaseOrderPdf({ ...po, purchaseOrgCode }, lh);
            }}>
              <Download className="h-4 w-4" /> Download PDF
            </Button>
            {canPrintGRN && (
              <Button variant="outline" onClick={async () => {
                const [{ generateGRNPdf }, { letterheadForPurchaseOrg }] = await Promise.all([
                  import("@/lib/generate-grn-pdf"),
                  import("@/lib/generate-purchase-order-pdf"),
                ]);
                // GRN prints under the supplier's Purchase Company; accounting stays HOOKKA.
                const sup = allSuppliers.find((s) => s.id === po.supplierId);
                const lh = letterheadForPurchaseOrg(sup?.purchaseOrgCode || "HOOKKA", orgsResp?.organisations);
                generateGRNPdf(po, lh);
              }}>
                <Printer className="h-4 w-4" /> Print GRN
              </Button>
            )}
            {!isDraft && !isCancelled && !editing && (() => {
              // One live (non-cancelled) PI per PO — the convert copies every line
              // at full qty, so a second one is a full-value duplicate. Disable
              // when an invoice already exists; the backend also 409s this.
              const hasLivePi = relatedPis.some((p) => p.status !== "CANCELLED");
              return (
                <Button
                  variant="outline"
                  onClick={() => navigate(`/procurement/pi/create?poId=${po.id}`)}
                  disabled={hasLivePi}
                  title={hasLivePi ? "This PO already has an invoice. Cancel it first to re-invoice." : undefined}
                >
                  <Receipt className="h-4 w-4" /> {hasLivePi ? "Invoiced" : "Create Invoice"}
                </Button>
              );
            })()}
          </>
        }
      />

      {/* Status Timeline */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-[#6B7280]">Status Timeline</CardTitle>
        </CardHeader>
        <CardContent>
          {isCancelled ? (
            <div className="flex items-center gap-2 text-red-600">
              <Lock className="h-5 w-5" />
              <span className="font-semibold">This Purchase Order has been cancelled.</span>
            </div>
          ) : (
            <div className="flex items-center gap-0 overflow-x-auto pb-2">
              {STATUS_STEPS.map((step, idx) => {
                const StepIcon = step.icon;
                const isActive = idx === currentStepIdx;
                const isCompleted = idx < currentStepIdx;
                return (
                  <div key={step.key} className="flex items-center">
                    <div className="flex flex-col items-center min-w-[80px]">
                      <div
                        className={`flex items-center justify-center w-9 h-9 rounded-full border-2 transition-colors ${
                          isActive
                            ? "border-[#6B5C32] bg-[#6B5C32] text-white"
                            : isCompleted
                              ? "border-green-500 bg-green-50 text-green-600"
                              : "border-[#E2DDD8] bg-white text-[#D1D5DB]"
                        }`}
                      >
                        {isCompleted ? (
                          <CheckCircle className="h-4 w-4" />
                        ) : (
                          <StepIcon className="h-4 w-4" />
                        )}
                      </div>
                      <span
                        className={`text-xs mt-1.5 font-medium text-center ${
                          isActive ? "text-[#6B5C32]" : isCompleted ? "text-green-600" : "text-[#D1D5DB]"
                        }`}
                      >
                        {step.label}
                      </span>
                    </div>
                    {idx < STATUS_STEPS.length - 1 && (
                      <div
                        className={`w-8 h-0.5 mt-[-16px] ${
                          idx < currentStepIdx ? "bg-green-400" : "bg-[#E2DDD8]"
                        }`}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit-mode form (editable until goods land — see isEditable). Replaces
          the read-only details/items cards while editing — the operator sees
          the same shape they get from the Create modal so there's no UI drift. */}
      {editing && isEditable && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Pencil className="h-4 w-4 text-[#6B5C32]" /> Edit Purchase Order
              </CardTitle>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" onClick={cancelEdit} disabled={saving}>
                  <X className="h-4 w-4" /> Cancel
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  onClick={saveEdits}
                  disabled={saving || editLines.length === 0 || editHasUnbound || editHasMixed}
                  title={
                    editHasUnbound
                      ? "Pick a supplier for every line"
                      : editHasMixed
                        ? "Lines must share a single supplier"
                        : editLines.length === 0
                          ? "Add at least one line"
                          : undefined
                  }
                >
                  <Save className="h-4 w-4" /> {saving ? "Saving…" : "Save Changes"}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Supplier is picked per line item below — no top-level
                supplier display (operator found it redundant and misleading
                mid-edit). Save still blocks on mixed suppliers via the
                button's disabled state. */}
            <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
              <div>
                <label className="block text-xs text-[#6B7280] mb-1">Delivery Date</label>
                <Input
                  type="date"
                  value={editExpectedDate}
                  onChange={(e) => setEditExpectedDate(e.target.value)}
                />
              </div>
              <div className="col-span-2 max-md:col-span-1">
                <label className="block text-xs text-[#6B7280] mb-1">Notes</label>
                <Input
                  value={editNotes}
                  onChange={(e) => setEditNotes(e.target.value)}
                  placeholder="Order notes…"
                />
              </div>
            </div>

            {/* Add line by RM code */}
            <div className="relative">
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
                      onClick={() => addLineFromRM(rm.itemCode)}
                    >
                      <span className="font-medium text-[#1F1D1B]">{rm.itemCode}</span>
                      <span className="text-[#6B7280] ml-2">{rm.description}</span>
                      <span className="text-[#9CA3AF] ml-2">({rm.baseUOM})</span>
                    </button>
                  ))}
                  {filteredRMs.length > 20 && (
                    <div className="px-3 py-2 text-xs text-[#9CA3AF]">
                      Showing 20 of {filteredRMs.length}. Refine search.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Line items */}
            {editLines.length > 0 && (
              <div className="space-y-2">
                {editLines.map((line, idx) => {
                  // Active-only bindings — same gate as addLineFromRM so the
                  // dropdown can never offer a deactivated vendor.
                  const bindings = supplierMaterialBindings.filter(
                    (b) => b.materialCode === line.rmCode && activeSupplierIds.has(b.supplierId),
                  );
                  return (
                    <div key={idx} className="p-3 bg-[#FAF9F7] rounded border border-[#E2DDD8] overflow-x-auto">
                      <div className="grid grid-cols-8 gap-2 items-end" style={{ minWidth: "560px" }}>
                        <div className="col-span-2">
                          <label className="block text-xs text-[#6B7280] mb-1">RM Code</label>
                          <div className="h-8 flex items-center px-2 text-xs font-medium text-[#1F1D1B] bg-white rounded border border-[#E2DDD8]">
                            {line.rmCode}
                          </div>
                        </div>
                        <div className="col-span-2">
                          <label className="block text-xs text-[#6B7280] mb-1">Description</label>
                          <div className="h-8 flex items-center px-2 text-xs text-[#374151] bg-white rounded border border-[#E2DDD8] truncate" title={line.rmDescription}>
                            {line.rmDescription || "-"}
                          </div>
                        </div>
                        <div className="col-span-2">
                          <label className="block text-xs text-[#6B7280] mb-1">
                            Supplier{!line.supplierId && <span className="ml-1 text-[#9A3A2D]">*</span>}
                          </label>
                          {bindings.length > 0 ? (
                            <select
                              className="flex h-8 w-full rounded border border-[#E2DDD8] bg-white px-2 text-xs"
                              value={line.supplierId}
                              onChange={(e) => switchLineSupplier(idx, e.target.value)}
                            >
                              <option value="">Pick supplier…</option>
                              {bindings.map((b) => (
                                <option key={b.id} value={b.supplierId}>
                                  {resolveSupplierName(b.supplierId)}{b.isMainSupplier ? " (main)" : ""}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <select
                              className={`flex h-8 w-full rounded border bg-white px-2 text-xs ${
                                line.supplierId ? "border-[#E2DDD8]" : "border-[#9A3A2D]"
                              }`}
                              value={line.supplierId}
                              onChange={(e) =>
                                updateLine(idx, {
                                  supplierId: e.target.value,
                                  supplierName: e.target.value ? resolveSupplierName(e.target.value) : "",
                                })
                              }
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
                          <label className="block text-xs text-[#6B7280] mb-1">SKU</label>
                          <Input
                            className="h-8 text-xs"
                            value={line.supplierSku}
                            onChange={(e) => updateLine(idx, { supplierSku: e.target.value })}
                          />
                        </div>
                        <div className="flex justify-end">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-8 text-[#9A3A2D] hover:text-[#7A2E24]"
                            onClick={() => removeLine(idx)}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                      <div className="grid grid-cols-8 gap-2 items-end mt-2" style={{ minWidth: "560px" }}>
                        <div>
                          <label className="block text-xs text-[#6B7280] mb-1">Qty</label>
                          <Input
                            className="h-8 text-xs"
                            type="number"
                            min={0}
                            onFocus={(e) => e.currentTarget.select()}
                            value={line.quantity}
                            onChange={(e) => updateLine(idx, { quantity: Number(e.target.value) })}
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-[#6B7280] mb-1">Price (RM)</label>
                          {/* Operator types RM (e.g. "25.50"); we convert to sen on every
                              keystroke (× 100, rounded). Storage + API stay in sen. */}
                          <Input
                            className="h-8 text-xs"
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            min={0}
                            onFocus={(e) => e.currentTarget.select()}
                            value={line.unitPriceSen === 0 ? "" : (line.unitPriceSen / 100).toFixed(2)}
                            onChange={(e) => {
                              const rm = parseFloat(e.target.value);
                              const sen = Number.isFinite(rm) && rm >= 0 ? Math.round(rm * 100) : 0;
                              updateLine(idx, { unitPriceSen: sen });
                            }}
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-[#6B7280] mb-1">Unit</label>
                          <div className="h-8 flex items-center px-2 text-xs text-[#374151] bg-white rounded border border-[#E2DDD8]">
                            {line.unit}
                          </div>
                        </div>
                        <div className="col-span-5 flex items-end justify-end">
                          <span className="text-xs font-medium text-[#1F1D1B]">
                            Line total: {formatCurrency(line.quantity * line.unitPriceSen)}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
                <div className="text-right text-sm font-semibold text-[#1F1D1B] pr-2">
                  Total: {formatCurrency(editSubtotalSen)}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* PO Details + Items (read-only — hidden while editing) */}
      {!editing && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left: Details */}
          <Card className="lg:col-span-1">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <FileText className="h-4 w-4 text-[#6B5C32]" /> Order Details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-y-3 text-sm">
                <span className="text-[#6B7280]">PO Number</span>
                <span className="font-medium text-[#1F1D1B]">{po.poNo}</span>

                <span className="text-[#6B7280]">Supplier</span>
                <span className="font-medium text-[#1F1D1B]">{po.supplierName}</span>

                <span className="text-[#6B7280]">Order Date</span>
                <span className="text-[#4B5563]">{formatDate(po.orderDate)}</span>

                <span className="text-[#6B7280]">Delivery Date</span>
                <span className="text-[#4B5563]">{po.expectedDate ? formatDate(po.expectedDate) : "-"}</span>

                <span className="text-[#6B7280]">Received Date</span>
                <span className="text-[#4B5563]">{po.receivedDate ? formatDate(po.receivedDate) : "-"}</span>

                <span className="text-[#6B7280]">Status</span>
                <span><Badge variant="status" status={po.status} /></span>

                <span className="text-[#6B7280]">Received</span>
                <div className="flex items-center gap-2">
                  <div className="w-16 h-2 bg-[#E2DDD8] rounded-full overflow-hidden">
                    <div className="h-full bg-[#6B5C32] rounded-full" style={{ width: `${receivePct}%` }} />
                  </div>
                  <span className="text-xs text-[#6B7280]">{receivePct}%</span>
                </div>
              </div>

              {po.notes && (
                <div className="pt-3 border-t border-[#E2DDD8]">
                  <p className="text-xs font-medium text-[#6B7280] mb-1">Notes</p>
                  <p className="text-sm text-[#4B5563] whitespace-pre-line">{po.notes}</p>
                </div>
              )}

              {/* Amount summary */}
              <div className="pt-3 border-t border-[#E2DDD8] space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-[#6B7280]">Subtotal</span>
                  <span className="text-[#1F1D1B]">{formatCurrency(po.subtotalSen)}</span>
                </div>
                <div className="flex justify-between text-sm font-bold">
                  <span className="text-[#6B5C32]">Total</span>
                  <span className="text-[#6B5C32]">{formatCurrency(po.totalSen)}</span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Right: Items Table */}
          <Card className="lg:col-span-2">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Package className="h-4 w-4 text-[#6B5C32]" /> Items ({po.items.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border border-[#E2DDD8] overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                      <th className="h-10 px-4 text-left font-medium text-[#374151]">#</th>
                      <th className="h-10 px-3 text-left font-medium text-[#374151]">Internal Code</th>
                      <th className="h-10 px-3 text-left font-medium text-[#374151]">Supplier SKU</th>
                      <th className="h-10 px-4 text-left font-medium text-[#374151]">Description</th>
                      <th className="h-10 px-4 text-center font-medium text-[#374151]">Unit</th>
                      <th className="h-10 px-4 text-right font-medium text-[#374151]">Qty</th>
                      <th className="h-10 px-4 text-right font-medium text-[#374151]">Received</th>
                      <th className="h-10 px-4 text-right font-medium text-[#374151]">Unit Price</th>
                      <th className="h-10 px-4 text-right font-medium text-[#374151]">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {po.items.map((item, idx) => {
                      const isComplete = item.receivedQty >= item.quantity;
                      const hasPartial = item.receivedQty > 0 && item.receivedQty < item.quantity;
                      // Prefer the real materialCode field (new POs). For old
                      // rows where materialCode is absent and materialName is
                      // still "CODE - DESCRIPTION", fall back to splitting.
                      const hasMaterialCode = !!item.materialCode;
                      const internalCode = hasMaterialCode
                        ? item.materialCode!.trim()
                        : (() => {
                            const dashIdx = (item.materialName ?? "").indexOf(" - ");
                            return dashIdx > 0
                              ? item.materialName.slice(0, dashIdx).trim()
                              : (item.materialName ?? "").trim();
                          })();
                      const description = hasMaterialCode
                        ? (item.materialName ?? "").trim()
                        : (() => {
                            const dashIdx = (item.materialName ?? "").indexOf(" - ");
                            return dashIdx > 0
                              ? item.materialName.slice(dashIdx + 3).trim()
                              : "";
                          })();
                      const supplierSku = (item.supplierSKU ?? "").trim();
                      return (
                        <tr key={item.id} className={`border-b border-[#E2DDD8] ${idx % 2 === 1 ? "bg-[#FAF9F7]" : ""}`}>
                          <td className="h-12 px-4 text-[#6B7280]">{idx + 1}</td>
                          <td
                            className="h-12 px-3 font-mono text-xs font-medium text-[#6B5C32] whitespace-nowrap"
                            title={internalCode || undefined}
                          >
                            {internalCode || <span className="text-[#9CA3AF]">—</span>}
                          </td>
                          <td
                            className="h-12 px-3 font-mono text-xs text-[#6B7280] whitespace-nowrap"
                            title={supplierSku || undefined}
                          >
                            {supplierSku || <span className="text-[#9CA3AF]">—</span>}
                          </td>
                          <td className="h-12 px-4 text-[#1F1D1B]">{description || <span className="text-[#9CA3AF]">—</span>}</td>
                          <td className="h-12 px-4 text-center text-[#6B7280]">{item.unit}</td>
                          <td className="h-12 px-4 text-right text-[#4B5563]">{item.quantity}</td>
                          <td className={`h-12 px-4 text-right font-medium ${isComplete ? "text-green-600" : hasPartial ? "text-amber-600" : "text-[#6B7280]"}`}>
                            {item.receivedQty}
                          </td>
                          <td className="h-12 px-4 text-right text-[#4B5563]">{formatCurrency(item.unitPriceSen)}</td>
                          <td className="h-12 px-4 text-right font-medium text-[#1F1D1B]">{formatCurrency(item.totalSen)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-[#F0ECE9]">
                      <td colSpan={5} className="h-10 px-4 font-semibold text-[#374151]">Total</td>
                      <td className="h-10 px-4 text-right font-semibold text-[#374151]">{totalOrdered}</td>
                      <td className="h-10 px-4 text-right font-semibold text-[#374151]">{totalReceived}</td>
                      <td className="h-10 px-4"></td>
                      <td className="h-10 px-4 text-right font-bold text-[#6B5C32]">{formatCurrency(po.totalSen)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Action Buttons. DRAFT POs only get Delete (physical row removal,
          no SUBMITTED intermediate state — operator's flow skips it).
          Non-DRAFT POs get the relevant status-advance buttons + Cancel PO
          (status=CANCELLED, row preserved). */}
      {!isCancelled && !editing && (statusActions.length > 0 || canCancelWithReason || showCreateGrnCta || canReceiveInline || isDraft) && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <p className="text-xs text-[#6B7280]">
                {isDraft ? "Available actions:" : "Advance this Purchase Order to the next status:"}
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                {showCreateGrnCta && (
                  <Button
                    variant="primary"
                    onClick={() => navigate(`/procurement/grn/create?poId=${po.id}`)}
                  >
                    <Package className="h-4 w-4" /> Create GRN
                  </Button>
                )}
                {!showCreateGrnCta && canReceiveInline && (
                  <Button
                    variant="outline"
                    onClick={() => navigate(`/procurement/grn/create?poId=${po.id}`)}
                  >
                    <Package className="h-4 w-4" /> Receive Goods
                  </Button>
                )}
                {statusActions.map((action) => (
                  <Button
                    key={action.status}
                    variant={action.variant}
                    onClick={() => handleAdvanceStatus(action.status)}
                  >
                    <ChevronRight className="h-4 w-4" /> {action.label}
                  </Button>
                ))}
                {isDraft && (
                  <Button
                    variant="outline"
                    className="text-red-700 border-red-300 hover:bg-red-50"
                    onClick={handleDelete}
                    disabled={deleting}
                  >
                    <Trash2 className="h-4 w-4" /> {deleting ? "Deleting…" : "Delete PO"}
                  </Button>
                )}
                {canCancelWithReason && (
                  <Button
                    variant="outline"
                    className="text-red-600 border-red-200 hover:bg-red-50"
                    onClick={() => setShowCancelModal(true)}
                  >
                    Cancel PO
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Cancel-with-reason modal (2.2). Min 10 chars on the reason
          textarea so we don't end up with single-character "x" justifications.
          PARTIAL_RECEIVED gets a callout that posted GRNs stay committed. */}
      {showCancelModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between p-5 border-b border-[#E2DDD8]">
              <div>
                <h2 className="text-lg font-semibold text-[#1F1D1B]">Cancel Purchase Order</h2>
                <p className="text-xs text-[#6B7280] mt-0.5">{po.poNo}</p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setShowCancelModal(false)}
                disabled={cancelling}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="p-5 space-y-3">
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1">
                  Reason for cancellation <span className="text-[#9A3A2D]">*</span>
                </label>
                <textarea
                  className="w-full min-h-[90px] rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  placeholder="Minimum 10 characters — what's the reason?"
                />
                <p className="text-xs text-[#6B7280] mt-1">
                  {cancelReason.trim().length}/10 minimum
                </p>
              </div>
              {po.status === "PARTIAL_RECEIVED" && (
                <div className="flex items-start gap-2 p-3 rounded border border-amber-200 bg-amber-50 text-xs text-amber-800">
                  <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <span>
                    Inventory already received from posted GRNs will NOT be reverted.
                    Run reverse-GRN manually if needed.
                  </span>
                </div>
              )}
              <p className="text-xs text-[#6B7280]">
                Reason will be appended to PO notes as a tagged
                <code className="mx-1 px-1 py-0.5 rounded bg-[#FAF9F7] text-[#374151]">[CANCELLED YYYY-MM-DD: …]</code>
                annotation.
              </p>
            </div>
            <div className="flex justify-end gap-2 p-5 border-t border-[#E2DDD8]">
              <Button
                variant="outline"
                onClick={() => setShowCancelModal(false)}
                disabled={cancelling}
              >
                Keep PO
              </Button>
              <Button
                variant="primary"
                className="bg-[#9A3A2D] hover:bg-[#7A2E24]"
                onClick={submitCancel}
                disabled={cancelling || cancelReason.trim().length < 10}
              >
                {cancelling ? "Cancelling…" : "Cancel PO"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Document lineage — GRNs received + PIs raised against this PO.
          Always rendered (pills disabled/greyed when count is 0) so the
          operator can see the chain at a glance even before any GRN exists. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-[#6B7280]">Document Lineage</CardTitle>
        </CardHeader>
        <CardContent>
          <PurchaseLineageBar
            links={[
              {
                type: "GRN",
                label: relatedGrns.length === 1 ? (relatedGrns[0].grnNumber || "GRN") : "GRNs",
                count: relatedGrns.length,
                items: relatedGrns.map((g) => ({
                  id: g.id,
                  docNo: g.grnNumber || g.id,
                  href: `/procurement/grn/${g.id}`,
                  status: g.status ?? null,
                })),
              },
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

      {/* Three-Way Match panel (Phase 4.3) — collapsible "tab" surfacing
          PO ↔ GRN ↔ PI variance per material. Hidden until the user clicks
          to expand. Source: GET /api/three-way-match/by-po/:poId. */}
      {po && <ThreeWayMatchPanel poId={po.id} />}

      {/* Audit trail for this PO */}
      {po && <AuditHistoryPanel resource="purchase-orders" resourceId={po.id} />}
    </div>
  );
}

// ============================================================
// Phase 4.3 — Three-Way Match panel
// ============================================================
type TwmLine = {
  materialCode: string;
  materialName: string;
  materialCategory: string;
  unit: string;
  poQty: number;
  grnQty: number;
  piQty: number;
  poUnitPriceSen: number;
  grnUnitPriceSen: number;
  piUnitPriceSen: number;
  poLineSen: number;
  grnLineSen: number;
  piLineSen: number;
  qtyVarianceVsPo: number;
  piVsPoQtyVariance: number;
  senVarianceVsPo: number;
  piVsPoSenVariance: number;
  fabricVariancePct: number | null;
  fabricFlagged: boolean;
  status: "MATCH" | "VARIANCE";
};

type TwmData = {
  poId: string;
  poNo: string;
  supplierId: string;
  supplierName: string;
  hasGRN: boolean;
  hasPI: boolean;
  lines: TwmLine[];
  summary: {
    poTotalSen: number;
    grnTotalSen: number;
    piTotalSen: number;
    overBilledSen: number;
    underDeliveredSen: number;
  };
};

function ThreeWayMatchPanel({ poId }: { poId: string }) {
  const [open, setOpen] = useState(false);
  // Fetch only when the panel is opened — avoids a useless query on every
  // PO detail render.
  const { data: resp, loading } = useCachedJson<{
    success?: boolean;
    data?: TwmData;
    error?: string;
  }>(open ? `/api/three-way-match/by-po/${poId}` : null);

  const data: TwmData | null = useMemo(
    () => (resp?.success ? resp.data ?? null : null),
    [resp],
  );

  const totalVariances = useMemo(() => {
    if (!data) return 0;
    return data.lines.filter((l) => l.status === "VARIANCE").length;
  }, [data]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-2">
            <GitCompare className="h-4 w-4 text-[#6B5C32]" />
            Three-Way Match
            {data && (
              <span className="text-xs font-normal text-[#6B7280]">
                — {data.lines.length} line{data.lines.length === 1 ? "" : "s"}
                {totalVariances > 0 && (
                  <span className="ml-1 text-[#9A3A2D] font-medium">
                    · {totalVariances} variance{totalVariances === 1 ? "" : "s"}
                  </span>
                )}
              </span>
            )}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            {open ? "Hide" : "Show"}
          </Button>
        </CardTitle>
      </CardHeader>
      {open && (
        <CardContent>
          {loading && (
            <p className="text-sm text-[#9CA3AF] py-4 text-center">Loading…</p>
          )}
          {!loading && !data && (
            <p className="text-sm text-[#9CA3AF] py-4 text-center">
              No reconciliation data available.
            </p>
          )}
          {data && (
            <>
              {(!data.hasGRN || !data.hasPI) && (
                <div className="mb-3 p-2 rounded border border-amber-200 bg-amber-50 text-xs text-amber-800">
                  {!data.hasGRN && !data.hasPI && "No posted GRN and no PI yet — only PO line is shown."}
                  {data.hasGRN && !data.hasPI && "GRN posted; awaiting purchase invoice for full reconciliation."}
                  {!data.hasGRN && data.hasPI && "Purchase invoice received but no posted GRN yet."}
                </div>
              )}
              <div className="rounded-md border border-[#E2DDD8] overflow-hidden overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-[#E2DDD8] bg-[#F0ECE9]">
                      <th className="h-9 px-3 text-left font-medium text-[#374151]">Material</th>
                      <th className="h-9 px-3 text-right font-medium text-[#374151]">PO</th>
                      <th className="h-9 px-3 text-right font-medium text-[#374151]">GRN</th>
                      <th className="h-9 px-3 text-right font-medium text-[#374151]">PI</th>
                      <th className="h-9 px-3 text-right font-medium text-[#374151]">Δ Qty (vs PO)</th>
                      <th className="h-9 px-3 text-right font-medium text-[#374151]">Δ Value</th>
                      <th className="h-9 px-3 text-right font-medium text-[#374151]">Fabric Δ%</th>
                      <th className="h-9 px-3 text-center font-medium text-[#374151]">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.lines.map((l, idx) => {
                      const grnDelta = l.qtyVarianceVsPo;
                      const senDelta = l.senVarianceVsPo;
                      return (
                        <tr key={l.materialCode || idx} className={`border-b border-[#E2DDD8] last:border-b-0 ${idx % 2 === 1 ? "bg-[#FAF9F7]" : ""}`}>
                          <td className="h-9 px-3">
                            <span className="font-medium text-[#6B5C32]">{l.materialCode}</span>
                            <span className="text-[#6B7280] ml-1">{l.materialName.replace(/^[^ ]+ - /, "")}</span>
                            {l.materialCategory && (
                              <span className="text-[#9CA3AF] ml-1 text-[10px]">[{l.materialCategory}]</span>
                            )}
                          </td>
                          <td className="h-9 px-3 text-right text-[#4B5563]">{l.poQty.toFixed(2)}</td>
                          <td className="h-9 px-3 text-right text-[#4B5563]">{l.grnQty.toFixed(2)}</td>
                          <td className="h-9 px-3 text-right text-[#4B5563]">{l.piQty.toFixed(2)}</td>
                          <td className={`h-9 px-3 text-right font-medium ${grnDelta === 0 ? "text-[#4F7C3A]" : grnDelta < 0 ? "text-[#9A3A2D]" : "text-[#9C6F1E]"}`}>
                            {grnDelta > 0 ? "+" : ""}{grnDelta.toFixed(2)}
                          </td>
                          <td className={`h-9 px-3 text-right font-medium ${senDelta === 0 ? "text-[#4F7C3A]" : senDelta < 0 ? "text-[#9A3A2D]" : "text-[#9C6F1E]"}`}>
                            {senDelta > 0 ? "+" : ""}{formatCurrency(senDelta)}
                          </td>
                          <td className="h-9 px-3 text-right">
                            {l.fabricVariancePct === null ? (
                              <span className="text-[#9CA3AF]">—</span>
                            ) : (
                              <span className={`inline-flex items-center gap-1 ${l.fabricFlagged ? "text-[#9A3A2D] font-medium" : "text-[#4B5563]"}`}>
                                {l.fabricFlagged && <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#9A3A2D]" />}
                                {l.fabricVariancePct > 0 ? "+" : ""}{l.fabricVariancePct.toFixed(2)}%
                              </span>
                            )}
                          </td>
                          <td className="h-9 px-3 text-center">
                            {l.status === "MATCH" ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-green-50 text-green-700 border border-green-200">
                                <CheckCircle className="h-3 w-3" />
                                Match
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-amber-50 text-amber-700 border border-amber-200">
                                <AlertTriangle className="h-3 w-3" />
                                Variance
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-[#F0ECE9]">
                      <td className="h-10 px-3 font-semibold text-[#374151]">
                        Totals — {data.supplierName || data.supplierId}
                      </td>
                      <td className="h-10 px-3 text-right font-semibold text-[#374151]">{formatCurrency(data.summary.poTotalSen)}</td>
                      <td className="h-10 px-3 text-right font-semibold text-[#374151]">{formatCurrency(data.summary.grnTotalSen)}</td>
                      <td className="h-10 px-3 text-right font-semibold text-[#374151]">{formatCurrency(data.summary.piTotalSen)}</td>
                      <td className="h-10 px-3"></td>
                      <td className="h-10 px-3"></td>
                      <td className="h-10 px-3"></td>
                      <td className="h-10 px-3"></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="mt-3 grid gap-3 grid-cols-1 sm:grid-cols-2">
                <div className="p-3 rounded border border-[#E2DDD8] bg-white">
                  <p className="text-xs text-[#6B7280]">Over-billed (PI &gt; PO)</p>
                  <p className={`text-lg font-bold ${data.summary.overBilledSen > 0 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>
                    {formatCurrency(data.summary.overBilledSen)}
                  </p>
                </div>
                <div className="p-3 rounded border border-[#E2DDD8] bg-white">
                  <p className="text-xs text-[#6B7280]">Under-delivered (GRN &lt; PO)</p>
                  <p className={`text-lg font-bold ${data.summary.underDeliveredSen > 0 ? "text-[#9C6F1E]" : "text-[#1F1D1B]"}`}>
                    {formatCurrency(data.summary.underDeliveredSen)}
                  </p>
                </div>
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}
