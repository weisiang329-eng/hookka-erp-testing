// ---------------------------------------------------------------------------
// GRN Create — full-page form.
//
// Manual entry is the DEFAULT surface. A top-right "Convert from PO" button
// opens a line-pick modal: pick a PO, select its lines (each with remaining
// availableQty) + per-line received qty, confirm → the GRN is pre-filled and
// linked to that PO. There is no "From PO | Manual" mode toggle — the page
// is in "PO-linked" mode whenever a PO has been picked (or ?poId= deep-links
// in), and reverts to plain manual entry when the link is cleared.
//
// Layout matches src/pages/procurement/create.tsx (New PO):
//   • Top header strip (back arrow + title + Convert/Cancel/Save buttons)
//   • 1-2 column grid: GRN Details card (left) + Summary card (right)
//   • Items card spans full width below
//
// The GRNFormDialog modal is KEPT in grn.tsx because detail.tsx (the PO
// detail page) still uses it via the "Receive Goods" button with lockedPoId.
//
// Query params
//   ?poId=<id>   — pre-select a PO (PO-linked mode); locks the PO.
//   ?scan=1      — auto-open the scan modal once a PO is selected
//
// MULTI-PO (owner 2026-08-04: "可以多个 PO 去 Good receipt"). One delivery
// routinely covers several purchase orders, so "Convert from PO" becomes "Add
// another PO" once lines exist and APPENDS rather than replaces.
//
// Each line carries its own { poId, poItemId } and is sent that way, so every
// purchase order is drawn down against its own line — `grns.poId` is only the
// header/display PO (the first one added). Rows show their PO number once more
// than one is involved, or the table is unreadable.
//
// Two guards: a second PO from a DIFFERENT supplier is refused (one GRN has one
// supplier, and taking the first would misattribute the goods), and re-picking
// a PO line already on the receipt is skipped so it cannot be double-counted.
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
import type { PurchaseOrder, Supplier, RawMaterial, SupplierMaterialBinding } from "@/types";
import { ArrowLeft, Save, ScanLine, Plus, Trash2, ChevronDown, ChevronUp, Ship, FolderInput } from "lucide-react";
import {
  ScanSupplierModal,
  type SupplierExtraction,
} from "@/components/scan-supplier-modal";
import {
  ConvertFromPOModal,
  type ConvertFromPOResult,
} from "@/components/convert-from-po-modal";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * PO-mode line.
 *
 * Each line names the PO LINE it receives, because one receipt routinely
 * covers several purchase orders (owner 2026-08-04). `poItemIndex` is kept for
 * the older backend path — the create handler prefers poId/poItemId when both
 * are present — but it is only meaningful WITHIN that line's own PO.
 */
type POItemEntry = {
  poId: string;
  poItemId: string;
  poItemIndex: number;
  receivedQty: number;
  acceptedQty: number;
  rejectedQty: number;
  rejectionReason: string;
};

