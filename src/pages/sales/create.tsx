import { useState, useEffect, Suspense, useMemo, useRef } from "react";
import { useToast } from "@/components/ui/toast";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useSOMode, soBasePath, soSingularNoun } from "@/lib/so-mode";
import { humanizeError } from "@/lib/humanize-error";
import { matchedOrderField } from "@/lib/order-lookup-match";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { calculateUnitPrice, calculateLineTotal } from "@/lib/pricing";
import {
  hasMixedSofaBedframe,
  SO_MIXED_CATEGORY_ERROR,
  findInvalidSofaQty,
  formatSofaQtyError,
} from "@/lib/so-category";
import { ArrowLeft, Plus, Trash2, Save, ChevronDown, ChevronUp, Check, AlertTriangle, X } from "lucide-react";
import { DiscountInput } from "@/components/ui/discount-input";
import type { Customer, Product, FabricItem } from "@/types";
import {
  divanHeightOptions,
  legHeightOptions,
  specialOrderOptions,
  gapHeightOptions,
  SEAT_HEIGHT_OPTIONS,
} from "@/lib/pricing-options";
import { fetchVariantsConfig, getVariantsConfigSync, subscribeKvConfig, VARIANTS_CONFIG_KEY } from "@/lib/kv-config";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { useUnsavedChanges } from "@/lib/use-unsaved-changes";
import { useFormDraft, clearFormDraft } from "@/lib/use-form-draft";
import {
  REPAIR_DEPT_CODES,
  validateRepairScopeInput,
} from "@/lib/repair-scope";
import { RepairScopePicker, RepairScopeBadge } from "@/components/sales/repair-scope-picker";

type SeatHeightTier = { height: string; priceSen: number };

// Free-text custom special order on a SO line (migration 0074). Unlike
// the master-config "Specials" list, these are typed by the operator per
// SO line for edge-case asks ("Custom Foam 35D", "Special leg ferrules"
// etc.). Folded into specialOrderPriceSen and suffixed into the
// `specialOrder` text column as "OTHER: <desc>" so legacy display paths
// (DO print, invoice, detail page) keep rendering them without changes.
type CustomSpecial = { description: string; surchargeSen: number };

// Maintenance config (kv_config 'variants-config') values are either bare
// strings (e.g. '4"') or { value, priceSen } pairs. Each consumer narrows
// the union further.
type MaintenanceConfigValue = string | { value: string; priceSen: number };

type SofaModule = {
  productId: string;
  productCode: string;
  productName: string;
  sizeCode: string;
  sizeLabel: string;
  quantity: number;
  basePriceSen: number;
};

type LineItem = {
  // Client-only stable id for React keys. Stripped before POST. Sprint 7.
  _uid: string;
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
  seatHeight: string; // For sofas: '24"', '28"', '30"', '32"', '35"'
  selectedModules: SofaModule[]; // For sofa: multi-select modules
  gapInches: number | null;
  divanHeightInches: number | null;
  divanPriceSen: number;
  legHeightInches: number | null;
  legPriceSen: number;
  totalHeightPriceSen: number; // surcharge from total height config
  specialOrders: string[]; // array of codes
  specialOrderPriceSen: number;
  specialOrder: string; // comma-joined text for submission (predefined names + "OTHER: <desc>" suffixes)
  customSpecials: CustomSpecial[]; // free-text per-line specials
  notes: string;
  // Per-line discount (migration 0179). In sen; 0 = no discount.
  discountSen: number;
  // Service-order Repair Scope (0160). Canonical JSON string
  // {"preset":...,"depts":[...]} or null (= Full remake). Only ever set in
  // service-order mode; normal SOs always submit null.
  repairScope: string | null;
  // Price hints cached on the line so seat-height / fabric pickers can resolve
  // the correct tier without re-fetching. Populated from the customer-aware
  // price endpoint when a customer is selected; otherwise falls back to the
  // global product record.
  price1Sen: number | null;
  seatHeightPrices: SeatHeightTier[];
};

// Factory for new lines — gives each row a fresh `_uid` so React keys are
// stable across add / remove / reorder. Use this instead of `{ ...EMPTY_LINE }`.
const makeEmptyLine = (): LineItem => ({
  _uid: crypto.randomUUID(),
  productId: "", productCode: "", productName: "", itemCategory: "", baseModel: "",
  sizeCode: "", sizeLabel: "", fabricCode: "",
  quantity: 1, basePriceSen: 0, seatHeight: "", selectedModules: [],
  gapInches: null, divanHeightInches: null, divanPriceSen: 0,
  legHeightInches: null, legPriceSen: 0, totalHeightPriceSen: 0,
  specialOrders: [], specialOrderPriceSen: 0, specialOrder: "", customSpecials: [], notes: "",
  discountSen: 0,
  repairScope: null,
  price1Sen: null, seatHeightPrices: [],
});

// EMPTY_LINE retained for places that spread `{ ...EMPTY_LINE, ...patch }`;
// callers in those spots either already have a `_uid` to keep, or assign a
// fresh one alongside the spread. The bare `_uid` here is overwritten in
// every consumer.
const EMPTY_LINE: LineItem = makeEmptyLine();

/** Extract FT portion from sizeLabel, e.g. "Queen 5FT" → "5FT", "Super King 200x200CM" → "200x200CM" */
function extractSizeSuffix(sizeLabel: string): string {
  const m = sizeLabel.match(/(\d[\d.x]*(?:FT|CM))/i);
  return m ? m[1] : sizeLabel;
}

/** Generate WIP items for a bedframe line item */
function generateBedframeWIPs(item: LineItem): { code: string; type: string; qty: number }[] {
  if (!item.baseModel || !item.sizeCode) return [];
  const totalHeight = (item.gapInches || 0) + (item.divanHeightInches || 0) + (item.legHeightInches || 0);
  const sizeSuffix = extractSizeSuffix(item.sizeLabel);
  const wips: { code: string; type: string; qty: number }[] = [];

  // 1x HB WIP: {baseModel}({sizeCode})-HB{totalHeight}"
  if (totalHeight > 0) {
    wips.push({
      code: `${item.baseModel}(${item.sizeCode})-HB${totalHeight}"`,
      type: "HB",
      qty: 1,
    });
  }

  // 2x Divan WIP: {divanHeight}" Divan-{sizeFT}
  if (item.divanHeightInches && item.divanHeightInches > 0) {
    wips.push({
      code: `${item.divanHeightInches}" Divan-${sizeSuffix}`,
      type: "DIVAN",
      qty: 2,
    });
  }

  return wips;
}

/** Generate WIP items for a sofa line item */
function generateSofaWIPs(item: LineItem): { code: string; type: string; qty: number }[] {
  if (!item.baseModel || !item.seatHeight) return [];
  const heightNum = item.seatHeight.replace('"', '');
  const wips: { code: string; type: string; qty: number }[] = [];
  // Base WIP: {code}-{seatHeight}-BASE
  wips.push({ code: `${item.productCode}-${heightNum}-BASE`, type: "BASE", qty: 1 });
  // Cushion WIP: {baseModel}-{seatHeight}-CUSHION
  wips.push({ code: `${item.baseModel}-${heightNum}-CUSHION`, type: "CUSHION", qty: 1 });
  // Arm WIP only if module has arm (sizeCode contains "A")
  if (item.sizeCode.includes("A")) {
    wips.push({ code: `${item.productCode}-${heightNum}-ARM`, type: "ARM", qty: 1 });
  }
  return wips;
}

/** Parse inches from a height string like '14"', '10.5"', or 'No Leg'.
 * Accepts decimals so a Maintenance-config value like 15.5" round-trips
 * through the dropdown without truncation. */
