// ---------------------------------------------------------------------------
// ConvertToPIModal — line-pick "Convert from PO / Goods Receipt" picker for
// the Purchase Invoice create page.
//
// Two source tabs, each a two-step pick:
//   GRN tab (primary) — pick a Goods Receipt, then its lines with per-line
//            `availableQty` (= acceptedQty − invoiced_qty). Each picked line
//            carries its `grnItemId` so the PI POST increments invoiced_qty
//            and the backend's line-level guard fires. Fully-invoiced lines
//            are skipped.
//   PO tab  — pick a Purchase Order, then its lines with `availableQty`
//            (= quantity − receivedQty). PO-source lines do NOT carry a
//            grnItemId (the PI links to the PO for lineage only).
//
// Single-source by design (one GRN or one PO per PI). Multi-source
// consolidation into one PI is a follow-up — see the create page note.
//
// Used from:
//   • src/pages/procurement/pi/create.tsx  — "Convert from Goods Receipt" btn
// ---------------------------------------------------------------------------
import { useState, useMemo, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCachedJson } from "@/lib/cached-fetch";
import { X, Search, FileText, PackageCheck, ArrowLeft } from "lucide-react";

// ── List shapes ─────────────────────────────────────────────────────────────
type POListItem = {
  id: string;
  poNo: string;
  supplierName: string;
  status: string;
  orderDate: string;
  totalSen: number;
};
type GRNListItem = {
  id: string;
  grnNumber: string;
  poNumber: string | null;
  supplierName: string;
  status: string;
  receivedDate: string;
};

// ── Detail shapes ───────────────────────────────────────────────────────────
type PODetailLine = {
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
  items: PODetailLine[];
};
type GRNDetailLine = {
  id: string; // grn_items row id == grnItemId
  materialCode: string;
  materialName: string;
  acceptedQty: number;
  invoicedQty: number;
  availableQty: number;
  unitPrice: number; // sen
};
type GRNDetail = {
  id: string;
  grnNumber: string;
  poId: string | null;
  supplierId: string;
  supplierName: string;
  items: GRNDetailLine[];
};

// ── Result shape ────────────────────────────────────────────────────────────
export type PickedPILine = {
  materialCode: string;
  materialName: string;
  supplierSku: string;
  qty: number;
  unitPriceRM: number;
  /** Present ONLY for GRN-source lines. Drives invoiced_qty + line guard. */
  grnItemId: string | null;
};

export type ConvertToPIResult = {
  source: "po" | "grn";
  /** Set for GRN source — POSTed as body.grnId. */
  grnId: string | null;
  /** Set for PO source (or the GRN's parent PO) — POSTed for lineage. */
  purchaseOrderId: string | null;
  docLabel: string;
  supplierId: string;
  supplierName: string;
  lines: PickedPILine[];
};

type Tab = "grn" | "po";

type Props = {
  open: boolean;
  onClose: () => void;
  onConfirm: (res: ConvertToPIResult) => void;
};

