// ---------------------------------------------------------------------------
// SKU Form Dialog — shared between /procurement/maintenance (global SKU tab)
// and /suppliers/:id (per-supplier SKU management). Extracted Wei Siang
// 2026-05-10 so the supplier detail page can edit mappings inline without
// duplicating the form code.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X } from "lucide-react";

export type SupplierSKU = {
  id: string;
  internalRMCode: string;
  materialName: string; // = our internal description
  supplierId: string;
  supplierName?: string;
  supplierSku: string; // = supplier's code
  supplierDescription: string; // = supplier's description
  unitPriceSen: number;
  currency: string;
  leadTimeDays: number;
  moq: number;
  isMainSupplier: boolean;
  validFrom: string;
  validTo: string;
};

export type SkuFormSupplier = {
  id: string;
  code: string;
  name: string;
  status: string; // "ACTIVE" | "INACTIVE" | "BLACKLISTED"
};

export type SkuFormInventoryItem = {
  id: string;
  itemCode: string;
  description: string;
  baseUOM: string;
  itemGroup: string;
};

export function SKUFormDialog({
  editData,
  suppliers,
  inventoryItems,
  onSave,
  onClose,
  presetSupplierId,
}: {
  editData?: SupplierSKU | null;
  suppliers: SkuFormSupplier[];
  inventoryItems: SkuFormInventoryItem[];
  onSave: (data: Omit<SupplierSKU, "id">) => void;
  onClose: () => void;
  // When opened from the supplier detail page the supplier dropdown is
  // pre-selected so operator doesn't have to pick again.
  presetSupplierId?: string;
}) {
  const [internalRMCode, setInternalRMCode] = useState(editData?.internalRMCode || "");
  const [materialName, setMaterialName] = useState(editData?.materialName || "");
  const [rmSearch, setRmSearch] = useState("");
  const [showRmDropdown, setShowRmDropdown] = useState(false);
  const rmDropdownRef = useRef<HTMLDivElement>(null);
  // Parallel search state for the Internal Description field — the owner
  // records materials by code OR by description and wants to search by
  // whichever he remembers. Mirrors the Internal Code field exactly.
  const [descSearch, setDescSearch] = useState("");
  const [showDescDropdown, setShowDescDropdown] = useState(false);
  const descDropdownRef = useRef<HTMLDivElement>(null);

  // Close the inventory dropdown on outside click. Without this it stayed
  // open indefinitely once focused, overlaying the Cancel + Add Mapping
  // buttons further down the form.
  useEffect(() => {
    if (!showRmDropdown) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rmDropdownRef.current && !rmDropdownRef.current.contains(e.target as Node)) {
        setShowRmDropdown(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [showRmDropdown]);

  // Same outside-click-close behavior for the description search dropdown.
  useEffect(() => {
    if (!showDescDropdown) return;
    const onMouseDown = (e: MouseEvent) => {
      if (descDropdownRef.current && !descDropdownRef.current.contains(e.target as Node)) {
        setShowDescDropdown(false);
      }
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [showDescDropdown]);

  const filteredInventory = useMemo(() => {
    if (!rmSearch) return inventoryItems.slice(0, 50);
    const q = rmSearch.toLowerCase();
    return inventoryItems
      .filter(
        // Guard against items missing a code or description — an undefined
        // value here threw "Cannot read properties of undefined (reading
        // 'toLowerCase')" and crashed the whole page the moment the operator
        // typed. Matches on EITHER internal code OR internal description.
        (item) =>
          (item.itemCode || "").toLowerCase().includes(q) ||
          (item.description || "").toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [inventoryItems, rmSearch]);

  // Same filter, driven off the description search box. Also matches on code
  // OR description so picking by either term fills both fields.
  const filteredInventoryByDesc = useMemo(() => {
    if (!descSearch) return inventoryItems.slice(0, 50);
    const q = descSearch.toLowerCase();
    return inventoryItems
      .filter(
        (item) =>
          (item.itemCode || "").toLowerCase().includes(q) ||
          (item.description || "").toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [inventoryItems, descSearch]);

  const selectInventoryItem = (item: SkuFormInventoryItem) => {
    setInternalRMCode(item.itemCode);
    setMaterialName(item.description);
    setShowRmDropdown(false);
    setRmSearch("");
    setShowDescDropdown(false);
    setDescSearch("");
  };
  const [supplierId, setSupplierId] = useState(
    editData?.supplierId || presetSupplierId || "",
  );
  const [supplierSku, setSupplierSku] = useState(editData?.supplierSku || "");
  const [supplierDescription, setSupplierDescription] = useState(
    editData?.supplierDescription || "",
  );
  const [unitPrice, setUnitPrice] = useState(editData ? String(editData.unitPriceSen / 100) : "");
  const [currency] = useState(editData?.currency || "MYR");
  const [leadTimeDays, setLeadTimeDays] = useState(editData?.leadTimeDays || 7);
  const [moq, setMoq] = useState(editData?.moq || 1);
  const [isMainSupplier, setIsMainSupplier] = useState(editData?.isMainSupplier || false);
  // Valid From / To default to blank for a new mapping — the operator fills
  // them only when a price has a real validity window. (Editing keeps whatever
  // was stored.)
  const [validFrom, setValidFrom] = useState(editData?.validFrom || "");
  const [validTo, setValidTo] = useState(editData?.validTo || "");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave({
      internalRMCode,
      materialName,
      supplierId,
      supplierSku,
      supplierDescription,
      unitPriceSen: Math.round(parseFloat(unitPrice) * 100),
      currency,
      leadTimeDays,
      moq,
      isMainSupplier,
      validFrom,
      validTo,
    });
  };

  // Close on Escape key — operators expect dialog dismissal even when focus
  // is trapped inside an Input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-[#E2DDD8]">
          <h2 className="text-lg font-semibold text-[#1F1D1B]">
            {editData ? "Edit SKU Mapping" : "Add SKU Mapping"}
          </h2>
          <Button type="button" variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-6">
          {/* Internal material — the code search owns a full-width row so its
              dropdown spans the whole dialog and descriptions stay readable. */}
          <div className="space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[#6B5C32]">
              Internal Material
            </h3>
            <div className="relative" ref={rmDropdownRef}>
              <label className="block text-sm font-medium text-[#374151] mb-1">Internal Code *</label>
              <Input
                value={showRmDropdown ? rmSearch : internalRMCode}
                onChange={(e) => {
                  setRmSearch(e.target.value);
                  setShowRmDropdown(true);
                }}
                onFocus={() => setShowRmDropdown(true)}
                placeholder="Search by code or description (FG / WIP / RM)..."
                required
                autoComplete="off"
              />
              {showRmDropdown && (
                <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border border-[#E2DDD8] rounded-md shadow-lg max-h-64 overflow-y-auto">
                  {filteredInventory.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-gray-400">No items found</div>
                  ) : (
                    filteredInventory.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="w-full text-left px-3 py-2 hover:bg-[#FAF9F7] flex items-center gap-3 border-b border-[#E2DDD8]/50 last:border-0"
                        onClick={() => selectInventoryItem(item)}
                      >
                        {/* Description is the primary line so the operator can
                            scan/search by it; the code sits underneath as a
                            muted sub-label. App font throughout (no monospace). */}
                        <span className="flex-1 min-w-0">
                          <span className="block truncate text-sm text-[#1F1D1B]">{item.description}</span>
                          <span className="block truncate text-xs text-[#9CA3AF]">{item.itemCode}</span>
                        </span>
                        <span className="text-[10px] text-gray-400 shrink-0">{item.itemGroup}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
            <div className="relative" ref={descDropdownRef}>
              <label className="block text-sm font-medium text-[#374151] mb-1">Internal Description *</label>
              <Input
                value={showDescDropdown ? descSearch : materialName}
                onChange={(e) => {
                  setDescSearch(e.target.value);
                  setShowDescDropdown(true);
                }}
                onFocus={() => setShowDescDropdown(true)}
                placeholder="Search by description..."
                required
                autoComplete="off"
              />
              {showDescDropdown && (
                <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border border-[#E2DDD8] rounded-md shadow-lg max-h-64 overflow-y-auto">
                  {filteredInventoryByDesc.length === 0 ? (
                    <div className="px-3 py-2 text-sm text-gray-400">No items found</div>
                  ) : (
                    filteredInventoryByDesc.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="w-full text-left px-3 py-2 hover:bg-[#FAF9F7] flex items-center gap-3 border-b border-[#E2DDD8]/50 last:border-0"
                        onClick={() => selectInventoryItem(item)}
                      >
                        {/* Description is the primary line so the operator can
                            scan/search by it; the code sits underneath as a
                            muted sub-label. App font throughout (no monospace). */}
                        <span className="flex-1 min-w-0">
                          <span className="block truncate text-sm text-[#1F1D1B]">{item.description}</span>
                          <span className="block truncate text-xs text-[#9CA3AF]">{item.itemCode}</span>
                        </span>
                        <span className="text-[10px] text-gray-400 shrink-0">{item.itemGroup}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Supplier details */}
          <div className="space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[#6B5C32]">
              Supplier Details
            </h3>
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
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1">Supplier Code *</label>
                <Input
                  value={supplierSku}
                  onChange={(e) => setSupplierSku(e.target.value)}
                  required
                  placeholder="Supplier's SKU / part number"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1">Supplier Description</label>
                <Input
                  value={supplierDescription}
                  onChange={(e) => setSupplierDescription(e.target.value)}
                  placeholder="As printed on supplier PI / quote"
                />
              </div>
            </div>
          </div>

          {/* Pricing & terms */}
          <div className="space-y-4">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-[#6B5C32]">
              Pricing &amp; Terms
            </h3>
            <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Unit Price (RM) *</label>
              <Input
                type="number"
                onFocus={(e) => e.currentTarget.select()}
                step="0.01"
                min="0"
                value={unitPrice}
                onChange={(e) => setUnitPrice(e.target.value)}
                required
                placeholder="0.00"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Lead Time (days)</label>
              <Input
                type="number"
                onFocus={(e) => e.currentTarget.select()}
                min="1"
                value={leadTimeDays}
                onChange={(e) => setLeadTimeDays(Number(e.target.value))}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">MOQ</label>
              <Input
                type="number"
                onFocus={(e) => e.currentTarget.select()}
                min="1"
                value={moq}
                onChange={(e) => setMoq(Number(e.target.value))}
              />
            </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1">Valid From</label>
                <Input
                  type="date"
                  value={validFrom}
                  onChange={(e) => setValidFrom(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-[#374151] mb-1">Valid To</label>
                <Input
                  type="date"
                  value={validTo}
                  onChange={(e) => setValidTo(e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center gap-2 pt-1">
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
