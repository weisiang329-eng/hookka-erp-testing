// ---------------------------------------------------------------------------
// MasterPriceHistoryDialog
//
// Schedule effective-dated master price changes for a single product.
// Backed by `product_prices` (migration 0066). Each save POSTs a row to
// /api/products/:id/prices; the resolver picks the newest row whose
// effectiveFrom <= today as the live master price.
//
// The dialog is intentionally a thin layer on top of three endpoints:
//   GET    /api/products/:id/price-history
//   POST   /api/products/:id/prices
//   DELETE /api/products/price-row/:id
// ---------------------------------------------------------------------------
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Plus, Trash2, X } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

type SeatHeightTier = {
  height: string;
  priceSen: number;
  // Optional fabric tier that matches fabric_tracking.priceTier so a sofa
  // line in CS Order can resolve its price by direct lookup once Phase 3c
  // ships. Legacy entries without a tier are treated as PRICE_2 by every
  // reader.
  tier?: "PRICE_1" | "PRICE_2" | "PRICE_3";
};

type PriceHistoryRow = {
  id: string;
  basePriceSen: number | null;
  price1Sen: number | null;
  seatHeightPrices: SeatHeightTier[];
  effectiveFrom: string;
  notes: string;
  createdAt: string;
};

type ProductLite = {
  id: string;
  code: string;
  name: string;
  category: string;
  basePriceSen?: number | null;
  price1Sen?: number | null;
  seatHeightPrices?: SeatHeightTier[];
};

const todayIso = () => new Date().toISOString().slice(0, 10);

const daysUntil = (iso: string): number => {
  const t = new Date(todayIso() + "T00:00:00Z").getTime();
  const d = new Date(iso + "T00:00:00Z").getTime();
  return Math.round((d - t) / 86400000);
};

