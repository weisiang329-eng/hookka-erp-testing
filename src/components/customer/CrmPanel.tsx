// ---------------------------------------------------------------------------
// CrmPanel — the CRM slice on the customer detail view (owner 2026-07-30, for
// outbound sales). Two sections:
//   · Contacts — multiple named people per company (name, title, phone, email,
//     role), so a new hire sees WHO to call.
//   · Activity timeline — every call/meeting/quote/note with what was discussed,
//     the outcome, and the NEXT follow-up date. Self-contained; talks to
//     /api/customer-crm. CSRF is auto-injected by api-client.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from "react";
import { Plus, Phone, Mail, Trash2, CalendarClock } from "lucide-react";

type Contact = {
  id: string;
  name: string | null;
  title: string | null;
  phone: string | null;
  email: string | null;
  role: string | null;
  is_primary: number | null;
};

type Activity = {
  id: string;
  activity_type: string | null;
  summary: string | null;
  detail: string | null;
  contact_name: string | null;
  next_follow_up: string | null;
  outcome: string | null;
  created_at: string | null;
};

const ACTIVITY_TYPES = ["CALL", "MEETING", "WHATSAPP", "EMAIL", "QUOTE", "VISIT", "NOTE"] as const;

async function getJson<T>(url: string): Promise<T[]> {
  try {
    const r = await fetch(url);
    const j = (await r.json()) as { success: boolean; data?: T[] };
    return j.success && j.data ? j.data : [];
  } catch {
    return [];
  }
}

