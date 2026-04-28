// ---------------------------------------------------------------------------
// Stock Adjustments — manual qty corrections for RM / WIP / FG inventory.
//
// Form (top) creates a new adjustment; History (bottom) lists the last 500.
// Each submit is a single POST to /api/stock-adjustments which atomically
// posts inventory, audit, and cost-ledger entries. The submit button is
// disabled until type / item / delta / reason are all filled.
// ---------------------------------------------------------------------------
import { useMemo, useState } from "react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { formatCurrency } from "@/lib/utils";
import { getCurrentUser } from "@/lib/auth";
import {
  Plus,
  Minus,
  TrendingUp,
  TrendingDown,
  History,
} from "lucide-react";

type AdjustmentType = "RM" | "WIP" | "FG";
type AdjustmentReason =
  | "FOUND"
  | "DAMAGED"
  | "COUNT_CORRECTION"
  | "WRITE_OFF"
  | "OTHER";

type AdjustmentRow = {
  id: string;
  type: AdjustmentType;
  itemId: string;
  itemCode: string;
  itemName: string;
  qtyDelta: number;
  unitCostSen: number;
  totalCostSen: number;
  direction: "IN" | "OUT";
  reason: AdjustmentReason;
  notes: string;
  adjustedBy: string;
  adjustedByName: string;
  adjustedAt: string;
};

type RawMaterialOpt = {
  id: string;
  itemCode: string;
  itemName: string;
  balanceQty: number;
  balanceQtyUom: string;
  unitCostSen?: number;
};
type WipOpt = {
  id: string;
  code: string;
  type: string;
  stockQty: number;
};
type FgBatchOpt = {
  id: string;
  productCode: string;
  productName: string;
  remainingQty: number;
  unitCostSen: number;
};

const REASON_OPTIONS: { value: AdjustmentReason; label: string; hint: string }[] = [
  { value: "FOUND", label: "Found", hint: "Stock turned up that wasn't on the books" },
  { value: "DAMAGED", label: "Damaged", hint: "Goods damaged in storage / handling" },
  { value: "COUNT_CORRECTION", label: "Count Correction", hint: "Physical count differs from system" },
  { value: "WRITE_OFF", label: "Write-Off", hint: "Removed from books — scrap, expired, lost" },
  { value: "OTHER", label: "Other", hint: "Something else (explain in notes)" },
];

const TYPE_TABS: { key: AdjustmentType; label: string }[] = [
  { key: "RM", label: "Raw Material" },
  { key: "WIP", label: "WIP" },
  { key: "FG", label: "Finished Goods" },
];