export function MasterPriceHistoryDialog({
  product,
  onClose,
  onSaved,
}: {
  product: ProductLite | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [history, setHistory] = useState<PriceHistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Form fields. Defaults seeded from the product's current price columns
  // so a "schedule a price hike" workflow is one date-pick + edit away.
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [baseRm, setBaseRm] = useState("");
  const [price1Rm, setPrice1Rm] = useState("");
  const [seatJson, setSeatJson] = useState("");
  const [notes, setNotes] = useState("");

  const isSofa = product?.category === "SOFA";

  // Reset the form whenever a different product is opened. State is
  // user-editable while the dialog is open so we can't derive these from
  // props — a one-shot sync on the product transition is the simplest
  // way to keep the inputs aligned with the freshly opened SKU.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!product) return;
    setEffectiveFrom(todayIso());
    setBaseRm(
      product.basePriceSen != null
        ? (product.basePriceSen / 100).toFixed(2)
        : "",
    );
    setPrice1Rm(
      product.price1Sen != null ? (product.price1Sen / 100).toFixed(2) : "",
    );
    setSeatJson(
      product.seatHeightPrices && product.seatHeightPrices.length > 0
        ? JSON.stringify(product.seatHeightPrices)
        : "",
    );
    setNotes("");
    void loadHistory(product.id);
  }, [product]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ESC closes the dialog so it never traps the user.
  useEffect(() => {
    if (!product) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [product, onClose]);

  async function loadHistory(productId: string) {
    setLoading(true);
    try {
      const res = await fetch(`/api/products/${productId}/price-history`);
      const j = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        data?: PriceHistoryRow[];
      };
      setHistory(j.success ? (j.data ?? []) : []);
    } finally {
      setLoading(false);
    }
  }

  async function saveScheduled() {
    if (!product) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      alert("Effective From date is required (YYYY-MM-DD).");
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = { effectiveFrom };
      if (baseRm !== "") body.basePriceSen = Math.round(Number(baseRm) * 100);
      else body.basePriceSen = null;
      if (price1Rm !== "")
        body.price1Sen = Math.round(Number(price1Rm) * 100);
      else body.price1Sen = null;
      if (seatJson.trim()) {
        try {
          body.seatHeightPrices = JSON.parse(seatJson);
        } catch {
          alert(
            'Seat-height prices must be valid JSON (e.g. [{"height":"24","priceSen":51700}]).',
          );
          return;
        }
      } else {
        body.seatHeightPrices = null;
      }
      body.notes = notes || null;

      const res = await fetch(`/api/products/${product.id}/prices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        alert(
          (j as { error?: string }).error ??
            `Failed to schedule price change (HTTP ${res.status})`,
        );
        return;
      }
      await loadHistory(product.id);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  async function deleteRow(rowId: string) {
    if (!product) return;
    if (!confirm("Delete this price history entry?")) return;
    const res = await fetch(`/api/products/price-row/${rowId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      alert(
        (j as { error?: string }).error ??
          `Failed to delete (HTTP ${res.status})`,
      );
      return;
    }
    await loadHistory(product.id);
    onSaved();
  }

  if (!product) return null;

  const today = todayIso();

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
              Schedule Price Change
            </h2>
            <p className="text-xs text-[#6B7280] mt-0.5">
              {product.code} — {product.name}
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
                  Past dates are allowed — backfill historical prices or
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
                  placeholder="e.g. Q3 price hike"
                  className="h-8"
                />
              </div>
              {!isSofa && (
                <>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">
                      Base price (RM)
                    </label>
                    <Input
                      type="number"
                      step="0.01"
                      value={baseRm}
                      onChange={(e) => setBaseRm(e.target.value)}
                      className="h-8 text-right"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">
                      Price 1 (RM)
                    </label>
                    <Input
                      type="number"
                      step="0.01"
                      value={price1Rm}
                      onChange={(e) => setPrice1Rm(e.target.value)}
                      className="h-8 text-right"
                    />
                  </div>
                </>
              )}
              {isSofa && (
                <div className="sm:col-span-2">
                  <label className="block text-xs text-[#6B7280] mb-1">
                    Seat-height prices (JSON)
                  </label>
                  <textarea
                    value={seatJson}
                    onChange={(e) => setSeatJson(e.target.value)}
                    rows={3}
                    className="w-full text-xs font-mono border border-[#E2DDD8] rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20"
                    placeholder='[{"height":"24","priceSen":51700},{"height":"28","priceSen":56000}]'
                  />
                </div>
              )}
            </div>
            <div className="mt-3 flex justify-end">
              <Button
                variant="primary"
                size="sm"
                onClick={saveScheduled}
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
              Price history ({history.length})
            </h3>
            {loading ? (
              <p className="text-sm text-[#9CA3AF] py-6 text-center">
                Loading…
              </p>
            ) : history.length === 0 ? (
              <p className="text-sm text-[#9CA3AF] py-6 text-center">
                No scheduled or past price changes yet. The current displayed
                price comes from the product master record.
              </p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-[#6B7280]">
                  <tr className="border-b border-[#E2DDD8]">
                    <th className="text-left py-2 px-2">Effective from</th>
                    <th className="text-right py-2 px-2">Base</th>
                    <th className="text-right py-2 px-2">Price 1</th>
                    <th className="text-left py-2 px-2">Seat tiers</th>
                    <th className="text-left py-2 px-2">Notes</th>
                    <th className="text-right py-2 px-2">Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => {
                    const pending = h.effectiveFrom > today;
                    const days = daysUntil(h.effectiveFrom);
                    return (
                      <tr key={h.id} className="border-b border-[#F0EEEA]">
                        <td className="py-1.5 px-2 doc-number">
                          {h.effectiveFrom}
                        </td>
                        <td className="py-1.5 px-2 text-right tabular-nums">
                          {h.basePriceSen != null
                            ? formatCurrency(h.basePriceSen)
                            : "—"}
                        </td>
                        <td className="py-1.5 px-2 text-right tabular-nums">
                          {h.price1Sen != null
                            ? formatCurrency(h.price1Sen)
                            : "—"}
                        </td>
                        <td className="py-1.5 px-2 text-[#6B7280]">
                          {h.seatHeightPrices.length > 0
                            ? h.seatHeightPrices
                                .map(
                                  (t) =>
                                    `${t.height}":${(t.priceSen / 100).toFixed(0)}`,
                                )
                                .join(" ")
                            : "—"}
                        </td>
                        <td className="py-1.5 px-2 text-[#6B7280]">
                          {h.notes || "—"}
                        </td>
                        <td className="py-1.5 px-2 text-right">
                          {pending ? (
                            <span
                              className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                                days <= 3
                                  ? "bg-[#FBE0DC] text-[#9A3A2D] border-[#E8B2A1]"
                                  : days <= 14
                                    ? "bg-[#FBE4CE] text-[#B8601A] border-[#E8B786]"
                                    : "bg-[#F4F0E8] text-[#6B5C32] border-[#D4CCB4]"
                              }`}
                              title={`Becomes effective on ${h.effectiveFrom}`}
                            >
                              Pending · {days}d
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#E0EDF0] text-[#3E6570] border border-[#B8D0D5]">
                              Active
                            </span>
                          )}
                        </td>
                        <td className="py-1.5 px-2 text-right">
                          <button
                            onClick={() => deleteRow(h.id)}
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
            )}
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
