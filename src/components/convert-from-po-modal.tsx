// ---------------------------------------------------------------------------
// ConvertFromPOModal — line-pick "Convert from PO" picker for GRN create.
//
// Two-step modal:
//   Step 1 — pick ONE purchase order (search by PO number / supplier). Only
//            POs eligible for receiving are listed (SUBMITTED / CONFIRMED /
//            PARTIAL_RECEIVED). Fully-received POs are excluded.
//   Step 2 — list that PO's lines with per-line `availableQty`
//            (= quantity − receivedQty). Checkbox-select + per-line received
//            qty (clamped to available). Confirm pre-fills the GRN line table.
//
// Single-PO by design: the GRN backend keys lines to ONE parent PO by
// `poItemIndex` (grns.poId is a single column). Multi-PO → one GRN is NOT
// supported by the current schema — see the create page's report note.
//
// Used from: src/pages/procurement/grn/create.tsx  — "Convert from PO" button.
// ---------------------------------------------------------------------------
import { useState, useMemo, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCachedJson } from "@/lib/cached-fetch";
import type { PurchaseOrder } from "@/types";
import { X, Search, FileText, ArrowLeft } from "lucide-react";

// PO line as returned by GET /api/purchase-orders/:id (rowToItem).
type POLine = {
  id: string;
  materialCode?: string;
  materialName: string;
  supplierSKU: string;
  quantity: number;
  unitPriceSen: number;
  receivedQty: number;
  availableQty: number;
  unit: string;
};

type PODetail = {
  id: string;
  poNo: string;
  supplierId: string;
  supplierName: string;
  items: POLine[];
};

// One line the operator picked, mapped back to its PO line index so the GRN
// create page can build the PO-mode POST body (keyed by poItemIndex).
export type PickedPOLine = {
  poItemIndex: number;
  materialCode: string;
  materialName: string;
  supplierSku: string;
  receivedQty: number;
  unit: string;
};

export type ConvertFromPOResult = {
  poId: string;
  poNo: string;
  supplierId: string;
  supplierName: string;
  lines: PickedPOLine[];
};

type Props = {
  open: boolean;
  onClose: () => void;
  /** Called with the picked PO + lines. Host pre-fills the GRN form. */
  onConfirm: (res: ConvertFromPOResult) => void;
};

