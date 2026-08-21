// ---------------------------------------------------------------------------
// SofaComboHistoryDialog
//
// Per-combo timeline of effective-dated price changes for a single
// (baseModel, componentSizes, fabricTier, customerId) group. Mirrors the
// MasterPriceHistoryDialog UX: a "Schedule new price change" form on top
// (pre-filled from the most recent row in the group) + a price history
// table below with Past/Active/Pending status badges.
//
// Backed by:
//   POST   /api/sofa-combos                  — new effective-dated rule
//   DELETE /api/sofa-combos/:id              — remove a single row
//
// The parent passes the full list of rows in this combo group; the dialog
// re-derives Active/Pending/Past locally and calls `refresh` after a save
// or delete so the list re-renders from the server.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { humanizeError } from "@/lib/humanize-error";
import { Loader2, Plus, Trash2, X } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { useSofaSeatHeights } from "@/lib/use-sofa-seat-heights";

export type SofaComboHistoryFabricTier = "ANY" | "PRICE_1" | "PRICE_2" | "PRICE_3";
export type SofaComboHistorySizes = string[] | string[][];

export type SofaComboHistoryRule = {
  id: string;
  baseModel: string;
  componentSizes: SofaComboHistorySizes;
  fabricTier: SofaComboHistoryFabricTier;
  pricesByHeight: Record<string, number>;
  customerId: string | null;
  customerName: string | null;
  effectiveFrom: string;
  notes: string;
  createdAt: string;
  createdBy: string | null;
};

// Follows Maintenance → Sofa → Sizes (owner 2026-08-21).

const todayIso = () => new Date().toISOString().slice(0, 10);

const daysUntil = (iso: string): number => {
  const t = new Date(todayIso() + "T00:00:00Z").getTime();
  const d = new Date(iso + "T00:00:00Z").getTime();
  return Math.round((d - t) / 86400000);
};

// Same renderer as the parent pages — kept local so this dialog file
// stays self-contained and doesn't need to reach back into either page.
function renderSofaComboSizes(sizes: SofaComboHistorySizes): string {
  if (!Array.isArray(sizes) || sizes.length === 0) return "—";
  const grouped = Array.isArray(sizes[0]);
  if (!grouped) return (sizes as string[]).join(" + ");
  return (sizes as string[][]).map((g) => g.join(" / ")).join(" + ");
}

// Sort newest-first so the table matches the master-price-history dialog
// (most recent at the top, oldest at the bottom).
function sortByEffectiveDesc(rules: SofaComboHistoryRule[]): SofaComboHistoryRule[] {
  return rules.slice().sort((a, b) => {
    if (a.effectiveFrom !== b.effectiveFrom) {
      return b.effectiveFrom.localeCompare(a.effectiveFrom);
    }
    return b.createdAt.localeCompare(a.createdAt);
  });
}

// Active = newest row with effective_from <= today. Returns the row id
// (or null if every row is Pending).
function findActiveRowId(rules: SofaComboHistoryRule[]): string | null {
  const today = todayIso();
  const sorted = sortByEffectiveDesc(rules);
  for (const r of sorted) {
    if (r.effectiveFrom <= today) return r.id;
  }
  return null;
}

