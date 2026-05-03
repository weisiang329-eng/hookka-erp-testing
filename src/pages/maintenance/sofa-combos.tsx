// ---------------------------------------------------------------------------
// Sofa Combo Pricing — maintenance screen.
//
// Lists every effective-dated combo rule (sofa_combo_rules, migration 0068)
// grouped by baseModel as a card grid. Operators add/remove rules; edits
// happen by appending a new row with a fresher effectiveFrom (matches the
// product_prices / customer_product_prices append-only pattern).
//
// CS Order detection (does this cart hit a combo? if so, charge combo
// price) lives in sales/create.tsx and is rolling out in Phase 3c — this
// page is the rule-management surface only.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { asArray } from "@/lib/safe-json";
import { formatCurrency, formatDate } from "@/lib/utils";
import { Loader2, Plus, Trash2, X, Tag, Layers } from "lucide-react";
import type { Product, Customer } from "@/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type FabricTier = "ANY" | "PRICE_1" | "PRICE_2" | "PRICE_3";

const FABRIC_TIERS: FabricTier[] = ["ANY", "PRICE_1", "PRICE_2", "PRICE_3"];

// Seat-height set used elsewhere in the products / sales-order modules.
// Hardcoded here — keeps the form deterministic and matches the pricesByHeight
// JSON shape stored in the table.
const SEAT_HEIGHTS = ["24", "28", "30", "32", "35"] as const;

// Storage shape changed mid-flight from string[] (single-variant exact match)
// to string[][] (OR-groups: each inner array is "any-of", outer is "all-of").
// Server still accepts the legacy flat shape and wraps each element into a
// 1-element group, so a fresh client never sees mixed shapes — but the
// renderer needs to handle both during the rollout window.
type ComponentSizeGroups = string[] | string[][];
type SofaComboRule = {
  id: string;
  baseModel: string;
  componentSizes: ComponentSizeGroups;
  fabricTier: FabricTier;
  pricesByHeight: Record<string, number>;
  customerId: string | null;
  customerName: string | null;
  effectiveFrom: string;
  notes: string;
  createdAt: string;
  createdBy: string | null;
};

// Render the OR-grouped sizes as readable text.
//   [["2A(LHF)","2A(RHF)"], ["L(LHF)","L(RHF)"]]  →  "2A(LHF) / 2A(RHF) + L(LHF) / L(RHF)"
//   ["2A(LHF)", "L(LHF)"]                         →  "2A(LHF) + L(LHF)"
// "+" between groups means "AND"; "/" within a group means "OR".
function renderComponentSizes(sizes: ComponentSizeGroups): string {
  if (!Array.isArray(sizes) || sizes.length === 0) return "—";
  const isGrouped = Array.isArray(sizes[0]);
  if (!isGrouped) return (sizes as string[]).join(" + ");
  return (sizes as string[][])
    .map((g) => g.join(" / "))
    .join(" + ");
}

type ApiList<T> = { success?: boolean; data?: T[] };
type ApiSingle<T> = { success?: boolean; data?: T; error?: string };

const todayIso = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fabricTierBadge(t: FabricTier) {
  const map: Record<FabricTier, { bg: string; text: string; border: string }> =
    {
      ANY: {
        bg: "bg-[#F0ECE9]",
        text: "text-[#4B5563]",
        border: "border-[#E2DDD8]",
      },
      PRICE_1: {
        bg: "bg-[#EEF3E4]",
        text: "text-[#4F7C3A]",
        border: "border-[#C6DBA8]",
      },
      PRICE_2: {
        bg: "bg-[#E0EDF0]",
        text: "text-[#3E6570]",
        border: "border-[#A8CAD2]",
      },
      PRICE_3: {
        bg: "bg-[#FAEFCB]",
        text: "text-[#9C6F1E]",
        border: "border-[#E8D597]",
      },
    };
  const c = map[t];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${c.bg} ${c.text} ${c.border}`}
    >
      {t}
    </span>
  );
}

function statusBadge(effectiveFrom: string) {
  const today = todayIso();
  const isPending = effectiveFrom > today;
  if (isPending) {
    // Days-until countdown so the operator can see at a glance how close
    // a scheduled combo is to taking effect. <=3d red, <=14d orange,
    // beyond that the standard amber matches the master Pending badge.
    const ms = new Date(effectiveFrom + "T00:00:00Z").getTime() - new Date(today + "T00:00:00Z").getTime();
    const days = Math.max(0, Math.round(ms / 86400000));
    const cls =
      days <= 3
        ? "bg-[#FBE0DC] text-[#9A3A2D] border-[#E8B2A1]"
        : days <= 14
          ? "bg-[#FBE4CE] text-[#B8601A] border-[#E8B786]"
          : "bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597]";
    return (
      <span
        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${cls}`}
        title={`Becomes effective on ${effectiveFrom}`}
      >
        Pending · {days}d
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]">
      Active
    </span>
  );
}