function parseInches(h: string): number | null {
  const m = h.match(/^(\d+(?:\.\d+)?)"/);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Calculate total special order surcharge, applying the combined HB+Divan cover rule:
 * If both HB_FULL_COVER and DIVAN_BTM_COVER are selected, total for that pair = RM100 (10000 sen)
 * instead of RM50 + RM80 = RM130.
 */
function calcSpecialOrderSurcharge(codes: string[]): number {
  const hasHBCover = codes.includes("HB_FULL_COVER");
  const hasDivanBtmCover = codes.includes("DIVAN_BTM_COVER");

  let total = 0;
  for (const code of codes) {
    const opt = specialOrderOptions.find(o => o.code === code);
    if (!opt) continue;

    if (hasHBCover && hasDivanBtmCover) {
      // Apply combined pricing: skip individual HB + BTM, add combined RM100 once
      if (code === "HB_FULL_COVER" || code === "DIVAN_BTM_COVER") continue;
    }
    total += opt.surcharge;
  }

  if (hasHBCover && hasDivanBtmCover) {
    total += 10000; // RM100 combined
  }

  return total;
}

export default function CreateSalesOrderPageWrapper() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64 text-[#9CA3AF]">Loading...</div>}>
      <CreateSalesOrderPage />
    </Suspense>
  );
}

function CreateSalesOrderPage() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // 0134 — flips this create form between regular Sales Order mode
  // (/sales/create) and Service Order mode (/service-order/create). In
  // Service Order mode: page header copy changes, POST body carries
  // isServiceOrder: true, navigates land on /service-order/:id, and the
  // copy-from-SO/CO button is rendered up top.
  const mode = useSOMode();
  const basePath = soBasePath(mode);
  const isServiceOrderMode = mode === "service-order";
  // Catalog endpoints — opt into focus revalidation so adding a new product /
  // fabric / customer in Maintenance becomes visible without a hard refresh.
  // Cross-tab BroadcastChannel + same-tab invalidate-listener (via cached-fetch)
  // already cover the active mutation path; revalidateOnFocus is the safety
  // net for edge cases (Maintenance edit done in another window, on another
  // device, or before this tab subscribed).
  const CAT_OPTS = { revalidateOnFocus: true };
  const { data: customersResp } = useCachedJson<{ data?: Customer[] }>("/api/customers", 300, CAT_OPTS);
  const { data: productsResp } = useCachedJson<{ data?: Product[] }>("/api/products", 300, CAT_OPTS);
  // Multi-Company Phase 2 — the registry that feeds the "Company" dropdown on
  // create. Same endpoint the procurement create page + PO/PI lists use, so the
  // cache is typically warm. Mirrors procurement/create.tsx's pattern exactly.
  const { data: orgsResp } = useCachedJson<{ organisations?: Array<{ code: string; name: string; isActive?: boolean }> }>("/api/organisations", 300, CAT_OPTS);
  // Fabric picker now reads from /api/fabric-tracking (sourced from
  // raw_materials, the inventory source of truth) — the legacy /api/fabrics
  // table has stale leading-zero duplicates (M2402-04 vs M2402-4) which let
  // operators pick fabrics that don't actually exist in inventory, leaving
  // POs with orphan fabricCodes. We map the tracking shape back to the
  // legacy FabricItem at the boundary so downstream picker logic is
  // unchanged.
  const { data: fabricsTrackingForPickerResp } = useCachedJson<{ data?: { id: string; fabricCode: string; fabricDescription?: string; fabricCategory?: string }[] }>("/api/fabric-tracking", 300, CAT_OPTS);
  const { data: fabricTrackingsResp } = useCachedJson<{ data?: {
    id: string;
    fabricCode: string;
    priceTier: "PRICE_1" | "PRICE_2" | "PRICE_3";
    sofaPriceTier?: "PRICE_1" | "PRICE_2" | "PRICE_3" | null;
    bedframePriceTier?: "PRICE_1" | "PRICE_2" | "PRICE_3" | null;
  }[] }>("/api/fabric-tracking", 300, CAT_OPTS);
  const customers: Customer[] = useMemo(() => customersResp?.data || [], [customersResp]);
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
  const fabricTrackings: {
    id: string;
    fabricCode: string;
    priceTier: "PRICE_1" | "PRICE_2" | "PRICE_3";
    sofaPriceTier?: "PRICE_1" | "PRICE_2" | "PRICE_3" | null;
    bedframePriceTier?: "PRICE_1" | "PRICE_2" | "PRICE_3" | null;
  }[] = useMemo(() => fabricTrackingsResp?.data || [], [fabricTrackingsResp]);
  const [saving, setSaving] = useState(false);
  const [isClone, setIsClone] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<"DRAFT" | "CONFIRMED" | "CONFIRMING">("DRAFT");
  // BOM-incomplete error modal — shown when /confirm returns 422. soId is set
  // so the "Open SO as Draft" button can navigate to the newly-created SO.
  const [bomError, setBomError] = useState<{
    open: boolean;
    incompleteProducts: Array<{ productCode: string; productName: string; reason: string }>;
    soId: string | null;
  }>({ open: false, incompleteProducts: [], soId: null });
  const [maintenanceConfig, setMaintenanceConfig] = useState<Record<string, MaintenanceConfigValue[]> | null>(null);
  // Bumped whenever a kv-config write is observed (cross-tab via
  // BroadcastChannel, or same-tab via subscribeKvConfig). Forces the
  // variants-fetch effect below to re-run so dropdowns reflect new
  // specials / heights / sofa sizes added in Maintenance without a
  // hard refresh.
  const [variantsTick, setVariantsTick] = useState(0);

  const [customerId, setCustomerId] = useState("");

  // Sofa combo rules (Phase 5c). Loaded once per customer change — pulls
  // both the customer-scoped rules AND the company-wide rules in one
  // round-trip and stores the union. Detection later prefers customer
  // rules over company-wide for the same (baseModel, sizes, fabricTier).
  type SofaComboRule = {
    id: string;
    baseModel: string;
    componentSizes: string[] | string[][];
    fabricTier: "ANY" | "PRICE_1" | "PRICE_2" | "PRICE_3";
    pricesByHeight: Record<string, number>;
    customerId: string | null;
    effectiveFrom: string;
  };
  const [sofaCombos, setSofaCombos] = useState<SofaComboRule[]>([]);
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    let cancelled = false;
    const loads: Promise<SofaComboRule[]>[] = [];
    // Company-wide rules — always relevant.
    loads.push(
      fetch("/api/sofa-combos?customerId=null")
        .then((r) => r.json())
        .then((raw) => {
          const j = raw as { success?: boolean; data?: SofaComboRule[] };
          return j?.success ? (j.data ?? []) : [];
        })
        .catch(() => []),
    );
    // Customer-scoped rules when a customer is selected.
    if (customerId) {
      loads.push(
        fetch(`/api/sofa-combos?customerId=${encodeURIComponent(customerId)}`)
          .then((r) => r.json())
          .then((raw) => {
          const j = raw as { success?: boolean; data?: SofaComboRule[] };
          return j?.success ? (j.data ?? []) : [];
        })
          .catch(() => []),
      );
    }
    Promise.all(loads).then((batches) => {
      if (cancelled) return;
      const merged: SofaComboRule[] = [];
      for (const arr of batches) merged.push(...arr);
      setSofaCombos(merged);
    });
    return () => {
      cancelled = true;
    };
  }, [customerId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Customer-specific assigned product list. Populated from
  // /api/customer-products?customerId=X whenever a customer is selected.
  // The endpoint already resolves the customer's effective price
  // (snapshot history > legacy override > master) and surfaces
  // hasPendingPriceChange / masterPendingEffectiveFrom flags.
  type CustomerProductRow = {
    id: string;
    customerId: string;
    productId: string;
    productCode: string;
    productName: string;
    category: string;
    basePriceSen: number | null;
    price1Sen: number | null;
    seatHeightPrices: { height: string; priceSen: number; tier?: "PRICE_1" | "PRICE_2" | "PRICE_3" }[] | null;
    notes: string;
    hasPendingPriceChange?: boolean;
  };
  const [customerProducts, setCustomerProducts] = useState<CustomerProductRow[]>([]);
  // Load on customer change. Empty customer = empty array (handlers fall
  // through to the global products list when the map is empty). State
  // mutations during the effect are intentional — there is no derivable
  // signal we can swap in without a fetch round-trip.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!customerId) {
      setCustomerProducts([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/customer-products?customerId=${encodeURIComponent(customerId)}`)
      .then((r) => r.json())
      .then((raw) => {
        if (cancelled) return;
        const j = raw as { success?: boolean; data?: CustomerProductRow[] };
        setCustomerProducts(j.success ? (j.data ?? []) : []);
      })
      .catch(() => {
        if (!cancelled) setCustomerProducts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [customerId]);
  /* eslint-enable react-hooks/set-state-in-effect */
  // Map for O(1) lookup by productId.
  const customerProductsMap = useMemo(() => {
    const m = new Map<string, CustomerProductRow>();
    for (const cp of customerProducts) m.set(cp.productId, cp);
    return m;
  }, [customerProducts]);
  const [deliveryHubId, setDeliveryHubId] = useState("");
  const [customerPOId, setCustomerPOId] = useState("");
  const [customerSOId, setCustomerSOId] = useState("");
  const [reference, setReference] = useState("");
  // Multi-Company Phase 2 — company this SO is booked under. Defaults to
  // HOOKKA so the default create behaviour is byte-identical to today.
  const [salesOrgCode, setSalesOrgCode] = useState<string>("HOOKKA");
  const [companySODate, setCompanySODate] = useState(new Date().toISOString().split("T")[0]);
  const [customerDeliveryDate, setCustomerDeliveryDate] = useState("");
  const [hookkaExpectedDD, setHookkaExpectedDD] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<LineItem[]>([makeEmptyLine()]);

  // Multi-Company Phase 2 — active companies for the Company dropdown.
  const activeOrgs = useMemo(
    () => (orgsResp?.organisations ?? []).filter((o) => o.isActive !== false),
    [orgsResp],
  );

  // 0134 — Copy-from modal state (Service Order mode only). Two-step:
  // (1) pick source SO/CO by id, (2) tick which lines to copy and dial
  // each one's Copy Qty down (defaults to source qty, max = source qty).
  // Each row shows the full per-line spec (gap / divan / leg / special
  // orders / custom specials) so the operator can distinguish lines
  // that share product+size but differ on attributes. All prices reset
  // to 0 on the copied draft — operator must price each line before save.
  const [copyFromOpen, setCopyFromOpen] = useState(false);

  // Service Case hand-off (?fromCase=<caseId>, service-order mode only).
  // "Spawn Service Order" on a SO/CO-sourced case lands here; the effect
  // below drives the SAME copy-for-service-order loader the Copy-from modal
  // uses, then narrows the seeded lines to the case's affected products.
  // linkedCase rides into the POST body (caseId) so the created SV order
  // shows on the case's "Service Orders" panel (migration 0165).
  const fromCaseId = isServiceOrderMode ? (searchParams.get("fromCase") ?? "") : "";
  const [linkedCase, setLinkedCase] = useState<{ id: string; caseNo: string } | null>(null);
  const caseHydrationRan = useRef(false);

  // ---- Shared copy-draft hydration (Copy-from modal + ?fromCase) --------
  // Header fields seed from the draft payload; only blank date fields take
  // the draft's today-defaults (same rule the modal handler always had).
  const applyCopyDraftHeader = (draft: CopyDraft) => {
    setCustomerId(draft.customerId || "");
    setCustomerPOId(draft.customerPOId || "");
    // 0134 — copy-from-SO/CO writes "EX-<sourceNo>" (e.g. "EX-SO-2605-121")
    // into the Customer SO slot so the destination Service Order visibly
    // carries the source id in the right field. Reference takes the
    // source's own reference field (EX-prefixed), not the source id.
    setCustomerSOId(draft.customerSOId || "");
    setReference(draft.reference || "");
    if (draft.hubId) setDeliveryHubId(draft.hubId);
    if (!companySODate) setCompanySODate(draft.companySODate || "");
    if (!customerDeliveryDate)
      setCustomerDeliveryDate(draft.customerDeliveryDate || "");
  };
  // Build LineItems from draft items. Prices are all 0 per the Service
  // Order policy — operator MUST price each line before save.
  const buildLinesFromCopyDraft = (draftItems: CopyDraftItem[]): LineItem[] =>
    (draftItems || []).map((it) => ({
      ...EMPTY_LINE,
      _uid: crypto.randomUUID(),
      productId: it.productId || "",
      productCode: it.productCode || "",
      productName: it.productName || "",
      itemCategory: it.itemCategory || "BEDFRAME",
      // SOFA lines need a baseModel so the Model dropdown isn't blank (Wei
      // Siang 2026-06-15: "为什么 model 不会自己跑出来"). The copy draft carries
      // no baseModel, so derive it from the product catalog by id/code. Bedframe
      // lines don't use baseModel (they key on productCode), so leave them "".
      baseModel:
        (it.itemCategory || "") === "SOFA"
          ? (products.find((p) => p.id === it.productId) ??
              products.find((p) => p.code === it.productCode))?.baseModel || ""
          : "",
      sizeCode: it.sizeCode || "",
      sizeLabel: it.sizeLabel || "",
      fabricCode: it.fabricCode || "",
      quantity: Number(it.quantity) || 1,
      basePriceSen: 0,
      seatHeight: "",
      selectedModules: [],
      gapInches: it.gapInches ?? null,
      divanHeightInches: it.divanHeightInches ?? null,
      divanPriceSen: 0,
      legHeightInches: it.legHeightInches ?? null,
      legPriceSen: 0,
      totalHeightPriceSen: 0,
      specialOrders: it.specialOrder
        ? String(it.specialOrder)
            .split(/[;,]/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      specialOrderPriceSen: 0,
      specialOrder: it.specialOrder || "",
      customSpecials: Array.isArray(it.customSpecials)
        ? it.customSpecials.map((cs) => ({
            description: cs.description,
            surchargeSen: 0,
          }))
        : [],
      notes: it.notes || "",
    }));

  // Hydrate from the linked case: load the case → copy its source order →
  // keep only the affected products' lines (case qty + damaged-part picks
  // override per line). One-shot (ref-guarded).
  useEffect(() => {
    if (!fromCaseId || caseHydrationRan.current) return;
    caseHydrationRan.current = true;
    let cancelled = false;
    type CaseAffectedProduct = {
      productId?: string;
      code?: string;
      qty?: number | null;
      components?: Array<{ key: string; label: string; qty: number }>;
    };
    (async () => {
      try {
        const caseRes = await fetch(`/api/service-cases/${encodeURIComponent(fromCaseId)}`);
        const caseJson = (await caseRes.json().catch(() => ({}))) as {
          success?: boolean;
          error?: string;
          data?: {
            id: string;
            caseNo: string;
            sourceType: "SO" | "CO" | "EXTERNAL";
            sourceId: string;
            affectedProducts?: CaseAffectedProduct[];
            coveredProductIds?: string[];
          };
        };
        if (!caseRes.ok || !caseJson.success || !caseJson.data) {
          throw new Error(caseJson.error || `Couldn't load the case (HTTP ${caseRes.status})`);
        }
        const sc = caseJson.data;
        if ((sc.sourceType !== "SO" && sc.sourceType !== "CO") || !sc.sourceId) {
          if (!cancelled) {
            toast.warning("This case has no source order to copy from — fill the form manually.");
          }
          return;
        }
        // Same loader the Copy-from modal posts to; omitting lineItems
        // copies EVERY source line — the affected-products filter below
        // narrows the result.
        const res = await fetch("/api/sales-orders/copy-for-service-order", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sourceType: sc.sourceType, sourceId: sc.sourceId }),
        });
        const json = (await res.json().catch(() => ({}))) as {
          success?: boolean;
          error?: string;
          data?: CopyDraft;
        };
        if (!res.ok || !json.success || !json.data) {
          throw new Error(json.error || `Couldn't copy the case's source order (HTTP ${res.status})`);
        }
        if (cancelled) return;
        const draft = json.data;
        const affected = Array.isArray(sc.affectedProducts) ? sc.affectedProducts : [];
        // Re-spawn (#10): a previous service order on this case may already
        // cover some affected products — pre-fill ONLY the NEW ones. Fall back
        // to all affected on the FIRST spawn (nothing covered yet) or if the
        // narrowing would leave nothing to work from.
        const covered = Array.isArray(sc.coveredProductIds)
          ? sc.coveredProductIds
          : [];
        const newAffected = affected.filter(
          (ap) => !(ap.productId && covered.includes(ap.productId)),
        );
        const effectiveAffected = newAffected.length > 0 ? newAffected : affected;
        const matchEntry = (it: CopyDraftItem): CaseAffectedProduct | undefined =>
          effectiveAffected.find(
            (ap) =>
              (!!ap.productId && ap.productId === it.productId) ||
              (!!ap.code && ap.code === it.productCode),
          );
        // Keep only the lines the case flagged (narrowed to NEW items for a
        // re-spawn). No affected products — or zero overlap (product edited off
        // the source order since the case was opened) — keeps every line so the
        // operator still has something to work from.
        const kept =
          effectiveAffected.length > 0
            ? draft.items.filter((it) => !!matchEntry(it))
            : draft.items;
        const baseItems = kept.length > 0 ? kept : draft.items;
        applyCopyDraftHeader(draft);
        const built = buildLinesFromCopyDraft(baseItems).map((line, i) => {
          const ap = matchEntry(baseItems[i]);
          if (!ap) return line;
          const apQty = Number(ap.qty);
          const next: LineItem = {
            ...line,
            ...(Number.isFinite(apQty) && apQty > 0 ? { quantity: Math.floor(apQty) } : {}),
          };
          // Damaged-part picks → CUSTOM scope over the full dept chain (the
          // components do the narrowing) — the same storage shape the
          // per-line Repair Scope picker writes; its reconcile effect
          // re-canonicalizes the picks against the live BOM.
          if (Array.isArray(ap.components) && ap.components.length > 0) {
            next.repairScope = JSON.stringify({
              preset: "CUSTOM",
              depts: [...REPAIR_DEPT_CODES],
              components: ap.components.map((cp) => ({
                key: cp.key,
                label: cp.label,
                qty: cp.qty,
              })),
            });
          }
          return next;
        });
        if (built.length > 0) setItems(built);
        setLinkedCase({ id: sc.id, caseNo: sc.caseNo });
        const coveredCount = affected.length - effectiveAffected.length;
        toast.success(
          coveredCount > 0
            ? `Loaded ${built.length} NEW line(s) from case ${sc.caseNo} (${coveredCount} already on a service order). Set prices before saving.`
            : `Loaded ${built.length} line(s) from case ${sc.caseNo}. Set prices before saving.`,
        );
      } catch (e) {
        if (!cancelled) {
          toast.error(e instanceof Error ? e.message : "Couldn't hydrate from the case");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot; helpers are stable per render and the ref guards re-runs
  }, [fromCaseId]);

  // Mark this tab as dirty (un-evictable from the 10-tab cap) the moment
  // the user has touched the form. Heuristic: any of the header fields
  // populated, or any line item with a product picked. Saving (which then
  // navigates away to the detail page) unmounts this component and the
  // useActiveTabDirty hook's cleanup automatically clears the flag.
  const isDirty = !saving && (
    !!customerId || !!customerPOId || !!customerSOId || !!reference ||
    !!customerDeliveryDate || !!hookkaExpectedDD || !!notes ||
    items.some((it) => !!it.productId)
  );
  useUnsavedChanges(isDirty);

  // Form draft — auto-save the in-progress form to localStorage every 500ms
  // (debounced inside the hook). If the user navigates away mid-edit and
  // comes back, we offer to restore. The clone branch (?clone=…) seeds the
  // form from the source SO directly, so we don't want a stale draft to
  // overwrite that — keep the draft key bound to the clone source so each
  // "new from X" thread has its own draft slot.
  const draftKey = `so-create:${searchParams.get("clone") ?? "blank"}`;
  type DraftShape = {
    customerId: string;
    deliveryHubId: string;
    customerPOId: string;
    customerSOId: string;
    reference: string;
    salesOrgCode: string;
    companySODate: string;
    customerDeliveryDate: string;
    hookkaExpectedDD: string;
    notes: string;
    items: LineItem[];
  };
  const draftCurrent: DraftShape = useMemo(() => ({
    customerId,
    deliveryHubId,
    customerPOId,
    customerSOId,
    reference,
    salesOrgCode,
    companySODate,
    customerDeliveryDate,
    hookkaExpectedDD,
    notes,
    items,
  }), [
    customerId, deliveryHubId, customerPOId, customerSOId, reference,
    salesOrgCode, companySODate, customerDeliveryDate, hookkaExpectedDD, notes, items,
  ]);
  const restoredDraft = useFormDraft<DraftShape>(draftKey, draftCurrent);
  const [draftBannerDismissed, setDraftBannerDismissed] = useState(false);
  // The banner is offered only if (a) there is an actual draft, (b) the
  // current form is still empty (so we don't surprise-overwrite a clone
  // seed), and (c) the user hasn't already chosen restore-or-discard.
  const draftBannerVisible =
    !!restoredDraft &&
    !draftBannerDismissed &&
    !customerId && !customerPOId && !customerSOId && !reference &&
    !notes && items.every((it) => !it.productId);
  const restoreDraft = () => {
    if (!restoredDraft) return;
    setCustomerId(restoredDraft.customerId);
    setDeliveryHubId(restoredDraft.deliveryHubId);
    setCustomerPOId(restoredDraft.customerPOId);
    setCustomerSOId(restoredDraft.customerSOId);
    setReference(restoredDraft.reference);
    if (restoredDraft.salesOrgCode) setSalesOrgCode(restoredDraft.salesOrgCode);
    setCompanySODate(restoredDraft.companySODate);
    setCustomerDeliveryDate(restoredDraft.customerDeliveryDate);
    setHookkaExpectedDD(restoredDraft.hookkaExpectedDD);
    setNotes(restoredDraft.notes);
    // Old drafts won't have `_uid` — backfill on restore so React keys stay
    // stable for whatever the user does next.
    setItems(restoredDraft.items.map((it) => (it._uid ? it : { ...it, _uid: crypto.randomUUID() })));
    setDraftBannerDismissed(true);
  };
  const discardDraft = () => {
    clearFormDraft(draftKey);
    setDraftBannerDismissed(true);
  };
  // Note: draft cleanup happens INSIDE handleSubmit on success. We don't
  // tie it to unmount because Cancel also unmounts and we want Cancel to
  // preserve the draft so the user can come back to it.

  useEffect(() => {
    // Variants now live in D1 under kv_config('variants-config'). Hydrate from
    // the shared cache first (instant if any other page already fetched it)
    // and fall back to factory defaults until the D1 round-trip resolves.
    const FACTORY_DEFAULTS: Record<string, unknown[]> = {
      divanHeights: [
        { value: '8"', priceSen: 0 }, { value: '10"', priceSen: 5000 },
        { value: '12"', priceSen: 10000 }, { value: '14"', priceSen: 18000 },
      ],
      totalHeights: [
        { value: '22"', priceSen: 0 }, { value: '24"', priceSen: 5000 },
        { value: '26"', priceSen: 10000 }, { value: '28"', priceSen: 15000 },
      ],
      gaps: ['4"', '5"', '6"', '7"', '8"', '9"', '10"'],
      legHeights: [
        { value: "No Leg", priceSen: 0 }, { value: '1"', priceSen: 0 },
        { value: '2"', priceSen: 0 }, { value: '4"', priceSen: 0 },
        { value: '6"', priceSen: 0 }, { value: '7"', priceSen: 16000 },
      ],
      specials: [
        { value: "HB Fully Cover", priceSen: 5000 },
        { value: "Divan Top Fully Cover", priceSen: 5000 },
        { value: "Divan Full Cover", priceSen: 8000 },
        { value: "Left Drawer", priceSen: 15000 },
        { value: "Right Drawer", priceSen: 15000 },
        { value: "Front Drawer", priceSen: 12000 },
        { value: "HB Straight", priceSen: 0 },
        { value: "Divan Top(W)", priceSen: 0 },
        { value: "1 Piece Divan", priceSen: 25000 },
        { value: "Divan Curve", priceSen: 5000 },
        { value: "No Side Panel", priceSen: 4000 },
        { value: "Headboard Only", priceSen: 0 },
      ],
      sofaSizes: ['24"', '28"', '30"', '32"', '35"'],
      sofaLegHeights: [
        { value: "No Leg", priceSen: 0 },
        { value: '4"', priceSen: 0 },
        { value: '6"', priceSen: 0 },
      ],
      sofaSpecials: [
        { value: "Nylon Fabric", priceSen: 0 },
        { value: "5537 Backrest", priceSen: 0 },
        { value: "Separate Backrest Packing", priceSen: 0 },
      ],
    };

    const applyCfg = (cfg: Record<string, unknown> | null) => {
      if (cfg && Object.keys(cfg).length > 0) {
        setMaintenanceConfig(cfg as Record<string, MaintenanceConfigValue[]>);
      } else {
        setMaintenanceConfig(FACTORY_DEFAULTS as Record<string, MaintenanceConfigValue[]>);
      }
    };

    // Customer-aware variants-config (read-time merge — added 2026-05-06):
    //   * No customer selected → master `variants-config`.
    //   * Customer selected → MERGE master + customer snapshot so new master
    //     variants automatically appear in every customer's picker without
    //     needing a Copy-from-Master refresh per customer. Per-category, for
    //     each entry in master we look up the same `value` in customer; if
    //     present, we use the customer override (preserves custom pricing);
    //     otherwise we use the master entry. Customer-only entries (rare —
    //     would mean the customer added a variant master doesn't have)
    //     survive the merge so nothing the user explicitly added is lost.
    //
    //   This replaces the old "snapshot completely shadows master" rule —
    //   that left customer pickers stuck on whatever was current the last
    //   time someone ran Copy-from-Master, which is the bug user hit
    //   2026-05-06: "我在 product code 添加了 items, 为什么 sales order
    //   search 不出来" — the Carress snapshot had been frozen.
    type CfgItem = { value?: string; priceSen?: number } & Record<string, unknown>;
    const mergeCfg = (
      master: Record<string, unknown> | null,
      customer: Record<string, unknown> | null,
    ): Record<string, unknown> | null => {
      if (!master && !customer) return null;
      const out: Record<string, unknown> = {};
      const keys = new Set([
        ...Object.keys(master ?? {}),
        ...Object.keys(customer ?? {}),
      ]);
      for (const k of keys) {
        const m = master?.[k];
        const c = customer?.[k];
        // Both arrays — merge per `value`. master ordering wins so newly-
        // added master items appear in the place the user added them; any
        // customer-only items go after.
        if (Array.isArray(m) && Array.isArray(c)) {
          const cByValue = new Map<string, CfgItem>();
          for (const it of c as CfgItem[]) {
            if (it && typeof it.value === "string") cByValue.set(it.value, it);
          }
          const merged: CfgItem[] = [];
          const seen = new Set<string>();
          for (const it of m as CfgItem[]) {
            if (!it || typeof it.value !== "string") { merged.push(it); continue; }
            const override = cByValue.get(it.value);
            merged.push(override ?? it);
            seen.add(it.value);
          }
          for (const it of c as CfgItem[]) {
            if (it && typeof it.value === "string" && !seen.has(it.value)) {
              merged.push(it);
            }
          }
          out[k] = merged;
          continue;
        }
        // Plain string-array category (e.g. `gaps`) — union, master order first.
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
        // Non-array (object) category — customer wins if present, else master.
        out[k] = c ?? m;
      }
      return out;
    };

    let cancelled = false;
    if (!customerId) {
      applyCfg(getVariantsConfigSync() as Record<string, unknown> | null);
      void fetchVariantsConfig().then((cfg) => {
        if (cancelled) return;
        applyCfg(cfg as Record<string, unknown> | null);
      });
      return () => { cancelled = true; };
    }

    // Customer selected — fetch BOTH in parallel, merge.
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
      applyCfg(mergeCfg(master, customer));
    });

    return () => { cancelled = true; };
  }, [customerId, variantsTick]);

  // Live-refresh hook: subscribe to variants-config writes so dropdowns
  // pick up new entries the moment Maintenance Save fires (in any tab).
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

  // Load clone data from localStorage if navigated from Clone button.
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot hydrate from localStorage clone payload on mount */
  useEffect(() => {
    if (searchParams.get("clone") === "1") {
      try {
        const raw = localStorage.getItem("so-clone-data");
        if (raw) {
          const data = JSON.parse(raw);
          setIsClone(true);
          setCustomerId(data.customerId || "");
          setCustomerPOId(data.customerPOId || "");
          setCustomerSOId(data.customerSOId || "");
          setReference(data.reference || "");
          setCompanySODate(data.companySODate || new Date().toISOString().split("T")[0]);
          setCustomerDeliveryDate(data.customerDeliveryDate || "");
          setHookkaExpectedDD(data.hookkaExpectedDD || "");
          setNotes(data.notes || "");
          if (data.items && data.items.length > 0) {
            // Migrate old single specialOrder string to specialOrders array.
            // Always assign a fresh `_uid` per cloned line — the source's uid
            // could collide if the user clones twice.
            const migrated = data.items.map((it: LineItem) => ({
              ...EMPTY_LINE,
              ...it,
              _uid: crypto.randomUUID(),
              seatHeight: it.seatHeight || "",
              specialOrders: it.specialOrders || (it.specialOrder ? it.specialOrder.split(/[;,]/).map((s: string) => s.trim()).filter(Boolean) : []),
              // Carry custom specials through the clone path. EMPTY_LINE
              // gives [] when source predates the field.
              customSpecials: Array.isArray(it.customSpecials) ? it.customSpecials : [],
            }));
            setItems(migrated);
          }
          localStorage.removeItem("so-clone-data");
        }
      } catch {
        // ignore parse errors
      }
    }
  }, [searchParams]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const addItem = () => {
    // New line lands at the BOTTOM of the list — on a long order it renders
    // below the fold and the click looks like a no-op (owner 2026-06-12:
    // "Add item 沒反應嗎?" after stacking 4 invisible blank lines). Scroll
    // the fresh card into view once React has committed it.
    const newIdx = items.length;
    setItems([...items, makeEmptyLine()]);
    window.setTimeout(() => {
      document
        .getElementById(`line-item-card-${newIdx}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
  };

  /** For sofa: replace the template line at `idx` with N line items (one per selected module productId) */
  const addSofaModules = (idx: number, moduleProductIds: string[]) => {
    if (moduleProductIds.length === 0) return;
    const template = items[idx];
    const newLines: LineItem[] = moduleProductIds.map(pid => {
      const prod = products.find(p => p.id === pid);
      if (!prod) return null;
      const isSofa = prod.category === "SOFA";
      let priceSen = prod.costPriceSen || 0;
      // If seat height already chosen, look up height-specific price
      if (template.seatHeight && prod.seatHeightPrices) {
        const tier = prod.seatHeightPrices.find(t => t.height === template.seatHeight);
        if (tier) priceSen = tier.priceSen;
      }
      return {
        ...EMPTY_LINE,
        _uid: crypto.randomUUID(),
        productId: prod.id,
        productCode: prod.code,
        productName: prod.name,
        itemCategory: prod.category,
        baseModel: prod.baseModel,
        sizeCode: prod.sizeCode,
        sizeLabel: prod.sizeLabel,
        // 0134 — Service Order mode: every variant/base price seed is 0.
        // Template.legPriceSen is already 0 in this mode (selectLeg zeroes
        // it), but belt-and-braces guard the basePrice here too.
        basePriceSen: isServiceOrderMode ? 0 : priceSen,
        seatHeight: template.seatHeight,
        fabricCode: template.fabricCode,
        quantity: 1,
        legHeightInches: isSofa ? template.legHeightInches : null,
        legPriceSen: isServiceOrderMode ? 0 : (isSofa ? template.legPriceSen : 0),
      } as LineItem;
    }).filter(Boolean) as LineItem[];
    if (newLines.length === 0) return;
    // Replace the template line at idx with the new lines
    setItems(prev => [...prev.slice(0, idx), ...newLines, ...prev.slice(idx + 1)]);
  };

  const removeItem = (idx: number) => {
    if (items.length <= 1) return;
    setItems(items.filter((_, i) => i !== idx));
  };

  // Lookup total height surcharge from maintenance config
  function calcTotalHeightSurcharge(totalInches: number): number {
    if (totalInches <= 0 || !maintenanceConfig?.totalHeights) return 0;
    const label = `${totalInches}"`;
    const entry = maintenanceConfig.totalHeights.find(
      (e: { value: string; priceSen: number } | string) =>
        typeof e === "object" && e.value === label
    );
    return entry && typeof entry === "object" ? entry.priceSen : 0;
  }

  const updateItem = (idx: number, updates: Partial<LineItem>) => {
    setItems(prev => prev.map((item, i) => {
      if (i !== idx) return item;
      const merged = { ...item, ...updates };
      // Recalculate total height surcharge whenever gap/divan/leg changes.
      // 0134 — Service Order mode: total-height surcharge is also 0
      // (variant pricing suppressed across the board).
      if ("gapInches" in updates || "divanHeightInches" in updates || "legHeightInches" in updates) {
        const th = (merged.gapInches || 0) + (merged.divanHeightInches || 0) + (merged.legHeightInches || 0);
        merged.totalHeightPriceSen = isServiceOrderMode ? 0 : calcTotalHeightSurcharge(th);
      }
      return merged;
    }));
  };

  // Propagate shared sofa variants (fabric / seat size / leg) from one line
  // to all OTHER sofa lines that share the same baseModel. This lets the
  // user fill the first module once and have the rest follow automatically
  // instead of re-entering the same variant on every module line.
  const propagateSofaVariant = (idx: number, updates: Partial<LineItem>) => {
    setItems(prev => {
      const source = prev[idx];
      if (!source || source.itemCategory !== "SOFA" || !source.baseModel) return prev;
      // Cascade only when the edit lands on the FIRST sofa line of this
      // baseModel — that line seeds defaults for the sibling modules.
      // Edits on any later sibling stay local so the user can override
      // fabric / seat / leg / special orders per-module without the
      // change bleeding back into Line 1 and re-cascading out again.
      // (Rule: defaults follow first item, per-line overrides stay local.)
      const firstSofaIdx = prev.findIndex(
        (it) => it.itemCategory === "SOFA" && it.baseModel === source.baseModel,
      );
      if (idx !== firstSofaIdx) {
        return prev.map((item, i) => (i === idx ? { ...item, ...updates } : item));
      }
      return prev.map((item, i) => {
        if (i === idx) {
          // First sofa line of this baseModel — also re-resolve its own
          // basePrice when seat height was the trigger so the user sees
          // the matrix-aware price land immediately. Tier comes from the
          // current fabric (or fabric being set in this same updates batch).
          if ("seatHeight" in updates) {
            const fabricCode = updates.fabricCode ?? item.fabricCode;
            const seatHeight = (updates.seatHeight ?? item.seatHeight) as string;
            const prod = products.find(p => p.id === item.productId);
            const tiers = (item.seatHeightPrices && item.seatHeightPrices.length > 0)
              ? item.seatHeightPrices
              : prod?.seatHeightPrices;
            const newPrice = resolveSofaTierPrice(tiers, seatHeight, fabricCode);
            return {
              ...item,
              ...updates,
              ...(newPrice !== null ? { basePriceSen: newPrice } : {}),
            };
          }
          return { ...item, ...updates };
        }
        if (item.itemCategory !== "SOFA" || item.baseModel !== source.baseModel) return item;
        // Sibling lines: same logic — re-resolve basePrice when seat
        // height changes, using THIS line's own fabric (sibling lines may
        // have already overridden their fabric independently). Tier
        // pulled from fabric_tracking via the same resolver.
        if ("seatHeight" in updates) {
          const prod = products.find(p => p.id === item.productId);
          const tiers = (item.seatHeightPrices && item.seatHeightPrices.length > 0)
            ? item.seatHeightPrices
            : prod?.seatHeightPrices;
          const newPrice = resolveSofaTierPrice(
            tiers,
            (updates.seatHeight ?? item.seatHeight) as string,
            item.fabricCode,
          );
          return {
            ...item,
            ...updates,
            ...(newPrice !== null ? { basePriceSen: newPrice } : {}),
          };
        }
        return { ...item, ...updates };
      });
    });
  };

  const selectProduct = (idx: number, productId: string) => {
    const prod = products.find(p => p.id === productId);
    if (!prod) return;
    const isSofa = prod.category === "SOFA";
    const isBF = prod.category === "BEDFRAME";
    // Customer-specific snapshot price (Phase 2). When a customer is
    // selected and this product is in their assigned list, seed the line
    // from the customer override row instead of the master product.
    // Otherwise fall through to the master values.
    const cp = customerProductsMap.get(prod.id);
    const seedPrice1 = cp?.price1Sen ?? prod.price1Sen ?? null;
    const seedSeat = (cp?.seatHeightPrices ?? prod.seatHeightPrices ?? []) as
      | { height: string; priceSen: number; tier?: "PRICE_1" | "PRICE_2" | "PRICE_3" }[]
      | [];

    // ---- Variant default pre-fill ------------------------------------
    // Per-SKU defaults stored on products.defaultVariants. The Variant
    // Defaults dialog on /products writes these. We pre-populate the line
    // from the saved values; user can still override every input.
    //   BEDFRAME: divanHeight, legHeight, gap, specials, fabricCode
    //   SOFA:     seatHeight, legHeight, specials, fabricCode
    const def = prod.defaultVariants ?? {};
    const lookupDivanSurcharge = (h: string): number => {
      const cfgEntry = maintenanceConfig?.divanHeights?.find(
        (e: { value: string; priceSen: number } | string) =>
          typeof e === "object" && e.value === h,
      );
      if (cfgEntry && typeof cfgEntry === "object") return cfgEntry.priceSen;
      return divanHeightOptions.find((o) => o.height === h)?.surcharge ?? 0;
    };
    const lookupLegSurcharge = (h: string): number => {
      const cfgKey = isSofa ? "sofaLegHeights" : "legHeights";
      const cfgEntry = maintenanceConfig?.[cfgKey]?.find(
        (e: { value: string; priceSen: number } | string) =>
          typeof e === "object" && e.value === h,
      );
      if (cfgEntry && typeof cfgEntry === "object") return cfgEntry.priceSen;
      return legHeightOptions.find((o) => o.height === h)?.surcharge ?? 0;
    };
    // Map default specials (stored as display names like "HB Fully Cover")
    // back to internal codes ("HB_FULL_COVER") that LineItem.specialOrders
    // uses. Drop any that don't have a known code so the line doesn't
    // carry orphan IDs through to the API.
    const defaultSpecialCodes: string[] = (def.specials ?? [])
      .map((name) => specialOrderOptions.find((o) => o.name === name)?.code)
      .filter((c): c is string => !!c);

    // BF default values (only apply to bedframes — the inputs are hidden
    // for sofa/accessory).
    const bfDivanInches = isBF && def.divanHeight ? parseInches(def.divanHeight) : null;
    const bfLegInches = isBF && def.legHeight ? parseInches(def.legHeight) : null;
    const bfGapInches = isBF && def.gap ? parseInches(def.gap) : null;
    const bfDivanPrice = isBF && def.divanHeight ? lookupDivanSurcharge(def.divanHeight) : 0;
    const bfLegPrice = isBF && def.legHeight ? lookupLegSurcharge(def.legHeight) : 0;
    // SOFA default values.
    const sofaSeat = isSofa && def.seatHeight ? def.seatHeight : "";
    const sofaLegInches = isSofa && def.legHeight ? parseInches(def.legHeight) : null;
    const sofaLegPrice = isSofa && def.legHeight ? lookupLegSurcharge(def.legHeight) : 0;
    const sofaSeatTier = (isSofa && sofaSeat && seedSeat.length > 0)
      ? seedSeat.find((s) => s.height === sofaSeat)
      : undefined;
    // Specials surcharge (re-using calcSpecialOrderSurcharge which already
    // handles the HB+Divan combined-cover rule so the prefill matches what
    // toggleSpecialOrder would produce).
    const defaultSpecialSurcharge = defaultSpecialCodes.length > 0
      ? calcSpecialOrderSurcharge(defaultSpecialCodes)
      : 0;
    // Fabric default — resolve by code so downstream fabric picker shows
    // the right selection. Skip if defaults didn't set one.
    const defaultFabric = def.fabricCode
      ? fabrics.find((f) => f.code === def.fabricCode)
      : undefined;
    // For bedframes, when both fabric and tier resolve, set basePriceSen
    // from price1Sen (Price 1 tier) or fall back to costPriceSen (Price 2).
    let bfBasePriceFromFabric = 0;
    if (isBF && defaultFabric) {
      const tracking = fabricTrackings.find((ft) => ft.fabricCode === defaultFabric.code);
      const tier = tracking?.bedframePriceTier ?? tracking?.priceTier ?? "PRICE_2";
      bfBasePriceFromFabric =
        tier === "PRICE_1"
          ? (cp?.price1Sen ?? prod.price1Sen ?? 0)
          : (cp?.basePriceSen ?? prod.basePriceSen ?? 0);
    }

    updateItem(idx, {
      productId: prod.id,
      productCode: prod.code,
      productName: prod.name,
      itemCategory: prod.category,
      baseModel: prod.baseModel,
      sizeCode: isSofa && sofaSeat ? sofaSeat.replace(/"/g, "").trim() : prod.sizeCode,
      sizeLabel: isSofa && sofaSeat ? sofaSeat : prod.sizeLabel,
      // Base price: resolves once fabric is known. For sofa, the seat-tier
      // matrix gives a price even without fabric (via the seedSeat lookup
      // below); for bedframe, leave 0 unless the default fabric pinned it.
      // 0134 — Service Order mode: skip auto-seed entirely; operator types
      // every Base Price by hand. Same goes for all variant surcharges
      // below (divan / leg / special-order).
      basePriceSen: isServiceOrderMode
        ? 0
        : isSofa
          ? (sofaSeatTier?.priceSen ?? 0)
          : bfBasePriceFromFabric,
      price1Sen: seedPrice1,
      seatHeightPrices: seedSeat,
      // Fabric prefill (applies to all categories).
      ...(defaultFabric ? { fabricCode: defaultFabric.code } : {}),
      // Specials prefill — codes (LineItem.specialOrders) + comma-joined
      // display string for the saved specialOrder field + surcharge. We
      // preserve any custom specials the user already typed on this line
      // and re-suffix them into the joined text so picking a different
      // product doesn't silently drop "OTHER: <desc>" tokens.
      specialOrders: defaultSpecialCodes,
      specialOrder: [
        ...defaultSpecialCodes
          .map((c) => specialOrderOptions.find((o) => o.code === c)?.name ?? "")
          .filter(Boolean),
        ...items[idx].customSpecials
          .map((cs) => cs.description.trim())
          .filter(Boolean)
          .map((d) => `OTHER: ${d}`),
      ].join("; "),
      specialOrderPriceSen: isServiceOrderMode
        ? 0
        : defaultSpecialSurcharge +
          items[idx].customSpecials.reduce(
            (s, c) => s + (Number.isFinite(c.surchargeSen) && c.surchargeSen > 0 ? Math.round(c.surchargeSen) : 0),
            0,
          ),
      // Category-specific dimension prefills.
      seatHeight: sofaSeat,
      gapInches: isSofa ? null : (bfGapInches ?? items[idx].gapInches),
      divanHeightInches: isSofa ? null : (bfDivanInches ?? items[idx].divanHeightInches),
      divanPriceSen: isServiceOrderMode
        ? 0
        : isSofa
          ? 0
          : (bfDivanInches != null ? bfDivanPrice : items[idx].divanPriceSen),
      legHeightInches: isSofa ? sofaLegInches : (bfLegInches ?? items[idx].legHeightInches),
      legPriceSen: isServiceOrderMode
        ? 0
        : isSofa
          ? sofaLegPrice
          : (bfLegInches != null ? bfLegPrice : items[idx].legPriceSen),
      totalHeightPriceSen: 0, // recomputed by updateItem when divan/leg/gap change
    });
  };

  // Resolve a sofa line's tier-aware price from its current (height, tier)
  // pair. Tier comes from fabric_tracking.sofaPriceTier (split off from the
  // legacy priceTier in migration 0069), falling back to priceTier and then
  // PRICE_2 when both are unset. Legacy seatHeightPrices entries without a
  // tier field also resolve as PRICE_2 — keeps behaviour stable for SKUs
  // that pre-date the matrix.
  const resolveSofaTierPrice = (
    seatHeightPrices: { height: string; priceSen: number; tier?: "PRICE_1" | "PRICE_2" | "PRICE_3" }[] | undefined,
    seatHeight: string,
    fabricCode: string,
  ): number | null => {
    if (!seatHeightPrices || seatHeightPrices.length === 0 || !seatHeight) return null;
    const tracking = fabricTrackings.find((ft) => ft.fabricCode === fabricCode);
    const tier =
      tracking?.sofaPriceTier ?? tracking?.priceTier ?? "PRICE_2";
    const cell = seatHeightPrices.find(
      (s) => s.height === seatHeight && (s.tier ?? "PRICE_2") === tier,
    );
    if (cell) return cell.priceSen;
    // Fallback: tier-agnostic match (e.g. PRICE_3 fabric on a SKU only
    // priced at PRICE_2 — show the closest rather than zero).
    const flat = seatHeightPrices.find((s) => s.height === seatHeight);
    return flat?.priceSen ?? null;
  };

  // Picker writes only fabricCode — the canonical reference (= raw_materials.itemCode).
  // fabricId is a UI-only artifact deprecated 2026-05-09; downstream (production,
  // MRP, fabric-usage, cost ledger, validation) all key on fabricCode. The legacy
  // fabricId column on sales_order_items is being dropped in a follow-up migration.
  const selectFabric = (idx: number, fabricCode: string) => {
    const fab = fabrics.find(f => f.code === fabricCode);
    if (!fab) return;
    const item = items[idx];

    // 0134 — Service Order mode: fabric is still required (production
    // routing) but does NOT seed basePriceSen from the tier matrix.
    // Operator types Base Price directly; auto-seeding would override
    // whatever they already typed.
    if (isServiceOrderMode) {
      if (item?.itemCategory === "SOFA") {
        propagateSofaVariant(idx, { fabricCode: fab.code });
      } else {
        updateItem(idx, { fabricCode: fab.code });
      }
      return;
    }

    if (item?.itemCategory === "SOFA") {
      // Tier-aware sofa pricing: when both seat height and fabric are
      // chosen, look up the (height, tier) cell of the price matrix and
      // seed basePriceSen. If only fabric is set, just store it — the
      // seat-height handler will resolve the price when that's picked.
      const newPrice = resolveSofaTierPrice(
        item.seatHeightPrices,
        item.seatHeight,
        fab.code,
      );
      propagateSofaVariant(idx, {
        fabricCode: fab.code,
        ...(newPrice !== null ? { basePriceSen: newPrice } : {}),
      });
    } else if (item?.itemCategory === "BEDFRAME" && item.productId) {
      // Look up fabric priceTier from tracking data — bedframe context uses
      // the bedframePriceTier split column (migration 0069), falling back to
      // the legacy priceTier and then PRICE_2.
      const tracking = fabricTrackings.find(ft => ft.fabricCode === fab.code);
      const priceTier =
        tracking?.bedframePriceTier ?? tracking?.priceTier ?? "PRICE_2";
      const prod = products.find(p => p.id === item.productId);
      let newPrice = item.basePriceSen;
      if (prod) {
        // Prefer customer-resolved price1Sen cached on the line; fall back
        // to global product price1Sen, then global basePriceSen.
        const p1 = item.price1Sen ?? prod.price1Sen ?? null;
        newPrice = priceTier === "PRICE_1" && p1
          ? p1
          : (prod.basePriceSen || 0);
      }
      updateItem(idx, { fabricCode: fab.code, basePriceSen: newPrice });
    } else {
      updateItem(idx, { fabricCode: fab.code });
    }
  };

  const selectGap = (idx: number, value: string) => {
    const inches = value ? parseInches(value) : null;
    updateItem(idx, { gapInches: inches });
  };

  const selectDivan = (idx: number, value: string) => {
    if (!value) {
      updateItem(idx, { divanHeightInches: null, divanPriceSen: 0 });
      return;
    }
    const opt = divanHeightOptions.find(o => o.height === value);
    if (opt) {
      // Use maintenance config surcharge if available
      let surcharge = opt.surcharge;
      if (maintenanceConfig?.divanHeights) {
        const cfgEntry = maintenanceConfig.divanHeights.find((e: {value:string; priceSen:number} | string) =>
          typeof e === "object" && e.value === value
        );
        if (cfgEntry && typeof cfgEntry === "object") surcharge = cfgEntry.priceSen;
      }
      updateItem(idx, {
        divanHeightInches: parseInches(opt.height),
        // 0134 — Service Order mode: variant surcharges are RM 0 by default.
        // The operator picks the divan height for production routing, not
        // for pricing; price lives in Base Price (editable). Catalog
        // surcharge is suppressed so the line total stays at 0 until the
        // operator edits Base Price.
        divanPriceSen: isServiceOrderMode ? 0 : surcharge,
      });
    }
  };

  const selectLeg = (idx: number, value: string) => {
    const item = items[idx];
    const isSofa = item?.itemCategory === "SOFA";
    const apply = (u: Partial<LineItem>) =>
      isSofa ? propagateSofaVariant(idx, u) : updateItem(idx, u);
    if (!value) {
      apply({ legHeightInches: null, legPriceSen: 0 });
      return;
    }
    const opt = legHeightOptions.find(o => o.height === value);
    if (opt) {
      // Use maintenance config surcharge — sofa uses sofaLegHeights, bedframe uses legHeights
      let surcharge = opt.surcharge;
      const cfgKey = isSofa ? "sofaLegHeights" : "legHeights";
      if (maintenanceConfig?.[cfgKey]) {
        const cfgEntry = maintenanceConfig[cfgKey].find((e: {value:string; priceSen:number} | string) =>
          typeof e === "object" && e.value === value
        );
        if (cfgEntry && typeof cfgEntry === "object") surcharge = cfgEntry.priceSen;
      }
      apply({
        legHeightInches: parseInches(opt.height),
        // 0134 — Service Order mode: leg surcharges suppressed (see selectDivan).
        legPriceSen: isServiceOrderMode ? 0 : surcharge,
      });
    }
  };

  const selectSeatHeight = (idx: number, value: string) => {
    const item = items[idx];
    // Read from the line's cached seatHeightPrices (populated by selectProduct
    // or customer-change re-fetch). Falls back to the global product record
    // only if no cached tiers are present.
    const cachedTiers = item.seatHeightPrices;
    const prod = products.find(p => p.id === item.productId);
    const tiers = (cachedTiers && cachedTiers.length > 0)
      ? cachedTiers
      : prod?.seatHeightPrices;
    if (!value || !tiers) {
      // propagateSofaVariant handles the basePrice reset on other lines via
      // its per-line seatHeightPrices lookup (here `undefined tier`).
      propagateSofaVariant(idx, { seatHeight: "", basePriceSen: 0 });
      return;
    }
    const tier = tiers.find(t => t.height === value);
    // For sofa items, the "Size" column downstream (SO detail / production
    // sheet) reads item.sizeLabel. The module code already lives in the
    // productCode (e.g. "5530-2A(LHF)") so "Size" should carry the seat
    // height — the variable variant — instead of the module. Propagate
    // the seat-height value into sizeLabel + sizeCode whenever it's
    // picked here so new rows are stored consistently; old rows keep
    // whatever was saved originally (data migration is a separate task).
    const sizeCode = value.replace(/"/g, "").trim();
    propagateSofaVariant(idx, {
      seatHeight: value,
      sizeLabel: value,
      sizeCode,
      // 0134 — Service Order mode: don't seed basePriceSen from the seat
      // tier matrix. Operator types Base Price; auto-seeding would
      // overwrite their input on each size change.
      basePriceSen: isServiceOrderMode ? 0 : (tier?.priceSen || 0),
    });
  };

  // Sum the predefined specials surcharge for a given code list, honoring
  // the HB+Divan combined-cover rule and the maintenance-config overrides.
  // Pulled out of toggleSpecialOrder so it can be reused when the custom
  // specials list changes (since both feed the same specialOrderPriceSen).
  const calcPredefinedSurcharge = (codes: string[], isSofa: boolean): number => {
    const cfgKey = isSofa ? "sofaSpecials" : "specials";
    const cfgSpecials = maintenanceConfig?.[cfgKey];
    if (!cfgSpecials || !Array.isArray(cfgSpecials)) {
      return calcSpecialOrderSurcharge(codes);
    }
    let surcharge = 0;
    const hasHBCover = codes.includes("HB_FULL_COVER");
    const hasDivanBtmCover = codes.includes("DIVAN_BTM_COVER");
    for (const c of codes) {
      const opt = specialOrderOptions.find(o => o.code === c);
      if (!opt) continue;
      if (hasHBCover && hasDivanBtmCover && (c === "HB_FULL_COVER" || c === "DIVAN_BTM_COVER")) continue;
      const cfgEntry = cfgSpecials.find((e: {value:string; priceSen:number} | string) =>
        typeof e === "object" && e.value === opt.name
      );
      surcharge += (cfgEntry && typeof cfgEntry === "object") ? cfgEntry.priceSen : opt.surcharge;
    }
    if (hasHBCover && hasDivanBtmCover) surcharge += 10000;
    return surcharge;
  };

  // Build the joined `specialOrder` text column from predefined codes and
  // the custom-special list. Predefined names come first, "OTHER: <desc>"
  // tokens follow — this is the format legacy readers (DO print, invoice,
  // detail page) already render verbatim.
  const buildSpecialOrderText = (codes: string[], customs: CustomSpecial[]): string => {
    const predefinedTokens = codes
      .map(c => specialOrderOptions.find(o => o.code === c)?.name || c);
    const customTokens = customs
      .map(c => c.description.trim())
      .filter(Boolean)
      .map(d => `OTHER: ${d}`);
    return [...predefinedTokens, ...customTokens].join("; ");
  };

  // Total surcharge for both predefined + custom specials. Custom entries
  // can have any non-negative sen amount (no combined-cover rule).
  const calcTotalSpecialSurcharge = (
    codes: string[],
    customs: CustomSpecial[],
    isSofa: boolean,
  ): number => {
    const predef = calcPredefinedSurcharge(codes, isSofa);
    const customSum = customs.reduce(
      (s, c) => s + (Number.isFinite(c.surchargeSen) && c.surchargeSen > 0 ? Math.round(c.surchargeSen) : 0),
      0,
    );
    return predef + customSum;
  };

  const toggleSpecialOrder = (idx: number, code: string) => {
    const item = items[idx];
    const isSofa = item?.itemCategory === "SOFA";
    const current = item.specialOrders;
    const next = current.includes(code)
      ? current.filter(c => c !== code)
      : [...current, code];

    // 0134 — Service Order mode: special-order surcharges are RM 0.
    // Operator picks the spec for production routing (Front Drawer changes
    // what's built); pricing lives in Base Price (editable). Catalog
    // surcharge is suppressed so the line total stays at 0.
    const surcharge = isServiceOrderMode
      ? 0
      : calcTotalSpecialSurcharge(next, item.customSpecials, isSofa);
    const label = buildSpecialOrderText(next, item.customSpecials);
    const patch = {
      specialOrders: next,
      specialOrder: label,
      specialOrderPriceSen: surcharge,
    };
    // Sofa sibling modules share the same special-order selection — per the
    // "variants cascade from first item" rule. Non-sofa lines edit in isolation.
    if (isSofa) {
      propagateSofaVariant(idx, patch);
    } else {
      updateItem(idx, patch);
    }
  };

  // Apply a new customSpecials array to a line — updates the joined
  // specialOrder text and recomputes the line's surcharge total. Sofa
  // siblings cascade together (mirrors toggleSpecialOrder's behavior).
  const applyCustomSpecials = (idx: number, customs: CustomSpecial[]) => {
    const item = items[idx];
    const isSofa = item?.itemCategory === "SOFA";
    // 0134 — Service Order mode: custom-special surcharges also suppressed.
    // The description carries (production sees it) but the surcharge total
    // is 0 — Base Price is the single price field operator edits.
    const surcharge = isServiceOrderMode
      ? 0
      : calcTotalSpecialSurcharge(item.specialOrders, customs, isSofa);
    const label = buildSpecialOrderText(item.specialOrders, customs);
    const patch: Partial<LineItem> = {
      customSpecials: customs,
      specialOrder: label,
      specialOrderPriceSen: surcharge,
    };
    if (isSofa) {
      propagateSofaVariant(idx, patch);
    } else {
      updateItem(idx, patch);
    }
  };

  const addCustomSpecial = (idx: number) => {
    const item = items[idx];
    const next: CustomSpecial[] = [
      ...item.customSpecials,
      { description: "", surchargeSen: 0 },
    ];
    applyCustomSpecials(idx, next);
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
    const next = item.customSpecials.filter((_, i) => i !== csIdx);
    applyCustomSpecials(idx, next);
  };

  const getUnitPrice = (item: LineItem) =>
    calculateUnitPrice({
      basePriceSen: item.basePriceSen,
      divanPriceSen: item.divanPriceSen,
      legPriceSen: item.legPriceSen,
      totalHeightPriceSen: item.totalHeightPriceSen,
      specialOrderPriceSen: item.specialOrderPriceSen,
    });

  // Line total = (unit price × qty) − per-line discount, clamped ≥ 0.
  // The per-line discount is applied AFTER the combo-adjusted base price and AFTER
  // all surcharges (divan/leg/special) — it's a manual operator adjustment on top.
  const getLineTotal = (item: LineItem) =>
    Math.max(0, calculateLineTotal(getUnitPrice(item), item.quantity) - (item.discountSen || 0));

  const getTotalHeight = (item: LineItem) => {
    const gap = item.gapInches || 0;
    const divan = item.divanHeightInches || 0;
    const leg = item.legHeightInches || 0;
    return gap + divan + leg;
  };

  const subtotalBeforeCombo = items.reduce(
    (sum, item) => sum + getLineTotal(item),
    0,
  );
  const totalQty = items.reduce((sum, item) => sum + item.quantity, 0);

  // -------------------------------------------------------------------------
  // Sofa combo detection (Phase 5c).
  // -------------------------------------------------------------------------
  // Group sofa lines by baseModel. For each group:
  //   1. Determine the uniform fabric tier (mixed-tier groups skip combo).
  //   2. Determine seat height (must be uniform across the group too — combo
  //      is keyed per height).
  //   3. Pick the best matching combo rule:
  //      customer-scoped + tier > customer-scoped + ANY > company + tier > company + ANY
  //      (effective_from <= today filtered, latest effective wins).
  //   4. Match componentSizes — supports both legacy flat shape and the new
  //      OR-group shape ([["2A(LHF)","2A(RHF)"],["L(LHF)","L(RHF)"]]). For
  //      OR-groups: every group must have ≥1 line with a matching sizeCode.
  //      For flat: line set must equal the combo set exactly.
  //   5. Compute discount = sum(line totals in group) − combo total for that
  //      seat height. Discount is positive when the combo saves money. If
  //      negative or zero, no discount is applied.
  type ComboMatch = {
    baseModel: string;
    seatHeight: string;
    fabricTier: "PRICE_1" | "PRICE_2" | "PRICE_3" | "ANY";
    customerSpecific: boolean;
    discountSen: number;
    comboTotalSen: number;
    components: string[]; // for display
    affectedLineUids: string[];
  };
  const todayDateStr = new Date().toISOString().slice(0, 10);
  // Greedy subset matcher (Wei Siang 2026-05-05).
  //
  // Rule semantic:
  //   - Flat shape (string[]): each element is a required size.
  //   - OR-group shape (string[][]): each group is "pick one option".
  //
  // Returns the subset of input lines that satisfies the rule's pieces
  // (one line per rule slot, greedy first-match), or null when at least
  // one rule slot can't be filled. Lines NOT in the returned subset are
  // "extras" and stay at full master price — no combo discount bleeds
  // into them. Replaces the older boolean matchesGroup which let extras
  // ride the combo (Wei Siang's 2A+L+1NA case → was wrongly snowballing
  // the 1NA into the 2A+L combo's redistribution).
  const findComboSubset = <L extends { sizeCode: string }>(
    groups: string[] | string[][],
    lines: L[],
  ): L[] | null => {
    if (!Array.isArray(groups) || groups.length === 0) return null;
    const isGrouped = Array.isArray(groups[0]);
    const remaining = lines.slice();
    const matched: L[] = [];
    if (!isGrouped) {
      for (const ruleSize of (groups as string[])) {
        const idx = remaining.findIndex((l) => l.sizeCode === ruleSize);
        if (idx === -1) return null;
        matched.push(remaining[idx]);
        remaining.splice(idx, 1);
      }
      return matched;
    }
    for (const groupOpts of (groups as string[][])) {
      const idx = remaining.findIndex((l) => groupOpts.includes(l.sizeCode));
      if (idx === -1) return null;
      matched.push(remaining[idx]);
      remaining.splice(idx, 1);
    }
    return matched;
  };
  const lineFabricTier = (line: LineItem): "PRICE_1" | "PRICE_2" | "PRICE_3" | null => {
    // Combo detection only fires for sofa lines, so resolve via the
    // sofaPriceTier split column (migration 0069). Falls back to the legacy
    // priceTier so old data still matches.
    const tracking = fabricTrackings.find((ft) => ft.fabricCode === line.fabricCode);
    return tracking?.sofaPriceTier ?? tracking?.priceTier ?? null;
  };
  const comboMatches: ComboMatch[] = useMemo(() => {
    const out: ComboMatch[] = [];
    const sofaLines = items.filter(
      (it) => it.itemCategory === "SOFA" && !!it.baseModel && !!it.seatHeight && !!it.fabricCode,
    );
    if (sofaLines.length === 0 || sofaCombos.length === 0) return out;
    const byBase = new Map<string, LineItem[]>();
    for (const l of sofaLines) {
      const arr = byBase.get(l.baseModel) ?? [];
      arr.push(l);
      byBase.set(l.baseModel, arr);
    }
    for (const [baseModel, group] of byBase) {
      // Uniform tier across group, else combo doesn't apply.
      const tiers = new Set<string | null>();
      for (const g of group) tiers.add(lineFabricTier(g));
      if (tiers.size > 1 || tiers.has(null)) continue;
      const groupTier = ([...tiers][0] ?? null) as
        | "PRICE_1"
        | "PRICE_2"
        | "PRICE_3"
        | null;
      if (!groupTier) continue;
      // Uniform seat height required (combo prices are per height).
      const heights = new Set(group.map((g) => g.seatHeight));
      if (heights.size > 1) continue;
      const seatHeight = [...heights][0];
      // Candidate rules — for each rule, attempt to find a subset of the
      // group that satisfies the rule's componentSizes. Rules whose pieces
      // can't be fully filled by this group are dropped. Extras (lines
      // outside the matched subset) keep their per-piece master price.
      const candidates = sofaCombos
        .filter(
          (r) =>
            r.baseModel === baseModel && r.effectiveFrom <= todayDateStr,
        )
        .map((r) => ({ r, subset: findComboSubset(r.componentSizes, group) }))
        .filter((x): x is { r: SofaComboRule; subset: LineItem[] } => x.subset !== null);
      if (candidates.length === 0) continue;
      // Priority: (customer + tier) > (customer + ANY) > (company + tier) > (company + ANY).
      const priorityOf = (r: SofaComboRule): number => {
        const isCustomer = r.customerId === customerId && customerId !== "";
        const tierMatch = r.fabricTier === groupTier;
        if (isCustomer && tierMatch) return 4;
        if (isCustomer && r.fabricTier === "ANY") return 3;
        if (!r.customerId && tierMatch) return 2;
        if (!r.customerId && r.fabricTier === "ANY") return 1;
        return 0;
      };
      const best = candidates
        .map(({ r, subset }) => ({ r, subset, p: priorityOf(r) }))
        .filter((x) => x.p > 0)
        .sort((a, b) => b.p - a.p || (a.r.effectiveFrom < b.r.effectiveFrom ? 1 : -1))[0];
      if (!best) continue;
      const comboTotal = best.r.pricesByHeight[seatHeight];
      if (typeof comboTotal !== "number" || comboTotal <= 0) continue;
      // Subset sum (not full group). Extras stay at master price entirely.
      const subsetSum = best.subset.reduce((s, g) => s + getLineTotal(g), 0);
      const discount = subsetSum - comboTotal;
      if (discount <= 0) continue;
      out.push({
        baseModel,
        seatHeight,
        fabricTier: best.r.fabricTier,
        customerSpecific: best.r.customerId === customerId && customerId !== "",
        discountSen: discount,
        comboTotalSen: comboTotal,
        components: best.subset.map((l) => l.sizeCode),
        affectedLineUids: best.subset.map((l) => l._uid),
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- getLineTotal is stable
  }, [items, sofaCombos, fabricTrackings, customerId]);

  const totalComboDiscountSen = comboMatches.reduce(
    (s, m) => s + m.discountSen,
    0,
  );
  const subtotal = subtotalBeforeCombo - totalComboDiscountSen;

  const handleSubmit = async (status: "DRAFT" | "CONFIRMED" = "DRAFT") => {
    if (!customerId) { toast.warning("Please select a customer"); return; }
    if (items.some(l => !l.productId)) { toast.warning("Please select a product for all line items"); return; }
    if (items.some(l => !l.fabricCode)) { toast.warning("Please select a fabric for all line items"); return; }
    // Sofa lines must have model + seat size chosen from dropdowns (no free text / blanks)
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
    // Repair Scope (0160) — same shared validator the backend POST runs, so
    // Save fails fast with the identical English error (e.g. Custom with no
    // departments ticked). Normal SO mode always submits null.
    for (let i = 0; i < items.length; i++) {
      const scopeCheck = validateRepairScopeInput(items[i].repairScope ?? null);
      if (!scopeCheck.ok) {
        toast.error(`Line ${i + 1}: ${scopeCheck.error}`);
        return;
      }
    }

    setPendingStatus(status);
    setSaving(true);
    // Guard against silent HTTP failures. A 401 (expired token) or 500
    // returns a body the JSON parse still accepts, so without checking
    // res.ok the "success" branch could fire on an error response and the
    // user would navigate to a detail page for a SO that was never created.
    // Sprint 3 #4 — idempotency. A network blip on submit could leave the
    // user uncertain whether the SO was created. Send a UUID so a retry
    // returns the cached response instead of creating a duplicate. Same
    // key reused for the chained /confirm call so a retry of the whole
    // flow short-circuits both POSTs.
    const idemKey = crypto.randomUUID();
    // Apply combo discount before submit by reducing each affected line's
    // basePriceSen proportionally. Final stored line totals add up to the
    // combo's negotiated total — downstream invoicing/COGS reads correct
    // numbers without needing a discount column on sales_orders. Lines
    // outside any combo are untouched. Phase 5c.b.
    let itemsAfterCombo: LineItem[] = items;
    if (comboMatches.length > 0) {
      const adjustments = new Map<string, number>(); // _uid → new basePriceSen
      for (const m of comboMatches) {
        const groupLines = items.filter((l) => m.affectedLineUids.includes(l._uid));
        const groupSum = groupLines.reduce((s, l) => s + getLineTotal(l), 0);
        if (groupSum <= 0) continue;
        const ratio = m.comboTotalSen / groupSum;
        for (const l of groupLines) {
          const lineTotal = getLineTotal(l);
          // Re-derive an adjusted unit price for the line (after the combo
          // discount), then back out the new basePriceSen. We keep the
          // surcharges (divan/leg/totalHeight/special/quantity) as-is — only
          // basePriceSen absorbs the discount, since that's the SKU value
          // the combo is renegotiating. Round-down with a final rounding
          // residual rebalanced into the last line so the group sum still
          // exactly equals comboTotalSen.
          const adjustedLineTotal = Math.floor(lineTotal * ratio);
          const surchargesPerUnit =
            (l.divanPriceSen || 0) +
            (l.legPriceSen || 0) +
            (l.totalHeightPriceSen || 0) +
            (l.specialOrderPriceSen || 0);
          const adjustedUnit = Math.max(0, Math.round(adjustedLineTotal / Math.max(1, l.quantity)));
          const newBase = Math.max(0, adjustedUnit - surchargesPerUnit);
          adjustments.set(l._uid, newBase);
        }
        // Rebalance rounding residual into the highest-priced line in the
        // group so the post-discount sum matches comboTotalSen exactly.
        const newGroupSum = groupLines.reduce((s, l) => {
          const newBase = adjustments.get(l._uid) ?? l.basePriceSen;
          const unit =
            newBase +
            (l.divanPriceSen || 0) +
            (l.legPriceSen || 0) +
            (l.totalHeightPriceSen || 0) +
            (l.specialOrderPriceSen || 0);
          return s + unit * l.quantity;
        }, 0);
        const residual = m.comboTotalSen - newGroupSum;
        if (residual !== 0 && groupLines.length > 0) {
          // Push residual into the line with the highest current basePrice.
          const target = groupLines
            .slice()
            .sort((a, b) => (adjustments.get(b._uid) ?? b.basePriceSen) - (adjustments.get(a._uid) ?? a.basePriceSen))[0];
          const cur = adjustments.get(target._uid) ?? target.basePriceSen;
          adjustments.set(target._uid, Math.max(0, cur + Math.round(residual / Math.max(1, target.quantity))));
        }
      }
      itemsAfterCombo = items.map((l) =>
        adjustments.has(l._uid) ? { ...l, basePriceSen: adjustments.get(l._uid)! } : l,
      );
    }
    try {
      // Strip the client-only `_uid` so the server contract is unchanged.
      const itemsForServer = itemsAfterCombo.map((it) => {
        const { _uid: _drop, ...rest } = it;
        void _drop;
        return rest;
      });
      const res = await fetch("/api/sales-orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idemKey,
        },
        body: JSON.stringify({
          customerId, customerPOId, customerSOId, reference,
          companySODate, customerDeliveryDate, hookkaExpectedDD, notes,
          // Multi-Company Phase 2 — company this SO is booked under.
          salesOrgCode,
          items: itemsForServer,
          status,
          // 0134 — flips the new SO into a Service Order (SV-YYMM-NNN
          // prefix + is_service_order = TRUE) when the operator came
          // from /service-order/create.
          isServiceOrder: isServiceOrderMode,
          // 0165 — case linkage when hydrated via ?fromCase: the created SV
          // order lands on the case's "Service Orders" panel.
          caseId: isServiceOrderMode && linkedCase ? linkedCase.id : undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: { id?: string; companySOId?: string } };

      if (!res.ok || !data.success) {
        setSaving(false);
        toast.error(data.error || `Failed to create order (HTTP ${res.status})`);
        return;
      }
      invalidateCachePrefix("/api/sales-orders");
      invalidateCachePrefix("/api/production-orders");
      const newId = data.data?.id;
      const newSoNumber = data.data?.companySOId || "";

      // POST / always persists as DRAFT. If the user clicked "Create Order"
      // (CONFIRMED branch), immediately fire /confirm to run the BOM
      // guard + PO cascade -> the server lands the SO at IN_PRODUCTION.
      // A 422 here leaves the SO as DRAFT on the server — we surface the
      // BOM-incomplete modal and keep the user on the new SO's detail page.
      if (status === "CONFIRMED" && newId) {
        // Switch loading copy from "Creating..." to "Confirming..." so the
        // user sees both phases of the chained call.
        setPendingStatus("CONFIRMING");
        const confirmRes = await fetch(`/api/sales-orders/${newId}/confirm`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": `${idemKey}-confirm`,
          },
          body: JSON.stringify({ changedBy: "Admin" }),
        });
        const confirmData = (await confirmRes.json().catch(() => ({}))) as {
          success?: boolean;
          error?: string;
          details?: { incompleteProducts?: Array<{ productCode: string; productName: string; reason: string }> };
        };
        setSaving(false);
        if (confirmRes.status === 422 && confirmData.details?.incompleteProducts) {
          setBomError({ open: true, incompleteProducts: confirmData.details.incompleteProducts, soId: newId });
          return;
        }
        if (!confirmRes.ok || !confirmData.success) {
          // POST succeeded so a DRAFT exists, but confirm failed (non-BOM
          // reason). Tell the user explicitly that the order is saved as
          // a draft and let them retry confirm from the list/detail page.
          const reason = confirmData.error || `HTTP ${confirmRes.status}`;
          toast.warning(`Order saved as draft - confirm manually from list. Reason: ${reason}`);
          navigate(`${basePath}/${newId}`);
          return;
        }
        invalidateCachePrefix("/api/sales-orders");
        invalidateCachePrefix("/api/production-orders");
        // Successful confirm — wipe the draft so the next visit to /sales/create
        // starts fresh. Failure paths (DRAFT-only saves, BOM-incomplete) keep
        // the draft alive in case the user wants to retry.
        clearFormDraft(draftKey);
        toast.success(
          newSoNumber
            ? `Order created and in production: ${newSoNumber}`
            : "Order created and in production",
        );
        navigate(`${basePath}/${newId}`);
        return;
      }

      setSaving(false);
      if (newId) {
        // Saved as DRAFT — also clear the draft since the form is now
        // persisted server-side under a real SO id.
        clearFormDraft(draftKey);
        toast.success(
          newSoNumber ? `Draft saved: ${newSoNumber}` : "Draft saved",
        );
        navigate(`${basePath}/${newId}`);
      }
    } catch (e) {
      setSaving(false);
      toast.error(e instanceof Error ? e.message : "Network error - order not saved");
    }
  };

  const selectedCustomer = customers.find(c => c.id === customerId);

  return (
    <div className="space-y-6">
      {/* BOM Incomplete Modal — shown on 422 from /confirm after create. */}
      {bomError.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/40" onClick={() => setBomError({ open: false, incompleteProducts: [], soId: null })} />
          <div className="relative bg-white rounded-lg shadow-xl border border-[#E2DDD8] w-full max-w-lg mx-4 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-[#9A3A2D]" />
                <h3 className="text-lg font-semibold text-[#1F1D1B]">Cannot Confirm — BOM Incomplete</h3>
              </div>
              <button onClick={() => setBomError({ open: false, incompleteProducts: [], soId: null })} className="text-[#9CA3AF] hover:text-[#374151]"><X className="h-5 w-5" /></button>
            </div>
            <p className="text-sm text-[#374151]">
              Cannot confirm — the following products have no BOM yet:
            </p>
            <ul className="space-y-1 text-sm bg-[#FBF3F1] border border-[#E8B2A1] rounded-md p-3 max-h-64 overflow-y-auto">
              {bomError.incompleteProducts.map((p) => (
                <li key={p.productCode} className="font-mono text-[#7A2E24]">
                  {p.productCode}: {p.productName}
                </li>
              ))}
            </ul>
            <p className="text-xs text-[#6B7280]">
              Please complete their BOM in Products &rarr; BOM first, then retry. The order has been saved as DRAFT.
            </p>
            <div className="flex justify-end gap-3">
              {bomError.incompleteProducts.length === 1 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    const code = bomError.incompleteProducts[0].productCode;
                    navigate(`/products/bom?sku=${encodeURIComponent(code)}`);
                  }}
                >
                  Open BOM for {bomError.incompleteProducts[0].productCode}
                </Button>
              )}
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  const soId = bomError.soId;
                  setBomError({ open: false, incompleteProducts: [], soId: null });
                  if (soId) navigate(`${basePath}/${soId}`);
                }}
              >
                Open SO as Draft
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Form-draft restore banner — appears once per session per draftKey
          when an unsaved draft is detected and the form is still empty. */}
      {draftBannerVisible && (
        <div className="rounded-md border border-[#A8CAD2] bg-[#E0EDF0] px-4 py-3 flex items-center justify-between text-sm">
          <div>
            <span className="font-medium text-[#3E6570]">Restore your draft?</span>
            <span className="ml-2 text-[#6B7280]">
              You started filling in this form earlier. Restore your in-progress entries?
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={discardDraft} className="text-[#6B7280]">
              Discard
            </Button>
            <Button variant="primary" size="sm" onClick={restoreDraft}>
              Restore
            </Button>
          </div>
        </div>
      )}

      <div className="flex items-center gap-4 flex-wrap">
        <Button variant="ghost" size="icon" onClick={() => navigate(basePath)}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1 min-w-[160px]">
          <h1 className="text-xl font-bold text-[#1F1D1B]">
            {isClone
              ? `Clone ${soSingularNoun(mode)}`
              : `New ${soSingularNoun(mode)}`}
          </h1>
          <p className="text-xs text-[#6B7280]">
            {isServiceOrderMode
              ? `Aftersales order — copy lines from an existing Sales / Consignment Order, then edit each line's price (defaults to 0).${linkedCase ? ` Linked to case ${linkedCase.caseNo}.` : ""}`
              : isClone
                ? "Create a new order based on an existing one"
                : "Create a new sales order for a customer"}
          </p>
        </div>
        {/* Copy-from button — Service Order mode only. Opens a modal that
            lets the operator pick a source SO/CO and a subset of its
            lines, then fills this form via POST /copy-for-service-order. */}
        {isServiceOrderMode && (
          <Button
            variant="outline"
            onClick={() => setCopyFromOpen(true)}
            disabled={saving}
          >
            Copy from SO/CO
          </Button>
        )}
        <Button variant="outline" onClick={() => navigate(basePath)}>Cancel</Button>
        <Button
          variant="outline"
          onClick={() => handleSubmit("DRAFT")}
          onMouseEnter={() => setPendingStatus("DRAFT")}
          disabled={saving}
        >
          <Save className="h-4 w-4" />
          {saving && pendingStatus === "DRAFT" ? "Saving..." : "Save as Draft"}
        </Button>
        <Button
          onClick={() => handleSubmit("CONFIRMED")}
          onMouseEnter={() => setPendingStatus("CONFIRMED")}
          disabled={saving}
          className="bg-[#6B5C32] text-white hover:bg-[#5a4d2a]"
        >
          <Save className="h-4 w-4" />
          {saving && pendingStatus === "CONFIRMING"
            ? "Confirming..."
            : saving && pendingStatus === "CONFIRMED"
              ? "Creating..."
              : "Create Order"}
        </Button>
      </div>

      <div className="grid gap-6 grid-cols-1 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="pb-3"><CardTitle>Order Details</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Customer *</label>
                <SearchableSelect
                  value={customerId}
                  onChange={(cid) => {
                    setCustomerId(cid);
                    const cust = customers.find(c => c.id === cid);
                    const hubs = cust?.deliveryHubs || [];
                    if (hubs.length === 1) {
                      setDeliveryHubId(hubs[0].id);
                    } else {
                      setDeliveryHubId("");
                    }
                    // Multi-Company Phase 4 — pre-fill the company selector from
                    // this customer's default company mapping, if any and if the
                    // mapped company is an active org. Unmapped customers leave
                    // the selector on its current value (HOOKKA by default) — the
                    // operator can still override the pick by hand afterwards.
                    const mapped = (cust?.defaultCompanyCode || "").trim().toUpperCase();
                    if (mapped && activeOrgs.some((o) => o.code === mapped)) {
                      setSalesOrgCode(mapped);
                    }
                  }}
                  options={customers.map(c => ({ value: c.id, label: `${c.code} - ${c.name}` }))}
                  placeholder="Select customer..."
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Delivery Hub *</label>
                {selectedCustomer && (selectedCustomer.deliveryHubs?.length || 0) === 1 ? (
                  <div className="w-full rounded-md border border-[#E2DDD8] bg-[#FAF9F7] px-3 py-2 text-sm text-[#1F1D1B]">
                    {selectedCustomer.deliveryHubs![0].shortName} — {selectedCustomer.deliveryHubs![0].address?.substring(0, 50)}
                  </div>
                ) : (
                  <SearchableSelect
                    value={deliveryHubId}
                    onChange={setDeliveryHubId}
                    options={(selectedCustomer?.deliveryHubs || []).map(h => ({
                      value: h.id,
                      label: `${h.shortName} — ${h.address?.substring(0, 50) || ""}`,
                    }))}
                    placeholder={selectedCustomer ? "Select delivery hub..." : "Select customer first"}
                    disabled={!selectedCustomer}
                  />
                )}
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
                {/* Multi-Company Phase 2 — company this Sales Order is booked
                    under. Defaults to HOOKKA; other sister companies come from
                    the /api/organisations registry. */}
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Company</label>
                <select
                  className="w-full h-9 rounded-md border border-[#E2DDD8] bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]/20 focus:border-[#6B5C32]"
                  value={salesOrgCode}
                  onChange={(e) => setSalesOrgCode(e.target.value)}
                  aria-label="Company this sales order is booked under"
                >
                  {activeOrgs.length === 0 ? (
                    <option value="HOOKKA">HOOKKA</option>
                  ) : (
                    activeOrgs.map((o) => (
                      <option key={o.code} value={o.code}>{o.name}</option>
                    ))
                  )}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Company SO Date</label>
                <Input type="date" value={companySODate} onChange={(e) => setCompanySODate(e.target.value)} />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1.5">Customer Delivery Date</label>
                <Input type="date" value={customerDeliveryDate} onChange={(e) => setCustomerDeliveryDate(e.target.value)} />
              </div>
            </div>

            {selectedCustomer && (
              <div className="rounded-md bg-[#FAF9F7] border border-[#E2DDD8] p-3 text-sm">
                <div className="flex flex-wrap gap-x-6 gap-y-1">
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
            <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Total Qty</span><span className="font-medium">{totalQty}</span></div>
            <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Line Items</span><span className="font-medium">{items.filter(l => l.productId).length}</span></div>
            <hr className="border-[#E2DDD8]" />
            <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Subtotal</span><span className="font-medium amount">{formatCurrency(subtotalBeforeCombo)}</span></div>
            {comboMatches.map((m, i) => (
              <div
                key={`combo-${i}`}
                className="flex justify-between text-sm"
                title={`${m.baseModel} ${m.components.join(" + ")} @ ${m.seatHeight}" — combo total ${formatCurrency(m.comboTotalSen)}${m.customerSpecific ? " (customer-specific)" : ""}`}
              >
                <span className="text-[#4F7C3A]">
                  Combo discount ({m.baseModel} {m.fabricTier === "ANY" ? "" : m.fabricTier})
                </span>
                <span className="font-medium text-[#4F7C3A] amount">
                  −{formatCurrency(m.discountSen)}
                </span>
              </div>
            ))}
            <div className="flex justify-between text-lg font-bold"><span>Total</span><span className="text-[#6B5C32]">{formatCurrency(subtotal)}</span></div>
            <div className="text-xs text-[#9CA3AF]">Status will be set to {pendingStatus === "DRAFT" ? "DRAFT" : "IN_PRODUCTION"}</div>
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
          {items.map((item, idx) => (
            <LineItemCard
              key={item._uid}
              item={item}
              idx={idx}
              // Filter the catalogue down to what's actually assigned to
              // this customer. When no customer is selected, fall through
              // to the full master list — stays compatible with workflows
              // that build the line set before picking a customer.
              // Always show every master product (added 2026-05-06 per
              // user request "全部自动 api 过去 要不然我选不到再 sales
              // order 里面"). Previously the picker filtered to only the
              // customer's `customer_products` rows, which left newly-
              // added master variants invisible until somebody clicked
              // "Assign SKU" per customer. The customerProductsMap is
              // still consulted on selectProduct for per-customer price
              // overrides — see seedPrice1 at ~line 775 — so a customer
              // who HAS overridden a SKU's price still gets that override
              // applied, but customers who never assigned the SKU now see
              // it (with master pricing) instead of the picker hiding it.
              products={products}
              fabrics={fabrics}
              onSelectProduct={selectProduct}
              onSelectFabric={selectFabric}
              onSelectGap={selectGap}
              onSelectDivan={selectDivan}
              onSelectLeg={selectLeg}
              onSelectSeatHeight={selectSeatHeight}
              onToggleSpecialOrder={toggleSpecialOrder}
              onAddCustomSpecial={addCustomSpecial}
              onUpdateCustomSpecial={updateCustomSpecial}
              onRemoveCustomSpecial={removeCustomSpecial}
              onAddSofaModules={addSofaModules}
              onUpdate={updateItem}
              onRemove={removeItem}
              canRemove={items.length > 1}
              getUnitPrice={getUnitPrice}
              getLineTotal={getLineTotal}
              getTotalHeight={getTotalHeight}
              maintenanceConfig={maintenanceConfig}
              isServiceOrderMode={isServiceOrderMode}
            />
          ))}
        </CardContent>
      </Card>

      {/* 0134 — Copy-from-SO/CO modal (Service Order mode only). */}
      {copyFromOpen && isServiceOrderMode && (
        <CopyFromSourceModal
          onClose={() => setCopyFromOpen(false)}
          onCopied={(draft) => {
            // Hydrate the form via the shared copy-draft helpers (also used
            // by the ?fromCase hand-off above). Prices are all 0 per spec —
            // operator MUST edit each line before save.
            applyCopyDraftHeader(draft);
            const built = buildLinesFromCopyDraft(draft.items);
            if (built.length > 0) setItems(built);
            setCopyFromOpen(false);
            toast.success(
              `Copied ${built.length} line(s) from ${draft.sourceType} ${draft.sourceNo}. Set prices before saving.`,
            );
          }}
        />
      )}
    </div>
  );
}

// ─── Copy-from Source Modal (0134 Service Order — two-step picker) ─────
//
// Step 1: operator picks SO or CO and types the source order id
//         (SO-2605-014 / CO-2605-003).
// Step 2: the modal fetches the source order's line items and renders a
//         checklist (all checked by default) with a per-line spec subline
//         (gap / divan / leg / special orders / custom specials) so the
//         operator can distinguish lines that share product+size but
//         differ on attributes. Each row also exposes a "Copy Qty" input
//         capped to the source line's qty — letting the operator take, say,
//         1 of a 2-qty source line. On submit the backend gets
//         lineItems: [{ id, qty }] and returns a draft with just those
//         lines, qty-overridden.
//
// On success the parent's onCopied receives the draft payload (customer,
// hub, lines, dates, prices reset to 0).
type CopyDraftItem = {
  productId?: string;
  productCode?: string;
  productName?: string;
  itemCategory?: string;
  sizeCode?: string;
  sizeLabel?: string;
  fabricCode?: string;
  quantity: number;
  gapInches?: number | null;
  divanHeightInches?: number | null;
  legHeightInches?: number | null;
  specialOrder?: string;
  notes?: string;
  customSpecials?: Array<{ description: string; surchargeSen: number }>;
};
type CopyDraft = {
  customerId: string;
  customerName?: string;
  customerState?: string;
  hubId: string | null;
  hubName?: string;
  customerPO?: string;
  customerPOId?: string;
  // 0134 — destination Service Order's Customer SO slot carries the EX-
  // prefixed source order id (e.g. "EX-SO-2605-121"). Backend now sets
  // both fields; the form binds to customerSOId.
  customerSO?: string;
  customerSOId?: string;
  reference?: string;
  companySODate?: string;
  customerDeliveryDate?: string;
  items: CopyDraftItem[];
  sourceType: "SO" | "CO";
  sourceId: string;
  sourceNo: string;
};
// Shape of one source line item the picker shows in Step 2. We pluck
// the identifying fields (product / size / fabric / qty) PLUS the per-line
// spec (gap / divan / leg / special order / custom specials) so the operator
// can distinguish lines that share product+size but differ on attributes.
// Pricing data is irrelevant — the backend zeroes all prices anyway.
type SourceLineRow = {
  id: string;
  productCode: string;
  productName: string;
  itemCategory: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  gapInches: number | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  specialOrder: string;
  customSpecials: Array<{ description: string; surchargeSen: number }>;
};
// SO lines persist customSpecials as a JSON string; CO lines don't store
// any. Accept either shape from the detail fetch and normalize in the
// modal. `null` covers the missing-key case.
type SourceLinesRawCustomSpecials =
  | string
  | Array<{ description?: string; surchargeSen?: number }>
  | null;

function CopyFromSourceModal({
  onClose,
  onCopied,
}: {
  onClose: () => void;
  onCopied: (draft: CopyDraft) => void;
}) {
  // Step 1 = "pick source", Step 2 = "pick line items".
  const [step, setStep] = useState<1 | 2>(1);
  const [sourceType, setSourceType] = useState<"SO" | "CO">("SO");
  const [sourceLookup, setSourceLookup] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Step-2 state: the resolved source row + its line items + checked set +
  // per-line qty override map (line id → qty, defaults to source qty).
  const [resolvedSourceId, setResolvedSourceId] = useState("");
  const [resolvedSourceNo, setResolvedSourceNo] = useState("");
  const [sourceLines, setSourceLines] = useState<SourceLineRow[]>([]);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [qtyById, setQtyById] = useState<Map<string, number>>(new Map());
  // Ambiguous-lookup chooser: a customer PO/SO number can span several of
  // our SOs (split orders share the customer's paperwork), so a lookup by
  // those may legitimately hit 2+ rows — the operator picks which one.
  const [matchChoices, setMatchChoices] = useState<
    Array<{ id: string; label: string; customerName: string; matched: string }>
  >([]);

  // Step 1 → Step 2: look up the typed order number, then fetch its lines.
  // The SO lookup accepts FOUR document numbers (Wei Siang 2026-06-11/12:
  // customers report aftersales issues quoting THEIR paperwork, not ours):
  //   1. our company SO id  (companySOId, SO-YYMM-NNN)
  //   2. the customer's PO number (customerPOId)
  //   3. the customer's own SO number (customerSO / customerSOId)
  //   4. the order's reference field
  // CO lookups match company CO id or reference.
  async function handleResolveSource() {
    if (!sourceLookup.trim()) {
      setError("Enter a source order number");
      return;
    }
    setBusy(true);
    setError("");
    setMatchChoices([]);
    try {
      // Resolve the typed number to the underlying row id. The copy
      // endpoint takes a row id; the operator types a human document no.
      const listUrl =
        sourceType === "SO"
          ? `/api/sales-orders?isServiceOrder=all`
          : `/api/consignment-orders`;
      const listRes = await fetch(listUrl);
      const listJson = (await listRes.json()) as {
        success?: boolean;
        data?: Array<{
          id: string;
          companySOId?: string;
          companyCOId?: string;
          customerPOId?: string;
          customerSO?: string;
          customerSOId?: string;
          reference?: string;
          customerName?: string;
        }>;
      };
      const candidates = listJson.data ?? [];
      const norm = (s?: string | null) => (s ?? "").trim().toUpperCase();
      const target = norm(sourceLookup);
      // Prefix-tolerant match: operators type "2605-001" for "SO-2605-001"
      // (Wei Siang 2026-07-02 — "why must I type the full number?"). The
      // resolver strips our SO-/CO-/SV- prefix on both sides for OUR ids;
      // customer PO / SO / reference stay exact. See @/lib/order-lookup-match.
      const matchedField = (r: (typeof candidates)[number]): string | null =>
        matchedOrderField(r, sourceType, target);
      const matches = candidates
        .map((r) => ({ row: r, matched: matchedField(r) }))
        .filter((m): m is { row: (typeof candidates)[number]; matched: string } => m.matched !== null);
      if (matches.length === 0) {
        setError(
          sourceType === "SO"
            ? `No order found matching ${target} — tried our SO, customer PO, customer SO, and reference.`
            : `No CO found matching ${target} — tried our CO id and reference.`,
        );
        setBusy(false);
        return;
      }
      if (matches.length > 1) {
        // Several of our SOs carry that customer document — let the
        // operator pick the right one instead of guessing.
        setMatchChoices(
          matches.map((m) => ({
            id: m.row.id,
            label: m.row.companySOId || m.row.id,
            customerName: m.row.customerName || "",
            matched: m.matched,
          })),
        );
        setBusy(false);
        return;
      }
      await loadSourceLines(matches[0].row.id);
    } catch (e) {
      setError(humanizeError(e, "Network problem — please try again."));
      setBusy(false);
    }
  }

  // Shared by the single-match path and the ambiguous-match chooser.
  async function loadSourceLines(matchId: string) {
    setBusy(true);
    setError("");
    try {
      // Fetch the source order detail to pull its line items for the picker.
      const detailUrl =
        sourceType === "SO"
          ? `/api/sales-orders/${matchId}`
          : `/api/consignment-orders/${matchId}`;
      const detailRes = await fetch(detailUrl);
      const detailJson = (await detailRes.json()) as {
        success?: boolean;
        error?: string;
        data?: {
          companySOId?: string;
          companyCOId?: string;
          items?: Array<{
            id: string;
            productCode?: string;
            productName?: string;
            itemCategory?: string;
            sizeLabel?: string;
            fabricCode?: string;
            quantity?: number;
            gapInches?: number | null;
            divanHeightInches?: number | null;
            legHeightInches?: number | null;
            specialOrder?: string | null;
            customSpecials?:
              | string
              | Array<{ description?: string; surchargeSen?: number }>
              | null;
          }>;
        };
      };
      if (!detailRes.ok || !detailJson.success || !detailJson.data) {
        setError(humanizeError({ status: detailRes.status, message: detailJson.error }, "Couldn't load that order. Please try again."));
        setBusy(false);
        return;
      }
      const rawItems = detailJson.data.items ?? [];
      if (rawItems.length === 0) {
        setError("That order has no line items to copy");
        setBusy(false);
        return;
      }
      // customSpecials comes down as a JSON string on SO lines and as an
      // empty array on CO lines. Normalize both into the picker shape so
      // the spec subline can render any saved special-order entries.
      const normalizeCustomSpecials = (
        raw: SourceLinesRawCustomSpecials,
      ): Array<{ description: string; surchargeSen: number }> => {
        if (!raw) return [];
        let arr: unknown = raw;
        if (typeof raw === "string") {
          try {
            arr = JSON.parse(raw);
          } catch {
            return [];
          }
        }
        if (!Array.isArray(arr)) return [];
        return arr
          .map((x) => {
            if (!x || typeof x !== "object") return null;
            const obj = x as { description?: unknown; surchargeSen?: unknown };
            return {
              description: typeof obj.description === "string" ? obj.description : "",
              surchargeSen: Number(obj.surchargeSen) || 0,
            };
          })
          .filter(
            (x): x is { description: string; surchargeSen: number } =>
              x !== null && x.description.length > 0,
          );
      };
      const lines: SourceLineRow[] = rawItems.map((it) => ({
        id: it.id,
        productCode: it.productCode ?? "",
        productName: it.productName ?? "",
        itemCategory: it.itemCategory ?? "BEDFRAME",
        sizeLabel: it.sizeLabel ?? "",
        fabricCode: it.fabricCode ?? "",
        quantity: Number(it.quantity) || 0,
        gapInches: it.gapInches ?? null,
        divanHeightInches: it.divanHeightInches ?? null,
        legHeightInches: it.legHeightInches ?? null,
        specialOrder: it.specialOrder ?? "",
        customSpecials: normalizeCustomSpecials(it.customSpecials ?? null),
      }));
      setResolvedSourceId(matchId);
      setResolvedSourceNo(
        (sourceType === "SO"
          ? detailJson.data.companySOId
          : detailJson.data.companyCOId) ?? sourceLookup.trim().toUpperCase(),
      );
      setMatchChoices([]);
      setSourceLines(lines);
      // Default all checked — operator unchecks what they don't want.
      setCheckedIds(new Set(lines.map((l) => l.id)));
      // Default qty override = source qty. Operator can dial it down.
      setQtyById(new Map(lines.map((l) => [l.id, l.quantity])));
      setStep(2);
    } catch (e) {
      setError(humanizeError(e, "Network problem — please try again."));
    } finally {
      setBusy(false);
    }
  }

  // Step 2 → Done: post the selected line items + their qty overrides to
  // the copy endpoint. Backend clamps each qty to 1..sourceQty.
  async function handleCopySelected() {
    const picked = sourceLines
      .filter((l) => checkedIds.has(l.id))
      .map((l) => ({
        id: l.id,
        qty: Math.max(1, Math.min(l.quantity, qtyById.get(l.id) ?? l.quantity)),
      }));
    if (picked.length === 0) {
      setError("Pick at least one line to copy");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/sales-orders/copy-for-service-order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceType,
          sourceId: resolvedSourceId,
          lineItems: picked,
        }),
      });
      const json = (await res.json()) as {
        success?: boolean;
        error?: string;
        data?: CopyDraft;
      };
      if (!res.ok || !json.success || !json.data) {
        setError(humanizeError({ status: res.status, message: json.error }, "Couldn't copy those lines. Please try again."));
        setBusy(false);
        return;
      }
      onCopied(json.data);
    } catch (e) {
      setError(humanizeError(e, "Network problem — please try again."));
    } finally {
      setBusy(false);
    }
  }

  function toggleLine(id: string) {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setAll(checked: boolean) {
    setCheckedIds(checked ? new Set(sourceLines.map((l) => l.id)) : new Set());
  }

  // Per-line qty override. Empty string clears to "0" but is clamped to 1
  // on commit. Anything above sourceQty is clamped down. Backend clamps
  // again to be safe.
  function handleQtyChange(line: SourceLineRow, raw: string) {
    const parsed = Number(raw);
    const safe = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1;
    const clamped = Math.max(1, Math.min(line.quantity, safe));
    setQtyById((prev) => {
      const next = new Map(prev);
      next.set(line.id, clamped);
      return next;
    });
  }

  const allChecked = sourceLines.length > 0 && checkedIds.size === sourceLines.length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="fixed inset-0 bg-black/40" onClick={onClose} />
      <div className={`relative bg-white rounded-lg shadow-xl border border-[#E2DDD8] w-full mx-4 p-5 space-y-4 ${step === 2 ? "max-w-3xl" : "max-w-md"}`}>
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-[#1F1D1B]">
            {step === 1
              ? "Copy from Sales / Consignment Order"
              : `Pick lines to copy from ${sourceType} ${resolvedSourceNo}`}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="text-[#9CA3AF] hover:text-[#374151]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {step === 1 ? (
          <>
            <p className="text-xs text-[#6B7280]">
              For Sales Orders you can enter <span className="font-medium">our SO</span> (e.g.{" "}
              <span className="font-mono">SO-2605-014</span>), the{" "}
              <span className="font-medium">customer&apos;s PO</span> or the{" "}
              <span className="font-medium">customer&apos;s SO</span> number — whichever
              document the customer quoted. Consignment lookups use our CO number
              (e.g. <span className="font-mono">CO-2605-003</span>). The next step lets
              you pick which lines to copy. All prices reset to 0 — edit each
              line&apos;s price before saving.
            </p>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setSourceType("SO");
                  setMatchChoices([]);
                }}
                className={`flex-1 py-1.5 text-sm rounded border ${
                  sourceType === "SO"
                    ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                    : "border-[#E2DDD8] text-[#5A5550] hover:bg-[#F4EFE3]"
                }`}
              >
                Sales Order
              </button>
              <button
                type="button"
                onClick={() => {
                  setSourceType("CO");
                  setMatchChoices([]);
                }}
                className={`flex-1 py-1.5 text-sm rounded border ${
                  sourceType === "CO"
                    ? "bg-[#6B5C32] text-white border-[#6B5C32]"
                    : "border-[#E2DDD8] text-[#5A5550] hover:bg-[#F4EFE3]"
                }`}
              >
                Consignment Order
              </button>
            </div>

            <Input
              autoFocus
              value={sourceLookup}
              onChange={(e) => {
                setSourceLookup(e.target.value);
                setMatchChoices([]);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) handleResolveSource();
              }}
              placeholder={
                sourceType === "SO"
                  ? "SO-YYMM-NNN / customer PO / customer SO / reference"
                  : "CO-YYMM-NNN / reference"
              }
            />

            {matchChoices.length > 0 && (
              <div className="border border-[#E2DDD8] rounded-md overflow-hidden">
                <p className="px-3 py-1.5 text-[11px] text-[#6B7280] bg-[#F9F7F5] border-b border-[#E2DDD8]">
                  {matchChoices.length} of our orders carry that customer
                  document — pick the right one:
                </p>
                <div className="max-h-44 overflow-y-auto">
                  {matchChoices.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      disabled={busy}
                      onClick={() => void loadSourceLines(m.id)}
                      className="w-full flex items-center justify-between px-3 py-2 text-left text-sm border-b border-[#F0ECE9] last:border-b-0 hover:bg-[#F4EFE3]"
                    >
                      <span>
                        <span className="font-medium text-[#1F1D1B]">{m.label}</span>
                        {m.customerName && (
                          <span className="text-[#6B7280]"> · {m.customerName}</span>
                        )}
                      </span>
                      <span className="text-[11px] text-[#9CA3AF]">
                        matched {m.matched}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {error && (
              <p className="text-xs text-[#7A2E24]">{error}</p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={handleResolveSource} disabled={busy}>
                {busy ? "Loading…" : "Next"}
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <p className="text-xs text-[#6B7280]">
                {checkedIds.size} of {sourceLines.length} line(s) selected.
                Uncheck the ones you don&apos;t want; dial down the Copy Qty
                to take only part of a line.
              </p>
              <button
                type="button"
                onClick={() => setAll(!allChecked)}
                className="text-xs text-[#6B5C32] hover:underline"
              >
                {allChecked ? "Uncheck all" : "Check all"}
              </button>
            </div>

            <div className="max-h-72 overflow-y-auto border border-[#E2DDD8] rounded">
              <table className="w-full text-sm">
                <thead className="bg-[#FAF9F7] text-xs text-[#6B7280] border-b border-[#E2DDD8]">
                  <tr>
                    <th className="w-8 px-2 py-1.5"></th>
                    <th className="text-left px-2 py-1.5">Product / Spec</th>
                    <th className="text-left px-2 py-1.5">Size</th>
                    <th className="text-left px-2 py-1.5">Fabric</th>
                    <th className="text-right px-2 py-1.5">Copy Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {sourceLines.map((line) => {
                    const checked = checkedIds.has(line.id);
                    // Pills: Gap / Divan (BEDFRAME only) / Leg / Special.
                    // Mirrors the visual language on the SO detail page so
                    // the operator scans these the same way they scan the
                    // existing line table elsewhere in the app.
                    const isBedframe = line.itemCategory === "BEDFRAME";
                    const hasGap = (line.gapInches ?? 0) > 0;
                    const hasDivan = isBedframe && (line.divanHeightInches ?? 0) > 0;
                    const hasLeg = (line.legHeightInches ?? 0) > 0;
                    const hasSpecial = !!line.specialOrder;
                    const hasCustom = line.customSpecials.length > 0;
                    const hasAnySpec = hasGap || hasDivan || hasLeg || hasSpecial || hasCustom;
                    const qty = qtyById.get(line.id) ?? line.quantity;
                    return (
                      <tr
                        key={line.id}
                        className={`border-b border-[#F0EDE8] last:border-0 ${checked ? "" : "opacity-50"}`}
                      >
                        <td
                          className="px-2 py-2 align-top cursor-pointer"
                          onClick={() => toggleLine(line.id)}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleLine(line.id)}
                            onClick={(e) => e.stopPropagation()}
                            className="h-4 w-4"
                          />
                        </td>
                        <td
                          className="px-2 py-2 text-[#1F1D1B] cursor-pointer"
                          onClick={() => toggleLine(line.id)}
                        >
                          <div className="font-medium">{line.productCode || "(no code)"}</div>
                          {line.productName && (
                            <div className="text-xs text-[#6B7280]">{line.productName}</div>
                          )}
                          {hasAnySpec && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {hasGap && (
                                <span className="text-xs bg-[#E0EDF0] text-[#3E6570] px-1.5 py-0.5 rounded">
                                  Gap {line.gapInches}&quot;
                                </span>
                              )}
                              {hasDivan && (
                                <span className="text-xs bg-[#F1E6F0] text-[#6B4A6D] px-1.5 py-0.5 rounded">
                                  Divan {line.divanHeightInches}&quot;
                                </span>
                              )}
                              {hasLeg && (
                                <span className="text-xs bg-[#FAEFCB] text-[#9C6F1E] px-1.5 py-0.5 rounded">
                                  Leg {line.legHeightInches}&quot;
                                </span>
                              )}
                              {hasSpecial && (
                                <span className="text-xs bg-[#F9E1DA] text-[#9A3A2D] px-1.5 py-0.5 rounded">
                                  {line.specialOrder.replace(/_/g, " ")}
                                </span>
                              )}
                              {line.customSpecials.map((cs, i) => (
                                <span
                                  key={`${line.id}-cs-${i}`}
                                  className="text-xs bg-[#F0E8DC] text-[#6B5C32] px-1.5 py-0.5 rounded"
                                >
                                  {cs.description}
                                </span>
                              ))}
                            </div>
                          )}
                        </td>
                        <td
                          className="px-2 py-2 text-[#5A5550] align-top cursor-pointer"
                          onClick={() => toggleLine(line.id)}
                        >
                          {line.sizeLabel || "-"}
                        </td>
                        <td
                          className="px-2 py-2 text-[#5A5550] font-mono text-xs align-top cursor-pointer"
                          onClick={() => toggleLine(line.id)}
                        >
                          {line.fabricCode || "-"}
                        </td>
                        <td className="px-2 py-2 text-right text-[#1F1D1B] align-top">
                          <div className="inline-flex items-center gap-1 justify-end">
                            <input
                              type="number"
                              min={1}
                              max={line.quantity}
                              step={1}
                              value={qty}
                              disabled={!checked}
                              onChange={(e) => handleQtyChange(line, e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              className="w-14 text-right text-sm border border-[#E2DDD8] rounded px-1.5 py-0.5 disabled:bg-[#F4EFE3] disabled:text-[#9CA3AF]"
                            />
                            <span className="text-xs text-[#9CA3AF]">/ {line.quantity}</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {error && (
              <p className="text-xs text-[#7A2E24]">{error}</p>
            )}

            <div className="flex justify-between gap-2 pt-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setStep(1);
                  setError("");
                }}
                disabled={busy}
              >
                Back
              </Button>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleCopySelected}
                  disabled={busy || checkedIds.size === 0}
                >
                  {busy ? "Copying…" : `Copy Selected (${checkedIds.size})`}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Line Item Card ──────────────────────────────────────────

type LineItemCardProps = {
  item: LineItem;
  idx: number;
  products: Product[];
  fabrics: FabricItem[];
  onSelectProduct: (idx: number, id: string) => void;
  onSelectFabric: (idx: number, id: string) => void;
  onSelectGap: (idx: number, v: string) => void;
  onSelectDivan: (idx: number, v: string) => void;
  onSelectLeg: (idx: number, v: string) => void;
  onSelectSeatHeight: (idx: number, v: string) => void;
  onToggleSpecialOrder: (idx: number, code: string) => void;
  onAddCustomSpecial: (idx: number) => void;
  onUpdateCustomSpecial: (idx: number, csIdx: number, patch: Partial<CustomSpecial>) => void;
  onRemoveCustomSpecial: (idx: number, csIdx: number) => void;
  onAddSofaModules: (idx: number, moduleProductIds: string[]) => void;
  onUpdate: (idx: number, u: Partial<LineItem>) => void;
  onRemove: (idx: number) => void;
  canRemove: boolean;
  getUnitPrice: (item: LineItem) => number;
  getLineTotal: (item: LineItem) => number;
  getTotalHeight: (item: LineItem) => number;
  maintenanceConfig: Record<string, MaintenanceConfigValue[]> | null;
  // 0134 — Service Order mode lets the operator type Base Price directly
  // instead of waiting for the fabric pick to seed the per-tier price.
  // Fabric is still required for production routing; it just doesn't
  // drive the price field in this mode.
  isServiceOrderMode: boolean;
};

function LineItemCard({
  item, idx, products, fabrics,
  onSelectProduct, onSelectFabric,
  onSelectGap, onSelectDivan, onSelectLeg, onSelectSeatHeight,
  onToggleSpecialOrder,
  onAddCustomSpecial, onUpdateCustomSpecial, onRemoveCustomSpecial,
  onAddSofaModules, onUpdate, onRemove, canRemove,
  getUnitPrice, getLineTotal, getTotalHeight, maintenanceConfig,
  isServiceOrderMode,
}: LineItemCardProps) {
  const [showSpecialOrders, setShowSpecialOrders] = useState(false);
  const [showModuleDropdown, setShowModuleDropdown] = useState(false);
  const [checkedModules, setCheckedModules] = useState<string[]>([]);
  // Derive the current divan dropdown value from the inches stored.
  // Same lookup-vs-display issue as gapValue (below): the saved divan
  // height may be a maintenance-config value that isn't in the hardcoded
  // divanHeightOptions fallback. Format the inches directly so any saved
  // value renders correctly in the <select>.
  const divanValue = useMemo(() => {
    if (item.divanHeightInches == null) return "";
    return `${item.divanHeightInches}"`;
  }, [item.divanHeightInches]);

  // Derive leg dropdown value. Null / 0 / undefined all mean the customer
  // declined a leg — show "No Leg" so the field always carries a selection
  // that comes from the variants config (never blank, per user SOP).
  // Same maintenance-config tolerance as divanValue — render any saved
  // inches directly so a user-added leg height (e.g. 7") still displays.
  const legValue = useMemo(() => {
    if (item.legHeightInches == null || item.legHeightInches === 0) return "No Leg";
    return `${item.legHeightInches}"`;
  }, [item.legHeightInches]);

  // Derive gap dropdown value. The saved gap may be a value the user added
  // via Product Maintenance (e.g. 14") that isn't in the hardcoded
  // gapHeightOptions fallback range (4"-10"). Format the inches directly
  // so the <select> shows whatever value was saved, regardless of whether
  // the maintenance config has loaded yet — when it does load, the option
  // with the same string is auto-selected. Without this, gapInches=14
  // produced gapValue="" and the field rendered as "-".
  const gapValue = useMemo(() => {
    if (item.gapInches == null) return "";
    return `${item.gapInches}"`;
  }, [item.gapInches]);

  // Helper: extract string values from a config array that may contain
  // PricedOption objects ({ value, priceSen }) or plain strings
  function extractValues(arr: unknown[]): string[] {
    return arr.map(v => (typeof v === "object" && v && "value" in v) ? (v as {value:string}).value : String(v));
  }

  const isSofa = item.itemCategory === "SOFA";

  // Options derived from the maintenance config (kv_config:variants-config)
  // — treat the config as the source of truth. The hardcoded *Options lists
  // are fallbacks used only when the config hasn't hydrated yet; they must
  // not be used to filter the config's contents, otherwise any value the
  // user adds in Product Maintenance above the hardcoded range (e.g. gap
  // 11"–20", a custom special-order name) silently drops out of the SO
  // dropdowns. Map each config entry into the existing option shape and
  // carry its saved priceSen through as the surcharge so pricing still
  // works for user-added entries.
  function configToHeightOptions(arr: unknown[]): { height: string; surcharge: number }[] {
    return arr.map((v) => ({
      height:
        typeof v === "object" && v && "value" in v
          ? String((v as { value: unknown }).value)
          : String(v),
      surcharge:
        typeof v === "object" && v && "priceSen" in v
          ? Number((v as { priceSen: unknown }).priceSen) || 0
          : 0,
    }));
  }

  const availableDivanHeights = useMemo(() => {
    if (!maintenanceConfig?.divanHeights) return divanHeightOptions;
    return configToHeightOptions(maintenanceConfig.divanHeights);
  }, [maintenanceConfig]);

  const availableLegHeights = useMemo(() => {
    const key = isSofa ? "sofaLegHeights" : "legHeights";
    if (!maintenanceConfig?.[key]) return legHeightOptions;
    return configToHeightOptions(maintenanceConfig[key]);
  }, [maintenanceConfig, isSofa]);

  const availableSofaSizes = useMemo(() => {
    if (!maintenanceConfig?.sofaSizes) return SEAT_HEIGHT_OPTIONS as unknown as string[];
    return extractValues(maintenanceConfig.sofaSizes);
  }, [maintenanceConfig]);

  const availableGapHeights = useMemo(() => {
    if (!maintenanceConfig?.gaps) return gapHeightOptions;
    return extractValues(maintenanceConfig.gaps);
  }, [maintenanceConfig]);

  const availableSpecials = useMemo(() => {
    const key = isSofa ? "sofaSpecials" : "specials";
    if (!maintenanceConfig?.[key]) return specialOrderOptions;
    return maintenanceConfig[key].map((v) => {
      const value =
        typeof v === "object" && v && "value" in v
          ? String((v as { value: unknown }).value)
          : String(v);
      const surcharge =
        typeof v === "object" && v && "priceSen" in v
          ? Number((v as { priceSen: unknown }).priceSen) || 0
          : 0;
      // Fall back to matching an existing hardcoded option's code/notes so
      // any pricing rule tied to the code keeps working; otherwise derive
      // a stable code from the name.
      const matched = specialOrderOptions.find((o) => o.name === value);
      return matched
        ? { ...matched, surcharge }
        : {
            code: value.toUpperCase().replace(/[^A-Z0-9]+/g, "_"),
            name: value,
            surcharge,
            notes: "",
          };
    });
  }, [maintenanceConfig, isSofa]);

  // Helper: get config surcharge for a given option value, or fall back to default.
  // 0134 — Service Order mode: every variant surcharge is RM 0 by default
  // (the operator types Base Price directly). Returning 0 here makes the
  // dropdown labels drop the "(+RM55)" suffix and the special-orders
  // checkboxes show "RM 0", matching the cleared line-total math.
  function getConfigSurcharge(cfgKey: string, value: string, defaultSurcharge: number): number {
    if (isServiceOrderMode) return 0;
    if (!maintenanceConfig?.[cfgKey]) return defaultSurcharge;
    const entry = maintenanceConfig[cfgKey].find((e: {value:string; priceSen:number} | string) =>
      typeof e === "object" && e.value === value
    );
    return (entry && typeof entry === "object") ? entry.priceSen : defaultSurcharge;
  }

  // Fabrics are managed in Inventory → Fabrics; show all in SO dropdown
  const availableFabrics = fabrics;

  const totalHeight = getTotalHeight(item);
  const unitPrice = getUnitPrice(item);
  const lineTotal = getLineTotal(item);

  const selectClass = "w-full rounded border border-[#E2DDD8] px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20";

  return (
    <div
      id={`line-item-card-${idx}`}
      className="rounded-md border border-[#E2DDD8] p-4 space-y-3"
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[#6B5C32]">Line {idx + 1}</span>
          {item.itemCategory && <Badge>{item.itemCategory}</Badge>}
          {isServiceOrderMode && <RepairScopeBadge repairScope={item.repairScope} />}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold amount">{formatCurrency(lineTotal)}</span>
          <Button variant="ghost" size="icon" className="h-7 w-7 text-[#9A3A2D] hover:text-[#7A2E24]" onClick={() => onRemove(idx)} disabled={!canRemove}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Category / Model (sofa) / Product / Fabric row */}
      {(() => {
        const catProducts = products.filter(p => p.category === item.itemCategory);
        const isSofa = item.itemCategory === "SOFA";
        // For sofa: get unique models
        const sofaModels = isSofa ? [...new Set(catProducts.map(p => p.baseModel))].sort() : [];
        // For sofa: filter products by selected model
        const filteredProducts = isSofa && item.baseModel
          ? catProducts.filter(p => p.baseModel === item.baseModel)
          : catProducts;

        // Product-first flow: users pick a product directly (across every
        // category) and itemCategory / baseModel / sizeLabel bind themselves
        // from the product record via selectProduct(). Sofa still has its
        // bulk "Modules" multi-select flow, but it's opt-in — click the
        // Model dropdown below to clear the picked product and re-enter
        // the checkbox picker. No category picker up front.
        return (
          <div className={`grid gap-3 ${isSofa ? "grid-cols-[130px_1fr_140px_1fr] max-sm:grid-cols-1" : "grid-cols-[1fr_140px_1fr] max-sm:grid-cols-1"}`}>
            {/* Sofa: Model selector */}
            {isSofa && (
              <div>
                <label className="block text-xs text-[#9CA3AF] mb-1">Model *</label>
                <SearchableSelect
                  value={item.baseModel}
                  onChange={(val) => {
                    onUpdate(idx, {
                      baseModel: val,
                      productId: "", productCode: "", productName: "",
                      sizeCode: "", sizeLabel: "", basePriceSen: 0, seatHeight: "",
                    });
                  }}
                  options={sofaModels.map(m => ({ value: m, label: m }))}
                  placeholder="Select model..."
                  className={selectClass}
                />
              </div>
            )}

            <div>
              <label className="block text-xs text-[#9CA3AF] mb-1">{isSofa ? "Module(s) *" : "Product *"}</label>
              {isSofa ? (
                item.productId ? (
                  <div className="h-[34px] flex items-center px-2 rounded border border-[#E2DDD8] bg-[#FAF9F7] text-sm">
                    {item.productCode} - {item.productName}
                  </div>
                ) : (
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => { if (!item.baseModel) return; setShowModuleDropdown(!showModuleDropdown); }}
                      disabled={!item.baseModel}
                      className={`${selectClass} h-[34px] text-left flex items-center justify-between`}
                    >
                      <span className={checkedModules.length > 0 ? "text-[#1F1D1B]" : "text-[#9CA3AF]"}>
                        {checkedModules.length > 0
                          ? `${checkedModules.length} module${checkedModules.length > 1 ? "s" : ""} selected`
                          : !item.baseModel ? "Select model first" : "Select modules..."}
                      </span>
                      <ChevronDown className="h-3.5 w-3.5 text-[#9CA3AF]" />
                    </button>
                    {showModuleDropdown && (
                      <div className="absolute z-50 mt-1 w-full max-h-56 overflow-y-auto rounded-md border border-[#E2DDD8] bg-white shadow-lg">
                        {filteredProducts.map(p => {
                          const isChecked = checkedModules.includes(p.id);
                          return (
                            <label key={p.id} className={`flex items-center gap-2 px-3 py-2 text-sm cursor-pointer transition-colors ${isChecked ? "bg-[#6B5C32]/10" : "hover:bg-[#FAF9F7]"}`}>
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => setCheckedModules(prev => prev.includes(p.id) ? prev.filter(id => id !== p.id) : [...prev, p.id])}
                                className="rounded border-[#D1D5DB] text-[#6B5C32] focus:ring-[#6B5C32]/20"
                              />
                              <span className="flex-1">{p.code} - {p.name}</span>
                            </label>
                          );
                        })}
                        {filteredProducts.length > 0 && (
                          <div className="sticky bottom-0 border-t border-[#E2DDD8] bg-white p-2 flex justify-between items-center">
                            <button type="button" onClick={() => setCheckedModules(prev => prev.length === filteredProducts.length ? [] : filteredProducts.map(p => p.id))} className="text-xs text-[#6B5C32] hover:text-[#4A3F22] font-medium">
                              {checkedModules.length === filteredProducts.length ? "Deselect All" : "Select All"}
                            </button>
                            <Button variant="primary" size="sm" disabled={checkedModules.length === 0} onClick={() => { onAddSofaModules(idx, checkedModules); setCheckedModules([]); setShowModuleDropdown(false); }}>
                              <Check className="h-3.5 w-3.5" />
                              Add {checkedModules.length} Item{checkedModules.length !== 1 ? "s" : ""}
                            </Button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              ) : (
                <SearchableSelect
                  value={item.productId}
                  onChange={(val) => {
                    // SOFA lines are built through the multi-module checkbox
                    // picker — a single pick here must NOT lock the line to
                    // one module. Seed itemCategory + baseModel only, drop
                    // the picked module into checkedModules, and flip the
                    // dropdown open so the user can add sibling modules in
                    // the same action before clicking "Add N Items".
                    // BEDFRAME / ACCESSORY stay on the single-select path.
                    const picked = products.find((p) => p.id === val);
                    if (picked?.category === "SOFA") {
                      onUpdate(idx, {
                        itemCategory: "SOFA",
                        baseModel: picked.baseModel,
                        productId: "",
                        productCode: "",
                        productName: "",
                        sizeCode: "",
                        sizeLabel: "",
                        basePriceSen: 0,
                        seatHeight: "",
                      });
                      setCheckedModules([picked.id]);
                      setShowModuleDropdown(true);
                    } else {
                      onSelectProduct(idx, val);
                    }
                  }}
                  // Always show the full catalog across every category so the
                  // user can switch between BEDFRAME / SOFA / ACCESSORY on the
                  // same line without a separate Category dropdown to clear —
                  // selectProduct() rebinds itemCategory from the chosen
                  // product. Category suffix on the label makes the jump
                  // visible in the dropdown.
                  options={products.map(p => ({
                    value: p.id,
                    label: `${p.code} - ${p.name} · ${p.category}`,
                  }))}
                  placeholder="Search any product..."
                  className={selectClass}
                />
              )}
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
                onChange={(val) => onSelectFabric(idx, val)}
                options={availableFabrics.map(f => ({ value: f.code, label: `${f.code} - ${f.name}` }))}
                placeholder="Select fabric..."
                className={selectClass}
              />
            </div>
          </div>
        );
      })()}

      {/* Qty / Configuration (category-dependent) */}
      {item.itemCategory === "ACCESSORY" ? (
        // Accessories (pillows etc.) need nothing beyond SKU + fabric + qty —
        // no seat size, no heights, no special-order modules. Fabric is
        // already picked in the SKU / fabric pair above; this strip just
        // carries the quantity and the derived base price.
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-[#9CA3AF] mb-1">Qty</label>
            <Input type="number" onFocus={(e) => e.currentTarget.select()} min={1} value={item.quantity} onChange={(e) => onUpdate(idx, { quantity: parseInt(e.target.value) || 1 })} className="h-8" />
          </div>
          <div>
            <label className="block text-xs text-[#9CA3AF] mb-1">Base Price (RM)</label>
            <MoneyInput value={item.basePriceSen / 100} onChange={(rm) => onUpdate(idx, { basePriceSen: Math.round((rm ?? 0) * 100) })} className="h-8" />
          </div>
        </div>
      ) : item.itemCategory === "SOFA" ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs text-[#9CA3AF] mb-1">Qty</label>
            <Input type="number" onFocus={(e) => e.currentTarget.select()} min={1} value={item.quantity} onChange={(e) => onUpdate(idx, { quantity: parseInt(e.target.value) || 1 })} className="h-8" />
          </div>
          <div>
            <label className="block text-xs text-[#9CA3AF] mb-1">Seat Size *</label>
            <SearchableSelect
              value={item.seatHeight}
              onChange={(val) => onSelectSeatHeight(idx, val)}
              options={availableSofaSizes.map(h => ({ value: h, label: h }))}
              placeholder="Select size..."
              className={`${selectClass} h-8`}
            />
          </div>
          <div>
            <label className="block text-xs text-[#9CA3AF] mb-1">Leg</label>
            <SearchableSelect
              value={legValue}
              onChange={(val) => onSelectLeg(idx, val)}
              options={availableLegHeights.map(o => {
                const sc = getConfigSurcharge(isSofa ? "sofaLegHeights" : "legHeights", o.height, o.surcharge);
                return { value: o.height, label: `${o.height}${sc > 0 ? ` (+RM${(sc / 100).toFixed(0)})` : ""}` };
              })}
              placeholder="Select leg..."
              className={`${selectClass} h-8`}
            />
          </div>
          <div>
            <label className="block text-xs text-[#9CA3AF] mb-1">Base Price (RM)</label>
            <MoneyInput value={item.basePriceSen / 100} onChange={(rm) => onUpdate(idx, { basePriceSen: Math.round((rm ?? 0) * 100) })} className="h-8" />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
          <div>
            <label className="block text-xs text-[#9CA3AF] mb-1">Qty</label>
            <Input type="number" onFocus={(e) => e.currentTarget.select()} min={1} value={item.quantity} onChange={(e) => onUpdate(idx, { quantity: parseInt(e.target.value) || 1 })} className="h-8" />
          </div>
          <div>
            <label className="block text-xs text-[#9CA3AF] mb-1">Base Price (RM)</label>
            {/* 2026-05-24 — Bedframe Base Price is always editable on every SO
                type. Previously read-only on regular SO (catalog-driven); Wei
                Siang feedback: catalog can be wrong, operator needs a one-off
                override. Default value still seeds from fabric-tier/cp catalog
                (in regular mode) or 0 (in Service Order mode) — operator types
                over it when needed. Matches the always-editable SOFA + ACCESSORY
                Base Price input above. */}
            <MoneyInput
              value={item.basePriceSen / 100}
              onChange={(rm) => onUpdate(idx, { basePriceSen: Math.round((rm ?? 0) * 100) })}
              placeholder={item.basePriceSen === 0 && !isServiceOrderMode ? "Pick fabric to auto-fill, or type" : ""}
              className={`h-8 ${item.basePriceSen === 0 && !isServiceOrderMode ? "bg-[#FAEFCB]/30 border-[#E8D597]" : ""}`}
            />
          </div>
          <div>
            <label className="block text-xs text-[#9CA3AF] mb-1">Gap</label>
            <SearchableSelect
              value={gapValue}
              onChange={(val) => onSelectGap(idx, val)}
              options={availableGapHeights.map(g => ({ value: g, label: g }))}
              placeholder="-"
              allowClear
              className={`${selectClass} h-8`}
            />
          </div>
          <div>
            <label className="block text-xs text-[#9CA3AF] mb-1">Divan Height</label>
            <SearchableSelect
              value={divanValue}
              onChange={(val) => onSelectDivan(idx, val)}
              options={availableDivanHeights.map(o => {
                const sc = getConfigSurcharge("divanHeights", o.height, o.surcharge);
                return { value: o.height, label: `${o.height}${sc > 0 ? ` (+RM${(sc / 100).toFixed(0)})` : ""}` };
              })}
              placeholder="-"
              allowClear
              className={`${selectClass} h-8`}
            />
          </div>
          <div>
            <label className="block text-xs text-[#9CA3AF] mb-1">Leg Height</label>
            <SearchableSelect
              value={legValue}
              onChange={(val) => onSelectLeg(idx, val)}
              options={availableLegHeights.map(o => {
                const sc = getConfigSurcharge(isSofa ? "sofaLegHeights" : "legHeights", o.height, o.surcharge);
                return { value: o.height, label: `${o.height}${sc > 0 ? ` (+RM${(sc / 100).toFixed(0)})` : ""}` };
              })}
              placeholder="-"
              allowClear
              className={`${selectClass} h-8`}
            />
          </div>
          <div>
            <label className="block text-xs text-[#9CA3AF] mb-1">Total Height</label>
            <div className="h-8 flex items-center px-2 rounded border border-[#E2DDD8] bg-[#FAF9F7] text-sm font-medium">
              {totalHeight > 0 ? `${totalHeight}"` : "-"}
            </div>
          </div>
        </div>
      )}

      {/* Special Orders multi-select — pillows have no surcharge modules */}
      {item.itemCategory !== "ACCESSORY" && (
      <div>
        <button
          type="button"
          onClick={() => setShowSpecialOrders(!showSpecialOrders)}
          className="flex items-center gap-1.5 text-xs font-medium text-[#6B5C32] hover:text-[#4A3F22] transition-colors"
        >
          {showSpecialOrders ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          Special Orders ({item.specialOrders.length} selected)
        </button>

        {item.specialOrders.length > 0 && !showSpecialOrders && (
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

        {showSpecialOrders && (
          <div className="mt-2 rounded-md border border-[#E2DDD8] bg-[#FAF9F7] p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {availableSpecials.map(opt => {
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
                    onChange={() => onToggleSpecialOrder(idx, opt.code)}
                    className="mt-0.5 rounded border-[#D1D5DB] text-[#6B5C32] focus:ring-[#6B5C32]/20"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-[#374151]">{opt.name}</div>
                    <div className="text-xs text-[#9CA3AF]">
                      {sc > 0 && <span className="text-[#9C6F1E]">+{formatCurrency(sc)}</span>}
                      {sc < 0 && <span className="text-[#4F7C3A]">{formatCurrency(sc)}</span>}
                      {sc === 0 && <span>RM 0</span>}
                      {opt.notes && <span className="ml-1">({opt.notes})</span>}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        )}

        {/* Custom (free-text) specials — for edge cases not in the master
            Specials maintenance config. Each entry has its own description
            + surcharge; the values are appended to the line's specialOrder
            text as "OTHER: <desc>" so legacy display paths render them
            without changes. Migration 0074. */}
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
              onClick={() => onAddCustomSpecial(idx)}
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
                      onUpdateCustomSpecial(idx, csIdx, {
                        description: e.target.value,
                      })
                    }
                    placeholder="e.g. Custom Foam Density 35D"
                    className="h-8 flex-1 text-sm"
                  />
                  {/* 0134 — Service Order mode: per-special-item surcharge
                      input is hidden. Whatever the operator types here
                      would be zeroed by applyCustomSpecials anyway (SO mode
                      keeps all variant prices at 0); price lives in the
                      single editable Base Price field. */}
                  {!isServiceOrderMode && (
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-[#9CA3AF]">RM</span>
                      <MoneyInput
                        value={cs.surchargeSen / 100}
                        onChange={(rm) =>
                          onUpdateCustomSpecial(idx, csIdx, {
                            surchargeSen: Math.round((rm ?? 0) * 100),
                          })
                        }
                        className="h-8 w-24 text-sm"
                      />
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={() => onRemoveCustomSpecial(idx, csIdx)}
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
      )}

      {/* Per-line Discount (migration 0179) */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-[#9CA3AF] mb-1">Discount (RM or %)</label>
          <DiscountInput
            baseAmountSen={getUnitPrice(item) * item.quantity}
            valueSen={item.discountSen || null}
            onChange={(sen) => onUpdate(idx, { discountSen: sen ?? 0 })}
            className="h-8"
          />
        </div>
        <div className="flex flex-col justify-end">
          <span className="text-xs text-[#9CA3AF] mb-1">Line Total</span>
          <span className="text-sm font-semibold text-[#1F1D1B] amount">{formatCurrency(lineTotal)}</span>
        </div>
      </div>

      {/* Line Notes */}
      <div>
        <label className="block text-xs text-[#9CA3AF] mb-1">Line Notes</label>
        <Input value={item.notes} onChange={(e) => onUpdate(idx, { notes: e.target.value })} placeholder="Optional notes for this line..." className="h-8" />
      </div>

      {/* Repair Scope (0160) — service-order mode only. Shared picker (also
          used by the edit page) so the create/edit UIs can't drift. */}
      {isServiceOrderMode && (
        <RepairScopePicker item={item} idx={idx} onUpdate={onUpdate} />
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
                  <span className="text-[#9CA3AF]">× {wip.qty}</span>
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

      {/* Price Breakdown */}
      <div className="border-t border-[#E2DDD8] pt-2">
        <div className="text-xs text-[#6B7280] space-y-0.5 font-mono">
          <div className="flex justify-between">
            <span>Base Price{item.itemCategory === "SOFA" && item.seatHeight ? ` (${item.seatHeight})` : ""}:</span>
            <span>{formatCurrency(item.basePriceSen)}</span>
          </div>
          {item.itemCategory !== "SOFA" && item.divanPriceSen !== 0 && (
            <div className="flex justify-between">
              <span>Divan ({divanValue}):</span>
              <span className="text-[#9C6F1E]">+{formatCurrency(item.divanPriceSen)}</span>
            </div>
          )}
          {item.itemCategory !== "SOFA" && item.legPriceSen !== 0 && (
            <div className="flex justify-between">
              <span>Leg ({legValue}):</span>
              <span className="text-[#9C6F1E]">+{formatCurrency(item.legPriceSen)}</span>
            </div>
          )}
          {item.itemCategory !== "SOFA" && item.totalHeightPriceSen !== 0 && (
            <div className="flex justify-between">
              <span>Total Height ({totalHeight}&quot;):</span>
              <span className="text-[#9C6F1E]">+{formatCurrency(item.totalHeightPriceSen)}</span>
            </div>
          )}
          {item.specialOrders.length > 0 && item.specialOrders.map(code => {
            const opt = specialOrderOptions.find(o => o.code === code);
            if (!opt) return null;
            const sc = getConfigSurcharge(isSofa ? "sofaSpecials" : "specials", opt.name, opt.surcharge);
            if (sc === 0) return null;
            return (
              <div key={code} className="flex justify-between">
                <span>{opt.name}:</span>
                <span className={sc > 0 ? "text-[#9C6F1E]" : "text-[#4F7C3A]"}>
                  {sc > 0 ? "+" : ""}{formatCurrency(sc)}
                </span>
              </div>
            );
          })}
          {/* Show combined discount note if applicable */}
          {item.specialOrders.includes("HB_FULL_COVER") && item.specialOrders.includes("DIVAN_BTM_COVER") && (
            <div className="flex justify-between text-[#3E6570]">
              <span>HB + Divan Cover (combined):</span>
              <span>RM 100.00</span>
            </div>
          )}
          {/* Custom specials breakdown — descriptions are operator-typed
              so we show them as "Other: <desc>" lines mirroring how they
              appear in the saved specialOrder text. Zero-surcharge entries
              still render so the operator can see what they typed. */}
          {item.customSpecials.map((cs, csIdx) => {
            const desc = cs.description.trim();
            if (!desc) return null;
            const sc = Number.isFinite(cs.surchargeSen) && cs.surchargeSen > 0
              ? Math.round(cs.surchargeSen)
              : 0;
            return (
              <div key={`cs-${csIdx}`} className="flex justify-between">
                <span>Other: {desc}:</span>
                <span className={sc > 0 ? "text-[#9C6F1E]" : ""}>
                  {sc > 0 ? `+${formatCurrency(sc)}` : "RM 0"}
                </span>
              </div>
            );
          })}
          <div className="flex justify-between border-t border-dashed border-[#D1D5DB] pt-1 mt-1 text-sm font-semibold text-[#1F1D1B]">
            <span>Unit Price:</span>
            <span>{formatCurrency(unitPrice)}</span>
          </div>
          {item.quantity > 1 && (
            <div className="flex justify-between text-sm font-bold text-[#6B5C32]">
              <span>Line Total ({item.quantity} pcs):</span>
              <span>{formatCurrency(lineTotal)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
