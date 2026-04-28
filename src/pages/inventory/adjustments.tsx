// ---------------------------------------------------------------------------
// Stock Adjustments — manual qty corrections for RM / WIP / FG inventory.
//
// Multi-row batch entry: operator adds N rows (one per item to adjust),
// fills each in a single horizontal line, then clicks "Submit All". Each
// row becomes one POST /api/stock-adjustments call (parallelised); the
// page reports per-row success/failure so partial failures stay visible.
//
// Each adjustment is a 4-row atomic write on the backend:
//   1. stock_adjustments         — the adjustment record (who / when / why)
//   2. stock_movements           — audit-ledger entry (physical movement)
//   3. cost_ledger               — financial impact (qty × unitCost, signed)
//   4. UPDATE the parent item    — raw_materials / wip_items / fg_batches
//
// Per user 2026-04-28: form must support unlimited rows + compact per-row
// layout (the prior single-form version made batch entry tedious).
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
import { Plus, Trash2, History, Save } from "lucide-react";

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
  // Bug fix 2026-04-28: surface itemGroup so the Adjustments page can
  // offer a category filter ("show only Wood items"), avoiding a
  // 200-row flat dropdown the user had to scroll through.
  itemGroup?: string;
};
type WipOpt = {
  id: string;
  code: string;
  type: string;
  stockQty: number;
  // Latest dept the WIP completed at (e.g. FAB_CUT). Used as the WIP
  // category filter on the Adjustments page.
  completedBy?: string;
};
type FgBatchOpt = {
  id: string;
  productCode: string;
  productName: string;
  remainingQty: number;
  unitCostSen: number;
  // Product category (BEDFRAME / SOFA / ACCESSORY) for the FG filter.
  category?: string;
};

// ---- Per-row form state. One DraftRow per row in the table; the user
// adds as many as needed before clicking Submit All. ----
type DraftRow = {
  // local-only id so React keys stay stable as rows are added/removed
  uid: string;
  type: AdjustmentType;
  itemId: string;
  // Optional category filter for the Item dropdown: itemGroup for RM,
  // department code for WIP, product category for FG. Empty string =
  // show all items. Added 2026-04-28 because the flat 200-row Item
  // dropdown was painful to navigate without grouping.
  category: string;
  // direction toggle stays per-row so RM-IN, WIP-OUT can sit side by side
  direction: "IN" | "OUT";
  // strings while typing so empty-input doesn't snap to 0
  qty: string;
  unitCost: string;
  reason: AdjustmentReason;
  notes: string;
  // submit-state per row so the user can see "Row 3 failed: not enough stock"
  status: "draft" | "saving" | "saved" | "error";
  errorMsg?: string;
};

const REASON_OPTIONS: { value: AdjustmentReason; label: string }[] = [
  { value: "FOUND", label: "Found" },
  { value: "DAMAGED", label: "Damaged" },
  { value: "COUNT_CORRECTION", label: "Count Corr." },
  { value: "WRITE_OFF", label: "Write-Off" },
  { value: "OTHER", label: "Other" },
];

const TYPE_OPTIONS: AdjustmentType[] = ["RM", "WIP", "FG"];

function newDraftRow(): DraftRow {
  return {
    uid: `r-${Math.random().toString(36).slice(2, 9)}`,
    type: "RM",
    itemId: "",
    category: "",
    direction: "OUT",
    qty: "",
    unitCost: "",
    reason: "COUNT_CORRECTION",
    notes: "",
    status: "draft",
  };
}

