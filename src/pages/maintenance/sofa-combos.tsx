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
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { humanizeError } from "@/lib/humanize-error";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { asArray } from "@/lib/safe-json";
import { formatCurrency, formatDate } from "@/lib/utils";
import { AlertTriangle, Loader2, Plus, Trash2, X, Layers, History, Pencil, Copy } from "lucide-react";
import { DataGrid, type Column } from "@/components/ui/data-grid";
import { useToast } from "@/components/ui/toast";
import type { Product, Customer } from "@/types";
import {
  SofaComboHistoryDialog,
  type SofaComboHistoryRule,
} from "./SofaComboHistoryDialog";
import { OLD_SO_SAFE_BANNER } from "../products/MaintenanceConfigHistoryDialog";
import { useSofaSeatHeights } from "@/lib/use-sofa-seat-heights";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type FabricTier = "ANY" | "PRICE_1" | "PRICE_2" | "PRICE_3";

const FABRIC_TIERS: FabricTier[] = ["ANY", "PRICE_1", "PRICE_2", "PRICE_3"];

// Seat-height set used elsewhere in the products / sales-order modules.
// Hardcoded here — keeps the form deterministic and matches the pricesByHeight
// JSON shape stored in the table.
// Follows Maintenance → Sofa → Sizes (owner 2026-08-21). See
// src/lib/sofa-seat-heights.ts for why eight copies of this existed.

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

// Per-combo group key — keyed by (baseModel, componentSizes, fabricTier)
// only. ONE card per combo SHAPE; price evolution is shown inside the
// History dialog (mirrors product master price history). When customers
// have DIFFERENT current-active prices we still split the card via a
// second-level dedup (see groupByCombo below) so the visual stays
// faithful to who-pays-what.
//
// JSON.stringify(componentSizes) only works because the API canonicalises
// (sorts) the OR-groups before storage.
function comboGroupKey(r: SofaComboRule): string {
  return `${r.baseModel}|${JSON.stringify(r.componentSizes)}|${r.fabricTier}`;
}

// Pick the row that "represents" a combo group on the card grid. Rule:
// newest row whose effectiveFrom <= today (Active). If every row is in
// the future, fall back to the newest Pending row so the card still
// shows something. Returned indices preserve the input order so callers
// can derive Past rows by exclusion.
//
// Currently unused after the two-pass groupByCombo refactor (each per-
// (combo, customer) bucket picks its own active inline). Kept for
// future single-grouping fallback paths; ignore the lint nag.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function pickRepresentativeRule(rules: SofaComboRule[]): SofaComboRule {
  const today = todayIso();
  const sorted = rules.slice().sort((a, b) => {
    if (a.effectiveFrom !== b.effectiveFrom) {
      return b.effectiveFrom.localeCompare(a.effectiveFrom);
    }
    return b.createdAt.localeCompare(a.createdAt);
  });
  for (const r of sorted) {
    if (r.effectiveFrom <= today) return r;
  }
  return sorted[0];
}

type ComboGroup = {
  key: string;
  rules: SofaComboRule[]; // all rules in the group (full history for the dialog)
  representative: SofaComboRule;
  hasActive: boolean;
};

// Two-pass grouping:
//   Pass 1 — bucket by (combo, customerId): collect each customer's
//            full price-change timeline for this combo, then pick that
//            customer's current active rule.
//   Pass 2 — bucket Pass 1's active rules by (combo, currentActivePrices):
//            customers paying the SAME current price for the same combo
//            collapse into one card; customers paying DIFFERENT current
//            prices stay split. The card's `rules` includes EVERY rule
//            from EVERY contributing customer, so the History dialog
//            shows the full union timeline (Past/Active/Pending) and
//            never strands a row.
//
// This gives Wei Siang what they asked for: ONE card per combo (not N
// per effective-date), with price evolution surfaced via History — same
// UX as the product master price-history dialog. Adding a new effective-
// dated row at the same price = card stays as-is + new row in History.
// Adding a new effective-dated row at a NEW price = card stays + new
// row in History; only when the current ACTIVE price changes does a
// second card potentially appear (when only some customers have moved
// to the new price).
function groupByCombo(rules: SofaComboRule[]): ComboGroup[] {
  const today = todayIso();

  // Pass 1: per (combo, customerId) — collect rules, pick active.
  type PerCC = {
    rules: SofaComboRule[];
    active: SofaComboRule;
    hasActive: boolean;
  };
  const perCustomer = new Map<string, PerCC>();
  for (const r of rules) {
    const k = `${comboGroupKey(r)}|${r.customerId ?? ""}`;
    let e = perCustomer.get(k);
    if (!e) {
      e = { rules: [], active: r, hasActive: false };
      perCustomer.set(k, e);
    }
    e.rules.push(r);
  }
  for (const e of perCustomer.values()) {
    const sortedDesc = e.rules
      .slice()
      .sort((a, b) =>
        a.effectiveFrom !== b.effectiveFrom
          ? b.effectiveFrom.localeCompare(a.effectiveFrom)
          : b.createdAt.localeCompare(a.createdAt),
      );
    let active = sortedDesc.find((r) => r.effectiveFrom <= today);
    e.hasActive = !!active;
    // Fall back to newest pending if no active row exists.
    if (!active) active = sortedDesc[0];
    e.active = active;
  }

  // Pass 2: bucket by (combo, currentActivePricesJson). Cards collapse
  // when customers share the same current active price.
  const cards = new Map<string, ComboGroup>();
  for (const e of perCustomer.values()) {
    const cardKey = `${comboGroupKey(e.active)}|${JSON.stringify(e.active.pricesByHeight)}`;
    let g = cards.get(cardKey);
    if (!g) {
      g = {
        key: cardKey,
        rules: [],
        representative: e.active,
        hasActive: false,
      };
      cards.set(cardKey, g);
    }
    g.rules.push(...e.rules);
    if (e.hasActive) g.hasActive = true;
    // Prefer an active rule as representative over a pending one.
    if (e.hasActive && !cards.get(cardKey)!.representative) {
      g.representative = e.active;
    }
  }

  const groups = Array.from(cards.values());
  groups.sort((a, b) => {
    if (a.hasActive !== b.hasActive) return a.hasActive ? -1 : 1;
    if (a.representative.baseModel !== b.representative.baseModel) {
      return a.representative.baseModel.localeCompare(b.representative.baseModel);
    }
    return a.representative.effectiveFrom.localeCompare(b.representative.effectiveFrom);
  });
  return groups;
}

