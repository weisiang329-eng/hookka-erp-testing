// ---------------------------------------------------------------------------
// KycPanel — account-opening / KYC block on the customer detail (owner
// 2026-07-30). Before extending credit we collect a consent letter + TIN +
// e-Invoice id + SSM. Records what we have + when docs were requested, so a new
// hire sees at a glance what's still outstanding. Talks to
// /api/customer-crm/onboarding.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from "react";
import { ShieldCheck, Send, Check } from "lucide-react";

type Onboarding = {
  tin_number: string | null;
  einvoice_id: string | null;
  consent_received: number | null;
  consent_date: string | null;
  docs_requested_at: string | null;
  notes: string | null;
} | null;

export function KycPanel({ customerId }: { customerId: string }) {
  const [form, setForm] = useState({ tinNumber: "", einvoiceId: "", consentReceived: false, consentDate: "", notes: "" });
  const [requestedAt, setRequestedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await fetch(`/api/customer-crm/onboarding?customerId=${encodeURIComponent(customerId)}`);
      const j = (await r.json()) as { success: boolean; data?: Onboarding };
      const d = j.data;
      if (d) {
        setForm({
          tinNumber: d.tin_number ?? "",
          einvoiceId: d.einvoice_id ?? "",
          consentReceived: !!d.consent_received,
          consentDate: d.consent_date ?? "",
          notes: d.notes ?? "",
        });
        setRequestedAt(d.docs_requested_at ?? null);
      }
    } catch {
      /* ignore */
    }
  }, [customerId]);

  /* eslint-disable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */
  useEffect(() => {
    void reload();
  }, [customerId]);
  /* eslint-enable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

  const save = async (extra?: { docsRequestedAt?: string }) => {
    setSaving(true);
    try {
      await fetch("/api/customer-crm/onboarding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, ...form, ...extra }),
      });
      if (extra?.docsRequestedAt) setRequestedAt(extra.docsRequestedAt);
      setSavedTick(true);
      // eslint-disable-next-line no-restricted-syntax -- transient "Saved" tick, not timing-critical
      setTimeout(() => setSavedTick(false), 1500);
    } finally {
      setSaving(false);
    }
  };

  const inputCls = "border border-[#E2DDD8] rounded-lg px-2.5 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]";

  return (
    <div className="rounded-xl border border-[#E2DDD8] bg-white p-5 mt-4">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-[#6B5C32]" />
          <h3 className="font-semibold text-[#1F1D1B]">Onboarding / KYC</h3>
        </div>
        {requestedAt ? (
          <span className="text-[11px] text-[#6B7280]">Docs requested {requestedAt.slice(0, 10)}</span>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-[#6B7280] flex flex-col gap-1">
          TIN number
          <input className={inputCls} value={form.tinNumber} onChange={(e) => setForm({ ...form, tinNumber: e.target.value })} placeholder="C1234567890" />
        </label>
        <label className="text-xs text-[#6B7280] flex flex-col gap-1">
          e-Invoice ID
          <input className={inputCls} value={form.einvoiceId} onChange={(e) => setForm({ ...form, einvoiceId: e.target.value })} />
        </label>
        <label className="text-xs text-[#6B7280] flex items-center gap-2 col-span-2 mt-1">
          <input type="checkbox" checked={form.consentReceived} onChange={(e) => setForm({ ...form, consentReceived: e.target.checked })} className="accent-[#6B5C32]" />
          Consent letter received
          {form.consentReceived && (
            <input type="date" className={`${inputCls} ml-2`} value={form.consentDate} onChange={(e) => setForm({ ...form, consentDate: e.target.value })} />
          )}
        </label>
        <label className="text-xs text-[#6B7280] flex flex-col gap-1 col-span-2">
          Notes
          <input className={inputCls} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="e.g. waiting on SSM copy" />
        </label>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          disabled={saving}
          onClick={() => void save()}
          className="px-4 py-2 rounded-lg bg-[#1F1D1B] text-white text-sm font-medium disabled:opacity-50 hover:bg-[#3a3633] flex items-center gap-2"
        >
          {savedTick ? <><Check className="w-4 h-4" /> Saved</> : "Save"}
        </button>
        <button
          disabled={saving}
          onClick={() => void save({ docsRequestedAt: new Date().toISOString() })}
          className="px-4 py-2 rounded-lg border border-[#E2DDD8] text-sm text-[#6B5C32] hover:bg-[#F0ECE9] flex items-center gap-2"
          title="Record that you've asked the customer for TIN / e-Invoice / SSM / consent letter"
        >
          <Send className="w-3.5 h-3.5" /> Mark docs requested
        </button>
      </div>
    </div>
  );
}
