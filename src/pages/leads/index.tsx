// ---------------------------------------------------------------------------
// Sales Pipeline (Leads) — the pre-sale funnel board (owner 2026-07-30).
// Columns per stage; cards move NEW → … → WON / LOST by DRAG or the stage
// dropdown. Clicking a card opens a full Lead detail drawer that mounts the
// same CRM panels a Customer has (Contacts, Activity timeline, KYC)
// keyed on the lead id — so a lead holds every detail and ANY salesperson can
// take over. See docs/plans/2026-07-30-crm-unified-customer.md.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Phone, Mail, Trash2, CalendarClock, X, GripVertical, Tag } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { CrmPanel } from "@/components/customer/CrmPanel";
import { KycPanel } from "@/components/customer/KycPanel";
import { PhoneInput } from "@/components/ui/phone-input";
import { StateSelect } from "@/components/ui/state-select";
import { isValidEmail } from "@/lib/contact-format";
import { familyOf } from "@/lib/product-family";

type Lead = {
  id: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  source: string | null;
  stage: string;
  est_value_sen: number | null;
  notes: string | null;
  next_follow_up: string | null;
  lost_reason: string | null;
  won_customer_id?: string | null;
  /** The POTENTIAL customer minted with this lead (owner 2026-08-01). */
  customer_id?: string | null;
  created_at?: string | null;
};

// Stage LABELS are display-only; `key` is the value persisted in sales_leads.stage
// (and the LEAD_STAGES contract in api/routes/sales-leads.ts), so renaming a label
// never needs a data migration. Owner 2026-08-01: the funnel now speaks the same
// language as the Customer module — a lead enters as Potential and becomes a
// Confirmed customer, so "New/Won/Lost" became "Potential/Confirmed/Dropped".
// This array is the single source of every stage label on the page (kanban
// columns, the card stage picker, the drawer badge, the move menu) — change it
// here and nowhere else.
const STAGES = [
  { key: "NEW", label: "Potential", accent: "#6B7280", soft: "#F3F4F6" },
  { key: "CONTACTED", label: "Contacted", accent: "#2563EB", soft: "#EAF1FE" },
  { key: "QUOTED", label: "Quoted", accent: "#B45309", soft: "#FBF0E0" },
  { key: "NEGOTIATING", label: "Negotiating", accent: "#7C3AED", soft: "#F1EBFD" },
  { key: "WON", label: "Confirmed", accent: "#15803D", soft: "#E7F4EC" },
  { key: "LOST", label: "Dropped", accent: "#9A3A2D", soft: "#F9E7E3" },
] as const;

const SOURCES = ["Walk-in", "Referral", "Facebook", "WhatsApp", "Website", "Exhibition", "Other"];

// Credit terms for the convert approval gate. Phone / state / email use the
// shared system-wide inputs (PhoneInput / StateSelect / isValidEmail).
const TERMS = ["CASH", "NET30", "NET60", "NET90"];

const EMPTY = { name: "", company: "", phone: "", email: "", source: "Referral", estValue: "", nextFollowUp: "", notes: "" };

// Email shape check — delegates to the system-wide shared validator so every
// form (Leads, Customers, Suppliers, Hubs) accepts identically.
function emailValid(v: string): boolean {
  return isValidEmail(v);
}

async function getLeads(): Promise<Lead[]> {
  try {
    const r = await fetch("/api/sales-leads");
    const j = (await r.json()) as { success: boolean; data?: Lead[] };
    return j.success && j.data ? j.data : [];
  } catch {
    return [];
  }
}