function fmtRM(sen: number) {
  return (sen / 100).toLocaleString("en-MY", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function statusBadge(status: string) {
  const colorMap: Record<string, string> = {
    DRAFT: "bg-[#F3F0EB] text-[#6B7280]",
    CONFIRMED: "bg-[#EFF6FF] text-[#1D4ED8]",
    POSTED: "bg-[#F0FDF4] text-[#166534]",
    RECEIVED: "bg-[#F0FDF4] text-[#166534]",
    PARTIAL_RECEIVED: "bg-[#FFFBEB] text-[#92400E]",
    PARTIAL: "bg-[#FFFBEB] text-[#92400E]",
    CANCELLED: "bg-[#FEF2F2] text-[#9A3A2D]",
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

export function ConvertToPIModal({ open, onClose, onConfirm }: Props) {
  const [tab, setTab] = useState<Tab>("grn");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Step-2 selection (one of these set once a doc is chosen).
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Per-line pick state — keyed by source-line id.
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [qty, setQty] = useState<Record<string, number>>({});

  // Lazy-fetched detail for step 2.
  const [poDetail, setPoDetail] = useState<PODetail | null>(null);
  const [grnDetail, setGrnDetail] = useState<GRNDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Reset on open.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- rising-edge reset on open
      setQuery("");
      setSelectedId(null);
      setPoDetail(null);
      setGrnDetail(null);
      setChecked({});
      setQty({});
      // eslint-disable-next-line no-restricted-syntax -- one-shot focus after paint
      setTimeout(() => searchRef.current?.focus(), 60);
    }
  }, [open]);

  // Lists (shared cache).
  const { data: poResp, loading: poLoading } = useCachedJson<{
    success?: boolean;
    data?: POListItem[];
  }>("/api/purchase-orders");
  const allPOs: POListItem[] = useMemo(
    () => (poResp?.data ?? []) as POListItem[],
    [poResp],
  );

  const { data: grnResp, loading: grnLoading } = useCachedJson<{
    success?: boolean;
    data?: GRNListItem[];
  }>("/api/grn");
  const allGRNs: GRNListItem[] = useMemo(
    () => (grnResp?.data ?? []) as GRNListItem[],
    [grnResp],
  );

  const q = query.toLowerCase().trim();

  const filteredPOs = useMemo(() => {
    const base = allPOs.filter(
      (p) => p.status !== "CANCELLED" && p.status !== "DRAFT",
    );
    if (!q) return base.slice(0, 60);
    return base
      .filter(
        (p) =>
          p.poNo.toLowerCase().includes(q) ||
          (p.supplierName ?? "").toLowerCase().includes(q),
      )
      .slice(0, 60);
  }, [allPOs, q]);

  const filteredGRNs = useMemo(() => {
    const base = allGRNs.filter((g) => g.status !== "CANCELLED");
    const sorted = [
      ...base.filter((g) => g.status === "POSTED"),
      ...base.filter((g) => g.status !== "POSTED"),
    ];
    if (!q) return sorted.slice(0, 60);
    return sorted
      .filter(
        (g) =>
          g.grnNumber.toLowerCase().includes(q) ||
          (g.supplierName ?? "").toLowerCase().includes(q) ||
          (g.poNumber ?? "").toLowerCase().includes(q),
      )
      .slice(0, 60);
  }, [allGRNs, q]);

  // Fetch detail when a doc is chosen; seed qty to availableQty.
  useEffect(() => {
    if (!selectedId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear on deselect
      setPoDetail(null);
      setGrnDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    const url =
      tab === "grn"
        ? `/api/grn/${selectedId}`
        : `/api/purchase-orders/${selectedId}`;
    fetch(url)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const nextChecked: Record<string, boolean> = {};
        const nextQty: Record<string, number> = {};
        if (tab === "grn") {
          const resp = j as { success?: boolean; data?: GRNDetail };
          const grn = resp.data ?? null;
          setGrnDetail(grn);
          for (const line of grn?.items ?? []) {
            const avail = Number(line.availableQty) || 0;
            nextChecked[line.id] = avail > 0;
            nextQty[line.id] = avail;
          }
        } else {
          const resp = j as { success?: boolean; data?: PODetail };
          const po = resp.data ?? null;
          setPoDetail(po);
          for (const line of po?.items ?? []) {
            const avail = Number(line.availableQty) || 0;
            nextChecked[line.id] = avail > 0;
            nextQty[line.id] = avail;
          }
        }
        setChecked(nextChecked);
        setQty(nextQty);
      })
      .catch(() => {
        if (!cancelled) {
          setPoDetail(null);
          setGrnDetail(null);
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, tab]);

  // Normalised line view for step 2 rendering.
  type RowView = {
    id: string;
    name: string;
    sub: string;
    avail: number;
    unit: string;
  };
  const rows: RowView[] = useMemo(() => {
    if (tab === "grn") {
      return (grnDetail?.items ?? []).map((l) => ({
        id: l.id,
        name: l.materialName,
        sub: l.materialCode || "",
        avail: Number(l.availableQty) || 0,
        unit: "",
      }));
    }
    return (poDetail?.items ?? []).map((l) => ({
      id: l.id,
      name: l.materialName,
      sub: l.supplierSKU || l.materialCode || "",
      avail: Number(l.availableQty) || 0,
      unit: l.unit ?? "",
    }));
  }, [tab, grnDetail, poDetail]);

  const selectedCount = rows.filter(
    (r) => checked[r.id] && (Number(qty[r.id]) || 0) > 0,
  ).length;
  const hasOver = rows.some(
    (r) => checked[r.id] && (Number(qty[r.id]) || 0) > r.avail,
  );

  const docTitle =
    tab === "grn" ? grnDetail?.grnNumber : poDetail?.poNo;

  const handleConfirm = () => {
    if (tab === "grn") {
      if (!grnDetail) return;
      const lines: PickedPILine[] = [];
      for (const l of grnDetail.items) {
        if (!checked[l.id]) continue;
        const want = Number(qty[l.id]) || 0;
        if (want <= 0) continue;
        lines.push({
          materialCode: l.materialCode ?? "",
          materialName: l.materialName,
          supplierSku: l.materialCode ?? "",
          qty: want,
          unitPriceRM: (Number(l.unitPrice) || 0) / 100,
          grnItemId: l.id,
        });
      }
      if (lines.length === 0) return;
      onConfirm({
        source: "grn",
        grnId: grnDetail.id,
        purchaseOrderId: grnDetail.poId ?? null,
        docLabel: grnDetail.grnNumber,
        supplierId: grnDetail.supplierId,
        supplierName: grnDetail.supplierName,
        lines,
      });
      onClose();
    } else {
      if (!poDetail) return;
      const lines: PickedPILine[] = [];
      for (const l of poDetail.items) {
        if (!checked[l.id]) continue;
        const want = Number(qty[l.id]) || 0;
        if (want <= 0) continue;
        lines.push({
          materialCode: l.materialCode ?? "",
          materialName: l.materialName,
          supplierSku: l.supplierSKU ?? "",
          qty: want,
          unitPriceRM: (Number(l.unitPriceSen) || 0) / 100,
          grnItemId: null,
        });
      }
      if (lines.length === 0) return;
      onConfirm({
        source: "po",
        grnId: null,
        purchaseOrderId: poDetail.id,
        docLabel: poDetail.poNo,
        supplierId: poDetail.supplierId,
        supplierName: poDetail.supplierName,
        lines,
      });
      onClose();
    }
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
            {selectedId && (
              <button
                type="button"
                className="text-[#9CA3AF] hover:text-[#1F1D1B] p-1 rounded"
                onClick={() => setSelectedId(null)}
                title="Back to list"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <h2 className="text-sm font-semibold text-[#1F1D1B]">
              {selectedId
                ? `Select lines — ${docTitle ?? "Loading…"}`
                : "Convert from PO / Goods Receipt"}
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

        {/* STEP 1 — tabs + list */}
        {!selectedId && (
          <>
            <div className="flex border-b border-[#E2DDD8] px-4">
              <button
                type="button"
                className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                  tab === "grn"
                    ? "border-[#6B5C32] text-[#6B5C32]"
                    : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
                }`}
                onClick={() => {
                  setTab("grn");
                  setQuery("");
                }}
              >
                <PackageCheck className="h-3.5 w-3.5" />
                Goods Receipts (GRN)
              </button>
              <button
                type="button"
                className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition-colors ${
                  tab === "po"
                    ? "border-[#6B5C32] text-[#6B5C32]"
                    : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
                }`}
                onClick={() => {
                  setTab("po");
                  setQuery("");
                }}
              >
                <FileText className="h-3.5 w-3.5" />
                Purchase Orders
              </button>
            </div>

            <div className="px-4 pt-3 pb-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#9CA3AF]" />
                <Input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={
                    tab === "grn"
                      ? "Search GRN number, PO ref, or supplier..."
                      : "Search PO number or supplier..."
                  }
                  className="pl-8 h-8 text-sm"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-2 pb-3">
              {tab === "grn" && (
                <>
                  {grnLoading && (
                    <p className="text-xs text-[#9CA3AF] text-center py-8">
                      Loading goods receipts...
                    </p>
                  )}
                  {!grnLoading && filteredGRNs.length === 0 && (
                    <p className="text-xs text-[#9CA3AF] text-center py-8">
                      No goods receipts found
                    </p>
                  )}
                  {filteredGRNs.map((g) => (
                    <button
                      type="button"
                      key={g.id}
                      className="w-full text-left px-3 py-2.5 rounded-md hover:bg-[#FAF9F7] border border-transparent hover:border-[#E2DDD8] transition-colors mb-1"
                      onClick={() => setSelectedId(g.id)}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-medium text-[#1F1D1B]">
                          {g.grnNumber}
                        </span>
                        {statusBadge(g.status)}
                      </div>
                      <p className="text-xs text-[#6B7280] truncate mt-0.5">
                        {g.supplierName}
                        {g.poNumber ? ` · PO: ${g.poNumber}` : ""}
                        {g.receivedDate ? ` · ${g.receivedDate}` : ""}
                      </p>
                    </button>
                  ))}
                </>
              )}

              {tab === "po" && (
                <>
                  {poLoading && (
                    <p className="text-xs text-[#9CA3AF] text-center py-8">
                      Loading purchase orders...
                    </p>
                  )}
                  {!poLoading && filteredPOs.length === 0 && (
                    <p className="text-xs text-[#9CA3AF] text-center py-8">
                      No purchase orders found
                    </p>
                  )}
                  {filteredPOs.map((po) => (
                    <button
                      type="button"
                      key={po.id}
                      className="w-full text-left px-3 py-2.5 rounded-md hover:bg-[#FAF9F7] border border-transparent hover:border-[#E2DDD8] transition-colors mb-1 flex items-center justify-between gap-3"
                      onClick={() => setSelectedId(po.id)}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
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
                </>
              )}
            </div>
          </>
        )}

        {/* STEP 2 — line picker */}
        {selectedId && (
          <>
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {detailLoading && (
                <p className="text-xs text-[#9CA3AF] text-center py-8">
                  Loading lines...
                </p>
              )}
              {!detailLoading && rows.length === 0 && (
                <p className="text-xs text-[#9CA3AF] text-center py-8">
                  No lines available to invoice.
                </p>
              )}
              {!detailLoading && rows.length > 0 && (
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
                        Invoice Qty
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => {
                      const fullyInvoiced = row.avail <= 0;
                      const want = Number(qty[row.id]) || 0;
                      const over = want > row.avail;
                      return (
                        <tr
                          key={row.id}
                          className={`border-t border-[#E2DDD8] ${
                            fullyInvoiced ? "opacity-50" : "hover:bg-[#FAF9F7]"
                          }`}
                        >
                          <td className="px-2 py-2 text-center">
                            <input
                              type="checkbox"
                              disabled={fullyInvoiced}
                              checked={!!checked[row.id]}
                              onChange={(e) =>
                                setChecked((prev) => ({
                                  ...prev,
                                  [row.id]: e.target.checked,
                                }))
                              }
                              className="h-4 w-4 accent-[#6B5C32] cursor-pointer disabled:cursor-not-allowed"
                            />
                          </td>
                          <td className="px-2 py-2">
                            <div className="font-medium text-[#1F1D1B]">
                              {row.name}
                            </div>
                            {row.sub && (
                              <div className="text-xs text-[#9CA3AF]">
                                {row.sub}
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-2 text-right">
                            <div className="text-[#374151]">
                              {row.avail} {row.unit}
                            </div>
                            {fullyInvoiced && (
                              <div className="text-[10px] text-[#6B5C32]">
                                fully invoiced
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-2 text-right">
                            <Input
                              type="number"
                              min={0}
                              max={row.avail}
                              disabled={fullyInvoiced || !checked[row.id]}
                              onFocus={(e) => e.currentTarget.select()}
                              value={want}
                              onChange={(e) =>
                                setQty((prev) => ({
                                  ...prev,
                                  [row.id]: Number(e.target.value),
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
                  disabled={selectedCount === 0 || hasOver}
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
