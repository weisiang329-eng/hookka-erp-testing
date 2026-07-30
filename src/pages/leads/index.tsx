// ---------------------------------------------------------------------------
// Sales Pipeline (Leads) — the pre-sale funnel board (owner 2026-07-30).
// Columns per stage; cards move NEW → … → WON / LOST. Consistent with the
// Hookka palette; stage identity carried by a left accent + column header.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Phone, Mail, Trash2, CalendarClock, X } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

type Lead = {
  id: string;
  name: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  source: string | null;
  stage: string;
  est_value_sen: number | null;
  next_follow_up: string | null;
  lost_reason: string | null;
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

const EMPTY = { name: "", company: "", phone: "", email: "", source: "Referral", estValue: "", nextFollowUp: "", notes: "" };

async function getLeads(): Promise<Lead[]> {
  try {
    const r = await fetch("/api/sales-leads");
    const j = (await r.json()) as { success: boolean; data?: Lead[] };
    return j.success && j.data ? j.data : [];
  } catch {
    return [];
  }
}

export default function LeadsPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ ...EMPTY });
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLeads(await getLeads());
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

  const addLead = async () => {
    if (!form.name.trim() && !form.company.trim()) return;
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

  const moveStage = async (lead: Lead, stage: string) => {
    let lostReason: string | null = null;
    if (stage === "LOST") {
      lostReason = window.prompt("Reason for losing this lead? (price / lead time / style / …)") || "";
    }
    await fetch(`/api/sales-leads/${lead.id}/stage`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage, lostReason }),
    });
    await reload();
  };

  const delLead = async (id: string) => {
    await fetch(`/api/sales-leads/${id}`, { method: "DELETE" });
    await reload();
  };

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-[#1F1D1B] tracking-tight">Sales Pipeline</h1>
          <p className="text-sm text-[#6B7280] mt-0.5">Track every lead from first contact to won — nothing slips.</p>
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

      {/* Board */}
      <div className="flex gap-4 overflow-x-auto pb-4">
        {STAGES.map((s, si) => (
          <div key={s.key} className="flex-shrink-0 w-[300px]">
            <div className="flex items-center justify-between mb-3 px-1">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: s.accent }} />
                <span className="text-sm font-semibold text-[#1F1D1B]">{s.label}</span>
              </div>
              <span className="text-xs text-[#9CA3AF] tabular-nums">{byStage[s.key].length}</span>
            </div>
            <div className="rounded-xl p-2 min-h-[120px] space-y-2" style={{ background: s.soft }}>
              {loaded && byStage[s.key].length === 0 && (
                <p className="text-xs text-center text-[#9CA3AF] py-6">—</p>
              )}
              {byStage[s.key].map((l, li) => (
                <div
                  key={l.id}
                  className="group rounded-lg bg-white border border-[#E2DDD8] p-3 shadow-sm hover:shadow-md transition-shadow"
                  style={{ borderLeft: `3px solid ${s.accent}`, animation: `crmfade .35s ease both`, animationDelay: `${si * 40 + li * 25}ms` }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-[#1F1D1B] truncate">{l.company || l.name || "—"}</div>
                      {l.company && l.name ? <div className="text-xs text-[#6B7280] truncate">{l.name}</div> : null}
                    </div>
                    {l.est_value_sen ? (
                      <span className="text-xs font-semibold text-[#6B5C32] whitespace-nowrap">{formatCurrency((l.est_value_sen ?? 0) / 100)}</span>
                    ) : null}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-[#6B7280]">
                    {l.phone ? <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{l.phone}</span> : null}
                    {l.email ? <span className="flex items-center gap-1"><Mail className="w-3 h-3" />{l.email}</span> : null}
                    {l.source ? <span className="px-1.5 py-0.5 rounded bg-[#F0ECE9] text-[#6B5C32]">{l.source}</span> : null}
                    {l.next_follow_up ? <span className="flex items-center gap-1 text-[#6B5C32]"><CalendarClock className="w-3 h-3" />{l.next_follow_up}</span> : null}
                  </div>
                  {l.lost_reason ? <div className="mt-1 text-[11px] text-[#9A3A2D] italic">Lost: {l.lost_reason}</div> : null}
                  <div className="mt-2 flex items-center justify-between opacity-0 group-hover:opacity-100 transition-opacity">
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
                  <input
                    value={form[k]}
                    onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                    className="border border-[#E2DDD8] rounded-lg px-2.5 py-2 text-sm text-[#1F1D1B] focus:outline-none focus:ring-2 focus:ring-[#6B5C32]"
                  />
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
              <button disabled={saving || (!form.name.trim() && !form.company.trim())} onClick={() => void addLead()} className="px-4 py-2 rounded-lg bg-[#1F1D1B] text-white text-sm font-medium disabled:opacity-50 hover:bg-[#3a3633]">Add lead</button>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes crmfade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}`}</style>
    </div>
  );
}