function dateLabel(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-MY", {
    year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

export default function StockAdjustmentsPage() {
  const { toast } = useToast();
  const user = getCurrentUser();

  // ---- form state ----
  const [type, setType] = useState<AdjustmentType>("RM");
  const [itemId, setItemId] = useState("");
  const [qtyDelta, setQtyDelta] = useState<string>("");
  const [unitCostSen, setUnitCostSen] = useState<string>("");
  const [reason, setReason] = useState<AdjustmentReason>("COUNT_CORRECTION");
  const [notes, setNotes] = useState("");
  const [direction, setDirection] = useState<"IN" | "OUT">("OUT");
  const [submitting, setSubmitting] = useState(false);

  // ---- data ----
  const { data: rmResp } = useCachedJson<{ data?: RawMaterialOpt[] }>(
    type === "RM" ? "/api/raw-materials" : null,
  );
  const { data: wipResp } = useCachedJson<{ data?: WipOpt[] }>(
    type === "WIP" ? "/api/inventory/wip" : null,
  );
  const { data: fgResp } = useCachedJson<{ data?: FgBatchOpt[] }>(
    type === "FG" ? "/api/inventory/fg-batches" : null,
  );
  const { data: historyResp, refresh: refreshHistory } = useCachedJson<{
    data?: AdjustmentRow[];
  }>("/api/stock-adjustments");

  const rmList = useMemo(() => rmResp?.data ?? [], [rmResp]);
  const wipList = useMemo(() => wipResp?.data ?? [], [wipResp]);
  const fgList = useMemo(() => fgResp?.data ?? [], [fgResp]);
  const history = useMemo(() => historyResp?.data ?? [], [historyResp]);

  // ---- derived: current qty + suggested unit cost for selected item ----
  const selected = useMemo(() => {
    if (!itemId) return null;
    if (type === "RM") {
      const r = rmList.find((x) => x.id === itemId);
      return r ? {
        code: r.itemCode, name: r.itemName, qty: r.balanceQty, uom: r.balanceQtyUom || "ea",
        suggestedCost: r.unitCostSen ?? 0,
      } : null;
    }
    if (type === "WIP") {
      const w = wipList.find((x) => x.id === itemId);
      return w ? {
        code: w.code, name: w.type, qty: w.stockQty, uom: "pc", suggestedCost: 0,
      } : null;
    }
    const f = fgList.find((x) => x.id === itemId);
    return f ? {
      code: f.productCode, name: f.productName, qty: f.remainingQty, uom: "unit",
      suggestedCost: f.unitCostSen,
    } : null;
  }, [itemId, type, rmList, wipList, fgList]);

  // Prefill unit cost when item changes
  function onSelectItem(id: string) {
    setItemId(id);
    if (type === "RM") {
      const r = rmList.find((x) => x.id === id);
      if (r?.unitCostSen) setUnitCostSen(String(r.unitCostSen));
    } else if (type === "FG") {
      const f = fgList.find((x) => x.id === id);
      if (f?.unitCostSen) setUnitCostSen(String(f.unitCostSen));
    }
  }

  function onChangeType(t: AdjustmentType) {
    setType(t);
    setItemId("");
    setUnitCostSen("");
  }

  const qtyNum = Number(qtyDelta) || 0;
  const signedDelta = direction === "IN" ? Math.abs(qtyNum) : -Math.abs(qtyNum);
  const totalCostSen = Math.round(Math.abs(qtyNum) * (Number(unitCostSen) || 0));

  const canSubmit =
    !!itemId && qtyNum !== 0 && !!reason && !submitting;

  async function handleSubmit() {
    if (!canSubmit || !selected) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/stock-adjustments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          itemId,
          qtyDelta: signedDelta,
          unitCostSen: Number(unitCostSen) || 0,
          reason,
          notes: notes || null,
          adjustedBy: user?.id ?? null,
          adjustedByName: user?.displayName ?? user?.email ?? null,
        }),
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !data?.success) {
        toast.error(data?.error || `HTTP ${res.status}`);
        return;
      }
      toast.success(`Adjusted ${selected.code} by ${signedDelta > 0 ? "+" : ""}${signedDelta} ${selected.uom}`);
      // Reset form (keep type so user can do batch adjustments)
      setItemId("");
      setQtyDelta("");
      setUnitCostSen("");
      setNotes("");
      // Invalidate inventory caches so the underlying balances refresh
      invalidateCachePrefix("/api/raw-materials");
      invalidateCachePrefix("/api/inventory");
      invalidateCachePrefix("/api/stock-adjustments");
      refreshHistory();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-[#1F1D1B]">Stock Adjustments</h1>
        <p className="text-xs text-[#6B7280]">
          Correct on-hand quantities for RM / WIP / FG. Each adjustment is
          recorded with reason, by-whom, and the cost impact on stock value.
        </p>
      </div>

      {/* ---------- Adjustment Form ---------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>New Adjustment</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Type tabs */}
          <div className="flex border-b border-[#E2DDD8]">
            {TYPE_TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => onChangeType(t.key)}
                className={`px-4 py-2 text-sm font-medium border-b-2 -mb-[1px] transition-colors ${
                  type === t.key
                    ? "border-[#6B5C32] text-[#6B5C32]"
                    : "border-transparent text-[#6B7280] hover:text-[#1F1D1B]"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Item picker */}
            <div className="lg:col-span-2">
              <label className="block text-sm font-medium text-[#374151] mb-1.5">
                Item *
              </label>
              <select
                value={itemId}
                onChange={(e) => onSelectItem(e.target.value)}
                className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
              >
                <option value="">Select {type === "RM" ? "raw material" : type === "WIP" ? "WIP item" : "FG batch"}...</option>
                {type === "RM" && rmList.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.itemCode} — {r.itemName} (on hand: {r.balanceQty} {r.balanceQtyUom || "ea"})
                  </option>
                ))}
                {type === "WIP" && wipList.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.code} ({w.type}) — on hand: {w.stockQty}
                  </option>
                ))}
                {type === "FG" && fgList.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.productCode} — {f.productName} (batch on hand: {f.remainingQty})
                  </option>
                ))}
              </select>
            </div>

            {/* Current qty display */}
            {selected && (
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">
                  Current On Hand
                </label>
                <div className="rounded-md border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2 text-sm">
                  <span className="font-mono font-bold text-[#1F1D1B]">{selected.qty}</span>{" "}
                  <span className="text-[#6B7280]">{selected.uom}</span>
                </div>
              </div>
            )}

            {/* Direction toggle */}
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1.5">
                Direction *
              </label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant={direction === "IN" ? "primary" : "outline"}
                  size="sm"
                  onClick={() => setDirection("IN")}
                  className="flex-1"
                >
                  <Plus className="h-3.5 w-3.5" /> Add
                </Button>
                <Button
                  type="button"
                  variant={direction === "OUT" ? "primary" : "outline"}
                  size="sm"
                  onClick={() => setDirection("OUT")}
                  className="flex-1"
                >
                  <Minus className="h-3.5 w-3.5" /> Subtract
                </Button>
              </div>
            </div>

            {/* Qty input */}
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1.5">
                Quantity *
              </label>
              <Input
                type="number"
                min="0"
                step="0.001"
                value={qtyDelta}
                onChange={(e) => setQtyDelta(e.target.value)}
                placeholder="0"
              />
            </div>

            {/* Unit cost */}
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1.5">
                Unit Cost (sen) {direction === "OUT" && "—  used for write-off value"}
              </label>
              <Input
                type="number"
                min="0"
                value={unitCostSen}
                onChange={(e) => setUnitCostSen(e.target.value)}
                placeholder="0"
              />
            </div>

            {/* Reason */}
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1.5">
                Reason *
              </label>
              <select
                value={reason}
                onChange={(e) => setReason(e.target.value as AdjustmentReason)}
                className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
              >
                {REASON_OPTIONS.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
              <p className="text-xs text-[#9CA3AF] mt-1">
                {REASON_OPTIONS.find((r) => r.value === reason)?.hint}
              </p>
            </div>

            {/* Notes */}
            <div className="lg:col-span-3">
              <label className="block text-sm font-medium text-[#374151] mb-1.5">
                Notes
              </label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                placeholder="Optional explanation..."
              />
            </div>
          </div>

          {/* Preview line */}
          {selected && qtyNum > 0 && (
            <div className="rounded-md bg-[#FAF9F7] border border-[#E2DDD8] p-3 text-sm flex items-center justify-between">
              <div className="flex items-center gap-3">
                {direction === "IN" ? (
                  <TrendingUp className="h-4 w-4 text-[#4F7C3A]" />
                ) : (
                  <TrendingDown className="h-4 w-4 text-[#9A3A2D]" />
                )}
                <span className="text-[#6B7280]">After:</span>
                <span className="font-mono font-bold text-[#1F1D1B]">
                  {selected.qty + signedDelta} {selected.uom}
                </span>
                <span className="text-[#6B7280]">
                  ({signedDelta > 0 ? "+" : ""}
                  {signedDelta} from {selected.qty})
                </span>
              </div>
              <div className="text-[#6B7280]">
                Cost impact:{" "}
                <span className="font-medium text-[#1F1D1B]">
                  {direction === "IN" ? "+" : "−"}
                  {formatCurrency(totalCostSen)}
                </span>
              </div>
            </div>
          )}

          <div className="flex justify-end">
            <Button
              variant="primary"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
            >
              {submitting ? "Saving..." : "Submit Adjustment"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ---------- History ---------- */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <History className="h-4 w-4" /> Adjustment History
            </CardTitle>
            <span className="text-xs text-[#6B7280]">
              Last {history.length} entries
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-[#9CA3AF] py-8 text-center">
              No adjustments yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#E2DDD8] text-left text-xs uppercase text-[#6B7280]">
                    <th className="py-2 px-2">Date</th>
                    <th className="py-2 px-2">Type</th>
                    <th className="py-2 px-2">Item</th>
                    <th className="py-2 px-2 text-right">Δ</th>
                    <th className="py-2 px-2 text-right">Cost Impact</th>
                    <th className="py-2 px-2">Reason</th>
                    <th className="py-2 px-2">By</th>
                    <th className="py-2 px-2">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b border-[#F0ECE9] hover:bg-[#FAF9F7]"
                    >
                      <td className="py-2 px-2 whitespace-nowrap text-xs">
                        {dateLabel(row.adjustedAt)}
                      </td>
                      <td className="py-2 px-2">
                        <Badge>{row.type}</Badge>
                      </td>
                      <td className="py-2 px-2">
                        <div className="font-mono text-xs font-medium text-[#1F1D1B]">
                          {row.itemCode}
                        </div>
                        <div className="text-xs text-[#9CA3AF]">{row.itemName}</div>
                      </td>
                      <td
                        className={`py-2 px-2 text-right font-mono ${
                          row.direction === "IN" ? "text-[#4F7C3A]" : "text-[#9A3A2D]"
                        }`}
                      >
                        {row.direction === "IN" ? "+" : ""}
                        {row.qtyDelta}
                      </td>
                      <td
                        className={`py-2 px-2 text-right amount ${
                          row.direction === "IN" ? "text-[#4F7C3A]" : "text-[#9A3A2D]"
                        }`}
                      >
                        {row.direction === "IN" ? "+" : "−"}
                        {formatCurrency(row.totalCostSen)}
                      </td>
                      <td className="py-2 px-2">
                        <Badge>
                          {REASON_OPTIONS.find((r) => r.value === row.reason)?.label ?? row.reason}
                        </Badge>
                      </td>
                      <td className="py-2 px-2 text-xs text-[#6B7280]">
                        {row.adjustedByName || "—"}
                      </td>
                      <td className="py-2 px-2 text-xs text-[#6B7280]">
                        {row.notes || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
