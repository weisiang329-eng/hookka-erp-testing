// ---------------------------------------------------------------------------
// RepairScopePicker — the per-line Repair Scope editor for service orders,
// shared by the create page (new SO) and the edit page (#18: change the
// repair department before production). Both pages MUST use the same picker
// so an edit can't drift from a create — the picker is the single UI source
// of truth, the same way src/lib/repair-scope.ts is the single data source
// of truth for the stored JSON.
//
// Reads the RAW stored JSON for the controls (so a Custom pick with zero
// depts ticked yet doesn't snap back to Full) and the LENIENT parse for the
// badge (only a valid, non-FULL scope earns one). Writes back through
// onUpdate(idx, { repairScope }) — exactly the shape both pages' updateItem
// already accept.
// ---------------------------------------------------------------------------
import { useState, useEffect, useMemo } from "react";
import { Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  REPAIR_DEPT_CODES,
  REPAIR_DEPT_LABELS,
  REPAIR_SCOPE_PRESET_DEPTS,
  REPAIR_SCOPE_PRESET_LABELS,
  parseRepairScope,
  serializeRepairScope,
  repairScopeBadgeLabel,
  repairPartsLabel,
  canonicalizeComponentPicks,
  type RepairDeptCode,
} from "@/lib/repair-scope";

// One pickable repair component — a top-level BOM WIP piece, as served by
// GET /api/sales-orders/repair-components (Component-level Repair Scope).
// `key` is the builder's deterministic wipKey; `qty` is the BOM's per-FG
// piece count (the qty input's upper bound).
type RepairComponentOption = {
  key: string;
  label: string;
  type: string;
  qty: number;
};

// The line-item fields the picker reads. Both the create-page and edit-page
// LineItem types are structurally compatible with this (the create LineItem
// carries more fields; structural typing only requires these).
export type RepairScopeLine = {
  productCode: string;
  sizeLabel: string;
  sizeCode: string;
  fabricCode: string;
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  repairScope?: string | null;
};

// Badge shown in the line header — only a valid, non-FULL scope earns one.
// Caller still gates on service-order mode; a normal order never has a scope.
export function RepairScopeBadge({ repairScope }: { repairScope?: string | null }) {
  const parsed = parseRepairScope(repairScope ?? null);
  if (!parsed) return null;
  return (
    <Badge className="bg-[#E0EDF0] text-[#3E6570]">
      {repairScopeBadgeLabel(parsed)}
    </Badge>
  );
}

// Delivery badge — lists the repaired PARTS of a partial repair in full words
// (Wei Siang 2026-06-16): "Repair: Headboard + Armrest". Renders nothing for a
// normal order or a full / dept-only repair (no component picks). Shown next to
// the product name in the delivery lists and the DO detail items; the model is
// already on the row (product code + name), so the parts aren't tagged again.
// `productCode` is accepted (call sites pass it) but not rendered — kept for a
// quick re-add if the tag is ever wanted back.
export function RepairPartsBadge({
  repairScope,
}: {
  repairScope?: string | null;
  productCode?: string | null;
}) {
  const parts = repairPartsLabel(parseRepairScope(repairScope ?? null));
  if (!parts) return null;
  return (
    <Badge className="bg-[#F7EFD9] text-[#7A5B1A] gap-1 whitespace-normal">
      <Wrench className="h-3 w-3 shrink-0" />
      Repair: {parts}
    </Badge>
  );
}

const selectClass =
  "w-full rounded border border-[#E2DDD8] px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20";

