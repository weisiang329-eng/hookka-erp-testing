// Stock PO dialog.
// Lets the factory create a "make-to-stock" production order against a
// placeholder SOH-YYMM-NNN SO when capacity is free and no real customer
// order is queued. Two modes:
//   - WIP: build only a sub-assembly (e.g. a Divan group off a bedframe BOM).
//     Item list is sourced from /historical-wips — distinct wipLabels across
//     every JobCard the factory has ever run.
//   - FG:  build the full finished good (complete pipeline incl. PACKING).
//     Item list is sourced from /historical-fgs — distinct product+size+fabric
//     trios from past POs.
// Only SKUs previously produced show up — this is intentional so we don't
// have to maintain a separate "stockable items" catalog.
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { HistoricalFg, HistoricalWip } from "../types";

export function CreateStockPODialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [type, setType] = useState<"WIP" | "FG">("WIP");
  const [wips, setWips] = useState<HistoricalWip[]>([]);
  const [fgs, setFgs] = useState<HistoricalFg[]>([]);
  const [loadingList, setLoadingList] = useState(false);
  const [search, setSearch] = useState("");
  // Dropdown filters layered on top of the search box. Category ("BEDFRAME"
  // / "SOFA") narrows the pool to one product family; WIP type (Divan / HB /
  // Base / Cushion / Arm, derived from wipType) narrows by component kind;
  // size and fabric match the existing dedup-key fields. Blank = no filter
  // on that axis. Applies to both the WIP and FG panes — FG rows have no
  // wipType so the WIP filter collapses to itemCategory+size+fabric there.
  const [filterCategory, setFilterCategory] = useState<string>("");
  const [filterWipType, setFilterWipType] = useState<string>("");
  const [filterSize, setFilterSize] = useState<string>("");
  const [filterFabric, setFilterFabric] = useState<string>("");
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [quantity, setQuantity] = useState<number>(1);
  const [targetEndDate, setTargetEndDate] = useState<string>(() => {
    // Default: two weeks out. Covers average bedframe/sofa lead time
    // comfortably, but the operator can push it later.
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return d.toISOString().slice(0, 10);
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string>("");

  // Load whichever list is active (WIP or FG) whenever the dialog opens
  // or the Type toggle changes. Keeps the picker data fresh — if the user
  // just created a new PO, its wipLabels should show up on the next open.
  /* eslint-disable react-hooks/set-state-in-effect -- reset filters + fetch the picker list when the dialog opens or type toggles */
  useEffect(() => {
    if (!open) return;
    setSelectedKey("");
    setSearch("");
    setFilterCategory("");
    setFilterWipType("");
    setFilterSize("");
    setFilterFabric("");
    setErr("");
    setLoadingList(true);
    const url = type === "WIP"
      ? "/api/production-orders/historical-wips"
      : "/api/production-orders/historical-fgs";
    fetch(url)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: unknown[] }>)
      .then((d) => {
        if (!d?.success) {
          setWips([]); setFgs([]); setLoadingList(false); return;
        }
        if (type === "WIP") { setWips((d.data || []) as HistoricalWip[]); setFgs([]); }
        else { setFgs((d.data || []) as HistoricalFg[]); setWips([]); }
        setLoadingList(false);
      })
      .catch(() => setLoadingList(false));
  }, [open, type]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Unique value lists used to populate the dropdown filters. Computed off
  // whichever pane (WIP / FG) is active so the options always match what's
  // pickable — e.g. the wipType dropdown is empty on the FG pane since FGs
  // don't carry one.
  const filterOptions = useMemo(() => {
    const cats = new Set<string>();
    const types = new Set<string>();
    const sizes = new Set<string>();
    const fabrics = new Set<string>();
    const source = type === "WIP" ? wips : fgs;
    for (const row of source) {
      const r = row as HistoricalWip & { itemCategory?: string };
      if (r.itemCategory) cats.add(r.itemCategory);
      if ("wipType" in r && r.wipType) types.add(r.wipType);
      if (r.sizeCode) sizes.add(r.sizeCode);
      if (r.fabricCode) fabrics.add(r.fabricCode);
    }
    return {
      categories: [...cats].sort(),
      wipTypes: [...types].sort(),
      sizes: [...sizes].sort(),
      fabrics: [...fabrics].sort(),
    };
  }, [type, wips, fgs]);

  // Filtered list for the picker. Dropdown filters narrow the pool first,
  // then the free-text search runs against the label / product / size /
  // fabric strings so the operator can still type "Divan" or "QN" to hit
  // their target quickly.
  const filteredOptions = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matchFilters = (
      cat: string | undefined,
      wt: string | undefined,
      sz: string,
      fab: string,
    ) =>
      (!filterCategory || cat === filterCategory) &&
      (!filterWipType || wt === filterWipType) &&
      (!filterSize || sz === filterSize) &&
      (!filterFabric || fab === filterFabric);

    if (type === "WIP") {
      const rows = wips
        .filter((w) =>
          matchFilters(w.itemCategory, w.wipType, w.sizeCode, w.fabricCode),
        )
        .map((w) => ({
          key: `${w.sourcePoId}::${w.sourceJcId}`,
          label: w.wipLabel,
          sub: `${w.productName} · ${w.sizeLabel} · ${w.fabricCode || "—"}`,
          ref: w.sourcePoNo,
        }));
      return q
        ? rows.filter((r) =>
            (r.label + " " + r.sub).toLowerCase().includes(q))
        : rows;
    } else {
      const rows = fgs
        .filter((f) =>
          matchFilters(
            (f as HistoricalFg & { itemCategory?: string }).itemCategory,
            undefined,
            f.sizeCode,
            f.fabricCode,
          ),
        )
        .map((f) => ({
          key: f.sourcePoId,
          label: `${f.productCode} — ${f.productName}`,
          sub: `${f.sizeLabel} · ${f.fabricCode || "—"}`,
          ref: f.sourcePoNo,
        }));
      return q
        ? rows.filter((r) =>
            (r.label + " " + r.sub).toLowerCase().includes(q))
        : rows;
    }
  }, [
    type,
    wips,
    fgs,
    search,
    filterCategory,
    filterWipType,
    filterSize,
    filterFabric,
  ]);

  async function handleSubmit() {
    if (!selectedKey) { setErr("Pick an item first."); return; }
    if (!quantity || quantity < 1) { setErr("Quantity must be ≥ 1."); return; }
    if (!targetEndDate) { setErr("Pick a target end date."); return; }

    let body: Record<string, unknown>;
    if (type === "WIP") {
      const [sourcePoId, sourceJcId] = selectedKey.split("::");
      body = { type, sourcePoId, sourceJcId, quantity, targetEndDate };
    } else {
      body = { type, sourcePoId: selectedKey, quantity, targetEndDate };
    }

    setSubmitting(true);
    setErr("");
    try {
      const res = await fetch("/api/production-orders/stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !d?.success) {
        setErr(d?.error || `Failed (${res.status}).`);
        setSubmitting(false);
        return;
      }
      setSubmitting(false);
      onCreated();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Network error");
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-xl w-[640px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
          <div>
            <h2 className="text-lg font-bold text-[#111827]">Create Stock Production Order</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              Uses spare capacity to build against a placeholder SOH- SO.
              When a real order arrives, the SO number is replaced in place.
            </p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {/* Type toggle */}
          <div>
            <label className="text-sm font-medium text-[#111827]">Type</label>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => setType("WIP")}
                className={`flex-1 px-3 py-2 rounded-md border text-sm ${
                  type === "WIP"
                    ? "border-[#6B5C32] bg-[#6B5C32]/10 text-[#6B5C32] font-medium"
                    : "border-[#E2DDD8] text-[#374151] hover:bg-[#FAF9F7]"
                }`}
              >
                WIP <span className="text-[10px] text-gray-500 ml-1">(sub-assembly, e.g. Divan)</span>
              </button>
              <button
                type="button"
                onClick={() => setType("FG")}
                className={`flex-1 px-3 py-2 rounded-md border text-sm ${
                  type === "FG"
                    ? "border-[#6B5C32] bg-[#6B5C32]/10 text-[#6B5C32] font-medium"
                    : "border-[#E2DDD8] text-[#374151] hover:bg-[#FAF9F7]"
                }`}
              >
                FG <span className="text-[10px] text-gray-500 ml-1">(full finished good)</span>
              </button>
            </div>
          </div>

          {/* Item picker */}
          <div>
            <label className="text-sm font-medium text-[#111827]">
              Item {type === "WIP" ? "(historical WIPs)" : "(historical finished goods)"}
            </label>
            <input
              type="text"
              placeholder={`Search ${type === "WIP" ? "WIP label / product / fabric" : "product / size / fabric"}…`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full mt-1 px-3 py-2 text-sm border border-[#E2DDD8] rounded-md bg-[#FAF9F7] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40"
            />
            {/* Dropdown filters — layered on top of the search box. Options
              * come from the current list's own values so the dropdowns only
              * ever show selectable choices. WIP Type hides on the FG pane
              * because FGs don't carry one. */}
            <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
              <select
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
                className="px-2 py-1.5 text-xs border border-[#E2DDD8] rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40"
              >
                <option value="">All Categories</option>
                {filterOptions.categories.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              {type === "WIP" && (
                <select
                  value={filterWipType}
                  onChange={(e) => setFilterWipType(e.target.value)}
                  className="px-2 py-1.5 text-xs border border-[#E2DDD8] rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40"
                >
                  <option value="">All WIP Types</option>
                  {filterOptions.wipTypes.map((t) => (
                    <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
                  ))}
                </select>
              )}
              <select
                value={filterSize}
                onChange={(e) => setFilterSize(e.target.value)}
                className="px-2 py-1.5 text-xs border border-[#E2DDD8] rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40"
              >
                <option value="">All Sizes</option>
                {filterOptions.sizes.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <select
                value={filterFabric}
                onChange={(e) => setFilterFabric(e.target.value)}
                className="px-2 py-1.5 text-xs border border-[#E2DDD8] rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40"
              >
                <option value="">All Fabrics</option>
                {filterOptions.fabrics.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </div>
            <div className="mt-2 max-h-[260px] overflow-y-auto border border-[#E2DDD8] rounded-md divide-y divide-[#E2DDD8]">
              {loadingList ? (
                <div className="px-4 py-6 text-center text-sm text-gray-400">Loading…</div>
              ) : filteredOptions.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-gray-400">
                  {type === "WIP"
                    ? "No WIPs produced yet — create a normal PO first, or switch to FG."
                    : "No finished goods produced yet — create a normal PO first."}
                </div>
              ) : (
                filteredOptions.slice(0, 80).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setSelectedKey(opt.key)}
                    className={`w-full text-left px-3 py-2 transition-colors ${
                      selectedKey === opt.key ? "bg-[#6B5C32]/10" : "hover:bg-[#FAF9F7]"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm font-medium text-[#111827]">{opt.label}</div>
                        <div className="text-xs text-gray-500 mt-0.5">{opt.sub}</div>
                      </div>
                      <div className="text-[10px] text-gray-400">from {opt.ref}</div>
                    </div>
                  </button>
                ))
              )}
            </div>
            {filteredOptions.length > 80 && (
              <p className="text-xs text-gray-400 mt-1">Showing first 80 of {filteredOptions.length}</p>
            )}
          </div>

          {/* Quantity + due date side by side */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium text-[#111827]">Quantity</label>
              <input
                type="number" onFocus={(e) => e.currentTarget.select()}
                min={1}
                value={quantity}
                onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
                className="w-full mt-1 px-3 py-2 text-sm border border-[#E2DDD8] rounded-md focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-[#111827]">Target End Date</label>
              <input
                type="date"
                value={targetEndDate}
                onChange={(e) => setTargetEndDate(e.target.value)}
                className="w-full mt-1 px-3 py-2 text-sm border border-[#E2DDD8] rounded-md focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/40"
              />
            </div>
          </div>

          {err && (
            <div className="px-3 py-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded">
              {err}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[#E2DDD8] flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || !selectedKey}
            className="bg-[#6B5C32] hover:bg-[#574A28] text-white"
          >
            {submitting ? "Creating…" : "Create Stock PO"}
          </Button>
        </div>
      </div>
    </div>
  );
}
