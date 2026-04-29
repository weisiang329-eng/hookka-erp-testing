import { useState, useEffect, Suspense, useMemo } from "react";
import { useToast } from "@/components/ui/toast";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { calculateUnitPrice, calculateLineTotal } from "@/lib/pricing";
import { hasMixedSofaBedframe, SO_MIXED_CATEGORY_ERROR } from "@/lib/so-category";
import { ArrowLeft, Plus, Trash2, Save, ChevronDown, ChevronUp, Check, AlertTriangle, X } from "lucide-react";
import type { Customer, Product, FabricItem } from "@/lib/mock-data";
import {
  divanHeightOptions,
  legHeightOptions,
  specialOrderOptions,
  gapHeightOptions,
  SEAT_HEIGHT_OPTIONS,
} from "@/lib/mock-data";
import { fetchVariantsConfig, getVariantsConfigSync } from "@/lib/kv-config";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { useActiveTabDirty } from "@/contexts/tabs-context";
import { useFormDraft, clearFormDraft } from "@/lib/use-form-draft";

type SeatHeightTier = { height: string; priceSen: number };

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
  fabricId: string;
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
  specialOrder: string; // comma-joined text for submission
  notes: string;
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
  sizeCode: "", sizeLabel: "", fabricId: "", fabricCode: "",
  quantity: 1, basePriceSen: 0, seatHeight: "", selectedModules: [],
  gapInches: null, divanHeightInches: null, divanPriceSen: 0,
  legHeightInches: null, legPriceSen: 0, totalHeightPriceSen: 0,
  specialOrders: [], specialOrderPriceSen: 0, specialOrder: "", notes: "",
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
  const { data: customersResp } = useCachedJson<{ data?: Customer[] }>("/api/customers");
  const { data: productsResp } = useCachedJson<{ data?: Product[] }>("/api/products");
  const { data: fabricsResp } = useCachedJson<{ data?: FabricItem[] }>("/api/fabrics");
  const { data: fabricTrackingsResp } = useCachedJson<{ data?: {id: string; fabricCode: string; priceTier: "PRICE_1" | "PRICE_2"}[] }>("/api/fabric-tracking");
  const customers: Customer[] = useMemo(() => customersResp?.data || [], [customersResp]);
  const products: Product[] = useMemo(() => productsResp?.data || [], [productsResp]);
  const fabrics: FabricItem[] = useMemo(() => fabricsResp?.data || [], [fabricsResp]);
  const fabricTrackings: {id: string; fabricCode: string; priceTier: "PRICE_1" | "PRICE_2"}[] = useMemo(() => fabricTrackingsResp?.data || [], [fabricTrackingsResp]);
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

  const [customerId, setCustomerId] = useState("");
  const [deliveryHubId, setDeliveryHubId] = useState("");
  const [customerPOId, setCustomerPOId] = useState("");
  const [customerSOId, setCustomerSOId] = useState("");
  const [reference, setReference] = useState("");
  const [companySODate, setCompanySODate] = useState(new Date().toISOString().split("T")[0]);
  const [customerDeliveryDate, setCustomerDeliveryDate] = useState("");
  const [hookkaExpectedDD, setHookkaExpectedDD] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<LineItem[]>([makeEmptyLine()]);

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
  useActiveTabDirty(isDirty);

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
    companySODate,
    customerDeliveryDate,
    hookkaExpectedDD,
    notes,
    items,
  }), [
    customerId, deliveryHubId, customerPOId, customerSOId, reference,
    companySODate, customerDeliveryDate, hookkaExpectedDD, notes, items,
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

    applyCfg(getVariantsConfigSync() as Record<string, unknown> | null);
    void fetchVariantsConfig().then((cfg) =>
      applyCfg(cfg as Record<string, unknown> | null),
    );
  }, []);

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

  const addItem = () => setItems([...items, makeEmptyLine()]);

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
        basePriceSen: priceSen,
        seatHeight: template.seatHeight,
        fabricId: template.fabricId,
        fabricCode: template.fabricCode,
        quantity: 1,
        legHeightInches: isSofa ? template.legHeightInches : null,
        legPriceSen: isSofa ? template.legPriceSen : 0,
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
      // Recalculate total height surcharge whenever gap/divan/leg changes
      if ("gapInches" in updates || "divanHeightInches" in updates || "legHeightInches" in updates) {
        const th = (merged.gapInches || 0) + (merged.divanHeightInches || 0) + (merged.legHeightInches || 0);
        merged.totalHeightPriceSen = calcTotalHeightSurcharge(th);
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
        if (i === idx) return { ...item, ...updates };
        if (item.itemCategory !== "SOFA" || item.baseModel !== source.baseModel) return item;
        // For seat height: re-resolve the other line's basePrice from its
        // own cached seatHeightPrices (customer-specific when available,
        // global product otherwise). Prices can differ by module.
        if ("seatHeight" in updates) {
          const prod = products.find(p => p.id === item.productId);
          const tiers = (item.seatHeightPrices && item.seatHeightPrices.length > 0)
            ? item.seatHeightPrices
            : prod?.seatHeightPrices;
          const tier = tiers?.find(t => t.height === updates.seatHeight);
          return { ...item, ...updates, basePriceSen: tier?.priceSen ?? item.basePriceSen };
        }
        return { ...item, ...updates };
      });
    });
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
      basePriceSen: 0, // Don't set base price yet — fabric determines Price 1 vs Price 2
      // Seed price hints from the global product record. Customer-specific
      // pricing is resolved server-side on SO create.
      price1Sen: prod.price1Sen ?? null,
      seatHeightPrices: prod.seatHeightPrices ?? [],
      // Reset category-specific fields
      seatHeight: "",
      gapInches: isSofa ? null : items[idx].gapInches,
      divanHeightInches: isSofa ? null : items[idx].divanHeightInches,
      divanPriceSen: isSofa ? 0 : items[idx].divanPriceSen,
      legHeightInches: isSofa ? null : items[idx].legHeightInches,
      legPriceSen: isSofa ? 0 : items[idx].legPriceSen,
    });
  };

  const selectFabric = (idx: number, fabricId: string) => {
    const fab = fabrics.find(f => f.id === fabricId);
    if (!fab) return;
    const item = items[idx];

    if (item?.itemCategory === "SOFA") {
      propagateSofaVariant(idx, { fabricId: fab.id, fabricCode: fab.code });
    } else if (item?.itemCategory === "BEDFRAME" && item.productId) {
      // Look up fabric priceTier from tracking data
      const tracking = fabricTrackings.find(ft => ft.fabricCode === fab.code);
      const priceTier = tracking?.priceTier || "PRICE_2";
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
      updateItem(idx, { fabricId: fab.id, fabricCode: fab.code, basePriceSen: newPrice });
    } else {
      updateItem(idx, { fabricId: fab.id, fabricCode: fab.code });
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
        divanPriceSen: surcharge,
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
        legPriceSen: surcharge,
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
      basePriceSen: tier?.priceSen || 0,
    });
  };

  const toggleSpecialOrder = (idx: number, code: string) => {
    const item = items[idx];
    const isSofa = item?.itemCategory === "SOFA";
    const current = item.specialOrders;
    const next = current.includes(code)
      ? current.filter(c => c !== code)
      : [...current, code];

    // Try to use maintenance config surcharges first
    const cfgKey = isSofa ? "sofaSpecials" : "specials";
    const cfgSpecials = maintenanceConfig?.[cfgKey];
    let surcharge: number;

    if (cfgSpecials && Array.isArray(cfgSpecials)) {
      // Calculate from config
      surcharge = 0;
      const hasHBCover = next.includes("HB_FULL_COVER");
      const hasDivanBtmCover = next.includes("DIVAN_BTM_COVER");
      for (const c of next) {
        const opt = specialOrderOptions.find(o => o.code === c);
        if (!opt) continue;
        if (hasHBCover && hasDivanBtmCover && (c === "HB_FULL_COVER" || c === "DIVAN_BTM_COVER")) continue;
        // Look up surcharge from config by name
        const cfgEntry = cfgSpecials.find((e: {value:string; priceSen:number} | string) =>
          typeof e === "object" && e.value === opt.name
        );
        surcharge += (cfgEntry && typeof cfgEntry === "object") ? cfgEntry.priceSen : opt.surcharge;
      }
      if (hasHBCover && hasDivanBtmCover) surcharge += 10000;
    } else {
      surcharge = calcSpecialOrderSurcharge(next);
    }

    // Persist as semicolon-separated canonical names; each token is guaranteed
    // to come from the config dropdown, so no free text leaks into specialOrder.
    const label = next.map(c => specialOrderOptions.find(o => o.code === c)?.name || c).join("; ");
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

  const getUnitPrice = (item: LineItem) =>
    calculateUnitPrice({
      basePriceSen: item.basePriceSen,
      divanPriceSen: item.divanPriceSen,
      legPriceSen: item.legPriceSen,
      totalHeightPriceSen: item.totalHeightPriceSen,
      specialOrderPriceSen: item.specialOrderPriceSen,
    });

  const getLineTotal = (item: LineItem) => calculateLineTotal(getUnitPrice(item), item.quantity);

  const getTotalHeight = (item: LineItem) => {
    const gap = item.gapInches || 0;
    const divan = item.divanHeightInches || 0;
    const leg = item.legHeightInches || 0;
    return gap + divan + leg;
  };

  const subtotal = items.reduce((sum, item) => sum + getLineTotal(item), 0);
  const totalQty = items.reduce((sum, item) => sum + item.quantity, 0);

  const handleSubmit = async (status: "DRAFT" | "CONFIRMED" = "DRAFT") => {
    if (!customerId) { toast.warning("Please select a customer"); return; }
    if (items.some(l => !l.productId)) { toast.warning("Please select a product for all line items"); return; }
    if (items.some(l => !l.fabricId)) { toast.warning("Please select a fabric for all line items"); return; }
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
    try {
      // Strip the client-only `_uid` so the server contract is unchanged.
      const itemsForServer = items.map((it) => {
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
          items: itemsForServer,
          status,
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
          navigate(`/sales/${newId}`);
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
        navigate(`/sales/${newId}`);
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
        navigate(`/sales/${newId}`);
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
                  if (soId) navigate(`/sales/${soId}`);
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

      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate("/sales")}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-[#1F1D1B]">{isClone ? "Clone Sales Order" : "New Sales Order"}</h1>
          <p className="text-xs text-[#6B7280]">{isClone ? "Create a new order based on an existing one" : "Create a new sales order for a customer"}</p>
        </div>
        <Button variant="outline" onClick={() => navigate("/sales")}>Cancel</Button>
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
            <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Total Qty</span><span className="font-medium">{totalQty}</span></div>
            <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Line Items</span><span className="font-medium">{items.filter(l => l.productId).length}</span></div>
            <hr className="border-[#E2DDD8]" />
            <div className="flex justify-between text-sm"><span className="text-[#6B7280]">Subtotal</span><span className="font-medium amount">{formatCurrency(subtotal)}</span></div>
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
              products={products}
              fabrics={fabrics}
              onSelectProduct={selectProduct}
              onSelectFabric={selectFabric}
              onSelectGap={selectGap}
              onSelectDivan={selectDivan}
              onSelectLeg={selectLeg}
              onSelectSeatHeight={selectSeatHeight}
              onToggleSpecialOrder={toggleSpecialOrder}
              onAddSofaModules={addSofaModules}
              onUpdate={updateItem}
              onRemove={removeItem}
              canRemove={items.length > 1}
              getUnitPrice={getUnitPrice}
              getLineTotal={getLineTotal}
              getTotalHeight={getTotalHeight}
              maintenanceConfig={maintenanceConfig}
            />
          ))}
        </CardContent>
      </Card>
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
  onAddSofaModules: (idx: number, moduleProductIds: string[]) => void;
  onUpdate: (idx: number, u: Partial<LineItem>) => void;
  onRemove: (idx: number) => void;
  canRemove: boolean;
  getUnitPrice: (item: LineItem) => number;
  getLineTotal: (item: LineItem) => number;
  getTotalHeight: (item: LineItem) => number;
  maintenanceConfig: Record<string, MaintenanceConfigValue[]> | null;
};

function LineItemCard({
  item, idx, products, fabrics,
  onSelectProduct, onSelectFabric,
  onSelectGap, onSelectDivan, onSelectLeg, onSelectSeatHeight,
  onToggleSpecialOrder, onAddSofaModules, onUpdate, onRemove, canRemove,
  getUnitPrice, getLineTotal, getTotalHeight, maintenanceConfig,
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

  // Helper: get config surcharge for a given option value, or fall back to default
  function getConfigSurcharge(cfgKey: string, value: string, defaultSurcharge: number): number {
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
    <div className="rounded-md border border-[#E2DDD8] p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[#6B5C32]">Line {idx + 1}</span>
          {item.itemCategory && <Badge>{item.itemCategory}</Badge>}
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
          <div className={`grid gap-3 ${isSofa ? "grid-cols-[130px_1fr_140px_1fr]" : "grid-cols-[1fr_140px_1fr]"}`}>
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
                value={item.fabricId}
                onChange={(val) => onSelectFabric(idx, val)}
                options={availableFabrics.map(f => ({ value: f.id, label: `${f.code} - ${f.name}` }))}
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
            <Input type="number" min={1} value={item.quantity} onChange={(e) => onUpdate(idx, { quantity: parseInt(e.target.value) || 1 })} className="h-8" />
          </div>
          <div>
            <label className="block text-xs text-[#9CA3AF] mb-1">Base Price (RM)</label>
            <Input type="number" min={0} value={item.basePriceSen / 100} onChange={(e) => onUpdate(idx, { basePriceSen: Math.round(parseFloat(e.target.value || "0") * 100) })} className="h-8 text-right" />
          </div>
        </div>
      ) : item.itemCategory === "SOFA" ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs text-[#9CA3AF] mb-1">Qty</label>
            <Input type="number" min={1} value={item.quantity} onChange={(e) => onUpdate(idx, { quantity: parseInt(e.target.value) || 1 })} className="h-8" />
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
            <Input type="number" min={0} value={item.basePriceSen / 100} onChange={(e) => onUpdate(idx, { basePriceSen: Math.round(parseFloat(e.target.value || "0") * 100) })} className="h-8 text-right" />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-6 gap-3">
          <div>
            <label className="block text-xs text-[#9CA3AF] mb-1">Qty</label>
            <Input type="number" min={1} value={item.quantity} onChange={(e) => onUpdate(idx, { quantity: parseInt(e.target.value) || 1 })} className="h-8" />
          </div>
          <div>
            <label className="block text-xs text-[#9CA3AF] mb-1">Base Price (RM)</label>
            <div className={`h-8 flex items-center justify-end px-2 rounded border text-sm ${
              item.basePriceSen > 0
                ? "border-[#E2DDD8] bg-[#FAF9F7] text-[#111827] font-medium"
                : "border-dashed border-[#E8D597] bg-[#FAEFCB] text-[#9C6F1E] text-xs"
            }`}>
              {item.basePriceSen > 0 ? (item.basePriceSen / 100).toFixed(0) : "Select fabric"}
            </div>
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
      </div>
      )}

      {/* Line Notes */}
      <div>
        <label className="block text-xs text-[#9CA3AF] mb-1">Line Notes</label>
        <Input value={item.notes} onChange={(e) => onUpdate(idx, { notes: e.target.value })} placeholder="Optional notes for this line..." className="h-8" />
      </div>

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
