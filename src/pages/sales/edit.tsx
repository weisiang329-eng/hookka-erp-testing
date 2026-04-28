import { useState, useEffect, useMemo } from "react";
import { useToast } from "@/components/ui/toast";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/utils";
import { hasMixedSofaBedframe, SO_MIXED_CATEGORY_ERROR } from "@/lib/so-category";
import { ArrowLeft, Plus, Trash2, Save, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import type { Customer, Product, FabricItem, SalesOrder } from "@/lib/mock-data";
import {
  SEAT_HEIGHT_OPTIONS,
  legHeightOptions,
  specialOrderOptions,
} from "@/lib/mock-data";
import { fetchVariantsConfig, getVariantsConfigSync } from "@/lib/kv-config";
import { useCachedJson, invalidateCache, invalidateCachePrefix } from "@/lib/cached-fetch";
import { LockBanner } from "@/components/ui/lock-banner";
import { usePresence } from "@/lib/use-presence";
import { PresenceBanner } from "@/components/presence-banner";
import { useActiveTabDirty } from "@/contexts/tabs-context";

type LineItem = {
  id?: string;
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
  seatHeight: string;
  gapInches: number | null;
  divanHeightInches: number | null;
  divanPriceSen: number;
  legHeightInches: number | null;
  legPriceSen: number;
  specialOrders: string[];
  specialOrder: string;
  specialOrderPriceSen: number;
  notes: string;
};

const EMPTY_LINE: LineItem = {
  productId: "", productCode: "", productName: "", itemCategory: "", baseModel: "",
  sizeCode: "", sizeLabel: "", fabricId: "", fabricCode: "",
  quantity: 1, basePriceSen: 0, seatHeight: "",
  gapInches: null, divanHeightInches: null, divanPriceSen: 0,
  legHeightInches: null, legPriceSen: 0,
  specialOrders: [], specialOrder: "", specialOrderPriceSen: 0, notes: "",
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
  const { data: customersResp } = useCachedJson<{ data?: Customer[] }>("/api/customers");
  const { data: productsResp } = useCachedJson<{ data?: Product[] }>("/api/products");
  const { data: fabricsResp } = useCachedJson<{ data?: FabricItem[] }>("/api/fabrics");
  const customers: Customer[] = useMemo(() => customersResp?.data || [], [customersResp]);
  const products: Product[] = useMemo(() => productsResp?.data || [], [productsResp]);
  const fabrics: FabricItem[] = useMemo(() => fabricsResp?.data || [], [fabricsResp]);
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
  const [items, setItems] = useState<LineItem[]>([{ ...EMPTY_LINE }]);
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
        productId: it.productId, fabricId: it.fabricId, quantity: it.quantity,
        seatHeight: it.seatHeight, gapInches: it.gapInches,
        divanHeightInches: it.divanHeightInches,
        legHeightInches: it.legHeightInches,
        specialOrders: it.specialOrders, notes: it.notes,
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
  useActiveTabDirty(isDirty);

  useEffect(() => {
    fetchVariantsConfig().then(setMaintenanceConfig).catch(() => { /* ignore */ });
  }, []);

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

  const toggleSpecialOrder = (idx: number, code: string) => {
    const item = items[idx];
    const isSofa = item.itemCategory === "SOFA";
    const next = item.specialOrders.includes(code)
      ? item.specialOrders.filter((c) => c !== code)
      : [...item.specialOrders, code];
    const available = getAvailableSpecials(isSofa);
    const sumSurcharge = next.reduce((s, c) => {
      const opt = available.find((o) => o.code === c);
      if (!opt) return s;
      return s + getConfigSurcharge(isSofa ? "sofaSpecials" : "specials", opt.name, opt.surcharge);
    }, 0);
    const combinedSurcharge = calcSpecialOrderSurcharge(next);
    const surcharge = isSofa ? sumSurcharge : combinedSurcharge;
    const label = next
      .map((c) => specialOrderOptions.find((o) => o.code === c)?.name || c)
      .join("; ");
    updateItem(idx, {
      specialOrders: next,
      specialOrder: label,
      specialOrderPriceSen: surcharge,
    });
  };

  // Load existing order + edit-eligibility verdict in parallel. The
  // eligibility check is a thin SQL-only endpoint that aggregates earliest
  // PO start + any-completed-JC across the SO's POs so the page doesn't
  // need to refetch the (much heavier) production-orders payload.
  // lockReason comes back on /:id and surfaces the cascade-lock reason
  // (e.g. "PO X is COMPLETED") so the page can disable Save + show banner.
  const { data: orderResp } = useCachedJson<{ success?: boolean; data?: SalesOrder; lockReason?: string | null }>(id ? `/api/sales-orders/${id}` : null);
  const { data: eligibilityResp } = useCachedJson<EditEligibility>(id ? `/api/sales-orders/${id}/edit-eligibility` : null);
  useEffect(() => {
    const d = orderResp;
    if (!d) {
      // no cached data yet — wait for the hook to fetch
      return;
    }
    (() => {
        if (d.success) {
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
            //   - seatHeight comes from sizeLabel e.g. '28"' (sizeCode is
            //     just the numeric portion like "28").
            const parsed = isSofa ? parseSofaCode(productCode) : { baseModel: "", module: "" };
            const rawSizeLabel = (item.sizeLabel as string) || "";
            const rawSizeCode = (item.sizeCode as string) || "";
            const seatHeight = isSofa
              ? ((item.seatHeight as string) ||
                 (rawSizeLabel.includes('"') ? rawSizeLabel : (rawSizeCode ? `${rawSizeCode}"` : "")))
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
              sizeLabel: rawSizeLabel,
              fabricId: item.fabricId as string,
              fabricCode: item.fabricCode as string,
              quantity: item.quantity as number,
              basePriceSen: item.basePriceSen as number,
              seatHeight,
              gapInches: item.gapInches as number | null,
              divanHeightInches: item.divanHeightInches as number | null,
              divanPriceSen: (item.divanPriceSen as number) || 0,
              legHeightInches: item.legHeightInches as number | null,
              legPriceSen: (item.legPriceSen as number) || 0,
              specialOrders: (() => {
                const raw = (item.specialOrder as string) || "";
                const tokens = raw.split(/[;,]+/).map((s) => s.trim()).filter(Boolean);
                return tokens
                  .map((tok) => specialOrderOptions.find((o) => o.name === tok)?.code)
                  .filter((c): c is string => Boolean(c));
              })(),
              specialOrder: (item.specialOrder as string) || "",
              specialOrderPriceSen: (item.specialOrderPriceSen as number) || 0,
              notes: (item.notes as string) || "",
            };
          }));
        }
        setLoading(false);
      })();
  }, [orderResp, id]);

  const addItem = () => setItems([...items, { ...EMPTY_LINE }]);

  const removeItem = (idx: number) => {
    if (items.length <= 1) return;
    setItems(items.filter((_, i) => i !== idx));
  };

  const updateItem = (idx: number, updates: Partial<LineItem>) => {
    setItems(prev => prev.map((item, i) => i === idx ? { ...item, ...updates } : item));
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
      basePriceSen: prod.costPriceSen || 0,
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
    if (fab) {
      updateItem(idx, { fabricId: fab.id, fabricCode: fab.code });
    }
  };

  // For sofa, propagate seat-height into sizeLabel + sizeCode so the "Size"
  // column downstream (detail page, production sheet) carries the seat
  // height — the variable variant — instead of the module code, which
  // already lives in productCode. Mirrors the same fix in create.tsx.
  const selectSeatHeight = (idx: number, value: string) => {
    const item = items[idx];
    const prod = products.find(p => p.id === item.productId);
    if (!value || !prod?.seatHeightPrices) {
      updateItem(idx, { seatHeight: "", basePriceSen: 0 });
      return;
    }
    const tier = prod.seatHeightPrices.find(t => t.height === value);
    const sizeCode = value.replace(/"/g, "").trim();
    updateItem(idx, {
      seatHeight: value,
      sizeLabel: value,
      sizeCode,
      basePriceSen: tier?.priceSen || 0,
    });
  };

  const getUnitPrice = (item: LineItem) =>
    item.basePriceSen + item.divanPriceSen + item.legPriceSen + item.specialOrderPriceSen;

  const getLineTotal = (item: LineItem) => getUnitPrice(item) * item.quantity;

  const subtotal = items.reduce((sum, item) => sum + getLineTotal(item), 0);
  const totalQty = items.reduce((sum, item) => sum + item.quantity, 0);

  const handleSubmit = async () => {
    if (!customerId) { toast.warning("Please select a customer"); return; }
    if (items.some(l => !l.productId)) { toast.warning("Please select a product for all line items"); return; }
    if (items.some(l => !l.fabricId)) { toast.warning("Please select a fabric for all line items"); return; }
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

    setSaving(true);
    try {
      const res = await fetch(`/api/sales-orders/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId, customerPOId, customerSOId, reference,
          companySODate, customerDeliveryDate, hookkaExpectedDD, notes, items,
          // Forward the admin-issued override token (if any). The backend
          // PUT verifies + atomically consumes it, then skips the Rule-3
          // production_window pre-flight. Token is NOT included on
          // refresh/back-navigation because location.state resets — that's
          // the desired behavior (single-use semantics).
          ...(overrideTokenFromState ? { overrideToken: overrideTokenFromState } : {}),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
      setSaving(false);
      // res.ok guard — see create.tsx for why this matters. Without it a
      // rejected PUT (401/500) was indistinguishable from success because
      // the JSON parser accepts error bodies and we only looked at
      // data.success.
      if (!res.ok || !data.success) {
        toast.error(data.error || `Failed to update order (HTTP ${res.status})`);
        return;
      }
      // Only this SO changed. The PO prefix stays because editing items can
      // cascade to regenerating linked POs on the server.
      if (id) invalidateCache(`/api/sales-orders/${id}`);
      invalidateCachePrefix("/api/production-orders");
      navigate(`/sales/${id}`);
    } catch (e) {
      setSaving(false);
      toast.error(e instanceof Error ? e.message : "Network error — changes not saved");
    }
  };

  if (loading) return <div className="flex items-center justify-center h-64 text-[#6B7280]">Loading...</div>;

  if (!order) return (
    <div className="flex flex-col items-center justify-center h-64 gap-4">
      <div className="text-[#6B7280]">Order not found</div>
      <Button variant="outline" onClick={() => navigate("/sales")}>Back</Button>
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
          <Button variant="ghost" size="icon" onClick={() => navigate(`/sales/${id}`)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-xl font-bold text-[#1F1D1B]">Edit Sales Order</h1>
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
              <Button variant="primary" onClick={() => navigate(`/sales/${id}`)}>
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
    <div className="space-y-6">
      <LockBanner reason={lockReason} />

      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(`/sales/${id}`)}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-bold text-[#1F1D1B]">Edit {order.companySOId}</h1>
          <p className="text-xs text-[#6B7280]">Modify sales order details and line items</p>
        </div>
        <Button variant="outline" onClick={() => navigate(`/sales/${id}`)}>Cancel</Button>
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
              <div key={idx} className="rounded-md border border-[#E2DDD8] p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[#6B5C32]">Line {idx + 1}</span>
                    {item.itemCategory && <Badge>{item.itemCategory}</Badge>}
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
                          value={item.fabricId}
                          onChange={(val) => selectFabric(idx, val)}
                          options={fabrics.map(f => ({ value: f.id, label: `${f.code} - ${f.name}` }))}
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
                      <Input type="number" min={1} value={item.quantity} onChange={(e) => updateItem(idx, { quantity: parseInt(e.target.value) || 1 })} className="h-8" />
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
                          const cfg = maintenanceConfig?.sofaSizes;
                          const arr = Array.isArray(cfg) && cfg.length > 0
                            ? cfg.map((v) =>
                                typeof v === "object" && v && "value" in v
                                  ? String((v as { value: unknown }).value)
                                  : String(v),
                              )
                            : (SEAT_HEIGHT_OPTIONS as unknown as string[]);
                          return arr.map(h => ({ value: h, label: h }));
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
                            legPriceSen: sc,
                          });
                        }}
                        options={(() => {
                          const cfg = maintenanceConfig?.sofaLegHeights;
                          const arr = Array.isArray(cfg)
                            ? cfg.map((v) => typeof v === "object" && v && "value" in v ? (v as { value: string }).value : String(v))
                            : legHeightOptions.map(o => o.height);
                          return arr.map(h => ({ value: h, label: h }));
                        })()}
                        placeholder="Select leg..."
                        className="w-full rounded border border-[#E2DDD8] px-2 py-1.5 text-sm h-8"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-[#9CA3AF] mb-1">Base Price (RM)</label>
                      <Input type="number" min={0} value={item.basePriceSen / 100} onChange={(e) => updateItem(idx, { basePriceSen: Math.round(parseFloat(e.target.value || "0") * 100) })} className="h-8 text-right" />
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                      <div>
                        <label className="block text-xs text-[#9CA3AF] mb-1">Qty</label>
                        <Input type="number" min={1} value={item.quantity} onChange={(e) => updateItem(idx, { quantity: parseInt(e.target.value) || 1 })} className="h-8" />
                      </div>
                      <div>
                        <label className="block text-xs text-[#9CA3AF] mb-1">Base Price (RM)</label>
                        <Input type="number" min={0} value={item.basePriceSen / 100} onChange={(e) => updateItem(idx, { basePriceSen: Math.round(parseFloat(e.target.value || "0") * 100) })} className="h-8 text-right" />
                      </div>
                      <div>
                        <label className="block text-xs text-[#9CA3AF] mb-1">Gap (&quot;)</label>
                        <Input type="number" min={0} value={item.gapInches ?? ""} onChange={(e) => updateItem(idx, { gapInches: e.target.value ? parseFloat(e.target.value) : null })} className="h-8" placeholder="-" />
                      </div>
                      <div>
                        <label className="block text-xs text-[#9CA3AF] mb-1">Divan H (&quot;)</label>
                        <Input type="number" min={0} value={item.divanHeightInches ?? ""} onChange={(e) => updateItem(idx, { divanHeightInches: e.target.value ? parseFloat(e.target.value) : null })} className="h-8" placeholder="-" />
                      </div>
                      <div>
                        <label className="block text-xs text-[#9CA3AF] mb-1">Leg H (&quot;)</label>
                        <Input type="number" min={0} value={item.legHeightInches ?? ""} onChange={(e) => updateItem(idx, { legHeightInches: e.target.value ? parseFloat(e.target.value) : null })} className="h-8" placeholder="-" />
                      </div>
                    </div>

                    {(item.divanHeightInches || item.legHeightInches || item.specialOrder) && (
                      <div className="grid grid-cols-3 gap-3">
                        {item.divanHeightInches && (
                          <div>
                            <label className="block text-xs text-[#9CA3AF] mb-1">Divan Surcharge (RM)</label>
                            <Input type="number" min={0} value={item.divanPriceSen / 100} onChange={(e) => updateItem(idx, { divanPriceSen: Math.round(parseFloat(e.target.value || "0") * 100) })} className="h-8 text-right" />
                          </div>
                        )}
                        {item.legHeightInches && (
                          <div>
                            <label className="block text-xs text-[#9CA3AF] mb-1">Leg Surcharge (RM)</label>
                            <Input type="number" min={0} value={item.legPriceSen / 100} onChange={(e) => updateItem(idx, { legPriceSen: Math.round(parseFloat(e.target.value || "0") * 100) })} className="h-8 text-right" />
                          </div>
                        )}
                        {item.specialOrder && (
                          <div>
                            <label className="block text-xs text-[#9CA3AF] mb-1">Special Order Surcharge (RM)</label>
                            <Input type="number" min={0} value={item.specialOrderPriceSen / 100} onChange={(e) => updateItem(idx, { specialOrderPriceSen: Math.round(parseFloat(e.target.value || "0") * 100) })} className="h-8 text-right" />
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
                    </div>
                  );
                })()}

                <div>
                  <label className="block text-xs text-[#9CA3AF] mb-1">Line Notes</label>
                  <Input value={item.notes} onChange={(e) => updateItem(idx, { notes: e.target.value })} placeholder="Optional notes for this line..." className="h-8" />
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
                  <span>Unit: {formatCurrency(getUnitPrice(item))} (Base{item.seatHeight ? ` @${item.seatHeight}` : ""} {formatCurrency(item.basePriceSen)}{item.itemCategory !== "SOFA" && item.divanPriceSen ? ` + Divan ${formatCurrency(item.divanPriceSen)}` : ""}{item.itemCategory !== "SOFA" && item.legPriceSen ? ` + Leg ${formatCurrency(item.legPriceSen)}` : ""}{item.specialOrderPriceSen ? ` + Special ${formatCurrency(item.specialOrderPriceSen)}` : ""})</span>
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
