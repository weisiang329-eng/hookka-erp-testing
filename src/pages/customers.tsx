import { useState, useEffect, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KycPanel } from "@/components/customer/KycPanel";
import { PhoneInput } from "@/components/ui/phone-input";
import { StateSelect } from "@/components/ui/state-select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { useToast } from "@/components/ui/toast";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { formatCurrency, formatRM } from "@/lib/utils";
import { humanizeError } from "@/lib/humanize-error";
import { parseDebtorCode } from "@/lib/debtor";
import { useCachedJson, invalidateCache, invalidateCachePrefix } from "@/lib/cached-fetch";
import { verifiedSave, formatMismatchError } from "@/lib/verified-save";
import { useNavGuard } from "@/lib/use-nav-guard";
import type { Customer } from "@/types";
// generateCustomerQuotationPdf is dynamic-imported at the click handler so
// the 1MB jspdf vendor chunk only ships when the user actually exports.
import {
  Plus,
  Building2,
  Phone,
  Mail,
  X,
  Loader2,
  MapPin,
  Users,
  Eye,
  Pencil,
  Trash2,
  RefreshCw,
  Warehouse,
  Package,
  Search,
  Check,
  FileDown,
  Calendar,
  Copy,
  ChevronDown,
  ChevronRight,
  History,
  AlertTriangle,
  // Pencil already imported above for SKU edit. Used here as the Edit-mode
  // toggle icon on the customer Maintenance panel.
} from "lucide-react";
import {
  MaintenanceConfigHistoryDialog,
  MaintenanceConfigSaveModal,
  OLD_SO_SAFE_BANNER,
  type MaintenanceHistoryRow,
} from "./products/MaintenanceConfigHistoryDialog";
import {
  MaintenanceItemHistoryDialog,
  type PricedItemKey,
} from "./products/MaintenanceItemHistoryDialog";

// Mirrors PricedItemKey in MaintenanceItemHistoryDialog.tsx — kept inline
// here because Fast Refresh disallows mixing component + value exports
// from the same module.
const PRICED_ITEM_KEYS: readonly PricedItemKey[] = [
  "divanHeights",
  "legHeights",
  "totalHeights",
  "specials",
  "sofaLegHeights",
  "sofaSpecials",
];
const isPricedItemKey = (k: string): k is PricedItemKey =>
  (PRICED_ITEM_KEYS as readonly string[]).includes(k);
import {
  SofaComboHistoryDialog,
  type SofaComboHistoryRule,
} from "./maintenance/SofaComboHistoryDialog";

type CustomerMutationResponse =
  | { success: true; data: Customer }
  | { success: false; error?: string };

function asCustomerMutationResponse(v: unknown): CustomerMutationResponse | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (o.success === true && o.data && typeof o.data === "object") {
    return { success: true, data: o.data as Customer };
  }
  if (o.success === false) {
    return { success: false, error: typeof o.error === "string" ? o.error : undefined };
  }
  return null;
}

// =====================================================================
// Customer Products types (per-customer SKU assignments with price overrides)
// =====================================================================
// Sofa fabric price tier — mirrors src/pages/products/index.tsx so the
// Customer Products panel can render the same P1/P2/P3 toggle and tier-
// scoped seat-height cells. Legacy entries without a tier resolve to
// PRICE_2 via entryTier(), matching the Products page semantics.
type SofaTier = "PRICE_1" | "PRICE_2" | "PRICE_3";
const CUST_SOFA_TIERS: { value: SofaTier; label: string }[] = [
  { value: "PRICE_1", label: "P1" },
  { value: "PRICE_2", label: "P2" },
  { value: "PRICE_3", label: "P3" },
];
const custEntryTier = (t: SofaTier | undefined): SofaTier => t ?? "PRICE_2";

type SeatHeightEntry = { height: string; priceSen: number; tier?: SofaTier };

type CustomerProduct = {
  id: string;
  customerId: string;
  productId: string;
  productCode: string;
  productName: string;
  category: string;
  basePriceSen: number;
  price1Sen: number | null;
  // Backend returns an array of { height, priceSen, tier? } objects — tier
  // is preserved through JSON round-trip even though the legacy server type
  // didn't model it.
  seatHeightPrices: SeatHeightEntry[] | null;
  notes: string | null;
  hasPendingPriceChange?: boolean;
  masterPendingEffectiveFrom?: string | null;
};

type PriceHistoryRow = {
  id: string;
  basePriceSen: number | null;
  price1Sen: number | null;
  seatHeightPrices: SeatHeightEntry[];
  effectiveFrom: string;
  notes: string;
  created_at: string;
};

type ProductOption = {
  id: string;
  code: string;
  name: string;
  category: string;
  basePriceSen: number;
  price1Sen?: number | null;
  // Extra SKU-master fields pulled from /api/products so the quotation
  // PDF can mirror the Products page column layouts per category.
  sizeCode?: string | null;
  sizeLabel?: string | null;
  baseModel?: string | null;
  unitM3?: number | null;
  fabricUsage?: number | null;
  productionTimeMinutes?: number | null;
  description?: string | null;
  // Master snapshot copy uses these to seed customer_product_prices rows.
  seatHeightPrices?: SeatHeightEntry[] | null;
};

// ---------- State badge colours ----------
const stateBadgeColors: Record<string, string> = {
  KL: "bg-[#E0EDF0] text-[#3E6570] border-[#A8CAD2]",
  PG: "bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8]",
  SRW: "bg-[#FBE4CE] text-[#B8601A] border-[#E8B786]",
  SBH: "bg-[#F1E6F0] text-[#6B4A6D] border-[#D1B7D0]",
  JB: "bg-[#F9E1DA] text-[#9A3A2D] border-[#E8B2A1]",
};

