// ---------------------------------------------------------------------------
// MaintenanceItemHistoryDialog
//
// Read-only timeline of one maintenance config item's price across all
// snapshots in maintenance_config_history. Mirrors per-SKU
// MasterPriceHistoryDialog but scoped to a single (listKey, itemValue) tuple
// — e.g. "Bedframe Divan Heights · 12\"".
//
// The caller already owns the full history list (it just fetched it for
// View History), so this dialog re-uses that list rather than re-fetching;
// pass `history` as a prop. We walk every snapshot, pull the priceSen for
// the matching key, and render Past / Active / Pending rows with the same
// status logic as MaintenanceConfigHistoryDialog.
// ---------------------------------------------------------------------------
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import type { MaintenanceHistoryRow } from "./MaintenanceConfigHistoryDialog";

const todayIso = () => new Date().toISOString().slice(0, 10);

const daysUntil = (iso: string): number => {
  const t = new Date(todayIso() + "T00:00:00Z").getTime();
  const d = new Date(iso + "T00:00:00Z").getTime();
  return Math.round((d - t) / 86400000);
};

// Keys of the maintenance config that hold priced lists. Non-priced keys
// (gaps, sofaSizes) don't open this dialog at all — the calendar icon is
// hidden on those rows.
export type PricedItemKey =
  | "divanHeights"
  | "legHeights"
  | "totalHeights"
  | "specials"
  | "sofaLegHeights"
  | "sofaSpecials";

function priceSenForItem(
  config: unknown,
  itemKey: PricedItemKey,
  itemValue: string,
): number | null {
  if (!config || typeof config !== "object") return null;
  const list = (config as Record<string, unknown>)[itemKey];
  if (!Array.isArray(list)) return null;
  for (const e of list) {
    if (
      e &&
      typeof e === "object" &&
      (e as { value?: unknown }).value === itemValue &&
      typeof (e as { priceSen?: unknown }).priceSen === "number"
    ) {
      return (e as { priceSen: number }).priceSen;
    }
  }
  return null;
}

const formatRm = (sen: number) => `RM ${(sen / 100).toFixed(2)}`;

export function MaintenanceItemHistoryDialog({
  open,
  itemKey,
  itemValue,
  itemLabel,
  history,
  onClose,
}: {
  open: boolean;
  itemKey: PricedItemKey;
  itemValue: string;
  /** Tab label shown in the dialog title — e.g. "Bedframe Divan Heights". */
  itemLabel: string;
  history: MaintenanceHistoryRow[];
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  // Pull priceSen out of every snapshot. Snapshots that don't include this
  // item at all are dropped — we can't say what the price "was" if the row
  // didn't exist yet. (Showing "missing" rows would be misleading: it might
  // simply be a snapshot from before the item was added.)
  const today = todayIso();
  type Row = {
    id: string;
    effectiveFrom: string;
    notes: string;
    createdAt: string;
    isPending: boolean;
    priceSen: number;
  };
  const rows: Row[] = [];
  for (const h of history) {
    const sen = priceSenForItem(h.config, itemKey, itemValue);
    if (sen == null) continue;
    rows.push({
      id: h.id,
      effectiveFrom: h.effectiveFrom,
      notes: h.notes,
      createdAt: h.createdAt,
      isPending: h.isPending,
      priceSen: sen,
    });
  }

  // Active = newest non-pending row with effectiveFrom <= today. Mirrors
  // resolver semantics in MaintenanceConfigHistoryDialog.
  let activeId: string | null = null;
  for (const r of rows) {
    if (!r.isPending && r.effectiveFrom <= today) {
      activeId = r.id;
      break;
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl flex flex-col w-[80vw] max-w-2xl mx-4 max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
          <div>
            <h2 className="text-lg font-semibold text-[#1F1D1B]">
              Price history · {itemLabel} · {itemValue}
            </h2>
            <p className="text-xs text-[#6B7280] mt-0.5">
              How this item's surcharge has changed across snapshots.
              Edit the value from the Maintenance tab to schedule a new entry.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[#E2DDD8]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {rows.length === 0 ? (
            <p className="text-sm text-[#9CA3AF] py-6 text-center">
              No history for this item yet. The first snapshot containing
              this row will appear here.
            </p>
          ) : (<div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[#6B7280]">
                <tr className="border-b border-[#E2DDD8]">
                  <th className="text-left py-2 px-2">Effective from</th>
                  <th className="text-right py-2 px-2">RM</th>
                  <th className="text-left py-2 px-2">Status</th>
                  <th className="text-left py-2 px-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const status: "Pending" | "Active" | "Past" = r.isPending
                    ? "Pending"
                    : r.id === activeId
                      ? "Active"
                      : "Past";
                  const days = daysUntil(r.effectiveFrom);
                  return (
                    <tr key={r.id} className="border-b border-[#F0EEEA]">
                      <td className="py-1.5 px-2 doc-number">
                        {r.effectiveFrom}
                      </td>
                      <td className="py-1.5 px-2 text-right tabular-nums font-medium text-[#1F1D1B]">
                        {formatRm(r.priceSen)}
                      </td>
                      <td className="py-1.5 px-2">
                        {status === "Pending" ? (
                          <span
                            className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                              days <= 3
                                ? "bg-[#FBE0DC] text-[#9A3A2D] border-[#E8B2A1]"
                                : days <= 14
                                  ? "bg-[#FBE4CE] text-[#B8601A] border-[#E8B786]"
                                  : "bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597]"
                            }`}
                            title={`Becomes effective on ${r.effectiveFrom}`}
                          >
                            Pending · {days}d
                          </span>
                        ) : status === "Active" ? (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#EEF3E4] text-[#4F7C3A] border border-[#C6DBA8]">
                            Active
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#F4F0E8] text-[#6B7280] border border-[#D4CCB4]">
                            Past
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 px-2 text-[#6B7280]">
                        {r.notes || "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
</div>)}
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2DDD8]">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

