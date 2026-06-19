import { useMemo, useState, useCallback, useEffect } from "react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Building2,
  Save,
  CheckCircle,
  ArrowRight,
  Plus,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { useConfirm } from "@/components/ui/confirm-dialog";

// Letterhead override registry. The Inter-Company Configuration card below
// is HOOKKA-OHANA-specific (transfer pricing %), but the top grid of cards
// is fully dynamic — operators can add HOUZS / any new sister company.
// Switching a supplier to print under that org swaps the letterhead on the
// PDF only; the actual legal/AP buyer is always HOOKKA.

type Organisation = {
  id: string;
  code: string;
  name: string;
  regNo: string;
  tin: string;
  msic: string;
  msicCode: string;
  address: string;
  phone: string;
  email: string;
  businessType: string;
  letterheadUrl: string;
  transferPricingPct: number;
  isActive: boolean;
  isDefault: boolean;
  displayOrder: number;
};

type InterCompanyConfig = {
  hookkaToOhanaRate: number;
  autoCreateMirrorDocs: boolean;
};

type FormState = {
  code: string;
  name: string;
  regNo: string;
  tin: string;
  msicCode: string;
  phone: string;
  email: string;
  address: string;
  businessType: string;
  isDefault: boolean;
};

const EMPTY_FORM: FormState = {
  code: "",
  name: "",
  regNo: "",
  tin: "",
  msicCode: "",
  phone: "",
  email: "",
  address: "",
  businessType: "",
  isDefault: false,
};