function dateLabel(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-MY", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function StockAdjustmentsPage() {
  const { toast } = useToast();
  const user = getCurrentUser();

  const [rows, setRows] = useState<DraftRow[]>([newDraftRow()]);
  const [submitting, setSubmitting] = useState(false);

  // ---- always fetch all 3 lists so any row can switch type freely ----
  // FG comes from /api/inventory's finishedProducts (the product master),
  // not /api/inventory/fg-batches - that endpoint never existed and was
  // returning 404 / empty, leaving the FG dropdown blank. Bug fix
  // 2026-04-28 per user.
  const { data: rmResp } = useCachedJson<{ data?: RawMaterialOpt[] }>("/api/raw-materials");
  const { data: wipResp } = useCachedJson<{ data?: WipOpt[] }>("/api/inventory/wip");
  const { data: invResp } = useCachedJson<{
    data?: { finishedProducts?: Array<{ id: string; code: string; name: string; category: string; stockQty?: number; basePriceSen?: number }> };
  }>("/api/inventory");
  const { data: historyResp, refresh: refreshHistory } = useCachedJson<{
    data?: AdjustmentRow[];
  }>("/api/stock-adjustments");

  const rmList = useMemo(() => rmResp?.data ?? [], [rmResp]);
  const wipList = useMemo(() => wipResp?.data ?? [], [wipResp]);
  const fgList: FgBatchOpt[] = useMemo(
    () => (invResp?.data?.finishedProducts ?? []).map((p) => ({
      id: p.id,
      productCode: p.code,
      productName: p.name,
      remainingQty: p.stockQty ?? 0,
      unitCostSen: p.basePriceSen ?? 0,
      category: p.category,
    })),
    [invResp],
  );
  const history = useMemo(() => historyResp?.data ?? [], [historyResp]);

  // ---- per-row mutators ----
  function patchRow(uid: string, p: Partial<DraftRow>) {
    setRows((prev) => prev.map((r) => (r.uid === uid ? { ...r, ...p } : r)));
  }
  function addRow() {
    setRows((prev) => [...prev, newDraftRow()]);
  }
  function cloneRow(uid: string) {
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.uid === uid);
      if (idx < 0) return prev;
      const clone: DraftRow = {
        ...prev[idx],
        uid: `r-${Math.random().toString(36).slice(2, 9)}`,
        status: "draft",
        errorMsg: undefined,
      };
      return [...prev.slice(0, idx + 1), clone, ...prev.slice(idx + 1)];
    });
  }
  function removeRow(uid: string) {
    setRows((prev) => (prev.length === 1 ? prev : prev.filter((r) => r.uid !== uid)));
  }

  // When the user picks an item, prefill unit cost from that item's record
  // (saves a manual lookup for the common case).
  function onSelectItem(uid: string, itemId: string) {
    const row = rows.find((r) => r.uid === uid);
    if (!row) return;
    let suggestedCost = "";
    if (row.type === "RM") {
      const r = rmList.find((x) => x.id === itemId);
      if (r?.unitCostSen) suggestedCost = String(r.unitCostSen);
    } else if (row.type === "FG") {
      const f = fgList.find((x) => x.id === itemId);
      if (f?.unitCostSen) suggestedCost = String(f.unitCostSen);
    }
    patchRow(uid, {
      itemId,
      unitCost: suggestedCost || row.unitCost,
      status: "draft",
      errorMsg: undefined,
    });
  }

  function onChangeType(uid: string, type: AdjustmentType) {
    // type change invalidates the picked item + category - the category
    // dropdown's options are scoped per type (RM=itemGroup, WIP=dept,
    // FG=category) so a stale "Bedframe" doesn't carry over to a WIP row.
    patchRow(uid, { type, itemId: "", category: "", unitCost: "", status: "draft", errorMsg: undefined });
  }

  // ---- derived per row ----
  function rowSelected(row: DraftRow): {
    code: string;
    name: string;
    qty: number;
    uom: string;
  } | null {
    if (!row.itemId) return null;
    if (row.type === "RM") {
      const r = rmList.find((x) => x.id === row.itemId);
      return r
        ? { code: r.itemCode, name: r.itemName, qty: r.balanceQty, uom: r.balanceQtyUom || "ea" }
        : null;
    }
    if (row.type === "WIP") {
      const w = wipList.find((x) => x.id === row.itemId);
      return w ? { code: w.code, name: w.type, qty: w.stockQty, uom: "pc" } : null;
    }
    const f = fgList.find((x) => x.id === row.itemId);
    return f
      ? { code: f.productCode, name: f.productName, qty: f.remainingQty, uom: "unit" }
      : null;
  }

  function rowSignedDelta(row: DraftRow): number {
    const n = Number(row.qty) || 0;
    return row.direction === "IN" ? Math.abs(n) : -Math.abs(n);
  }
  function rowTotalCost(row: DraftRow): number {
    const n = Number(row.qty) || 0;
    return Math.round(Math.abs(n) * (Number(row.unitCost) || 0));
  }
  function rowReady(row: DraftRow): boolean {
    return !!row.itemId && Number(row.qty) > 0 && !!row.reason;
  }

  // ---- aggregate footer ----
  const readyCount = rows.filter(rowReady).length;
  const totalImpact = rows.reduce((acc, r) => {
    if (!rowReady(r)) return acc;
    const tc = rowTotalCost(r);
    return acc + (r.direction === "IN" ? tc : -tc);
  }, 0);

  // ---- submit all ready rows in parallel; per-row state shows pass/fail ----
  async function handleSubmitAll() {
    const ready = rows.filter(rowReady);
    if (ready.length === 0) {
      toast.warning("No complete rows to submit. Fill item / qty / reason on at least one row.");
      return;
    }
    setSubmitting(true);
    setRows((prev) =>
      prev.map((r) => (rowReady(r) ? { ...r, status: "saving" as const } : r)),
    );
    const results = await Promise.all(
      ready.map(async (row) => {
        const sel = rowSelected(row);
        try {
          const res = await fetch("/api/stock-adjustments", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: row.type,
              itemId: row.itemId,
              qtyDelta: rowSignedDelta(row),
              unitCostSen: Number(row.unitCost) || 0,
              reason: row.reason,
              notes: row.notes || null,
              adjustedBy: user?.id ?? null,
              adjustedByName: user?.displayName ?? user?.email ?? null,
            }),
          });
          const data = (await res.json()) as { success?: boolean; error?: string };
          if (!res.ok || !data?.success) {
            return { uid: row.uid, ok: false, msg: data?.error || `HTTP ${res.status}`, code: sel?.code };
          }
          return { uid: row.uid, ok: true, code: sel?.code };
        } catch (e) {
          return {
            uid: row.uid,
            ok: false,
            msg: e instanceof Error ? e.message : "Network error",
            code: sel?.code,
          };
        }
      }),
    );

    // ---- mark per-row results, then drop the saved rows from the table
    // and replace with a single fresh blank row (so the page is reusable
    // immediately for the next batch). Failed rows STAY so the user can
    // fix and retry.
    const failedUids = new Set(results.filter((r) => !r.ok).map((r) => r.uid));
    setRows((prev) => {
      const surviving = prev.map((r) => {
        if (failedUids.has(r.uid)) {
          const fail = results.find((x) => x.uid === r.uid);
          return { ...r, status: "error" as const, errorMsg: fail?.msg };
        }
        return r;
      });
      const remaining = surviving.filter((r) => !ready.some((rd) => rd.uid === r.uid && r.status !== "error"));
      // If everything passed, leave one blank row; otherwise leave the failures.
      if (remaining.length === 0) return [newDraftRow()];
      return remaining;
    });

    setSubmitting(false);
    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;
    if (okCount && !failCount) toast.success(`Posted ${okCount} adjustment(s)`);
    else if (okCount && failCount) toast.warning(`${okCount} posted · ${failCount} failed (fix the red rows)`);
    else toast.error(`All ${failCount} row(s) failed`);

    invalidateCachePrefix("/api/raw-materials");
    invalidateCachePrefix("/api/inventory");
    invalidateCachePrefix("/api/stock-adjustments");
    refreshHistory();
  }

  // ---- styling shorthands ----
  const sel =
    "w-full rounded border border-[#E2DDD8] bg-white px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-[#1F1D1B]">Stock Adjustments</h1>
        <p className="text-xs text-[#6B7280]">
          Correct on-hand quantities for RM / WIP / FG. Add as many rows as
          needed and submit them in one batch — each row posts its own
          atomic stock + cost-ledger entry.
        </p>
      </div>

      {/* ---------- Multi-row Entry ---------- */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle>New Adjustments ({rows.length})</CardTitle>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={addRow} disabled={submitting}>
                <Plus className="h-3.5 w-3.5" /> Add Row
              </Button>
              <Button
                onClick={handleSubmitAll}
                disabled={submitting || readyCount === 0}
                className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
                size="sm"
              >
                <Save className="h-3.5 w-3.5" />
                {submitting ? "Saving..." : `Submit All (${readyCount})`}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[#E2DDD8] text-left text-[10px] uppercase text-[#6B7280]">
                <th className="py-1.5 px-1 w-[60px]">#</th>
                <th className="py-1.5 px-1 w-[70px]">Type</th>
                <th className="py-1.5 px-1 w-[130px]">Category</th>
                <th className="py-1.5 px-1">Item</th>
                <th className="py-1.5 px-1 w-[80px] text-right">On Hand</th>
                <th className="py-1.5 px-1 w-[90px]">Dir</th>
                <th className="py-1.5 px-1 w-[80px]">Qty</th>
                <th className="py-1.5 px-1 w-[100px]">Unit Cost</th>
                <th className="py-1.5 px-1 w-[110px]">Reason</th>
                <th className="py-1.5 px-1">Notes</th>
                <th className="py-1.5 px-1 w-[90px] text-right">Impact</th>
                <th className="py-1.5 px-1 w-[40px]"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, idx) => {
                const sel_ = rowSelected(row);
                const impact = rowReady(row) ? rowTotalCost(row) : 0;
                const isError = row.status === "error";
                return (
                  <tr
                    key={row.uid}
                    className={`border-b border-[#F0ECE9] ${isError ? "bg-[#FBF3F1]" : ""}`}
                  >
                    <td className="py-1 px-1 text-[10px] text-[#9CA3AF]">{idx + 1}</td>
                    <td className="py-1 px-1">
                      <select
                        value={row.type}
                        onChange={(e) =>
                          onChangeType(row.uid, e.target.value as AdjustmentType)
                        }
                        className={sel}
                        disabled={submitting}
                      >
                        {TYPE_OPTIONS.map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-1 px-1">
                      {/* Category filter - scopes the Item dropdown.
                          RM=itemGroup, WIP=completedBy dept, FG=category. */}
                      <select
                        value={row.category}
                        onChange={(e) => patchRow(row.uid, { category: e.target.value, itemId: "" })}
                        className={sel}
                        disabled={submitting}
                      >
                        <option value="">All</option>
                        {row.type === "RM" &&
                          Array.from(new Set(rmList.map((r) => r.itemGroup).filter((g): g is string => !!g))).sort().map((g) => (
                            <option key={g} value={g}>{g}</option>
                          ))}
                        {row.type === "WIP" &&
                          Array.from(new Set(wipList.map((w) => w.completedBy ?? w.type).filter((g): g is string => !!g))).sort().map((g) => (
                            <option key={g} value={g}>{g}</option>
                          ))}
                        {row.type === "FG" &&
                          ["BEDFRAME", "SOFA", "ACCESSORY"].map((g) => (
                            <option key={g} value={g}>{g[0] + g.slice(1).toLowerCase()}</option>
                          ))}
                      </select>
                    </td>
                    <td className="py-1 px-1">
                      <select
                        value={row.itemId}
                        onChange={(e) => onSelectItem(row.uid, e.target.value)}
                        className={sel}
                        disabled={submitting}
                      >
                        <option value="">Select…</option>
                        {row.type === "RM" &&
                          rmList
                            .filter((r) => !row.category || r.itemGroup === row.category)
                            .map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.itemCode} — {r.itemName}
                              </option>
                            ))}
                        {row.type === "WIP" &&
                          wipList
                            .filter((w) => !row.category || (w.completedBy ?? w.type) === row.category)
                            .map((w) => (
                              <option key={w.id} value={w.id}>
                                {w.code} ({w.type})
                              </option>
                            ))}
                        {row.type === "FG" &&
                          fgList
                            .filter((f) => !row.category || f.category === row.category)
                            .map((f) => (
                              <option key={f.id} value={f.id}>
                                {f.productCode} — {f.productName}
                              </option>
                            ))}
                      </select>
                    </td>
                    <td className="py-1 px-1 text-right font-mono text-[11px] text-[#6B7280]">
                      {sel_ ? `${sel_.qty} ${sel_.uom}` : "—"}
                    </td>
                    <td className="py-1 px-1">
                      <select
                        value={row.direction}
                        onChange={(e) =>
                          patchRow(row.uid, { direction: e.target.value as "IN" | "OUT" })
                        }
                        className={sel}
                        disabled={submitting}
                      >
                        <option value="IN">+ In</option>
                        <option value="OUT">− Out</option>
                      </select>
                    </td>
                    <td className="py-1 px-1">
                      <Input
                        type="number"
                        min="0"
                        step="0.001"
                        value={row.qty}
                        onChange={(e) => patchRow(row.uid, { qty: e.target.value })}
                        placeholder="0"
                        className="h-7 text-xs px-2"
                        disabled={submitting}
                      />
                    </td>
                    <td className="py-1 px-1">
                      <Input
                        type="number"
                        min="0"
                        value={row.unitCost}
                        onChange={(e) => patchRow(row.uid, { unitCost: e.target.value })}
                        placeholder="sen"
                        className="h-7 text-xs px-2"
                        disabled={submitting}
                      />
                    </td>
                    <td className="py-1 px-1">
                      <select
                        value={row.reason}
                        onChange={(e) =>
                          patchRow(row.uid, { reason: e.target.value as AdjustmentReason })
                        }
                        className={sel}
                        disabled={submitting}
                      >
                        {REASON_OPTIONS.map((r) => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className="py-1 px-1">
                      <Input
                        type="text"
                        value={row.notes}
                        onChange={(e) => patchRow(row.uid, { notes: e.target.value })}
                        placeholder="optional"
                        className="h-7 text-xs px-2"
                        disabled={submitting}
                      />
                    </td>
                    <td
                      className={`py-1 px-1 text-right font-mono text-[11px] ${
                        row.direction === "IN" ? "text-[#4F7C3A]" : "text-[#9A3A2D]"
                      }`}
                    >
                      {rowReady(row)
                        ? `${row.direction === "IN" ? "+" : "−"}${formatCurrency(impact)}`
                        : ""}
                    </td>
                    <td className="py-1 px-1 text-right">
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          type="button"
                          onClick={() => cloneRow(row.uid)}
                          disabled={submitting}
                          title="Duplicate row"
                          className="text-[#9CA3AF] hover:text-[#1F1D1B]"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => removeRow(row.uid)}
                          disabled={submitting || rows.length === 1}
                          title="Remove row"
                          className="text-[#9A3A2D] hover:text-[#7A2E24] disabled:text-[#E2DDD8]"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Per-row error messages live below the table so failing rows
              show their reason without bloating the row layout. */}
          {rows.some((r) => r.status === "error") && (
            <div className="mt-3 space-y-1">
              {rows
                .map((r, idx) => ({ r, idx }))
                .filter(({ r }) => r.status === "error")
                .map(({ r, idx }) => (
                  <div
                    key={r.uid}
                    className="text-[11px] text-[#7A2E24] bg-[#FBF3F1] border border-[#E8B2A1] rounded px-3 py-1.5"
                  >
                    Row {idx + 1}: {r.errorMsg ?? "Failed"}
                  </div>
                ))}
            </div>
          )}

          {/* Aggregate footer — total cost impact of all ready rows. */}
          {readyCount > 0 && (
            <div className="mt-3 flex items-center justify-end gap-4 text-xs text-[#6B7280] border-t border-[#E2DDD8] pt-2">
              <span>
                <span className="text-[#9CA3AF]">Ready: </span>
                <span className="font-medium text-[#1F1D1B]">{readyCount}</span> /{" "}
                {rows.length}
              </span>
              <span>
                <span className="text-[#9CA3AF]">Net cost impact: </span>
                <span
                  className={`font-medium ${
                    totalImpact >= 0 ? "text-[#4F7C3A]" : "text-[#9A3A2D]"
                  }`}
                >
                  {totalImpact >= 0 ? "+" : "−"}
                  {formatCurrency(Math.abs(totalImpact))}
                </span>
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------- History ---------- */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <History className="h-4 w-4" /> Adjustment History
            </CardTitle>
            <span className="text-xs text-[#6B7280]">Last {history.length} entries</span>
          </div>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-[#9CA3AF] py-8 text-center">No adjustments yet.</p>
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
                    <tr key={row.id} className="border-b border-[#F0ECE9] hover:bg-[#FAF9F7]">
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
                          {REASON_OPTIONS.find((r) => r.value === row.reason)?.label ??
                            row.reason}
                        </Badge>
                      </td>
                      <td className="py-2 px-2 text-xs text-[#6B7280]">
                        {row.adjustedByName || "—"}
                      </td>
                      <td className="py-2 px-2 text-xs text-[#6B7280]">{row.notes || "—"}</td>
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