export function SofaComboHistoryDialog({
  rules,
  onClose,
  refresh,
}: {
  rules: SofaComboHistoryRule[];
  onClose: () => void;
  refresh: () => void;
}) {
  const SEAT_HEIGHTS = useSofaSeatHeights();
  // Top-of-group canonical row — the Active one if it exists, otherwise
  // the newest Pending. Used for the dialog header + form pre-fill.
  const { confirm } = useConfirm();
  const sortedRules = useMemo(() => sortByEffectiveDesc(rules), [rules]);
  const seedRule = sortedRules[0] ?? null;

  // Form state — pre-filled on first mount from the most recent row so a
  // "schedule a discount adjustment" workflow is one date-pick + tweak away.
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [notes, setNotes] = useState("");
  const [pricesRm, setPricesRm] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    if (seedRule) {
      for (const h of SEAT_HEIGHTS) {
        const sen = seedRule.pricesByHeight[h];
        if (typeof sen === "number") out[h] = (sen / 100).toFixed(2);
      }
    }
    return out;
  });
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string>("");

  // ESC closes the dialog so it never traps the user.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const activeRowId = useMemo(() => findActiveRowId(rules), [rules]);

  if (!seedRule) return null;

  async function saveScheduled() {
    if (!seedRule) return;
    setErrorMsg("");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      setErrorMsg("Effective From date is required (YYYY-MM-DD).");
      return;
    }
    const pricesByHeight: Record<string, number> = {};
    for (const h of SEAT_HEIGHTS) {
      const raw = (pricesRm[h] ?? "").trim();
      if (!raw) continue;
      const num = Number(raw);
      if (!Number.isFinite(num) || num < 0) {
        setErrorMsg(`Price for height ${h} must be a non-negative number`);
        return;
      }
      pricesByHeight[h] = Math.round(num * 100);
    }
    if (Object.keys(pricesByHeight).length === 0) {
      setErrorMsg("Enter at least one seat-height price");
      return;
    }

    setSaving(true);
    try {
      const body = {
        baseModel: seedRule.baseModel,
        componentSizes: seedRule.componentSizes,
        fabricTier: seedRule.fabricTier,
        pricesByHeight,
        customerId: seedRule.customerId,
        effectiveFrom,
        notes: notes.trim() || null,
      };
      const res = await fetch("/api/sofa-combos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
      };
      if (!res.ok || !j.success) {
        setErrorMsg(humanizeError({ status: res.status, message: j.error }, "Couldn't schedule the change. Please try again."));
        return;
      }
      // Reset note + date so a follow-up edit doesn't accidentally re-post
      // the same fields. Prices stay seeded from this newly-saved row on
      // the next render once `refresh` repopulates the parent's state.
      setNotes("");
      setEffectiveFrom(todayIso());
      refresh();
    } finally {
      setSaving(false);
    }
  }

  async function deleteRow(rowId: string) {
    if (!(await confirm({ title: "Delete history entry", message: "Delete this combo history entry?", danger: true }))) return;
    const res = await fetch(`/api/sofa-combos/${rowId}`, { method: "DELETE" });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErrorMsg(
        humanizeError(
          { status: res.status, message: (j as { error?: string }).error },
          "Couldn't delete. Please try again.",
        ),
      );
      return;
    }
    refresh();
  }

  const customerLabel = seedRule.customerName ?? "Company-wide";
  const headerSubtitle = `${seedRule.baseModel} — ${renderSofaComboSizes(
    seedRule.componentSizes,
  )} — ${seedRule.fabricTier} — ${customerLabel}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl flex flex-col w-[80vw] h-[85vh] max-w-4xl mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
          <div>
            <h2 className="text-lg font-semibold text-[#1F1D1B]">
              Schedule Combo Price Change
            </h2>
            <p className="text-xs text-[#6B7280] mt-0.5">{headerSubtitle}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[#E2DDD8]"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {/* ===== New scheduled change ===== */}
          <section>
            <h3 className="text-sm font-medium text-[#1F1D1B] mb-3">
              New scheduled change
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-[#6B7280] mb-1">
                  Effective from *
                </label>
                <Input
                  type="date"
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                  className="h-8"
                />
                <p className="text-[10px] text-[#9CA3AF] mt-1">
                  Past dates are allowed — backfill historical combo prices or
                  back-date a correction here.
                </p>
              </div>
              <div>
                <label className="block text-xs text-[#6B7280] mb-1">
                  Notes
                </label>
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g. Q3 combo discount"
                  className="h-8"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs text-[#6B7280] mb-2">
                  Combo price by seat height (RM)
                </label>
                <p className="text-[10px] text-[#9CA3AF] mb-2">
                  Pre-filled from the most recent row in this combo. Edit any
                  cell — leave blank to omit that height from the new row.
                </p>
                <div className="grid grid-cols-5 gap-2">
                  {SEAT_HEIGHTS.map((h) => (
                    <div key={h} className="space-y-1">
                      <div className="text-[10px] uppercase tracking-wide text-center text-[#9CA3AF]">
                        {h}&Prime;
                      </div>
                      <Input
                        type="number" onFocus={(e) => e.currentTarget.select()}
                        step="0.01"
                        min="0"
                        placeholder="—"
                        value={pricesRm[h] ?? ""}
                        onChange={(e) =>
                          setPricesRm((prev) => ({
                            ...prev,
                            [h]: e.target.value,
                          }))
                        }
                        className="h-8 text-right"
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
            {errorMsg && (
              <div className="mt-3 rounded-md border border-[#E8B2A1] bg-[#F9E1DA] px-3 py-2 text-sm text-[#9A3A2D]">
                {errorMsg}
              </div>
            )}
            <div className="mt-3 flex justify-end">
              <Button
                variant="primary"
                size="sm"
                onClick={() => void saveScheduled()}
                disabled={saving}
              >
                {saving ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4 mr-1" />
                )}
                Schedule
              </Button>
            </div>
          </section>

          {/* ===== History table ===== */}
          <section>
            <h3 className="text-sm font-medium text-[#1F1D1B] mb-3">
              Price history ({rules.length})
            </h3>
            {rules.length === 0 ? (
              <p className="text-sm text-[#9CA3AF] py-6 text-center">
                No history rows yet.
              </p>
            ) : (<div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[#6B7280]">
                  <tr className="border-b border-[#E2DDD8]">
                    <th className="text-left py-2 px-2">Effective from</th>
                    <th className="text-left py-2 px-2">
                      Prices by seat height
                    </th>
                    <th className="text-left py-2 px-2">Notes</th>
                    <th className="text-right py-2 px-2">Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sortedRules.map((r) => {
                    const today = todayIso();
                    const isPending = r.effectiveFrom > today;
                    const isActive = r.id === activeRowId;
                    const isPast = !isPending && !isActive;
                    const days = daysUntil(r.effectiveFrom);
                    return (
                      <tr key={r.id} className="border-b border-[#F0EEEA]">
                        <td className="py-1.5 px-2 doc-number align-top">
                          {r.effectiveFrom}
                        </td>
                        <td className="py-1.5 px-2 align-top">
                          <table className="text-[10px] tabular-nums border-collapse">
                            <tbody>
                              {SEAT_HEIGHTS.map((hh) => {
                                const v = r.pricesByHeight[hh];
                                return (
                                  <tr key={hh}>
                                    <td className="px-1 py-0 text-[#1F1D1B] font-medium">
                                      {hh}&Prime;
                                    </td>
                                    <td className="px-1 py-0 text-right">
                                      {typeof v === "number" ? (
                                        <span className="text-[#1F1D1B]">
                                          {formatCurrency(v)}
                                        </span>
                                      ) : (
                                        <span className="text-[#D1D5DB]">
                                          —
                                        </span>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </td>
                        <td className="py-1.5 px-2 text-[#6B7280] align-top">
                          {r.notes || "—"}
                        </td>
                        <td className="py-1.5 px-2 text-right align-top">
                          {isPending ? (
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
                          ) : isActive ? (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#EEF3E4] text-[#4F7C3A] border border-[#C6DBA8]">
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#F0ECE9] text-[#6B7280] border border-[#E2DDD8]">
                              Past
                            </span>
                          )}
                          {/* isPast retained for symmetry in case future
                              status badges diverge from the Active styling. */}
                          <span className="hidden">{isPast ? "" : ""}</span>
                        </td>
                        <td className="py-1.5 px-2 text-right align-top">
                          <button
                            onClick={() => void deleteRow(r.id)}
                            className="p-1 rounded text-[#9A3A2D] hover:bg-[#FBE0DC]"
                            title="Delete this entry"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
</div>)}
          </section>
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