export function CrmPanel({ customerId }: { customerId: string; customerName?: string }) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [showContact, setShowContact] = useState(false);
  const [cForm, setCForm] = useState({ name: "", title: "", phone: "", email: "", role: "" });
  const [aForm, setAForm] = useState({ activityType: "CALL", summary: "", detail: "", nextFollowUp: "", outcome: "", contactName: "" });
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    const [c, a] = await Promise.all([
      getJson<Contact>(`/api/customer-crm/contacts?customerId=${encodeURIComponent(customerId)}`),
      getJson<Activity>(`/api/customer-crm/activities?customerId=${encodeURIComponent(customerId)}`),
    ]);
    setContacts(c);
    setActivities(a);
  }, [customerId]);

  // reload() flips the contacts/activities setters; the effect fires on a
  // user-driven prop change (customerId), not a tight render loop, so the
  // cascading-render concern set-state-in-effect warns about doesn't apply.
  /* eslint-disable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */
  useEffect(() => {
    void reload();
  }, [customerId]);
  /* eslint-enable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */

  const addContact = async () => {
    if (!cForm.name.trim()) return;
    setSaving(true);
    try {
      await fetch("/api/customer-crm/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, ...cForm }),
      });
      setCForm({ name: "", title: "", phone: "", email: "", role: "" });
      setShowContact(false);
      await reload();
    } finally {
      setSaving(false);
    }
  };

  const delContact = async (id: string) => {
    await fetch(`/api/customer-crm/contacts/${id}`, { method: "DELETE" });
    await reload();
  };

  const addActivity = async () => {
    if (!aForm.summary.trim()) return;
    setSaving(true);
    try {
      await fetch("/api/customer-crm/activities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId, ...aForm }),
      });
      setAForm({ activityType: "CALL", summary: "", detail: "", nextFollowUp: "", outcome: "", contactName: "" });
      await reload();
    } finally {
      setSaving(false);
    }
  };

  const delActivity = async (id: string) => {
    await fetch(`/api/customer-crm/activities/${id}`, { method: "DELETE" });
    await reload();
  };

  const inputCls = "border border-[#E2DDD8] rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#6B5C32]";

  return (
    <div className="rounded-xl border border-[#E2DDD8] bg-white p-5 mt-4">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-lg">👥</span>
        <h3 className="font-semibold text-[#1F1D1B]">CRM — Contacts & Activity</h3>
      </div>

      {/* Contacts */}
      <div className="mb-6">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-medium text-[#6B7280]">Contacts ({contacts.length})</h4>
          <button onClick={() => setShowContact((s) => !s)} className="text-xs flex items-center gap-1 text-[#6B5C32] hover:underline">
            <Plus className="w-3 h-3" /> Add contact
          </button>
        </div>
        {showContact && (
          <div className="flex flex-wrap gap-2 mb-3 p-3 bg-[#FAF9F7] rounded">
            <input className={inputCls} placeholder="Name *" value={cForm.name} onChange={(e) => setCForm({ ...cForm, name: e.target.value })} />
            <input className={inputCls} placeholder="Title / position" value={cForm.title} onChange={(e) => setCForm({ ...cForm, title: e.target.value })} />
            <input className={inputCls} placeholder="Phone" value={cForm.phone} onChange={(e) => setCForm({ ...cForm, phone: e.target.value })} />
            <input className={inputCls} placeholder="Email" value={cForm.email} onChange={(e) => setCForm({ ...cForm, email: e.target.value })} />
            <input className={inputCls} placeholder="Role (e.g. Purchasing)" value={cForm.role} onChange={(e) => setCForm({ ...cForm, role: e.target.value })} />
            <button disabled={saving || !cForm.name.trim()} onClick={() => void addContact()} className="px-3 py-1.5 rounded bg-[#1F1D1B] text-white text-sm disabled:opacity-50">Save</button>
          </div>
        )}
        {contacts.length === 0 ? (
          <p className="text-sm text-[#9CA3AF]">No contacts yet.</p>
        ) : (
          <div className="grid gap-2">
            {contacts.map((c) => (
              <div key={c.id} className="flex items-center justify-between border border-[#F0ECE9] rounded px-3 py-2">
                <div className="text-sm">
                  <span className="font-medium text-[#1F1D1B]">{c.name}</span>
                  {c.title ? <span className="text-[#6B7280]"> · {c.title}</span> : null}
                  {c.role ? <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded bg-[#F0ECE9] text-[#6B5C32]">{c.role}</span> : null}
                  <div className="text-[#6B7280] text-xs flex gap-3 mt-0.5">
                    {c.phone ? <span className="flex items-center gap-1"><Phone className="w-3 h-3" />{c.phone}</span> : null}
                    {c.email ? <span className="flex items-center gap-1"><Mail className="w-3 h-3" />{c.email}</span> : null}
                  </div>
                </div>
                <button onClick={() => void delContact(c.id)} className="text-[#9A3A2D] hover:bg-[#F9E1DA] rounded p-1"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Activity timeline */}
      <div>
        <h4 className="text-sm font-medium text-[#6B7280] mb-2">Activity & follow-ups</h4>
        <div className="flex flex-wrap gap-2 mb-3 p-3 bg-[#FAF9F7] rounded items-end">
          <select className={inputCls} value={aForm.activityType} onChange={(e) => setAForm({ ...aForm, activityType: e.target.value })}>
            {ACTIVITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input className={`${inputCls} flex-1 min-w-[180px]`} placeholder="What happened? *" value={aForm.summary} onChange={(e) => setAForm({ ...aForm, summary: e.target.value })} />
          <input className={inputCls} placeholder="Who (contact)" value={aForm.contactName} onChange={(e) => setAForm({ ...aForm, contactName: e.target.value })} />
          <label className="text-xs text-[#6B7280] flex items-center gap-1">Next follow-up
            <input type="date" className={inputCls} value={aForm.nextFollowUp} onChange={(e) => setAForm({ ...aForm, nextFollowUp: e.target.value })} />
          </label>
          <button disabled={saving || !aForm.summary.trim()} onClick={() => void addActivity()} className="px-3 py-1.5 rounded bg-[#1F1D1B] text-white text-sm disabled:opacity-50">Log</button>
        </div>
        {activities.length === 0 ? (
          <p className="text-sm text-[#9CA3AF]">No activity logged yet.</p>
        ) : (
          <ol className="relative border-l-2 border-[#E2DDD8] ml-2">
            {activities.map((a) => (
              <li key={a.id} className="ml-4 pb-4">
                <div className="absolute -left-[7px] w-3 h-3 rounded-full bg-[#6B5C32]" />
                <div className="flex items-start justify-between">
                  <div>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#F0ECE9] text-[#6B5C32] mr-2">{a.activity_type}</span>
                    <span className="text-sm font-medium text-[#1F1D1B]">{a.summary}</span>
                    {a.contact_name ? <span className="text-xs text-[#6B7280]"> · {a.contact_name}</span> : null}
                    {a.detail ? <p className="text-xs text-[#6B7280] mt-0.5">{a.detail}</p> : null}
                    <div className="text-[11px] text-[#9CA3AF] mt-0.5 flex gap-3">
                      <span>{a.created_at?.slice(0, 10)}</span>
                      {a.next_follow_up ? <span className="flex items-center gap-1 text-[#6B5C32]"><CalendarClock className="w-3 h-3" />follow up {a.next_follow_up}</span> : null}
                    </div>
                  </div>
                  <button onClick={() => void delActivity(a.id)} className="text-[#9A3A2D] hover:bg-[#F9E1DA] rounded p-1"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
