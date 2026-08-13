import { useState, useEffect, useMemo, useRef } from "react";
import { useToast } from "@/components/ui/toast";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { useSOMode, soBasePath, soSingularNoun } from "@/lib/so-mode";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { calculateUnitPrice, formatOrderLineUnit } from "@/lib/pricing";
import { deriveTotalHeightSurchargeSen } from "@/lib/total-height-surcharge";
import type { CfgHeight } from "@/lib/height-surcharge";
import {
  hasMixedSofaBedframe,
  SO_MIXED_CATEGORY_ERROR,
  findInvalidSofaQty,
  formatSofaQtyError,
} from "@/lib/so-category";
import { ArrowLeft, Plus, Trash2, Save, AlertTriangle, ChevronDown, ChevronUp, X } from "lucide-react";
import { DiscountInput } from "@/components/ui/discount-input";
import type { Customer, Product, FabricItem, SalesOrder } from "@/types";
import {
  SEAT_HEIGHT_OPTIONS,
  legHeightOptions,
  specialOrderOptions,
} from "@/lib/pricing-options";
import { fetchVariantsConfig, getVariantsConfigSync, subscribeKvConfig, VARIANTS_CONFIG_KEY } from "@/lib/kv-config";
import { useCachedJson, invalidateCache, invalidateCachePrefix, isUnknownOutcome } from "@/lib/cached-fetch";
import { RecordLoadError } from "@/components/ui/record-load-error";
import { verifiedSave, formatMismatchError } from "@/lib/verified-save";
import { LockBanner } from "@/components/ui/lock-banner";
import { RepairScopePicker, RepairScopeBadge } from "@/components/sales/repair-scope-picker";
import { usePresence } from "@/lib/use-presence";
import { PresenceBanner } from "@/components/presence-banner";
import { useUnsavedChanges } from "@/lib/use-unsaved-changes";

// Free-text custom special order on a SO line (migration 0074). Operator-typed
// description + surcharge for edge cases not in the master Specials config.
// Folded into specialOrderPriceSen and suffixed into the `specialOrder` text
// column as "OTHER: <desc>" so legacy display paths render them as-is.
type CustomSpecial = { description: string; surchargeSen: number };

type LineItem = {
  id?: string;
  // Client-only stable id for React keys when `id` is absent (newly added
  // rows). Stripped before save. Sprint 7.
  _uid?: string;
  productId: string;
  productCode: string;
  productName: string;
  itemCategory: string;
  baseModel: string;
  sizeCode: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  basePriceSen: number;
  seatHeight: string;
  gapInches: number | null;
  divanHeightInches: number | null;
  divanPriceSen: number;
  legHeightInches: number | null;
  legPriceSen: number;
  // The FIFTH price component (migration 0209, own stored column
  // sales_order_items.total_height_price_sen). It used to be absent from this
  // page entirely: the PUT derives it server-side when the client omits the
  // field, so the screen showed base+divan+leg+special while the save stored
  // that PLUS the total-height surcharge. Carried in state and posted back so
  // what this page displays is what it saves.
  totalHeightPriceSen: number;
  specialOrders: string[];
  specialOrder: string;
  specialOrderPriceSen: number;
  customSpecials: CustomSpecial[];
  notes: string;
  // Per-line discount (migration 0179). In sen; 0 = no discount.
  discountSen: number;
  // Service-order Repair Scope (0160). The edit page has no scope picker —
  // it just round-trips the stored value through the PUT payload so an SO
  // edit can't silently wipe a line's scope. Picker lives on the create
  // page (service-order mode).
  repairScope?: string | null;
};

const EMPTY_LINE: LineItem = {
  productId: "", productCode: "", productName: "", itemCategory: "", baseModel: "",
  sizeCode: "", sizeLabel: "", fabricCode: "",
  quantity: 1, basePriceSen: 0, seatHeight: "",
  gapInches: null, divanHeightInches: null, divanPriceSen: 0,
  legHeightInches: null, legPriceSen: 0, totalHeightPriceSen: 0,
  specialOrders: [], specialOrder: "", specialOrderPriceSen: 0,
  customSpecials: [], notes: "",
  discountSen: 0,
  repairScope: null,
};

/** Parse inches from a height string like '14"', '10.5"', or 'No Leg'.
 * Accepts decimals so a Maintenance-config value like 15.5" round-trips
 * through the dropdown without truncation. */
