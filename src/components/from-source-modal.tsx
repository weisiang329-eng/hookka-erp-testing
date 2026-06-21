// ---------------------------------------------------------------------------
// FromSourceModal — "From PO / GRN" picker for the PI create page.
//
// Two-tab modal: POs (all recent, prefer un-fully-invoiced) and GRNs
// (prefer POSTED status). Each tab has a search box filtering by doc number
// and supplier name. Selecting a row calls onSelect which the host page uses
// to navigate to /procurement/pi/create?poId=<id> or ?grnId=<id>.
//
// Used from:
//   • src/pages/procurement/pi/create.tsx  — "From PO / GRN" header button
//   • src/pages/procurement/pi.tsx          — header next to "Create Invoice"
// ---------------------------------------------------------------------------
import { useState, useMemo, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCachedJson } from "@/lib/cached-fetch";
import { X, Search, FileText, PackageCheck } from "lucide-react";

// ── Minimal shapes for the list endpoints ────────────────────────────────────
type POListItem = {
  id: string;
  poNo: string;
  supplierId: string;
  supplierName: string;
  status: string;
  orderDate: string;
  totalSen: number;
};

type GRNListItem = {
  id: string;
  grnNumber: string;
  poId: string | null;
  poNumber: string | null;
  supplierId: string;
  supplierName: string;
  status: string;
  receivedDate: string;
  /** Per-line invoicing state returned by GET /api/grn (rowToGRN includes items). */
  items?: { availableQty: number }[];
};

type Tab = "po" | "grn";

export type SourceSelection =
  | { type: "po"; id: string; label: string }
  | { type: "grn"; id: string; label: string };

type Props = {
  open: boolean;
  onClose: () => void;
  /** Called when the user picks a row. Host navigates accordingly. */
  onSelect: (sel: SourceSelection) => void;
};

// Currency formatter (no import of formatCurrency to avoid circular deps)
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
    SENT: "bg-[#EFF6FF] text-[#1D4ED8]",
    APPROVED: "bg-[#F0FDF4] text-[#166534]",
    RECEIVED: "bg-[#F0FDF4] text-[#166534]",
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

export function FromSourceModal({ open, onClose, onSelect }: Props) {
  const [tab, setTab] = useState<Tab>("po");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // Reset query and focus search input when modal opens.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- rising-edge reset on open; same pattern as DashboardLayout.tsx:93
      setQuery("");
      // eslint-disable-next-line no-restricted-syntax -- one-shot focus after paint; no scheduler dep needed for a UI affordance
      setTimeout(() => searchRef.current?.focus(), 60);
    }
  }, [open]);

  // Fetch PO list (shared cache with procurement pages)
  const { data: poResp, loading: poLoading } = useCachedJson<{
    success?: boolean;
    data?: POListItem[];
  }>("/api/purchase-orders");
  const allPOs: POListItem[] = useMemo(
    () => (poResp?.data ?? []) as POListItem[],
    [poResp],
  );

  // Fetch GRN list (shared cache with GRN page)
  const { data: grnResp, loading: grnLoading } = useCachedJson<{
    success?: boolean;
    data?: GRNListItem[];
  }>("/api/grn");
  const allGRNs: GRNListItem[] = useMemo(
    () => (grnResp?.data ?? []) as GRNListItem[],
    [grnResp],
  );

  // Filter logic — search on doc number + supplier name
  const q = query.toLowerCase().trim();

  const filteredPOs = useMemo(() => {
    // CLOSED and CANCELLED are terminal — nothing more can be converted from
    // them. DRAFT POs are not yet confirmed. Exclude all three.
    const base = allPOs.filter(
      (p) =>
        p.status !== "CANCELLED" &&
        p.status !== "DRAFT" &&
        p.status !== "CLOSED",
    );
    if (!q) return base.slice(0, 60); // cap at 60 for render perf
    return base
      .filter(
        (p) =>
          p.poNo.toLowerCase().includes(q) ||
          (p.supplierName ?? "").toLowerCase().includes(q),
      )
      .slice(0, 60);
  }, [allPOs, q]);

  const filteredGRNs = useMemo(() => {
    // Prefer POSTED, but show all non-cancelled so operator can still pick CONFIRMED.
    // Exclude GRNs where every line's availableQty is 0 — nothing left to invoice.
    // GET /api/grn returns items[] with availableQty already computed server-side.
    const base = allGRNs.filter((g) => {
      if (g.status === "CANCELLED") return false;
      // If items are present, hide GRNs that are fully invoiced.
      if (g.items && g.items.length > 0) {
        const hasInvoiceable = g.items.some(
          (i) => (Number(i.availableQty) || 0) > 0,
        );
        if (!hasInvoiceable) return false;
      }
      return true;
    });
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

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-lg shadow-xl w-full max-w-xl mx-4 flex flex-col max-h-[80vh]">
        {/* Modal header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#E2DDD8]">
          <h2 className="text-sm font-semibold text-[#1F1D1B]">
            Import from PO or GRN
          </h2>
          <button
            type="button"
            className="text-[#9CA3AF] hover:text-[#1F1D1B] p-1 rounded"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[#E2DDD8] px-4">
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
        </div>

        {/* Search */}
        <div className="px-4 pt-3 pb-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#9CA3AF]" />
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                tab === "po"
                  ? "Search PO number or supplier..."
                  : "Search GRN number, PO ref, or supplier..."
              }
              className="pl-8 h-8 text-sm"
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {tab === "po" && (
            <>
              {poLoading && (
                <p className="text-xs text-[#9CA3AF] text-center py-8">
                  Loading purchase orders...
                </p>
              )}
              {!poLoading && filteredPOs.length === 0 && (
                <p className="text-xs text-[#9CA3AF] text-center py-8">
                  No purchase orders available to convert. Closed, cancelled, or draft POs are hidden.
                </p>
              )}
              {filteredPOs.map((po) => (
                <button
                  type="button"
                  key={po.id}
                  className="w-full text-left px-3 py-2.5 rounded-md hover:bg-[#FAF9F7] border border-transparent hover:border-[#E2DDD8] transition-colors mb-1 flex items-center justify-between gap-3"
                  onClick={() => {
                    onSelect({
                      type: "po",
                      id: po.id,
                      label: `${po.poNo} — ${po.supplierName}`,
                    });
                    onClose();
                  }}
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

          {tab === "grn" && (
            <>
              {grnLoading && (
                <p className="text-xs text-[#9CA3AF] text-center py-8">
                  Loading goods receipts...
                </p>
              )}
              {!grnLoading && filteredGRNs.length === 0 && (
                <p className="text-xs text-[#9CA3AF] text-center py-8">
                  No goods receipts available to invoice. Fully invoiced and cancelled GRNs are hidden.
                </p>
              )}
              {filteredGRNs.map((g) => (
                <button
                  type="button"
                  key={g.id}
                  className="w-full text-left px-3 py-2.5 rounded-md hover:bg-[#FAF9F7] border border-transparent hover:border-[#E2DDD8] transition-colors mb-1"
                  onClick={() => {
                    onSelect({
                      type: "grn",
                      id: g.id,
                      label: `${g.grnNumber} — ${g.supplierName}`,
                    });
                    onClose();
                  }}
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
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-[#E2DDD8] flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
