import { useState, useMemo, useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { SKUFormDialog } from "./sku-form-dialog";
import { SupplierFormDialog, type OrgOption } from "./supplier-form-dialog";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { formatDate } from "@/lib/utils";
import { useCachedJson, invalidateCache } from "@/lib/cached-fetch";
import { useToast } from "@/components/ui/toast";
import {
  Plus,
  Building2,
  Star,
  Package,
  Pencil,
  Trash2,
  CheckCircle2,
  TrendingUp,
} from "lucide-react";

type InventoryItem = {
  id: string;
  itemCode: string;
  description: string;
  baseUOM: string;
  itemGroup: string;
};

// ============================================================
// Types
// ============================================================
type SupplierStatus = "ACTIVE" | "INACTIVE" | "BLACKLISTED";
type PaymentTerms = "NET15" | "NET30" | "NET45" | "NET60" | "COD";

type Supplier = {
  id: string;
  code: string;
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  paymentTerms: PaymentTerms;
  rating: number; // 1-5
  status: SupplierStatus;
  address: string;
  // Purchase Company override (migration 0142 / multi-org letterhead).
  // Default = HOOKKA. Picks which org's letterhead prints on the PO PDF.
  // The legal/AP buyer is always HOOKKA — this is cosmetic.
  purchaseOrgCode: string;
};

type SupplierSKU = {
  id: string;
  internalRMCode: string;
  materialName: string; // = our internal description
  supplierId: string;
  supplierName?: string; // resolved for display/filter
  supplierSku: string; // = supplier's code
  supplierDescription: string; // = supplier's description (Wei Siang 2026-05-10)
  unitPriceSen: number;
  currency: string;
  leadTimeDays: number;
  moq: number;
  isMainSupplier: boolean;
  validFrom: string;
  validTo: string;
};

// ============================================================
// Mock Data
// ============================================================
const _MOCK_SUPPLIERS: Supplier[] = [
  {
    id: "sup-001",
    code: "SUP-001",
    name: "Kain Sdn Bhd",
    contactPerson: "Ahmad Razak",
    phone: "+60 12-345 6789",
    email: "ahmad@kainsb.com",
    paymentTerms: "NET30",
    rating: 4,
    status: "ACTIVE",
    address: "12, Jalan Industri 3, Shah Alam, Selangor",
    purchaseOrgCode: "HOOKKA",
  },
  {
    id: "sup-002",
    code: "SUP-002",
    name: "TimberCraft Industries",
    contactPerson: "Lee Wei Ming",
    phone: "+60 16-789 0123",
    email: "weiming@timbercraft.my",
    paymentTerms: "NET45",
    rating: 5,
    status: "ACTIVE",
    address: "Lot 45, Kawasan Perindustrian Meru, Klang",
    purchaseOrgCode: "HOOKKA",
  },
  {
    id: "sup-003",
    code: "SUP-003",
    name: "FoamTech Malaysia",
    contactPerson: "Siti Aminah",
    phone: "+60 13-456 7890",
    email: "siti@foamtech.com.my",
    paymentTerms: "NET30",
    rating: 3,
    status: "ACTIVE",
    address: "8, Jalan Perusahaan 2, Puchong, Selangor",
    purchaseOrgCode: "HOOKKA",
  },
  {
    id: "sup-004",
    code: "SUP-004",
    name: "Spring Works Sdn Bhd",
    contactPerson: "Raj Kumar",
    phone: "+60 17-234 5678",
    email: "raj@springworks.my",
    paymentTerms: "NET15",
    rating: 4,
    status: "ACTIVE",
    address: "22, Persiaran Perindustrian, Rawang",
    purchaseOrgCode: "HOOKKA",
  },
  {
    id: "sup-005",
    code: "SUP-005",
    name: "Metro Hardware Supply",
    contactPerson: "Tan Boon Huat",
    phone: "+60 19-876 5432",
    email: "boonhuat@metrohw.com",
    paymentTerms: "COD",
    rating: 2,
    status: "INACTIVE",
    address: "56, Jalan Besar, Petaling Jaya",
    purchaseOrgCode: "HOOKKA",
  },
];

const _MOCK_SKU: SupplierSKU[] = [
  {
    id: "sku-001",
    internalRMCode: "RM-FAB-001",
    materialName: "Linen Fabric - Beige",
    supplierId: "sup-001",
    supplierSku: "KSB-LIN-BG-01",
    supplierDescription: "Beige Linen Fabric — KS Brothers",
    unitPriceSen: 4500,
    currency: "MYR",
    leadTimeDays: 14,
    moq: 100,
    isMainSupplier: true,
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
  },
  {
    id: "sku-002",
    internalRMCode: "RM-FAB-002",
    materialName: "Velvet Fabric - Navy",
    supplierId: "sup-001",
    supplierSku: "KSB-VEL-NV-01",
    supplierDescription: "Navy Velvet Fabric — KS Brothers",
    unitPriceSen: 7800,
    currency: "MYR",
    leadTimeDays: 21,
    moq: 50,
    isMainSupplier: true,
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
  },
  {
    id: "sku-003",
    internalRMCode: "RM-WD-001",
    materialName: "Rubberwood Frame - 6ft",
    supplierId: "sup-002",
    supplierSku: "TC-RBW-6F-01",
    supplierDescription: "Rubberwood Frame 6ft — Timber Co",
    unitPriceSen: 15000,
    currency: "MYR",
    leadTimeDays: 10,
    moq: 20,
    isMainSupplier: true,
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
  },
  {
    id: "sku-004",
    internalRMCode: "RM-FM-001",
    materialName: "HR Foam 32D - Sheet",
    supplierId: "sup-003",
    supplierSku: "FT-HRF-32D-SH",
    supplierDescription: "HR Foam 32D Sheet — Foam Tech",
    unitPriceSen: 8200,
    currency: "MYR",
    leadTimeDays: 7,
    moq: 50,
    isMainSupplier: true,
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
  },
  {
    id: "sku-005",
    internalRMCode: "RM-SP-001",
    materialName: "Bonnell Spring Unit - Queen",
    supplierId: "sup-004",
    supplierSku: "SW-BSU-QN-01",
    supplierDescription: "Bonnell Spring Unit Queen — Spring Works",
    unitPriceSen: 12500,
    currency: "MYR",
    leadTimeDays: 14,
    moq: 30,
    isMainSupplier: true,
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
  },
  {
    id: "sku-006",
    internalRMCode: "RM-FAB-001",
    materialName: "Linen Fabric - Beige",
    supplierId: "sup-003",
    supplierSku: "FT-LIN-BG-ALT",
    supplierDescription: "Linen Fabric Beige (alt) — Foam Tech",
    unitPriceSen: 4800,
    currency: "MYR",
    leadTimeDays: 18,
    moq: 80,
    isMainSupplier: false,
    validFrom: "2026-01-01",
    validTo: "2026-06-30",
  },
  {
    id: "sku-007",
    internalRMCode: "RM-WD-002",
    materialName: "Plywood Panel - 4x8",
    supplierId: "sup-002",
    supplierSku: "TC-PLY-4X8-01",
    supplierDescription: "Plywood Panel 4x8 — Timber Co",
    unitPriceSen: 6500,
    currency: "MYR",
    leadTimeDays: 5,
    moq: 40,
    isMainSupplier: true,
    validFrom: "2026-02-01",
    validTo: "2026-12-31",
  },
];

// ============================================================
// Helpers
// ============================================================
function statusBadge(status: SupplierStatus) {
  const map: Record<SupplierStatus, { bg: string; text: string; border: string; label: string }> = {
    ACTIVE: { bg: "bg-green-50", text: "text-green-800", border: "border-green-300", label: "Active" },
    INACTIVE: { bg: "bg-gray-100", text: "text-gray-500", border: "border-gray-300", label: "Inactive" },
    BLACKLISTED: { bg: "bg-red-50", text: "text-red-800", border: "border-red-300", label: "Blacklisted" },
  };
  const c = map[status] || map.ACTIVE;
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${c.bg} ${c.text} ${c.border}`}>
      {c.label}
    </span>
  );
}

function ratingStars(rating: number) {
  return (
    <span className="inline-flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <Star
          key={i}
          className={`h-3.5 w-3.5 ${i <= rating ? "text-amber-400 fill-amber-400" : "text-gray-300"}`}
        />
      ))}
    </span>
  );
}

// ============================================================
// Main Page
// ============================================================
type TabId = "suppliers" | "sku-costing";

export default function SupplierMaintenancePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState<TabId>(
    searchParams.get("tab") === "sku-costing" ? "sku-costing" : "suppliers",
  );

  // Supplier state — D1 is source of truth; MOCK_SUPPLIERS kept only as
  // a fallback if the API is unreachable, so the page always renders.
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierSearch, setSupplierSearch] = useState("");
  const [showSupplierForm, setShowSupplierForm] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);

  const { data: suppliersResp } = useCachedJson<{ success?: boolean; data?: Record<string, unknown>[] } | Record<string, unknown>[]>("/api/suppliers");

  // Organisation list — feeds the Purchase Company dropdown + column lookup.
  // We only need code + legal name; other fields live on the org admin page.
  const { data: orgsResp } = useCachedJson<{
    organisations?: Array<{ code: string; name: string; isActive?: boolean }>;
  }>("/api/organisations");
  const orgOptions: OrgOption[] = useMemo(() => {
    const list = orgsResp?.organisations ?? [];
    return list
      .filter((o) => o.isActive !== false)
      .map((o) => ({ code: o.code, name: o.name }));
  }, [orgsResp]);
  // Quick code → legal name lookup for the column pill tooltip.
  const orgNameByCode = useMemo(() => {
    const m: Record<string, string> = {};
    orgOptions.forEach((o) => {
      m[o.code] = o.name;
    });
    return m;
  }, [orgOptions]);

  /* eslint-disable react-hooks/set-state-in-effect -- mirror SWR suppliers data into mutable local state for optimistic UI */
  useEffect(() => {
    const d = suppliersResp;
    if (!d) return;
    const list = Array.isArray((d as { data?: unknown[] })?.data) ? (d as { data: Record<string, unknown>[] }).data : Array.isArray(d) ? (d as Record<string, unknown>[]) : [];
    if (!list.length) return;
    const mapped: Supplier[] = list.map((s: Record<string, unknown>) => ({
      id: String(s.id ?? s.code ?? ""),
      code: String(s.code ?? s.id ?? ""),
      name: String(s.name ?? ""),
      contactPerson: String(s.contactPerson ?? s.attention ?? ""),
      phone: String(s.phone ?? ""),
      email: String(s.email ?? ""),
      paymentTerms: (s.paymentTerms ?? s.creditTerm ?? "NET30") as PaymentTerms,
      rating: Number(s.rating ?? 0),
      status: ((s.status ?? (s.isActive === false ? "INACTIVE" : "ACTIVE")) as SupplierStatus),
      address: String(
        s.address ??
          [s.addressLine1, s.addressLine2, s.addressLine3, s.addressLine4]
            .filter(Boolean)
            .join(", ") ??
          "",
      ),
      // Falls back to HOOKKA for pre-0142 rows (the column is missing on
      // the JSON response when the migration hasn't been applied yet).
      purchaseOrgCode: String(s.purchaseOrgCode ?? "HOOKKA"),
    }));
    setSuppliers(mapped);
  }, [suppliersResp]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const { toast } = useToast();

  // SKU state — D1 is source of truth; MOCK_SKU kept only as a silent
  // fallback if the API is unreachable, so the page always renders.
  const [skuList, setSkuList] = useState<SupplierSKU[]>([]);
  const [skuSearch, setSkuSearch] = useState("");
  const [skuSupplierFilter, setSkuSupplierFilter] = useState<string>(
    searchParams.get("supplier") ?? "",
  );
  const [showSKUForm, setShowSKUForm] = useState(false);
  const [editingSKU, setEditingSKU] = useState<SupplierSKU | null>(null);

  // Deep-link from /suppliers/:id detail page: ?action=add pre-opens the
  // SKU form on the SKU & Costing tab. Once consumed, the param is stripped
  // from the URL so a refresh doesn't re-open the dialog. The tab + supplier
  // filter params are handled at useState init above so they survive refresh.
  const consumedDeepLinkRef = useRef(false);
  /* eslint-disable react-hooks/set-state-in-effect -- one-shot: opens dialog from URL on first mount */
  useEffect(() => {
    if (consumedDeepLinkRef.current) return;
    if (searchParams.get("action") !== "add") return;
    consumedDeepLinkRef.current = true;
    setActiveTab("sku-costing");
    setEditingSKU(null);
    setShowSKUForm(true);
    const next = new URLSearchParams(searchParams);
    next.delete("action");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // D1 exposes this under /api/supplier-materials (the legacy mock was
  // /api/supplier-skus which never became a real endpoint). Map the
  // D1 binding shape into the page's SupplierSKU type.
  const { data: smResp } = useCachedJson<{ success?: boolean; data?: Record<string, unknown>[] } | Record<string, unknown>[]>("/api/supplier-materials");

  /* eslint-disable react-hooks/set-state-in-effect -- mirror SWR supplier-material bindings into mutable local state */
  useEffect(() => {
    const d = smResp;
    if (!d) return;
    const raw = Array.isArray((d as { data?: unknown[] })?.data)
      ? (d as { data: Record<string, unknown>[] }).data
      : Array.isArray(d)
        ? (d as Record<string, unknown>[])
        : [];
    const mapped: SupplierSKU[] = raw.map((b: Record<string, unknown>) => ({
      id: String(b.id ?? ""),
      internalRMCode: String(b.materialCode ?? ""),
      materialName: String(b.materialName ?? ""),
      supplierId: String(b.supplierId ?? ""),
      supplierName: b.supplierName ? String(b.supplierName) : undefined,
      supplierSku: String(b.supplierSku ?? ""),
      supplierDescription: String(b.supplierDescription ?? ""),
      // The /api/supplier-materials route returns `unitPrice` already in sen
      // (the supplier_material_bindings.unitPrice column is INTEGER sen — see
      // migrations/0001_init.sql + scripts/import-historical-purchases.py
      // which inserts `unit_price * 100`). Treat it as sen directly; do NOT
      // multiply by 100 again or the column renders 100× too high.
      unitPriceSen:
        typeof b.unitPriceSen === "number"
          ? b.unitPriceSen
          : typeof b.unitPrice === "number"
            ? Math.round(b.unitPrice)
            : 0,
      currency: String(b.currency ?? "MYR"),
      leadTimeDays: Number(b.leadTimeDays ?? 7),
      moq: Number(b.moq ?? 0),
      isMainSupplier: Boolean(b.isMainSupplier),
      validFrom: String(b.priceValidFrom ?? b.validFrom ?? ""),
      validTo: String(b.priceValidTo ?? b.validTo ?? ""),
    }));
    setSkuList(mapped);
  }, [smResp]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Inventory items for RM code selector
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  const { data: invResp } = useCachedJson<{ success?: boolean; data?: { rawMaterials?: InventoryItem[]; finishedGoods?: InventoryItem[]; wipItems?: InventoryItem[] } }>("/api/inventory");
  /* eslint-disable react-hooks/set-state-in-effect -- flatten inventory categories into the SKU selector's pool */
  useEffect(() => {
    const d = invResp;
    if (d?.success && d.data) {
      const all: InventoryItem[] = [
        ...(d.data.rawMaterials || []),
        ...(d.data.finishedGoods || []),
        ...(d.data.wipItems || []),
      ].map((item: InventoryItem) => ({
        id: item.id,
        itemCode: item.itemCode,
        description: item.description,
        baseUOM: item.baseUOM,
        itemGroup: item.itemGroup,
      }));
      setInventoryItems(all);
    }
  }, [invResp]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Supplier name lookup
  const supplierMap = useMemo(() => {
    const map: Record<string, string> = {};
    suppliers.forEach((s) => { map[s.id] = s.name; });
    return map;
  }, [suppliers]);

  // Resolve supplier names into SKU data for filter/display
  const resolvedSkuList = useMemo(() => {
    return skuList.map((s) => ({ ...s, supplierName: supplierMap[s.supplierId] || s.supplierId }));
  }, [skuList, supplierMap]);

  // ---- Supplier Tab ----
  const filteredSuppliers = useMemo(() => {
    if (!supplierSearch) return suppliers;
    const q = supplierSearch.toLowerCase();
    return suppliers.filter(
      (s) =>
        s.code.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.contactPerson.toLowerCase().includes(q) ||
        s.phone.includes(q)
    );
  }, [suppliers, supplierSearch]);

  const supplierColumns: Column<Supplier>[] = useMemo(
    () => [
      { key: "code", label: "Code", type: "docno", width: "100px", sortable: true },
      { key: "name", label: "Supplier Name", type: "text", sortable: true },
      { key: "contactPerson", label: "Contact Person", type: "text", width: "150px", sortable: true },
      { key: "phone", label: "Phone", type: "text", width: "150px" },
      { key: "paymentTerms", label: "Terms", type: "text", width: "90px", sortable: true },
      {
        key: "purchaseOrgCode",
        label: "Purchase Company",
        width: "140px",
        sortable: true,
        render: (_val: unknown, row: Supplier) => {
          const code = row.purchaseOrgCode || "HOOKKA";
          const fullName = orgNameByCode[code] || code;
          const tone =
            code === "HOOKKA"
              ? "bg-[#1F1D1B]/10 text-[#1F1D1B] border-[#1F1D1B]/30"
              : code === "OHANA"
                ? "bg-[#6B5C32]/10 text-[#6B5C32] border-[#6B5C32]/30"
                : "bg-[#8B7A4E]/10 text-[#8B7A4E] border-[#8B7A4E]/30";
          return (
            <span
              title={fullName}
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold border ${tone}`}
            >
              {code}
            </span>
          );
        },
      },
      {
        key: "rating",
        label: "Rating",
        width: "120px",
        sortable: true,
        render: (_val: unknown, row: Supplier) => ratingStars(row.rating),
      },
      {
        key: "status",
        label: "Status",
        width: "110px",
        sortable: true,
        render: (_val: unknown, row: Supplier) => statusBadge(row.status),
      },
      {
        key: "actions",
        label: "Actions",
        width: "80px",
        align: "right",
        render: (_val: unknown, row: Supplier) => (
          <div className="flex items-center justify-end">
            <Button
              variant="ghost"
              size="icon"
              title="Edit supplier"
              onClick={(e) => {
                e.stopPropagation();
                setEditingSupplier(row);
                setShowSupplierForm(true);
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          </div>
        ),
      },
    ],
    [orgNameByCode]
  );

  const supplierContextMenu = useMemo(
    () =>
      (row: Supplier): ContextMenuItem[] => [
        {
          label: "View Scorecard",
          icon: <TrendingUp className="h-3.5 w-3.5" />,
          action: () => navigate(`/suppliers/${row.id}`),
        },
        {
          label: "Edit",
          icon: <Pencil className="h-3.5 w-3.5" />,
          action: () => { setEditingSupplier(row); setShowSupplierForm(true); },
        },
        { label: "", separator: true, action: () => {} },
        {
          label: "Delete",
          icon: <Trash2 className="h-3.5 w-3.5" />,
          danger: true,
          action: async () => {
            const id = row.id;
            // Optimistic remove, then persist AND surface failure. invalidateCache
            // re-reads the server so a failed delete reappears (no silent loss).
            setSuppliers((prev) => prev.filter((s) => s.id !== id));
            try {
              const res = await fetch(`/api/suppliers/${id}`, { method: "DELETE" });
              if (!res.ok) {
                const b = (await res.json().catch(() => ({}))) as { error?: string };
                toast.error(b.error || `Delete failed (${res.status})`);
              }
            } catch {
              toast.error("Delete failed — network error");
            }
            invalidateCache("/api/suppliers");
          },
        },
      ],
    [navigate, toast]
  );

  const handleSaveSupplier = async (data: Omit<Supplier, "id">) => {
    // Optimistic update for instant UX, then persist. A FAILED save now shows
    // a red error and invalidateCache re-reads the server so the optimistic
    // row reconciles (no more silent "looked saved but wasn't").
    let ok = false;
    let errMsg = "";
    if (editingSupplier) {
      const id = editingSupplier.id;
      setSuppliers((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...data } : s))
      );
      try {
        const res = await fetch(`/api/suppliers/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        ok = res.ok;
        if (!ok) {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          errMsg = b.error || `HTTP ${res.status}`;
        }
      } catch {
        errMsg = "network error";
      }
    } else {
      const tempId = `sup-${Date.now()}`;
      const newSupplier: Supplier = { ...data, id: tempId };
      setSuppliers((prev) => [...prev, newSupplier]);
      try {
        const res = await fetch("/api/suppliers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        ok = res.ok;
        if (ok) {
          const body = (await res.json().catch(() => ({}))) as {
            data?: { id?: string };
          };
          const realId = body.data?.id;
          if (realId) {
            setSuppliers((prev) =>
              prev.map((s) => (s.id === tempId ? { ...s, id: realId } : s)),
            );
          }
        } else {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          errMsg = b.error || `HTTP ${res.status}`;
        }
      } catch {
        errMsg = "network error";
      }
    }
    invalidateCache("/api/suppliers");
    if (ok) {
      toast.success("Supplier saved");
      setShowSupplierForm(false);
      setEditingSupplier(null);
    } else {
      // Keep the form open so the operator can retry — do NOT pretend it saved.
      toast.error(`Save failed: ${errMsg}`);
    }
  };

  // ---- SKU Tab ----
  // Per-supplier counts for the dropdown — Wei Siang 2026-05-10:
  // 969 rows in one flat list is unusable; pick a supplier to scope.
  const skuCountBySupplierId = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of resolvedSkuList) {
      m.set(s.supplierId, (m.get(s.supplierId) ?? 0) + 1);
    }
    return m;
  }, [resolvedSkuList]);

  const filteredSKU = useMemo(() => {
    let rows = resolvedSkuList;
    if (skuSupplierFilter) {
      rows = rows.filter((s) => s.supplierId === skuSupplierFilter);
    }
    if (skuSearch) {
      const q = skuSearch.toLowerCase();
      rows = rows.filter(
        (s) =>
          s.internalRMCode.toLowerCase().includes(q) ||
          s.materialName.toLowerCase().includes(q) ||
          s.supplierSku.toLowerCase().includes(q) ||
          s.supplierDescription.toLowerCase().includes(q) ||
          (s.supplierName || "").toLowerCase().includes(q)
      );
    }
    return rows;
  }, [resolvedSkuList, skuSearch, skuSupplierFilter]);

  const skuColumns: Column<SupplierSKU>[] = useMemo(
    () => [
      { key: "internalRMCode", label: "Internal Code", type: "docno", width: "130px", sortable: true },
      { key: "materialName", label: "Internal Description", type: "text", sortable: true },
      {
        key: "supplierName",
        label: "Supplier",
        type: "text",
        width: "160px",
        sortable: true,
      },
      { key: "supplierSku", label: "Supplier Code", type: "text", width: "140px", sortable: true },
      { key: "supplierDescription", label: "Supplier Description", type: "text", sortable: true },
      {
        key: "unitPriceSen",
        label: "Unit Price",
        type: "currency",
        width: "110px",
        sortable: true,
      },
      { key: "currency", label: "Currency", type: "text", width: "80px" },
      {
        key: "leadTimeDays",
        label: "Lead Time",
        width: "90px",
        sortable: true,
        render: (val: unknown) => <span>{val as number}d</span>,
      },
      { key: "moq", label: "MOQ", type: "number", width: "70px", sortable: true },
      {
        key: "isMainSupplier",
        label: "Main",
        width: "70px",
        sortable: true,
        render: (_val: unknown, row: SupplierSKU) =>
          row.isMainSupplier ? (
            <Badge className="bg-green-50 text-green-800 border-green-300">Main</Badge>
          ) : (
            <span className="text-gray-400 text-xs">-</span>
          ),
      },
      {
        key: "validFrom",
        label: "Valid Period",
        width: "160px",
        render: (_val: unknown, row: SupplierSKU) => (
          <span className="text-xs text-gray-500">
            {formatDate(row.validFrom)} - {formatDate(row.validTo)}
          </span>
        ),
      },
    ],
    [supplierMap]
  );

  const skuContextMenu = useMemo(
    () =>
      (row: SupplierSKU): ContextMenuItem[] => [
        {
          label: "Edit",
          icon: <Pencil className="h-3.5 w-3.5" />,
          action: () => { setEditingSKU(row); setShowSKUForm(true); },
        },
        { label: "", separator: true, action: () => {} },
        {
          label: "Delete",
          icon: <Trash2 className="h-3.5 w-3.5" />,
          danger: true,
          action: async () => {
            const id = row.id;
            // Optimistic remove, then persist AND surface failure. invalidateCache
            // re-reads the server so a failed delete reappears (no silent loss).
            setSkuList((prev) => prev.filter((s) => s.id !== id));
            try {
              const res = await fetch(`/api/supplier-materials/${id}`, { method: "DELETE" });
              if (!res.ok) {
                const b = (await res.json().catch(() => ({}))) as { error?: string };
                toast.error(b.error || `Delete failed (${res.status})`);
              }
            } catch {
              toast.error("Delete failed — network error");
            }
            invalidateCache("/api/supplier-materials");
          },
        },
      ],
    [toast]
  );

  // Map the page's SupplierSKU shape onto the /api/supplier-materials body.
  // unitPrice is sent in SEN (the binding column is integer sen — the same
  // basis the list maps back from, so do NOT multiply by 100).
  const skuToBindingBody = (data: Omit<SupplierSKU, "id">) => ({
    supplierId: data.supplierId,
    materialCode: data.internalRMCode,
    materialName: data.materialName,
    supplierSku: data.supplierSku,
    supplierDescription: data.supplierDescription ?? "",
    unitPrice: data.unitPriceSen,
    currency: data.currency,
    leadTimeDays: data.leadTimeDays,
    moq: data.moq,
    isMainSupplier: data.isMainSupplier,
    priceValidFrom: data.validFrom || undefined,
    priceValidTo: data.validTo || undefined,
  });

  const handleSaveSKU = async (data: Omit<SupplierSKU, "id">) => {
    // Optimistic local update for instant UX, then persist. A FAILED save now
    // shows a red error and invalidateCache re-reads the server so a non-saved
    // edit reconciles (no more silent "looked saved but bounced back").
    let ok = false;
    let errMsg = "";
    if (editingSKU) {
      const id = editingSKU.id;
      setSkuList((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...data } : s))
      );
      try {
        const res = await fetch(`/api/supplier-materials/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(skuToBindingBody(data)),
        });
        ok = res.ok;
        if (!ok) {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          errMsg = b.error || `HTTP ${res.status}`;
        }
      } catch {
        errMsg = "network error";
      }
    } else {
      const tempId = `sku-${Date.now()}`;
      setSkuList((prev) => [...prev, { ...data, id: tempId }]);
      try {
        const res = await fetch("/api/supplier-materials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(skuToBindingBody(data)),
        });
        ok = res.ok;
        if (ok) {
          const body = (await res.json().catch(() => ({}))) as {
            data?: { id?: string };
          };
          const realId = body.data?.id;
          if (realId) {
            setSkuList((prev) =>
              prev.map((s) => (s.id === tempId ? { ...s, id: realId } : s))
            );
          }
        } else {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          errMsg = b.error || `HTTP ${res.status}`;
        }
      } catch {
        errMsg = "network error";
      }
    }
    invalidateCache("/api/supplier-materials");
    if (ok) {
      toast.success("SKU mapping saved");
      setShowSKUForm(false);
      setEditingSKU(null);
    } else {
      // Keep the form open so the operator can retry — do NOT pretend it saved.
      toast.error(`Save failed: ${errMsg}`);
    }
  };

  // KPIs
  const activeSuppliers = suppliers.filter((s) => s.status === "ACTIVE").length;
  const totalMappings = skuList.length;
  const mainSupplierCount = skuList.filter((s) => s.isMainSupplier).length;
  const avgRating = suppliers.length > 0
    ? (suppliers.reduce((sum, s) => sum + s.rating, 0) / suppliers.length).toFixed(1)
    : "0";

  const tabs = [
    { key: "suppliers" as const, label: "Supplier Information", icon: <Building2 className="h-4 w-4" /> },
    { key: "sku-costing" as const, label: "Supplier SKU & Costing", icon: <Package className="h-4 w-4" /> },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-[#1F1D1B]">Supplier Maintenance</h1>
        <p className="text-xs text-[#6B7280] mt-0.5">
          Manage supplier information and material SKU mappings
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Active Suppliers</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{activeSuppliers}</p>
            </div>
            <Building2 className="h-5 w-5 text-[#6B5C32]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">SKU Mappings</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{totalMappings}</p>
            </div>
            <Package className="h-5 w-5 text-[#6B5C32]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Main Suppliers</p>
              <p className="text-xl font-bold text-[#1F1D1B]">{mainSupplierCount}</p>
            </div>
            <CheckCircle2 className="h-5 w-5 text-green-500" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-2.5 flex items-center justify-between">
            <div>
              <p className="text-xs text-[#6B7280]">Avg Rating</p>
              <p className="text-xl font-bold text-amber-600">{avgRating}</p>
            </div>
            <Star className="h-5 w-5 text-amber-400 fill-amber-400" />
          </CardContent>
        </Card>
      </div>

      {/* Tab Buttons */}
      <div className="flex gap-1 border-b border-[#E2DDD8]">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.key
                ? "border-[#6B5C32] text-[#6B5C32]"
                : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* ===== TAB 1: Supplier Information ===== */}
      {activeTab === "suppliers" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="w-80">
              <Input
                placeholder="Search code, name, contact..."
                value={supplierSearch}
                onChange={(e) => setSupplierSearch(e.target.value)}
              />
            </div>
            <Button variant="primary" onClick={() => { setEditingSupplier(null); setShowSupplierForm(true); }}>
              <Plus className="h-4 w-4" />
              Add Supplier
            </Button>
          </div>

          <DataGrid<Supplier>
            columns={supplierColumns}
            data={filteredSuppliers}
            keyField="id"
            virtualize
            gridId="supplier-info"
            contextMenuItems={supplierContextMenu}
            onDoubleClick={(row) => navigate(`/suppliers/${row.id}`)}
            emptyMessage="No suppliers found."
            stickyHeader
            maxHeight="calc(100vh - 420px)"
          />
        </div>
      )}

      {/* ===== TAB 2: Supplier SKU & Costing ===== */}
      {activeTab === "sku-costing" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <select
                value={skuSupplierFilter}
                onChange={(e) => setSkuSupplierFilter(e.target.value)}
                className="h-10 px-3 rounded border border-[#D8D2CC] bg-white text-sm min-w-[260px]"
                title="Filter SKU mappings by supplier"
              >
                <option value="">
                  All suppliers ({resolvedSkuList.length})
                </option>
                {[...suppliers]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((s) => {
                    const n = skuCountBySupplierId.get(s.id) ?? 0;
                    return (
                      <option key={s.id} value={s.id}>
                        {s.name} ({n})
                      </option>
                    );
                  })}
              </select>
              <div className="w-72">
                <Input
                  placeholder="Search internal code, description, supplier code..."
                  value={skuSearch}
                  onChange={(e) => setSkuSearch(e.target.value)}
                />
              </div>
            </div>
            <Button variant="primary" onClick={() => { setEditingSKU(null); setShowSKUForm(true); }}>
              <Plus className="h-4 w-4" />
              Add SKU Mapping
            </Button>
          </div>

          <DataGrid<SupplierSKU>
            columns={skuColumns}
            data={filteredSKU}
            keyField="id"
            virtualize
            gridId="supplier-sku-costing"
            contextMenuItems={skuContextMenu}
            onDoubleClick={(row) => { setEditingSKU(row); setShowSKUForm(true); }}
            emptyMessage="No SKU mappings found."
            stickyHeader
            maxHeight="calc(100vh - 420px)"
          />
        </div>
      )}

      {/* Supplier Form Dialog */}
      {showSupplierForm && (
        <SupplierFormDialog
          editData={editingSupplier}
          orgOptions={orgOptions}
          onSave={handleSaveSupplier}
          onClose={() => { setShowSupplierForm(false); setEditingSupplier(null); }}
        />
      )}

      {/* SKU Form Dialog */}
      {showSKUForm && (
        <SKUFormDialog
          editData={editingSKU}
          suppliers={suppliers}
          inventoryItems={inventoryItems}
          presetSupplierId={editingSKU ? undefined : skuSupplierFilter || undefined}
          onSave={handleSaveSKU}
          onClose={() => { setShowSKUForm(false); setEditingSKU(null); }}
        />
      )}
    </div>
  );
}