function parseInches(h: string): number | null {
  const m = h.match(/^(\d+(?:\.\d+)?)"/);
  return m ? parseFloat(m[1]) : null;
}

function calcSpecialOrderSurcharge(codes: string[]): number {
  const hasHB = codes.includes("HB_FULL_COVER");
  const hasBtm = codes.includes("DIVAN_BTM_COVER");
  let total = 0;
  for (const code of codes) {
    const opt = specialOrderOptions.find(o => o.code === code);
    if (!opt) continue;
    if (hasHB && hasBtm && (code === "HB_FULL_COVER" || code === "DIVAN_BTM_COVER")) continue;
    total += opt.surcharge;
  }
  if (hasHB && hasBtm) total += 10000;
  return total;
}

/** Extract FT portion from sizeLabel, e.g. "Queen 5FT" → "5FT" */
function extractSizeSuffix(sizeLabel: string): string {
  const m = sizeLabel.match(/(\d[\d.x]*(?:FT|CM))/i);
  return m ? m[1] : sizeLabel;
}

/** Parse a sofa productCode like "5531-1A(LHF)" → { baseModel: "5531", module: "1A(LHF)" }.
 *  Falls back to the full code when no hyphen is present. */
function parseSofaCode(code: string): { baseModel: string; module: string } {
  const m = code.match(/^([^-]+)-(.+)$/);
  return m ? { baseModel: m[1], module: m[2] } : { baseModel: code, module: "" };
}

/** Generate WIP items for a bedframe line item */
function generateBedframeWIPs(item: LineItem): { code: string; type: string; qty: number }[] {
  if (!item.baseModel || !item.sizeCode) return [];
  const totalHeight = (item.gapInches || 0) + (item.divanHeightInches || 0) + (item.legHeightInches || 0);
  const sizeSuffix = extractSizeSuffix(item.sizeLabel);
  const wips: { code: string; type: string; qty: number }[] = [];
  if (totalHeight > 0) {
    wips.push({ code: `${item.baseModel}(${item.sizeCode})-HB${totalHeight}"`, type: "HB", qty: 1 });
  }
  if (item.divanHeightInches && item.divanHeightInches > 0) {
    wips.push({ code: `${item.divanHeightInches}" Divan-${sizeSuffix}`, type: "DIVAN", qty: 2 });
  }
  return wips;
}

/** Generate WIP items for a sofa line item */
function generateSofaWIPs(item: LineItem): { code: string; type: string; qty: number }[] {
  if (!item.baseModel || !item.seatHeight) return [];
  const heightNum = item.seatHeight.replace('"', '');
  const wips: { code: string; type: string; qty: number }[] = [];
  wips.push({ code: `${item.productCode}-${heightNum}-BASE`, type: "BASE", qty: 1 });
  wips.push({ code: `${item.baseModel}-${heightNum}-CUSHION`, type: "CUSHION", qty: 1 });
  if (item.sizeCode.includes("A")) {
    wips.push({ code: `${item.productCode}-${heightNum}-ARM`, type: "ARM", qty: 1 });
  }
  return wips;
}

type EditEligibility = {
  success?: boolean;
  editable: boolean;
  reason?: "status" | "production_window" | "dept_completed";
  status?: string;
  earliestStartDate?: string;
  cutoffDate?: string;
  completedDept?: string;
  completedAt?: string;
};

/** Format an ISO date (YYYY-MM-DD or full timestamp) as "27 Apr 2026". */
function formatLockDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default function EditSalesOrderPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  // 0134 — flips this edit form between regular Sales Order mode and
  // Service Order mode (route-derived). Only navigates + header copy
  // differ; the PUT body preserves isServiceOrder from the row, so we
  // don't override it here.
  const mode = useSOMode();
  const basePath = soBasePath(mode);
  // 0134 — Service Order mode: every variant/option surcharge is RM 0.
  // Toggling a special order or picking a new divan/leg height while
  // editing a Service Order must NOT silently re-introduce the catalog
  // surcharge — operator types Base Price directly. Mirrors create.tsx.
  const isServiceOrderMode = mode === "service-order";
  // Override token forwarded from the SO detail page when an admin
  // overrode the Rule-3 production_window lock. Survives a single
  // navigation through router state, NOT through query params or
  // localStorage — refresh / back-button correctly drops the token so a
  // stale FE cannot replay it. Also captured as a local const so the
  // dirty-state callback closure doesn't re-read on every keystroke.
  const overrideTokenFromState =
    (location.state as { overrideToken?: string } | null)?.overrideToken ??
    null;
  const otherEditors = usePresence("sales_order", id, Boolean(id));
  // Catalog endpoints — opt into focus revalidation so adding a new product /
  // fabric / customer in Maintenance becomes visible without a hard refresh.
  // Cross-tab BroadcastChannel + same-tab invalidate-listener (via cached-fetch)
  // already cover the active mutation path; revalidateOnFocus is the safety
  // net for edge cases (e.g. Maintenance edit happened in a window that's now
  // closed / on another device pointing at the same backend).
  const CAT_OPTS = { revalidateOnFocus: true };
  const { data: customersResp } = useCachedJson<{ data?: Customer[] }>("/api/customers", 300, CAT_OPTS);
  const { data: productsResp } = useCachedJson<{ data?: Product[] }>("/api/products", 300, CAT_OPTS);
  // Fabric picker now reads from /api/fabric-tracking (sourced from
  // raw_materials, the inventory source of truth) — the legacy /api/fabrics
  // table has stale leading-zero duplicates (M2402-04 vs M2402-4) which let
  // operators pick fabrics that don't actually exist in inventory, leaving
  // POs with orphan fabricCodes. We map the tracking shape back to the
  // legacy FabricItem at the boundary so downstream picker logic is
  // unchanged.
  const { data: fabricsTrackingForPickerResp } = useCachedJson<{ data?: { id: string; fabricCode: string; fabricDescription?: string; fabricCategory?: string }[] }>("/api/fabric-tracking", 300, CAT_OPTS);
  // Same CONFIRMED-only rule as sales/create.tsx - an edit must not be able to
  // re-point an order at an unbillable account either.
  const customers: Customer[] = useMemo(
    () =>
      (customersResp?.data || []).filter(
        (c) => (c.customerStage ?? "CONFIRMED") !== "POTENTIAL",
      ),
    [customersResp],
  );
  const products: Product[] = useMemo(() => productsResp?.data || [], [productsResp]);
  const fabrics: FabricItem[] = useMemo(
    () => (fabricsTrackingForPickerResp?.data || []).map(t => ({
      id: t.id,
      code: t.fabricCode,
      name: t.fabricDescription || "",
      category: t.fabricCategory || "",
      priceSen: 0,
      sohMeters: 0,
      reorderLevel: 0,
    })),
    [fabricsTrackingForPickerResp],
  );
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [order, setOrder] = useState<SalesOrder | null>(null);

  const [customerId, setCustomerId] = useState("");
  const [customerPOId, setCustomerPOId] = useState("");
  const [customerSOId, setCustomerSOId] = useState("");
  const [reference, setReference] = useState("");
  const [companySODate, setCompanySODate] = useState("");
  const [customerDeliveryDate, setCustomerDeliveryDate] = useState("");
  const [hookkaExpectedDD, setHookkaExpectedDD] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<LineItem[]>([{ ...EMPTY_LINE, _uid: crypto.randomUUID() }]);
  const [maintenanceConfig, setMaintenanceConfig] = useState<Record<string, unknown> | null>(getVariantsConfigSync());
  const [showSpecialOrdersIdx, setShowSpecialOrdersIdx] = useState<number | null>(null);

  // Compare the current form state against what was loaded; dirty = the
  // user has typed something that hasn't been saved. We compute a coarse
  // fingerprint rather than deep-equal each line item — perf doesn't matter
  // here, but a stable string makes the memo dep simple. The order's own
  // fingerprint is captured once when it loads so save→navigate cleanly
  // resets the flag (the page unmounts and useActiveTabDirty cleans up).
  const formSig = useMemo(
    () => JSON.stringify({
      customerId, customerPOId, customerSOId, reference,
      companySODate, customerDeliveryDate, hookkaExpectedDD, notes,
      items: items.map((it) => ({
        productId: it.productId, fabricCode: it.fabricCode, quantity: it.quantity,
        seatHeight: it.seatHeight, gapInches: it.gapInches,
        divanHeightInches: it.divanHeightInches,
        legHeightInches: it.legHeightInches,
        specialOrders: it.specialOrders,
        customSpecials: it.customSpecials,
        notes: it.notes,
        repairScope: it.repairScope ?? null,
      })),
    }),
    [
      customerId, customerPOId, customerSOId, reference,
      companySODate, customerDeliveryDate, hookkaExpectedDD, notes, items,
    ],
  );
  const [initialSig, setInitialSig] = useState<string | null>(null);
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- one-shot baseline snapshot when the loaded order arrives; deliberately excludes formSig so later edits don't reset the baseline */
  useEffect(() => {
    if (!loading && order && initialSig === null) {
      setInitialSig(formSig);
    }
  }, [loading, order, initialSig]);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  const isDirty =
    !saving && !loading && initialSig !== null && initialSig !== formSig;
  useUnsavedChanges(isDirty);

  // Customer-aware variants-config — read-time merge (added 2026-05-06,
  // same fix as sales/create.tsx):
  //   * No customer → master `variants-config`.
  //   * Customer → MERGE master + customer snapshot. Customer overrides
  //     master per-`value`; master entries the customer doesn't have
  //     (i.e. newly-added master variants) flow through automatically.
  //
  // [variantsTick] is bumped whenever a kv-config change is received
  // (cross-tab via BroadcastChannel, or same-tab via subscribeKvConfig).
  // Bumping forces this effect to re-run so the dropdowns reflect the
  // new specials / heights / sizes the operator just added in Maintenance.
  const [variantsTick, setVariantsTick] = useState(0);
  useEffect(() => {
    const unsubMaster = subscribeKvConfig(VARIANTS_CONFIG_KEY, () => setVariantsTick((t) => t + 1));
    const unsubCustomer = customerId
      ? subscribeKvConfig(`${VARIANTS_CONFIG_KEY}:${customerId}`, () => setVariantsTick((t) => t + 1))
      : null;
    return () => {
      unsubMaster();
      if (unsubCustomer) unsubCustomer();
    };
  }, [customerId]);

  useEffect(() => {
    type CfgItem = { value?: string } & Record<string, unknown>;
    const mergeCfg = (
      master: Record<string, unknown> | null,
      customer: Record<string, unknown> | null,
    ): Record<string, unknown> | null => {
      if (!master && !customer) return null;
      const out: Record<string, unknown> = {};
      const keys = new Set([...Object.keys(master ?? {}), ...Object.keys(customer ?? {})]);
      for (const k of keys) {
        const m = master?.[k];
        const c = customer?.[k];
        if (Array.isArray(m) && Array.isArray(c)) {
          const cByValue = new Map<string, CfgItem>();
          for (const it of c as CfgItem[]) {
            if (it && typeof it.value === "string") cByValue.set(it.value, it);
          }
          const merged: CfgItem[] = [];
          const seen = new Set<string>();
          for (const it of m as CfgItem[]) {
            if (!it || typeof it.value !== "string") { merged.push(it); continue; }
            merged.push(cByValue.get(it.value) ?? it);
            seen.add(it.value);
          }
          for (const it of c as CfgItem[]) {
            if (it && typeof it.value === "string" && !seen.has(it.value)) merged.push(it);
          }
          out[k] = merged;
          continue;
        }
        if (Array.isArray(m) || Array.isArray(c)) {
          const seen = new Set<string>();
          const merged: unknown[] = [];
          for (const arr of [m, c]) {
            if (Array.isArray(arr)) for (const v of arr) {
              const key = typeof v === "string" ? v : JSON.stringify(v);
              if (seen.has(key)) continue;
              seen.add(key);
              merged.push(v);
            }
          }
          out[k] = merged;
          continue;
        }
        out[k] = c ?? m;
      }
      return out;
    };

    let cancelled = false;
    if (!customerId) {
      fetchVariantsConfig()
        .then((cfg) => { if (!cancelled) setMaintenanceConfig(cfg as Record<string, unknown> | null); })
        .catch(() => { /* ignore */ });
      return () => { cancelled = true; };
    }
    Promise.all([
      fetch("/api/kv-config/variants-config")
        .then((r) => r.json() as Promise<{ success?: boolean; data?: unknown }>)
        .then((j) => (j?.success ? (j.data as Record<string, unknown> | null) : null))
        .catch(() => null),
      fetch(`/api/kv-config/${encodeURIComponent(`variants-config:${customerId}`)}`)
        .then((r) => r.json() as Promise<{ success?: boolean; data?: unknown }>)
        .then((j) => (j?.success ? (j.data as Record<string, unknown> | null) : null))
        .catch(() => null),
    ]).then(([master, customer]) => {
      if (cancelled) return;
      setMaintenanceConfig(mergeCfg(master, customer));
    });
    return () => { cancelled = true; };
  }, [customerId, variantsTick]);

  // Surcharge lookup from maintenance config
  const getConfigSurcharge = (key: string, value: string, fallback: number): number => {
    if (!maintenanceConfig) return fallback;
    const arr = (maintenanceConfig as Record<string, unknown>)[key];
    if (!Array.isArray(arr)) return fallback;
    const found = arr.find((it: unknown) => {
      if (typeof it !== "object" || !it) return false;
      const r = it as Record<string, unknown>;
      return r.value === value || r.height === value || r.name === value;
    });
    if (found && typeof found === "object") {
      const r = found as Record<string, unknown>;
      const v = r.priceSen ?? r.surcharge;
      if (typeof v === "number") return v;
    }
    return fallback;
  };

  // Build the available special-order list from the maintenance config
  // (kv_config:variants-config). The config is the source of truth; the
  // hardcoded specialOrderOptions array is only a shape reference so we
  // can preserve the `code` + `notes` for entries that happen to match by
  // name. User-added entries (not in the hardcoded list) still show up
  // with a derived code and their saved priceSen carried through — this
  // is what the old filter-against-hardcoded approach was silently
  // dropping whenever Product Maintenance gained a new option.
  const getAvailableSpecials = (isSofa: boolean) => {
    const key = isSofa ? "sofaSpecials" : "specials";
    const cfg = maintenanceConfig?.[key];
    if (!Array.isArray(cfg) || cfg.length === 0) return specialOrderOptions;
    return cfg.map((c) => {
      const value =
        typeof c === "object" && c && "value" in c
          ? String((c as { value: unknown }).value)
          : String(c);
      const priceSen =
        typeof c === "object" && c && "priceSen" in c
          ? Number((c as { priceSen: unknown }).priceSen) || 0
          : 0;
      const matched = specialOrderOptions.find((o) => o.name === value);
      return matched
        ? { ...matched, surcharge: priceSen }
        : {
            code: value.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
            name: value,
            surcharge: priceSen,
            notes: "",
          };
    });
  };

  // Sum of custom-special surcharges, treating non-numeric / negative as 0.
  const sumCustomSpecials = (customs: CustomSpecial[]): number =>
    customs.reduce(
      (s, c) =>
        s +
        (Number.isFinite(c.surchargeSen) && c.surchargeSen > 0
          ? Math.round(c.surchargeSen)
          : 0),
      0,
    );

  // Build the joined `specialOrder` text — predefined names first, then
  // "OTHER: <desc>" tokens for each non-empty custom entry.
  const buildSpecialOrderText = (
    codes: string[],
    customs: CustomSpecial[],
  ): string => {
    const predefinedTokens = codes
      .map((c) => specialOrderOptions.find((o) => o.code === c)?.name || c);
    const customTokens = customs
      .map((c) => c.description.trim())
      .filter(Boolean)
      .map((d) => `OTHER: ${d}`);
    return [...predefinedTokens, ...customTokens].join("; ");
  };

  const calcPredefinedSurcharge = (
    codes: string[],
    isSofa: boolean,
  ): number => {
    const available = getAvailableSpecials(isSofa);
    const sumSurcharge = codes.reduce((s, c) => {
      const opt = available.find((o) => o.code === c);
      if (!opt) return s;
      return s + getConfigSurcharge(isSofa ? "sofaSpecials" : "specials", opt.name, opt.surcharge);
    }, 0);
    const combinedSurcharge = calcSpecialOrderSurcharge(codes);
    return isSofa ? sumSurcharge : combinedSurcharge;
  };

  const toggleSpecialOrder = (idx: number, code: string) => {
    const item = items[idx];
    const isSofa = item.itemCategory === "SOFA";
    const next = item.specialOrders.includes(code)
      ? item.specialOrders.filter((c) => c !== code)
      : [...item.specialOrders, code];
    // 0134 — Service Order mode: catalog surcharge stays at 0; operator's
    // manual Base Price (and the manual Special $ input) is the only price.
    const surcharge = isServiceOrderMode
      ? 0
      : calcPredefinedSurcharge(next, isSofa) + sumCustomSpecials(item.customSpecials);
    const label = buildSpecialOrderText(next, item.customSpecials);
    updateItem(idx, {
      specialOrders: next,
      specialOrder: label,
      specialOrderPriceSen: surcharge,
    });
  };

  // Apply a new customSpecials array, recomputing the joined text and the
  // total surcharge (predefined + custom). Edit page mirrors create.tsx.
  const applyCustomSpecials = (idx: number, customs: CustomSpecial[]) => {
    const item = items[idx];
    const isSofa = item.itemCategory === "SOFA";
    // 0134 — Service Order mode: variant surcharge total stays at 0.
    const surcharge = isServiceOrderMode
      ? 0
      : calcPredefinedSurcharge(item.specialOrders, isSofa) + sumCustomSpecials(customs);
    const label = buildSpecialOrderText(item.specialOrders, customs);
    updateItem(idx, {
      customSpecials: customs,
      specialOrder: label,
      specialOrderPriceSen: surcharge,
    });
  };

  const addCustomSpecial = (idx: number) => {
    const item = items[idx];
    applyCustomSpecials(idx, [
      ...item.customSpecials,
      { description: "", surchargeSen: 0 },
    ]);
  };

  const updateCustomSpecial = (
    idx: number,
    csIdx: number,
    patch: Partial<CustomSpecial>,
  ) => {
    const item = items[idx];
    const next = item.customSpecials.map((c, i) =>
      i === csIdx ? { ...c, ...patch } : c,
    );
    applyCustomSpecials(idx, next);
  };

  const removeCustomSpecial = (idx: number, csIdx: number) => {
    const item = items[idx];
    applyCustomSpecials(
      idx,
      item.customSpecials.filter((_, i) => i !== csIdx),
    );
  };

  // Load existing order + edit-eligibility verdict in parallel. The
  // eligibility check is a thin SQL-only endpoint that aggregates earliest
  // PO start + any-completed-JC across the SO's POs so the page doesn't
  // need to refetch the (much heavier) production-orders payload.
  // lockReason comes back on /:id and surfaces the cascade-lock reason
  // (e.g. "PO X is COMPLETED") so the page can disable Save + show banner.
  const { data: orderResp, failure: orderFailure, refresh: refreshOrder } = useCachedJson<{ success?: boolean; data?: SalesOrder; lockReason?: string | null }>(id ? `/api/sales-orders/${id}` : null);
  const { data: eligibilityResp } = useCachedJson<EditEligibility>(id ? `/api/sales-orders/${id}/edit-eligibility` : null);
  // Seed the form ONCE per order. Re-seeding on a later background refetch
  // (cross-tab cache invalidation, the SWR mount refetch, polling) would
  // silently wipe the operator's in-progress edits — the "mid-edit draft wipe"
  // class from the 2990s cross-audit. Marked seeded only on a successful load
  // so an error→success sequence still hydrates.
  const seededIdRef = useRef<string | null>(null);
  useEffect(() => {
    const d = orderResp;
    if (!d) {
      // no cached data yet — wait for the hook to fetch
      return;
    }
    if (seededIdRef.current === id) {
      return;
    }
    (() => {
        if (d.success) {
          seededIdRef.current = id ?? null;
          const so: SalesOrder = d.data as SalesOrder;
          setOrder(so);
          setCustomerId(so.customerId);
          setCustomerPOId(so.customerPOId || "");
          setCustomerSOId(so.customerSOId || "");
          setReference(so.reference || "");
          setCompanySODate(so.companySODate ? so.companySODate.split("T")[0] : "");
          setCustomerDeliveryDate(so.customerDeliveryDate ? so.customerDeliveryDate.split("T")[0] : "");
          setHookkaExpectedDD(so.hookkaExpectedDD ? so.hookkaExpectedDD.split("T")[0] : "");
          setNotes(so.notes || "");
          setItems(so.items.map((item: Record<string, unknown>) => {
            const productCode = (item.productCode as string) || "";
            const itemCategory = (item.itemCategory as string) || "";
            const isSofa = itemCategory === "SOFA";
            // For sofa line items:
            //   - baseModel is parsed from productCode "5531-1A(LHF)" → "5531"
            //     (the DB doesn't carry a separate baseModel column on
            //     sales_order_items; we re-derive it so the Model dropdown
            //     pre-selects on edit instead of showing blank).
            //   - seatHeight comes from sizeLabel e.g. '28"'. Scan-PO OCR
            //     ships sizeLabel as a bare number ("28") matching the
            //     SOFA Sizes catalog entry; the Seat Size dropdown keys
            //     against quoted values (e.g. '28"'), so when the stored
            //     value is bare-numeric we append the inch suffix.
            const parsed = isSofa ? parseSofaCode(productCode) : { baseModel: "", module: "" };
            const rawSizeLabel = (item.sizeLabel as string) || "";
            const rawSizeCode = (item.sizeCode as string) || "";
            // Wei Siang 2026-05-15: SOFA seat height canonical is BARE
            // numerics (matches kv_config.variants-config.sofaSizes
            // + the validateSofaSizeLabels backend gate). The previous
            // normalizeSeat() here added trailing `"` to bare values,
            // poisoning the form state — any saved SO with bare
            // sizeLabel got re-sent to backend as `32"` and rejected.
            // Removed: just pass DB values through verbatim.
            const seatHeight = isSofa
              ? ((item.seatHeight as string) || rawSizeLabel || rawSizeCode)
              : "";
            return {
              id: item.id as string,
              productId: item.productId as string,
              productCode,
              productName: item.productName as string,
              itemCategory,
              baseModel: isSofa
                ? parsed.baseModel
                : ((item.baseModel as string) || productCode || ""),
              sizeCode: rawSizeCode,
              // Mirror the seat-size normalization into sizeLabel for
              // sofa items so the Seat Size dropdown reads the same value
              // it pre-selected against. Bedframes keep sizeLabel verbatim.
              sizeLabel: isSofa && seatHeight ? seatHeight : rawSizeLabel,
              fabricCode: (item.fabricCode as string) || "",
              quantity: item.quantity as number,
              basePriceSen: item.basePriceSen as number,
              seatHeight,
              gapInches: item.gapInches as number | null,
              divanHeightInches: item.divanHeightInches as number | null,
              divanPriceSen: (item.divanPriceSen as number) || 0,
              legHeightInches: item.legHeightInches as number | null,
              legPriceSen: (item.legPriceSen as number) || 0,
              // Seeded from the line's OWN stored component (rowToItem returns
              // it), never re-derived on load: opening an order and pressing
              // Save without touching anything must charge exactly what it
              // already charged.
              totalHeightPriceSen: (item.totalHeightPriceSen as number) || 0,
              // Special-orders multi-select pre-fill. Parse the stored
              // comma/semicolon-joined string and resolve each token's
              // canonical code. Hardcoded specialOrderOptions covers the
              // legacy options; for user-added entries (added via Product
              // Maintenance) we fall back to the same derived-code shape
              // used by getAvailableSpecials so the multi-select checkbox
              // still round-trips.
              specialOrders: (() => {
                const raw = (item.specialOrder as string) || "";
                const tokens = raw.split(/[;,]+/).map((s) => s.trim()).filter(Boolean);
                return tokens
                  // Skip "OTHER: <desc>" tokens — they belong to customSpecials.
                  .filter((tok) => !tok.toUpperCase().startsWith("OTHER:"))
                  .map((tok) => {
                    const matched = specialOrderOptions.find((o) => o.name === tok);
                    if (matched) return matched.code;
                    return tok.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
                  })
                  .filter((c): c is string => Boolean(c));
              })(),
              specialOrder: (item.specialOrder as string) || "",
              specialOrderPriceSen: (item.specialOrderPriceSen as number) || 0,
              // customSpecials is delivered as a parsed array by rowToItem
              // in the API. Older SOs without the column come back as []. As
              // a defense, fall back to [] when the field is missing or
              // arrives in an unexpected shape.
              customSpecials: Array.isArray(item.customSpecials)
                ? (item.customSpecials as Array<Record<string, unknown>>)
                    .filter(
                      (e) =>
                        typeof e?.description === "string" &&
                        typeof e?.surchargeSen === "number",
                    )
                    .map((e) => ({
                      description: e.description as string,
                      surchargeSen: e.surchargeSen as number,
                    }))
                : [],
              notes: (item.notes as string) || "",
              // Per-line discount (migration 0179). Default 0 for rows
              // predating the column (backend rowToItem already defaults to 0).
              discountSen: (item.discountSen as number) || 0,
              // Repair Scope (0160) — pass-through only; preserved into the
              // PUT payload so editing a service order keeps each line's
              // scope intact.
              repairScope:
                typeof item.repairScope === "string" && item.repairScope
                  ? item.repairScope
                  : null,
            };
          }));
        }
        setLoading(false);
      })();
  }, [orderResp, id]);

  // 2026-05-09: deferred fabricId backfill removed. Picker now keys on
  // fabricCode (the canonical reference matching raw_materials.itemCode),
  // so loaded SOs pre-select the dropdown directly without any client-side
  // namespace translation. fabricId is no longer touched anywhere on this
  // page; the legacy column on sales_order_items is being dropped.

  const addItem = () => {
    // Same below-the-fold no-op feel as the create page (owner 2026-06-12):
    // scroll the freshly added card into view once React commits it.
    const newIdx = items.length;
    setItems([...items, { ...EMPTY_LINE, _uid: crypto.randomUUID() }]);
    // eslint-disable-next-line no-restricted-syntax -- one-shot scroll-into-view delay inside add-item event handler
    window.setTimeout(() => {
      document
        .getElementById(`line-item-card-${newIdx}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
  };

  const removeItem = (idx: number) => {
    if (items.length <= 1) return;
    setItems(items.filter((_, i) => i !== idx));
  };

  const updateItem = (idx: number, updates: Partial<LineItem>) => {
    setItems(prev => prev.map((item, i) => {
      if (i !== idx) return item;
      const merged = { ...item, ...updates };
      // Total height = gap + divan + leg, priced off the owner's
      // variants-config.totalHeights. Re-derived here whenever one of those
      // three changes — through the SAME helper the PUT uses
      // (deriveTotalHeightSurchargeSen), so the number on screen is the number
      // the server would have derived, and the number we now post.
      // 0134 — Service Order mode suppresses variant pricing across the board.
      if ("gapInches" in updates || "divanHeightInches" in updates || "legHeightInches" in updates) {
        const cfgTotalHeights = maintenanceConfig?.totalHeights as CfgHeight[] | undefined;
        if (isServiceOrderMode) {
          merged.totalHeightPriceSen = 0;
        } else if (Array.isArray(cfgTotalHeights)) {
          merged.totalHeightPriceSen = deriveTotalHeightSurchargeSen(
            (merged.gapInches || 0) + (merged.divanHeightInches || 0) + (merged.legHeightInches || 0),
            cfgTotalHeights,
          );
        }
        // Config not loaded (yet / at all): KEEP the line's stored surcharge
        // rather than zeroing it. A price we cannot look up is not a price of
        // zero, and whatever we keep is still exactly what we display and post.
      }
      return merged;
    }));
  };

  const selectProduct = (idx: number, productId: string) => {
    const prod = products.find(p => p.id === productId);
    if (!prod) return;
    const isSofa = prod.category === "SOFA";
    updateItem(idx, {
      productId: prod.id,
      productCode: prod.code,
      productName: prod.name,
      itemCategory: prod.category,
      baseModel: prod.baseModel,
      sizeCode: prod.sizeCode,
      sizeLabel: prod.sizeLabel,
      // 0134 — Service Order mode: don't auto-seed Base Price from product
      // cost; operator types it. Existing variant prices on the line
      // would already be 0 in SO mode (set by the write paths), but reset
      // them here too in case the line is being re-pointed at a different
      // product after a price was carried in via clone / draft restore.
      basePriceSen: isServiceOrderMode ? 0 : (prod.costPriceSen || 0),
      seatHeight: "",
      gapInches: isSofa ? null : items[idx].gapInches,
      divanHeightInches: isSofa ? null : items[idx].divanHeightInches,
      divanPriceSen: isServiceOrderMode ? 0 : (isSofa ? 0 : items[idx].divanPriceSen),
      legHeightInches: isSofa ? null : items[idx].legHeightInches,
      legPriceSen: isServiceOrderMode ? 0 : (isSofa ? 0 : items[idx].legPriceSen),
      // A sofa line has no gap/divan/leg, so it has no total height either.
      // updateItem re-derives this anyway when the config is loaded; stating it
      // here means a config that never loaded still can't leave a bedframe's
      // surcharge attached to a sofa.
      totalHeightPriceSen:
        isServiceOrderMode || isSofa ? 0 : items[idx].totalHeightPriceSen,
    });
  };

  // Picker writes only fabricCode — see comment in sales/create.tsx selectFabric.
  // fabricId is a UI-only artifact deprecated 2026-05-09.
  const selectFabric = (idx: number, fabricCode: string) => {
    const fab = fabrics.find(f => f.code === fabricCode);
    if (fab) {
      updateItem(idx, { fabricCode: fab.code });
    }
  };

  // For sofa, propagate seat-height into sizeLabel + sizeCode so the "Size"
  // column downstream (detail page, production sheet) carries the seat
  // height — the variable variant — instead of the module code, which
  // already lives in productCode. Mirrors the same fix in create.tsx.
  const selectSeatHeight = (idx: number, value: string) => {
    const item = items[idx];
    const prod = products.find(p => p.id === item.productId);
    if (!value) {
      updateItem(idx, { seatHeight: "", basePriceSen: 0 });
      return;
    }
    if (!prod?.seatHeightPrices) {
      // No seat-price matrix on this product — keep the operator's pick and
      // leave Base Price manual (RM0 allowed; BUG-2026-07-27-001).
      const sizeCode = value.replace(/"/g, "").trim();
      updateItem(idx, { seatHeight: value, sizeLabel: value, sizeCode });
      return;
    }
    const tier = prod.seatHeightPrices.find(t => t.height === value);
    const sizeCode = value.replace(/"/g, "").trim();
    updateItem(idx, {
      seatHeight: value,
      sizeLabel: value,
      sizeCode,
      // 0134 — Service Order mode: don't seed basePriceSen from the tier
      // matrix on size change; operator types Base Price directly.
      basePriceSen: isServiceOrderMode ? 0 : (tier?.priceSen || 0),
    });
  };

  // THE unit-price sum — the shared one, not a local copy. `calculateUnitPrice`
  // is the order-side alias of `invoiceLineUnitSen` (src/lib/invoice-line-price.ts),
  // and it is the same function the PUT uses to compute what it stores, so this
  // page cannot drift a component behind the save again.
  const getUnitPrice = (item: LineItem) =>
    calculateUnitPrice({
      basePriceSen: item.basePriceSen,
      divanPriceSen: item.divanPriceSen,
      legPriceSen: item.legPriceSen,
      totalHeightPriceSen: item.totalHeightPriceSen,
      specialOrderPriceSen: item.specialOrderPriceSen,
    });

  // Line total = (unit price × qty) − per-line discount, clamped ≥ 0.
  const getLineTotal = (item: LineItem) =>
    Math.max(0, getUnitPrice(item) * item.quantity - (item.discountSen || 0));

  const subtotal = items.reduce((sum, item) => sum + getLineTotal(item), 0);
  const totalQty = items.reduce((sum, item) => sum + item.quantity, 0);

  const handleSubmit = async () => {
    if (!customerId) { toast.warning("Please select a customer"); return; }
    if (items.some(l => !l.productId)) { toast.warning("Please select a product for all line items"); return; }
    if (items.some(l => !l.fabricCode)) { toast.warning("Please select a fabric for all line items"); return; }
    // Sofa lines require model + seat size from dropdown — no free text / blanks
    if (items.some(l => l.itemCategory === "SOFA" && !l.baseModel)) {
      toast.warning("Please select a model for all sofa items"); return;
    }
    if (items.some(l => l.itemCategory === "SOFA" && !l.seatHeight)) {
      toast.warning("Please select a seat size for all sofa items"); return;
    }
    // Hard restriction: SOFA + BEDFRAME may NOT coexist on a single SO.
    // Server enforces this too — client check just gives instant feedback.
    if (hasMixedSofaBedframe(items)) {
      toast.error(SO_MIXED_CATEGORY_ERROR);
      return;
    }
    // Sofa qty>1 — must use 1 unit per line. Server enforces too.
    {
      const offending = findInvalidSofaQty(
        items.map((it, i) => ({
          itemCategory: it.itemCategory,
          quantity: it.quantity,
          productCode: it.productCode,
          lineNo: i + 1,
        })),
      );
      if (offending) {
        toast.error(formatSofaQtyError(offending));
        return;
      }
    }

    setSaving(true);
    try {
      // Strip the client-only `_uid` so the server contract is unchanged.
      const itemsForServer = items.map((it) => {
        const { _uid: _drop, ...rest } = it;
        void _drop;
        return rest;
      });
      // 2026-05-27 — verifiedSave migration. After the PUT, read back
      // the SO with a cache-bust and compare key header fields (customer,
      // PO/SO ids, dates) against what we just sent. If the readback
      // returns the OLD values, the operator sees a clear "save did not
      // take effect — try again" instead of a misleading green toast.
      // Items aren't included in the compare because the backend may
      // legitimately rewrite line numbers / IDs (rebuild semantics).
      const requestBody = {
        customerId, customerPOId, customerSOId, reference,
        companySODate, customerDeliveryDate, hookkaExpectedDD, notes,
        items: itemsForServer,
        ...(overrideTokenFromState ? { overrideToken: overrideTokenFromState } : {}),
      };
      const result = await verifiedSave<SalesOrder>({
        endpoint: `/api/sales-orders/${id}`,
        method: "PUT",
        body: requestBody,
        readback: async () => {
          // Cache-bust query param so the FE/server caches don't serve
          // stale state. Returns the SO envelope { success, data: SO }.
          const r = await fetch(`/api/sales-orders/${id}?_v=${Date.now()}`, {
            credentials: "include",
            cache: "no-store",
          });
          if (!r.ok) return null;
          const j = (await r.json()) as { success?: boolean; data?: SalesOrder } | SalesOrder;
          return (j as { data?: SalesOrder })?.data ?? (j as SalesOrder) ?? null;
        },
        expect: {
          customerId,
          customerPOId,
          customerSOId,
          reference,
          companySODate,
          customerDeliveryDate,
          hookkaExpectedDD,
          notes,
        },
      });
      setSaving(false);
      if (!result.ok) {
        if (result.reason === "mismatch") {
          toast.error(formatMismatchError(result.diffs));
        } else if (result.reason === "http") {
          let parsedErr = result.body;
          try {
            const j = JSON.parse(result.body) as { error?: string };
            if (j.error) parsedErr = j.error;
          } catch {
            /* keep raw body */
          }
          toast.error(parsedErr || `Failed to update order (HTTP ${result.status})`);
        } else {
          toast.error(`Save failed: ${result.details}`);
        }
        return;
      }
      // Only this SO changed. The PO prefix stays because editing items can
      // cascade to regenerating linked POs on the server.
      if (id) invalidateCache(`/api/sales-orders/${id}`);
      invalidateCachePrefix("/api/production-orders");
      navigate(`${basePath}/${id}`);
    } catch (e) {
      setSaving(false);
      toast.error(e instanceof Error ? e.message : "Network error — changes not saved");
    }
  };

  // `loading` here is the SEEDING flag, and it is only cleared inside the
  // effect that runs when `orderResp` arrives. So a failed read used to leave
  // this page on "Loading..." for ever, with no way back. Check the failure
  // FIRST — before `loading` — because on this page loading never clears
  // (BUG-2026-08-13-016).
  if (!order && orderFailure && isUnknownOutcome(orderFailure))
    return (
      <RecordLoadError
        subject={mode === "service-order" ? "service order" : "sales order"}
        failure={orderFailure}
        onRetry={refreshOrder}
        backTo={basePath}
        backLabel="Back to list"
      />
    );

  if (loading) return <div className="flex items-center justify-center h-64 text-[#6B7280]">Loading...</div>;

  if (!order) return (
    <div className="flex flex-col items-center justify-center h-64 gap-4">
      <div className="text-[#6B7280]">Order not found</div>
      <Button variant="outline" onClick={() => navigate(basePath)}>Back</Button>
    </div>
  );

  // Lock decision: prefer the eligibility endpoint (handles IN_PRODUCTION's
  // 2-day-window + any-completed-dept rules). While the eligibility request
  // is in flight, fall back to the cheap status-only check so the page
  // doesn't briefly flash the form for a clearly-locked order. Once the
  // verdict lands we use it verbatim — including the trigger values
  // (earliest start date, completed dept) for the human-readable reason.
  const eligibility: EditEligibility | null = eligibilityResp ?? null;
  const fallbackEditable =
    order.status === "DRAFT" || order.status === "CONFIRMED" || order.status === "IN_PRODUCTION";
  const isEditable = eligibility ? eligibility.editable : fallbackEditable;

  if (!isEditable) {
    // Build the reason copy. We always include both the rule that triggered
    // and the concrete trigger value so the user knows what to do next
    // (cancel that completion, or wait/contact ops).
    let reasonText: string;
    let ruleText: string;
    if (eligibility?.reason === "dept_completed") {
      reasonText = `${eligibility.completedDept || "A department"} already has a completion date (${formatLockDate(eligibility.completedAt)}).`;
      ruleText = "Once any department stamps completion, the order is locked.";
    } else if (eligibility?.reason === "production_window") {
      reasonText = `Production starts on ${formatLockDate(eligibility.earliestStartDate)}, which is within the 2-day cutoff.`;
      ruleText = `Edits must be made before ${formatLockDate(eligibility.cutoffDate)}.`;
    } else {
      // status mismatch (or no eligibility data yet — fall back to status copy)
      const status = eligibility?.status || order.status;
      reasonText = `Order status is ${status}.`;
      ruleText =
        "Only DRAFT, CONFIRMED, and IN_PRODUCTION (within 2 days of start, no completed depts) can be edited.";
    }
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={() => navigate(`${basePath}/${id}`)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-xl font-bold text-[#1F1D1B]">Edit {soSingularNoun(mode)}</h1>
          </div>
        </div>
        <Card>
          <CardContent className="p-8">
            <div className="flex flex-col items-center justify-center gap-4 text-center max-w-xl mx-auto">
              <div className="h-12 w-12 rounded-full bg-[#FAEFCB] flex items-center justify-center">
                <AlertTriangle className="h-6 w-6 text-[#9C6F1E]" />
              </div>
              <h2 className="text-lg font-semibold text-[#1F1D1B]">Cannot Edit Order</h2>
              <div className="space-y-2">
                <p className="text-[#374151]">
                  This order is locked because: <span className="font-medium">{reasonText}</span>
                </p>
                <p className="text-sm text-[#6B7280]">{ruleText}</p>
              </div>
              <Button variant="primary" onClick={() => navigate(`${basePath}/${id}`)}>
                Back to Order Details
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const selectedCustomer = customers.find(c => c.id === customerId);

  // Cascade lock — disable Save when the SO has a downstream PO COMPLETED
  // (or any other lock the backend reports). Also forbid handleSubmit by
  // setting the disabled flag; the backend re-validates regardless.
  const lockReason = orderResp?.lockReason ?? null;
  const isLocked = !!lockReason;

  return (
    <div className="space-y-6 max-md:space-y-4">
      <LockBanner reason={lockReason} />

      <div className="flex items-center gap-4 flex-wrap">
        <Button variant="ghost" size="icon" onClick={() => navigate(`${basePath}/${id}`)}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-[#1F1D1B]">Edit {order.companySOId}</h1>
          <p className="text-xs text-[#6B7280]">Modify {soSingularNoun(mode).toLowerCase()} details and line items</p>
        </div>
        <Button variant="outline" onClick={() => navigate(`${basePath}/${id}`)}>Cancel</Button>
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={saving || isLocked}
          title={isLocked ? lockReason ?? undefined : undefined}
        >
          <Save className="h-4 w-4" />
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </div>

      <PresenceBanner holders={otherEditors} />

      <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3"><CardTitle>Order Details</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Customer *</label>
                <SearchableSelect
                  value={customerId}
                  onChange={setCustomerId}
                  options={customers.map(c => ({ value: c.id, label: `${c.code} - ${c.name}` }))}
                  placeholder="Select customer..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Customer PO No.</label>
                <Input value={customerPOId} onChange={(e) => setCustomerPOId(e.target.value)} placeholder="e.g. PO-HKL-2604-012" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Customer SO No.</label>
                <Input value={customerSOId} onChange={(e) => setCustomerSOId(e.target.value)} placeholder="e.g. SO-12345" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Reference</label>
                <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional reference" />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Company SO Date</label>
                <Input type="date" value={companySODate} onChange={(e) => setCompanySODate(e.target.value)} />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Customer Delivery Date</label>
                <Input type="date" value={customerDeliveryDate} onChange={(e) => setCustomerDeliveryDate(e.target.value)} />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Hookka Expected DD</label>
                <Input type="date" value={hookkaExpectedDD} onChange={(e) => setHookkaExpectedDD(e.target.value)} />
              </div>
            </div>

            {selectedCustomer && (
              <div className="rounded-md bg-[#FAF9F7] border border-[#E2DDD8] p-3 text-sm">
                <div className="flex gap-6">
                  <span className="text-[#6B7280]">Hubs: <span className="font-medium text-[#1F1D1B]">{selectedCustomer.deliveryHubs?.length || 0}</span></span>
                  <span className="text-[#6B7280]">Terms: <span className="font-medium text-[#1F1D1B]">{selectedCustomer.creditTerms}</span></span>
                  <span className="text-[#6B7280]">Limit: <span className="font-medium text-[#1F1D1B]">{formatCurrency(selectedCustomer.creditLimitSen)}</span></span>
                  <span className="text-[#6B7280]">Outstanding: <span className="font-medium text-[#9C6F1E]">{formatCurrency(selectedCustomer.outstandingSen)}</span></span>
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1.5">Notes</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                placeholder="Internal notes..."
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3"><CardTitle>Summary</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Status</span><Badge variant="status" status={order.status} /></div>
            <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Total Qty</span><span className="font-medium">{totalQty}</span></div>
            <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Line Items</span><span className="font-medium">{items.filter(l => l.productId).length}</span></div>
            <hr className="border-[#E2DDD8]" />
            <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Subtotal</span><span className="font-medium amount">{formatCurrency(subtotal)}</span></div>
            <div className="flex justify-between text-lg font-bold"><span>Total</span><span className="text-[#6B5C32]">{formatCurrency(subtotal)}</span></div>
          </CardContent>
        </Card>
      </div>

      {/* Line Items */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle>Line Items ({items.length})</CardTitle>
            <Button variant="outline" size="sm" onClick={addItem}>
              <Plus className="h-4 w-4" /> Add Item
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {items.map((item, idx) => {
            return (
              <div
                key={item.id ?? item._uid ?? idx}
                id={`line-item-card-${idx}`}
                className="rounded-md border border-[#E2DDD8] p-4 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[#6B5C32]">Line {idx + 1}</span>
                    {item.itemCategory && <Badge>{item.itemCategory}</Badge>}
                    {isServiceOrderMode && <RepairScopeBadge repairScope={item.repairScope} />}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold amount">{formatCurrency(getLineTotal(item))}</span>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-[#9A3A2D] hover:text-[#7A2E24]" onClick={() => removeItem(idx)} disabled={items.length <= 1}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {(() => {
                  const sc = "w-full rounded border border-[#E2DDD8] px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20";
                  const catProducts = products.filter(p => p.category === item.itemCategory);
                  const isSofa = item.itemCategory === "SOFA";
                  const sofaModels = isSofa ? [...new Set(catProducts.map(p => p.baseModel))].sort() : [];
                  const filteredProducts = isSofa && item.baseModel
                    ? catProducts.filter(p => p.baseModel === item.baseModel)
                    : catProducts;

                  return (
                    <div className={`grid gap-3 ${isSofa ? "grid-cols-[110px_130px_1fr_1fr]" : "grid-cols-[110px_1fr_140px_1fr]"}`}>
                      <div>
                        <label className="block text-xs text-[#9CA3AF] mb-1">Category *</label>
                        <select
                          value={item.itemCategory}
                          onChange={(e) => {
                            updateItem(idx, {
                              itemCategory: e.target.value,
                              productId: "", productCode: "", productName: "",
                              baseModel: "", sizeCode: "", sizeLabel: "",
                              basePriceSen: 0, seatHeight: "",
                              gapInches: null, divanHeightInches: null, divanPriceSen: 0,
                              legHeightInches: null, legPriceSen: 0,
                            });
                          }}
                          className={sc}
                        >
                          <option value="">Select...</option>
                          <option value="BEDFRAME">Bedframe</option>
                          <option value="SOFA">Sofa</option>
                          <option value="ACCESSORY">Accessory</option>
                        </select>
                      </div>

                      {isSofa && (
                        <div>
                          <label className="block text-xs text-[#9CA3AF] mb-1">Model *</label>
                          <SearchableSelect
                            value={item.baseModel}
                            onChange={(val) => {
                              updateItem(idx, {
                                baseModel: val,
                                productId: "", productCode: "", productName: "",
                                sizeCode: "", sizeLabel: "", basePriceSen: 0, seatHeight: "",
                              });
                            }}
                            options={sofaModels.map(m => ({ value: m, label: m }))}
                            placeholder="Select model..."
                            className={sc}
                          />
                        </div>
                      )}

                      <div>
                        <label className="block text-xs text-[#9CA3AF] mb-1">{isSofa ? "Module *" : "Product *"}</label>
                        <SearchableSelect
                          value={item.productId}
                          onChange={(val) => selectProduct(idx, val)}
                          options={filteredProducts.map(p => ({ value: p.id, label: `${p.code} - ${p.name}` }))}
                          placeholder={!item.itemCategory ? "Select category first" : isSofa && !item.baseModel ? "Select model first" : isSofa ? "Select module..." : "Select product..."}
                          disabled={!item.itemCategory || (isSofa && !item.baseModel)}
                          className={sc}
                        />
                      </div>

                      {!isSofa && (
                        <div>
                          <label className="block text-xs text-[#9CA3AF] mb-1">Size</label>
                          <div className="h-[34px] flex items-center px-2 rounded border border-[#E2DDD8] bg-[#FAF9F7] text-sm">
                            {item.sizeLabel || "-"}
                          </div>
                        </div>
                      )}

                      <div>
                        <label className="block text-xs text-[#9CA3AF] mb-1">Fabric *</label>
                        <SearchableSelect
                          value={item.fabricCode}
                          onChange={(val) => selectFabric(idx, val)}
                          options={fabrics.map(f => ({ value: f.code, label: `${f.code} - ${f.name}` }))}
                          placeholder="Select fabric..."
                          className={sc}
                        />
                      </div>
                    </div>
                  );
                })()}

                {item.itemCategory === "SOFA" ? (
                  // Module shown via the top Module dropdown — the side-by-side
                  // readonly field that used to display sizeCode here was
                  // mislabeled (sizeCode is the seat SIZE, not the module).
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div>
                      <label className="block text-xs text-[#9CA3AF] mb-1">Qty</label>
                      <Input type="number" onFocus={(e) => e.currentTarget.select()} min={1} value={item.quantity} onChange={(e) => updateItem(idx, { quantity: parseInt(e.target.value) || 1 })} className="h-8" />
                    </div>
                    <div>
                      <label className="block text-xs text-[#9CA3AF] mb-1">Seat Size *</label>
                      <SearchableSelect
                        value={item.seatHeight}
                        onChange={(val) => selectSeatHeight(idx, val)}
                        options={(() => {
                          // Source from kv_config.sofaSizes so anything the user
                          // adds in Product Maintenance is picked up. Fall back
                          // to the hardcoded list only when the config hasn't
                          // hydrated yet.
                          //
                          // Wei Siang 2026-05-15: canonical is BARE numerics
                          // (matches Maintenance page + DB + backend validator).
                          // Previously this builder normalized bare values to
                          // quoted form (`24` → `24"`) which contradicted the
                          // backend. Removed the normalize step — dropdown now
                          // shows whatever Maintenance config stores, verbatim.
                          const cfg = maintenanceConfig?.sofaSizes;
                          const arr = Array.isArray(cfg) && cfg.length > 0
                            ? cfg.map((v) =>
                                typeof v === "object" && v && "value" in v
                                  ? String((v as { value: unknown }).value)
                                  : String(v),
                              )
                            : (SEAT_HEIGHT_OPTIONS as unknown as string[]);
                          const opts = arr.map(h => ({ value: h, label: h }));
                          // 2026-05-09: if the SO's stored seatHeight isn't in
                          // current config (operator may have removed an option
                          // OR the value was a legacy quoted form from before
                          // the 2026-05-09 backfill), surface it as a legacy
                          // entry so the dropdown still pre-fills instead of
                          // going blank.
                          if (item.seatHeight && !opts.some(o => o.value === item.seatHeight)) {
                            opts.unshift({ value: item.seatHeight, label: `${item.seatHeight} (legacy)` });
                          }
                          return opts;
                        })()}
                        placeholder="Select size..."
                        className="w-full rounded border border-[#E2DDD8] px-2 py-1.5 text-sm h-8"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[#9CA3AF] mb-1">Leg</label>
                      <SearchableSelect
                        value={(() => {
                          // Format inches directly so any maintenance-config
                          // value (incl. decimals like 7.5") renders without
                          // depending on legHeightOptions containing it.
                          if (item.legHeightInches == null || item.legHeightInches === 0) return "No Leg";
                          return `${item.legHeightInches}"`;
                        })()}
                        onChange={(val) => {
                          const inches = val === "No Leg" ? null : parseInches(val);
                          const opt = legHeightOptions.find(o => o.height === val);
                          const sc = opt ? getConfigSurcharge("sofaLegHeights", val, opt.surcharge) : 0;
                          updateItem(idx, {
                            legHeightInches: inches,
                            // 0134 — Service Order mode: leg surcharge stays 0.
                            legPriceSen: isServiceOrderMode ? 0 : sc,
                          });
                        }}
                        options={(() => {
                          const cfg = maintenanceConfig?.sofaLegHeights;
                          const arr = Array.isArray(cfg)
                            ? cfg.map((v) => typeof v === "object" && v && "value" in v ? (v as { value: string }).value : String(v))
                            : legHeightOptions.map(o => o.height);
                          const opts = arr.map(h => ({ value: h, label: h }));
                          // Same legacy-tolerant fallback as Seat Size above.
                          const current =
                            item.legHeightInches == null || item.legHeightInches === 0
                              ? "No Leg"
                              : `${item.legHeightInches}"`;
                          if (current && !opts.some(o => o.value === current)) {
                            opts.unshift({ value: current, label: `${current} (legacy)` });
                          }
                          return opts;
                        })()}
                        placeholder="Select leg..."
                        className="w-full rounded border border-[#E2DDD8] px-2 py-1.5 text-sm h-8"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[#9CA3AF] mb-1">Base Price (RM)</label>
                      <MoneyInput value={item.basePriceSen / 100} onChange={(rm) => updateItem(idx, { basePriceSen: Math.round((rm ?? 0) * 100) })} className="h-8" />
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                      <div>
                        <label className="block text-xs text-[#9CA3AF] mb-1">Qty</label>
                        <Input type="number" onFocus={(e) => e.currentTarget.select()} min={1} value={item.quantity} onChange={(e) => updateItem(idx, { quantity: parseInt(e.target.value) || 1 })} className="h-8" />
                      </div>
                      <div>
                        <label className="block text-xs text-[#9CA3AF] mb-1">Base Price (RM)</label>
                        <MoneyInput value={item.basePriceSen / 100} onChange={(rm) => updateItem(idx, { basePriceSen: Math.round((rm ?? 0) * 100) })} className="h-8" />
                      </div>
                      <div>
                        <label className="block text-xs text-[#9CA3AF] mb-1">Gap (&quot;)</label>
                        <Input type="number" onFocus={(e) => e.currentTarget.select()} min={0} value={item.gapInches ?? ""} onChange={(e) => updateItem(idx, { gapInches: e.target.value ? parseFloat(e.target.value) : null })} className="h-8" placeholder="-" />
                      </div>
                      <div>
                        <label className="block text-xs text-[#9CA3AF] mb-1">Divan H (&quot;)</label>
                        <Input type="number" onFocus={(e) => e.currentTarget.select()} min={0} value={item.divanHeightInches ?? ""} onChange={(e) => updateItem(idx, { divanHeightInches: e.target.value ? parseFloat(e.target.value) : null })} className="h-8" placeholder="-" />
                      </div>
                      <div>
                        <label className="block text-xs text-[#9CA3AF] mb-1">Leg H (&quot;)</label>
                        <Input type="number" onFocus={(e) => e.currentTarget.select()} min={0} value={item.legHeightInches ?? ""} onChange={(e) => updateItem(idx, { legHeightInches: e.target.value ? parseFloat(e.target.value) : null })} className="h-8" placeholder="-" />
                      </div>
                    </div>

                    {(item.divanHeightInches || item.legHeightInches || item.specialOrder) && (
                      <div className="grid grid-cols-3 gap-3">
                        {item.divanHeightInches && (
                          <div>
                            <label className="block text-xs text-[#9CA3AF] mb-1">Divan Surcharge (RM)</label>
                            <MoneyInput value={item.divanPriceSen / 100} onChange={(rm) => updateItem(idx, { divanPriceSen: Math.round((rm ?? 0) * 100) })} className="h-8" />
                          </div>
                        )}
                        {item.legHeightInches && (
                          <div>
                            <label className="block text-xs text-[#9CA3AF] mb-1">Leg Surcharge (RM)</label>
                            <MoneyInput value={item.legPriceSen / 100} onChange={(rm) => updateItem(idx, { legPriceSen: Math.round((rm ?? 0) * 100) })} className="h-8" />
                          </div>
                        )}
                        {item.specialOrder && (
                          <div>
                            <label className="block text-xs text-[#9CA3AF] mb-1">Special Order Surcharge (RM)</label>
                            <MoneyInput value={item.specialOrderPriceSen / 100} onChange={(rm) => updateItem(idx, { specialOrderPriceSen: Math.round((rm ?? 0) * 100) })} className="h-8" />
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}

                {/* Special Orders multi-select — config-driven, shared across sofa + bedframe */}
                {item.itemCategory && (() => {
                  const isSofa = item.itemCategory === "SOFA";
                  const available = getAvailableSpecials(isSofa);
                  const isOpen = showSpecialOrdersIdx === idx;
                  return (
                    <div>
                      <button
                        type="button"
                        onClick={() => setShowSpecialOrdersIdx(isOpen ? null : idx)}
                        className="flex items-center gap-1.5 text-xs font-medium text-[#6B5C32] hover:text-[#4A3F22] transition-colors"
                      >
                        {isOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        Special Orders ({item.specialOrders.length} selected)
                      </button>
                      {item.specialOrders.length > 0 && !isOpen && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {item.specialOrders.map(code => {
                            const opt = specialOrderOptions.find(o => o.code === code);
                            if (!opt) return null;
                            const sc = getConfigSurcharge(isSofa ? "sofaSpecials" : "specials", opt.name, opt.surcharge);
                            return (
                              <Badge key={code} className="text-xs font-normal">
                                {opt.name}
                                {sc !== 0 && (
                                  <span className={sc > 0 ? "text-[#9C6F1E] ml-1" : "text-[#4F7C3A] ml-1"}>
                                    {sc > 0 ? "+" : ""}{formatCurrency(sc)}
                                  </span>
                                )}
                              </Badge>
                            );
                          })}
                        </div>
                      )}
                      {isOpen && (
                        <div className="mt-2 rounded-md border border-[#E2DDD8] bg-[#FAF9F7] p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                          {available.map(opt => {
                            const checked = item.specialOrders.includes(opt.code);
                            const sc = getConfigSurcharge(isSofa ? "sofaSpecials" : "specials", opt.name, opt.surcharge);
                            return (
                              <label
                                key={opt.code}
                                className={`flex items-start gap-2 p-2 rounded cursor-pointer text-sm transition-colors ${checked ? "bg-[#6B5C32]/10 border border-[#6B5C32]/30" : "hover:bg-white border border-transparent"}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleSpecialOrder(idx, opt.code)}
                                  className="mt-0.5 rounded border-[#D1D5DB] text-[#6B5C32] focus:ring-[#6B5C32]/20"
                                />
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium text-[#374151]">{opt.name}</div>
                                  <div className="text-xs text-[#9CA3AF]">
                                    {sc > 0 && <span className="text-[#9C6F1E]">+{formatCurrency(sc)}</span>}
                                    {sc < 0 && <span className="text-[#4F7C3A]">{formatCurrency(sc)}</span>}
                                    {sc === 0 && <span>RM 0</span>}
                                  </div>
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      )}

                      {/* Custom (free-text) specials — see create.tsx for
                          design rationale. Mirrored here so an existing SO
                          can be edited end-to-end without losing custom
                          entries. Migration 0074. */}
                      <div className="mt-3">
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-xs font-medium text-[#374151]">
                            Other (custom)
                            {item.customSpecials.length > 0 && (
                              <span className="text-[#9CA3AF] font-normal ml-1">
                                ({item.customSpecials.length})
                              </span>
                            )}
                          </span>
                          <button
                            type="button"
                            onClick={() => addCustomSpecial(idx)}
                            className="text-xs font-medium text-[#6B5C32] hover:text-[#4A3F22] transition-colors flex items-center gap-1"
                          >
                            <Plus className="h-3 w-3" />
                            Add custom
                          </button>
                        </div>
                        {item.customSpecials.length > 0 && (
                          <div className="space-y-1.5">
                            {item.customSpecials.map((cs, csIdx) => (
                              <div
                                key={csIdx}
                                className="flex items-center gap-2 rounded-md border border-[#E2DDD8] bg-[#FAF9F7] p-2"
                              >
                                <Input
                                  value={cs.description}
                                  onChange={(e) =>
                                    updateCustomSpecial(idx, csIdx, {
                                      description: e.target.value,
                                    })
                                  }
                                  placeholder="e.g. Custom Foam Density 35D"
                                  className="h-8 flex-1 text-sm"
                                />
                                <div className="flex items-center gap-1">
                                  <span className="text-xs text-[#9CA3AF]">RM</span>
                                  <MoneyInput
                                    value={cs.surchargeSen / 100}
                                    onChange={(rm) =>
                                      updateCustomSpecial(idx, csIdx, {
                                        surchargeSen: Math.round((rm ?? 0) * 100),
                                      })
                                    }
                                    className="h-8 w-24 text-sm"
                                  />
                                </div>
                                <button
                                  type="button"
                                  onClick={() => removeCustomSpecial(idx, csIdx)}
                                  className="p-1 rounded text-[#9CA3AF] hover:text-[#B91C1C] hover:bg-[#FEE2E2] transition-colors"
                                  aria-label="Remove custom special"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* Per-line Discount (migration 0179) */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-[#9CA3AF] mb-1">Discount (RM or %)</label>
                    <DiscountInput
                      baseAmountSen={getUnitPrice(item) * item.quantity}
                      valueSen={item.discountSen || null}
                      onChange={(sen) => updateItem(idx, { discountSen: sen ?? 0 })}
                      className="h-8"
                    />
                  </div>
                  <div className="flex flex-col justify-end">
                    <span className="text-xs text-[#9CA3AF] mb-1">Line Total</span>
                    <span className="text-sm font-semibold text-[#1F1D1B] amount">{formatCurrency(getLineTotal(item))}</span>
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-[#9CA3AF] mb-1">Line Notes</label>
                  <Input value={item.notes} onChange={(e) => updateItem(idx, { notes: e.target.value })} placeholder="Optional notes for this line..." className="h-8" />
                </div>

                {/* Repair Scope (0160) — service-order mode only. Same shared
                    picker the create page uses, so the two can't drift. Editing
                    here is already gated by the page-level eligibility lock
                    (edits allowed only before any department completes and
                    within the production window), so a line's repair scope can
                    only change before its job cards are built. */}
                {isServiceOrderMode && (
                  <RepairScopePicker item={item} idx={idx} onUpdate={updateItem} />
                )}

                {/* WIP Preview (Bedframe) */}
                {item.itemCategory === "BEDFRAME" && item.productCode && (() => {
                  const wips = generateBedframeWIPs(item);
                  if (wips.length === 0) return null;
                  return (
                    <div className="border-t border-[#E2DDD8] pt-2">
                      <div className="text-xs font-medium text-[#374151] mb-1.5">Auto-generated WIP Components</div>
                      <div className="space-y-1">
                        {wips.map((wip, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className={`px-1.5 py-0.5 rounded font-semibold ${
                              wip.type === "HB" ? "bg-[#FAEFCB] text-[#9C6F1E]" : "bg-[#E0EDF0] text-[#3E6570]"
                            }`}>
                              {wip.type}
                            </span>
                            <span className="font-mono text-[#1F1D1B]">{wip.code}</span>
                            <span className="text-[#9CA3AF]">x {wip.qty}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {/* WIP Preview (Sofa) */}
                {item.itemCategory === "SOFA" && item.productCode && item.seatHeight && (() => {
                  const wips = generateSofaWIPs(item);
                  if (wips.length === 0) return null;
                  return (
                    <div className="border-t border-[#E2DDD8] pt-2">
                      <div className="text-xs font-medium text-[#374151] mb-1.5">Auto-generated WIP Components</div>
                      <div className="space-y-1">
                        {wips.map((wip, i) => (
                          <div key={i} className="flex items-center gap-2 text-xs">
                            <span className={`px-1.5 py-0.5 rounded font-semibold ${
                              wip.type === "BASE" ? "bg-[#FAEFCB] text-[#9C6F1E]" : wip.type === "CUSHION" ? "bg-[#E0EDF0] text-[#3E6570]" : "bg-[#EEF3E4] text-[#4F7C3A]"
                            }`}>
                              {wip.type}
                            </span>
                            <span className="font-mono text-[#1F1D1B]">{wip.code}</span>
                            <span className="text-[#9CA3AF]">x {wip.qty}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                <div className="flex items-center justify-between text-xs text-[#9CA3AF] border-t border-[#E2DDD8] pt-2">
                  {/* The build-up is an EXPLANATION of the unit above it, and
                      it is only shown when it adds up to that unit — same rule
                      as the invoice screen and the PDF, same module. */}
                  <span>Unit: {formatOrderLineUnit(
                    {
                      basePriceSen: item.basePriceSen,
                      divanPriceSen: item.divanPriceSen,
                      legPriceSen: item.legPriceSen,
                      totalHeightPriceSen: item.totalHeightPriceSen,
                      specialOrderPriceSen: item.specialOrderPriceSen,
                    },
                    getUnitPrice(item),
                    item.seatHeight,
                  )}</span>
                  <span className="font-medium text-sm text-[#1F1D1B]">Total: {formatCurrency(getLineTotal(item))}</span>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