export default function OrganisationsPage() {
  const { confirm } = useConfirm();
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [config, setConfig] = useState<InterCompanyConfig>({
    hookkaToOhanaRate: 0.65,
    autoCreateMirrorDocs: true,
  });

  // Modal state — null means closed; "new" means add-mode; otherwise the
  // id of the org being edited.
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  const { data: orgResp, refresh: refreshOrgHook } = useCachedJson<{
    organisations: Organisation[];
    activeOrgId: string;
    interCompanyConfig: InterCompanyConfig;
  }>("/api/organisations");

  const orgs: Organisation[] = useMemo(
    () => orgResp?.organisations ?? [],
    [orgResp],
  );
  const activeOrgId: string = useMemo(
    () => orgResp?.activeOrgId ?? "",
    [orgResp],
  );

  /* eslint-disable react-hooks/set-state-in-effect -- seed editable form from server snapshot once */
  useEffect(() => {
    if (orgResp?.interCompanyConfig) {
      setConfig(orgResp.interCompanyConfig);
    }
  }, [orgResp]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const fetchData = useCallback(() => {
    invalidateCachePrefix("/api/organisations");
    refreshOrgHook();
  }, [refreshOrgHook]);

  const flash = (msg: string) => {
    setSaveMsg(msg);
    // eslint-disable-next-line no-restricted-syntax -- one-shot banner timer
    setTimeout(() => setSaveMsg(null), 3000);
  };

  const openAdd = () => {
    setEditingId("new");
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const openEdit = (org: Organisation) => {
    setEditingId(org.id);
    setForm({
      code: org.code,
      name: org.name,
      regNo: org.regNo,
      tin: org.tin,
      msicCode: org.msicCode || org.msic || "",
      phone: org.phone,
      email: org.email,
      address: org.address,
      businessType: org.businessType,
      isDefault: org.isDefault,
    });
    setFormError(null);
  };

  const closeModal = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const saveForm = async () => {
    if (!form.code.trim() || !form.name.trim()) {
      setFormError("Code and Legal Name are required");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (editingId === "new") {
        const res = await fetch("/api/organisations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: form.code,
            name: form.name,
            regNo: form.regNo,
            tin: form.tin,
            msicCode: form.msicCode,
            phone: form.phone,
            email: form.email,
            address: form.address,
            businessType: form.businessType,
            isDefault: form.isDefault,
          }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setFormError(err.error || "Failed to create organisation");
          setSaving(false);
          return;
        }
        flash("Organisation created");
      } else if (editingId) {
        const res = await fetch(`/api/organisations/${editingId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: form.code,
            name: form.name,
            regNo: form.regNo,
            tin: form.tin,
            msicCode: form.msicCode,
            phone: form.phone,
            email: form.email,
            address: form.address,
            businessType: form.businessType,
            isDefault: form.isDefault,
          }),
        });
        if (!res.ok) {
          const err = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setFormError(err.error || "Failed to update organisation");
          setSaving(false);
          return;
        }
        flash("Organisation updated");
      }
      closeModal();
      await fetchData();
    } finally {
      setSaving(false);
    }
  };

  const deleteOrg = async (org: Organisation) => {
    if (org.isDefault) {
      flash("Cannot delete the default organisation");
      return;
    }
    if (
      !(await confirm({
        title: "Soft-delete organisation?",
        message: `Soft-delete ${org.name}? Existing suppliers / POs that reference this org keep their letterhead override, but it stops appearing in pickers.`,
        danger: true,
      }))
    ) {
      return;
    }
    setSaving(true);
    try {
      await fetch(`/api/organisations/${org.id}`, { method: "DELETE" });
      await fetchData();
      flash("Organisation deactivated");
    } finally {
      setSaving(false);
    }
  };

  const saveConfig = async () => {
    setSaving(true);
    await fetch("/api/organisations", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ interCompanyConfig: config }),
    });
    await fetchData();
    setSaving(false);
    flash("Inter-company config saved");
  };

  const exampleOhanaPrice = 1000;
  const hookkaShare = exampleOhanaPrice * config.hookkaToOhanaRate;
  const ohanaGP = exampleOhanaPrice - hookkaShare;

  const visibleOrgs = orgs.filter((o) => o.isActive);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">
            Organisation Management
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Sister companies whose letterhead can print on a supplier&apos;s
            Purchase Order. HOOKKA is always the actual buyer / AP entity —
            this is a frontend letterhead override.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {saveMsg && (
            <div className="flex items-center gap-2 rounded-md bg-[#EEF3E4] border border-[#C6DBA8] px-4 py-2 text-sm text-[#4F7C3A]">
              <CheckCircle className="h-4 w-4" />
              {saveMsg}
            </div>
          )}
          <button
            onClick={openAdd}
            className="flex items-center gap-2 rounded-md bg-[#1F1D1B] px-4 py-2 text-sm font-medium text-white hover:bg-[#1F1D1B]/90 transition-colors"
          >
            <Plus className="h-4 w-4" />
            Add Organisation
          </button>
        </div>
      </div>

      {/* Organisation Cards */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {visibleOrgs.map((org) => {
          const isActiveSwitcher = org.id === activeOrgId;
          // 2-letter avatar derived from the code so new sister companies
          // (HOUZS → HZ, etc.) render without hardcoded branching.
          const initials =
            org.code === "HOOKKA"
              ? "HI"
              : org.code === "OHANA"
                ? "OM"
                : org.code.slice(0, 2);
          const avatarColour =
            org.code === "HOOKKA"
              ? "bg-[#1F1D1B]"
              : org.code === "OHANA"
                ? "bg-[#6B5C32]"
                : "bg-[#8B7A4E]";
          return (
            <Card
              key={org.id}
              className={
                isActiveSwitcher ? "ring-2 ring-[#6B5C32] ring-offset-2" : ""
              }
            >
              <CardHeader className="pb-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={`h-10 w-10 rounded-lg flex items-center justify-center text-white font-bold text-sm ${avatarColour}`}
                    >
                      {initials}
                    </div>
                    <div>
                      <CardTitle className="text-base">{org.name}</CardTitle>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {org.businessType ||
                          (org.code === "HOOKKA"
                            ? "Production & Manufacturing"
                            : org.code === "OHANA"
                              ? "B2B Trading & Distribution"
                              : "—")}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {org.isDefault && (
                      <span className="text-[10px] font-semibold uppercase tracking-wider bg-[#1F1D1B]/10 text-[#1F1D1B] px-2 py-1 rounded">
                        Default
                      </span>
                    )}
                    {isActiveSwitcher && (
                      <span className="text-[10px] font-semibold uppercase tracking-wider bg-[#6B5C32]/10 text-[#6B5C32] px-2 py-1 rounded">
                        Active
                      </span>
                    )}
                    <button
                      onClick={() => openEdit(org)}
                      className="flex items-center gap-1 text-xs text-[#6B5C32] hover:underline font-medium"
                    >
                      <Pencil className="h-3 w-3" />
                      Edit
                    </button>
                    {!org.isDefault && (
                      <button
                        onClick={() => deleteOrg(org)}
                        className="flex items-center gap-1 text-xs text-red-600 hover:underline font-medium"
                      >
                        <Trash2 className="h-3 w-3" />
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <ReadField label="Company Name" value={org.name} />
                  <ReadField label="Registration No." value={org.regNo} />
                  <ReadField label="TIN" value={org.tin} />
                  <ReadField label="MSIC Code" value={org.msicCode || org.msic} />
                  <ReadField label="Phone" value={org.phone} />
                  <ReadField label="Email" value={org.email} />
                  <div className="col-span-2">
                    <ReadField label="Address" value={org.address} />
                  </div>

                  {/* Transfer Pricing Info — kept inline for HOOKKA/OHANA
                      only since that's the only inter-company flow today. */}
                  {org.transferPricingPct > 0 && (
                    <div className="col-span-2 pt-2 border-t border-[#E2DDD8]">
                      <span className="text-xs text-gray-500">
                        Transfer Pricing
                      </span>
                      <p className="font-medium">{org.transferPricingPct}%</p>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Inter-Company Configuration — HOOKKA ↔ OHANA specific */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Building2 className="h-5 w-5 text-[#6B5C32]" />
            <CardTitle>Inter-Company Configuration (HOOKKA ↔ OHANA)</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Transfer Pricing */}
          <div className="space-y-3">
            <label className="text-sm font-medium text-[#1F1D1B]">
              Transfer Pricing Rate (HOOKKA share of OHANA price)
            </label>
            <div className="flex items-center gap-4">
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={Math.round(config.hookkaToOhanaRate * 100)}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    hookkaToOhanaRate: parseInt(e.target.value) / 100,
                  })
                }
                className="flex-1 accent-[#6B5C32]"
              />
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  onFocus={(e) => e.currentTarget.select()}
                  min={0}
                  max={100}
                  value={Math.round(config.hookkaToOhanaRate * 100)}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      hookkaToOhanaRate:
                        Math.min(
                          100,
                          Math.max(0, parseInt(e.target.value) || 0),
                        ) / 100,
                    })
                  }
                  className="w-16 rounded border border-[#E2DDD8] px-2 py-1 text-sm text-center"
                />
                <span className="text-sm text-gray-500">%</span>
              </div>
            </div>
          </div>

          {/* Transfer Pricing Example */}
          <div className="rounded-lg bg-[#F0ECE9] p-4 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">
              Transfer Pricing Example
            </p>
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-gray-600">Customer buys from OHANA</span>
                <span className="font-semibold text-[#1F1D1B]">
                  RM {exampleOhanaPrice.toLocaleString()} (OHANA Revenue)
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 text-gray-600">
                  <ArrowRight className="h-3.5 w-3.5 text-[#6B5C32]" />
                  OHANA buys from HOOKKA
                </span>
                <span className="font-semibold text-[#1F1D1B]">
                  RM {hookkaShare.toLocaleString()} (
                  {Math.round(config.hookkaToOhanaRate * 100)}% x RM{" "}
                  {exampleOhanaPrice.toLocaleString()})
                </span>
              </div>
              <div className="flex items-center justify-between border-t border-[#E2DDD8] pt-2">
                <span className="font-medium text-gray-700">
                  OHANA Gross Profit
                </span>
                <span className="font-bold text-[#6B5C32]">
                  RM {ohanaGP.toLocaleString()}
                </span>
              </div>
            </div>
          </div>

          {/* Auto Mirror Docs */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-[#1F1D1B]">
                Auto-create mirror documents
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                Automatically generate corresponding PO/SO between HOOKKA and
                OHANA for inter-company transactions
              </p>
            </div>
            <button
              onClick={() =>
                setConfig({
                  ...config,
                  autoCreateMirrorDocs: !config.autoCreateMirrorDocs,
                })
              }
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                config.autoCreateMirrorDocs ? "bg-[#6B5C32]" : "bg-gray-300"
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  config.autoCreateMirrorDocs
                    ? "translate-x-6"
                    : "translate-x-1"
                }`}
              />
            </button>
          </div>

          {/* Save Button */}
          <div className="flex justify-end pt-2">
            <button
              onClick={saveConfig}
              disabled={saving}
              className="flex items-center gap-2 rounded-md bg-[#1F1D1B] px-6 py-2.5 text-sm font-medium text-white hover:bg-[#1F1D1B]/90 disabled:opacity-50 transition-colors"
            >
              <Save className="h-4 w-4" />
              Save Configuration
            </button>
          </div>
        </CardContent>
      </Card>

      {/* Add / Edit Modal */}
      {editingId !== null && (
        <OrganisationFormModal
          mode={editingId === "new" ? "create" : "edit"}
          form={form}
          setForm={setForm}
          error={formError}
          saving={saving}
          onSave={saveForm}
          onClose={closeModal}
        />
      )}
    </div>
  );
}

function ReadField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-xs text-gray-500">{label}</span>
      <p className="font-medium text-[#1F1D1B] mt-0.5 break-words">
        {value || "—"}
      </p>
    </div>
  );
}

function OrganisationFormModal({
  mode,
  form,
  setForm,
  error,
  saving,
  onSave,
  onClose,
}: {
  mode: "create" | "edit";
  form: FormState;
  setForm: (f: FormState) => void;
  error: string | null;
  saving: boolean;
  onSave: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave();
  };

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm({ ...form, [key]: value });
  };

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
            {mode === "create" ? "Add Organisation" : "Edit Organisation"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 hover:bg-gray-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Code *" hint="e.g. HOOKKA, OHANA, HOUZS">
              <input
                type="text"
                value={form.code}
                onChange={(e) =>
                  setField("code", e.target.value.toUpperCase())
                }
                required
                disabled={mode === "edit" && form.code === "HOOKKA"}
                placeholder="HOUZS"
                className="w-full rounded border border-[#D1D5DB] px-3 py-2 text-sm bg-white disabled:bg-gray-50 disabled:text-gray-500"
              />
            </FormField>
            <FormField label="Legal Name *">
              <input
                type="text"
                value={form.name}
                onChange={(e) => setField("name", e.target.value)}
                required
                placeholder="HOUZS TRADING SDN BHD"
                className="w-full rounded border border-[#D1D5DB] px-3 py-2 text-sm"
              />
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Registration No.">
              <input
                type="text"
                value={form.regNo}
                onChange={(e) => setField("regNo", e.target.value)}
                placeholder="202501XXXXXX (XXXXXXX-X)"
                className="w-full rounded border border-[#D1D5DB] px-3 py-2 text-sm"
              />
            </FormField>
            <FormField label="TIN">
              <input
                type="text"
                value={form.tin}
                onChange={(e) => setField("tin", e.target.value)}
                placeholder="C60XXXXXXXXX"
                className="w-full rounded border border-[#D1D5DB] px-3 py-2 text-sm"
              />
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="MSIC Code">
              <input
                type="text"
                value={form.msicCode}
                onChange={(e) => setField("msicCode", e.target.value)}
                placeholder="31009"
                className="w-full rounded border border-[#D1D5DB] px-3 py-2 text-sm"
              />
            </FormField>
            <FormField label="Business Type">
              <input
                type="text"
                value={form.businessType}
                onChange={(e) => setField("businessType", e.target.value)}
                placeholder="B2B Trading & Distribution"
                className="w-full rounded border border-[#D1D5DB] px-3 py-2 text-sm"
              />
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Phone">
              <input
                type="text"
                value={form.phone}
                onChange={(e) => setField("phone", e.target.value)}
                placeholder="+60XX-XXX XXXX"
                className="w-full rounded border border-[#D1D5DB] px-3 py-2 text-sm"
              />
            </FormField>
            <FormField label="Email">
              <input
                type="email"
                value={form.email}
                onChange={(e) => setField("email", e.target.value)}
                placeholder="finance@example.com"
                className="w-full rounded border border-[#D1D5DB] px-3 py-2 text-sm"
              />
            </FormField>
          </div>
          <FormField label="Address">
            <textarea
              value={form.address}
              onChange={(e) => setField("address", e.target.value)}
              rows={2}
              placeholder="Full registered address"
              className="w-full rounded border border-[#D1D5DB] px-3 py-2 text-sm resize-none"
            />
          </FormField>
          <label className="flex items-center gap-2 text-sm text-[#374151]">
            <input
              type="checkbox"
              checked={form.isDefault}
              onChange={(e) => setField("isDefault", e.target.checked)}
              className="accent-[#6B5C32]"
            />
            <span>
              Default organisation (prints on suppliers with no override; cannot
              be deleted)
            </span>
          </label>
          <div className="flex justify-end gap-3 pt-4 border-t border-[#E2DDD8]">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-[#D1D5DB] px-4 py-2 text-sm font-medium text-[#374151] hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-[#1F1D1B] px-4 py-2 text-sm font-medium text-white hover:bg-[#1F1D1B]/90 disabled:opacity-50"
            >
              {mode === "create" ? "Add Organisation" : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function FormField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-[#374151] mb-1">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
    </div>
  );
}