// Canonical JSON of a price map (keys sorted) so identical price sets hash to
// the same string — used for the History count (distinct date×price events).
function sortedPricesJson(p: Record<string, number>): string {
  return JSON.stringify(
    Object.keys(p)
      .sort()
      .reduce<Record<string, number>>((acc, k) => {
        acc[k] = p[k];
        return acc;
      }, {}),
  );
}

// Format a sen amount for the grid: drop the non-breaking space (it overflowed
// the narrow price cells), "—" when the height isn't part of the deal.
function fmtPriceCell(sen: number | null | undefined): string {
  if (typeof sen !== "number") return "—";
  return formatCurrency(sen).replace(new RegExp(String.fromCharCode(160), "g"), " ");
}

// One flattened combo for the Excel-like grid. The representative (active) rule
// supplies the displayed values; `group` is kept for row actions and batch
// operations, which read the full rule set.
type ComboRow = {
  key: string;
  group: ComboGroup;
  baseModel: string;
  components: string;
  fabricTier: FabricTier;
  customerNames: string[];
  customerLabel: string;
  p24: number | null;
  p28: number | null;
  p30: number | null;
  p32: number | null;
  p35: number | null;
  effectiveFrom: string;
  status: "Active" | "Pending";
  historyCount: number;
};

function toComboRow(g: ComboGroup): ComboRow {
  const rep = g.representative;
  const customerNames = Array.from(
    new Set(g.rules.map((r) => r.customerName).filter((n): n is string => !!n)),
  ).sort();
  const historyCount = new Set(
    g.rules.map((r) => `${r.effectiveFrom}|${sortedPricesJson(r.pricesByHeight)}`),
  ).size;
  const price = (h: string) =>
    typeof rep.pricesByHeight[h] === "number" ? rep.pricesByHeight[h] : null;
  return {
    key: g.key,
    group: g,
    baseModel: rep.baseModel,
    components: renderComponentSizes(rep.componentSizes),
    fabricTier: rep.fabricTier,
    customerNames,
    customerLabel: customerNames.length === 0 ? "All customers" : customerNames.join(", "),
    p24: price("24"),
    p28: price("28"),
    p30: price("30"),
    p32: price("32"),
    p35: price("35"),
    effectiveFrom: rep.effectiveFrom,
    status: rep.effectiveFrom > todayIso() ? "Pending" : "Active",
    historyCount,
  };
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function SofaCombosPage() {
  const seatHeights = useSofaSeatHeights();
  const { confirm } = useConfirm();
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
  // editingRule drives the same dialog component used for create. Setting
  // it pops the dialog open in edit mode pre-filled with the row's values.
  const [editingRule, setEditingRule] = useState<SofaComboRule | null>(null);

  // Grid selection + batch operations (multi-select → copy to a company, or
  // batch-edit prices across the picked combos).
  const { toast } = useToast();
  const [selectedRows, setSelectedRows] = useState<ComboRow[]>([]);
  const [copyCompanyId, setCopyCompanyId] = useState<string>("");
  const [copyBusy, setCopyBusy] = useState(false);
  const [showBatchEdit, setShowBatchEdit] = useState(false);

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

  // Two-level structure: outer = baseModel section, inner = per-combo
  // groups. Pending-only combos sink to the bottom of each baseModel
  // section. This is the bridge between the current "card per rule" UX
  // and the new "card per combo, history dialog underneath" UX.
  const groupedByBase = useMemo(
    () => groupByBaseModel(filteredRules),
    [filteredRules],
  );
  const combosByBase = useMemo(() => {
    const m: Record<string, ComboGroup[]> = {};
    for (const [bm, rs] of Object.entries(groupedByBase)) {
      m[bm] = groupByCombo(rs);
    }
    return m;
  }, [groupedByBase]);

  // Flat row list for the Excel-like grid. DataGrid re-groups by baseModel.
  const comboRows = useMemo<ComboRow[]>(
    () => Object.values(combosByBase).flat().map(toComboRow),
    [combosByBase],
  );

  // History dialog: open by group key so the dialog re-derives its rules
  // list from the freshly-fetched data after each save/delete.
  //
  // The card's group key is `${combo}|${currentActivePricesJson}` (set by
  // groupByCombo Pass 2), so a plain comboGroupKey filter on rules misses
  // every row whose own pricesByHeight differs from the active. Find the
  // matching card via combosByBase and use ITS .rules (which include
  // every contributing customer's full timeline).
  const [historyKey, setHistoryKey] = useState<string | null>(null);
  const historyRules = useMemo<SofaComboRule[] | null>(() => {
    if (!historyKey) return null;
    let card: ComboGroup | undefined;
    for (const cards of Object.values(combosByBase)) {
      const found = cards.find((g) => g.key === historyKey);
      if (found) {
        card = found;
        break;
      }
    }
    if (!card) return null;
    // Card collapses identical-price rules across multiple customers, so
    // the .rules list contains 1 row per (effectiveFrom × customer).
    // Dedup the dialog by (effectiveFrom + sorted-pricesJson) so each
    // unique price-event shows ONCE — multiple customers with the same
    // price at the same date are surfaced via the customer chips on the
    // card, not as repeated rows in the timeline.
    const sortedKeys = (p: Record<string, number>) =>
      JSON.stringify(
        Object.keys(p).sort().reduce<Record<string, number>>((acc, k) => {
          acc[k] = p[k];
          return acc;
        }, {}),
      );
    const seen = new Map<string, SofaComboRule>();
    for (const r of card.rules) {
      const k = `${r.effectiveFrom}|${sortedKeys(r.pricesByHeight)}`;
      const existing = seen.get(k);
      // Prefer master (NULL customerId) over customer-specific so the
      // "Auto-baseline" / "Mirrored from Master" notes propagate.
      if (!existing) seen.set(k, r);
      else if (existing.customerId && !r.customerId) seen.set(k, r);
    }
    return Array.from(seen.values());
  }, [combosByBase, historyKey]);

  async function handleDelete(id: string) {
    if (!(await confirm({ title: "Delete combo rule", message: "Delete this combo rule? The history of past rules is preserved by their dates.", danger: true })))
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

  // Copy each selected combo to the picked company as a customer-specific row,
  // effective today. One POST per combo (the create endpoint is single-
  // customer per row); the grid collapses identical price/date rows so a
  // re-copy is visually idempotent.
  async function handleCopyToCompany() {
    const target = customers.find((c) => c.id === copyCompanyId);
    if (!target || selectedRows.length === 0) return;
    if (
      !(await confirm({
        title: "Copy combos to company",
        message: `Copy ${selectedRows.length} combo${selectedRows.length === 1 ? "" : "s"} to ${target.name}? Each becomes a ${target.name}-specific combo effective today.`,
      }))
    ) {
      return;
    }
    setCopyBusy(true);
    let ok = 0;
    const failed: string[] = [];
    try {
      for (const row of selectedRows) {
        const rep = row.group.representative;
        const res = await fetch("/api/sofa-combos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseModel: rep.baseModel,
            componentSizes: rep.componentSizes,
            fabricTier: rep.fabricTier,
            pricesByHeight: rep.pricesByHeight,
            effectiveFrom: todayIso(),
            notes: rep.notes || null,
            customerId: copyCompanyId,
          }),
        });
        const j = (await res.json().catch(() => ({}))) as ApiSingle<unknown>;
        if (res.ok && j.success) ok++;
        else failed.push(`${rep.baseModel} (${j.error ?? "error"})`);
      }
      invalidateCachePrefix("/api/sofa-combos");
      refreshRules();
      if (failed.length === 0) {
        toast.success(`Copied ${ok} combo${ok === 1 ? "" : "s"} to ${target.name}.`);
        setSelectedRows([]);
        setCopyCompanyId("");
      } else {
        toast.error(
          `Copied ${ok}, failed ${failed.length}: ${failed.slice(0, 2).join("; ")}${failed.length > 2 ? "…" : ""}`,
        );
      }
    } finally {
      setCopyBusy(false);
    }
  }

  // Column defs for the Excel-like combo grid. Rebuilt each render (cheap; a
  // few dozen rows) so the action closures always see fresh handlers.
  const comboColumns: Column<ComboRow>[] = [
    { key: "baseModel", label: "Base Model", width: "120px", sortable: true },
    {
      key: "components",
      label: "Components",
      width: "210px",
      sortable: true,
      render: (v: string) => <span className="text-xs text-[#4B5563]">{v}</span>,
    },
    {
      key: "fabricTier",
      label: "Fabric",
      width: "92px",
      align: "center",
      sortable: true,
      filterAccessor: (r) => r.fabricTier,
      render: (_v, r) => fabricTierBadge(r.fabricTier),
    },
    {
      key: "customerLabel",
      label: "Customers",
      width: "180px",
      sortable: true,
      noClip: true,
      render: (_v, r) =>
        r.customerNames.length === 0 ? (
          <span className="text-xs text-[#6B7280]">All customers</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {r.customerNames.map((c) => (
              <span
                key={c}
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#F4F0E8] text-[#6B5C32] border border-[#E2DDD8]"
              >
                {c}
              </span>
            ))}
          </div>
        ),
    },
    ...seatHeights.map<Column<ComboRow>>((h) => ({
      key: `p${h}`,
      label: h,
      width: "76px",
      align: "right",
      sortable: true,
      render: (v: number | null) => (
        <span className="text-xs tabular-nums text-[#1F1D1B]">{fmtPriceCell(v)}</span>
      ),
    })),
    {
      key: "effectiveFrom",
      label: "Effective",
      width: "106px",
      type: "date",
      sortable: true,
      render: (v: string) => <span className="text-xs text-[#6B7280]">{formatDate(v)}</span>,
    },
    {
      key: "status",
      label: "Status",
      width: "96px",
      align: "center",
      sortable: true,
      filterAccessor: (r) => r.status,
      render: (_v, r) => statusBadge(r.effectiveFrom),
    },
    {
      key: "actions",
      label: "",
      width: "120px",
      align: "right",
      render: (_v, r) => (
        <div className="flex items-center justify-end gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setEditingRule(r.group.representative);
            }}
            title="Edit this combo in place"
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-[#6B5C32] text-white hover:bg-[#5A4E2A] transition-colors"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setHistoryKey(r.key);
            }}
            title="View this combo's full effective-dated history"
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium bg-white text-[#6B5C32] border border-[#D4CCB4] hover:bg-[#F4F0E8] transition-colors"
          >
            <History className="h-3 w-3" />
            {r.historyCount}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              void handleDelete(r.group.representative.id);
            }}
            title="Delete this combo rule"
            className="p-1 rounded-md text-[#9A3A2D] hover:bg-[#F9E1DA] transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ),
    },
  ];

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
      <div className="flex items-center justify-between flex-wrap gap-2">
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

      {/* Selection toolbar — appears once combos are picked. Copy them to a
          company (picker top-right) or batch-edit their prices. */}
      {selectedRows.length > 0 && (
        <Card>
          <CardContent className="p-3">
            <div className="flex items-center gap-2 flex-wrap justify-end">
              <span className="text-sm font-medium text-[#1F1D1B] mr-auto">
                {selectedRows.length} combo{selectedRows.length === 1 ? "" : "s"} selected
              </span>
              <select
                value={copyCompanyId}
                onChange={(e) => setCopyCompanyId(e.target.value)}
                disabled={copyBusy}
                className="h-9 rounded-md border border-[#E2DDD8] bg-white px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6B5C32]"
                title="Company to copy the selected combos to"
              >
                <option value="">Copy to company…</option>
                {customers.map((cu) => (
                  <option key={cu.id} value={cu.id}>
                    {cu.name}
                  </option>
                ))}
              </select>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleCopyToCompany()}
                disabled={!copyCompanyId || copyBusy}
              >
                {copyBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
                Copy
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowBatchEdit(true)}
                disabled={copyBusy}
              >
                <Pencil className="h-4 w-4" /> Batch Edit
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelectedRows([])} disabled={copyBusy}>
                Clear
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Excel-like combo listing. Sortable, filterable, grouped by base
          model; multi-select drives the copy / batch-edit toolbar above. */}
      <Card>
        <CardContent className="p-0">
          <DataGrid<ComboRow>
            columns={comboColumns}
            data={comboRows}
            keyField="key"
            gridId="sofa-combos"
            groupBy="baseModel"
            selectable
            onSelectionChange={setSelectedRows}
            onDoubleClick={(r) => setEditingRule(r.group.representative)}
            emptyMessage={'No combo rules yet. Click "New Combo" to add one.'}
            stickyHeader
            maxHeight="calc(100vh - 360px)"
          />
        </CardContent>
      </Card>

      {/* Per-combo history dialog */}
      {historyRules && historyRules.length > 0 && (
        <SofaComboHistoryDialog
          rules={historyRules as unknown as SofaComboHistoryRule[]}
          onClose={() => setHistoryKey(null)}
          refresh={() => {
            invalidateCachePrefix("/api/sofa-combos");
            refreshRules();
          }}
        />
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

      {/* Edit dialog — same component, fed an editingRule. */}
      {editingRule && (
        <CreateComboDialog
          baseModels={baseModels}
          sizesByBaseModel={sizesByBaseModel}
          customers={customers}
          editingRule={editingRule}
          onClose={() => setEditingRule(null)}
          onSaved={() => {
            invalidateCachePrefix("/api/sofa-combos");
            refreshRules();
            setEditingRule(null);
          }}
        />
      )}

      {/* Batch edit dialog — schedule a price change across the selected combos. */}
      {showBatchEdit && selectedRows.length > 0 && (
        <BatchEditDialog
          rows={selectedRows}
          onClose={() => setShowBatchEdit(false)}
          onDone={(ok, fail) => {
            invalidateCachePrefix("/api/sofa-combos");
            refreshRules();
            if (fail === 0) {
              toast.success(`Scheduled a new price on ${ok} row${ok === 1 ? "" : "s"}.`);
              setShowBatchEdit(false);
              setSelectedRows([]);
            } else {
              toast.error(`Applied ${ok}, failed ${fail}. Adjust and retry.`);
            }
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Batch edit dialog — schedule a price change across several combos at once.
// Each selected combo gets a NEW effective-dated row (append-only) for every
// customer the card represents, so existing orders stay untouched. Fabric tier
// and components are intentionally NOT batch-editable — they define the combo's
// identity; changing them would make a different combo, not edit this one.
// ---------------------------------------------------------------------------
function BatchEditDialog({
  rows,
  onClose,
  onDone,
}: {
  rows: ComboRow[];
  onClose: () => void;
  onDone: (ok: number, fail: number) => void;
}) {
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [mode, setMode] = useState<"percent" | "set">("percent");
  const [percent, setPercent] = useState("");
  const [setRm, setSetRm] = useState("");
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  // Compute the new price map for a combo from its CURRENT active prices.
  function computeNewPrices(current: Record<string, number>): Record<string, number> | null {
    const out: Record<string, number> = {};
    if (mode === "percent") {
      const pct = Number(percent);
      if (!Number.isFinite(pct)) return null;
      for (const [h, sen] of Object.entries(current)) {
        out[h] = Math.max(0, Math.round(sen * (1 + pct / 100)));
      }
    } else {
      const rm = Number(setRm);
      if (!Number.isFinite(rm) || rm < 0) return null;
      const sen = Math.round(rm * 100);
      for (const h of Object.keys(current)) out[h] = sen;
    }
    return out;
  }

  // Live preview off the first selected combo.
  const preview = rows[0];
  const previewNew = preview ? computeNewPrices(preview.group.representative.pricesByHeight) : null;

  async function handleApply() {
    setErr(null);
    if (!effectiveFrom) {
      setErr("Pick an effective date");
      return;
    }
    if (mode === "percent") {
      if (!percent.trim() || !Number.isFinite(Number(percent))) {
        setErr("Enter a percentage, e.g. 5 (raise) or -10 (cut)");
        return;
      }
    } else if (!setRm.trim() || !Number.isFinite(Number(setRm)) || Number(setRm) < 0) {
      setErr("Enter a non-negative price");
      return;
    }

    // One new row per (combo × distinct customer the card covers).
    const jobs: Record<string, unknown>[] = [];
    for (const row of rows) {
      const rep = row.group.representative;
      const newPrices = computeNewPrices(rep.pricesByHeight);
      if (!newPrices || Object.keys(newPrices).length === 0) continue;
      const customerIds = Array.from(new Set(row.group.rules.map((r) => r.customerId)));
      for (const cid of customerIds) {
        jobs.push({
          baseModel: rep.baseModel,
          componentSizes: rep.componentSizes,
          fabricTier: rep.fabricTier,
          pricesByHeight: newPrices,
          effectiveFrom,
          notes: rep.notes || null,
          customerId: cid,
        });
      }
    }
    if (jobs.length === 0) {
      setErr("Nothing to update — the selected combos have no prices set.");
      return;
    }

    setSaving(true);
    setProgress({ done: 0, total: jobs.length });
    let ok = 0;
    let fail = 0;
    for (let i = 0; i < jobs.length; i++) {
      try {
        const res = await fetch("/api/sofa-combos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(jobs[i]),
        });
        const j = (await res.json().catch(() => ({}))) as ApiSingle<unknown>;
        if (res.ok && j.success) ok++;
        else fail++;
      } catch {
        fail++;
      }
      setProgress({ done: i + 1, total: jobs.length });
    }
    setSaving(false);
    onDone(ok, fail);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={() => !saving && onClose()} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between p-5 border-b border-[#E2DDD8]">
          <h2 className="text-lg font-semibold text-[#1F1D1B]">
            Batch Edit — {rows.length} combo{rows.length === 1 ? "" : "s"}
          </h2>
          <button
            type="button"
            onClick={() => !saving && onClose()}
            className="text-[#9CA3AF] hover:text-[#374151]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-xs text-[#6B7280]">
            Schedules a new price on every selected combo from the date below.
            Past orders are never touched — this appends a fresh effective-dated
            row (the old price stays in History).
          </p>

          <div>
            <label className="block text-xs font-medium text-[#374151] mb-1">Price change</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setMode("percent")}
                className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${
                  mode === "percent"
                    ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                    : "bg-white text-[#6B7280] border-[#E2DDD8] hover:bg-[#F3F4F6]"
                }`}
              >
                Adjust by %
              </button>
              <button
                type="button"
                onClick={() => setMode("set")}
                className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${
                  mode === "set"
                    ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                    : "bg-white text-[#6B7280] border-[#E2DDD8] hover:bg-[#F3F4F6]"
                }`}
              >
                Set all heights
              </button>
            </div>
          </div>

          {mode === "percent" ? (
            <div>
              <label className="block text-xs font-medium text-[#374151] mb-1">
                Percentage (e.g. 5 to raise, -10 to cut)
              </label>
              <Input
                type="number"
                step="0.1"
                placeholder="5"
                value={percent}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setPercent(e.target.value)}
              />
            </div>
          ) : (
            <div>
              <label className="block text-xs font-medium text-[#374151] mb-1">
                New price for every priced height (RM)
              </label>
              <Input
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={setRm}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => setSetRm(e.target.value)}
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-[#374151] mb-1">Effective From</label>
            <Input
              type="date"
              value={effectiveFrom}
              onChange={(e) => setEffectiveFrom(e.target.value)}
            />
          </div>

          {preview && previewNew && (
            <div className="rounded-md border border-[#E2DDD8] bg-[#FAF9F7] p-3 text-xs">
              <div className="font-medium text-[#374151] mb-1">
                Preview — {preview.baseModel} ({preview.components})
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {Object.keys(preview.group.representative.pricesByHeight).map((h) => (
                  <span key={h} className="text-[#6B7280]">
                    {h}:{" "}
                    <span className="line-through">
                      {fmtPriceCell(preview.group.representative.pricesByHeight[h])}
                    </span>{" "}
                    <span className="font-medium text-[#1F1D1B]">{fmtPriceCell(previewNew[h])}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {err && (
            <div className="rounded-md border border-[#E8B2A1] bg-[#F9E1DA] px-3 py-2 text-sm text-[#9A3A2D]">
              {err}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 p-5 border-t border-[#E2DDD8]">
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void handleApply()} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {progress ? `Applying ${progress.done}/${progress.total}…` : "Applying…"}
              </>
            ) : (
              <>
                <Pencil className="h-4 w-4" />
                Apply to {rows.length}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Combo form dialog — used for BOTH create and edit. When `editingRule` is
// provided, the form pre-fills from that row + submits via PUT to update
// in-place. When omitted, the form starts blank + submits via POST (one
// per selected customer when multi-select is used).
// ---------------------------------------------------------------------------
function CreateComboDialog({
  baseModels,
  sizesByBaseModel,
  customers,
  onClose,
  onSaved,
  editingRule,
}: {
  baseModels: string[];
  sizesByBaseModel: Record<string, string[]>;
  customers: Customer[];
  onClose: () => void;
  onSaved: () => void;
  editingRule?: SofaComboRule | null;
}) {
  const SEAT_HEIGHTS = useSofaSeatHeights();
  const isEdit = !!editingRule;

  // Helpers to derive initial state from an editingRule.
  const initialGroups: string[][] = (() => {
    if (!editingRule) return [[]];
    const sizes = editingRule.componentSizes;
    if (!Array.isArray(sizes) || sizes.length === 0) return [[]];
    if (Array.isArray(sizes[0])) return (sizes as string[][]).map((g) => [...g]);
    return [(sizes as string[]).slice()];
  })();
  const initialPricesRm: Record<string, string> = (() => {
    if (!editingRule) return {};
    const out: Record<string, string> = {};
    for (const [h, sen] of Object.entries(editingRule.pricesByHeight)) {
      out[h] = (Number(sen) / 100).toFixed(2);
    }
    return out;
  })();
  const initialCustomerIds: Set<string> = editingRule?.customerId
    ? new Set([editingRule.customerId])
    : new Set();

  const [baseModel, setBaseModel] = useState<string>(
    editingRule?.baseModel ?? baseModels[0] ?? "",
  );
  // Explicit OR-group editor: each compartment is one group of "any-of"
  // modules. Across compartments must all match (AND). Default: one empty
  // compartment so the operator immediately sees the structure.
  const [groups, setGroups] = useState<string[][]>(initialGroups);
  const [fabricTier, setFabricTier] = useState<FabricTier>(
    editingRule?.fabricTier ?? "ANY",
  );
  const [pricesRm, setPricesRm] = useState<Record<string, string>>(initialPricesRm);
  // Multi-select: empty Set = company-wide; 1+ ids = create one row per
  // selected customer (server is single-customerId per row, frontend loops).
  // Edit mode: customer is single (PUT updates one row), multi-select UI
  // still works but only first selection is honored.
  const [customerIds, setCustomerIds] = useState<Set<string>>(initialCustomerIds);
  const [effectiveFrom, setEffectiveFrom] = useState(
    editingRule?.effectiveFrom ?? todayIso(),
  );
  const [notes, setNotes] = useState(editingRule?.notes ?? "");
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

  // Reset compartments when baseModel changes — old selection won't match
  // the new model's size set. Skip in edit mode on first render so the
  // pre-filled groups from editingRule survive (they came from the same
  // baseModel anyway). Subsequent baseModel edits in either mode reset.
  const baseModelMounted = useRef(false);
  useEffect(() => {
    if (isEdit && !baseModelMounted.current) {
      baseModelMounted.current = true;
      return;
    }
    setGroups([[]]);
  }, [baseModel, isEdit]);

  function toggleSizeInGroup(groupIdx: number, sz: string) {
    setGroups((prev) =>
      prev.map((g, i) =>
        i === groupIdx
          ? g.includes(sz)
            ? g.filter((s) => s !== sz)
            : [...g, sz]
          : g,
      ),
    );
  }
  function addGroup() {
    setGroups((prev) => [...prev, []]);
  }
  function removeGroup(idx: number) {
    setGroups((prev) =>
      prev.length <= 1 ? [[]] : prev.filter((_, i) => i !== idx),
    );
  }

  async function handleSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(null);

    if (!baseModel) {
      setErr("Select a base model");
      return;
    }
    // Drop empty compartments and dedupe; bail out if nothing usable left.
    const cleanedGroups: string[][] = groups
      .map((g) => Array.from(new Set(g)).slice().sort())
      .filter((g) => g.length > 0);
    if (cleanedGroups.length === 0) {
      setErr("Add at least one compartment with at least one module");
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

    // Storage shape on componentSizes is string[][] — one entry per
    // compartment. Within a compartment any module qualifies (OR);
    // across compartments every group must have a match (AND). Sort
    // across compartments so equivalent shapes hash to the same JSON.
    const componentSizeGroups: string[][] = cleanedGroups
      .slice()
      .sort((a, b) => a[0].localeCompare(b[0]));

    setSaving(true);
    try {
      const baseBody = {
        baseModel,
        componentSizes: componentSizeGroups,
        fabricTier,
        pricesByHeight,
        effectiveFrom,
        notes: notes.trim() || null,
      };
      if (isEdit && editingRule) {
        // SMART SAVE — only "scheduling a new effective-dated price"
        // creates a new row. Everything else updates in place to avoid
        // duplicate rows at the same date.
        //
        //   - Date CHANGED + Price CHANGED → POST (new history event:
        //     scheduling a new price for a new date).
        //   - Date CHANGED, Price SAME      → PUT (date typo / shift).
        //   - Date SAME, Price CHANGED      → PUT (correcting a wrong
        //     price for the SAME date — there can only be one price
        //     per date in the timeline).
        //   - Both SAME                     → PUT (metadata-only edit).
        //
        // Customer broadcast: additional selected customers always POST
        // new rows (one per customer) regardless of edit mode.
        const selectedCustomers = Array.from(customerIds);
        const primaryCustomerId: string | null =
          selectedCustomers.length === 0
            ? null
            : (selectedCustomers[0] ?? null);
        const additionalCustomerIds = selectedCustomers.slice(1);
        const dateChanged = effectiveFrom !== editingRule.effectiveFrom;
        const pricesChanged =
          JSON.stringify(pricesByHeight) !==
          JSON.stringify(editingRule.pricesByHeight);
        const shouldPostNewRow = dateChanged && pricesChanged;

        // 1. Save THIS row.
        if (shouldPostNewRow) {
          // POST a new row — operator is scheduling a new effective-
          // dated price change. Old row preserved as Past.
          const postR = await fetch("/api/sofa-combos", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...baseBody, customerId: primaryCustomerId }),
          });
          const postJson = (await postR.json().catch(() => ({}))) as ApiSingle<unknown>;
          if (!postR.ok || !postJson.success) {
            setErr(postJson.error ?? "Failed to add new effective-dated row");
            setSaving(false);
            return;
          }
        } else {
          // PUT in place — date OR price typo correction (or metadata-
          // only edit). No duplicate row at same date.
          const putR = await fetch(`/api/sofa-combos/${editingRule.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...baseBody, customerId: primaryCustomerId }),
          });
          const putJson = (await putR.json().catch(() => ({}))) as ApiSingle<unknown>;
          if (!putR.ok || !putJson.success) {
            setErr(putJson.error ?? "Failed to update combo rule");
            setSaving(false);
            return;
          }
        }

        // 2. Broadcast: POST a clone for each additional customer.
        for (const cid of additionalCustomerIds) {
          const postR = await fetch("/api/sofa-combos", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...baseBody, customerId: cid }),
          });
          const postJson = (await postR.json().catch(() => ({}))) as ApiSingle<unknown>;
          if (!postR.ok || !postJson.success) {
            setErr(
              `Saved this row, but failed to broadcast to additional customer ${cid}: ${postJson.error ?? "unknown error"}`,
            );
            setSaving(false);
            return;
          }
        }
      } else {
        // Create mode: fire one POST per selected customer (or one with
        // null for company-wide). Stop on first failure so the operator
        // sees the error rather than half-applying the change.
        const targets: (string | null)[] =
          customerIds.size === 0 ? [null] : Array.from(customerIds);
        const results = await Promise.all(
          targets.map((cid) =>
            fetch("/api/sofa-combos", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...baseBody, customerId: cid }),
            }).then(async (r) => ({
              ok: r.ok,
              json: (await r.json().catch(() => ({}))) as ApiSingle<unknown>,
            })),
          ),
        );
        const failed = results.find((r) => !r.ok || !r.json.success);
        if (failed) {
          setErr(failed.json.error ?? "Failed to create combo rule");
          setSaving(false);
          return;
        }
      }
      onSaved();
    } catch (ex) {
      setErr(humanizeError(ex, "Couldn't save. Please try again."));
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <CardHeader className="pb-3 sticky top-0 bg-white z-10 border-b border-[#E2DDD8]">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">{isEdit ? "Edit Sofa Combo" : "New Sofa Combo"}</CardTitle>
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

            {/* Component sizes — one compartment = one OR-group.
                Within a compartment any checked module satisfies it (OR).
                Across compartments every group needs a match (AND). */}
            <div>
              <label className="block text-xs font-medium text-[#374151] mb-1">
                Components
              </label>
              <p className="text-[11px] text-[#6B7280] mb-2">
                Each compartment is an <b>OR</b> group (any one module
                satisfies it). Compartments are joined by <b>AND</b>.
                Example: <i>Compartment A: 2A(LHF) / 2A(RHF) <b>+</b>
                Compartment B: L(LHF) / L(RHF)</i>.
              </p>
              {availableSizes.length === 0 ? (
                <p className="text-xs text-[#9CA3AF] italic">
                  Pick a base model first to see its modules.
                </p>
              ) : (
                <div className="space-y-2">
                  {groups.map((group, gIdx) => (
                    <div
                      key={gIdx}
                      className="rounded-md border border-[#E2DDD8] bg-[#FAF9F7] p-2"
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[11px] font-semibold text-[#6B5C32] uppercase tracking-wide">
                          Compartment {String.fromCharCode(65 + gIdx)} (any of)
                        </span>
                        <button
                          type="button"
                          onClick={() => removeGroup(gIdx)}
                          disabled={groups.length <= 1}
                          className="text-[11px] text-[#9A3A2D] hover:underline disabled:text-[#9CA3AF] disabled:no-underline"
                        >
                          Remove
                        </button>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {availableSizes.map((sz) => {
                          const checked = group.includes(sz);
                          return (
                            <label
                              key={sz}
                              className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs cursor-pointer transition-colors ${
                                checked
                                  ? "bg-[#EEF3E4] border-[#C6DBA8] text-[#4F7C3A]"
                                  : "bg-white border-[#E2DDD8] text-[#4B5563] hover:bg-[#F3F4F6]"
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleSizeInGroup(gIdx, sz)}
                                className="h-3 w-3"
                              />
                              {sz}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={addGroup}
                    className="inline-flex items-center gap-1 text-xs text-[#6B5C32] hover:underline"
                  >
                    <Plus className="h-3 w-3" /> Add Compartment
                  </button>
                </div>
              )}
              {groups.some((g) => g.length > 0) && (
                <p className="text-xs text-[#6B7280] mt-2">
                  Combo:{" "}
                  {groups
                    .filter((g) => g.length > 0)
                    .map((g) => [...g].sort().join(" / "))
                    .join(" + ")}
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
                      type="number" onFocus={(e) => e.currentTarget.select()}
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

            {/* Customer multi-select */}
            <div>
              <label className="block text-xs font-medium text-[#374151] mb-1">
                Customers
              </label>
              <p className="text-[11px] text-[#6B7280] mb-2">
                {isEdit ? (
                  <>
                    Edit mode: THIS row's customer is updated to the FIRST
                    selected customer (or company-wide if none). Selecting
                    additional customers BROADCASTS a clone of this combo
                    to each of them as a new row.
                  </>
                ) : (
                  <>
                    Pick none → company-wide (visible to every customer). Pick
                    one or more → creates a separate combo row for each
                    selected customer (only those customers see the deal).
                  </>
                )}
              </p>
              <div className="flex items-center gap-2 mb-2">
                <button
                  type="button"
                  onClick={() => setCustomerIds(new Set())}
                  className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                    customerIds.size === 0
                      ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                      : "bg-white text-[#6B7280] border-[#E2DDD8] hover:bg-[#F3F4F6]"
                  }`}
                >
                  Company-wide
                </button>
                <button
                  type="button"
                  onClick={() => setCustomerIds(new Set(customers.map((c) => c.id)))}
                  className="text-xs px-2.5 py-1 rounded-md border bg-white text-[#6B7280] border-[#E2DDD8] hover:bg-[#F3F4F6]"
                >
                  Select all customers
                </button>
                {customerIds.size > 0 && (
                  <span className="text-[11px] text-[#6B5C32] font-medium">
                    {customerIds.size} selected
                  </span>
                )}
              </div>
              <div className="max-h-40 overflow-y-auto rounded-md border border-[#E2DDD8] bg-white p-2">
                {customers.length === 0 ? (
                  <p className="text-xs text-[#9CA3AF] italic">No customers.</p>
                ) : (
                  <div className="grid grid-cols-2 gap-1">
                    {customers.map((cu) => {
                      const checked = customerIds.has(cu.id);
                      return (
                        <label
                          key={cu.id}
                          className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs cursor-pointer transition-colors ${
                            checked
                              ? "bg-[#EEF3E4] text-[#4F7C3A]"
                              : "text-[#4B5563] hover:bg-[#F3F4F6]"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setCustomerIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(cu.id)) next.delete(cu.id);
                                else next.add(cu.id);
                                return next;
                              });
                            }}
                            className="h-3 w-3"
                          />
                          {cu.name}
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Effective from + notes */}
            <div className="flex items-start gap-2 rounded border border-[#E8D597] bg-[#FAEFCB] px-3 py-2 text-xs text-[#6B5C32]">
              <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>{OLD_SO_SAFE_BANNER}</span>
            </div>
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
                    {isEdit ? "Save Changes" : "Save Combo"}
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
  const { confirm } = useConfirm();

  async function handleCopy() {
    if (!selectedId) return;
    const target = customers.find((c) => c.id === selectedId);
    if (
      !target ||
      !(await confirm({
        title: "Copy combos to company?",
        message: `Copy every company-wide combo into ${target.name}? Already-copied combos are skipped (idempotent).`,
      }))
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