export function RepairScopePicker({
  item,
  idx,
  onUpdate,
}: {
  item: RepairScopeLine;
  idx: number;
  onUpdate: (idx: number, updates: { repairScope: string | null }) => void;
}) {
  // The RAW stored JSON drives the select + checkboxes (so a Custom pick with
  // zero depts ticked yet doesn't snap back to Full); the LENIENT parse drives
  // the badge / current-scope reads.
  const rawScope = (() => {
    if (!item.repairScope) return null;
    try {
      return JSON.parse(item.repairScope) as {
        preset?: string;
        depts?: string[];
        components?: unknown;
      };
    } catch {
      return null;
    }
  })();
  const scopePresetValue = rawScope?.preset ?? "FULL";
  const scopeCustomDepts: string[] = Array.isArray(rawScope?.depts) ? rawScope.depts : [];

  // ---- Component-level Repair Scope (CUSTOM only) ----
  // Stored picks: ABSENT components field = ALL pieces at full qty (the
  // canonical "everything" form — see canonicalizeComponentPicks). An
  // explicit array = the subset the operator ticked (empty array = nothing
  // ticked → Save is blocked by the shared validator).
  const storedComponents: { key: string; label: string; qty: number }[] | undefined =
    (() => {
      const raw = rawScope?.components;
      if (!Array.isArray(raw)) return undefined;
      return raw
        .filter(
          (p): p is { key: string; label?: unknown; qty?: unknown } =>
            !!p && typeof p === "object" && typeof (p as { key?: unknown }).key === "string",
        )
        .map((p) => ({
          key: p.key,
          label: typeof p.label === "string" ? p.label : "",
          qty: Number(p.qty) || 1,
        }));
    })();

  // The pickable pieces for this line's product — fetched from
  // /api/sales-orders/repair-components, which runs the SAME BOM → WIP
  // breakdown (same keys, same per-FG qty) the confirm-time builder uses,
  // so a pick here always matches the job cards that get built. Empty =
  // hide the picker (legacy/flat BOM → all components, today's behaviour).
  //
  // State holds the LAST SUCCESSFUL fetch keyed by its variant fingerprint;
  // `repairComponents` derives to [] whenever the fingerprint is stale (no
  // synchronous state resets in the effect). A failed fetch leaves the
  // result null → picker hidden, stored picks untouched (a network blip
  // must never wipe a saved selection).
  const wantComponents = scopePresetValue === "CUSTOM" && !!item.productCode;
  const componentsFetchKey = wantComponents
    ? [
        item.productCode,
        item.sizeLabel,
        item.sizeCode,
        item.fabricCode,
        item.gapInches ?? "",
        item.divanHeightInches ?? "",
        item.legHeightInches ?? "",
      ].join("|")
    : "";
  const [componentsResult, setComponentsResult] = useState<{
    key: string;
    options: RepairComponentOption[];
  } | null>(null);
  useEffect(() => {
    if (!componentsFetchKey) return;
    let cancelled = false;
    const params = new URLSearchParams({ productCode: item.productCode });
    if (item.sizeLabel) params.set("sizeLabel", item.sizeLabel);
    if (item.sizeCode) params.set("sizeCode", item.sizeCode);
    if (item.fabricCode) params.set("fabricCode", item.fabricCode);
    if (item.gapInches != null) params.set("gapInches", String(item.gapInches));
    if (item.divanHeightInches != null) params.set("divanHeightInches", String(item.divanHeightInches));
    if (item.legHeightInches != null) params.set("legHeightInches", String(item.legHeightInches));
    fetch(`/api/sales-orders/repair-components?${params.toString()}`)
      .then((res): Promise<{ success?: boolean; data?: RepairComponentOption[] } | null> =>
        res.ok ? res.json() : Promise.resolve(null),
      )
      .then((data) => {
        if (cancelled) return;
        if (data?.success && Array.isArray(data.data)) {
          setComponentsResult({ key: componentsFetchKey, options: data.data });
        }
      })
      .catch(() => {
        /* keep the previous result — picker stays hidden for this key */
      });
    return () => {
      cancelled = true;
    };
  }, [
    componentsFetchKey,
    item.productCode,
    item.sizeLabel,
    item.sizeCode,
    item.fabricCode,
    item.gapInches,
    item.divanHeightInches,
    item.legHeightInches,
  ]);
  const componentsLoaded =
    !!componentsFetchKey && componentsResult?.key === componentsFetchKey;
  const repairComponents: RepairComponentOption[] = useMemo(
    () =>
      componentsResult && componentsFetchKey && componentsResult.key === componentsFetchKey
        ? componentsResult.options
        : [],
    [componentsResult, componentsFetchKey],
  );

  // Reconcile stored picks against a SUCCESSFULLY fetched component list:
  // prune keys that no longer exist (product changed / BOM edited — the
  // survivors re-canonicalize; ALL keys vanished → reset to the fresh
  // all-ticked default so the operator re-picks). Drops the field when the
  // product has no pickable components (picker hidden = all components).
  // An explicit empty array (operator unticked everything) is PRESERVED so
  // Save stays blocked by the shared validator. Write-once guard (nextJson
  // comparison) keeps this loop-free.
  useEffect(() => {
    if (!wantComponents || !componentsLoaded) return;
    if (!item.repairScope) return;
    let parsed: { preset?: string; depts?: string[]; components?: unknown };
    try {
      parsed = JSON.parse(item.repairScope);
    } catch {
      return;
    }
    if (parsed?.preset !== "CUSTOM" || !Array.isArray(parsed.components)) return;
    const storedEntries = parsed.components as { key?: unknown; label?: unknown; qty?: unknown }[];
    const validKeys = new Set(repairComponents.map((o) => o.key));
    const surviving = storedEntries.filter(
      (p): p is { key: string; label?: string; qty: number } =>
        !!p && typeof p === "object" && typeof p.key === "string" && validKeys.has(p.key as string),
    );
    let canonical: ReturnType<typeof canonicalizeComponentPicks>;
    if (repairComponents.length === 0) {
      // No pickable components for this product (flat/legacy BOM): the
      // picker is hidden, so any stored field — even an empty one — must
      // go, or Save would be blocked with nothing visible to untangle.
      canonical = undefined;
    } else if (storedEntries.length === 0) {
      // Operator explicitly unticked everything — keep [] so Save blocks.
      canonical = [];
    } else if (surviving.length === 0) {
      // Every stored key vanished (product re-pointed / BOM rebuilt) —
      // reset to the all-ticked default; the operator re-picks visibly.
      canonical = undefined;
    } else {
      canonical = canonicalizeComponentPicks(repairComponents, surviving);
    }
    const nextJson = JSON.stringify({
      preset: "CUSTOM",
      depts: Array.isArray(parsed.depts) ? parsed.depts : [],
      ...(canonical !== undefined ? { components: canonical } : {}),
    });
    if (nextJson !== item.repairScope) onUpdate(idx, { repairScope: nextJson });
  }, [wantComponents, componentsLoaded, repairComponents, item.repairScope, onUpdate, idx]);

  // Checked/qty state for one component row, derived from storage.
  const componentPickFor = (opt: RepairComponentOption): { checked: boolean; qty: number } => {
    const maxQty = Math.max(1, Math.floor(opt.qty) || 1);
    if (storedComponents === undefined) return { checked: true, qty: maxQty };
    const hit = storedComponents.find((p) => p.key === opt.key);
    if (!hit) return { checked: false, qty: maxQty };
    const q = Math.floor(Number(hit.qty));
    return {
      checked: true,
      qty: Number.isFinite(q) && q >= 1 ? Math.min(q, maxQty) : maxQty,
    };
  };

  const currentComponentPicks = (): { key: string; label: string; qty: number }[] =>
    repairComponents
      .map((opt) => ({ opt, st: componentPickFor(opt) }))
      .filter(({ st }) => st.checked)
      .map(({ opt, st }) => ({ key: opt.key, label: opt.label, qty: st.qty }));

  const writeComponentPicks = (picks: { key: string; label: string; qty: number }[]) => {
    const canonical = canonicalizeComponentPicks(repairComponents, picks);
    onUpdate(idx, {
      repairScope: JSON.stringify({
        preset: "CUSTOM",
        depts: scopeCustomDepts,
        // undefined = everything ticked at full qty → omit the field (the
        // canonical storage form). An empty array (nothing ticked) is kept
        // so Save blocks via the shared validator.
        ...(canonical !== undefined ? { components: canonical } : {}),
      }),
    });
  };

  const toggleComponent = (opt: RepairComponentOption) => {
    const picks = currentComponentPicks();
    const has = picks.some((p) => p.key === opt.key);
    writeComponentPicks(
      has
        ? picks.filter((p) => p.key !== opt.key)
        : [...picks, { key: opt.key, label: opt.label, qty: 1 }],
    );
  };

  const setComponentQty = (opt: RepairComponentOption, raw: string) => {
    const maxQty = Math.max(1, Math.floor(opt.qty) || 1);
    const n = Math.floor(Number(raw));
    const qty = Number.isFinite(n) ? Math.min(Math.max(1, n), maxQty) : maxQty;
    writeComponentPicks(
      currentComponentPicks().map((p) => (p.key === opt.key ? { ...p, qty } : p)),
    );
  };

  const handleScopePresetChange = (v: string) => {
    if (v === "FABRIC" || v === "FRAME" || v === "FOAM") {
      onUpdate(idx, {
        repairScope: serializeRepairScope({
          preset: v,
          depts: [...REPAIR_SCOPE_PRESET_DEPTS[v]],
        }),
      });
    } else if (v === "CUSTOM") {
      // Partial repair ALWAYS includes Upholstery + Packing (Wei Siang
      // 2026-06-15): every repair has to be re-upholstered and re-packed, so
      // they start ticked and are locked on (see toggleScopeDept + the
      // disabled checkboxes). The operator adds whichever other depts the
      // repair needs. Components start absent (= all pieces, full qty).
      onUpdate(idx, {
        repairScope: JSON.stringify({
          preset: "CUSTOM",
          depts: ["UPHOLSTERY", "PACKING"],
        }),
      });
    } else {
      onUpdate(idx, { repairScope: null });
    }
  };

  const toggleScopeDept = (code: RepairDeptCode) => {
    // Upholstery + Packing are mandatory on every partial repair — locked on.
    if (code === "UPHOLSTERY" || code === "PACKING") return;
    const next = scopeCustomDepts.includes(code)
      ? scopeCustomDepts.filter((d) => d !== code)
      : [...scopeCustomDepts, code];
    // Keep canonical chain order regardless of tick order.
    const ordered = REPAIR_DEPT_CODES.filter((d) => next.includes(d));
    onUpdate(idx, {
      repairScope: JSON.stringify({
        preset: "CUSTOM",
        depts: ordered,
        // Dept ticks and component picks are independent narrowings of the
        // same scope — keep the line's picks when toggling a dept.
        ...(storedComponents !== undefined ? { components: storedComponents } : {}),
      }),
    });
  };

  /* Repair Scope picker (service-order mode only). Full remake (NULL) is
     today's behaviour (every department, full materials); Partial reveals
     dept checkboxes and builds job cards only for the ticked departments.
     Owner 2026-06-11 ("点选部门最万能"): the named FABRIC/FRAME/FOAM presets
     are hidden from the picker — dept checkboxes cover every real repair.
     The lib still accepts stored preset values, and a legacy line renders
     its preset via the conditional option below instead of snapping to FULL. */
  return (
    <div>
      <label className="block text-xs text-[#9CA3AF] mb-1">Repair Scope</label>
      <select
        value={scopePresetValue}
        onChange={(e) => handleScopePresetChange(e.target.value)}
        className={selectClass}
      >
        <option value="FULL">{REPAIR_SCOPE_PRESET_LABELS.FULL}</option>
        {(scopePresetValue === "FABRIC" ||
          scopePresetValue === "FRAME" ||
          scopePresetValue === "FOAM") && (
          <option value={scopePresetValue}>
            {REPAIR_SCOPE_PRESET_LABELS[scopePresetValue]}
          </option>
        )}
        <option value="CUSTOM">Partial repair — pick departments…</option>
      </select>
      {scopePresetValue === "CUSTOM" && (
        <div className="mt-2 grid grid-cols-2 gap-1.5 rounded-md border border-[#E2DDD8] bg-[#FAF9F7] p-2">
          {REPAIR_DEPT_CODES.map((code) => {
            // Upholstery + Packing always apply to a repair → shown ticked
            // and locked (disabled) so they can't be unticked by mistake.
            const locked = code === "UPHOLSTERY" || code === "PACKING";
            return (
              <label
                key={code}
                className={`flex items-center gap-2 text-xs ${locked ? "text-[#9CA3AF] cursor-default" : "text-[#374151] cursor-pointer"}`}
              >
                <input
                  type="checkbox"
                  checked={locked || scopeCustomDepts.includes(code)}
                  disabled={locked}
                  onChange={() => toggleScopeDept(code)}
                  className="h-3.5 w-3.5 accent-[#6B5C32]"
                />
                {REPAIR_DEPT_LABELS[code]}
                {locked ? " (always)" : ""}
              </label>
            );
          })}
        </div>
      )}
      {/* Component-level Repair Scope — which BOM pieces get repaired
          (bedframe Headboard vs Divan; sofa base / cushions / armrest /
          headrest). All ticked at full qty by default = the whole item
          (stored with NO components field — byte-identical to a dept-only
          scope). Hidden when the product's BOM has no top-level pieces
          (legacy/flat BOM = all components). */}
      {scopePresetValue === "CUSTOM" && repairComponents.length > 0 && (
        <div className="mt-2 space-y-1.5 rounded-md border border-[#E2DDD8] bg-[#FAF9F7] p-2">
          <div className="text-[11px] font-medium text-[#6B5C32]">
            Components to repair
          </div>
          {repairComponents.map((opt) => {
            const picked = componentPickFor(opt);
            const maxQty = Math.max(1, Math.floor(opt.qty) || 1);
            return (
              <div
                key={opt.key}
                className="flex items-center gap-2 text-xs text-[#374151]"
              >
                <label className="flex flex-1 items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={picked.checked}
                    onChange={() => toggleComponent(opt)}
                    className="h-3.5 w-3.5 accent-[#6B5C32]"
                  />
                  <span className="truncate" title={opt.label}>{opt.label}</span>
                </label>
                <input
                  type="number"
                  min={1}
                  max={maxQty}
                  step={1}
                  value={picked.qty}
                  disabled={!picked.checked}
                  onChange={(e) => setComponentQty(opt, e.target.value)}
                  className="w-14 rounded border border-[#E2DDD8] px-1.5 py-0.5 text-right disabled:bg-[#F4EFE3] disabled:text-[#9CA3AF]"
                />
                <span className="text-[#9CA3AF]">/ {maxQty}</span>
              </div>
            );
          })}
          {storedComponents !== undefined && storedComponents.length === 0 && (
            <div className="text-[11px] text-[#9A3A2D]">
              Keep at least one component ticked, or switch back to Full remake.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
