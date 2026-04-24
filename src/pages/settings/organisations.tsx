import { useMemo, useState, useCallback } from "react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Building2,
  Save,
  CheckCircle,
  ArrowRight,
} from "lucide-react";

type Organisation = {
  id: string;
  code: "HOOKKA" | "OHANA";
  name: string;
  regNo: string;
  tin: string;
  msic: string;
  address: string;
  phone: string;
  email: string;
  transferPricingPct: number;
  isActive: boolean;
};

type InterCompanyConfig = {
  hookkaToOhanaRate: number;
  autoCreateMirrorDocs: boolean;
};

export default function OrganisationsPage() {
  const [editingOrg, setEditingOrg] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Partial<Organisation>>({});
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const { data: orgResp, refresh: refreshOrgHook } = useCachedJson<{ organisations: Organisation[]; activeOrgId: string; interCompanyConfig: InterCompanyConfig }>("/api/organisations");

  const orgs: Organisation[] = useMemo(() => orgResp?.organisations ?? [], [orgResp]);
  const activeOrgId: string = useMemo(() => orgResp?.activeOrgId ?? "", [orgResp]);
  const config: InterCompanyConfig = useMemo(
    () => orgResp?.interCompanyConfig ?? { hookkaToOhanaRate: 0.65, autoCreateMirrorDocs: true },
    [orgResp]
  );

  const fetchData = useCallback(() => {
    invalidateCachePrefix("/api/organisations");
    refreshOrgHook();
  }, [refreshOrgHook]);

  const startEdit = (org: Organisation) => {
    setEditingOrg(org.id);
    setEditForm({
      name: org.name,
      regNo: org.regNo,
      tin: org.tin,
      address: org.address,
      phone: org.phone,
      email: org.email,
    });
  };

  const cancelEdit = () => {
    setEditingOrg(null);
    setEditForm({});
  };

  const saveOrg = async (orgId: string) => {
    setSaving(true);
    const org = orgs.find((o) => o.id === orgId);
    if (!org) return;
    await fetch("/api/organisations", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organisation: { ...org, ...editForm, id: orgId } }),
    });
    setEditingOrg(null);
    setEditForm({});
    await fetchData();
    setSaving(false);
    flash("Organisation updated");
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

  const flash = (msg: string) => {
    setSaveMsg(msg);
    setTimeout(() => setSaveMsg(null), 3000);
  };

  const exampleOhanaPrice = 1000;
  const hookkaShare = exampleOhanaPrice * config.hookkaToOhanaRate;
  const ohanaGP = exampleOhanaPrice - hookkaShare;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#1F1D1B]">
            Organisation Management
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage company details, registration info, and inter-company
            configuration
          </p>
        </div>
        {saveMsg && (
          <div className="flex items-center gap-2 rounded-md bg-[#EEF3E4] border border-[#C6DBA8] px-4 py-2 text-sm text-[#4F7C3A]">
            <CheckCircle className="h-4 w-4" />
            {saveMsg}
          </div>
        )}
      </div>

      {/* Organisation Cards */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {orgs.map((org) => {
          const isEditing = editingOrg === org.id;
          const isActive = org.id === activeOrgId;
          return (
            <Card
              key={org.id}
              className={
                isActive
                  ? "ring-2 ring-[#6B5C32] ring-offset-2"
                  : ""
              }
            >
              <CardHeader className="pb-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={`h-10 w-10 rounded-lg flex items-center justify-center text-white font-bold text-sm ${
                        org.code === "HOOKKA"
                          ? "bg-[#1F1D1B]"
                          : "bg-[#6B5C32]"
                      }`}
                    >
                      {org.code === "HOOKKA" ? "HI" : "OM"}
                    </div>
                    <div>
                      <CardTitle className="text-base">{org.name}</CardTitle>
                      <p className="text-xs text-gray-500 mt-0.5">
                        {org.code === "HOOKKA"
                          ? "Production & Manufacturing"
                          : "B2B Trading & Distribution"}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {isActive && (
                      <span className="text-[10px] font-semibold uppercase tracking-wider bg-[#6B5C32]/10 text-[#6B5C32] px-2 py-1 rounded">
                        Active
                      </span>
                    )}
                    {!isEditing ? (
                      <button
                        onClick={() => startEdit(org)}
                        className="text-xs text-[#6B5C32] hover:underline font-medium"
                      >
                        Edit
                      </button>
                    ) : (
                      <div className="flex gap-2">
                        <button
                          onClick={cancelEdit}
                          className="text-xs text-gray-500 hover:underline"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => saveOrg(org.id)}
                          disabled={saving}
                          className="flex items-center gap-1 text-xs bg-[#1F1D1B] text-white px-3 py-1 rounded hover:bg-[#1F1D1B]/90 disabled:opacity-50"
                        >
                          <Save className="h-3 w-3" />
                          Save
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <Field
                    label="Company Name"
                    value={org.name}
                    editing={isEditing}
                    editValue={editForm.name}
                    onChange={(v) => setEditForm({ ...editForm, name: v })}
                  />
                  <Field
                    label="Registration No."
                    value={org.regNo}
                    editing={isEditing}
                    editValue={editForm.regNo}
                    onChange={(v) => setEditForm({ ...editForm, regNo: v })}
                  />
                  <Field
                    label="TIN"
                    value={org.tin}
                    editing={isEditing}
                    editValue={editForm.tin}
                    onChange={(v) => setEditForm({ ...editForm, tin: v })}
                  />
                  <Field label="MSIC Code" value={org.msic} editing={false} />
                  <Field
                    label="Phone"
                    value={org.phone}
                    editing={isEditing}
                    editValue={editForm.phone}
                    onChange={(v) => setEditForm({ ...editForm, phone: v })}
                  />
                  <Field
                    label="Email"
                    value={org.email}
                    editing={isEditing}
                    editValue={editForm.email}
                    onChange={(v) => setEditForm({ ...editForm, email: v })}
                  />
                  <div className="col-span-2">
                    <Field
                      label="Address"
                      value={org.address}
                      editing={isEditing}
                      editValue={editForm.address}
                      onChange={(v) => setEditForm({ ...editForm, address: v })}
                    />
                  </div>

                  {/* Transfer Pricing Info */}
                  <div className="col-span-2 pt-2 border-t border-[#E2DDD8]">
                    <div className="flex items-center gap-4">
                      {org.transferPricingPct > 0 && (
                        <div>
                          <span className="text-xs text-gray-500">
                            Transfer Pricing
                          </span>
                          <p className="font-medium">
                            {org.transferPricingPct}%
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Inter-Company Configuration */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <Building2 className="h-5 w-5 text-[#6B5C32]" />
            <CardTitle>Inter-Company Configuration</CardTitle>
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
                  min={0}
                  max={100}
                  value={Math.round(config.hookkaToOhanaRate * 100)}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      hookkaToOhanaRate:
                        Math.min(100, Math.max(0, parseInt(e.target.value) || 0)) / 100,
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
                <span className="text-gray-600">
                  Customer buys from OHANA
                </span>
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
                config.autoCreateMirrorDocs
                  ? "bg-[#6B5C32]"
                  : "bg-gray-300"
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
    </div>
  );
}

function Field({
  label,
  value,
  editing,
  editValue,
  onChange,
}: {
  label: string;
  value: string;
  editing: boolean;
  editValue?: string;
  onChange?: (v: string) => void;
}) {
  return (
    <div>
      <span className="text-xs text-gray-500">{label}</span>
      {editing && onChange ? (
        <input
          type="text"
          value={editValue ?? value}
          onChange={(e) => onChange(e.target.value)}
          className="mt-0.5 w-full rounded border border-[#E2DDD8] px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
        />
      ) : (
        <p className="font-medium text-[#1F1D1B] mt-0.5">{value}</p>
      )}
    </div>
  );
}
