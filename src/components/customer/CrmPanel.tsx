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
  /** What to raise next time — the reminder's actual content. */
  follow_up_topic: string | null;
  outcome: string | null;
  /** When the call/meeting HAPPENED, which is not when it was typed in. */
  occurred_at: string | null;
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
  // Owner 2026-08-02:「我应该能记录几时 call 他、call 之后发生了什么,以及我
  // call 的是谁。系统未必要强求 mention next follow-up,只要能提醒我下一次
  // follow-up 的时候,具体要 follow up 什么东西就行」.
  //
  // Three things the old form could not record:
  //   * WHEN. It stamped created_at = now, so a call logged the next morning
  //     was filed under the wrong day. `occurredAt` defaults to today and is
  //     editable.
  //   * WHAT HAPPENED AFTER. `outcome` and `detail` were in the payload but had
  //     no input at all — the columns were永远 empty.
  //   * WHO, reliably. "Who (contact)" was free text next to a contact list the
  //     panel had already loaded, so the same person got three spellings.
  //
  // And the follow-up DATE is not required — a follow-up with no topic is the
  // thing that is actually useless, so the topic is what the reminder carries.
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const [aForm, setAForm] = useState({
    activityType: "CALL",
    occurredAt: todayIso(),
    summary: "",
    detail: "",
    nextFollowUp: "",
    followUpTopic: "",
    outcome: "",
    contactName: "",
  });
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
      setAForm({
        activityType: "CALL",
        occurredAt: todayIso(),
        summary: "",
        detail: "",
        nextFollowUp: "",
        followUpTopic: "",
        outcome: "",
        contactName: "",
      });
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
        <div className="mb-3 space-y-2 rounded bg-[#FAF9F7] p-3">
          {/* Row 1 — what kind of contact, when, and with whom. */}
          <div className="flex flex-wrap items-center gap-2">
            <select className={inputCls} value={aForm.activityType} onChange={(e) => setAForm({ ...aForm, activityType: e.target.value })}>
              {ACTIVITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <label className="flex items-center gap-1 text-xs text-[#6B7280]">
              on
              <input type="date" className={inputCls} value={aForm.occurredAt} onChange={(e) => setAForm({ ...aForm, occurredAt: e.target.value })} />
            </label>
            {/* The contacts are already loaded — free text next to a known list
                is how one person ends up with three spellings. Still allows a
                name that is not on file, for the receptionist who answered. */}
            <input
              className={`${inputCls} min-w-[150px]`}
              list={`crm-contacts-${customerId}`}
              placeholder="Who did you speak to?"
              value={aForm.contactName}
              onChange={(e) => setAForm({ ...aForm, contactName: e.target.value })}
            />
            <datalist id={`crm-contacts-${customerId}`}>
              {contacts.map((c) => (
                <option key={c.id} value={c.name ?? ""}>
                  {[c.title, c.role].filter(Boolean).join(" · ")}
                </option>
              ))}
            </datalist>
          </div>

          {/* Row 2 — what happened, and what came of it. */}
          <div className="flex flex-wrap items-center gap-2">
            <input className={`${inputCls} flex-1 min-w-[200px]`} placeholder="What happened? *" value={aForm.summary} onChange={(e) => setAForm({ ...aForm, summary: e.target.value })} />
            <input className={`${inputCls} flex-1 min-w-[180px]`} placeholder="Outcome — what came of it?" value={aForm.outcome} onChange={(e) => setAForm({ ...aForm, outcome: e.target.value })} />
          </div>

          {/* Row 3 — the follow-up. The TOPIC is the point; the date is
              optional, because a reminder that only says "follow up" tells you
              nothing when it fires. */}
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={`${inputCls} flex-1 min-w-[220px]`}
              placeholder="Next time, follow up on… (optional)"
              value={aForm.followUpTopic}
              onChange={(e) => setAForm({ ...aForm, followUpTopic: e.target.value })}
            />
            <label className="flex items-center gap-1 text-xs text-[#6B7280]">
              by
              <input type="date" className={inputCls} value={aForm.nextFollowUp} onChange={(e) => setAForm({ ...aForm, nextFollowUp: e.target.value })} />
            </label>
            <button disabled={saving || !aForm.summary.trim()} onClick={() => void addActivity()} className="ml-auto rounded bg-[#1F1D1B] px-3 py-1.5 text-sm text-white disabled:opacity-50">Log</button>
          </div>
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
                    {a.outcome ? <p className="mt-0.5 text-xs text-[#3E6570]">→ {a.outcome}</p> : null}
                    {a.detail ? <p className="text-xs text-[#6B7280] mt-0.5">{a.detail}</p> : null}
                    <div className="text-[11px] text-[#9CA3AF] mt-0.5 flex flex-wrap gap-3">
                      {/* The day it HAPPENED, falling back to the day it was
                          logged for every row written before occurred_at
                          existed. */}
                      <span>{(a.occurred_at ?? a.created_at)?.slice(0, 10)}</span>
                      {a.follow_up_topic || a.next_follow_up ? (
                        <span className="flex items-center gap-1 text-[#6B5C32]">
                          <CalendarClock className="w-3 h-3" />
                          {a.follow_up_topic || "follow up"}
                          {a.next_follow_up ? ` · by ${a.next_follow_up}` : ""}
                        </span>
                      ) : null}
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