function fmtRM(sen: number) {
  return (sen / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function statusBadge(status: string) {
  const colorMap: Record<string, string> = {
    CONFIRMED: "bg-[#EFF6FF] text-[#1D4ED8]",
    SUBMITTED: "bg-[#FFFBEB] text-[#92400E]",
    PARTIAL_RECEIVED: "bg-[#FFFBEB] text-[#92400E]",
  };
  const cls = colorMap[status] ?? "bg-[#F3F0EB] text-[#6B7280]";
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${cls}`}
    >
      {status}
    </span>
  );
}

export function ConvertFromPOModal({ open, onClose, onConfirm }: Props) {
  const [query, setQuery] = useState("");
  const [selectedPoId, setSelectedPoId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Per-line pick state — keyed by PO line id.
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [qty, setQty] = useState<Record<string, number>>({});

  // PO detail for step 2 (lazy fetch on selection).
  const [poDetail, setPoDetail] = useState<PODetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Reset everything when the modal opens.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- rising-edge reset on open
      setQuery("");
      setSelectedPoId(null);
      setPoDetail(null);
      setChecked({});
      setQty({});
      // eslint-disable-next-line no-restricted-syntax -- one-shot focus after paint
      setTimeout(() => searchRef.current?.focus(), 60);
    }
  }, [open]);

  // PO list (shared cache with procurement pages).
  const { data: poResp, loading: poLoading } = useCachedJson<{
    success?: boolean;
    data?: PurchaseOrder[];
  }>("/api/purchase-orders");
  const allPOs: PurchaseOrder[] = useMemo(
    () => (poResp?.data ?? []) as PurchaseOrder[],
    [poResp],
  );

  // Only receivable POs (mirrors the GRN modal's eligiblePOs filter).
  const eligiblePOs = useMemo(
    () =>
      allPOs.filter(
        (p) =>
          p.status === "CONFIRMED" ||
          p.status === "PARTIAL_RECEIVED" ||
          p.status === "SUBMITTED",
      ),
    [allPOs],
  );

  const q = query.toLowerCase().trim();
  const filteredPOs = useMemo(() => {
    if (!q) return eligiblePOs.slice(0, 60);
    return eligiblePOs
      .filter(
        (p) =>
          p.poNo.toLowerCase().includes(q) ||
          (p.supplierName ?? "").toLowerCase().includes(q),
      )
      .slice(0, 60);
  }, [eligiblePOs, q]);

  // Fetch the chosen PO's lines and seed per-line qty to availableQty.
  useEffect(() => {
    if (!selectedPoId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear on deselect
      setPoDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    fetch(`/api/purchase-orders/${selectedPoId}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const resp = j as { success?: boolean; data?: PODetail };
        const po = resp.data ?? null;
        setPoDetail(po);
        if (po) {
          const nextChecked: Record<string, boolean> = {};
          const nextQty: Record<string, number> = {};
          for (const line of po.items) {
            const avail = Number(line.availableQty) || 0;
            // Pre-check + seed only lines that still have something to receive.
            nextChecked[line.id] = avail > 0;
            nextQty[line.id] = avail;
          }
          setChecked(nextChecked);
          setQty(nextQty);
        }
      })
      .catch(() => {
        if (!cancelled) setPoDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPoId]);

  const lines = poDetail?.items ?? [];
  const selectedCount = lines.filter(
    (l) => checked[l.id] && (Number(qty[l.id]) || 0) > 0,
  ).length;

  const handleConfirm = () => {
    if (!poDetail) return;
    const picked: PickedPOLine[] = [];
    poDetail.items.forEach((line, idx) => {
      if (!checked[line.id]) return;
      const want = Number(qty[line.id]) || 0;
      if (want <= 0) return;
      picked.push({
        poItemIndex: idx,
        materialCode: line.materialCode ?? "",
        materialName: line.materialName,
        supplierSku: line.supplierSKU ?? "",
        receivedQty: want,
        unit: line.unit ?? "pcs",
      });
    });
    if (picked.length === 0) return;
    onConfirm({
      poId: poDetail.id,
      poNo: poDetail.poNo,
      supplierId: poDetail.supplierId,
      supplierName: poDetail.supplierName,
      lines: picked,
    });
    onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl mx-4 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#E2DDD8]">
          <div className="flex items-center gap-2">
            {selectedPoId && (
              <button
                type="button"
                className="text-[#9CA3AF] hover:text-[#1F1D1B] p-1 rounded"
                onClick={() => setSelectedPoId(null)}
                title="Back to PO list"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <h2 className="text-sm font-semibold text-[#1F1D1B]">
              {selectedPoId
                ? `Select lines — ${poDetail?.poNo ?? "Loading…"}`
                : "Convert from Purchase Order"}
            </h2>
          </div>
          <button
            type="button"
            className="text-[#9CA3AF] hover:text-[#1F1D1B] p-1 rounded"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* STEP 1 — PO list */}
        {!selectedPoId && (
          <>
            <div className="px-4 pt-3 pb-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#9CA3AF]" />
                <Input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search PO number or supplier..."
                  className="pl-8 h-8 text-sm"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-2 pb-3">
              {poLoading && (
                <p className="text-xs text-[#9CA3AF] text-center py-8">
                  Loading purchase orders...
                </p>
              )}
              {!poLoading && filteredPOs.length === 0 && (
                <p className="text-xs text-[#9CA3AF] text-center py-8">
                  No purchase orders are ready to receive. A PO must be
                  Submitted or Confirmed first.
                </p>
              )}
              {filteredPOs.map((po) => (
                <button
                  type="button"
                  key={po.id}
                  className="w-full text-left px-3 py-2.5 rounded-md hover:bg-[#FAF9F7] border border-transparent hover:border-[#E2DDD8] transition-colors mb-1 flex items-center justify-between gap-3"
                  onClick={() => setSelectedPoId(po.id)}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <FileText className="h-3.5 w-3.5 text-[#6B5C32] shrink-0" />
                      <span className="font-mono text-xs font-medium text-[#1F1D1B]">
                        {po.poNo}
                      </span>
                      {statusBadge(po.status)}
                    </div>
                    <p className="text-xs text-[#6B7280] truncate mt-0.5">
                      {po.supplierName}
                      {po.orderDate ? ` · ${po.orderDate}` : ""}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs font-medium text-[#1F1D1B]">
                      {po.totalSen != null ? `RM ${fmtRM(po.totalSen)}` : ""}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {/* STEP 2 — line picker */}
        {selectedPoId && (
          <>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {detailLoading && (
                <p className="text-xs text-[#9CA3AF] text-center py-8">
                  Loading PO lines...
                </p>
              )}
              {!detailLoading && lines.length === 0 && (
                <p className="text-xs text-[#9CA3AF] text-center py-8">
                  This PO has no lines.
                </p>
              )}
              {!detailLoading && lines.length > 0 && (
                <table className="w-full text-sm">
                  <thead className="bg-[#F0ECE9] border-b border-[#E2DDD8]">
                    <tr className="text-xs uppercase tracking-wide text-[#6B7280]">
                      <th className="px-2 py-2 w-8" />
                      <th className="text-left px-2 py-2 font-medium">
                        Material
                      </th>
                      <th className="text-right px-2 py-2 font-medium w-24">
                        Available
                      </th>
                      <th className="text-right px-2 py-2 font-medium w-28">
                        Receive Qty
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line) => {
                      const avail = Number(line.availableQty) || 0;
                      const fullyReceived = avail <= 0;
                      const want = Number(qty[line.id]) || 0;
                      const over = want > avail;
                      return (
                        <tr
                          key={line.id}
                          className={`border-t border-[#E2DDD8] ${
                            fullyReceived ? "opacity-50" : "hover:bg-[#FAF9F7]"
                          }`}
                        >
                          <td className="px-2 py-2 text-center">
                            <input
                              type="checkbox"
                              disabled={fullyReceived}
                              checked={!!checked[line.id]}
                              onChange={(e) =>
                                setChecked((prev) => ({
                                  ...prev,
                                  [line.id]: e.target.checked,
                                }))
                              }
                              className="h-4 w-4 accent-[#6B5C32] cursor-pointer disabled:cursor-not-allowed"
                            />
                          </td>
                          <td className="px-2 py-2">
                            <div className="font-medium text-[#1F1D1B]">
                              {line.materialName}
                            </div>
                            <div className="text-xs text-[#9CA3AF]">
                              {line.supplierSKU || line.materialCode || ""}
                            </div>
                          </td>
                          <td className="px-2 py-2 text-right">
                            <div className="text-[#374151]">
                              {avail} {line.unit}
                            </div>
                            {fullyReceived && (
                              <div className="text-[10px] text-[#6B5C32]">
                                fully received
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-2 text-right">
                            <Input
                              type="number"
                              min={0}
                              max={avail}
                              disabled={fullyReceived || !checked[line.id]}
                              onFocus={(e) => e.currentTarget.select()}
                              value={want}
                              onChange={(e) =>
                                setQty((prev) => ({
                                  ...prev,
                                  [line.id]: Number(e.target.value),
                                }))
                              }
                              className={`w-24 text-right ml-auto h-8 ${
                                over ? "border-[#9A3A2D]" : ""
                              }`}
                            />
                            {over && (
                              <div className="text-[10px] text-[#9A3A2D] mt-0.5">
                                exceeds available
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div className="px-4 py-3 border-t border-[#E2DDD8] flex items-center justify-between">
              <span className="text-xs text-[#6B7280]">
                {selectedCount} line{selectedCount === 1 ? "" : "s"} selected
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleConfirm}
                  disabled={
                    selectedCount === 0 ||
                    lines.some(
                      (l) =>
                        checked[l.id] &&
                        (Number(qty[l.id]) || 0) >
                          (Number(l.availableQty) || 0),
                    )
                  }
                  className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
                >
                  Add {selectedCount > 0 ? `${selectedCount} ` : ""}line
                  {selectedCount === 1 ? "" : "s"}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
