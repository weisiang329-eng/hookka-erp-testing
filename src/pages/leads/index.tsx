// ---------------------------------------------------------------------------
// Sales Pipeline (Leads) — the pre-sale funnel board (owner 2026-07-30).
// Columns per stage; cards move NEW → … → WON / LOST by DRAG or the stage
// dropdown. Clicking a card opens a full Lead detail drawer that mounts the
// same CRM panels a Customer has (Contacts, Activity timeline, Wishlist, KYC)
// keyed on the lead id — so a lead holds every detail and ANY salesperson can
// take over. See docs/plans/2026-07-30-crm-unified-customer.md.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Phone, Mail, Trash2, CalendarClock, X, GripVertical } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { CrmPanel } from "@/components/customer/CrmPanel";
import { WishlistPanel } from "@/components/customer/WishlistPanel";
import { KycPanel } from "@/components/customer/KycPanel";
import { PhoneInput } from "@/components/ui/phone-input";
import { StateSelect } from "@/components/ui/state-select";
import { isValidEmail } from "@/lib/contact-format";

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
  created_at?: string | null;
};

const STAGES = [
  { key: "NEW", label: "New", accent: "#6B7280", soft: "#F3F4F6" },
  { key: "CONTACTED", label: "Contacted", accent: "#2563EB", soft: "#EAF1FE" },
  { key: "QUOTED", label: "Quoted", accent: "#B45309", soft: "#FBF0E0" },
  { key: "NEGOTIATING", label: "Negotiating", accent: "#7C3AED", soft: "#F1EBFD" },
  { key: "WON", label: "Won", accent: "#15803D", soft: "#E7F4EC" },
  { key: "LOST", label: "Lost", accent: "#9A3A2D", soft: "#F9E7E3" },
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
      lostReason = window.prompt("Reason for losing this lead? (price / lead time / style / …)") || "";
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
            <div className="text-[11px] uppercase tracking-wide text-[#9CA3AF]">Won</div>
            <div className="text-lg font-semibold text-[#15803D]">{formatCurrency(wonValueSen / 100)}</div>
          </div>
          <button
            onClick={() => setShowAdd(true)}
            className="h-10 px-4 rounded-lg bg-[#1F1D1B] text-white text-sm font-medium hover:bg-[#3a3633] flex items-center gap-2 shadow-sm transition-colors"
          >
            <Plus className="w-4 h-4" /> New Lead
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
                  {l.lost_reason ? <div className="mt-1 text-[11px] text-[#9A3A2D] italic pl-5">Lost: {l.lost_reason}</div> : null}
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
              <h2 className="text-lg font-semibold text-[#1F1D1B]">New Lead</h2>
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
              <button disabled={saving || (!form.name.trim() && !form.company.trim()) || !emailValid(form.email)} onClick={() => void addLead()} className="px-4 py-2 rounded-lg bg-[#1F1D1B] text-white text-sm font-medium disabled:opacity-50 hover:bg-[#3a3633]">Add lead</button>
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
// carries contacts, a follow-up timeline, a wishlist and KYC — everything a
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
          <CrmPanel customerId={lead.id} customerName={lead.company || lead.name || "Lead"} />
          <WishlistPanel customerId={lead.id} />
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
      // 1) create the customer via the canonical endpoint.
      const createRes = await fetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: f.code.trim(),
          name: f.name.trim(),
          ssmNo: f.ssmNo.trim(),
          creditTerms: f.creditTerms,
          creditLimitSen: Math.round((parseFloat(f.creditLimit) || 0) * 100),
          contactName: f.contactName.trim(),
          phone: f.phone.trim(),
          email: f.email.trim(),
        }),
      });
      const createJson = (await createRes.json().catch(() => ({}))) as { success?: boolean; error?: string; data?: { id: string } };
      if (!createRes.ok || !createJson.success || !createJson.data?.id) {
        setErr(createJson.error || `Could not create customer (HTTP ${createRes.status}).`);
        return;
      }
      const customerId = createJson.data.id;

      // 2) attach a delivery hub (optional) via the customer PUT.
      if (f.hubShortName.trim() && f.hubCode.trim()) {
        await fetch(`/api/customers/${customerId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...createJson.data,
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

      window.alert(`Converted. New customer ${f.code.trim()} — ${f.name.trim()} created; the lead's contacts, activity, wishlist and KYC moved over.`);
      await onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-semibold text-[#1F1D1B]">Convert to customer</h2>
          <button onClick={onClose} className="text-[#9CA3AF] hover:text-[#1F1D1B]"><X className="w-5 h-5" /></button>
        </div>
        <p className="text-xs text-[#6B7280] mb-4">Fill the account-opening details. The lead's contacts, activity, wishlist and KYC move over automatically.</p>

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