// Group rules by baseModel for the card-grid display.
function groupByBaseModel(rules: SofaComboRule[]): Record<string, SofaComboRule[]> {
  const m: Record<string, SofaComboRule[]> = {};
  for (const r of rules) {
    if (!m[r.baseModel]) m[r.baseModel] = [];
    m[r.baseModel].push(r);
  }
  return m;
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function SofaCombosPage() {
  const {
    data: rulesResp,
    loading: rulesLoading,
    refresh: refreshRules,
  } = useCachedJson<unknown>("/api/sofa-combos");
  const { data: productsResp } = useCachedJson<unknown>("/api/products");
  const { data: customersResp } = useCachedJson<unknown>("/api/customers");

  const rules: SofaComboRule[] = useMemo(
    () => asArray<SofaComboRule>(rulesResp),
    [rulesResp],
  );
  const products: Product[] = useMemo(
    () => asArray<Product>(productsResp),
    [productsResp],
  );
  const customers: Customer[] = useMemo(
    () => asArray<Customer>(customersResp),
    [customersResp],
  );

  // SOFA-only product set, with the unique baseModel list and the per-baseModel
  // size codes the form's checklist is built from.
  const sofaProducts = useMemo(
    () => products.filter((p) => p.category === "SOFA"),
    [products],
  );
  const baseModels = useMemo(() => {
    const set = new Set<string>();
    for (const p of sofaProducts) {
      if (p.baseModel) set.add(p.baseModel);
    }
    return [...set].sort();
  }, [sofaProducts]);
  // Keep handedness in the size code — "2A(LHF)" and "2A(RHF)" stay
  // separate so combo definitions match the product master 1:1. Operator
  // creates a distinct combo per handedness pair. Reverted from a brief
  // attempt to dedupe — that would have decoupled combo codes from the
  // canonical product code structure.
  const sizesByBaseModel = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const p of sofaProducts) {
      if (!p.baseModel || !p.sizeCode) continue;
      if (!m[p.baseModel]) m[p.baseModel] = [];
      if (!m[p.baseModel].includes(p.sizeCode)) m[p.baseModel].push(p.sizeCode);
    }
    for (const k of Object.keys(m)) m[k].sort();
    return m;
  }, [sofaProducts]);

  // Filters
  const [filterBaseModel, setFilterBaseModel] = useState<string>("ALL");
  const [filterCustomer, setFilterCustomer] = useState<string>("ALL");
  const [showCreate, setShowCreate] = useState(false);

  const filteredRules = useMemo(() => {
    return rules.filter((r) => {
      if (filterBaseModel !== "ALL" && r.baseModel !== filterBaseModel)
        return false;
      if (filterCustomer === "COMPANY" && r.customerId !== null) return false;
      if (
        filterCustomer !== "ALL" &&
        filterCustomer !== "COMPANY" &&
        r.customerId !== filterCustomer
      )
        return false;
      return true;
    });
  }, [rules, filterBaseModel, filterCustomer]);

  const grouped = useMemo(() => groupByBaseModel(filteredRules), [filteredRules]);

  async function handleDelete(id: string) {
    if (!confirm("Delete this combo rule? The history of past rules is preserved by their dates."))
      return;
    const res = await fetch(`/api/sofa-combos/${id}`, { method: "DELETE" });
    if (res.ok) {
      invalidateCachePrefix("/api/sofa-combos");
      refreshRules();
    } else {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      alert(body.error ?? "Failed to delete combo rule");
    }
  }

  if (rulesLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-[#6B5C32]" />
        <span className="ml-2 text-sm text-[#6B7280]">
          Loading sofa combo rules...
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Sofa Combo Pricing</h1>
          <p className="text-xs text-[#6B7280]">
            Module-set combo deals with optional same-fabric-tier discount.
            Append-only history; edits = a new row with a fresher effective
            date.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Bulk seed: clone every company-wide combo into a customer-
              scoped duplicate so the customer's combos can be edited
              independently of master. Idempotent — re-running skips
              already-copied rules. */}
          <CopyMasterCombosButton
            customers={customers}
            onCopied={() => {
              invalidateCachePrefix("/api/sofa-combos");
              refreshRules();
            }}
          />
          <Button variant="primary" onClick={() => setShowCreate(true)}>
            <Plus className="h-4 w-4" />
            New Combo
          </Button>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={filterBaseModel}
              onChange={(e) => setFilterBaseModel(e.target.value)}
              className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
            >
              <option value="ALL">All base models</option>
              {baseModels.map((bm) => (
                <option key={bm} value={bm}>
                  {bm}
                </option>
              ))}
            </select>
            <select
              value={filterCustomer}
              onChange={(e) => setFilterCustomer(e.target.value)}
              className="h-10 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
            >
              <option value="ALL">All customers</option>
              <option value="COMPANY">Company-wide only</option>
              {customers.map((cu) => (
                <option key={cu.id} value={cu.id}>
                  {cu.name}
                </option>
              ))}
            </select>
            <span className="text-xs text-[#9CA3AF] ml-auto">
              {filteredRules.length} rule
              {filteredRules.length === 1 ? "" : "s"}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Card grid */}
      {Object.keys(grouped).length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-[#9CA3AF]">
            No combo rules yet. Click "New Combo" to add one.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([baseModel, group]) => (
            <div key={baseModel} className="space-y-3">
              <div className="flex items-center gap-2">
                <Layers className="h-4 w-4 text-[#6B5C32]" />
                <h2 className="text-sm font-semibold text-[#1F1D1B]">
                  {baseModel}
                </h2>
                <span className="text-xs text-[#9CA3AF]">
                  ({group.length} rule{group.length === 1 ? "" : "s"})
                </span>
              </div>
              <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                {group.map((rule) => (
                  <ComboCard
                    key={rule.id}
                    rule={rule}
                    onDelete={() => handleDelete(rule.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create dialog */}
      {showCreate && (
        <CreateComboDialog
          baseModels={baseModels}
          sizesByBaseModel={sizesByBaseModel}
          customers={customers}
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            invalidateCachePrefix("/api/sofa-combos");
            refreshRules();
            setShowCreate(false);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Combo card
// ---------------------------------------------------------------------------
function ComboCard({
  rule,
  onDelete,
}: {
  rule: SofaComboRule;
  onDelete: () => void;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Tag className="h-3.5 w-3.5 text-[#6B5C32]" />
              <span className="text-sm font-semibold text-[#1F1D1B]">
                {rule.baseModel}
              </span>
              <span className="text-xs text-[#6B7280]">·</span>
              <span className="text-xs font-medium text-[#4B5563]">
                {renderComponentSizes(rule.componentSizes)}
              </span>
              {fabricTierBadge(rule.fabricTier)}
            </div>
            <div className="text-xs text-[#6B7280]">
              {rule.customerName ?? "All customers"}
            </div>
          </div>
          <Button variant="ghost" size="icon" onClick={onDelete}>
            <Trash2 className="h-4 w-4 text-[#9A3A2D]" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-3">
        <div className="grid grid-cols-5 gap-1 text-center">
          {SEAT_HEIGHTS.map((h) => {
            const sen = rule.pricesByHeight[h];
            return (
              <div
                key={h}
                className="rounded border border-[#E2DDD8] bg-[#FAF9F7] px-1 py-1.5"
              >
                <div className="text-[10px] uppercase tracking-wide text-[#9CA3AF]">
                  {h}
                </div>
                <div className="text-xs font-medium text-[#1F1D1B]">
                  {typeof sen === "number" ? formatCurrency(sen) : "—"}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-between text-xs text-[#6B7280]">
          <span>Effective {formatDate(rule.effectiveFrom)}</span>
          {statusBadge(rule.effectiveFrom)}
        </div>
        {rule.notes ? (
          <p className="text-xs text-[#6B7280] italic">{rule.notes}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------
function CreateComboDialog({
  baseModels,
  sizesByBaseModel,
  customers,
  onClose,
  onSaved,
}: {
  baseModels: string[];
  sizesByBaseModel: Record<string, string[]>;
  customers: Customer[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [baseModel, setBaseModel] = useState<string>(baseModels[0] ?? "");
  const [selectedSizes, setSelectedSizes] = useState<string[]>([]);
  const [fabricTier, setFabricTier] = useState<FabricTier>("ANY");
  const [pricesRm, setPricesRm] = useState<Record<string, string>>({});
  const [customerId, setCustomerId] = useState<string>("");
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const availableSizes = sizesByBaseModel[baseModel] ?? [];

  // ESC closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Reset selectedSizes when baseModel changes — old selection won't match
  // the new model's size set.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setSelectedSizes([]);
  }, [baseModel]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function toggleSize(sz: string) {
    setSelectedSizes((prev) =>
      prev.includes(sz) ? prev.filter((s) => s !== sz) : [...prev, sz],
    );
  }

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);

    if (!baseModel) {
      setErr("Select a base model");
      return;
    }
    if (selectedSizes.length === 0) {
      setErr("Select at least one component size");
      return;
    }
    // Build pricesByHeight from the form. Skip blank entries — the resolver
    // returns "—" for missing heights, which is the expected display when
    // a height isn't part of the deal.
    const pricesByHeight: Record<string, number> = {};
    for (const h of SEAT_HEIGHTS) {
      const raw = (pricesRm[h] ?? "").trim();
      if (!raw) continue;
      const rm = Number(raw);
      if (!Number.isFinite(rm) || rm < 0) {
        setErr(`Price for height ${h} must be a non-negative number`);
        return;
      }
      pricesByHeight[h] = Math.round(rm * 100); // RM -> sen
    }
    if (Object.keys(pricesByHeight).length === 0) {
      setErr("Enter at least one seat-height price");
      return;
    }

    // Auto-group by base size: handedness variants of the same base
    // (2A(LHF) and 2A(RHF), L(LHF) and L(RHF), …) collapse into ONE
    // OR-group so a single combo rule covers all 4 orientations of a
    // 2A+L deal. Sizes without handedness (CNR, STOOL, 1S/2S/3S, 1NA/2NA)
    // each form their own one-element group.
    //
    // Storage shape on componentSizes is now string[][]:
    //   [["2A(LHF)","2A(RHF)"], ["L(LHF)","L(RHF)"]]
    // Detection on the CS Order side requires every group to have at
    // least one matching module on the cart (any-of within a group,
    // all-of across groups).
    const stripHandedness = (s: string): string =>
      s.replace(/\s*\((?:LHF|RHF)\)\s*/i, "").trim();
    const groupedByBase = new Map<string, string[]>();
    for (const sz of selectedSizes) {
      const base = stripHandedness(sz) || sz;
      const arr = groupedByBase.get(base) ?? [];
      if (!arr.includes(sz)) arr.push(sz);
      groupedByBase.set(base, arr);
    }
    const componentSizeGroups: string[][] = Array.from(groupedByBase.values()).map(
      (g) => g.slice().sort(),
    );
    componentSizeGroups.sort((a, b) => a[0].localeCompare(b[0]));

    setSaving(true);
    try {
      const body = {
        baseModel,
        componentSizes: componentSizeGroups,
        fabricTier,
        pricesByHeight,
        customerId: customerId || null,
        effectiveFrom,
        notes: notes.trim() || null,
      };
      const res = await fetch("/api/sofa-combos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as ApiSingle<unknown>;
      if (!res.ok || !json.success) {
        setErr(json.error ?? "Failed to create combo rule");
        setSaving(false);
        return;
      }
      onSaved();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : String(ex));
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <CardHeader className="pb-3 sticky top-0 bg-white z-10 border-b border-[#E2DDD8]">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">New Sofa Combo</CardTitle>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-4">
          <form onSubmit={handleSave} className="space-y-4">
            {/* Base model */}
            <div>
              <label className="block text-xs font-medium text-[#374151] mb-1">
                Base Model
              </label>
              <select
                value={baseModel}
                onChange={(e) => setBaseModel(e.target.value)}
                className="h-10 w-full rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
              >
                <option value="">Select base model</option>
                {baseModels.map((bm) => (
                  <option key={bm} value={bm}>
                    {bm}
                  </option>
                ))}
              </select>
            </div>

            {/* Component sizes */}
            <div>
              <label className="block text-xs font-medium text-[#374151] mb-1">
                Component Sizes (modules in this combo)
              </label>
              {availableSizes.length === 0 ? (
                <p className="text-xs text-[#9CA3AF] italic">
                  Pick a base model first to see its modules.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {availableSizes.map((sz) => {
                    const checked = selectedSizes.includes(sz);
                    return (
                      <label
                        key={sz}
                        className={`inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm cursor-pointer transition-colors ${
                          checked
                            ? "bg-[#EEF3E4] border-[#C6DBA8] text-[#4F7C3A]"
                            : "bg-white border-[#E2DDD8] text-[#4B5563] hover:bg-[#FAF9F7]"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleSize(sz)}
                          className="h-3.5 w-3.5"
                        />
                        {sz}
                      </label>
                    );
                  })}
                </div>
              )}
              {selectedSizes.length > 0 && (
                <p className="text-xs text-[#6B7280] mt-1.5">
                  Combo: {[...selectedSizes].sort().join(" + ")}
                </p>
              )}
            </div>

            {/* Fabric tier */}
            <div>
              <label className="block text-xs font-medium text-[#374151] mb-1">
                Fabric Tier (matches when every module is on this tier)
              </label>
              <div className="flex flex-wrap gap-3">
                {FABRIC_TIERS.map((t) => (
                  <label
                    key={t}
                    className="inline-flex items-center gap-1.5 text-sm text-[#4B5563] cursor-pointer"
                  >
                    <input
                      type="radio"
                      name="fabricTier"
                      checked={fabricTier === t}
                      onChange={() => setFabricTier(t)}
                    />
                    {t}
                  </label>
                ))}
              </div>
            </div>

            {/* Prices per seat height */}
            <div>
              <label className="block text-xs font-medium text-[#374151] mb-1">
                Combo Price by Seat Height (RM)
              </label>
              <div className="grid grid-cols-5 gap-2">
                {SEAT_HEIGHTS.map((h) => (
                  <div key={h} className="space-y-1">
                    <div className="text-[10px] uppercase tracking-wide text-center text-[#9CA3AF]">
                      {h}
                    </div>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={pricesRm[h] ?? ""}
                      onChange={(e) =>
                        setPricesRm((prev) => ({
                          ...prev,
                          [h]: e.target.value,
                        }))
                      }
                    />
                  </div>
                ))}
              </div>
            </div>

            {/* Customer */}
            <div>
              <label className="block text-xs font-medium text-[#374151] mb-1">
                Customer (leave blank for company-wide)
              </label>
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                className="h-10 w-full rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
              >
                <option value="">All customers (company-wide)</option>
                {customers.map((cu) => (
                  <option key={cu.id} value={cu.id}>
                    {cu.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Effective from + notes */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-[#374151] mb-1">
                  Effective From
                </label>
                <Input
                  type="date"
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                  required
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[#374151] mb-1">
                  Notes (optional)
                </label>
                <Input
                  placeholder="Free-form note"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>

            {err && (
              <div className="rounded-md border border-[#E8B2A1] bg-[#F9E1DA] px-3 py-2 text-sm text-[#9A3A2D]">
                {err}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={saving}>
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Plus className="h-4 w-4" />
                    Save Combo
                  </>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// Type-only: silence unused-import warning for ApiList kept for future surface.
export type { ApiList };

// ---------------------------------------------------------------------------
// CopyMasterCombosButton — page-header action that clones every company-
// wide combo into a customer-scoped duplicate. Customer picker lives in a
// small inline popover so the page header stays compact.
// ---------------------------------------------------------------------------
function CopyMasterCombosButton({
  customers,
  onCopied,
}: {
  customers: Customer[];
  onCopied: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>("");
  const [busy, setBusy] = useState(false);

  async function handleCopy() {
    if (!selectedId) return;
    const target = customers.find((c) => c.id === selectedId);
    if (
      !target ||
      !confirm(
        `Copy every company-wide combo into ${target.name}? Already-copied combos are skipped (idempotent).`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/sofa-combos/copy-from-master", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: selectedId }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
        data?: { copied: number; skipped: number };
      };
      if (!res.ok || !j.success) {
        alert(j.error ?? "Failed to copy combos");
        return;
      }
      const d = j.data ?? { copied: 0, skipped: 0 };
      alert(
        `Copied ${d.copied} combo${d.copied === 1 ? "" : "s"} to ${target.name}. ${d.skipped} already existed and were skipped.`,
      );
      setOpen(false);
      setSelectedId("");
      onCopied();
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Layers className="h-4 w-4" />
        Copy to customer
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <select
        value={selectedId}
        onChange={(e) => setSelectedId(e.target.value)}
        className="h-9 rounded-md border border-[#E2DDD8] bg-white px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
      >
        <option value="">Pick customer…</option>
        {customers.map((cu) => (
          <option key={cu.id} value={cu.id}>
            {cu.name}
          </option>
        ))}
      </select>
      <Button
        variant="primary"
        size="sm"
        onClick={() => void handleCopy()}
        disabled={!selectedId || busy}
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        Copy
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setOpen(false);
          setSelectedId("");
        }}
        disabled={busy}
      >
        Cancel
      </Button>
    </div>
  );
}