/** Stable React key — poItemIndex alone collides across POs. */
function entryKey(e: { poId: string; poItemId: string; poItemIndex: number }): string {
  return `${e.poId}:${e.poItemId || e.poItemIndex}`;
}

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

  // If opened with ?poId= the PO is locked (deep-link from PO detail/list).
  const isLockedPO = Boolean(seedPoId);

  // ── Data fetches ─────────────────────────────────────────────────────────
  const { data: poResp } = useCachedJson<
    { success?: boolean; data?: PurchaseOrder[] } | PurchaseOrder[]
  >("/api/purchase-orders");

  const { data: supResp } = useCachedJson<{
    success?: boolean;
    data?: Supplier[];
  }>("/api/suppliers");

  // Purchase Company registry — feeds the per-GRN buying-company dropdown.
  const { data: orgsResp } = useCachedJson<{ organisations?: Array<{ code: string; name: string; isActive?: boolean }> }>("/api/organisations");

  // Raw materials + supplier↔material bindings — fed to the scan-create wizard
  // (mode="create-grn") so its strict-pick MaterialPickers + binding lookups work.
  const { data: invResp } = useCachedJson<{
    success?: boolean;
    data?: { rawMaterials?: RawMaterial[] };
  }>("/api/inventory");
  const { data: bindingsResp } = useCachedJson<
    { success?: boolean; data?: SupplierMaterialBinding[] } | SupplierMaterialBinding[]
  >("/api/supplier-materials");

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

  // Active raw materials (for the scan-create wizard's MaterialPicker).
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

  // ── PO link state ─────────────────────────────────────────────────────────
  // The page is "PO-linked" whenever selectedPO is set (deep-link or convert).
  const [selectedPO, setSelectedPO] = useState(seedPoId);
  const isPoLinked = Boolean(selectedPO);
  const po = purchaseOrders.find((p) => p.id === selectedPO);

  // ── Shared form state ─────────────────────────────────────────────────────
  const [receivedBy, setReceivedBy] = useState("");
  const [notes, setNotes] = useState("");
  // Supplier's own delivery-order number on this receipt (owner 2026-06-21).
  const [supplierDoNo, setSupplierDoNo] = useState("");
  const [scanOpen, setScanOpen] = useState(false);
  // The scan-create wizard (mode="create-grn"): a separate flow from the
  // in-page apply-mode "Scan supplier document" autofill. Opens via the
  // top-right "Scan & Create GRNs" button or the ?scan=1 deep-link.
  const [scanCreateOpen, setScanCreateOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // OCR gate (owner ruling 2026-06-21, mirrors PI create): a GRN built from a
  // scanned supplier document lands as DRAFT (parked for review, like a scanned
  // Sales Order). A manual create is a REAL document — it posts straight to
  // stock when the goods have arrived (local), or sits in the arrival pipeline
  // when the goods are still in transit (import). Flips true on the ?scan=1
  // deep-link or whenever the scan modal's applyOcr runs.
  const [ocrUsed, setOcrUsed] = useState(false);

  // ── Shipment details (PO-linked only) ─────────────────────────────────────
  const [shipmentOpen, setShipmentOpen] = useState(false);
  const [shipmentMethod, setShipmentMethod] = useState("");
  const [shipmentCarrier, setShipmentCarrier] = useState("");
  const [shipmentExpectedArrival, setShipmentExpectedArrival] = useState("");

  // ── PO-mode entries (built from a picked PO; keyed by poItemIndex) ─────────
  const [poItemEntries, setPoItemEntries] = useState<POItemEntry[]>([]);
  // Header info from the convert pick (so the form shows supplier/PO before
  // the PO list cache resolves the full `po` object).
  const [convertSupplierName, setConvertSupplierName] = useState("");
  const [convertPoNo, setConvertPoNo] = useState("");

  // ── Manual-mode state (default surface when NOT PO-linked) ─────────────────
  const [supplierId, setSupplierId] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [manualItems, setManualItems] = useState<ManualItemEntry[]>([
    newManualRow(),
  ]);

  // ── Purchase company (HOOKKA / OHANA / sister co) on this GRN ─────────────
  // Defaults from source PO → supplier → "HOOKKA". Always overridable.
  const [purchaseOrgCode, setPurchaseOrgCode] = useState<string>("HOOKKA");
  const activeOrgs = useMemo(
    () => (orgsResp?.organisations ?? []).filter((o) => o.isActive !== false),
    [orgsResp],
  );

  // ── Auto-scan gate ─────────────────────────────────────────────────────────
  // ?scan=1 + locked PO → open the in-page apply-mode autofill (legacy).
  // ?scan=1 alone (no PO) → open the create-grn wizard so the operator can
  // scan multiple delivery notes straight into DRAFT GRNs.
  const autoScanFired = useRef(false);
  useEffect(() => {
    if (autoScanFired.current) return;
    if (autoScan && po) {
      autoScanFired.current = true;
      /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setScanOpen(true);
    } else if (autoScan && !isLockedPO) {
      autoScanFired.current = true;
      /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setScanCreateOpen(true);
    }
  }, [autoScan, po, isLockedPO]);
  // NOTE: ocrUsed is flipped in applyOcr (the authoritative moment a scanned
  // document actually builds the lines), covering both the PO-linked and manual
  // scan flows. We deliberately do NOT force it on the ?scan=1 deep-link alone:
  // if the operator opens Scan but then keys the receipt by hand, it should
  // follow the manual rule (post when arrived), not be stuck as a Draft.

  // ── Seed PO item entries when a deep-linked PO resolves ────────────────────
  // Only runs for the ?poId= deep-link path (locked PO). Convert-from-PO picks
  // seed entries directly in handleConvert so we honour per-line qty there.
  const deepLinkSeeded = useRef(false);
  /* eslint-disable react-hooks/set-state-in-effect -- seed from deep-linked PO */
  useEffect(() => {
    if (isLockedPO && po && !deepLinkSeeded.current) {
      deepLinkSeeded.current = true;
      setPoItemEntries(
        po.items.map((item, idx) => {
          const remaining = Math.max(0, item.quantity - (item.receivedQty || 0));
          return {
            poId: po.id,
            poItemId: String(item.id ?? ""),
            poItemIndex: idx,
            receivedQty: remaining,
            acceptedQty: remaining,
            rejectedQty: 0,
            rejectionReason: "",
          };
        }),
      );
    }
  }, [isLockedPO, po]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ── Convert-from-PO handler ────────────────────────────────────────────────
  const handleConvert = (res: ConvertFromPOResult) => {
    // One GRN has ONE supplier. Receiving two suppliers on a single document
    // would misattribute the goods, so refuse rather than silently take the
    // first supplier and mislabel the rest.
    if (
      poItemEntries.length > 0 &&
      convertSupplierName &&
      res.supplierName &&
      res.supplierName !== convertSupplierName
    ) {
      toast.error(
        `This receipt is for ${convertSupplierName}. Create a separate GRN for ${res.supplierName}.`,
      );
      return;
    }
    // The FIRST PO becomes the header PO; later ones only contribute lines.
    if (!selectedPO) {
      setSelectedPO(res.poId);
      setConvertPoNo(res.poNo);
      setConvertSupplierName(res.supplierName);
    }
    deepLinkSeeded.current = true; // suppress the deep-link seeder
    const incoming = res.lines.map((l) => ({
        poId: res.poId,
        poItemId: String(
          purchaseOrders.find((x) => x.id === res.poId)?.items?.[l.poItemIndex]?.id ?? "",
        ),
      poItemIndex: l.poItemIndex,
      receivedQty: l.receivedQty,
      acceptedQty: l.receivedQty,
      rejectedQty: 0,
      rejectionReason: "",
    }));
    // Append, skipping any PO line already on this receipt so picking the same
    // PO twice cannot double-count it.
    setPoItemEntries((prev) => {
      const seen = new Set(prev.map(entryKey));
      return [...prev, ...incoming.filter((e) => !seen.has(entryKey(e)))];
    });
  };

  // ── Clear the PO link → back to manual entry ───────────────────────────────
  const clearPoLink = () => {
    setSelectedPO("");
    setPoItemEntries([]);
    setConvertPoNo("");
    setConvertSupplierName("");
  };

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
    // Prefill the Purchase company from this supplier's default; always
    // overridable below. Empty supplier resets to "HOOKKA".
    if (s?.purchaseOrgCode) {
      setPurchaseOrgCode(s.purchaseOrgCode);
    } else if (!id) {
      setPurchaseOrgCode("HOOKKA");
    }
  };

  // Prefill Purchase company when the source PO resolves (deep-link or
  // convert flow). Source PO wins over supplier; supplier wins over default.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isPoLinked) return;
    const sup = po?.supplierId ? suppliers.find((s) => s.id === po.supplierId) : null;
    const next = po?.purchaseOrgCode || sup?.purchaseOrgCode || "HOOKKA";
    /* eslint-disable-next-line react-hooks/set-state-in-effect */
    setPurchaseOrgCode(next);
  }, [isPoLinked, po, suppliers]);

  // ── OCR apply ────────────────────────────────────────────────────────────
  const applyOcr = (ex: SupplierExtraction) => {
    // Building the receipt from a scanned document = the OCR path → this GRN
    // lands as DRAFT (editable/parked for review), matching the Sales Order and
    // Purchase Invoice scan rule. A manual create stays a real document.
    setOcrUsed(true);
    if (isPoLinked) {
      // PO-linked — match against PO lines (existing behaviour)
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
          const targetPoIdx = po.items.findIndex((it) => {
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
          if (targetPoIdx < 0) continue;
          // Find the entry row carrying that poItemIndex.
          const entryIdx = next.findIndex(
            (e) => e.poItemIndex === targetPoIdx,
          );
          if (entryIdx >= 0) {
            const remaining = Math.max(
              0,
              po.items[targetPoIdx].quantity -
                (po.items[targetPoIdx].receivedQty || 0),
            );
            const recv = remaining > 0 ? Math.min(qty, remaining) : qty;
            next[entryIdx] = {
              ...next[entryIdx],
              receivedQty: recv,
              acceptedQty: recv,
            };
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
  const activeEntries = isPoLinked
    ? poItemEntries
    : manualItems.map((m) => ({
        receivedQty: m.receivedQty,
        acceptedQty: m.acceptedQty,
        rejectedQty: m.rejectedQty,
      }));

  const totalReceived = activeEntries.reduce((s, e) => s + e.receivedQty, 0);
  const totalAccepted = activeEntries.reduce((s, e) => s + e.acceptedQty, 0);
  const totalRejected = activeEntries.reduce((s, e) => s + e.rejectedQty, 0);
  const hasItems = isPoLinked
    ? poItemEntries.some((e) => e.receivedQty > 0)
    : manualItems.some((e) => e.receivedQty > 0 && e.materialName.trim());

  // PO line lookup. Entries may come from SEVERAL purchase orders, so resolve
  // against the entry's own PO — falling back to the header PO by index for
  // rows seeded before a poItemId was known.
  const poById = useMemo(
    () => new Map(purchaseOrders.map((x) => [x.id, x])),
    [purchaseOrders],
  );
  const poItemForEntry = (e: POItemEntry) => {
    const owner = poById.get(e.poId) ?? po;
    if (!owner) return undefined;
    return (
      owner.items.find((it) => String(it.id ?? "") === e.poItemId) ??
      owner.items[e.poItemIndex]
    );
  };
  /** Distinct POs contributing lines — drives the header chips + summary. */
  const linkedPoIds = useMemo(
    () => [...new Set(poItemEntries.map((e) => e.poId).filter(Boolean))],
    [poItemEntries],
  );

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (saving) return;

    if (isPoLinked) {
      if (!selectedPO) {
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

      if (isPoLinked) {
        // Include shipment fields if the operator filled them in.
        const hasShipment = shipmentMethod || shipmentCarrier || shipmentExpectedArrival;
        body = {
          poId: selectedPO,
          purchaseOrgCode,
          receivedBy: receivedBy.trim(),
          notes: notes.trim(),
          supplier_do_no: supplierDoNo.trim() || null,
          // No-Draft (owner 2026-06-21): OCR/scan → DRAFT (review); otherwise the
          // backend derives the status from arrival (arrived → POSTED, in
          // transit → DRAFT tracked by the arrival pipeline).
          ocrUsed,
          // Each line carries its OWN purchase order, so a receipt spanning
          // several POs draws each one down correctly. `poId` above is only
          // the header/display PO (the first one added).
          items: poItemEntries
            .filter((ie) => ie.receivedQty > 0)
            .map((ie) => ({
              poItemIndex: ie.poItemIndex,
              poId: ie.poId || selectedPO,
              poItemId: ie.poItemId || null,
              receivedQty: ie.receivedQty,
              acceptedQty: ie.acceptedQty,
              rejectedQty: ie.rejectedQty,
              rejectionReason: ie.rejectionReason,
            })),
          ...(hasShipment ? {
            arrival_state: "NOT_ARRIVED",
            shipping_method: shipmentMethod || null,
            carrier_name: shipmentCarrier || null,
            expected_arrival: shipmentExpectedArrival || null,
          } : {}),
        };
      } else {
        const validLines = manualItems.filter(
          (m) => m.materialName.trim() && m.receivedQty > 0,
        );
        body = {
          supplierId,
          supplierName,
          purchaseOrgCode,
          receivedBy: receivedBy.trim(),
          notes: notes.trim(),
          supplier_do_no: supplierDoNo.trim() || null,
          // No-Draft (owner 2026-06-21): OCR/scan → DRAFT (review); a manual
          // receipt with no arrival override defaults to ARRIVED → POSTED
          // (local goods in hand, stock in now).
          ocrUsed,
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
        data?: { id?: string; status?: string };
        costing?: { unresolvedLines?: unknown[] };
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
      // Born-POSTED (local goods) → stock is in. Surface any line that had no
      // matching raw material so the operator knows that stock did NOT land.
      const unresolved = resBody.costing?.unresolvedLines?.length ?? 0;
      if (resBody.data?.status === "POSTED") {
        if (unresolved > 0) {
          toast.error(
            `GRN created & posted, but ${unresolved} line(s) had no matching raw material — that stock did NOT land.`,
          );
        } else {
          toast.success("GRN created and posted to stock");
        }
      } else {
        toast.success("GRN created");
      }
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
  const summaryPO = isPoLinked ? (po?.poNo || convertPoNo || "—") : "—";
  const summarySupplier = isPoLinked
    ? (po?.supplierName || convertSupplierName || "—")
    : supplierName || "—";

  // ── No-Draft create-status hint (mirrors the backend mapping) ──────────────
  // OCR/scan → DRAFT (review). A PO-linked receipt is treated as an import in
  // transit (tracked by the arrival pipeline; posts to stock once it arrives).
  // A plain manual receipt = local goods in hand → POSTED straight to stock.
  const willPostNow = !ocrUsed && !isPoLinked;
  const createStatusHint = ocrUsed
    ? "Scanned receipt — status will be set to DRAFT for review"
    : willPostNow
      ? "Local goods — will be received and posted to stock on save"
      : "Import in transit — tracked in the Arrival pipeline; posts to stock when marked Arrived";
  const saveLabel = saving
    ? "Saving..."
    : willPostNow
      ? "Receive & Post to Stock"
      : "Create GRN";

  // ── Scan modal context ───────────────────────────────────────────────────
  const scanSupplierId = isPoLinked
    ? (po?.supplierId ?? null)
    : (supplierId || null);
  const scanSupplierName = isPoLinked
    ? (po?.supplierName ?? convertSupplierName ?? null)
    : (supplierName || null);
  const scanPoContext =
    isPoLinked && po
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
      <div className="flex items-center gap-4 flex-wrap">
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
        {/* Convert from PO — hidden when deep-linked to a locked PO */}
        {!isLockedPO && (
          <Button
            variant="outline"
            onClick={() => setConvertOpen(true)}
            title="Pick a Purchase Order and its lines to pre-fill this receipt"
          >
            <FolderInput className="h-4 w-4" />{" "}
            {poItemEntries.length > 0 ? "Add another PO" : "Convert from PO"}
          </Button>
        )}
        {/* Scan & Create GRNs (multi-document wizard) — only when not deep-linked
            to a locked PO; the in-page autofill is the right path when a PO is
            already pinned. */}
        {!isLockedPO && (
          <Button
            variant="outline"
            onClick={() => setScanCreateOpen(true)}
            title="Upload supplier delivery notes (multiple OK) and auto-create one DRAFT GRN per document"
          >
            <ScanLine className="h-4 w-4" /> Scan &amp; Create GRNs
          </Button>
        )}
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
            (isPoLinked ? !selectedPO || !hasItems : !supplierId || !hasItems)
          }
          className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
          title={
            isPoLinked
              ? !selectedPO
                ? "Pick a purchase order first"
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
          {saveLabel}
        </Button>
      </div>

      {/* Top section: GRN Details (2/3) + Summary (1/3) */}
      <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3">
            <CardTitle>GRN Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* PO-linked banner — shows the linked PO + an Unlink action */}
            {isPoLinked && (
              <div className="flex items-center justify-between rounded-md border border-[#E8D597] bg-[#FAEFCB] px-3 py-2 text-sm">
                <div className="text-[#6B5C32]">
                  Receiving against{" "}
                  <span className="font-semibold">{summaryPO}</span>
                  {summarySupplier !== "—" && (
                    <> — {summarySupplier}</>
                  )}
                </div>
                {!isLockedPO && (
                  <button
                    type="button"
                    className="text-xs font-medium text-[#6B5C32] underline hover:text-[#5a4d2a]"
                    onClick={clearPoLink}
                  >
                    Unlink / manual entry
                  </button>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Supplier — read-only when PO-linked (derived from the PO); editable picker in manual mode */}
              {isPoLinked ? (
                <div>
                  <label className="block text-sm font-medium text-[#374151] mb-1.5">
                    Supplier
                  </label>
                  {(() => {
                    const linkedSupplierId = po?.supplierId ?? "";
                    const linkedSupplierCode =
                      suppliers.find((s) => s.id === linkedSupplierId)?.code ?? "";
                    const linkedSupplierName =
                      po?.supplierName || convertSupplierName || "—";
                    return (
                      <div className="flex items-center h-10 px-3 rounded-md border border-[#E2DDD8] bg-[#FAF9F7] text-sm text-[#374151] select-none">
                        {linkedSupplierCode
                          ? <><span className="font-mono text-xs text-[#6B7280] mr-2">{linkedSupplierCode}</span>{linkedSupplierName}</>
                          : linkedSupplierName}
                      </div>
                    );
                  })()}
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

              {/* Purchase company (HOOKKA / OHANA / sister co) */}
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">
                  Purchase company<span className="text-[#9A3A2D]"> *</span>
                </label>
                <select
                  className="flex h-10 w-full rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
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

              {/* Supplier DO No. — the supplier's delivery-order number */}
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">
                  Supplier DO No.
                </label>
                <Input
                  value={supplierDoNo}
                  onChange={(e) => setSupplierDoNo(e.target.value)}
                  placeholder="Supplier's delivery order number"
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

            {/* Shipment Details — PO-linked only; optional collapsible */}
            {isPoLinked && (
              <div className="border border-[#E2DDD8] rounded-lg overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShipmentOpen(!shipmentOpen)}
                  className="w-full flex items-center justify-between px-4 py-3 bg-[#FAF9F7] hover:bg-[#F0ECE9] transition-colors text-left cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <Ship className="h-4 w-4 text-[#6B5C32]" />
                    <span className="text-sm font-medium text-[#374151]">Shipment Details</span>
                    <span className="text-xs text-[#9CA3AF]">optional — fills in carrier &amp; expected arrival</span>
                  </div>
                  {shipmentOpen ? <ChevronUp className="h-4 w-4 text-[#6B7280]" /> : <ChevronDown className="h-4 w-4 text-[#6B7280]" />}
                </button>
                {shipmentOpen && (
                  <div className="p-4 border-t border-[#E2DDD8] space-y-3 bg-white">
                    <p className="text-xs text-[#6B7280]">
                      If this is an imported shipment (goods not yet arrived), fill in the shipping details below. The GRN will be created with arrival status <b>Not Arrived</b> and can be advanced as the shipment progresses. Leave blank for local / walk-in deliveries.
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-[#374151] mb-1">Shipping Method</label>
                        <select
                          value={shipmentMethod}
                          onChange={(e) => setShipmentMethod(e.target.value)}
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
                        <label className="block text-xs font-medium text-[#374151] mb-1">Carrier</label>
                        <Input
                          value={shipmentCarrier}
                          onChange={(e) => setShipmentCarrier(e.target.value)}
                          placeholder="e.g. COSCO, DHL"
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[#374151] mb-1">Expected Arrival</label>
                        <Input
                          type="date"
                          value={shipmentExpectedArrival}
                          onChange={(e) => setShipmentExpectedArrival(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Summary card */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle>Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {isPoLinked && (
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
            <div className="flex justify-between text-sm">
              <span className="text-[#6B7280]">Line Items</span>
              <span className="font-medium">
                {isPoLinked
                  ? poItemEntries.length
                  : manualItems.filter(
                      (m) => m.materialName.trim() && m.receivedQty > 0,
                    ).length}
              </span>
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
            <div className="text-xs text-[#9CA3AF]">{createStatusHint}</div>
          </CardContent>
        </Card>
      </div>

      {/* Items card — full width */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle>
              {isPoLinked
                ? `Items — Enter Received Quantities (${poItemEntries.length})`
                : "Items — Enter Lines"}
            </CardTitle>
            <div className="flex items-center gap-2">
              {/* Scan button: PO mode needs a PO; Manual once supplier picked */}
              {(isPoLinked ? po : supplierId) && (
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
              {!isPoLinked && (
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
          {isPoLinked ? (
            poItemEntries.length === 0 ? (
              <div className="rounded-md border border-dashed border-[#E2DDD8] bg-[#FAF9F7] py-10 text-center text-sm text-[#9CA3AF]">
                {po
                  ? "Loading PO items…"
                  : "No lines picked. Use Convert from PO to pick lines."}
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
                    {poItemEntries.map((entry, idx) => {
                      const poItem = poItemForEntry(entry);
                      const ownerPo = poById.get(entry.poId);
                      const alreadyReceived = poItem?.receivedQty || 0;
                      const ordered = poItem?.quantity ?? 0;
                      const cumulative = alreadyReceived + entry.receivedQty;
                      const overReceipt =
                        ordered > 0 && cumulative > ordered * 1.1;
                      return (
                        <tr
                          key={entryKey(entry)}
                          className="border-t border-[#E2DDD8] hover:bg-[#FAF9F7]"
                        >
                          <td className="px-3 py-2">
                            <div className="font-medium text-[#1F1D1B]">
                              {poItem?.materialName ??
                                `Line #${entry.poItemIndex + 1}`}
                            </div>
                            <div className="text-xs text-[#9CA3AF]">
                              {poItem?.supplierSKU ?? ""}
                              {/* Which PO this line draws down — without it a
                                  multi-PO receipt is unreadable. Only shown
                                  once more than one PO is involved. */}
                              {linkedPoIds.length > 1 && ownerPo?.poNo && (
                                <span className="ml-2 rounded bg-[#E0EDF0] px-1.5 py-0.5 text-[10px] font-medium text-[#3E6570]">
                                  {ownerPo.poNo}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <div className="text-[#374151]">
                              {ordered} {poItem?.unit ?? ""}
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

      {/* Convert from PO line-pick modal */}
      <ConvertFromPOModal
        open={convertOpen}
        onClose={() => setConvertOpen(false)}
        onConfirm={handleConvert}
      />

      {/* Scan supplier document modal (apply mode — autofills this form's lines) */}
      <ScanSupplierModal
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        supplierId={scanSupplierId}
        supplierName={scanSupplierName}
        poContext={scanPoContext}
        onApply={applyOcr}
      />

      {/* Scan-create wizard (create-grn mode) — multi-document → DRAFT GRNs.
          The wizard owns the entire OCR-to-GRN flow; this host page just
          refreshes the GRN list cache and navigates on success. */}
      <ScanSupplierModal
        mode="create-grn"
        open={scanCreateOpen}
        onClose={() => setScanCreateOpen(false)}
        suppliers={suppliers}
        rawMaterials={allRawMaterials}
        bindings={supplierMaterialBindings}
        organisations={activeOrgs}
        purchaseOrders={purchaseOrders}
        defaultSupplierId={
          isPoLinked ? po?.supplierId ?? null : (supplierId || null)
        }
        defaultPurchaseOrderId={isPoLinked ? selectedPO || null : null}
        onCreated={(ids) => {
          if (ids.length > 0) {
            invalidateCachePrefix("/api/grn");
            invalidateCachePrefix("/api/purchase-orders");
            invalidateCachePrefix("/api/inventory");
            invalidateCachePrefix("/api/raw-materials");
            toast.success(
              ids.length === 1
                ? "Goods Receipt Note created"
                : `${ids.length} Goods Receipt Notes created`,
            );
            navigate("/procurement/grn");
          }
        }}
      />
    </div>
  );
}
