// ---------------------------------------------------------------------------
// Supplier Form Dialog — shared between /procurement/maintenance (supplier
// list: Add + Edit) and /suppliers/:id (detail page: Edit Supplier). Extracted
// 2026-06-02 so the supplier detail page can edit supplier info inline without
// duplicating the form code, mirroring how sku-form-dialog.tsx was extracted.
// Behaviour is unchanged from the previous inline definition in maintenance.tsx.
// ---------------------------------------------------------------------------
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PhoneInput } from "@/components/ui/phone-input";
import { isValidEmail } from "@/lib/contact-format";
import { X } from "lucide-react";

export type SupplierStatus = "ACTIVE" | "INACTIVE" | "BLACKLISTED";
export type PaymentTerms = "NET15" | "NET30" | "NET45" | "NET60" | "COD";

export type OrgOption = {
  code: string;
  name: string;
};

// The fields the form collects + emits. The list page's richer Supplier type
// (id, code, rating, etc.) is a superset; only these fields are edited here.
export type SupplierFormData = {
  code: string;
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  address: string;
  paymentTerms: PaymentTerms;
  rating: number;
  status: SupplierStatus;
  purchaseOrgCode: string;
};

// editData only needs to provide the editable fields plus rating (preserved on
// edit). Callers can pass any object that structurally satisfies this — the
// list page's Supplier and the detail page's mapped supplier both do.
export type SupplierFormEditData = {
  code?: string;
  name?: string;
  contactPerson?: string;
  phone?: string;
  email?: string;
  address?: string;
  paymentTerms?: PaymentTerms;
  rating?: number;
  status?: SupplierStatus;
  purchaseOrgCode?: string;
};

export function SupplierFormDialog({
  editData,
  orgOptions,
  onSave,
  onClose,
}: {
  editData?: SupplierFormEditData | null;
  orgOptions: OrgOption[];
  onSave: (data: SupplierFormData) => void;
  onClose: () => void;
}) {
  const [code, setCode] = useState(editData?.code || "");
  const [name, setName] = useState(editData?.name || "");
  const [contactPerson, setContactPerson] = useState(editData?.contactPerson || "");
  const [phone, setPhone] = useState(editData?.phone || "");
  const [email, setEmail] = useState(editData?.email || "");
  const [address, setAddress] = useState(editData?.address || "");
  const [paymentTerms, setPaymentTerms] = useState<PaymentTerms>(editData?.paymentTerms || "NET30");
  const [status, setStatus] = useState<SupplierStatus>(editData?.status || "ACTIVE");
  // Purchase Company override — which org's letterhead prints on the PO.
  // Default HOOKKA so existing suppliers / new suppliers without an
  // explicit choice print under HOOKKA INDUSTRIES like they always did.
  const [purchaseOrgCode, setPurchaseOrgCode] = useState<string>(
    editData?.purchaseOrgCode || "HOOKKA",
  );
  // Rating is no longer collected on the form. Preserve the existing value on
  // edit; default new suppliers to a neutral 3-star rating. Operators can
  // adjust ratings later via a dedicated path when that workflow exists.
  const rating = editData?.rating ?? 3;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValidEmail(email)) return; // block save on a malformed email
    onSave({ code, name, contactPerson, phone, email, address, paymentTerms, rating, status, purchaseOrgCode });
  };

  // Close on Escape key — operators expect dialog dismissal even when
  // focus is trapped inside an Input.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b border-[#E2DDD8]">
          <h2 className="text-lg font-semibold text-[#1F1D1B]">
            {editData ? "Edit Supplier" : "Add Supplier"}
          </h2>
          <Button type="button" variant="ghost" size="icon" onClick={onClose}>
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
              <label className="block text-sm font-medium text-[#374151] mb-1">Contact Person</label>
              <Input value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} placeholder="Full name" />
            </div>
            <div>
              <label className="block text-sm font-medium text-[#374151] mb-1">Phone</label>
              <PhoneInput value={phone} onChange={(v) => setPhone(v)} />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-[#374151] mb-1">Email</label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@example.com" className={!isValidEmail(email) ? "border-[#9A3A2D]" : undefined} />
            {!isValidEmail(email) ? <span className="text-[11px] text-[#9A3A2D]">Enter a valid email address</span> : null}
          </div>
          <div>
            <label className="block text-sm font-medium text-[#374151] mb-1">Address</label>
            <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Full address" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[#374151] mb-1">
              Purchase Company
            </label>
            <select
              className="w-full border border-[#D1D5DB] rounded-md px-3 py-2 text-sm bg-white"
              value={purchaseOrgCode}
              onChange={(e) => setPurchaseOrgCode(e.target.value)}
              title="Letterhead that prints on this supplier's PO PDF. HOOKKA is always the legal buyer."
            >
              {orgOptions.length === 0 ? (
                <option value="HOOKKA">HOOKKA INDUSTRIES SDN BHD</option>
              ) : (
                orgOptions.map((o) => (
                  <option key={o.code} value={o.code}>
                    {o.code} — {o.name}
                  </option>
                ))
              )}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              Frontend-only override. HOOKKA INDUSTRIES is always the legal
              buyer / AP entity on the books.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
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