type FollowUp = { id: string; summary: string | null; customer_name?: string | null; contact_name: string | null; next_follow_up: string | null };
async function getFollowUps(): Promise<FollowUp[]> {
  try {
    const r = await fetch("/api/customer-crm/follow-ups");
    const j = (await r.json()) as { success: boolean; data?: FollowUp[] };
    return j.success && j.data ? j.data : [];
  } catch {
    return [];
  }
}

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [followUps, setFollowUps] = useState<FollowUp[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  const [saving, setSaving] = useState(false);
  const [openLeadId, setOpenLeadId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverStage, setDragOverStage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const [ls, fu] = await Promise.all([getLeads(), getFollowUps()]);
    setLeads(ls);
    setFollowUps(fu);
    setLoaded(true);
  }, []);

  /* eslint-disable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */
  useEffect(() => {
    void reload();
  }, []);
  /* eslint-enable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

  const byStage = useMemo(() => {
    const m: Record<string, Lead[]> = {};
    for (const s of STAGES) m[s.key] = [];
    for (const l of leads) (m[l.stage] ?? m.NEW).push(l);
    return m;
  }, [leads]);

  const openValueSen = useMemo(
    () => leads.filter((l) => l.stage !== "WON" && l.stage !== "LOST").reduce((s, l) => s + (l.est_value_sen ?? 0), 0),
    [leads],
  );
  const wonValueSen = useMemo(() => byStage.WON.reduce((s, l) => s + (l.est_value_sen ?? 0), 0), [byStage]);
  const openLead = useMemo(() => leads.find((l) => l.id === openLeadId) ?? null, [leads, openLeadId]);

  const addLead = async () => {
    if (!form.name.trim() && !form.company.trim()) return;
    if (!emailValid(form.email)) return;
    setSaving(true);
    try {
      await fetch("/api/sales-leads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          company: form.company,
          phone: form.phone,
          email: form.email,
          source: form.source,
          nextFollowUp: form.nextFollowUp,
          notes: form.notes,
          estValueSen: Math.round((parseFloat(form.estValue) || 0) * 100),
        }),
      });
      setForm({ ...EMPTY });
      setShowAdd(false);
      await reload();
    } finally {
      setSaving(false);
    }
  };

  const moveStage = useCallback(async (lead: Lead, stage: string) => {
    if (lead.stage === stage) return;
    let lostReason: string | null = null;
    if (stage === "LOST") {
      lostReason = window.prompt("Why is this lead being dropped? (price / lead time / style / …)") || "";
    }
    // Optimistic move so the drag feels instant; reconcile from the server after.
    setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, stage, lost_reason: lostReason ?? l.lost_reason } : l)));
    await fetch(`/api/sales-leads/${lead.id}/stage`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage, lostReason }),
    });
    await reload();
  }, [reload]);

  const delLead = async (id: string) => {
    await fetch(`/api/sales-leads/${id}`, { method: "DELETE" });
    if (openLeadId === id) setOpenLeadId(null);
    await reload();
  };

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-[#1F1D1B] tracking-tight">Sales Pipeline</h1>
          <p className="text-sm text-[#6B7280] mt-0.5">Drag a card between columns to move a deal. Click it to log everything — so anyone can take over.</p>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wide text-[#9CA3AF]">Open pipeline</div>
            <div className="text-lg font-semibold text-[#1F1D1B]">{formatCurrency(openValueSen / 100)}</div>
          </div>
          <div className="text-right">
            <div className="text-[11px] uppercase tracking-wide text-[#9CA3AF]">Confirmed</div>
            <div className="text-lg font-semibold text-[#15803D]">{formatCurrency(wonValueSen / 100)}</div>
          </div>
          <button
            onClick={() => setShowAdd(true)}
            className="h-10 px-4 rounded-lg bg-[#1F1D1B] text-white text-sm font-medium hover:bg-[#3a3633] flex items-center gap-2 shadow-sm transition-colors"
          >
            <Plus className="w-4 h-4" /> New Potential
          </button>
        </div>
      </div>

      {/* Follow-ups due — who to contact now (from customer activity timelines) */}
      {followUps.length > 0 && (
        <div className="mb-6 rounded-xl border border-[#E7DFC9] bg-[#FBF7EA] p-4">
          <div className="flex items-center gap-2 mb-2">
            <CalendarClock className="w-4 h-4 text-[#6B5C32]" />
            <span className="text-sm font-semibold text-[#1F1D1B]">{followUps.length} follow-up{followUps.length > 1 ? "s" : ""} due</span>
            <span className="text-xs text-[#9CA3AF]">— who to contact now</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {followUps.slice(0, 12).map((f) => (
              <div key={f.id} className="text-xs bg-white border border-[#E2DDD8] rounded-lg px-3 py-1.5">
                <span className="font-medium text-[#1F1D1B]">{f.customer_name ?? "—"}</span>
                {f.summary ? <span className="text-[#6B7280]"> · {f.summary}</span> : null}
                <span className="ml-2 text-[#6B5C32]">{f.next_follow_up?.slice(0, 10)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Board */}
      <div className="flex gap-4 overflow-x-auto pb-4">
        {STAGES.map((s, si) => (
          <div
            key={s.key}
            className="flex-shrink-0 w-[300px]"
            onDragOver={(e) => { if (dragId) { e.preventDefault(); setDragOverStage(s.key); } }}
            onDragLeave={() => setDragOverStage((cur) => (cur === s.key ? null : cur))}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData("text/plain") || dragId;
              const lead = leads.find((l) => l.id === id);
              setDragId(null);
              setDragOverStage(null);
              if (lead) void moveStage(lead, s.key);
            }}
          >
            <div className="flex items-center justify-between mb-3 px-1">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: s.accent }} />
                <span className="text-sm font-semibold text-[#1F1D1B]">{s.label}</span>
              </div>
              <span className="text-xs text-[#9CA3AF] tabular-nums">{byStage[s.key].length}</span>
            </div>
            <div
              className="rounded-xl p-2 min-h-[120px] space-y-2 transition-all"
              style={{ background: s.soft, outline: dragOverStage === s.key ? `2px dashed ${s.accent}` : "2px dashed transparent", outlineOffset: "-2px" }}
            >
              {loaded && byStage[s.key].length === 0 && (
                <p className="text-xs text-center text-[#9CA3AF] py-6">{dragOverStage === s.key ? "Drop here" : "—"}</p>
              )}
              {byStage[s.key].map((l, li) => (
                <div
                  key={l.id}
                  draggable
                  onDragStart={(e) => { setDragId(l.id); e.dataTransfer.setData("text/plain", l.id); e.dataTransfer.effectAllowed = "move"; }}
                  onDragEnd={() => { setDragId(null); setDragOverStage(null); }}
                  onClick={() => setOpenLeadId(l.id)}
                  className={`group rounded-lg bg-white border border-[#E2DDD8] p-3 shadow-sm hover:shadow-md transition-all cursor-pointer ${dragId === l.id ? "opacity-40" : ""}`}
                  style={{ borderLeft: `3px solid ${s.accent}`, animation: `crmfade .35s ease both`, animationDelay: `${si * 40 + li * 25}ms` }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex items-start gap-1.5">
                      <GripVertical className="w-3.5 h-3.5 text-[#D1CCC6] mt-0.5 flex-shrink-0 group-hover:text-[#9CA3AF]" />
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-[#1F1D1B] truncate">{l.company || l.name || "—"}</div>
                        {l.company && l.name ? <div className="text-xs text-[#6B7280] truncate">{l.name}</div> : null}
                      </div>
                    </div>
                    {l.est_value_sen ? (
                      <span className="text-xs font-semibold text-[#6B5C32] whitespace-nowrap">{formatCurrency((l.est_value_sen ?? 0) / 100)}</span>
                    ) : null}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#6B7280] pl-5">
                    {l.phone ? <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{l.phone}</span> : null}
                    {l.email ? <span className="flex items-center gap-1"><Mail className="w-3 h-3" />{l.email}</span> : null}
                    {l.source ? <span className="px-1.5 py-0.5 rounded bg-[#F0ECE9] text-[#6B5C32]">{l.source}</span> : null}
                    {l.next_follow_up ? <span className="flex items-center gap-1 text-[#6B5C32]"><CalendarClock className="w-3 h-3" />{l.next_follow_up}</span> : null}
                  </div>
                  {l.lost_reason ? <div className="mt-1 text-[11px] text-[#9A3A2D] italic pl-5">Dropped: {l.lost_reason}</div> : null}
                  <div className="mt-2 flex items-center justify-between opacity-0 group-hover:opacity-100 transition-opacity pl-5" onClick={(e) => e.stopPropagation()}>
                    <select
                      value={l.stage}
                      onChange={(e) => void moveStage(l, e.target.value)}
                      className="text-[11px] border border-[#E2DDD8] rounded px-1.5 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
                    >
                      {STAGES.map((st) => <option key={st.key} value={st.key}>{st.label}</option>)}
                    </select>
                    <button onClick={() => void delLead(l.id)} className="text-[#9A3A2D] hover:bg-[#F9E1DA] rounded p-1"><Trash2 className="w-3.5 h-3.5" /></button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Lead detail drawer — full CRM record on a lead (takeover-ready) */}
      {openLead && (
        <LeadDetailDrawer
          lead={openLead}
          onClose={() => setOpenLeadId(null)}
          onSaved={reload}
          onMoveStage={(stage) => moveStage(openLead, stage)}
        />
      )}

      {/* Add-lead modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setShowAdd(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-[#1F1D1B]">New potential customer</h2>
              <button onClick={() => setShowAdd(false)} className="text-[#9CA3AF] hover:text-[#1F1D1B]"><X className="w-5 h-5" /></button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {([
                ["company", "Company", "col-span-2"],
                ["name", "Contact person", ""],
                ["phone", "Phone", ""],
                ["email", "Email", "col-span-2"],
                ["estValue", "Est. value (RM)", ""],
              ] as const).map(([k, label, cls]) => (
                <label key={k} className={`text-xs text-[#6B7280] flex flex-col gap-1 ${cls}`}>
                  {label}
                  {k === "phone" ? (
                    <PhoneInput value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
                  ) : (
                    <input
                      value={form[k]}
                      onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                      className={`border rounded-lg px-2.5 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32] ${k === "email" && !emailValid(form.email) ? "border-[#9A3A2D]" : "border-[#E2DDD8]"}`}
                    />
                  )}
                  {k === "email" && !emailValid(form.email) ? <span className="text-[10px] text-[#9A3A2D]">Enter a valid email address</span> : null}
                </label>
              ))}
              <label className="text-xs text-[#6B7280] flex flex-col gap-1">
                Source
                <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} className="border border-[#E2DDD8] rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]">
                  {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="text-xs text-[#6B7280] flex flex-col gap-1 col-span-2">
                Next follow-up
                <input type="date" value={form.nextFollowUp} onChange={(e) => setForm({ ...form, nextFollowUp: e.target.value })} className="border border-[#E2DDD8] rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]" />
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setShowAdd(false)} className="px-4 py-2 rounded-lg border border-[#E2DDD8] text-sm text-[#6B7280] hover:bg-[#F0ECE9]">Cancel</button>
              <button disabled={saving || (!form.name.trim() && !form.company.trim()) || !emailValid(form.email)} onClick={() => void addLead()} className="px-4 py-2 rounded-lg bg-[#1F1D1B] text-white text-sm font-medium disabled:opacity-50 hover:bg-[#3a3633]">Add potential</button>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes crmfade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lead detail drawer — right-side panel. Top: editable lead fields + stage.
// Below: the SAME CRM panels a Customer has, keyed on the lead id, so a lead
// carries contacts, a follow-up timeline and KYC — everything a
// new salesperson needs to take over. On convert (slice 2) these rows are
// re-pointed to the new customer id.
// ---------------------------------------------------------------------------
function LeadDetailDrawer({
  lead,
  onClose,
  onSaved,
  onMoveStage,
}: {
  lead: Lead;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
  onMoveStage: (stage: string) => void;
}) {
  const [draft, setDraft] = useState({
    name: lead.name ?? "",
    company: lead.company ?? "",
    phone: lead.phone ?? "",
    email: lead.email ?? "",
    source: lead.source ?? "Referral",
    estValue: lead.est_value_sen != null ? (lead.est_value_sen / 100).toString() : "",
    nextFollowUp: lead.next_follow_up ?? "",
    notes: lead.notes ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [showConvert, setShowConvert] = useState(false);
  const stageMeta = STAGES.find((s) => s.key === lead.stage) ?? STAGES[0];
  const alreadyCustomer = !!lead.won_customer_id;

  const saveFields = async () => {
    if (!emailValid(draft.email)) return;
    setSaving(true);
    try {
      await fetch(`/api/sales-leads/${lead.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          company: draft.company,
          phone: draft.phone,
          email: draft.email,
          source: draft.source,
          nextFollowUp: draft.nextFollowUp,
          notes: draft.notes,
          estValueSen: Math.round((parseFloat(draft.estValue) || 0) * 100),
        }),
      });
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-[560px] h-full bg-[#FAF9F7] shadow-2xl overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-white border-b border-[#E2DDD8] px-5 py-4 flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-base font-semibold text-[#1F1D1B] truncate">{draft.company || draft.name || "Lead"}</div>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-[11px] font-medium px-2 py-0.5 rounded-full" style={{ background: stageMeta.soft, color: stageMeta.accent }}>{stageMeta.label}</span>
              <select
                value={lead.stage}
                onChange={(e) => onMoveStage(e.target.value)}
                className="text-[11px] border border-[#E2DDD8] rounded px-1.5 py-0.5 bg-white focus:outline-none focus:ring-1 focus:ring-[#6B5C32]"
              >
                {STAGES.map((st) => <option key={st.key} value={st.key}>Move to {st.label}</option>)}
              </select>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {alreadyCustomer ? (
              <span className="text-[11px] font-medium px-2.5 py-1 rounded-full bg-[#E7F4EC] text-[#15803D]">✓ Converted to customer</span>
            ) : (
              <button
                onClick={() => setShowConvert(true)}
                className="text-xs font-medium px-3 py-1.5 rounded-lg bg-[#6B5C32] text-white hover:bg-[#5A4D2A]"
              >
                Convert to customer →
              </button>
            )}
            <button onClick={onClose} className="text-[#9CA3AF] hover:text-[#1F1D1B]"><X className="w-5 h-5" /></button>
          </div>
        </div>

        {showConvert && (
          <ConvertLeadDialog
            lead={lead}
            onClose={() => setShowConvert(false)}
            onDone={async () => { setShowConvert(false); await onSaved(); }}
          />
        )}

        <div className="p-5 space-y-4">
          {/* Editable lead fields */}
          <div className="rounded-lg border border-[#E2DDD8] bg-white p-4">
            <div className="text-sm font-semibold text-[#1F1D1B] mb-3">Lead details</div>
            <div className="grid grid-cols-2 gap-3">
              {([
                ["company", "Company", "col-span-2", "text"],
                ["name", "Contact person", "", "text"],
                ["phone", "Phone", "", "text"],
                ["email", "Email", "col-span-2", "text"],
                ["estValue", "Est. value (RM)", "", "number"],
                ["nextFollowUp", "Next follow-up", "", "date"],
              ] as const).map(([k, label, cls, type]) => (
                <label key={k} className={`text-xs text-[#6B7280] flex flex-col gap-1 ${cls}`}>
                  {label}
                  {k === "phone" ? (
                    <PhoneInput value={draft.phone} onChange={(v) => setDraft({ ...draft, phone: v })} />
                  ) : (
                    <input
                      type={type}
                      value={draft[k]}
                      onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                      className={`border rounded-lg px-2.5 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32] ${k === "email" && !emailValid(draft.email) ? "border-[#9A3A2D]" : "border-[#E2DDD8]"}`}
                    />
                  )}
                </label>
              ))}
              <label className="text-xs text-[#6B7280] flex flex-col gap-1">
                Source
                <select value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} className="border border-[#E2DDD8] rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]">
                  {SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="text-xs text-[#6B7280] flex flex-col gap-1 col-span-2">
                Notes
                <textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} rows={2} className="border border-[#E2DDD8] rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32] resize-none" />
              </label>
            </div>
            <div className="mt-3 flex justify-end">
              <button disabled={saving || !emailValid(draft.email)} onClick={() => void saveFields()} className="px-3 py-1.5 rounded-lg bg-[#6B5C32] text-white text-sm font-medium disabled:opacity-50 hover:bg-[#5A4D2A]">{saving ? "Saving…" : "Save details"}</button>
            </div>
          </div>

          {/* Full CRM record — same panels a Customer has, keyed on the lead id. */}
          {/* Wishlist retired 2026-08-01 (owner: "整个功能删掉，我们 assign SKU 就行了").
              The activity timeline above plus the catalogue/SKU assignment below
              cover what it was for. The customer_wishlist TABLE is deliberately
              left in place — the feature is gone, the historical rows are not. */}
          <CrmPanel customerId={lead.id} customerName={lead.company || lead.name || "Lead"} />
          <LeadCatalogPanel leadId={lead.id} />
          <KycPanel customerId={lead.id} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Convert a WON lead into a formal customer. The approval gate the owner
// requires (Credit Code, Name, Delivery Hub, PIC, PIC Contact, Terms, Credit
// Limit) is collected here. Flow, so customer-creation logic stays in one place:
//   1. POST /api/customers      → create the debtor (validates the code, mints id)
//   2. PUT  /api/customers/:id  → attach the delivery hub (if given)
//   3. POST /api/sales-leads/:id/convert → re-point the lead's CRM record + WON
// ---------------------------------------------------------------------------
function ConvertLeadDialog({
  lead,
  onClose,
  onDone,
}: {
  lead: Lead;
  onClose: () => void;
  onDone: () => Promise<void> | void;
}) {
  const [f, setF] = useState({
    code: "",
    name: lead.company || lead.name || "",
    ssmNo: "",
    creditTerms: "NET30",
    creditLimit: "",
    contactName: lead.name || "",
    phone: lead.phone || "",
    email: lead.email || "",
    hubShortName: "",
    hubCode: "",
    hubState: "",
    hubAddress: "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const canSubmit = f.code.trim() && f.name.trim() && emailValid(f.email);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setErr(null);
    try {
      // 1) CONFIRM the account (owner 2026-08-01). The customer row already
      //    exists — it was created as POTENTIAL the moment this lead was
      //    entered, and has been carrying its SKU assignments, combos and
      //    quotations ever since. So this promotes that SAME row rather than
      //    minting a second one, which would strand everything assigned to it.
      //    A lead from before this change (or whose best-effort customer create
      //    failed) has no customer_id — those still take the create path.
      const accountFields = {
        code: f.code.trim(),
        name: f.name.trim(),
        ssmNo: f.ssmNo.trim(),
        creditTerms: f.creditTerms,
        creditLimitSen: Math.round((parseFloat(f.creditLimit) || 0) * 100),
        contactName: f.contactName.trim(),
        phone: f.phone.trim(),
        email: f.email.trim(),
        customerStage: "CONFIRMED" as const,
      };
      const existingCustomerId = String(lead.customer_id ?? "").trim();
      let customerId = existingCustomerId;
      if (existingCustomerId) {
        const res = await fetch(`/api/customers/${existingCustomerId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: existingCustomerId, ...accountFields }),
        });
        const j = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string };
        if (!res.ok || !j.success) {
          setErr(j.error || `Could not confirm the customer (HTTP ${res.status}).`);
          return;
        }
      } else {
        const createRes = await fetch("/api/customers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(accountFields),
        });
        const createJson = (await createRes.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: { id: string } };
        if (!createRes.ok || !createJson.success || !createJson.data?.id) {
          setErr(createJson.error || `Could not create customer (HTTP ${createRes.status}).`);
          return;
        }
        customerId = createJson.data.id;
      }

      // 2) attach a delivery hub (optional) via the customer PUT.
      if (f.hubShortName.trim() && f.hubCode.trim()) {
        await fetch(`/api/customers/${customerId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: customerId,
            ...accountFields,
            deliveryHubs: [{
              id: `hub-${customerId}-1`,
              code: f.hubCode.trim(),
              shortName: f.hubShortName.trim(),
              state: f.hubState,
              address: f.hubAddress.trim(),
              contactName: f.contactName.trim(),
              phone: f.phone.trim(),
              email: f.email.trim(),
              isDefault: true,
            }],
          }),
        });
      }

      // 3) re-point the lead's CRM record onto the new customer + mark WON.
      await fetch(`/api/sales-leads/${lead.id}/convert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId }),
      });

      window.alert(`Confirmed. ${f.code.trim()} — ${f.name.trim()} is now a confirmed customer and can be used on sales orders. Its SKU assignments and quotations carried over.`);
      await onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-[#1F1D1B]">Confirm customer</h2>
          <button onClick={onClose} className="text-[#9CA3AF] hover:text-[#1F1D1B]"><X className="w-5 h-5" /></button>
        </div>
        <p className="text-xs text-[#6B7280] mb-4">Fill the account-opening details. This confirms the account that already exists for this lead — everything assigned to it is kept.</p>

        <div className="space-y-4">
          <div>
            <div className="text-xs font-semibold text-[#6B5C32] uppercase tracking-wide mb-2">Account</div>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-[#6B7280] flex flex-col gap-1">Credit Code *
                <input value={f.code} onChange={(e) => set("code", e.target.value)} className="border border-[#E2DDD8] rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]" /></label>
              <label className="text-xs text-[#6B7280] flex flex-col gap-1">Terms
                <select value={f.creditTerms} onChange={(e) => set("creditTerms", e.target.value)} className="border border-[#E2DDD8] rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]">
                  {TERMS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select></label>
              <label className="text-xs text-[#6B7280] flex flex-col gap-1 col-span-2">Customer Name *
                <input value={f.name} onChange={(e) => set("name", e.target.value)} className="border border-[#E2DDD8] rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]" /></label>
              <label className="text-xs text-[#6B7280] flex flex-col gap-1">SSM No.
                <input value={f.ssmNo} onChange={(e) => set("ssmNo", e.target.value)} className="border border-[#E2DDD8] rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]" /></label>
              <label className="text-xs text-[#6B7280] flex flex-col gap-1">Credit Limit (RM)
                <input type="number" value={f.creditLimit} onChange={(e) => set("creditLimit", e.target.value)} className="border border-[#E2DDD8] rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]" /></label>
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold text-[#6B5C32] uppercase tracking-wide mb-2">Person in charge (PIC)</div>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-[#6B7280] flex flex-col gap-1">PIC name
                <input value={f.contactName} onChange={(e) => set("contactName", e.target.value)} className="border border-[#E2DDD8] rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]" /></label>
              <label className="text-xs text-[#6B7280] flex flex-col gap-1">PIC contact
                <PhoneInput value={f.phone} onChange={(v) => set("phone", v)} /></label>
              <label className="text-xs text-[#6B7280] flex flex-col gap-1 col-span-2">Email
                <input value={f.email} onChange={(e) => set("email", e.target.value)} className={`border rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32] ${!emailValid(f.email) ? "border-[#9A3A2D]" : "border-[#E2DDD8]"}`} /></label>
            </div>
          </div>

          <div>
            <div className="text-xs font-semibold text-[#6B5C32] uppercase tracking-wide mb-2">Delivery hub <span className="text-[#9CA3AF] normal-case font-normal">(optional — add more on the customer page)</span></div>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-[#6B7280] flex flex-col gap-1">Hub name
                <input value={f.hubShortName} onChange={(e) => set("hubShortName", e.target.value)} placeholder="e.g. KL" className="border border-[#E2DDD8] rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]" /></label>
              <label className="text-xs text-[#6B7280] flex flex-col gap-1">Hub code
                <input value={f.hubCode} onChange={(e) => set("hubCode", e.target.value)} placeholder="e.g. KL" className="border border-[#E2DDD8] rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]" /></label>
              <label className="text-xs text-[#6B7280] flex flex-col gap-1">State
                <StateSelect value={f.hubState} onChange={(v) => set("hubState", v)} /></label>
              <label className="text-xs text-[#6B7280] flex flex-col gap-1">Address
                <input value={f.hubAddress} onChange={(e) => set("hubAddress", e.target.value)} className="border border-[#E2DDD8] rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]" /></label>
            </div>
          </div>

          {err ? <div className="text-xs text-[#9A3A2D] bg-[#F9E7E3] border border-[#E8B2A1] rounded-lg px-3 py-2">{err}</div> : null}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg border border-[#E2DDD8] text-sm text-[#6B7280] hover:bg-[#F0ECE9]">Cancel</button>
          <button disabled={busy || !canSubmit} onClick={() => void submit()} className="px-4 py-2 rounded-lg bg-[#6B5C32] text-white text-sm font-medium disabled:opacity-50 hover:bg-[#5A4D2A]">{busy ? "Converting…" : "Convert"}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lead catalog — provisional product assignments + target prices on a lead
// (CRM slice 3, owner 2026-07-30). Stored in its own lead_products table (never
// customer_products), and copied into the real customer on convert. Lets a
// salesperson line up what they're quoting BEFORE the lead becomes a customer.
// ---------------------------------------------------------------------------
type LeadProduct = { id: string; product_code: string | null; product_name: string | null; price_sen: number | null };
type ProductLite = { id: string; code: string; name: string };

function LeadCatalogPanel({ leadId }: { leadId: string }) {
  const [items, setItems] = useState<LeadProduct[]>([]);
  const [products, setProducts] = useState<ProductLite[]>([]);
  // Owner 2026-08-02:「不能根据我的 catalog 去选吗？应该当我选了 catalog 之后,
  // 直接带出这个 catalog 里面所有的 SKU」+「难道不能 multiselect 吗？如果不能
  // multiselect 的话,就不好用了」.
  //
  // The old control was one free-text datalist over EVERY SKU. A single
  // bedframe model carries fourteen of them (1003-(K), 1003(A)-(Q),
  // 1003(A)(HF)(W)-(SS)…), so quoting a model meant typing a near-identical
  // string fourteen times and getting one character wrong on the way. Pick the
  // MODEL, tick its SKUs, add them together — the same family grouping the
  // Products → Catalog page shows, via the same `familyOf`, so the two screens
  // can never disagree about what a model is.
  const [model, setModel] = useState("");
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [priceRm, setPriceRm] = useState("");
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    try {
      const r = await fetch(`/api/sales-leads/lead-products?leadId=${encodeURIComponent(leadId)}`);
      const j = (await r.json()) as { success: boolean; data?: LeadProduct[] };
      setItems(j.success && j.data ? j.data : []);
    } catch { setItems([]); }
  };

  /* eslint-disable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */
  useEffect(() => {
    void reload();
    void (async () => {
      try {
        const r = await fetch("/api/products");
        const j = (await r.json()) as { success: boolean; data?: ProductLite[] };
        const list = j.success && j.data ? j.data : [];
        setProducts(list.filter((p) => p && p.code).map((p) => ({ id: p.id, code: p.code, name: p.name })));
      } catch { /* leave empty */ }
    })();
  }, [leadId]);
  /* eslint-enable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

  /** Models, grouped exactly as Products → Catalog groups them. */
  const models = useMemo(() => {
    const map = new Map<string, ProductLite[]>();
    for (const p of products) {
      const key = familyOf(p.code) || p.code;
      const arr = map.get(key);
      if (arr) arr.push(p);
      else map.set(key, [p]);
    }
    return [...map.entries()]
      .map(([key, skus]) => ({
        key,
        // The family's own name, not the first SKU's: "1003 — HILTON BEDFRAME"
        // reads as a model, "1003-(K) — HILTON BEDFRAME (6FT)" reads as a size.
        name: skus[0]?.name ?? key,
        skus: skus.slice().sort((a, b) => a.code.localeCompare(b.code)),
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [products]);

  const modelSkus = useMemo(
    () => models.find((m) => m.key === model)?.skus ?? [],
    [models, model],
  );
  /** Already on the lead — shown ticked and locked, never added twice. */
  const alreadyOn = useMemo(
    () => new Set(items.map((i) => (i.product_code ?? "").toUpperCase()).filter(Boolean)),
    [items],
  );

  const toggleSku = (id: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const addTicked = async () => {
    const chosen = modelSkus.filter((p) => ticked.has(p.id));
    if (chosen.length === 0) return;
    setSaving(true);
    try {
      // Sequential, not Promise.all: the endpoint self-applies its DDL on first
      // write, and firing ten concurrent creates at a cold isolate races that.
      for (const p of chosen) {
        await fetch("/api/sales-leads/lead-products", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            leadId,
            productId: p.id,
            productCode: p.code,
            productName: p.name,
            // One target price applies to every SKU ticked in this batch — the
            // sizes of one model are quoted together in practice. Per-SKU edits
            // stay possible by adding them one at a time.
            priceRm: priceRm.trim() === "" ? null : priceRm,
          }),
        });
      }
      setTicked(new Set());
      setPriceRm("");
      await reload();
    } finally { setSaving(false); }
  };

  const del = async (id: string) => {
    await fetch(`/api/sales-leads/lead-products/${id}`, { method: "DELETE" });
    await reload();
  };

  return (
    <div className="rounded-lg border border-[#E2DDD8] bg-white p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-[#1F1D1B] mb-1">
        <Tag className="h-4 w-4 text-[#3E6570]" /> Catalog &amp; target prices ({items.length})
      </div>
      <p className="text-[11px] text-[#9CA3AF] mb-3">What you&apos;re quoting this lead. Copied onto the customer when you convert.</p>
      {/* Step 1 — the model. */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <select
          value={model}
          onChange={(e) => { setModel(e.target.value); setTicked(new Set()); }}
          className="flex-1 min-w-[200px] text-sm border border-[#E2DDD8] rounded px-2 py-1.5 bg-white focus:outline-none focus:border-[#6B5C32]"
        >
          <option value="">Pick a model from the catalog…</option>
          {models.map((m) => (
            <option key={m.key} value={m.key}>
              {m.key} — {m.name} ({m.skus.length} SKU{m.skus.length === 1 ? "" : "s"})
            </option>
          ))}
        </select>
      </div>

      {/* Step 2 — tick the sizes. */}
      {model && (
        <div className="mb-3 rounded-md border border-[#E2DDD8] bg-[#FAF9F7] p-2">
          <div className="mb-1.5 flex items-center gap-2 text-[11px] text-[#6B7280]">
            <span>{modelSkus.length} SKUs in this model</span>
            <button
              type="button"
              onClick={() => setTicked(new Set(modelSkus.filter((p) => !alreadyOn.has(p.code.toUpperCase())).map((p) => p.id)))}
              className="rounded border border-[#E2DDD8] bg-white px-1.5 py-0.5 hover:text-[#1F1D1B]"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => setTicked(new Set())}
              className="rounded border border-[#E2DDD8] bg-white px-1.5 py-0.5 hover:text-[#1F1D1B]"
            >
              Clear
            </button>
          </div>
          <div className="max-h-52 overflow-y-auto">
            {modelSkus.map((p) => {
              const on = alreadyOn.has(p.code.toUpperCase());
              return (
                <label
                  key={p.id}
                  className={`flex items-center gap-2 rounded px-1.5 py-1 text-[12px] ${on ? "text-[#9CA3AF]" : "cursor-pointer text-[#1F1D1B] hover:bg-white"}`}
                >
                  <input
                    type="checkbox"
                    // Already on the lead: ticked and locked, so a second pass
                    // over the same model cannot silently duplicate a line.
                    checked={on || ticked.has(p.id)}
                    disabled={on}
                    onChange={() => toggleSku(p.id)}
                  />
                  <span className="font-mono text-[#6B5C32]">{p.code}</span>
                  <span className="truncate">{p.name}</span>
                  {on ? <span className="ml-auto shrink-0 text-[10px]">already added</span> : null}
                </label>
              );
            })}
          </div>
        </div>
      )}

      {/* Step 3 — one target price for the batch, then add. */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <input value={priceRm} onChange={(e) => setPriceRm(e.target.value)} type="number" placeholder="Target RM (optional)" className="w-40 text-sm border border-[#E2DDD8] rounded px-2 py-1.5 bg-white focus:outline-none focus:border-[#6B5C32]" />
        <button onClick={() => void addTicked()} disabled={saving || ticked.size === 0} className="text-sm px-3 py-1.5 bg-[#6B5C32] text-white rounded-md hover:bg-[#5A4D2A] disabled:opacity-40">
          {saving ? "Adding…" : `Add ${ticked.size || ""} SKU${ticked.size === 1 ? "" : "s"}`.trim()}
        </button>
      </div>
      {items.length === 0 ? (
        <p className="text-xs text-gray-400 py-1">No SKUs yet.</p>
      ) : (
        <div className="space-y-1.5">
          {items.map((it) => (
            <div key={it.id} className="flex items-center gap-2 px-2.5 py-2 bg-[#FAF9F7] border border-[#E2DDD8] rounded-md">
              <span className="text-sm font-medium text-[#1F1D1B]">
                {it.product_code ? <span className="font-mono text-[#6B5C32]">{it.product_code}</span> : null}
                {it.product_code && it.product_name ? " · " : ""}{it.product_name}
              </span>
              {it.price_sen != null ? <span className="text-xs text-[#3E6570] font-medium">{formatCurrency(it.price_sen / 100)}</span> : null}
              <button onClick={() => void del(it.id)} className="ml-auto p-1 text-[#9A3A2D] hover:bg-[#F9E1DA] rounded" title="Remove"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
