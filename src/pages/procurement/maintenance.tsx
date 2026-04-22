import { useState, useMemo, useEffect } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataGrid, type Column, type ContextMenuItem } from "@/components/ui/data-grid";
import { formatDate } from "@/lib/utils";
import {
  Plus,
  Building2,
  Star,
  X,
  Package,
  Pencil,
  Trash2,
  CheckCircle2,
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
};

type SupplierSKU = {
  id: string;
  internalRMCode: string;
  materialName: string;
  supplierId: string;
  supplierName?: string; // resolved for display/filter
  supplierSku: string;
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
const MOCK_SUPPLIERS: Supplier[] = [
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
  },
];

const MOCK_SKU: SupplierSKU[] = [
  {
    id: "sku-001",
    internalRMCode: "RM-FAB-001",
    materialName: "Linen Fabric - Beige",
    supplierId: "sup-001",
    supplierSku: "KSB-LIN-BG-01",
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
// Supplier Form Dialog
// ============================================================
function SupplierFormDialog({
  editData,
  onSave,
  onClose,
}: {
  editData?: Supplier | null;
  onSave: (data: Omit<Supplier, "id">) => void;
  onClose: () => void;
}) {
  const [code, setCode] = useState(editData?.code || "");
  const [name, setName] = useState(editData?.name || "");
  const [contactPerson, setContactPerson] = useState(editData?.contactPerson || "");
  const [phone, setPhone] = useState(editData?.phone || "");
  const [email, setEmail] = useState(editData?.email || "");
  const [address, setAddress] = useState(editData?.address || "");
  const [paymentTerms, setPaymentTerms] = useState<PaymentTerms>(editData?.paymentTerms || "NET30");
  const [rating, setRating] = useState(editData?.rating || 3);
  const [status, setStatus] = useState<SupplierStatus>(editData?.status || "ACTIVE");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({ code, name, contactPerson, phone, email, address, paymentTerms, rating, status });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-[#E2DDD8]">
          <h2 className="text-lg font-semibold text-[#1F1D1B]">
            {editData ? "Edit Supplier" : "Add Supplier"}
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Supplier Code *</label>
              <Input value={code} onChange={(e) => setCode(e.target.value)} required placeholder="SUP-XXX" />
            </div>
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Supplier Name *</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} required placeholder="Company name" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Contact Person *</label>
              <Input value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} required placeholder="Full name" />
            </div>
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Phone *</label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} required placeholder="+60 12-XXX XXXX" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-[#374151] mb-1">Email</label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[#374151] mb-1">Address</label>
            <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Full address" />
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Payment Terms</label>
              <select
                className="w-full border border-[#D1D5DB] rounded-md px-3 py-2 text-sm bg-white"
                value={paymentTerms}
                onChange={(e) => setPaymentTerms(e.target.value as PaymentTerms)}
              >
                <option value="COD">COD</option>
                <option value="NET15">Net 15</option>
                <option value="NET30">Net 30</option>
                <option value="NET45">Net 45</option>
                <option value="NET60">Net 60</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Rating</label>
              <select
                className="w-full border border-[#D1D5DB] rounded-md px-3 py-2 text-sm bg-white"
                value={rating}
                onChange={(e) => setRating(Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5].map((r) => (
                  <option key={r} value={r}>{r} Star{r > 1 ? "s" : ""}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Status</label>
              <select
                className="w-full border border-[#D1D5DB] rounded-md px-3 py-2 text-sm bg-white"
                value={status}
                onChange={(e) => setStatus(e.target.value as SupplierStatus)}
              >
                <option value="ACTIVE">Active</option>
                <option value="INACTIVE">Inactive</option>
                <option value="BLACKLISTED">Blacklisted</option>
              </select>
            </div>
          </div>
          <div className="flex justify-end gap-3 pt-4 border-t border-[#E2DDD8]">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary">{editData ? "Update" : "Add Supplier"}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// SKU Costing Form Dialog
// ============================================================
function SKUFormDialog({
  editData,
  suppliers,
  inventoryItems,
  onSave,
  onClose,
}: {
  editData?: SupplierSKU | null;
  suppliers: Supplier[];
  inventoryItems: InventoryItem[];
  onSave: (data: Omit<SupplierSKU, "id">) => void;
  onClose: () => void;
}) {
  const [internalRMCode, setInternalRMCode] = useState(editData?.internalRMCode || "");
  const [materialName, setMaterialName] = useState(editData?.materialName || "");
  const [rmSearch, setRmSearch] = useState("");
  const [showRmDropdown, setShowRmDropdown] = useState(false);

  const filteredInventory = useMemo(() => {
    if (!rmSearch) return inventoryItems.slice(0, 50);
    const q = rmSearch.toLowerCase();
    return inventoryItems.filter(
      (item) => item.itemCode.toLowerCase().includes(q) || item.description.toLowerCase().includes(q)
    ).slice(0, 50);
  }, [inventoryItems, rmSearch]);

  const selectInventoryItem = (item: InventoryItem) => {
    setInternalRMCode(item.itemCode);
    setMaterialName(item.description);
    setShowRmDropdown(false);
    setRmSearch("");
  };
  const [supplierId, setSupplierId] = useState(editData?.supplierId || "");
  const [supplierSku, setSupplierSku] = useState(editData?.supplierSku || "");
  const [unitPrice, setUnitPrice] = useState(editData ? String(editData.unitPriceSen / 100) : "");
  const [currency] = useState(editData?.currency || "MYR");
  const [leadTimeDays, setLeadTimeDays] = useState(editData?.leadTimeDays || 7);
  const [moq, setMoq] = useState(editData?.moq || 1);
  const [isMainSupplier, setIsMainSupplier] = useState(editData?.isMainSupplier || false);
  const [validFrom, setValidFrom] = useState(editData?.validFrom || new Date().toISOString().split("T")[0]);
  const [validTo, setValidTo] = useState(editData?.validTo || "2026-12-31");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      internalRMCode,
      materialName,
      supplierId,
      supplierSku,
      unitPriceSen: Math.round(parseFloat(unitPrice) * 100),
      currency,
      leadTimeDays,
      moq,
      isMainSupplier,
      validFrom,
      validTo,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-[#E2DDD8]">
          <h2 className="text-lg font-semibold text-[#1F1D1B]">
            {editData ? "Edit SKU Mapping" : "Add SKU Mapping"}
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="relative">
              <label className="block text-sm font-medium text-[#374151] mb-1">Internal Code *</label>
              <Input
                value={showRmDropdown ? rmSearch : internalRMCode}
                onChange={(e) => { setRmSearch(e.target.value); setShowRmDropdown(true); }}
                onFocus={() => setShowRmDropdown(true)}
                placeholder="Search FG / WIP / RM..."
                required
                autoComplete="off"
              />
              {showRmDropdown && (
                <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border border-[#E2DDD8] rounded-md shadow-lg max-h-48 overflow-y-auto">
                  {filteredInventory.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-gray-400">No items found</div>
                  ) : (
                    filteredInventory.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="w-full text-left px-3 py-1.5 text-sm hover:bg-[#FAF9F7] flex items-center gap-2 border-b border-[#E2DDD8]/50 last:border-0"
                        onClick={() => selectInventoryItem(item)}
                      >
                        <span className="font-mono text-xs text-[#6B5C32] min-w-[100px]">{item.itemCode}</span>
                        <span className="text-[#374151] truncate">{item.description}</span>
                        <span className="text-[10px] text-gray-400 ml-auto shrink-0">{item.itemGroup}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Material Name *</label>
              <Input value={materialName} onChange={(e) => setMaterialName(e.target.value)} required placeholder="Auto-filled from selection" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Supplier *</label>
              <select
                className="w-full border border-[#D1D5DB] rounded-md px-3 py-2 text-sm bg-white"
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                required
              >
                <option value="">Select supplier...</option>
                {suppliers
                  .filter((s) => s.status === "ACTIVE")
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.code} - {s.name}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Supplier SKU *</label>
              <Input value={supplierSku} onChange={(e) => setSupplierSku(e.target.value)} required placeholder="Supplier's code" />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Unit Price (RM) *</label>
              <Input type="number" step="0.01" min="0" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} required placeholder="0.00" />
            </div>
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Lead Time (days)</label>
              <Input type="number" min="1" value={leadTimeDays} onChange={(e) => setLeadTimeDays(Number(e.target.value))} />
            </div>
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">MOQ</label>
              <Input type="number" min="1" value={moq} onChange={(e) => setMoq(Number(e.target.value))} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Valid From</label>
              <Input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Valid To</label>
              <Input type="date" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="mainSupplier"
              checked={isMainSupplier}
              onChange={(e) => setIsMainSupplier(e.target.checked)}
              className="h-4 w-4 rounded border-[#D1D5DB] text-[#6B5C32] focus:ring-[#6B5C32]"
            />
            <label htmlFor="mainSupplier" className="text-sm font-medium text-[#374151]">
              Main supplier for this material
            </label>
          </div>
          <div className="flex justify-end gap-3 pt-4 border-t border-[#E2DDD8]">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary">{editData ? "Update" : "Add Mapping"}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// Main Page
// ============================================================
type TabId = "suppliers" | "sku-costing";

export default function SupplierMaintenancePage() {
  const [activeTab, setActiveTab] = useState<TabId>("suppliers");

  // Supplier state
  const [suppliers, setSuppliers] = useState<Supplier[]>(MOCK_SUPPLIERS);
  const [supplierSearch, setSupplierSearch] = useState("");
  const [showSupplierForm, setShowSupplierForm] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);

  // SKU state
  const [skuList, setSkuList] = useState<SupplierSKU[]>(MOCK_SKU);
  const [skuSearch, setSkuSearch] = useState("");
  const [showSKUForm, setShowSKUForm] = useState(false);
  const [editingSKU, setEditingSKU] = useState<SupplierSKU | null>(null);

  // Inventory items for RM code selector
  const [inventoryItems, setInventoryItems] = useState<InventoryItem[]>([]);
  useEffect(() => {
    fetch("/api/inventory")
      .then((r) => r.json())
      .then((d) => {
        if (d.success && d.data) {
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
      })
      .catch(() => {});
  }, []);

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
    ],
    []
  );

  const supplierContextMenu = useMemo(
    () =>
      (row: Supplier): ContextMenuItem[] => [
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
          action: () => {
            setSuppliers((prev) => prev.filter((s) => s.id !== row.id));
          },
        },
      ],
    []
  );

  const handleSaveSupplier = (data: Omit<Supplier, "id">) => {
    if (editingSupplier) {
      setSuppliers((prev) =>
        prev.map((s) => (s.id === editingSupplier.id ? { ...s, ...data } : s))
      );
    } else {
      const newSupplier: Supplier = { ...data, id: `sup-${Date.now()}` };
      setSuppliers((prev) => [...prev, newSupplier]);
    }
    setShowSupplierForm(false);
    setEditingSupplier(null);
  };

  // ---- SKU Tab ----
  const filteredSKU = useMemo(() => {
    if (!skuSearch) return resolvedSkuList;
    const q = skuSearch.toLowerCase();
    return resolvedSkuList.filter(
      (s) =>
        s.internalRMCode.toLowerCase().includes(q) ||
        s.materialName.toLowerCase().includes(q) ||
        s.supplierSku.toLowerCase().includes(q) ||
        (s.supplierName || "").toLowerCase().includes(q)
    );
  }, [resolvedSkuList, skuSearch]);

  const skuColumns: Column<SupplierSKU>[] = useMemo(
    () => [
      { key: "internalRMCode", label: "Internal RM Code", type: "docno", width: "130px", sortable: true },
      { key: "materialName", label: "Material Name", type: "text", sortable: true },
      {
        key: "supplierName",
        label: "Supplier",
        type: "text",
        width: "160px",
        sortable: true,
      },
      { key: "supplierSku", label: "Supplier SKU", type: "text", width: "140px", sortable: true },
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
          action: () => {
            setSkuList((prev) => prev.filter((s) => s.id !== row.id));
          },
        },
      ],
    []
  );

  const handleSaveSKU = (data: Omit<SupplierSKU, "id">) => {
    if (editingSKU) {
      setSkuList((prev) =>
        prev.map((s) => (s.id === editingSKU.id ? { ...s, ...data } : s))
      );
    } else {
      const newSKU: SupplierSKU = { ...data, id: `sku-${Date.now()}` };
      setSkuList((prev) => [...prev, newSKU]);
    }
    setShowSKUForm(false);
    setEditingSKU(null);
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
        <h1 className="text-2xl font-bold text-[#1F1D1B]">Supplier Maintenance</h1>
        <p className="text-sm text-[#6B7280] mt-1">
          Manage supplier information and material SKU mappings
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid gap-4 grid-cols-1 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-[#6B7280]">Active Suppliers</p>
              <p className="text-2xl font-bold text-[#1F1D1B]">{activeSuppliers}</p>
            </div>
            <Building2 className="h-5 w-5 text-[#6B5C32]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-[#6B7280]">SKU Mappings</p>
              <p className="text-2xl font-bold text-[#1F1D1B]">{totalMappings}</p>
            </div>
            <Package className="h-5 w-5 text-[#6B5C32]" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-[#6B7280]">Main Suppliers</p>
              <p className="text-2xl font-bold text-[#1F1D1B]">{mainSupplierCount}</p>
            </div>
            <CheckCircle2 className="h-5 w-5 text-green-500" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-sm text-[#6B7280]">Avg Rating</p>
              <p className="text-2xl font-bold text-amber-600">{avgRating}</p>
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
            gridId="supplier-info"
            contextMenuItems={supplierContextMenu}
            onDoubleClick={(row) => { setEditingSupplier(row); setShowSupplierForm(true); }}
            emptyMessage="No suppliers found."
            stickyHeader
            maxHeight="calc(100vh - 420px)"
          />
        </div>
      )}

      {/* ===== TAB 2: Supplier SKU & Costing ===== */}
      {activeTab === "sku-costing" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="w-80">
              <Input
                placeholder="Search RM code, material, supplier SKU..."
                value={skuSearch}
                onChange={(e) => setSkuSearch(e.target.value)}
              />
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
          onSave={handleSaveSKU}
          onClose={() => { setShowSKUForm(false); setEditingSKU(null); }}
        />
      )}
    </div>
  );
}