function StateBadge({ state }: { state: string }) {
  if (!state) return null;
  const colors = stateBadgeColors[state] || "bg-gray-100 text-gray-700 border-gray-300";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${colors}`}>
      {state}
    </span>
  );
}

// =====================================================================
// Customer Products Panel — shown inside the expanded-customer detail.
// Lists SKUs assigned to this customer with per-customer price overrides.
//
// UX mirrors the Products page (src/pages/products/index.tsx):
//   - Same row-per-row table layout per category (BF / Sofa / Accessory),
//     minus Production Time / Total Min / Fabric (m) / Unit (m³) — the
//     customer panel is contract-scoped, not factory-scoped.
//   - Edit / Save / Cancel bulk workflow: every price edit lands in a
//     local dirtyEdits map; Save opens a modal that asks for an effective
//     date and dispatches one POST /:cpId/prices per dirty row.
//   - Calendar icon next to product code opens the per-product history
//     dialog (CustomerPriceHistoryDialog).
//   - Pending badge surfaces when a future-dated history row exists.
// =====================================================================
function CustomerProductsPanel({ customerId, customerName, customer }: { customerId: string; customerName: string; customer: Customer }) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  // Date the operator wants prices resolved to. Drives BOTH the on-screen
  // grid AND the Export Quotation PDF — plumbed into both
  // /api/customer-products?asOf= and /api/customer-quotation?asOf=.
  const [quotationAsOf, setQuotationAsOf] = useState<string>(() =>
    new Date().toISOString().slice(0, 10),
  );
  const { data: resp, refresh } = useCachedJson<{ success?: boolean; data?: CustomerProduct[] }>(
    customerId ? `/api/customer-products?customerId=${customerId}&asOf=${quotationAsOf}` : null
  );
  const serverRows: CustomerProduct[] = useMemo(
    () => (resp?.success ? resp.data ?? [] : Array.isArray(resp) ? (resp as CustomerProduct[]) : []),
    [resp]
  );

  // Local state mirrors the Products page: server snapshot seeds the
  // displayed rows, and inline edits patch the local copy until Save.
  const [rows, setRows] = useState<CustomerProduct[]>([]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setRows(serverRows); }, [serverRows]);

  const { data: productsResp } = useCachedJson<{ success?: boolean; data?: ProductOption[] }>("/api/products");
  const allProducts: ProductOption[] = useMemo(
    () => (productsResp?.success ? productsResp.data ?? [] : Array.isArray(productsResp) ? (productsResp as ProductOption[]) : []),
    [productsResp]
  );
  // Lookup by product id — built once per catalog change so the per-row render
  // below is an O(1) Map.get instead of a linear allProducts.find scan on every
  // row, every render (which re-ran on each price keystroke). Same value as the
  // old .find (product id is a unique key), just without the N×rows scan.
  const productById = useMemo(() => {
    const m = new Map<string, ProductOption>();
    for (const p of allProducts) m.set(p.id, p);
    return m;
  }, [allProducts]);

  const [query, setQuery] = useState("");
  const [categoryTab, setCategoryTab] = useState<"ALL" | "BEDFRAME" | "SOFA" | "ACCESSORY">("ALL");
  const [showAssign, setShowAssign] = useState(false);
  const [_assignQuery, setAssignQuery] = useState("");
  const [assignPicked, setAssignPicked] = useState<Set<string>>(new Set());
  const [assignSaving, setAssignSaving] = useState(false);
  const [copyingFromMaster, setCopyingFromMaster] = useState(false);

  // Sofa fabric tier toggle — same shape as Products page so legacy
  // entries with no `tier` resolve to PRICE_2.
  const [sofaTier, setSofaTier] = useState<SofaTier>("PRICE_2");

  // Per-product price-history dialog. Holds the cp row whose history is
  // being inspected; null when closed.
  const [historyForCpId, setHistoryForCpId] = useState<string | null>(null);

  // Collapsed by default so the Maintenance + Sofa Combo panels below
  // are visible without scrolling past 200+ product rows.
  const [collapsed, setCollapsed] = useState(true);

  // ---------- Bulk edit state (mirrors Products page dirtyEdits) ----------
  type DirtyCustomerEdit = {
    customerProductId: string;
    basePriceSen?: number;
    price1Sen?: number | null;
    // Full updated seatHeightPrices snapshot; the bulk POST sends this
    // so the new history row carries the complete picture and doesn't
    // accidentally clear cells that were never touched.
    seatHeightPrices?: SeatHeightEntry[];
  };
  const [dirtyEdits, setDirtyEdits] = useState<Map<string, DirtyCustomerEdit>>(new Map());
  const [editMode, setEditMode] = useState(false);
  const [showBulkSaveDialog, setShowBulkSaveDialog] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkEffectiveFrom, setBulkEffectiveFrom] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [bulkNotes, setBulkNotes] = useState("");

  // Inline-cell editing focus state (which cell is currently in input mode).
  const [editingBaseId, setEditingBaseId] = useState<string | null>(null);
  const [baseInput, setBaseInput] = useState("");
  const [editingPrice1Id, setEditingPrice1Id] = useState<string | null>(null);
  const [price1Input, setPrice1Input] = useState("");
  // Sofa cell editing — composite key "<cpId>__<height>__<tier>".
  const [editingSeatKey, setEditingSeatKey] = useState<string | null>(null);
  const [seatInput, setSeatInput] = useState("");

  const todayIso = () => new Date().toISOString().slice(0, 10);

  function recordDirty(cpId: string, patch: Partial<DirtyCustomerEdit>) {
    setDirtyEdits((prev) => {
      const next = new Map(prev);
      const existing = next.get(cpId) ?? { customerProductId: cpId };
      next.set(cpId, { ...existing, ...patch });
      return next;
    });
  }

  function discardDirty() {
    setDirtyEdits(new Map());
    setEditMode(false);
    setBulkNotes("");
    // Reload from server to undo optimistic local edits.
    invalidateCachePrefix(`/api/customer-products?customerId=${customerId}`);
    refresh();
  }

  const isSeatCellDirty = (cpId: string, height: string, tier: SofaTier) => {
    const d = dirtyEdits.get(cpId);
    if (!d || !d.seatHeightPrices) return false;
    return d.seatHeightPrices.some(
      (s) => s.height === height && custEntryTier(s.tier) === tier,
    );
  };

  // Bulk save — one POST /api/customer-products/:cpId/prices per dirty row.
  async function bulkSave() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(bulkEffectiveFrom)) {
      toast.error("Effective date must be YYYY-MM-DD.");
      return;
    }
    if (dirtyEdits.size === 0) return;
    setBulkSaving(true);
    try {
      const requests = Array.from(dirtyEdits.values()).map((d) => {
        const cur = rows.find((r) => r.id === d.customerProductId);
        // Compose a complete snapshot — fields the user didn't edit get
        // current values so the history row is self-contained.
        const body: Record<string, unknown> = {
          effectiveFrom: bulkEffectiveFrom,
          notes: bulkNotes || null,
          basePriceSen:
            d.basePriceSen !== undefined ? d.basePriceSen : (cur?.basePriceSen ?? null),
          price1Sen:
            d.price1Sen !== undefined ? d.price1Sen : (cur?.price1Sen ?? null),
          seatHeightPrices:
            d.seatHeightPrices !== undefined
              ? d.seatHeightPrices
              : (cur?.seatHeightPrices ?? null),
        };
        return fetch(`/api/customer-products/${d.customerProductId}/prices`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }).then((r) => ({ ok: r.ok, status: r.status, cpId: d.customerProductId }));
      });
      const results = await Promise.all(requests);
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        toast.error(
          `${failed.length} of ${results.length} updates failed. The successful ones were saved.`,
        );
      }
      setDirtyEdits(new Map());
      setShowBulkSaveDialog(false);
      setEditMode(false);
      setBulkNotes("");
      invalidateCachePrefix(`/api/customer-products?customerId=${customerId}`);
      refresh();
    } finally {
      setBulkSaving(false);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (categoryTab !== "ALL" && r.category !== categoryTab) return false;
      if (!q) return true;
      return r.productCode.toLowerCase().includes(q) || r.productName.toLowerCase().includes(q);
    });
  }, [rows, query, categoryTab]);

  // Counts come from the full assignment list so numbers stay stable as the user types/tabs.
  const categoryTabs: { key: "ALL" | "BEDFRAME" | "SOFA" | "ACCESSORY"; label: string }[] = [
    { key: "ALL", label: "All" },
    { key: "BEDFRAME", label: "Bedframe" },
    { key: "SOFA", label: "Sofa" },
    { key: "ACCESSORY", label: "Accessory" },
  ];
  const categoryCounts = useMemo(() => {
    const c = { ALL: rows.length, BEDFRAME: 0, SOFA: 0, ACCESSORY: 0 } as Record<"ALL" | "BEDFRAME" | "SOFA" | "ACCESSORY", number>;
    for (const r of rows) {
      if (r.category === "BEDFRAME" || r.category === "SOFA" || r.category === "ACCESSORY") {
        c[r.category] += 1;
      }
    }
    return c;
  }, [rows]);

  const assignedIds = useMemo(() => new Set(rows.map((r) => r.productId)), [rows]);

  const handleRemove = async (row: CustomerProduct) => {
    if (!(await confirm({ title: "Remove product?", message: `Remove "${row.productCode} ${row.productName}" from ${customerName}?`, danger: true }))) return;
    const res = await fetch(`/api/customer-products/${row.id}`, { method: "DELETE" });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error((j as { error?: string }).error || `Failed to remove (HTTP ${res.status})`);
      return;
    }
    invalidateCachePrefix(`/api/customer-products?customerId=${customerId}`);
    refresh();
  };

  const toggleAssignPick = (id: string) => {
    setAssignPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submitAssign = async () => {
    if (assignPicked.size === 0) return;
    setAssignSaving(true);
    try {
      const res = await fetch("/api/customer-products/bulk-assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, productIds: Array.from(assignPicked) }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error((j as { error?: string }).error || `Failed to assign (HTTP ${res.status})`);
        return;
      }
      invalidateCachePrefix(`/api/customer-products?customerId=${customerId}`);
      refresh();
      setAssignPicked(new Set());
      setAssignQuery("");
      setShowAssign(false);
    } finally {
      setAssignSaving(false);
    }
  };

  // Two-phase sync: assign every unassigned master SKU AND mirror every
  // master product_prices history row into customer_product_prices.
  // Idempotent — re-clicking on a customer with all SKUs already
  // assigned still backfills missing historical rows, so the customer's
  // history dialog reflects the master timeline (baseline + scheduled
  // changes) instead of just a single snapshot.
  const handleCopyFromMaster = async () => {
    const unassignedCount = allProducts.filter((p) => !assignedIds.has(p.id)).length;
    const confirmMsg =
      unassignedCount === 0
        ? `All master SKUs already assigned to ${customerName}. Re-syncing the price HISTORY from Master will add any missing rows (idempotent — won't duplicate). Continue?`
        : `Copy ${unassignedCount} unassigned SKU${unassignedCount === 1 ? "" : "s"} to ${customerName} AND mirror the full master price history (every effective-dated row). Continue?`;
    if (!(await confirm({ title: "Copy from Master?", message: confirmMsg }))) {
      return;
    }
    setCopyingFromMaster(true);
    try {
      const res = await fetch("/api/customer-products/copy-from-master", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, effectiveFrom: todayIso() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error((j as { error?: string }).error || `Copy from master failed (HTTP ${res.status})`);
        return;
      }
      const j = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        data?: { assigned?: number; historyRowsAdded?: number };
      };
      const a = j.data?.assigned ?? 0;
      const h = j.data?.historyRowsAdded ?? 0;
      toast.success(
        `Sync done — assigned ${a} new SKU${a === 1 ? "" : "s"}, mirrored ${h} master price-history row${h === 1 ? "" : "s"}.`,
      );
      invalidateCachePrefix(`/api/customer-products?customerId=${customerId}`);
      refresh();
    } finally {
      setCopyingFromMaster(false);
    }
  };

  const [exportingQuotation, setExportingQuotation] = useState(false);
  const [emailingQuotation, setEmailingQuotation] = useState(false);
  const [exportingCatalogue, setExportingCatalogue] = useState(false);

  // Customer catalogue export — generates a photo-first lookbook PDF for this
  // customer's assigned SKUs only, by reusing the customer-quotation endpoint to
  // resolve product list then the generate-product-catalogue-pdf generator.
  // `emailTo` turns this from a download into a send — same PDF either way, so
  // the emailed catalogue can never drift from the exported one.
  const handleExportCataloguePdf = async (emailTo?: string) => {
    if (rows.length === 0) return;
    setExportingCatalogue(true);
    try {
      const today = new Date().toISOString().slice(0, 10);
      const res = await fetch(
        `/api/customer-quotation?customerId=${encodeURIComponent(customerId)}&asOf=${today}`,
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error((j as { error?: string }).error || `Failed to fetch products (HTTP ${res.status})`);
        return;
      }
      const json = (await res.json()) as
        | { success: true; data: { products?: Array<{ code: string; name: string; category: string; sizeLabel: string | null }> } }
        | { success: false; error?: string };
      if (!json.success || !json.data?.products) {
        toast.error((json as { error?: string }).error || "No products found.");
        return;
      }

      // Derive baseModels and group products (mirrors catalog.tsx buildModelGroups)
      const groupMap = new Map<string, {
        category: string; name: string; sizeLabels: string[];
      }>();
      for (const p of json.data.products) {
        const key = (p.code || "").split(/\s|-\(/)[0].trim() || p.code;
        const sl = p.sizeLabel ?? "";
        const existing = groupMap.get(key);
        if (existing) {
          if (sl && !existing.sizeLabels.includes(sl)) existing.sizeLabels.push(sl);
        } else {
          groupMap.set(key, {
            category: p.category || "",
            name: p.name || "",
            sizeLabels: sl ? [sl] : [],
          });
        }
      }
      if (groupMap.size === 0) {
        toast.error("No models to export.");
        return;
      }

      // Fetch photo file IDs for modular assets
      const photoMap: Record<string, string> = {};
      try {
        const pr = await fetch("/api/files?resourceType=modular");
        const pj = (await pr.json().catch(() => null)) as {
          success?: boolean;
          data?: Array<{ id: string; resourceId: string }>;
        } | null;
        if (pr.ok && pj?.success && Array.isArray(pj.data)) {
          for (const f of pj.data) {
            if (!photoMap[f.resourceId]) photoMap[f.resourceId] = f.id;
          }
        }
      } catch { /* no photos — placeholders will be used */ }

      const { fetchModelPhotoBytes, default: generateProductCataloguePdf } = await import(
        "@/lib/generate-product-catalogue-pdf"
      );

      const entries = await Promise.all(
        Array.from(groupMap.entries()).map(async ([baseModel, g]) => {
          const fileId = photoMap[baseModel];
          let photoBytes: Uint8Array | null = null;
          let photoMimeType = "image/jpeg";
          if (fileId) {
            const result = await fetchModelPhotoBytes(fileId);
            if (result) { photoBytes = result.bytes; photoMimeType = result.mimeType; }
          }
          return {
            baseModel,
            category: g.category,
            name: g.name,
            variantCount: json.data.products!.filter(
              (p) => ((p.code || "").split(/\s|-\(/)[0].trim() || p.code) === baseModel,
            ).length,
            sizeLabels: g.sizeLabels.sort(),
            photoBytes,
            photoMimeType,
          };
        }),
      );
      entries.sort((a, b) =>
        a.category !== b.category
          ? a.category.localeCompare(b.category)
          : a.baseModel.localeCompare(b.baseModel),
      );

      const doc = generateProductCataloguePdf(entries, { customerName });
      const safeCode = (customerId || customerName).replace(/[^a-zA-Z0-9_-]+/g, "_");
      const filename = `Product-Catalogue-${safeCode}-${today}.pdf`;
      if (emailTo) {
        // Same PDF, delivered instead of downloaded. The send endpoint takes
        // bare base64, so strip the data-URI prefix jsPDF emits.
        const dataUri = doc.output("datauristring");
        const sendRes = await fetch("/api/customer-crm/send-quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerId,
            to: emailTo,
            filename,
            pdfBase64: dataUri.slice(dataUri.indexOf(",") + 1),
          }),
        });
        const sendJson = (await sendRes.json().catch(() => ({}))) as {
          success?: boolean;
          error?: string;
        };
        if (!sendRes.ok || !sendJson.success) {
          toast.error(sendJson.error || `Send failed (HTTP ${sendRes.status})`);
          return;
        }
        toast.success(`Catalogue emailed to ${emailTo}.`);
        return;
      }
      doc.save(filename);
    } catch (err) {
      console.error("[Customer Catalogue PDF]", err);
      toast.error("Failed to generate catalogue PDF.");
    } finally {
      setExportingCatalogue(false);
    }
  };

  // Date-aware export. Fetches the combined envelope (products + sofa combos
  // + maintenance config + letterhead-resolved customer block) and hands it
  // to the v2 generator. Filename embeds the customer code + asOf so multiple
  // exports for the same customer don't collide on disk.
  const handleExportQuotationV2 = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(quotationAsOf)) {
      toast.error("Effective date must be YYYY-MM-DD.");
      return;
    }
    setExportingQuotation(true);
    try {
      const res = await fetch(
        `/api/customer-quotation?customerId=${encodeURIComponent(customerId)}&asOf=${encodeURIComponent(quotationAsOf)}`,
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(
          (j as { error?: string }).error ||
            `Failed to fetch quotation (HTTP ${res.status})`,
        );
        return;
      }
      const json = (await res.json()) as
        | { success: true; data: import("@/lib/generate-customer-quotation-pdf-v2").QuotationEnvelope }
        | { success: false; error?: string };
      if (!json.success) {
        toast.error(json.error || "Quotation API returned an error.");
        return;
      }
      // Optional: pull a kv_config('org-letterhead') override so the PDF
      // header can show the live company branding without bumping the API.
      let letterhead: import("@/lib/generate-customer-quotation-pdf-v2").LetterheadConfig =
        null;
      try {
        const lhRes = await fetch("/api/kv-config/org-letterhead");
        if (lhRes.ok) {
          const lhJson = (await lhRes.json()) as { success: boolean; data: unknown };
          if (lhJson.success && lhJson.data && typeof lhJson.data === "object") {
            letterhead = lhJson.data as import("@/lib/generate-customer-quotation-pdf-v2").LetterheadConfig;
          } else {
            console.log(
              "[Quotation] No org-letterhead kv_config — using fallback. Configure letterhead in Settings.",
            );
          }
        }
      } catch {
        console.log(
          "[Quotation] org-letterhead fetch failed — using fallback.",
        );
      }
      const { default: generateCustomerQuotationPdfV2 } = await import(
        "@/lib/generate-customer-quotation-pdf-v2"
      );
      const doc = generateCustomerQuotationPdfV2({
        ...json.data,
        letterhead,
      });
      const safeCode = (json.data.customer.code || customerName).replace(
        /[^a-zA-Z0-9_-]+/g,
        "_",
      );
      doc.save(`Quotation-${safeCode}-${quotationAsOf}.pdf`);
    } finally {
      setExportingQuotation(false);
    }
  };

  // Which document the Email button sends. Kept as state (not two buttons) so
  // the operator makes one explicit choice instead of hunting for the right
  // look-alike control.
  const [emailDocKind, setEmailDocKind] = useState<"QUOTATION" | "CATALOGUE">(
    "QUOTATION",
  );

  // Shared recipient prompt + confirm for BOTH document kinds. Sending is an
  // outward action, so the operator always sees who it is going to and what is
  // going, and can correct the address before anything leaves.
  const askRecipient = async (label: string): Promise<string | null> => {
    const to = window.prompt(
      `Email this ${label} to which address?`,
      customer.email?.trim() || "",
    );
    if (to === null) return null; // cancelled
    const recipient = to.trim();
    if (!/.+@.+\..+/.test(recipient)) {
      toast.error("That doesn't look like a valid email address.");
      return null;
    }
    const ok = await confirm({
      title: `Send ${label}?`,
      message: `Email the ${label} for ${customerName} to ${recipient}?`,
    });
    return ok ? recipient : null;
  };

  const handleEmailDocument = async () => {
    if (emailDocKind === "QUOTATION") {
      await handleEmailQuotationV2();
      return;
    }
    const recipient = await askRecipient("catalogue");
    if (!recipient) return;
    await handleExportCataloguePdf(recipient);
  };

  // One-click send (CRM slice 6): generate the SAME quotation PDF in the
  // browser, base64-encode it, and hand it to /api/customer-crm/send-quote which
  // emails it + logs a QUOTE_SENT activity. Sending is an outward action, so a
  // confirm dialog gates it and the operator can correct the recipient first.
  const handleEmailQuotationV2 = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(quotationAsOf)) {
      toast.error("Effective date must be YYYY-MM-DD.");
      return;
    }
    setEmailingQuotation(true);
    try {
      const res = await fetch(
        `/api/customer-quotation?customerId=${encodeURIComponent(customerId)}&asOf=${encodeURIComponent(quotationAsOf)}`,
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error(
          (j as { error?: string }).error ||
            `Failed to fetch quotation (HTTP ${res.status})`,
        );
        return;
      }
      const json = (await res.json()) as
        | { success: true; data: import("@/lib/generate-customer-quotation-pdf-v2").QuotationEnvelope }
        | { success: false; error?: string };
      if (!json.success) {
        toast.error(json.error || "Quotation API returned an error.");
        return;
      }
      const defaultEmail = json.data.customer.email?.trim() || "";
      // Let the operator confirm / correct the recipient before anything is sent.
      const to = window.prompt(
        `Email this quotation to which address?`,
        defaultEmail,
      );
      if (to === null) return; // cancelled
      const recipient = to.trim();
      if (!/.+@.+\..+/.test(recipient)) {
        toast.error("That doesn't look like a valid email address.");
        return;
      }
      const ok = await confirm({
        title: "Send quotation?",
        message: `Email the ${quotationAsOf} quotation for ${customerName} to ${recipient}?`,
      });
      if (!ok) return;

      let letterhead: import("@/lib/generate-customer-quotation-pdf-v2").LetterheadConfig =
        null;
      try {
        const lhRes = await fetch("/api/kv-config/org-letterhead");
        if (lhRes.ok) {
          const lhJson = (await lhRes.json()) as { success: boolean; data: unknown };
          if (lhJson.success && lhJson.data && typeof lhJson.data === "object") {
            letterhead = lhJson.data as import("@/lib/generate-customer-quotation-pdf-v2").LetterheadConfig;
          }
        }
      } catch {
        /* fallback letterhead */
      }
      const { default: generateCustomerQuotationPdfV2 } = await import(
        "@/lib/generate-customer-quotation-pdf-v2"
      );
      const doc = generateCustomerQuotationPdfV2({ ...json.data, letterhead });
      const safeCode = (json.data.customer.code || customerName).replace(
        /[^a-zA-Z0-9_-]+/g,
        "_",
      );
      const filename = `Quotation-${safeCode}-${quotationAsOf}.pdf`;
      // doc.output('datauristring') → "data:application/pdf;base64,AAAA…"; the
      // send endpoint wants the bare base64, so strip the data-URI prefix.
      const dataUri = doc.output("datauristring");
      const base64 = dataUri.slice(dataUri.indexOf(",") + 1);
      const sendRes = await fetch("/api/customer-crm/send-quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, to: recipient, filename, pdfBase64: base64 }),
      });
      const sendJson = (await sendRes.json().catch(() => ({}))) as {
        success?: boolean;
        error?: string;
      };
      if (!sendRes.ok || !sendJson.success) {
        toast.error(sendJson.error || `Send failed (HTTP ${sendRes.status})`);
        return;
      }
      toast.success(`Quotation emailed to ${recipient}.`);
    } finally {
      setEmailingQuotation(false);
    }
  };

  // ---------- Layout helpers (mirror Products page) ----------
  const isSofaView = categoryTab === "SOFA";
  const isAccessoryView = categoryTab === "ACCESSORY";
  // Column count (used as colSpan when rendering the table-level wrapper).
  // BEDFRAME / ALL: Code | Description | Category | Size | Price 2 | Price 1 | Actions = 7
  // SOFA:           Code | Description | Model | 24 | 28 | 30 | 32 | 35 | Actions = 9
  // ACCESSORY:      Code | Description | Base Price | Actions = 4
  const colSpanN = isSofaView ? 9 : isAccessoryView ? 4 : 7;
  const gridCols = isSofaView
    ? "1.3fr 1.5fr 0.7fr 0.95fr 0.95fr 0.95fr 0.95fr 0.95fr 0.7fr"
    : isAccessoryView
    ? "1.3fr 2.5fr 1fr 0.7fr"
    : "1.3fr 2fr 0.8fr 0.8fr 1fr 1fr 0.7fr";
  const thCls = "px-3 py-1.5 text-[11px] font-medium text-[#6B7280] uppercase tracking-wider";

  // The cp row whose history dialog is open, looked up against the current rows array.
  const historyTargetRow = useMemo(
    () => (historyForCpId ? rows.find((r) => r.id === historyForCpId) ?? null : null),
    [historyForCpId, rows],
  );

  return (
    <Card className="border-[#6B5C32] border-2">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="flex items-center gap-2 text-base font-semibold text-[#1F1D1B] hover:text-[#6B5C32] transition-colors"
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4 text-[#6B5C32]" />
            ) : (
              <ChevronDown className="h-4 w-4 text-[#6B5C32]" />
            )}
            <Package className="h-5 w-5 text-[#6B5C32]" />
            Customer Products — {customerName} ({rows.length})
          </button>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Date-aware quotation: operator picks the asOf date the prices
                should resolve to (today / past / future scheduled rate). */}
            <div className="flex items-center gap-1">
              <label
                htmlFor={`quote-asof-${customerId}`}
                className="text-[11px] text-[#6B7280] font-medium"
              >
                Effective
              </label>
              <input
                id={`quote-asof-${customerId}`}
                type="date"
                value={quotationAsOf}
                onChange={(e) => setQuotationAsOf(e.target.value)}
                className="h-8 px-2 text-xs border border-[#E2DDD8] rounded-md bg-white text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={rows.length === 0 || exportingQuotation}
              onClick={handleExportQuotationV2}
            >
              {exportingQuotation ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <FileDown className="h-4 w-4 mr-1" />
              )}
              Export Quotation PDF
            </Button>
            {/* Owner 2026-08-01: one Email control, two documents. Picking WHAT to
                send belongs next to the send button, not split across two
                look-alike buttons the operator has to tell apart. Both paths
                reuse the exact PDF their Export counterpart produces, so what
                lands in the customer's inbox is what you saw on screen. */}
            <div className="flex items-center">
              <select
                value={emailDocKind}
                onChange={(e) => setEmailDocKind(e.target.value as "QUOTATION" | "CATALOGUE")}
                disabled={rows.length === 0 || emailingQuotation || exportingCatalogue}
                aria-label="Which document to email"
                className="h-8 rounded-l-md border border-r-0 border-[#E2DDD8] bg-white px-2 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/30 disabled:opacity-50"
              >
                <option value="QUOTATION">Quotation</option>
                <option value="CATALOGUE">Catalogue</option>
              </select>
              <Button
                variant="outline"
                size="sm"
                className="rounded-l-none"
                disabled={rows.length === 0 || emailingQuotation || exportingCatalogue}
                onClick={() => void handleEmailDocument()}
                title={
                  emailDocKind === "QUOTATION"
                    ? "Generate the quotation PDF and email it to the customer"
                    : "Generate the product catalogue PDF and email it to the customer"
                }
              >
                {emailingQuotation || exportingCatalogue ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Mail className="h-4 w-4 mr-1" />
                )}
                Email
              </Button>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={rows.length === 0 || exportingCatalogue}
              onClick={() => void handleExportCataloguePdf()}
              title="Export a photo-first product lookbook for this customer's assigned SKUs"
            >
              {exportingCatalogue ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <FileDown className="h-4 w-4 mr-1" />
              )}
              Export Catalogue PDF
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={copyingFromMaster}
              onClick={handleCopyFromMaster}
            >
              {copyingFromMaster ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Copy className="h-4 w-4 mr-1" />
              )}
              Copy from Master Listing
            </Button>
            <Button variant="primary" size="sm" onClick={() => setShowAssign(true)}>
              <Plus className="h-4 w-4 mr-1" />
              Assign SKU
            </Button>
          </div>
        </div>
        {!collapsed && (<>
        <div className="flex items-center gap-2 flex-wrap mt-3">
          {categoryTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setCategoryTab(tab.key)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                categoryTab === tab.key
                  ? "bg-[#111827] text-white"
                  : "bg-white text-[#6B7280] border border-[#E2DDD8] hover:bg-[#F3F4F6]"
              }`}
            >
              {tab.label} ({categoryCounts[tab.key]})
            </button>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <div className="relative w-48">
            <Search className="h-3.5 w-3.5 text-[#9CA3AF] absolute left-2.5 top-1/2 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search SKUs..."
              className="h-8 pl-8"
            />
          </div>
          {/* Edit / Save / Cancel — bulk price-edit gate, mirrors the
              Products page. Cells are click-to-edit only while editMode is
              on; Save opens a modal that asks for the effective date and
              dispatches one customer_product_prices row per dirty cp row. */}
          {!editMode ? (
            <button
              onClick={() => setEditMode(true)}
              className="px-3 py-1.5 rounded-md text-xs font-medium bg-white text-[#6B7280] border border-[#E2DDD8] hover:bg-[#F3F4F6] transition-colors"
            >
              Edit Prices
            </button>
          ) : (
            <>
              <button
                onClick={() => {
                  if (dirtyEdits.size === 0) {
                    setEditMode(false);
                    return;
                  }
                  setShowBulkSaveDialog(true);
                }}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  dirtyEdits.size > 0
                    ? "bg-[#6B5C32] text-white hover:bg-[#5A4E2A]"
                    : "bg-white text-[#9CA3AF] border border-[#E2DDD8] cursor-not-allowed"
                }`}
                disabled={dirtyEdits.size === 0}
              >
                Save{dirtyEdits.size > 0 ? ` (${dirtyEdits.size})` : ""}
              </button>
              <button
                onClick={async () => {
                  if (
                    dirtyEdits.size > 0 &&
                    !(await confirm({
                      title: "Discard unsaved changes?",
                      message: `Discard ${dirtyEdits.size} unsaved change${dirtyEdits.size === 1 ? "" : "s"}?`,
                      danger: true,
                    }))
                  ) {
                    return;
                  }
                  discardDirty();
                }}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-white text-[#6B7280] border border-[#E2DDD8] hover:bg-[#F3F4F6] transition-colors"
              >
                Cancel
              </button>
            </>
          )}
          {/* Sofa fabric-tier toggle — only meaningful on the Sofa tab.
              Mirrors the Products page segmented control. */}
          {isSofaView && (
            <>
              <div className="w-px h-5 bg-[#E2DDD8] mx-1" />
              <span className="text-[11px] text-[#6B7280] uppercase tracking-wide">Tier</span>
              <div className="inline-flex rounded-md border border-[#E2DDD8] overflow-hidden">
                {CUST_SOFA_TIERS.map((t) => (
                  <button
                    key={t.value}
                    onClick={() => setSofaTier(t.value)}
                    className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                      sofaTier === t.value
                        ? "bg-[#6B5C32] text-white"
                        : "bg-white text-[#6B7280] hover:bg-[#F3F4F6]"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        </>)}
      </CardHeader>
      {/* Assign SKU modal — full-screen overlay. Mounted OUTSIDE the
          collapsed branch so the "Assign SKU" button on the header still
          opens it when the panel itself is collapsed. Was inside the
          {!collapsed && ...} block before 2026-05-06, which left the
          button silently no-op'd whenever the panel was collapsed
          (default since 7923f04 — user reported "Assign SKU 没反应"). */}
      <AssignSkuModal
        open={showAssign}
        customerName={customerName}
        candidates={allProducts.filter((p) => !assignedIds.has(p.id))}
        picked={assignPicked}
        togglePick={toggleAssignPick}
        setPicked={setAssignPicked}
        saving={assignSaving}
        onClose={() => { setShowAssign(false); setAssignPicked(new Set()); setAssignQuery(""); }}
        onSubmit={submitAssign}
      />
      {!collapsed && (
      <CardContent>

        {/* Per-product price-history dialog (calendar icon next to code). */}
        {historyTargetRow && (
          <CustomerPriceHistoryDialog
            cp={historyTargetRow}
            onClose={() => setHistoryForCpId(null)}
            onChanged={() => {
              invalidateCachePrefix(`/api/customer-products?customerId=${customerId}`);
              refresh();
            }}
          />
        )}

        {rows.length === 0 ? (
          <div className="py-8 text-center space-y-3">
            <p className="text-sm text-[#9CA3AF]">
              No SKUs assigned. Pillows and bedframes assigned to this customer will show here.
            </p>
            <Button variant="primary" size="sm" onClick={() => setShowAssign(true)}>
              <Plus className="h-4 w-4 mr-1" /> Assign SKU
            </Button>
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-[#E2DDD8] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-[#E2DDD8]">
                <thead className="bg-[#F9FAFB]">
                  <tr>
                    <th colSpan={colSpanN} className="p-0">
                      <div className="grid" style={{ gridTemplateColumns: gridCols }}>
                        <div className={`${thCls} text-left flex items-center gap-1.5`}>
                          <span className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                          Product Code
                        </div>
                        <div className={`${thCls} text-left`}>Description</div>
                        {isSofaView ? (
                          <>
                            <div className={`${thCls} text-left`}>Model</div>
                            <div className={`${thCls} text-right`}>24</div>
                            <div className={`${thCls} text-right`}>28</div>
                            <div className={`${thCls} text-right`}>30</div>
                            <div className={`${thCls} text-right`}>32</div>
                            <div className={`${thCls} text-right`}>35</div>
                            <div className={`${thCls} text-right`}>Actions</div>
                          </>
                        ) : isAccessoryView ? (
                          <>
                            <div className={`${thCls} text-right`}>Base Price</div>
                            <div className={`${thCls} text-right`}>Actions</div>
                          </>
                        ) : (
                          <>
                            <div className={`${thCls} text-left`}>Category</div>
                            <div className={`${thCls} text-left`}>Size</div>
                            <div className={`${thCls} text-right`}>Price 2</div>
                            <div className={`${thCls} text-right`}>Price 1</div>
                            <div className={`${thCls} text-right`}>Actions</div>
                          </>
                        )}
                      </div>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E2DDD8]">
                  {filtered.map((row) => {
                    const productMaster = productById.get(row.productId);
                    const description = productMaster?.description ?? "";
                    const baseModel = productMaster?.baseModel ?? "";
                    const sizeLabel = productMaster?.sizeLabel ?? "";
                    const isEditingBase = editingBaseId === row.id;
                    const isEditingP1 = editingPrice1Id === row.id;
                    const dirty = dirtyEdits.get(row.id);
                    const baseDirty = dirty?.basePriceSen !== undefined;
                    const p1Dirty = dirty?.price1Sen !== undefined;

                    return (
                      <tr key={row.id} className="group">
                        <td colSpan={colSpanN} className="p-0">
                          <div
                            className="grid hover:bg-[#FAF9F7] transition-colors"
                            style={{ gridTemplateColumns: gridCols }}
                          >
                            {/* Code + calendar icon + Pending badge */}
                            <div className="px-3 py-1.5 flex items-center gap-1.5">
                              <span className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                              <span className="text-xs font-mono font-medium text-[#111827] whitespace-nowrap">
                                {row.productCode}
                              </span>
                              <button
                                type="button"
                                title="View / schedule customer price history"
                                onClick={() => setHistoryForCpId(row.id)}
                                className={`p-1 rounded flex-shrink-0 ${
                                  row.hasPendingPriceChange
                                    ? "text-[#B8601A] hover:bg-[#FBE4CE]"
                                    : "text-[#9CA3AF] hover:text-[#6B5C32] hover:bg-[#F4F0E8]"
                                }`}
                              >
                                <Calendar className="h-3.5 w-3.5" />
                              </button>
                              {row.hasPendingPriceChange && (
                                <span
                                  title="A future-dated price change is queued for this customer"
                                  className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-medium bg-[#FBE4CE] text-[#B8601A] border border-[#E8B786]"
                                >
                                  Pending
                                </span>
                              )}
                            </div>
                            {/* Description */}
                            <div className="px-3 py-1.5 min-w-0">
                              <span className="text-xs text-[#111827] truncate block">{row.productName}</span>
                              {description && (
                                <span className="block text-[11px] text-[#9CA3AF] truncate">{description}</span>
                              )}
                            </div>

                            {isSofaView ? (
                              <>
                                {/* Model */}
                                <div className="px-3 py-1.5 text-sm text-[#111827]">{baseModel || "—"}</div>
                                {/* 5 seat-height columns, tier-aware */}
                                {(['24"', '28"', '30"', '32"', '35"'] as const).map((h) => {
                                  const hNum = h.replace('"', '');
                                  const norm = (v: unknown) => String(v ?? "").replace('"', '').trim();
                                  const sh = (row.seatHeightPrices || []).find(
                                    (s) => norm(s.height) === hNum && custEntryTier(s.tier) === sofaTier,
                                  );
                                  const editKey = `${row.id}__${h}__${sofaTier}`;
                                  const isEditingThisCell = editingSeatKey === editKey;
                                  return (
                                    <div key={h} className="px-3 py-1.5 text-right">
                                      {isEditingThisCell ? (
                                        <input
                                          autoFocus
                                          type="number" onFocus={(e) => e.currentTarget.select()}
                                          step="0.01"
                                          value={seatInput}
                                          onChange={(e) => setSeatInput(e.target.value)}
                                          onBlur={() => {
                                            const val = Math.round(parseFloat(seatInput || "0") * 100);
                                            setEditingSeatKey(null);
                                            const matches = (s: SeatHeightEntry) =>
                                              norm(s.height) === hNum && custEntryTier(s.tier) === sofaTier;
                                            let arr: SeatHeightEntry[] = row.seatHeightPrices || [];
                                            if (!arr.find(matches)) {
                                              arr = [...arr, { height: hNum, priceSen: val, tier: sofaTier }];
                                            }
                                            const updated = arr.map((s) =>
                                              matches(s) ? { height: hNum, priceSen: val, tier: sofaTier } : s,
                                            );
                                            setRows((prev) =>
                                              prev.map((r) =>
                                                r.id === row.id ? { ...r, seatHeightPrices: updated } : r,
                                              ),
                                            );
                                            recordDirty(row.id, { seatHeightPrices: updated });
                                          }}
                                          onKeyDown={(e) => {
                                            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                            if (e.key === "Escape") setEditingSeatKey(null);
                                          }}
                                          className="w-full text-right text-xs border border-[#6B5C32] rounded px-1 py-0.5 bg-[#FAEFCB] focus:outline-none"
                                        />
                                      ) : (
                                        <button
                                          onClick={() => {
                                            if (!editMode) return;
                                            setSeatInput(((sh?.priceSen ?? 0) / 100).toFixed(2));
                                            setEditingSeatKey(editKey);
                                          }}
                                          className={`text-sm tabular-nums ${
                                            isSeatCellDirty(row.id, hNum, sofaTier)
                                              ? "bg-[#FEF7E0] px-1.5 rounded text-[#9C6F1E] font-semibold"
                                              : "text-[#111827]"
                                          } ${editMode ? "hover:text-[#6B5C32] hover:underline cursor-pointer" : "cursor-default"}`}
                                        >
                                          {sh && sh.priceSen > 0 ? formatCurrency(sh.priceSen) : <span className="text-[#9CA3AF]">-</span>}
                                        </button>
                                      )}
                                    </div>
                                  );
                                })}
                              </>
                            ) : isAccessoryView ? (
                              <>
                                {/* Base Price (editable) */}
                                <div className="px-3 py-1.5 text-right">
                                  {isEditingBase ? (
                                    <input
                                      autoFocus
                                      type="number" onFocus={(e) => e.currentTarget.select()}
                                      step="0.01"
                                      value={baseInput}
                                      onChange={(e) => setBaseInput(e.target.value)}
                                      onBlur={() => {
                                        const val = Math.round(parseFloat(baseInput || "0") * 100);
                                        setEditingBaseId(null);
                                        setRows((prev) => prev.map((r) => r.id === row.id ? { ...r, basePriceSen: val } : r));
                                        recordDirty(row.id, { basePriceSen: val });
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                        if (e.key === "Escape") setEditingBaseId(null);
                                      }}
                                      className="w-full text-right text-sm border border-[#6B5C32] rounded px-2 py-0.5 bg-[#FAEFCB] focus:outline-none"
                                    />
                                  ) : (
                                    <button
                                      onClick={() => {
                                        if (!editMode) return;
                                        setEditingBaseId(row.id);
                                        setBaseInput((row.basePriceSen / 100).toFixed(2));
                                      }}
                                      className={`text-sm font-medium ${
                                        baseDirty
                                          ? "bg-[#FEF7E0] px-1.5 rounded text-[#9C6F1E]"
                                          : "text-[#111827]"
                                      } ${editMode ? "hover:text-[#6B5C32] hover:underline cursor-pointer" : "cursor-default"}`}
                                    >
                                      {row.basePriceSen > 0 ? formatRM(row.basePriceSen) : <span className="text-[#9CA3AF]">Set price</span>}
                                    </button>
                                  )}
                                </div>
                              </>
                            ) : (
                              /* BEDFRAME / ALL */
                              <>
                                <div className="px-3 py-1.5">
                                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                                    row.category === "BEDFRAME" ? "bg-[#FAEFCB] text-[#9C6F1E]" :
                                    row.category === "SOFA" ? "bg-[#E0EDF0] text-[#3E6570]" :
                                    "bg-[#F3F4F6] text-[#6B7280]"
                                  }`}>
                                    {row.category}
                                  </span>
                                </div>
                                <div className="px-3 py-1.5 text-sm text-[#111827]">{sizeLabel || "—"}</div>
                                {/* Price 2 */}
                                <div className="px-3 py-1.5 text-right">
                                  {isEditingBase ? (
                                    <input
                                      autoFocus
                                      type="number" onFocus={(e) => e.currentTarget.select()}
                                      step="0.01"
                                      value={baseInput}
                                      onChange={(e) => setBaseInput(e.target.value)}
                                      onBlur={() => {
                                        const val = Math.round(parseFloat(baseInput || "0") * 100);
                                        setEditingBaseId(null);
                                        setRows((prev) => prev.map((r) => r.id === row.id ? { ...r, basePriceSen: val } : r));
                                        recordDirty(row.id, { basePriceSen: val });
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                        if (e.key === "Escape") setEditingBaseId(null);
                                      }}
                                      className="w-full text-right text-sm border border-[#6B5C32] rounded px-2 py-0.5 bg-[#FAEFCB] focus:outline-none"
                                    />
                                  ) : (
                                    <button
                                      onClick={() => {
                                        if (!editMode) return;
                                        setEditingBaseId(row.id);
                                        setBaseInput((row.basePriceSen / 100).toFixed(2));
                                      }}
                                      className={`text-sm font-medium ${
                                        baseDirty
                                          ? "bg-[#FEF7E0] px-1.5 rounded text-[#9C6F1E]"
                                          : "text-[#111827]"
                                      } ${editMode ? "hover:text-[#6B5C32] hover:underline cursor-pointer" : "cursor-default"}`}
                                    >
                                      {row.basePriceSen > 0 ? formatRM(row.basePriceSen) : <span className="text-[#9CA3AF]">Set price</span>}
                                    </button>
                                  )}
                                </div>
                                {/* Price 1 */}
                                <div className="px-3 py-1.5 text-right">
                                  {isEditingP1 ? (
                                    <input
                                      autoFocus
                                      type="number" onFocus={(e) => e.currentTarget.select()}
                                      step="0.01"
                                      value={price1Input}
                                      onChange={(e) => setPrice1Input(e.target.value)}
                                      onBlur={() => {
                                        const val = price1Input.trim() === ""
                                          ? null
                                          : Math.round(parseFloat(price1Input) * 100);
                                        setEditingPrice1Id(null);
                                        setRows((prev) => prev.map((r) => r.id === row.id ? { ...r, price1Sen: val } : r));
                                        recordDirty(row.id, { price1Sen: val });
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                        if (e.key === "Escape") setEditingPrice1Id(null);
                                      }}
                                      className="w-full text-right text-sm border border-[#6B5C32] rounded px-2 py-0.5 bg-[#FAEFCB] focus:outline-none"
                                    />
                                  ) : (
                                    <button
                                      onClick={() => {
                                        if (!editMode) return;
                                        setEditingPrice1Id(row.id);
                                        setPrice1Input(row.price1Sen != null ? (row.price1Sen / 100).toFixed(2) : "");
                                      }}
                                      className={`text-sm font-medium ${
                                        p1Dirty
                                          ? "bg-[#FEF7E0] px-1.5 rounded text-[#9C6F1E]"
                                          : "text-[#111827]"
                                      } ${editMode ? "hover:text-[#6B5C32] hover:underline cursor-pointer" : "cursor-default"}`}
                                    >
                                      {row.price1Sen != null && row.price1Sen > 0
                                        ? formatRM(row.price1Sen)
                                        : <span className="text-[#9CA3AF]">-</span>}
                                    </button>
                                  )}
                                </div>
                              </>
                            )}
                            {/* Actions */}
                            <div className="px-3 py-1.5 flex justify-end items-center">
                              <button
                                onClick={() => handleRemove(row)}
                                className="p-1.5 rounded hover:bg-[#F9E1DA]"
                                title="Remove from this customer"
                              >
                                <Trash2 className="h-3.5 w-3.5 text-[#9A3A2D]" />
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {filtered.length === 0 && rows.length > 0 && (
                    <tr>
                      <td colSpan={colSpanN} className="py-4 text-center text-xs text-[#9CA3AF]">
                        {categoryTab !== "ALL"
                          ? "No SKUs in this category"
                          : `No SKUs match "${query}".`}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-2 bg-[#F9FAFB] border-t border-[#E2DDD8] flex items-center justify-between">
              <span className="text-xs text-[#6B7280]">
                Record {filtered.length > 0 ? 1 : 0} of {filtered.length}
              </span>
              <span className="text-xs text-[#9CA3AF]">{rows.length} total assigned</span>
            </div>
          </div>
        )}
      </CardContent>
      )}

      {/* Bulk save dialog — surfaces when the user clicks "Save N changes"
          while in edit mode. Captures the effective date and an optional
          shared note, then dispatches one customer_product_prices history
          row per dirty cp row. */}
      {showBulkSaveDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => !bulkSaving && setShowBulkSaveDialog(false)}
        >
          <div
            className="bg-white rounded-lg shadow-xl w-[90vw] max-w-md mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-[#E2DDD8]">
              <h2 className="text-lg font-semibold text-[#1F1D1B]">
                Save {dirtyEdits.size} price change{dirtyEdits.size === 1 ? "" : "s"}
              </h2>
              <p className="text-xs text-[#6B7280] mt-1">
                Pick the date the new prices should take effect. All
                changes share the same effective date. Affects {customerName} only.
              </p>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div className="flex items-start gap-2 rounded border border-[#E8D597] bg-[#FAEFCB] px-3 py-2 text-xs text-[#6B5C32]">
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>{OLD_SO_SAFE_BANNER}</span>
              </div>
              <div>
                <label className="block text-xs text-[#6B7280] mb-1">Effective from *</label>
                <input
                  type="date"
                  value={bulkEffectiveFrom}
                  onChange={(e) => setBulkEffectiveFrom(e.target.value)}
                  className="w-full border border-[#E2DDD8] rounded px-2 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none"
                />
                <p className="text-[10px] text-[#9CA3AF] mt-1">
                  Past dates allowed (backfill / corrections); future dates show a Pending badge until they take effect.
                </p>
              </div>
              <div>
                <label className="block text-xs text-[#6B7280] mb-1">Notes (optional)</label>
                <input
                  type="text"
                  value={bulkNotes}
                  onChange={(e) => setBulkNotes(e.target.value)}
                  placeholder="e.g. Q3 contract renewal"
                  className="w-full border border-[#E2DDD8] rounded px-2 py-1.5 text-sm focus:border-[#6B5C32] focus:outline-none"
                />
              </div>
              <div className="text-xs text-[#6B7280] bg-[#F9FAFB] border border-[#E2DDD8] rounded px-3 py-2 max-h-40 overflow-y-auto">
                <p className="font-medium text-[#374151] mb-1">
                  Affecting {dirtyEdits.size} SKU{dirtyEdits.size === 1 ? "" : "s"}:
                </p>
                <ul className="list-disc list-inside space-y-0.5">
                  {Array.from(dirtyEdits.values()).slice(0, 8).map((d) => {
                    const cur = rows.find((r) => r.id === d.customerProductId);
                    return (
                      <li key={d.customerProductId} className="truncate">
                        {cur ? `${cur.productCode} — ${cur.productName}` : d.customerProductId}
                      </li>
                    );
                  })}
                  {dirtyEdits.size > 8 && (
                    <li className="text-[#9CA3AF]">…and {dirtyEdits.size - 8} more</li>
                  )}
                </ul>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2DDD8]">
              <button
                onClick={() => !bulkSaving && setShowBulkSaveDialog(false)}
                disabled={bulkSaving}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-white text-[#6B7280] border border-[#E2DDD8] hover:bg-[#F3F4F6] disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void bulkSave()}
                disabled={bulkSaving || dirtyEdits.size === 0}
                className="px-3 py-1.5 rounded-md text-xs font-medium bg-[#6B5C32] text-white hover:bg-[#5A4E2A] disabled:opacity-50"
              >
                {bulkSaving
                  ? "Saving…"
                  : `Save ${dirtyEdits.size} change${dirtyEdits.size === 1 ? "" : "s"}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

// =====================================================================
// Customer Maintenance Panel — per-customer snapshot of variants config.
//
// Master "Maintenance" lives at kv_config['variants-config'] and contains
// surcharge prices for Divan Heights / Total Heights / Gaps / Leg Heights /
// Specials / Sofa Sizes / Sofa Leg Heights / Sofa Specials, plus a Fabrics
// price-tier list (PRICE_1 / PRICE_2 / PRICE_3). Each customer keeps their
// OWN copy of this blob keyed kv_config['variants-config:<customerId>'] —
// snapshotted at customer setup; from then on master changes don't flow
// through automatically.
//
// UX mirrors src/pages/products/index.tsx MaintenanceView:
//   - Tabbed view (BEDFRAME: Divan / Total / Gaps / Leg / Specials,
//     SOFA: Sizes / Leg / Specials, COMMON: Fabrics)
//   - Editable surcharge price (RM input) + delete button per row
//   - Add row form per tab
//   - "Copy from Master Maintenance" CTA when customer not yet seeded
//   - Save button persists the full blob to kv_config:variants-config:<id>
// =====================================================================
type CustMaintPriced = { value: string; priceSen: number };
type CustMaintConfig = {
  divanHeights: CustMaintPriced[];
  legHeights: CustMaintPriced[];
  totalHeights: CustMaintPriced[];
  gaps: string[];
  specials: CustMaintPriced[];
  sofaLegHeights: CustMaintPriced[];
  sofaSpecials: CustMaintPriced[];
  sofaSizes: string[];
  // Fabrics live in /api/fabric-tracking, not in the variants-config blob —
  // but we still expose a Fabrics tab on the customer panel for completeness
  // (read-only here; real fabric-tier edits stay on master Maintenance).
};

type CustMaintListKey =
  | "divanHeights"
  | "totalHeights"
  | "gaps"
  | "legHeights"
  | "specials"
  | "sofaSizes"
  | "sofaLegHeights"
  | "sofaSpecials";
type CustMaintTab = CustMaintListKey | "fabrics";

const CUST_MAINT_TABS: {
  key: CustMaintTab;
  label: string;
  description: string;
  priced?: boolean;
  section?: string;
}[] = [
  { key: "divanHeights", label: "Divan Heights", description: "Bedframe divan height surcharges", priced: true, section: "Bedframe" },
  { key: "totalHeights", label: "Total Heights", description: "Bedframe total height surcharges", priced: true, section: "Bedframe" },
  { key: "gaps", label: "Gaps", description: "Bedframe gap height options", section: "Bedframe" },
  { key: "legHeights", label: "Leg Heights", description: "Bedframe leg height surcharges", priced: true, section: "Bedframe" },
  { key: "specials", label: "Specials", description: "Bedframe special order surcharges", priced: true, section: "Bedframe" },
  { key: "sofaSizes", label: "Sizes", description: "Sofa seat heights", section: "Sofa" },
  { key: "sofaLegHeights", label: "Leg Heights", description: "Sofa leg height surcharges", priced: true, section: "Sofa" },
  { key: "sofaSpecials", label: "Specials", description: "Sofa special order surcharges", priced: true, section: "Sofa" },
  { key: "fabrics", label: "Fabrics", description: "Fabric price-tier assignments (read-only here — manage via master Maintenance)", section: "Common" },
];

function ensureCustMaintPriced(val: unknown): CustMaintPriced[] {
  if (!Array.isArray(val)) return [];
  if (val.length === 0) return [];
  if (typeof val[0] === "string") {
    return (val as string[]).map((v) => ({ value: v, priceSen: 0 }));
  }
  // Coerce { value, priceSen } shape, dropping unrecognised fields.
  return (val as unknown[]).map((row) => {
    if (typeof row !== "object" || !row) return { value: "", priceSen: 0 };
    const r = row as Record<string, unknown>;
    return {
      value: typeof r.value === "string" ? r.value : "",
      priceSen: typeof r.priceSen === "number" ? r.priceSen : 0,
    };
  }).filter((r) => r.value !== "");
}

function ensureCustMaintStrings(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return (val as unknown[]).filter((v) => typeof v === "string") as string[];
}

function parseCustMaintConfig(blob: unknown): CustMaintConfig {
  const empty: CustMaintConfig = {
    divanHeights: [], legHeights: [], totalHeights: [],
    gaps: [], specials: [], sofaLegHeights: [], sofaSpecials: [], sofaSizes: [],
  };
  if (!blob || typeof blob !== "object") return empty;
  const b = blob as Record<string, unknown>;
  return {
    divanHeights: ensureCustMaintPriced(b.divanHeights),
    legHeights: ensureCustMaintPriced(b.legHeights),
    totalHeights: ensureCustMaintPriced(b.totalHeights),
    gaps: ensureCustMaintStrings(b.gaps),
    specials: ensureCustMaintPriced(b.specials),
    sofaLegHeights: ensureCustMaintPriced(b.sofaLegHeights),
    sofaSpecials: ensureCustMaintPriced(b.sofaSpecials),
    sofaSizes: ensureCustMaintStrings(b.sofaSizes),
  };
}

type CustFabricRow = {
  id: string;
  fabricCode: string;
  fabricDescription: string;
  fabricCategory: string;
  priceTier?: "PRICE_1" | "PRICE_2";
  soh: number;
};

function CustomerMaintenancePanel({ customerId, customerName }: { customerId: string; customerName: string }) {
  const { confirm } = useConfirm();
  // Loaded blob from /api/kv-config/variants-config:<customerId>. null = not
  // yet hydrated; "missing" sentinel via `seeded` flag tells us whether the
  // customer has had Copy from Master run.
  const [seeded, setSeeded] = useState<boolean | null>(null);
  // savedConfig = last persisted snapshot. config = the editable working
  // copy. They diverge only inside edit mode; outside edit mode the inline
  // RM inputs render as read-only text.
  const [savedConfig, setSavedConfig] = useState<CustMaintConfig | null>(null);
  const [config, setConfig] = useState<CustMaintConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<CustMaintTab>("divanHeights");
  const [newValue, setNewValue] = useState("");
  const [newPriceSen, setNewPriceSen] = useState(0);
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [fabrics, setFabrics] = useState<CustFabricRow[]>([]);
  const [fabricsLoading, setFabricsLoading] = useState(false);
  const [fabricSearch, setFabricSearch] = useState("");
  const [copying, setCopying] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string>("");
  // Collapsed by default — operator can expand the panel they want to inspect.
  const [collapsed, setCollapsed] = useState(true);
  // Edit / Save / Cancel mode — mirrors SKU Master + master Maintenance.
  const [editMode, setEditMode] = useState(false);
  // Effective-dated history workflow. The dual-write to
  // kv_config('variants-config:<id>') is now triggered INSIDE the save flow
  // when effectiveFrom <= today (so live readers stay current); it is no
  // longer fired on every keystroke.
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showHistoryDialog, setShowHistoryDialog] = useState(false);
  // Per-row item history.
  const [historyList, setHistoryList] = useState<MaintenanceHistoryRow[]>([]);
  const [itemHistoryFor, setItemHistoryFor] = useState<{ key: PricedItemKey; value: string; label: string } | null>(null);

  const customerKey = `variants-config:${customerId}`;
  const scope = `customer:${customerId}`;

  // Mount-time hydrate from D1.
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot fetch on customer change */
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErrorMsg("");
    fetch(`/api/kv-config/${encodeURIComponent(customerKey)}`)
      .then((r) => r.json() as Promise<{ success?: boolean; data?: unknown }>)
      .then((j) => {
        if (cancelled) return;
        if (j?.success && j.data) {
          const cfg = parseCustMaintConfig(j.data);
          setConfig(cfg);
          setSavedConfig(cfg);
          setSeeded(true);
        } else {
          // No customer-keyed blob yet — show the "not seeded" CTA.
          setSeeded(false);
          setConfig(null);
          setSavedConfig(null);
        }
      })
      .catch(() => {
        if (cancelled) return;
        setErrorMsg("Failed to load customer maintenance");
        setSeeded(false);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [customerKey]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Load fabrics when fabrics tab opens (read-only mirror of master).
  /* eslint-disable react-hooks/set-state-in-effect -- lazy load on tab switch */
  useEffect(() => {
    if (tab !== "fabrics") return;
    if (fabrics.length > 0) return;
    setFabricsLoading(true);
    fetch("/api/fabric-tracking")
      .then((r) => r.json() as Promise<{ data?: CustFabricRow[] }>)
      .then((j) => {
        setFabrics(j?.data ?? []);
      })
      .catch(() => {})
      .finally(() => setFabricsLoading(false));
  }, [tab, fabrics.length]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const isDirty = useMemo(
    () => config != null && JSON.stringify(config) !== JSON.stringify(savedConfig),
    [config, savedConfig],
  );
  // Warn before leaving (browser close + in-app nav) with unsaved config edits
  // — owner's "切頁也提醒". Single guard on this route, no useBlocker conflict.
  useNavGuard(editMode && isDirty, "You have unsaved customer settings. Leave without saving?");

  const meta = CUST_MAINT_TABS.find((t) => t.key === tab)!;
  const isFabricsTab = tab === "fabrics";
  const isPricedTab = !isFabricsTab && (meta.priced ?? false);
  const currentStringList: string[] = !isFabricsTab && !isPricedTab && config
    ? (config[tab as CustMaintListKey] as string[])
    : [];
  const currentPricedList: CustMaintPriced[] = !isFabricsTab && isPricedTab && config
    ? (config[tab as CustMaintListKey] as CustMaintPriced[])
    : [];

  const handleCopyFromMaster = async () => {
    if (!(await confirm({
      title: "Copy from Master?",
      message:
        `Copy current Master Maintenance values to "${customerName}"?\n\n` +
        `This will create a customer-specific snapshot. Future master changes will NOT flow through; you'll edit ${customerName}'s prices independently from this point on.`,
    }))) return;
    setCopying(true);
    setErrorMsg("");
    try {
      const res = await fetch(
        `/api/customer-maintenance/${encodeURIComponent(customerId)}/copy-from-master`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErrorMsg(humanizeError({ status: res.status, message: (j as { error?: string })?.error }, "Copy failed. Please try again."));
        return;
      }
      // Re-fetch the just-seeded blob so the panel re-renders with content.
      const refetch = await fetch(`/api/kv-config/${encodeURIComponent(customerKey)}`);
      const rj = await refetch.json() as { success?: boolean; data?: unknown };
      if (rj?.success && rj.data) {
        const cfg = parseCustMaintConfig(rj.data);
        setConfig(cfg);
        setSavedConfig(cfg);
        setSeeded(true);
      }
    } catch (e) {
      setErrorMsg(humanizeError(e, "Network problem — please try again."));
    } finally {
      setCopying(false);
    }
  };

  const handleSaveClick = () => {
    if (!config) return;
    if (!isDirty) {
      // Nothing to commit — just exit edit mode quietly.
      setEditMode(false);
      return;
    }
    setShowSaveModal(true);
  };

  const handleCancel = async () => {
    if (
      isDirty &&
      !(await confirm({
        title: "Discard unsaved edits?",
        message: "Discard your unsaved Maintenance edits?",
        danger: true,
      }))
    ) {
      return;
    }
    setConfig(savedConfig);
    setEditMode(false);
    setEditingIdx(null);
    setEditingValue("");
    setNewValue("");
    setNewPriceSen(0);
  };

  // Open the per-row item history dialog. One fetch covers every row in the
  // customer's snapshot timeline.
  async function openItemHistory(key: PricedItemKey, value: string, label: string) {
    try {
      const res = await fetch(
        `/api/maintenance-config/history?scope=${encodeURIComponent(scope)}`,
      );
      const j = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        data?: MaintenanceHistoryRow[];
      };
      setHistoryList(j.success && j.data ? j.data : []);
    } catch {
      setHistoryList([]);
    }
    setItemHistoryFor({ key, value, label });
  }

  const addEntry = () => {
    if (!config || isFabricsTab || !editMode) return;
    const v = newValue.trim();
    if (!v) return;
    const k = tab as CustMaintListKey;
    if (isPricedTab) {
      const list = config[k] as CustMaintPriced[];
      if (list.some((o) => o.value === v)) { setNewValue(""); return; }
      setConfig({ ...config, [k]: [...list, { value: v, priceSen: newPriceSen }] });
    } else {
      const list = config[k] as string[];
      if (list.includes(v)) { setNewValue(""); return; }
      setConfig({ ...config, [k]: [...list, v] });
    }
    setNewValue("");
    setNewPriceSen(0);
  };

  const removeEntry = (idx: number) => {
    if (!config || isFabricsTab || !editMode) return;
    const k = tab as CustMaintListKey;
    const list = config[k] as (string | CustMaintPriced)[];
    setConfig({ ...config, [k]: list.filter((_, i) => i !== idx) });
  };

  const updatePrice = (idx: number, priceSen: number) => {
    if (!config || isFabricsTab || !isPricedTab || !editMode) return;
    const k = tab as CustMaintListKey;
    const list = config[k] as CustMaintPriced[];
    setConfig({
      ...config,
      [k]: list.map((o, i) => (i === idx ? { ...o, priceSen } : o)),
    });
  };

  const updateEntryValue = (idx: number, newVal: string) => {
    if (!config || isFabricsTab || !editMode) return;
    if (!newVal.trim()) return;
    const k = tab as CustMaintListKey;
    if (isPricedTab) {
      const list = config[k] as CustMaintPriced[];
      setConfig({
        ...config,
        [k]: list.map((o, i) => (i === idx ? { ...o, value: newVal } : o)),
      });
    } else {
      const list = config[k] as string[];
      setConfig({
        ...config,
        [k]: list.map((o, i) => (i === idx ? newVal : o)),
      });
    }
  };

  const startEditing = (idx: number, currentVal: string) => {
    if (!editMode) return;
    setEditingIdx(idx);
    setEditingValue(currentVal);
  };

  const commitEdit = (idx: number) => {
    updateEntryValue(idx, editingValue);
    setEditingIdx(null);
    setEditingValue("");
  };

  return (
    <Card className="border-[#6B5C32] border-2 mt-4">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="flex items-center gap-2 text-base font-semibold text-[#1F1D1B] hover:text-[#6B5C32] transition-colors"
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4 text-[#6B5C32]" />
            ) : (
              <ChevronDown className="h-4 w-4 text-[#6B5C32]" />
            )}
            <Package className="h-5 w-5 text-[#6B5C32]" />
            {customerName} — Customer Maintenance Config
            {seeded === false && (
              <Badge className="bg-[#FAEFCB] text-[#9C6F1E] border-[#E8D597] text-[10px]">Not seeded</Badge>
            )}
            {seeded === true && (
              <Badge className="bg-[#EEF3E4] text-[#4F7C3A] border-[#C6DBA8] text-[10px]">Snapshot</Badge>
            )}
          </button>
          <div className="flex items-center gap-2 flex-wrap">
            {seeded === true && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowHistoryDialog(true)}
                  title="View effective-dated history of this customer's maintenance config"
                >
                  <History className="h-3.5 w-3.5 mr-1" />
                  View History
                </Button>
                {/* Edit / Save / Cancel — Save opens the effective-date
                    modal. Dual-write to kv_config('variants-config:<id>')
                    happens INSIDE that modal's onSaved handler when the
                    snapshot is effective today. */}
                {!editMode ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditMode(true)}
                    disabled={!config}
                  >
                    <Pencil className="h-3.5 w-3.5 mr-1" />
                    Edit
                  </Button>
                ) : (
                  <>
                    <Button
                      variant={isDirty ? "primary" : "outline"}
                      size="sm"
                      onClick={handleSaveClick}
                      disabled={!config}
                    >
                      <Calendar className="h-3.5 w-3.5 mr-1" />
                      Save
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleCancel}
                    >
                      Cancel
                    </Button>
                  </>
                )}
              </>
            )}
            <Button
              variant={seeded === false ? "primary" : "outline"}
              size="sm"
              onClick={handleCopyFromMaster}
              disabled={copying}
            >
              {copying ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Copy className="h-4 w-4 mr-1" />}
              Copy from Master Maintenance
            </Button>
          </div>
        </div>
        {errorMsg && (
          <p className="text-xs text-[#9A3A2D] mt-2">{errorMsg}</p>
        )}
      </CardHeader>
      {!collapsed && (
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-[#6B5C32]" />
          </div>
        ) : seeded === false || !config ? (
          <div className="text-center py-10 text-sm text-[#6B7280] bg-[#FAF9F7] rounded-md border border-dashed border-[#E2DDD8]">
            <p className="mb-2">{customerName} has no customer-specific Maintenance config yet.</p>
            <p className="text-xs">Click <strong>Copy from Master Maintenance</strong> above to seed a snapshot. After that, edits stay scoped to this customer only.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Tabs header */}
            <div className="flex border-b border-[#E2DDD8] bg-[#FAF9F7] overflow-x-auto items-end -mx-6 px-6">
              {CUST_MAINT_TABS.map((t, i) => {
                const prevSection = i > 0 ? CUST_MAINT_TABS[i - 1].section : undefined;
                const showSectionLabel = t.section && t.section !== prevSection;
                return (
                  <div key={t.key} className="flex items-end">
                    {showSectionLabel && (
                      <div className="flex items-center self-stretch">
                        {i > 0 && <div className="w-px h-6 bg-[#D1D5DB] mx-1 self-center" />}
                        <span className="text-[10px] font-bold uppercase tracking-wider text-[#9CA3AF] px-2 pb-3.5 self-end">
                          {t.section}
                        </span>
                      </div>
                    )}
                    <button
                      onClick={() => { setTab(t.key); setNewValue(""); setNewPriceSen(0); setEditingIdx(null); }}
                      className={`relative px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors ${
                        tab === t.key
                          ? "text-[#6B5C32] bg-white border-b-2 border-[#6B5C32]"
                          : "text-gray-500 hover:text-gray-700 hover:bg-white/50"
                      }`}
                    >
                      {t.label}
                      <span className="ml-1.5 text-[10px] text-gray-400 font-normal">
                        ({(() => {
                          if (t.key === "fabrics") return fabrics.length;
                          const list = config[t.key as CustMaintListKey];
                          return Array.isArray(list) ? list.length : 0;
                        })()})
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>

            <p className="text-xs text-gray-500">{meta.description}</p>

            {isFabricsTab ? (
              /* Fabrics tab — read-only list. Tier edits stay on master Maintenance. */
              <div className="space-y-2">
                <div className="relative">
                  <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-[#9CA3AF]" />
                  <input
                    type="text"
                    placeholder="Search fabrics..."
                    value={fabricSearch}
                    onChange={(e) => setFabricSearch(e.target.value)}
                    className="w-full pl-8 text-sm border border-[#E2DDD8] rounded-md px-3 py-2 bg-[#FAF9F7] focus:outline-none focus:border-[#6B5C32] focus:bg-white"
                  />
                </div>
                {fabricsLoading ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="h-5 w-5 animate-spin text-[#6B5C32]" />
                  </div>
                ) : (
                  <div className="overflow-x-auto border border-[#E2DDD8] rounded-md">
                    <table className="min-w-full divide-y divide-gray-200 text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">Code</th>
                          <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">Description</th>
                          <th className="px-3 py-2 text-left text-xs font-semibold text-gray-600">Category</th>
                          <th className="px-3 py-2 text-center text-xs font-semibold text-gray-600">Price Tier</th>
                          <th className="px-3 py-2 text-right text-xs font-semibold text-gray-600">SOH</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {fabrics
                          .filter((f) => {
                            if (!fabricSearch.trim()) return true;
                            const q = fabricSearch.toLowerCase();
                            return f.fabricCode.toLowerCase().includes(q)
                              || f.fabricDescription.toLowerCase().includes(q);
                          })
                          .map((f) => (
                            <tr key={f.id}>
                              <td className="px-3 py-1.5 font-mono font-medium text-gray-900">{f.fabricCode}</td>
                              <td className="px-3 py-1.5 text-gray-700">{f.fabricDescription}</td>
                              <td className="px-3 py-1.5">
                                <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-gray-100 text-gray-600">
                                  {f.fabricCategory}
                                </span>
                              </td>
                              <td className="px-3 py-1.5 text-center">
                                <span className={`inline-block px-2 py-0.5 rounded text-xs font-semibold border ${
                                  f.priceTier === "PRICE_1"
                                    ? "bg-[#E0EDF0] border-[#A8CAD2] text-[#3E6570]"
                                    : "bg-[#FAEFCB] border-[#E8D597] text-[#9C6F1E]"
                                }`}>
                                  {f.priceTier === "PRICE_1" ? "Price 1" : "Price 2"}
                                </span>
                              </td>
                              <td className="px-3 py-1.5 text-right text-gray-900">{f.soh.toLocaleString()}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ) : (
              <>
                {/* Add row — only visible while editing. */}
                {editMode && (
                  <div className="flex gap-2">
                    <input
                      value={newValue}
                      onChange={(e) => setNewValue(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEntry(); } }}
                      placeholder={`Add new ${meta.label.toLowerCase().replace(/s$/, "")}...`}
                      className="flex-1 text-sm border border-[#E2DDD8] rounded-md px-3 py-1.5 bg-[#FAF9F7] focus:outline-none focus:border-[#6B5C32] focus:bg-white"
                    />
                    {isPricedTab && (
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-gray-500">RM</span>
                        <input
                          type="number" onFocus={(e) => e.currentTarget.select()}
                          step="0.01"
                          value={newPriceSen / 100}
                          onChange={(e) => setNewPriceSen(Math.round(parseFloat(e.target.value || "0") * 100))}
                          className="w-24 text-right text-sm border border-[#E2DDD8] rounded-md px-3 py-1.5 bg-[#FAF9F7] focus:outline-none focus:border-[#6B5C32] focus:bg-white"
                          placeholder="0.00"
                        />
                      </div>
                    )}
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={addEntry}
                      disabled={!newValue.trim()}
                    >
                      <Plus className="h-4 w-4 mr-1" /> Add
                    </Button>
                  </div>
                )}

                {/* List */}
                <div className="space-y-1.5">
                  {isPricedTab ? (
                    currentPricedList.length === 0 ? (
                      <div className="text-center py-6 text-xs text-gray-400 bg-[#FAF9F7] rounded-md border border-dashed border-[#E2DDD8]">
                        No entries yet.
                      </div>
                    ) : (
                      currentPricedList.map((entry, idx) => (
                        <div
                          key={`${tab}-${idx}`}
                          className="flex items-center justify-between px-3 py-1.5 bg-[#FAF9F7] border border-[#E2DDD8] rounded-md hover:bg-white transition-colors group"
                        >
                          <div
                            className={`flex items-center gap-2 flex-1 min-w-0 ${editMode ? "cursor-pointer" : ""}`}
                            onClick={() => { if (editMode && editingIdx !== idx) startEditing(idx, entry.value); }}
                          >
                            {/* Per-row history icon — priced rows only. */}
                            {isPricedItemKey(tab) && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void openItemHistory(tab, entry.value, meta.label);
                                }}
                                className="p-0.5 text-[#9CA3AF] hover:text-[#6B5C32] hover:bg-[#F4F0E8] rounded flex-shrink-0"
                                title="View this item's price history"
                              >
                                <History className="h-3.5 w-3.5" />
                              </button>
                            )}
                            <span className="text-[10px] text-gray-400 font-mono w-6 flex-shrink-0">{idx + 1}</span>
                            {editMode && editingIdx === idx ? (
                              <input
                                autoFocus
                                value={editingValue}
                                onChange={(e) => setEditingValue(e.target.value)}
                                onBlur={() => commitEdit(idx)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") { e.preventDefault(); commitEdit(idx); }
                                  if (e.key === "Escape") { setEditingIdx(null); setEditingValue(""); }
                                }}
                                onClick={(e) => e.stopPropagation()}
                                className="text-sm font-medium border-2 border-[#6B5C32] rounded px-2 py-0.5 bg-[#FAEFCB] focus:outline-none w-48"
                              />
                            ) : (
                              <span className={`text-sm text-[#111827] font-medium ${editMode ? "group-hover:text-[#6B5C32] group-hover:underline" : ""}`}>
                                {entry.value}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 flex-shrink-0">
                            <div className="flex items-center gap-1">
                              <span className="text-xs text-gray-400">RM</span>
                              {editMode ? (
                                <input
                                  type="number" onFocus={(e) => e.currentTarget.select()}
                                  step="0.01"
                                  value={entry.priceSen / 100}
                                  onChange={(e) => updatePrice(idx, Math.round(parseFloat(e.target.value || "0") * 100))}
                                  className="w-20 text-right text-sm border border-[#E2DDD8] rounded px-2 py-1 bg-white focus:outline-none focus:border-[#6B5C32]"
                                />
                              ) : (
                                <span className="w-20 text-right text-sm tabular-nums text-[#111827] font-medium">
                                  {(entry.priceSen / 100).toFixed(2)}
                                </span>
                              )}
                            </div>
                            {editMode && (
                              <button
                                onClick={() => removeEntry(idx)}
                                className="p-1 text-[#9A3A2D] hover:text-[#7A2E24] hover:bg-[#F9E1DA] rounded"
                                title="Remove"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      ))
                    )
                  ) : (
                    currentStringList.length === 0 ? (
                      <div className="text-center py-6 text-xs text-gray-400 bg-[#FAF9F7] rounded-md border border-dashed border-[#E2DDD8]">
                        No entries yet.
                      </div>
                    ) : (
                      currentStringList.map((entry, idx) => (
                        <div
                          key={`${tab}-${idx}`}
                          className="flex items-center justify-between px-3 py-1.5 bg-[#FAF9F7] border border-[#E2DDD8] rounded-md hover:bg-white transition-colors group"
                        >
                          <div
                            className={`flex items-center gap-2 flex-1 min-w-0 ${editMode ? "cursor-pointer" : ""}`}
                            onClick={() => { if (editMode && editingIdx !== idx) startEditing(idx, entry); }}
                          >
                            <span className="text-[10px] text-gray-400 font-mono w-6 flex-shrink-0">{idx + 1}</span>
                            {editMode && editingIdx === idx ? (
                              <input
                                autoFocus
                                value={editingValue}
                                onChange={(e) => setEditingValue(e.target.value)}
                                onBlur={() => commitEdit(idx)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") { e.preventDefault(); commitEdit(idx); }
                                  if (e.key === "Escape") { setEditingIdx(null); setEditingValue(""); }
                                }}
                                onClick={(e) => e.stopPropagation()}
                                className="text-sm font-medium border-2 border-[#6B5C32] rounded px-2 py-0.5 bg-[#FAEFCB] focus:outline-none w-48"
                              />
                            ) : (
                              <span className={`text-sm text-[#111827] font-medium ${editMode ? "group-hover:text-[#6B5C32] group-hover:underline" : ""}`}>
                                {entry}
                              </span>
                            )}
                          </div>
                          {editMode && (
                            <button
                              onClick={() => removeEntry(idx)}
                              className="p-1 text-[#9A3A2D] hover:text-[#7A2E24] hover:bg-[#F9E1DA] rounded"
                              title="Remove"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      ))
                    )
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </CardContent>
      )}

      {/* Effective-date snapshot modal */}
      <MaintenanceConfigSaveModal
        open={showSaveModal}
        scope={scope}
        config={config}
        onClose={() => setShowSaveModal(false)}
        onSaved={async (effectiveFrom) => {
          setShowSaveModal(false);
          // Mirror today-effective snapshots into the legacy
          // kv_config('variants-config:<id>') key so sales/create.tsx etc.
          // see the same values immediately. Future-dated snapshots stay
          // only in the history table until their day arrives.
          const today = new Date().toISOString().slice(0, 10);
          if (config && effectiveFrom <= today) {
            try {
              await fetch(`/api/kv-config/${encodeURIComponent(customerKey)}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(config),
              });
            } catch {
              // Non-fatal — the history row was saved successfully.
            }
          }
          if (config) setSavedConfig(config);
          setEditMode(false);
        }}
      />

      {/* History listing dialog */}
      <MaintenanceConfigHistoryDialog
        open={showHistoryDialog}
        scope={scope}
        title={`${customerName} — Maintenance config history`}
        onClose={() => setShowHistoryDialog(false)}
      />

      {/* Per-row item history dialog — read-only timeline. To schedule a
          new entry the operator clicks Edit on the panel, edits the RM
          input, then Save (which opens the effective-date modal). */}
      {itemHistoryFor && (
        <MaintenanceItemHistoryDialog
          open={itemHistoryFor !== null}
          itemKey={itemHistoryFor.key}
          itemValue={itemHistoryFor.value}
          itemLabel={`${meta.section ? meta.section + " " : ""}${itemHistoryFor.label}`}
          history={historyList}
          onClose={() => setItemHistoryFor(null)}
        />
      )}
    </Card>
  );
}

// =====================================================================
// CustomerSofaCombosPanel — read-only listing of this customer's sofa
// combo rules, plus Copy-from-Master + per-row Delete. The full editor
// (with new-combo dialog, edit, etc.) lives on /maintenance/sofa-combos
// — a "Manage in full editor" link routes there with the customer
// pre-selected via querystring.
// =====================================================================
type CustSofaComboSizes = string[] | string[][];
type CustSofaComboRule = {
  id: string;
  baseModel: string;
  componentSizes: CustSofaComboSizes;
  fabricTier: "ANY" | "PRICE_1" | "PRICE_2" | "PRICE_3";
  pricesByHeight: Record<string, number>;
  customerId: string | null;
  customerName: string | null;
  effectiveFrom: string;
  notes: string;
  createdAt: string;
  createdBy: string | null;
};

// Group key for the per-combo History dialog. Same shape as the
// maintenance/sofa-combos page so a customer's combos collapse into one
// card per (baseModel, componentSizes, fabricTier) tuple. customerId is
// always the panel's own customerId so it's effectively constant here,
// but we include it for symmetry with the maintenance page's logic.
function custComboGroupKey(r: CustSofaComboRule): string {
  return `${r.baseModel}|${JSON.stringify(r.componentSizes)}|${r.fabricTier}|${r.customerId ?? ""}`;
}

function custPickRepresentative(rs: CustSofaComboRule[]): CustSofaComboRule {
  const today = new Date().toISOString().slice(0, 10);
  const sorted = rs.slice().sort((a, b) => {
    if (a.effectiveFrom !== b.effectiveFrom) {
      return b.effectiveFrom.localeCompare(a.effectiveFrom);
    }
    return (b.createdAt ?? "").localeCompare(a.createdAt ?? "");
  });
  for (const r of sorted) {
    if (r.effectiveFrom <= today) return r;
  }
  return sorted[0];
}

type CustComboGroup = {
  key: string;
  rules: CustSofaComboRule[];
  representative: CustSofaComboRule;
  hasActive: boolean;
};

function custGroupByCombo(rules: CustSofaComboRule[]): CustComboGroup[] {
  const today = new Date().toISOString().slice(0, 10);
  const buckets: Record<string, CustSofaComboRule[]> = {};
  for (const r of rules) {
    const k = custComboGroupKey(r);
    if (!buckets[k]) buckets[k] = [];
    buckets[k].push(r);
  }
  const groups: CustComboGroup[] = Object.entries(buckets).map(([key, rs]) => {
    const representative = custPickRepresentative(rs);
    const hasActive = rs.some((r) => r.effectiveFrom <= today);
    return { key, rules: rs, representative, hasActive };
  });
  groups.sort((a, b) => {
    if (a.hasActive !== b.hasActive) return a.hasActive ? -1 : 1;
    if (a.representative.baseModel !== b.representative.baseModel) {
      return a.representative.baseModel.localeCompare(b.representative.baseModel);
    }
    return a.representative.effectiveFrom.localeCompare(b.representative.effectiveFrom);
  });
  return groups;
}

const CUST_SOFA_SEAT_HEIGHTS = ["24", "28", "30", "32", "35"] as const;

function renderCustComponentSizes(sizes: CustSofaComboSizes): string {
  if (!Array.isArray(sizes) || sizes.length === 0) return "—";
  const grouped = Array.isArray(sizes[0]);
  if (!grouped) return (sizes as string[]).join(" + ");
  return (sizes as string[][]).map((g) => g.join(" / ")).join(" + ");
}

function CustomerSofaCombosPanel({ customerId, customerName }: { customerId: string; customerName: string }) {
  const { confirm } = useConfirm();
  const [rules, setRules] = useState<CustSofaComboRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [copying, setCopying] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [collapsed, setCollapsed] = useState(true);
  const [historyKey, setHistoryKey] = useState<string | null>(null);

  const comboGroups = useMemo(() => custGroupByCombo(rules), [rules]);
  const historyRules = useMemo<CustSofaComboRule[] | null>(() => {
    if (!historyKey) return null;
    const matching = rules.filter((r) => custComboGroupKey(r) === historyKey);
    // Dedup by (effectiveFrom + pricesJson). When the API returns
    // includeApplicableMaster=true the customer's own row + the master
    // row for the same (combo, tier) at the same date+price both land
    // in the timeline; collapse them. Prefer the customer-scoped row
    // (real ownership) over the master fallback when both exist.
    const sortedKeys = (p: Record<string, number>) =>
      JSON.stringify(
        Object.keys(p).sort().reduce<Record<string, number>>((acc, k) => {
          acc[k] = p[k];
          return acc;
        }, {}),
      );
    const seen = new Map<string, CustSofaComboRule>();
    for (const r of matching) {
      const key = `${r.effectiveFrom}|${sortedKeys(r.pricesByHeight)}`;
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, r);
      } else if (!existing.customerId && r.customerId) {
        // Replace master with customer-scoped row when both exist.
        seen.set(key, r);
      }
    }
    return Array.from(seen.values());
  }, [rules, historyKey]);

  const reload = () => {
    setLoading(true);
    setErrorMsg("");
    fetch(
      `/api/sofa-combos?customerId=${encodeURIComponent(customerId)}&includeApplicableMaster=true`,
    )
      .then((r) => r.json() as Promise<{ success?: boolean; data?: CustSofaComboRule[] }>)
      .then((j) => {
        if (j?.success) setRules(j.data ?? []);
        else setRules([]);
      })
      .catch(() => setErrorMsg("Failed to load sofa combos"))
      .finally(() => setLoading(false));
  };

  /* eslint-disable react-hooks/set-state-in-effect -- one-shot fetch on customer change */
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleCopyFromMaster = async () => {
    if (!(await confirm({
      title: "Copy Sofa Combos?",
      message:
        `Copy company-wide Sofa Combos to "${customerName}"?\n\n` +
        `This snapshots the latest master rules into customer-specific copies. ` +
        `Already-snapshotted rules are skipped (re-running is safe).`,
    }))) return;
    setCopying(true);
    setErrorMsg("");
    try {
      const res = await fetch("/api/sofa-combos/copy-from-master", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setErrorMsg(humanizeError({ status: res.status, message: (j as { error?: string })?.error }, "Copy failed. Please try again."));
        return;
      }
      reload();
      // Cross-page freshness (2026-07-04 cache sweep): the maintenance Sofa
      // Combos page reads the same prefix through the localStorage cache.
      invalidateCachePrefix("/api/sofa-combos");
    } finally {
      setCopying(false);
    }
  };

  const handleDelete = async (rule: CustSofaComboRule) => {
    if (!(await confirm({
      title: "Delete combo?",
      message: `Delete combo "${rule.baseModel} — ${renderCustComponentSizes(rule.componentSizes)}"?`,
      danger: true,
    }))) return;
    const res = await fetch(`/api/sofa-combos/${rule.id}`, { method: "DELETE" });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setErrorMsg(humanizeError({ status: res.status, message: (j as { error?: string })?.error }, "Delete failed. Please try again."));
      return;
    }
    reload();
    invalidateCachePrefix("/api/sofa-combos");
  };

  return (
    <Card className="border-[#6B5C32] border-2 mt-4">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="flex items-center gap-2 text-base font-semibold text-[#1F1D1B] hover:text-[#6B5C32] transition-colors"
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4 text-[#6B5C32]" />
            ) : (
              <ChevronDown className="h-4 w-4 text-[#6B5C32]" />
            )}
            <Package className="h-5 w-5 text-[#6B5C32]" />
            Sofa Combos — {customerName} ({comboGroups.length})
          </button>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              disabled={copying}
              onClick={handleCopyFromMaster}
            >
              {copying ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Copy className="h-4 w-4 mr-1" />
              )}
              Copy from Master
            </Button>
            <a
              href="/maintenance/sofa-combos"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium bg-white text-[#6B7280] border border-[#E2DDD8] hover:bg-[#F3F4F6] transition-colors"
            >
              Open Full Editor →
            </a>
          </div>
        </div>
      </CardHeader>
      {!collapsed && (
      <CardContent>
        {errorMsg && (
          <div className="mb-3 rounded-md border border-[#E8B2A1] bg-[#F9E1DA] px-3 py-2 text-sm text-[#9A3A2D]">
            {errorMsg}
          </div>
        )}
        {loading ? (
          <p className="text-sm text-[#9CA3AF] py-4 text-center">Loading...</p>
        ) : rules.length === 0 ? (
          <div className="py-8 text-center space-y-3">
            <p className="text-sm text-[#9CA3AF]">
              No customer-specific sofa combos yet.
            </p>
            <p className="text-xs text-[#9CA3AF]">
              Click <b>Copy from Master</b> to snapshot the company-wide combo
              rules into customer-specific copies that you can edit independently.
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-[#E2DDD8] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-[#E2DDD8] text-sm">
                <thead className="bg-[#F9FAFB]">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold text-[#6B7280]">Base</th>
                    <th className="px-3 py-2 text-left font-semibold text-[#6B7280]">Components</th>
                    <th className="px-3 py-2 text-left font-semibold text-[#6B7280]">Tier</th>
                    {CUST_SOFA_SEAT_HEIGHTS.map((h) => (
                      <th key={h} className="px-3 py-2 text-right font-semibold text-[#6B7280]">
                        {h}″
                      </th>
                    ))}
                    <th className="px-3 py-2 text-left font-semibold text-[#6B7280]">Effective</th>
                    <th className="px-3 py-2 text-right font-semibold text-[#6B7280]">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F3F4F6]">
                  {comboGroups.map((g) => {
                    const r = g.representative;
                    const isPending = r.effectiveFrom > new Date().toISOString().slice(0, 10);
                    return (
                      <tr key={g.key} className="hover:bg-[#FAF9F7]">
                        <td className="px-3 py-2 font-mono text-[#1F1D1B]">{r.baseModel}</td>
                        <td className="px-3 py-2 text-[#374151]">
                          {renderCustComponentSizes(r.componentSizes)}
                        </td>
                        <td className="px-3 py-2">
                          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-[#F0ECE9] text-[#4B5563] border border-[#E2DDD8]">
                            {r.fabricTier}
                          </span>
                        </td>
                        {CUST_SOFA_SEAT_HEIGHTS.map((h) => (
                          <td key={h} className="px-3 py-2 text-right text-[#374151]">
                            {r.pricesByHeight[h] != null ? formatRM(r.pricesByHeight[h]) : "—"}
                          </td>
                        ))}
                        <td className="px-3 py-2 text-[#6B7280]">
                          {r.effectiveFrom}
                          {isPending && (
                            <span className="ml-2 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-[#FAEFCB] text-[#9C6F1E] border border-[#E8D597]">
                              Pending
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="inline-flex items-center gap-1">
                            <button
                              onClick={() => setHistoryKey(g.key)}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-[#6B5C32] text-white hover:bg-[#5A4E2A] transition-colors"
                              title="Schedule a new effective-dated price (or view full history)"
                            >
                              <Pencil className="h-3 w-3" />
                              Edit
                            </button>
                            <button
                              onClick={() => setHistoryKey(g.key)}
                              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium bg-white text-[#6B5C32] border border-[#D4CCB4] hover:bg-[#F4F0E8] transition-colors"
                              title="View this combo's full effective-dated history"
                            >
                              <History className="h-3 w-3" />
                              History (
                                {
                                  // Count unique (date, prices) tuples
                                  // — matches what the dedup'd dialog
                                  // will render. Same logic as the
                                  // master sofa-combos page card count.
                                  new Set(
                                    g.rules.map(
                                      (r) =>
                                        `${r.effectiveFrom}|${JSON.stringify(
                                          Object.keys(r.pricesByHeight)
                                            .sort()
                                            .reduce<Record<string, number>>(
                                              (acc, k) => {
                                                acc[k] = r.pricesByHeight[k];
                                                return acc;
                                              },
                                              {},
                                            ),
                                        )}`,
                                    ),
                                  ).size
                                }
                                )
                            </button>
                            <button
                              onClick={() => handleDelete(r)}
                              className="p-1 rounded hover:bg-[#FBE0DC] text-[#9A3A2D]"
                              title="Delete combo"
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
      )}
      {historyRules && historyRules.length > 0 && (
        <SofaComboHistoryDialog
          rules={historyRules as unknown as SofaComboHistoryRule[]}
          onClose={() => setHistoryKey(null)}
          refresh={reload}
        />
      )}
    </Card>
  );
}

// =====================================================================
// CustomerPriceHistoryDialog — per-customer-per-product price history
// + new effective-dated row form. Mirrors MasterPriceHistoryDialog but
// hits /api/customer-products/:cpId/price-history and
// /api/customer-products/:cpId/prices.
// =====================================================================
function CustomerPriceHistoryDialog({
  cp,
  onClose,
  onChanged,
}: {
  cp: CustomerProduct;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const [history, setHistory] = useState<PriceHistoryRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const todayIso = () => new Date().toISOString().slice(0, 10);
  const daysUntil = (iso: string): number => {
    const t = new Date(todayIso() + "T00:00:00Z").getTime();
    const d = new Date(iso + "T00:00:00Z").getTime();
    return Math.round((d - t) / 86400000);
  };
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [baseRm, setBaseRm] = useState((cp.basePriceSen / 100).toFixed(2));
  const [price1Rm, setPrice1Rm] = useState(
    cp.price1Sen != null ? (cp.price1Sen / 100).toFixed(2) : "",
  );
  const [notes, setNotes] = useState("");

  const isSofa = cp.category === "SOFA";

  // Sofa price matrix: 5 heights × 3 fabric tiers. Stored here as RM-string
  // inputs (so blank = "no price for this cell" instead of "RM 0"). Save
  // builds the sparse seatHeightPrices array from the non-blank cells.
  const SOFA_HEIGHTS = ["24", "28", "30", "32", "35"] as const;
  const SOFA_TIERS = ["PRICE_1", "PRICE_2", "PRICE_3"] as const;
  type CustSofaTier = (typeof SOFA_TIERS)[number];
  type CustSofaHeight = (typeof SOFA_HEIGHTS)[number];
  const blankGrid = (): Record<CustSofaHeight, Record<CustSofaTier, string>> => {
    const out: Record<string, Record<string, string>> = {};
    for (const h of SOFA_HEIGHTS) {
      out[h] = { PRICE_1: "", PRICE_2: "", PRICE_3: "" };
    }
    return out as Record<CustSofaHeight, Record<CustSofaTier, string>>;
  };

  // Seed the editor grid from the customer-product's existing
  // seatHeightPrices so "schedule a price hike" is one date-pick + edit
  // away. Legacy entries without a tier default to PRICE_2.
  const seedGridFromCp = (
    rows: SeatHeightEntry[] | null | undefined,
  ): Record<CustSofaHeight, Record<CustSofaTier, string>> => {
    const g = blankGrid();
    if (!rows) return g;
    const norm = (v: string) => String(v ?? "").replace('"', "").trim();
    for (const r of rows) {
      const h = norm(r.height) as CustSofaHeight;
      if (!SOFA_HEIGHTS.includes(h)) continue;
      const t = (r.tier ?? "PRICE_2") as CustSofaTier;
      if (!SOFA_TIERS.includes(t)) continue;
      g[h][t] = (r.priceSen / 100).toFixed(2);
    }
    return g;
  };

  const [seatGrid, setSeatGrid] = useState<
    Record<CustSofaHeight, Record<CustSofaTier, string>>
  >(() => seedGridFromCp(cp.seatHeightPrices));

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/customer-products/${cp.id}/price-history`);
      const j = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        data?: PriceHistoryRow[];
      };
      setHistory(j.success ? j.data ?? [] : []);
    } finally {
      setLoading(false);
    }
  };

  // load() flips loading + history setters; the dialog opens on a
  // user-driven prop change (cp.id), not a tight render loop, so the
  // cascading-render concern react-hooks/set-state-in-effect warns about
  // doesn't apply here. Same pattern as MasterPriceHistoryDialog.
  /* eslint-disable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */
  useEffect(() => { void load(); }, [cp.id]);
  /* eslint-enable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

  // ESC closes the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
      toast.error("Effective From date is required (YYYY-MM-DD).");
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = { effectiveFrom };
      body.basePriceSen = baseRm.trim() === "" ? null : Math.round(Number(baseRm) * 100);
      body.price1Sen = price1Rm.trim() === "" ? null : Math.round(Number(price1Rm) * 100);
      if (isSofa) {
        // Build sparse seatHeightPrices from the grid. Each non-blank cell
        // becomes one entry; blank cells are omitted so the resolver
        // falls back to whatever was previously effective for that
        // (height, tier) pair.
        const rows: { height: string; priceSen: number; tier: CustSofaTier }[] = [];
        for (const h of SOFA_HEIGHTS) {
          for (const t of SOFA_TIERS) {
            const raw = (seatGrid[h]?.[t] ?? "").trim();
            if (!raw) continue;
            const num = Number(raw);
            if (!Number.isFinite(num) || num < 0) {
              toast.error(`Invalid price for ${h}" ${t}: must be a non-negative number.`);
              setSaving(false);
              return;
            }
            rows.push({ height: h, priceSen: Math.round(num * 100), tier: t });
          }
        }
        body.seatHeightPrices = rows.length > 0 ? rows : null;
      } else {
        body.seatHeightPrices = null;
      }
      body.notes = notes || null;
      const res = await fetch(`/api/customer-products/${cp.id}/prices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast.error((j as { error?: string }).error || `Failed to save (HTTP ${res.status})`);
        return;
      }
      onChanged();
      void load();
      setNotes("");
    } finally {
      setSaving(false);
    }
  };

  const deleteRow = async (rowId: string) => {
    if (!(await confirm({ title: "Delete price entry?", message: "Delete this price history entry?", danger: true }))) return;
    const res = await fetch(`/api/customer-products/price-row/${rowId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      toast.error((j as { error?: string }).error || `Failed to delete (HTTP ${res.status})`);
      return;
    }
    onChanged();
    void load();
  };

  const today = todayIso();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl flex flex-col w-[80vw] h-[85vh] max-w-4xl mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
          <div>
            <h2 className="text-lg font-semibold text-[#1F1D1B]">
              Customer Price History — {cp.productCode}
            </h2>
            <p className="text-xs text-[#6B7280] mt-0.5">{cp.productName}</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[#E2DDD8]" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {/* ===== New scheduled change ===== */}
          <section>
            <h3 className="text-sm font-medium text-[#1F1D1B] mb-3">
              New scheduled change
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-[#6B7280] mb-1">
                  Effective from *
                </label>
                <Input
                  type="date"
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                  className="h-8"
                />
                <p className="text-[10px] text-[#9CA3AF] mt-1">
                  Past dates are allowed — backfill historical prices or
                  back-date a correction here.
                </p>
              </div>
              <div>
                <label className="block text-xs text-[#6B7280] mb-1">
                  Notes
                </label>
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  placeholder="e.g. Q3 price hike"
                  className="h-8"
                />
              </div>
              {!isSofa && (
                <>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">
                      Price 2 (RM)
                    </label>
                    <Input
                      type="number" onFocus={(e) => e.currentTarget.select()}
                      step="0.01"
                      value={baseRm}
                      onChange={(e) => setBaseRm(e.target.value)}
                      className="h-8 text-right"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">
                      Price 1 (RM)
                    </label>
                    <Input
                      type="number" onFocus={(e) => e.currentTarget.select()}
                      step="0.01"
                      value={price1Rm}
                      onChange={(e) => setPrice1Rm(e.target.value)}
                      className="h-8 text-right"
                    />
                  </div>
                </>
              )}
              {isSofa && (
                <div className="sm:col-span-2">
                  <label className="block text-xs text-[#6B7280] mb-2">
                    Seat-height × fabric tier (RM)
                  </label>
                  <p className="text-[10px] text-[#9CA3AF] mb-2">
                    Leave a cell blank to keep the previously-effective price
                    for that (height × tier). Filled cells become the new
                    price from {effectiveFrom} onwards.
                  </p>
                  <div className="overflow-x-auto">
                    <table className="text-xs border-collapse">
                      <thead>
                        <tr>
                          <th className="px-2 py-1.5 text-left text-[#6B7280] font-medium">
                            Height
                          </th>
                          {SOFA_TIERS.map((t) => (
                            <th
                              key={t}
                              className="px-2 py-1.5 text-right text-[#6B7280] font-medium"
                            >
                              {t === "PRICE_1"
                                ? "P1"
                                : t === "PRICE_2"
                                  ? "P2"
                                  : "P3"}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {SOFA_HEIGHTS.map((h) => (
                          <tr key={h}>
                            <td className="px-2 py-1 text-[#1F1D1B] font-medium">
                              {h}&quot;
                            </td>
                            {SOFA_TIERS.map((t) => (
                              <td key={t} className="px-1 py-1">
                                <Input
                                  type="number" onFocus={(e) => e.currentTarget.select()}
                                  step="0.01"
                                  value={seatGrid[h]?.[t] ?? ""}
                                  onChange={(e) =>
                                    setSeatGrid((g) => ({
                                      ...g,
                                      [h]: { ...g[h], [t]: e.target.value },
                                    }))
                                  }
                                  className="h-8 text-right w-24"
                                  placeholder="—"
                                />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
            <div className="mt-3 flex justify-end">
              <Button variant="primary" size="sm" disabled={saving} onClick={save}>
                {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
                Schedule
              </Button>
            </div>
          </section>

          {/* ===== History table ===== */}
          <section>
            <h3 className="text-sm font-medium text-[#1F1D1B] mb-3">
              Price history ({history.length})
            </h3>
            {loading ? (
              <p className="text-sm text-[#9CA3AF] py-6 text-center">
                Loading…
              </p>
            ) : history.length === 0 ? (
              <p className="text-sm text-[#9CA3AF] py-6 text-center">
                No scheduled or past price changes yet. The current displayed
                price comes from the customer-product record.
              </p>
            ) : (
              <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-[#6B7280]">
                  <tr className="border-b border-[#E2DDD8]">
                    <th className="text-left py-2 px-2">Effective from</th>
                    <th className="text-right py-2 px-2">Price 2</th>
                    <th className="text-right py-2 px-2">Price 1</th>
                    <th className="text-left py-2 px-2">Seat tiers</th>
                    <th className="text-left py-2 px-2">Notes</th>
                    <th className="text-right py-2 px-2">Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {/* Active = newest row whose effectiveFrom <= today; we
                      compute its id once per render so the badge column can
                      cheaply mark it. Pending = future-dated. Past = older
                      than the active row. */}
                  {(() => {
                    const activeId = (() => {
                      const past = history.filter((r) => r.effectiveFrom <= today);
                      if (past.length === 0) return null;
                      return past.reduce((a, b) =>
                        a.effectiveFrom >= b.effectiveFrom ? a : b,
                      ).id;
                    })();
                    return history.map((h) => {
                      const pending = h.effectiveFrom > today;
                      const days = daysUntil(h.effectiveFrom);
                      const isActive = h.id === activeId;
                      return (
                        <tr key={h.id} className="border-b border-[#F0EEEA]">
                          <td className="py-1.5 px-2 doc-number">
                            {h.effectiveFrom}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums">
                            {h.basePriceSen != null
                              ? formatCurrency(h.basePriceSen)
                              : "—"}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums">
                            {h.price1Sen != null
                              ? formatCurrency(h.price1Sen)
                              : "—"}
                          </td>
                          <td className="py-1.5 px-2 text-[#6B7280] align-top">
                            {h.seatHeightPrices && h.seatHeightPrices.length > 0 ? (
                              (() => {
                                // Build a {height -> {tier -> priceSen}}
                                // lookup so we can render the same 5×3 grid
                                // as the editor form above. Legacy entries
                                // (no tier) collapse into the P2 column to
                                // match every reader's fallback behavior.
                                const lookup: Record<
                                  string,
                                  Record<"PRICE_1" | "PRICE_2" | "PRICE_3", number | null>
                                > = {};
                                for (const h2 of SOFA_HEIGHTS) {
                                  lookup[h2] = {
                                    PRICE_1: null,
                                    PRICE_2: null,
                                    PRICE_3: null,
                                  };
                                }
                                for (const r of h.seatHeightPrices) {
                                  const key = String(r.height ?? "")
                                    .replace('"', "")
                                    .trim();
                                  if (!lookup[key]) continue;
                                  const tier = (r.tier ?? "PRICE_2") as
                                    | "PRICE_1"
                                    | "PRICE_2"
                                    | "PRICE_3";
                                  lookup[key][tier] = r.priceSen;
                                }
                                return (
                                  <table className="text-[10px] tabular-nums border-collapse">
                                    <thead>
                                      <tr className="text-[#9CA3AF]">
                                        <th className="px-1 py-0 font-normal" />
                                        <th className="px-1 py-0 text-right font-normal">
                                          P1
                                        </th>
                                        <th className="px-1 py-0 text-right font-normal">
                                          P2
                                        </th>
                                        <th className="px-1 py-0 text-right font-normal">
                                          P3
                                        </th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {SOFA_HEIGHTS.map((hh) => (
                                        <tr key={hh}>
                                          <td className="px-1 py-0 text-[#1F1D1B] font-medium">
                                            {hh}&Prime;
                                          </td>
                                          {(
                                            [
                                              "PRICE_1",
                                              "PRICE_2",
                                              "PRICE_3",
                                            ] as const
                                          ).map((tt) => {
                                            const v = lookup[hh]?.[tt];
                                            return (
                                              <td
                                                key={tt}
                                                className="px-1 py-0 text-right"
                                              >
                                                {v != null ? (
                                                  <span className="text-[#1F1D1B]">
                                                    {(v / 100).toFixed(0)}
                                                  </span>
                                                ) : (
                                                  <span className="text-[#D1D5DB]">
                                                    —
                                                  </span>
                                                )}
                                              </td>
                                            );
                                          })}
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                );
                              })()
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="py-1.5 px-2 text-[#6B7280]">
                            {h.notes || "—"}
                          </td>
                          <td className="py-1.5 px-2 text-right">
                            {pending ? (
                              <span
                                className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${
                                  days <= 3
                                    ? "bg-[#FBE0DC] text-[#9A3A2D] border-[#E8B2A1]"
                                    : days <= 14
                                      ? "bg-[#FBE4CE] text-[#B8601A] border-[#E8B786]"
                                      : "bg-[#F4F0E8] text-[#6B5C32] border-[#D4CCB4]"
                                }`}
                                title={`Becomes effective on ${h.effectiveFrom}`}
                              >
                                Pending · {days}d
                              </span>
                            ) : isActive ? (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#E0EDF0] text-[#3E6570] border border-[#B8D0D5]">
                                Active
                              </span>
                            ) : (
                              <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#F3F4F6] text-[#9CA3AF] border border-[#E2DDD8]">
                                Past
                              </span>
                            )}
                          </td>
                          <td className="py-1.5 px-2 text-right">
                            <button
                              onClick={() => deleteRow(h.id)}
                              className="p-1 rounded text-[#9A3A2D] hover:bg-[#FBE0DC]"
                              title="Delete this entry"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    });
                  })()}
                </tbody>
              </table>
              </div>
            )}
          </section>
        </div>
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2DDD8]">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// AssignSkuModal — full-screen overlay for bulk-assigning unassigned SKUs
// to a customer. Replaces the earlier inline expand, which didn't scale
// once customers had dozens of candidate SKUs to pick from.
// =====================================================================
type ModalCategory = "ALL" | "BEDFRAME" | "SOFA" | "ACCESSORY";

function AssignSkuModal({
  open,
  customerName,
  candidates,
  picked,
  togglePick,
  setPicked,
  saving,
  onClose,
  onSubmit,
}: {
  open: boolean;
  customerName: string;
  candidates: ProductOption[];
  picked: Set<string>;
  togglePick: (id: string) => void;
  setPicked: (next: Set<string>) => void;
  saving: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const [modalTab, setModalTab] = useState<ModalCategory>("ALL");
  const [modalQuery, setModalQuery] = useState("");

  // Reset local state on every open so stale tab/search never bleed across
  // customers. Each field is user-editable while open, so pure derive isn't
  // possible — we just need a one-shot clear on the open->true transition.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (open) {
      setModalTab("ALL");
      setModalQuery("");
    }
  }, [open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // ESC closes the modal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const tabs: { key: ModalCategory; label: string }[] = [
    { key: "ALL", label: "All" },
    { key: "BEDFRAME", label: "Bedframe" },
    { key: "SOFA", label: "Sofa" },
    { key: "ACCESSORY", label: "Accessory" },
  ];

  const tabCounts = useMemo(() => {
    const c: Record<ModalCategory, number> = { ALL: candidates.length, BEDFRAME: 0, SOFA: 0, ACCESSORY: 0 };
    for (const p of candidates) {
      if (p.category === "BEDFRAME" || p.category === "SOFA" || p.category === "ACCESSORY") {
        c[p.category] += 1;
      }
    }
    return c;
  }, [candidates]);

  const visible = useMemo(() => {
    const q = modalQuery.trim().toLowerCase();
    return candidates.filter((p) => {
      if (modalTab !== "ALL" && p.category !== modalTab) return false;
      if (!q) return true;
      return p.code.toLowerCase().includes(q) || p.name.toLowerCase().includes(q);
    });
  }, [candidates, modalTab, modalQuery]);

  const selectAllVisible = () => {
    const next = new Set(picked);
    for (const p of visible) next.add(p.id);
    setPicked(next);
  };
  const clearSelection = () => setPicked(new Set());

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl flex flex-col w-[80vw] h-[80vh] max-w-6xl mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8]">
          <h2 className="text-lg font-semibold text-[#1F1D1B]">Assign SKUs to {customerName}</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-[#E2DDD8]" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Sub-header: tabs + search + bulk shortcuts */}
        <div className="px-6 py-3 border-b border-[#E2DDD8] space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setModalTab(t.key)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  modalTab === t.key
                    ? "bg-[#111827] text-white"
                    : "bg-white text-[#6B7280] border border-[#E2DDD8] hover:bg-[#F3F4F6]"
                }`}
              >
                {t.label} ({tabCounts[t.key]})
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px] max-w-md">
              <Search className="h-3.5 w-3.5 text-[#9CA3AF] absolute left-2.5 top-1/2 -translate-y-1/2" />
              <Input
                value={modalQuery}
                onChange={(e) => setModalQuery(e.target.value)}
                placeholder="Search by code or name..."
                className="h-8 pl-8"
                autoFocus
              />
            </div>
            <Button variant="outline" size="sm" onClick={selectAllVisible} disabled={visible.length === 0}>
              Select All visible
            </Button>
            <Button variant="outline" size="sm" onClick={clearSelection} disabled={picked.size === 0}>
              Clear
            </Button>
            <span className="text-xs text-[#6B7280] ml-auto">{picked.size} selected</span>
          </div>
        </div>

        {/* Body: scrollable grid of SKU rows */}
        <div className="flex-1 overflow-y-auto px-6 py-3">
          {candidates.length === 0 ? (
            <p className="text-sm text-[#9CA3AF] py-12 text-center">
              All SKUs are already assigned to this customer.
            </p>
          ) : visible.length === 0 ? (
            <p className="text-sm text-[#9CA3AF] py-12 text-center">
              No SKUs match the current filter.
            </p>
          ) : (
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {visible.map((p) => {
                const isPicked = picked.has(p.id);
                return (
                  <li
                    key={p.id}
                    onClick={() => togglePick(p.id)}
                    className={`flex items-center gap-3 px-3 py-2 border rounded cursor-pointer transition-colors ${
                      isPicked
                        ? "bg-[#F4F0E8] border-[#6B5C32]"
                        : "bg-white border-[#E2DDD8] hover:bg-[#FAF9F7]"
                    }`}
                  >
                    <div className={`h-4 w-4 rounded border flex items-center justify-center flex-shrink-0 ${isPicked ? "bg-[#6B5C32] border-[#6B5C32]" : "border-[#C8C2BB]"}`}>
                      {isPicked && <Check className="h-3 w-3 text-white" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="doc-number text-xs text-[#1F1D1B]">{p.code}</span>
                        <Badge className="text-[10px]">{p.category}</Badge>
                      </div>
                      <p className="text-xs text-[#6B7280] truncate">{p.name}</p>
                    </div>
                    <span className="text-xs tabular-nums text-[#6B7280] flex-shrink-0">{formatRM(p.basePriceSen)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2DDD8]">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={picked.size === 0 || saving}
            onClick={onSubmit}
          >
            {saving ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
            Assign {picked.size} item{picked.size === 1 ? "" : "s"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// =====================================================================
// Main Page
// =====================================================================
export default function CustomersPage() {
  const { toast } = useToast();
  const { confirm } = useConfirm();
  const { data: customersResp, loading, refresh: refreshCustomers } = useCachedJson<{ success?: boolean; data?: Customer[] }>("/api/customers");
  // Multi-Company Phase 4 — active companies for the per-customer default
  // company dropdown in the edit dialog.
  const { data: orgsResp } = useCachedJson<{ organisations?: Array<{ code?: string; name?: string; isActive?: boolean }> }>("/api/organisations");
  const activeOrgs = useMemo(
    () => (orgsResp?.organisations ?? []).filter((o) => o.isActive !== false && o.code),
    [orgsResp],
  );
  const initialCustomers: Customer[] = useMemo(
    () => (customersResp?.success ? customersResp.data ?? [] : Array.isArray(customersResp) ? customersResp : []),
    [customersResp]
  );
  // Salespeople come from user management — we store users.id and render the
  // name, so a rename never rots the assignment.
  // /api/users returns publicUser(): { id, email, displayName, isActive, … }.
  // displayName is optional, so fall back to the email before the raw id —
  // an id in a dropdown is unreadable.
  const { data: usersResp } = useCachedJson<{ success?: boolean; data?: Array<{ id?: string; displayName?: string; email?: string; isActive?: boolean }> }>("/api/users");
  const salespeople = useMemo(
    () =>
      (usersResp?.data ?? [])
        .filter((u) => u.id && u.isActive !== false)
        .map((u) => ({
          id: String(u.id),
          name: String(u.displayName || "").trim() || String(u.email || "").trim() || String(u.id),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [usersResp],
  );
  const salespersonName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of salespeople) m.set(s.id, s.name);
    return m;
  }, [salespeople]);

  const [data, setData] = useState<Customer[]>([]);
  const [expandedCustomer, setExpandedCustomer] = useState<string | null>(null);
  const [customerSearch, setCustomerSearch] = useState("");
  // Confirmed | Potential | All. Defaults to CONFIRMED so this page looks and
  // behaves exactly as it did before potential accounts existed — a salesperson
  // filling the pipeline must not quietly change what the accounts team sees.
  const [stageFilter, setStageFilter] = useState<"CONFIRMED" | "POTENTIAL" | "ALL">("CONFIRMED");

  // add-form state
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ code: "", name: "", contactName: "", phone: "", email: "", creditTerms: "NET30", creditLimitSen: 0 });
  const [addSaving, setAddSaving] = useState(false);

  // edit customer dialog state
  const [editCustomer, setEditCustomer] = useState<Customer | null>(null);
  const [editCustForm, setEditCustForm] = useState({ code: "", name: "", ssmNo: "", companyAddress: "", contactName: "", phone: "", email: "", creditTerms: "", creditLimitSen: 0, defaultCompanyCode: "", salespersonUserId: "", oemMarking: { bedframe: "NONE", sofa: "NONE", accessory: "NONE" } });
  // Guards the Save Changes button so a double-tap on tablet doesn't fire two
  // PUTs. persistCustomer already does the optimistic-update + rollback dance,
  // but without this guard the operator can still hammer the network.
  const [savingEdit, setSavingEdit] = useState(false);

  // add/edit hub form state
  const [showAddHub, setShowAddHub] = useState(false);
  const [editHubId, setEditHubId] = useState<string | null>(null);
  const [hubForm, setHubForm] = useState({ shortName: "", code: "", state: "KL", contactName: "", phone: "", email: "", address: "" });

  // ---------- Fetch ----------
  const fetchCustomers = () => {
    invalidateCachePrefix("/api/customers");
    refreshCustomers();
  };

  // `data` is locally mutated by add/edit/delete handlers (see ~5 setData
  // call sites below) for optimistic updates. We seed from the cached server
  // snapshot via this effect; pure derive would lose the optimistic state.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setData(initialCustomers); }, [initialCustomers]);

  // ---------- Add ----------
  // Owner 2026-08-01: a potential customer must be creatable from HERE too, not
  // only via the Sales Pipeline. The stage follows the tab you are standing on
  // — Potential creates POTENTIAL, Confirmed/All creates CONFIRMED — so the
  // button never silently produces the other kind. A POTENTIAL account has no
  // creditor code yet (that is what the Confirm gate is for), so the code is
  // optional in that mode and the debtor-code format check only runs when one
  // was actually typed.
  const addingPotential = stageFilter === "POTENTIAL";

  const handleAdd = async () => {
    if (addForm.code.trim()) {
      const dv = parseDebtorCode(addForm.code);
      if (!dv.ok) {
        toast.error(dv.error);
        return;
      }
    } else if (!addingPotential) {
      toast.error("A creditor code is required for a confirmed customer.");
      return;
    }
    setAddSaving(true);
    try {
      const res = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...addForm,
          customerStage: addingPotential ? "POTENTIAL" : "CONFIRMED",
        }),
      });
      const json = asCustomerMutationResponse(await res.json());
      if (json?.success) {
        setData((prev) => [...prev, json.data]);
        invalidateCachePrefix("/api/customers");
        setAddForm({ code: "", name: "", contactName: "", phone: "", email: "", creditTerms: "NET30", creditLimitSen: 0 });
        setShowAdd(false);
      } else {
        toast.error(json?.error || `Failed to add customer (HTTP ${res.status})`);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : "network error";
      toast.error(`Failed to add customer: ${detail}`);
      console.error(err);
    } finally {
      setAddSaving(false);
    }
  };

  // ---------- Delete ----------
  const handleDelete = async (customer: Customer) => {
    if (!(await confirm({ title: "Delete customer?", message: `Delete customer "${customer.name}"?`, danger: true }))) return;
    try {
      const res = await fetch(`/api/customers/${customer.id}`, { method: "DELETE" });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json: any = await res.json().catch(() => ({}));
      // res.ok guard — a failed DELETE (foreign-key block, 401, 500) would
      // otherwise let the row disappear from the list locally while the
      // customer stays in the DB. On next reload it reappears "zombie" style.
      if (!res.ok) {
        toast.error(json?.error || `Failed to delete customer (HTTP ${res.status})`);
        return;
      }
      if (json.success) {
        setData((prev) => prev.filter((c) => c.id !== customer.id));
        invalidateCachePrefix("/api/customers");
      } else {
        toast.error(json.error || "Failed to delete customer");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Network error — customer not deleted");
    }
  };

  // ---------- Persist customer to API ----------
  // Returns true on success, false on failure. Caller is responsible for
  // rolling back local optimistic state on false (we already applied it
  // before the network round-trip).
  // deletedHubIds: hub deletions must be named explicitly — the backend no
  // longer diff-deletes hubs missing from the array (BUG-2026-07-27-002).
  const persistCustomer = async (
    updated: Customer & { deletedHubIds?: string[] },
  ): Promise<boolean> => {
    const previousData = data;
    setData((prev) => prev.map((c) => c.id === updated.id ? updated : c));
    // 2026-05-27 verifiedSave migration. Compares name + state on
    // readback so a backend that silently dropped the change (stale
    // cache / partial commit) flips us to error instead of green toast.
    const result = await verifiedSave<Customer>({
      endpoint: `/api/customers/${updated.id}`,
      method: "PUT",
      body: updated,
      readback: async () => {
        const r = await fetch(`/api/customers/${updated.id}?_v=${Date.now()}`, {
          credentials: "include",
          cache: "no-store",
        });
        if (!r.ok) return null;
        const j = (await r.json()) as { success?: boolean; data?: Customer } | Customer;
        return (j as { data?: Customer })?.data ?? (j as Customer) ?? null;
      },
      expect: {
        name: updated.name,
        code: updated.code,
        creditLimitSen: updated.creditLimitSen,
        contactName: updated.contactName,
        phone: updated.phone,
      },
    });
    if (!result.ok) {
      // The write returned 2xx but the confirmation read was cancelled (route
      // change / 30s cap). The edit almost certainly persisted, so KEEP it on
      // screen — reverting here is what made the owner's credit-limit change
      // vanish behind "Failed to save customer: signal is aborted without
      // reason" when it had in fact saved.
      if (result.reason === "unverified") {
        toast.info(result.details);
        return true;
      }
      setData(previousData);
      if (result.reason === "mismatch") {
        toast.error(formatMismatchError(result.diffs));
      } else if (result.reason === "http") {
        let detail = result.body;
        try { const j = JSON.parse(result.body) as { error?: string }; if (j.error) detail = j.error; } catch { /* keep raw */ }
        toast.error(`Failed to save customer: ${detail || result.status}`);
      } else {
        toast.error(`Failed to save customer: ${result.details}`);
      }
      console.error("persistCustomer failed:", result);
      return false;
    }
    invalidateCache(`/api/customers/${updated.id}`);
    return true;
  };

  // ---------- Edit Customer ----------
  const openEditCustomer = (cust: Customer) => {
    setEditCustomer(cust);
    setEditCustForm({
      code: cust.code,
      name: cust.name,
      ssmNo: cust.ssmNo || "",
      companyAddress: cust.companyAddress || "",
      contactName: cust.contactName,
      phone: cust.phone,
      email: cust.email,
      creditTerms: cust.creditTerms,
      creditLimitSen: cust.creditLimitSen,
      defaultCompanyCode: cust.defaultCompanyCode || "",
      salespersonUserId: cust.salespersonUserId || "",
      oemMarking: (() => {
        const cm = (cust as { oemMarking?: { bedframe?: string; sofa?: string; accessory?: string } }).oemMarking;
        const norm = (v: string | undefined) => (v === "TAG" || v === "LABEL" ? v : "NONE");
        return { bedframe: norm(cm?.bedframe), sofa: norm(cm?.sofa), accessory: norm(cm?.accessory) };
      })(),
    });
  };

  const saveEditCustomer = async () => {
    if (!editCustomer || savingEdit) return;
    if (editCustForm.code !== editCustomer.code) {
      const dv = parseDebtorCode(editCustForm.code);
      if (!dv.ok) {
        toast.error(dv.error);
        return;
      }
    }
    setSavingEdit(true);
    try {
      const updated = { ...editCustomer, ...editCustForm };
      const ok = await persistCustomer(updated);
      if (ok) setEditCustomer(null);
      // On failure persistCustomer already rolled back local state and toasted.
      // Keep the dialog open so the operator can retry.
    } finally {
      setSavingEdit(false);
    }
  };

  // ---------- KPI calculations ----------
  // Stage-scoped view of the account list. Everything below — the KPI tiles and
  // the grid — reads THIS, not `data`. A potential customer has no A/R and no
  // approved credit line, so counting one into Total Outstanding / Total Credit
  // Limit would misstate the numbers the accounts team reads off this page.
  const stageScoped = useMemo(
    () =>
      stageFilter === "ALL"
        ? data
        : data.filter((c) => (c.customerStage ?? "CONFIRMED") === stageFilter),
    [data, stageFilter],
  );
  const potentialCount = useMemo(
    () => data.filter((c) => c.customerStage === "POTENTIAL").length,
    [data],
  );

  const totalCustomers = stageScoped.length;
  const totalHubs = stageScoped.reduce((s, c) => s + (c.deliveryHubs?.length || 0), 0);
  const totalOutstanding = stageScoped.reduce((s, c) => s + c.outstandingSen, 0);
  const totalCreditLimit = stageScoped.reduce((s, c) => s + c.creditLimitSen, 0);

  // ---------- Columns ----------
  const columns: Column<Customer>[] = [
    {
      key: "code",
      label: "Creditor Code",
      type: "docno",
      width: "120px",
      sortable: true,
    },
    {
      key: "name",
      label: "Customer Name",
      width: "200px",
      sortable: true,
      render: (_value, row) => (
        <div>
          <p className="font-medium text-[#1F1D1B] flex items-center gap-1.5">
            {row.name}
            {/* Only POTENTIAL is badged. Confirmed is the norm and badging every
                row would be noise the operator has to read past. */}
            {row.customerStage === "POTENTIAL" && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[#F3F4F6] text-[#6B7280] border border-[#E2DDD8]">
                Potential
              </span>
            )}
          </p>
          <p className="text-xs text-[#9CA3AF]">{row.contactName}</p>
        </div>
      ),
    },
    {
      key: "salespersonUserId",
      label: "Salesperson",
      width: "140px",
      sortable: true,
      // Stored as users.id, rendered as the name — so renaming a user in User
      // Management never orphans the assignment.
      render: (_value, row) => {
        const name = row.salespersonUserId ? salespersonName.get(row.salespersonUserId) : "";
        return name ? (
          <span className="text-[#1F1D1B]">{name}</span>
        ) : (
          <span className="text-[#C9C3BC]">—</span>
        );
      },
    },
    {
      key: "deliveryHubs" as keyof Customer,
      label: "Delivery Hubs",
      width: "200px",
      sortable: false,
      render: (_value, row) => {
        const hubs = row.deliveryHubs || [];
        if (hubs.length === 0) return <span className="text-xs text-[#9CA3AF]">No hubs</span>;
        return (
          <div className="flex flex-col gap-0.5">
            {hubs.map((h) => (
              <div key={h.id} className="flex items-center gap-1.5 text-xs">
                <StateBadge state={h.state} />
                <span className="text-[#1F1D1B]">{h.shortName}</span>
              </div>
            ))}
          </div>
        );
      },
    },
    {
      key: "contactName",
      label: "PIC",
      width: "150px",
      sortable: true,
      render: (_value, row) => {
        const hubs = row.deliveryHubs || [];
        if (hubs.length <= 1) return <span className="text-sm">{row.contactName}</span>;
        return (
          <div className="flex flex-col gap-0.5">
            {hubs.map((h) => (
              <span key={h.id} className="text-xs text-[#1F1D1B]">{h.contactName}</span>
            ))}
          </div>
        );
      },
    },
    {
      key: "phone",
      label: "PIC Contact",
      width: "200px",
      render: (_value, row) => {
        const hubs = row.deliveryHubs || [];
        if (hubs.length <= 1) {
          return (
            <div className="space-y-0.5">
              <div className="flex items-center gap-1 text-xs text-[#6B7280]">
                <Phone className="h-3 w-3" />
                {row.phone}
              </div>
              {row.email && (
                <div className="flex items-center gap-1 text-xs text-[#6B7280]">
                  <Mail className="h-3 w-3" />
                  {row.email}
                </div>
              )}
            </div>
          );
        }
        return (
          <div className="flex flex-col gap-0.5">
            {hubs.map((h) => (
              <div key={h.id} className="flex items-center gap-1 text-xs text-[#6B7280]">
                <Phone className="h-3 w-3" />
                {h.phone}
              </div>
            ))}
          </div>
        );
      },
    },
    {
      key: "creditTerms",
      label: "Terms",
      width: "80px",
      sortable: true,
      align: "center",
      render: (_value, row) => <Badge>{row.creditTerms}</Badge>,
    },
    {
      key: "creditLimitSen",
      label: "Credit Limit",
      type: "currency",
      width: "130px",
      sortable: true,
      align: "right",
    },
    {
      key: "outstandingSen",
      label: "Outstanding",
      width: "140px",
      sortable: true,
      align: "right",
      render: (_value, row) => {
        const pct = row.creditLimitSen > 0
          ? (row.outstandingSen / row.creditLimitSen) * 100
          : 0;
        return (
          <div>
            <span className={`font-medium tabular-nums ${pct > 80 ? "text-[#9A3A2D]" : "text-[#1F1D1B]"}`}>
              {formatRM(row.outstandingSen)}
            </span>
            <div className="mt-1 h-1 w-full rounded-full bg-[#E2DDD8]">
              <div
                className={`h-1 rounded-full ${
                  pct > 80 ? "bg-[#9A3A2D]" : pct > 50 ? "bg-[#9C6F1E]" : "bg-[#4F7C3A]"
                }`}
                style={{ width: `${Math.min(pct, 100)}%` }}
              />
            </div>
          </div>
        );
      },
    },
    {
      // Available = credit limit − outstanding. Derived on the client from the
      // two ledger-backed fields already on the row, so it needs no new API. A
      // customer with no limit (e.g. CASH terms) has no meaningful headroom.
      key: "availableSen",
      label: "Available",
      width: "130px",
      sortable: true,
      align: "right",
      sortAccessor: (row) => row.creditLimitSen - row.outstandingSen,
      render: (_value, row) => {
        if (row.creditLimitSen <= 0) return <span className="text-[#9CA3AF]">—</span>;
        const available = row.creditLimitSen - row.outstandingSen;
        const over = available <= 0;
        return (
          <span
            className={`font-medium tabular-nums ${over ? "text-[#9A3A2D]" : "text-[#4F7C3A]"}`}
            title={over ? "Over credit limit" : "Credit headroom remaining"}
          >
            {formatRM(available)}
          </span>
        );
      },
    },
  ];

  // ---------- Context menu ----------
  const contextMenuItems: ContextMenuItem[] = [
    {
      label: "View",
      icon: <Eye className="h-3.5 w-3.5" />,
      action: (row: Customer) => setExpandedCustomer(expandedCustomer === row.id ? null : row.id),
    },
    {
      label: "Edit",
      icon: <Pencil className="h-3.5 w-3.5" />,
      action: (row: Customer) => openEditCustomer(row),
    },
    { label: "", separator: true, action: () => {} },
    {
      label: "Delete",
      icon: <Trash2 className="h-3.5 w-3.5" />,
      danger: true,
      action: (row: Customer) => handleDelete(row),
    },
    { label: "", separator: true, action: () => {} },
    {
      label: "Refresh",
      icon: <RefreshCw className="h-3.5 w-3.5" />,
      action: () => fetchCustomers(),
    },
  ];

  const filteredData = customerSearch.trim()
    ? stageScoped.filter((c) => {
        const q = customerSearch.toLowerCase();
        return (
          (c.code ?? "").toLowerCase().includes(q) ||
          (c.name ?? "").toLowerCase().includes(q) ||
          (c.contactName ?? "").toLowerCase().includes(q) ||
          (c.phone ?? "").toLowerCase().includes(q)
        );
      })
    : stageScoped;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">Customers</h1>
          <p className="text-xs text-[#6B7280]">
            Manage customer accounts, delivery hubs, and credit
          </p>
        </div>
        {/* Confirmed | Potential | All. Potential accounts come from the Sales
            Pipeline and are not billable, so they stay out of the default view. */}
        <div className="flex items-center rounded-lg border border-[#E2DDD8] bg-white p-0.5">
          {([
            { key: "CONFIRMED", label: "Confirmed" },
            { key: "POTENTIAL", label: "Potential" },
            { key: "ALL", label: "All" },
          ] as const).map((opt) => (
            <button
              key={opt.key}
              onClick={() => setStageFilter(opt.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                stageFilter === opt.key
                  ? "bg-[#1F1D1B] text-white"
                  : "text-[#6B7280] hover:bg-[#FAF9F7]"
              }`}
            >
              {opt.label}
              {opt.key === "POTENTIAL" && potentialCount > 0 && (
                <span className={`ml-1.5 tabular-nums ${stageFilter === opt.key ? "text-white/70" : "text-[#9CA3AF]"}`}>
                  {potentialCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {stageFilter !== "CONFIRMED" && potentialCount > 0 && (
        <div className="rounded-lg border border-[#E7DFC9] bg-[#FBF7EA] px-4 py-2.5 text-xs text-[#6B5C32]">
          Potential customers come from the Sales Pipeline. You can assign SKUs,
          maintenance and combos to them and quote from them — but they cannot be
          used on a sales order until they are confirmed.
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#F0ECE9] p-2.5">
              <Building2 className="h-5 w-5 text-[#6B5C32]" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[#1F1D1B]">{totalCustomers}</p>
              <p className="text-xs text-[#6B7280]">Total Customers</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#F0ECE9] p-2.5">
              <Warehouse className="h-5 w-5 text-[#6B5C32]" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[#1F1D1B]">{totalHubs}</p>
              <p className="text-xs text-[#6B7280]">Delivery Hubs</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#FAEFCB] p-2.5">
              <AlertTriangle className="h-5 w-5 text-[#9C6F1E]" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[#9C6F1E]">
                {formatCurrency(totalOutstanding)}
              </p>
              <p className="text-xs text-[#6B7280]">Total Outstanding</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="rounded-lg bg-[#F0ECE9] p-2.5">
              <Package className="h-5 w-5 text-[#6B5C32]" />
            </div>
            <div>
              <p className="text-2xl font-bold text-[#1F1D1B]">
                {formatCurrency(totalCreditLimit)}
              </p>
              <p className="text-xs text-[#6B7280]">Total Credit Limit</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Add Customer Form */}
      {showAdd && (
        <Card className="border-[#6B5C32] border-2">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {addingPotential ? "New potential customer" : "New Customer"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <label className="text-xs font-medium text-[#374151] mb-1 block">
                  Creditor Code {addingPotential ? <span className="font-normal text-[#9CA3AF]">(set at Confirm)</span> : "*"}
                </label>
                <Input value={addForm.code} onChange={(e) => setAddForm({ ...addForm, code: e.target.value })} placeholder={addingPotential ? "Optional until confirmed" : "e.g. 300-X"} />
              </div>
              <div>
                <label className="text-xs font-medium text-[#374151] mb-1 block">Customer Name *</label>
                <Input value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} placeholder="Company name" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#374151] mb-1 block">PIC</label>
                <Input value={addForm.contactName} onChange={(e) => setAddForm({ ...addForm, contactName: e.target.value })} placeholder="e.g. Purchasing" />
              </div>
              <div className="min-w-0 sm:col-span-2">
                {/* Span 2 so the +60 dial select + number field aren't crushed
                    into a quarter-width cell (number cut off). */}
                <label className="text-xs font-medium text-[#374151] mb-1 block">PIC Contact</label>
                <PhoneInput value={addForm.phone} onChange={(v) => setAddForm({ ...addForm, phone: v })} />
              </div>
              <div>
                <label className="text-xs font-medium text-[#374151] mb-1 block">PIC Email</label>
                <Input value={addForm.email} onChange={(e) => setAddForm({ ...addForm, email: e.target.value })} placeholder="email@example.com" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#374151] mb-1 block">Credit Terms</label>
                <Input value={addForm.creditTerms} onChange={(e) => setAddForm({ ...addForm, creditTerms: e.target.value })} placeholder="NET30" />
              </div>
              <div>
                <label className="text-xs font-medium text-[#374151] mb-1 block">Credit Limit (RM)</label>
                <Input type="number" onFocus={(e) => e.currentTarget.select()} value={addForm.creditLimitSen / 100} onChange={(e) => setAddForm({ ...addForm, creditLimitSen: Math.round(Number(e.target.value) * 100) })} placeholder="0.00" />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-4">
              <Button variant="outline" onClick={() => setShowAdd(false)}>Cancel</Button>
              <Button variant="primary" disabled={!addForm.name || (!addingPotential && !addForm.code) || addSaving} onClick={handleAdd}>
                {addSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                {addingPotential ? "Create potential" : "Create Customer"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Customer List */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="w-80 max-w-full">
          <Input
            placeholder="Search code, name, contact..."
            value={customerSearch}
            onChange={(e) => setCustomerSearch(e.target.value)}
          />
        </div>
        <Button variant="primary" onClick={() => setShowAdd((v) => !v)}>
          {showAdd ? (
            <>
              <X className="h-4 w-4" />
              Cancel
            </>
          ) : (
            <>
              <Plus className="h-4 w-4" />
              Add Customer
            </>
          )}
        </Button>
      </div>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5 text-[#6B5C32]" />
            All Customers
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataGrid<Customer>
            columns={columns}
            data={filteredData}
            keyField="id"
            virtualize
            gridId="customers"
            loading={loading}
            stickyHeader={true}
            emptyMessage="No customers found."
            onRowClick={(row) => setExpandedCustomer(expandedCustomer === row.id ? null : row.id)}
            contextMenuItems={contextMenuItems}
            // WYSIWYG export of the current columns over the current rows.
            // No detail listing: a customer is not a document and has no line
            // items. (Its delivery hubs / customer products are separate
            // records shown in the expander, not lines of this row.)
            exportName="customers"
            exportSheetLabel="Customers"
          />
        </CardContent>
      </Card>

      {/* Expanded Customer Detail (Delivery Hubs + Customer Products) */}
      {expandedCustomer && (() => {
        const cust = data.find((c) => c.id === expandedCustomer);
        if (!cust) return null;
        return (
          <>
          <Card className="border-[#6B5C32] border-2">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Warehouse className="h-5 w-5 text-[#6B5C32]" />
                  {cust.name} — Delivery Hubs ({cust.deliveryHubs?.length || 0})
                </CardTitle>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button variant="outline" size="sm" onClick={() => openEditCustomer(cust)}>
                    <Pencil className="h-4 w-4 mr-1" /> Edit
                  </Button>
                  <Button variant="primary" size="sm" onClick={() => { setShowAddHub(true); setHubForm({ shortName: "", code: "", state: "KL", contactName: "", phone: "", email: "", address: "" }); }}>
                    <Plus className="h-4 w-4 mr-1" /> Add Hub
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setExpandedCustomer(null)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="flex items-center gap-4 mt-2 text-sm text-[#6B7280] flex-wrap">
                <span>Credit Limit: <strong className="text-[#1F1D1B]">{formatRM(cust.creditLimitSen)}</strong></span>
                <span>Outstanding: <strong className="text-[#1F1D1B]">{formatRM(cust.outstandingSen)}</strong></span>
                {cust.creditLimitSen > 0 && (() => {
                  const available = cust.creditLimitSen - cust.outstandingSen;
                  const over = available <= 0;
                  return (
                    <span>Available: <strong className={over ? "text-[#9A3A2D]" : "text-[#4F7C3A]"}>{formatRM(available)}</strong>{over ? " (over limit)" : ""}</span>
                  );
                })()}
                <span>Terms: <Badge>{cust.creditTerms}</Badge></span>
              </div>
            </CardHeader>
            <CardContent>
              {(!cust.deliveryHubs || cust.deliveryHubs.length === 0) ? (
                <p className="text-sm text-[#9CA3AF] py-4 text-center">No delivery hubs configured</p>
              ) : (
                <div className="space-y-2">
                  {cust.deliveryHubs.map((hub) => (
                    editHubId === hub.id ? (
                      <div key={hub.id} className="p-4 rounded-lg border-2 border-[#6B5C32]/30 bg-[#FAF9F7] space-y-3">
                        <h3 className="text-sm font-semibold text-[#6B5C32]">Edit Hub — {hub.shortName}</h3>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 max-md:grid-cols-1">
                          <div>
                            <label className="block text-xs text-[#6B7280] mb-1">Hub Name *</label>
                            <Input value={hubForm.shortName} onChange={(e) => setHubForm(f => ({ ...f, shortName: e.target.value }))} className="h-8" />
                          </div>
                          <div>
                            <label className="block text-xs text-[#6B7280] mb-1">Hub Code</label>
                            <Input value={hubForm.code} onChange={(e) => setHubForm(f => ({ ...f, code: e.target.value }))} className="h-8" />
                          </div>
                          <div>
                            <label className="block text-xs text-[#6B7280] mb-1">State *</label>
                            <StateSelect value={hubForm.state} onChange={(v) => setHubForm(f => ({ ...f, state: v }))} className="w-full h-8" />
                          </div>
                          <div>
                            <label className="block text-xs text-[#6B7280] mb-1">Contact Name</label>
                            <Input value={hubForm.contactName} onChange={(e) => setHubForm(f => ({ ...f, contactName: e.target.value }))} className="h-8" />
                          </div>
                          <div>
                            <label className="block text-xs text-[#6B7280] mb-1">Phone</label>
                            <PhoneInput value={hubForm.phone} onChange={(v) => setHubForm(f => ({ ...f, phone: v }))} />
                          </div>
                          <div>
                            <label className="block text-xs text-[#6B7280] mb-1">Email</label>
                            <Input value={hubForm.email} onChange={(e) => setHubForm(f => ({ ...f, email: e.target.value }))} className="h-8" />
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs text-[#6B7280] mb-1">Address *</label>
                          <Input value={hubForm.address} onChange={(e) => setHubForm(f => ({ ...f, address: e.target.value }))} />
                        </div>
                        <div className="flex justify-end gap-2">
                          <Button variant="outline" size="sm" onClick={() => setEditHubId(null)}>Cancel</Button>
                          <Button variant="primary" size="sm" onClick={async () => {
                            const cust = data.find(c => c.id === expandedCustomer);
                            if (!cust) { setEditHubId(null); return; }
                            const ok = await persistCustomer({ ...cust, deliveryHubs: cust.deliveryHubs.map(h => h.id === editHubId ? { ...h, ...hubForm } : h) });
                            if (ok) setEditHubId(null);
                          }}>Save</Button>
                        </div>
                      </div>
                    ) : (
                      <div key={hub.id} className="flex items-center gap-4 p-3 rounded-lg border border-[#E2DDD8] hover:bg-[#FAF9F7] group">
                        <StateBadge state={hub.state} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm text-[#1F1D1B]">{hub.shortName}</span>
                            <span className="text-xs text-[#9CA3AF] doc-number">{hub.code}</span>
                            <StateBadge state={hub.state} />
                            {hub.isDefault && <Badge className="bg-[#6B5C32]/10 text-[#6B5C32] border-[#6B5C32]/20 text-[10px]">Default</Badge>}
                          </div>
                          <div className="flex items-center gap-3 mt-0.5 text-xs text-[#6B7280]">
                            <span className="flex items-center gap-1"><Users className="h-3 w-3" />{hub.contactName}</span>
                            <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{hub.phone}</span>
                            {hub.email && <span className="flex items-center gap-1"><Mail className="h-3 w-3" />{hub.email}</span>}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-1 text-xs text-[#6B7280] max-w-xs text-right">
                            <MapPin className="h-3 w-3 flex-shrink-0" />
                            <span className="line-clamp-2">{hub.address}</span>
                          </div>
                          <button
                            onClick={() => {
                              setEditHubId(hub.id);
                              setHubForm({ shortName: hub.shortName, code: hub.code, state: hub.state, contactName: hub.contactName, phone: hub.phone, email: hub.email || "", address: hub.address });
                            }}
                            className="p-1.5 rounded hover:bg-[#E2DDD8] transition-opacity"
                          >
                            <Pencil className="h-3.5 w-3.5 text-[#6B5C32]" />
                          </button>
                          <button
                            onClick={async () => {
                              if (!(await confirm({ title: "Delete hub?", message: `Delete hub "${hub.shortName}"?`, danger: true }))) return;
                              const cust = data.find(c => c.id === expandedCustomer);
                              if (!cust) return;
                              await persistCustomer({ ...cust, deliveryHubs: cust.deliveryHubs.filter(h => h.id !== hub.id), deletedHubIds: [hub.id] });
                              // persistCustomer toasts + rolls back on failure; nothing else to do here.
                            }}
                            className="p-1.5 rounded hover:bg-[#F9E1DA] transition-opacity"
                          >
                            <Trash2 className="h-3.5 w-3.5 text-[#9A3A2D]" />
                          </button>
                        </div>
                      </div>
                    )
                  ))}
                </div>
              )}
              {/* Add Hub Form */}
              {showAddHub && (
                <div className="mt-3 p-4 rounded-lg border-2 border-dashed border-[#6B5C32]/30 bg-[#FAF9F7] space-y-3">
                  <h3 className="text-sm font-semibold text-[#6B5C32]">Add New Hub</h3>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1">Hub Name *</label>
                      <Input value={hubForm.shortName} onChange={(e) => setHubForm(f => ({ ...f, shortName: e.target.value }))} placeholder="e.g. Houzs JB" className="h-8" />
                    </div>
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1">Hub Code *</label>
                      <Input value={hubForm.code} onChange={(e) => setHubForm(f => ({ ...f, code: e.target.value }))} placeholder="e.g. 300-H005" className="h-8" />
                    </div>
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1">State *</label>
                      <StateSelect value={hubForm.state} onChange={(v) => setHubForm(f => ({ ...f, state: v }))} className="w-full h-8" />
                    </div>
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1">Contact Name</label>
                      <Input value={hubForm.contactName} onChange={(e) => setHubForm(f => ({ ...f, contactName: e.target.value }))} placeholder="PIC name" className="h-8" />
                    </div>
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1">Phone</label>
                      <PhoneInput value={hubForm.phone} onChange={(v) => setHubForm(f => ({ ...f, phone: v }))} />
                    </div>
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1">Email</label>
                      <Input value={hubForm.email} onChange={(e) => setHubForm(f => ({ ...f, email: e.target.value }))} placeholder="email@example.com" className="h-8" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Address *</label>
                    <Input value={hubForm.address} onChange={(e) => setHubForm(f => ({ ...f, address: e.target.value }))} placeholder="Full delivery address" />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setShowAddHub(false)}>Cancel</Button>
                    <Button variant="primary" size="sm" disabled={!hubForm.shortName || !hubForm.code || !hubForm.address} onClick={async () => {
                      const newHub = { id: `hub-${Date.now()}`, ...hubForm, isDefault: false };
                      const cust = data.find(c => c.id === expandedCustomer);
                      if (!cust) { setShowAddHub(false); return; }
                      const ok = await persistCustomer({ ...cust, deliveryHubs: [...(cust.deliveryHubs || []), newHub] });
                      if (ok) setShowAddHub(false);
                    }}>Save Hub</Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          {/* CRM (contacts + activity) lives in the Sales Pipeline lead drawer,
              not here — owner 2026-08-01: the Pipeline is where the whole contact
              history is kept, and this page is for what you DO with an account
              (SKUs, maintenance, combos, quotations). Wishlist was retired
              outright in the same pass; assigning SKUs covers that need. */}
          <KycPanel customerId={cust.id} />
          <CustomerProductsPanel customerId={cust.id} customerName={cust.name} customer={cust} />
          <CustomerMaintenancePanel customerId={cust.id} customerName={cust.name} />
          <CustomerSofaCombosPanel customerId={cust.id} customerName={cust.name} />
          </>
        );
      })()}

      {/* Edit Customer Dialog */}
      {editCustomer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          {/* Landscape (two-column) layout + capped height so the header and the
              Save/Cancel footer stay PINNED and only the middle scrolls — on a
              short laptop screen the old single-column tall modal overflowed with
              no way to reach Save (users literally couldn't save). */}
          <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl mx-4 flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#E2DDD8] shrink-0">
              <h2 className="text-lg font-semibold text-[#1F1D1B]">Edit Customer — {editCustomer.code}</h2>
              <button onClick={() => setEditCustomer(null)} className="p-1 rounded hover:bg-[#E2DDD8]">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4">
              <div className="grid grid-cols-2 gap-x-6 gap-y-4 max-md:grid-cols-1">
                {/* LEFT column — Company Information */}
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold text-[#6B5C32]">Company Information</h3>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Creditor Code *</label>
                    <Input value={editCustForm.code} onChange={(e) => setEditCustForm(f => ({ ...f, code: e.target.value }))} />
                    <p className="mt-1 text-[10px] text-[#9C6F1E] bg-[#FAEFCB] border border-[#E8D899] rounded px-2 py-1">
                      ⚠ Changing the code does not rewrite historical SO / DO / Invoice / Maintenance / Customer Products references — those records keep the old code on file. Use only when fixing a typo or migrating accounting numbering.
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Customer Name *</label>
                    <Input value={editCustForm.name} onChange={(e) => setEditCustForm(f => ({ ...f, name: e.target.value }))} />
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">SSM No.</label>
                    <Input value={editCustForm.ssmNo} onChange={(e) => setEditCustForm(f => ({ ...f, ssmNo: e.target.value }))} placeholder="e.g. 201901012345" />
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Company Address</label>
                    <Input value={editCustForm.companyAddress} onChange={(e) => setEditCustForm(f => ({ ...f, companyAddress: e.target.value }))} placeholder="Registered company address" />
                  </div>
                  {/* PIC : Phone — Phone gets the wider share (1.4fr) and its own
                      min-width so the +60 dial select doesn't squeeze the number
                      field to a few visible digits ("11-6151 1…" cut off). Stacks
                      on small screens. */}
                  <div className="grid grid-cols-1 sm:grid-cols-[1fr_1.4fr] gap-4">
                    <div className="min-w-0">
                      <label className="block text-xs text-[#6B7280] mb-1">PIC</label>
                      <Input value={editCustForm.contactName} onChange={(e) => setEditCustForm(f => ({ ...f, contactName: e.target.value }))} />
                    </div>
                    <div className="min-w-0">
                      <label className="block text-xs text-[#6B7280] mb-1">Phone</label>
                      <PhoneInput value={editCustForm.phone} onChange={(v) => setEditCustForm(f => ({ ...f, phone: v }))} />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Email</label>
                    <Input value={editCustForm.email} onChange={(e) => setEditCustForm(f => ({ ...f, email: e.target.value }))} />
                  </div>
                </div>
                {/* RIGHT column — Credit & Terms + OEM marking */}
                <div className="space-y-4">
                  <h3 className="text-sm font-semibold text-[#6B5C32]">Credit & Terms</h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1">Credit Terms</label>
                      <select
                        value={editCustForm.creditTerms}
                        onChange={(e) => setEditCustForm(f => ({ ...f, creditTerms: e.target.value }))}
                        className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20"
                      >
                        <option value="COD">COD</option>
                        <option value="NET15">NET15</option>
                        <option value="NET30">NET30</option>
                        <option value="NET45">NET45</option>
                        <option value="NET60">NET60</option>
                        <option value="NET90">NET90</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1">Credit Limit (RM)</label>
                      <Input type="number" onFocus={(e) => e.currentTarget.select()} value={editCustForm.creditLimitSen / 100} onChange={(e) => setEditCustForm(f => ({ ...f, creditLimitSen: Math.round(Number(e.target.value) * 100) }))} />
                    </div>
                  </div>
                  {/* Multi-Company Phase 4 — default company for NEW sales orders
                      from this customer. Empty = no default (falls back to
                      HOOKKA). Does NOT move existing orders. */}
                  {activeOrgs.length > 0 && (
                    <div>
                      <label className="block text-xs text-[#6B7280] mb-1">Default Company (new orders)</label>
                      <select
                        value={editCustForm.defaultCompanyCode}
                        onChange={(e) => setEditCustForm(f => ({ ...f, defaultCompanyCode: e.target.value }))}
                        className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20"
                        aria-label="Default company for new sales orders"
                      >
                        <option value="">No default (Hookka)</option>
                        {activeOrgs.map((o) => (
                          <option key={o.code} value={o.code}>{o.name || o.code}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {/* Salesperson who owns the account. Sourced from User
                      Management; we store users.id and render the name, so a
                      rename in Settings never orphans the assignment. */}
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">Salesperson</label>
                    <select
                      value={editCustForm.salespersonUserId}
                      onChange={(e) => setEditCustForm(f => ({ ...f, salespersonUserId: e.target.value }))}
                      className="w-full rounded-md border border-[#E2DDD8] bg-white px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]/20"
                      aria-label="Salesperson who owns this account"
                    >
                      <option value="">Unassigned</option>
                      {salespeople.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                      {/* An assignment whose user was deactivated must stay
                          visible, or saving the dialog would silently clear it. */}
                      {editCustForm.salespersonUserId &&
                        !salespeople.some((s) => s.id === editCustForm.salespersonUserId) && (
                          <option value={editCustForm.salespersonUserId}>
                            {salespersonName.get(editCustForm.salespersonUserId) ?? "(inactive user)"}
                          </option>
                        )}
                    </select>
                  </div>
                  {/* OEM product marking — per category, what to attach on this
                      customer's finished goods. Shows on the Fab Cut / Fab Sew
                      sticker Notes so the line knows (see customers.ts oem_marking). */}
                  <div>
                    <label className="block text-xs text-[#6B7280] mb-1">OEM product marking (shows on Fab Cut / Sew sticker)</label>
                    <div className="space-y-1.5">
                      {([["bedframe", "Bedframe"], ["sofa", "Sofa"], ["accessory", "Accessory"]] as const).map(([key, label]) => (
                        <div key={key} className="flex items-center justify-between gap-2">
                          <span className="text-sm text-[#374151]">{label}</span>
                          <div className="inline-flex rounded-md border border-[#E2DDD8] overflow-hidden">
                            {(["NONE", "TAG", "LABEL"] as const).map((opt) => {
                              const on = editCustForm.oemMarking[key] === opt;
                              return (
                                <button
                                  key={opt}
                                  type="button"
                                  onClick={() => setEditCustForm((f) => ({ ...f, oemMarking: { ...f.oemMarking, [key]: opt } }))}
                                  className={`px-3 py-1 text-xs ${opt !== "NONE" ? "border-l border-[#E2DDD8]" : ""} ${on ? "bg-[#6B5C32] text-white" : "bg-white text-gray-600 hover:bg-[#FAF9F7]"}`}
                                >
                                  {opt === "NONE" ? "None" : opt === "TAG" ? "Tag" : "Label"}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 px-6 py-4 border-t border-[#E2DDD8] shrink-0">
              <Button variant="outline" onClick={() => setEditCustomer(null)} disabled={savingEdit}>Cancel</Button>
              <Button variant="primary" onClick={saveEditCustomer} disabled={savingEdit || !editCustForm.name || !editCustForm.code}>{savingEdit ? "Saving…" : "Save Changes"}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
