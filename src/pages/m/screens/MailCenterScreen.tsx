// ===========================================================================
// MailCenterScreen (+ MailThreadScreen) — Mail Center to v20.
//
// Owner 2026-07-02 (v20 `MobileMailCenter.tsx`): a real mail client —
//   • LIST: avatar (initials) + party + subject + preview + date + unread dot,
//     Inbox / Sent folders.
//   • THREAD: message bubbles (inbound left / outbound dark-gold right) + Reply.
// Rebuilt with REAL data (mailConfig source + GET /threads/:id → {thread,
// messages}). Compose / Reply reuse the existing newMailSpec form.
//
// ADDITIVE: list = CUSTOM_L1['mail-center']; thread = CUSTOM_L2['mail-center'].
// ===========================================================================
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Search, Plus, Paperclip } from "lucide-react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { MobileHeader, FormSheet } from "../components";
import { M, M_ACCENT } from "../theme";
import { mailConfig } from "../config/modules";
import { newMailSpec } from "../config/forms";
import { type FormSpec } from "../config/form-types";
import { str, num, dateOnly, shortDate } from "../config/helpers";
import { useDebounced } from "../lib/use-debounced";

const AV = ["#6B5C32", "#3E6570", "#4F7C3A", "#9A3A2D", "#6B4A6D"];
const avColor = (s: string) => AV[(s || "?").charCodeAt(0) % 5];
const ini = (s: string) =>
  (s || "?")
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

// ---- LIST ------------------------------------------------------------------
export function MailCenterScreen() {
  const navigate = useNavigate();
  const source = mailConfig.sources[0];
  const { data, loading, error } = useCachedJson<unknown>(source.url);
  const [folder, setFolder] = useState<"inbox" | "sent">("inbox");
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const [composeSpec, setComposeSpec] = useState<FormSpec | null>(null);

  const rows = useMemo(() => {
    const all = data ? source.select(data) : [];
    const n = dq.trim().toLowerCase();
    return all.filter((r) => {
      const inFolder = folder === "sent" ? r.hasOutbound === true : r.trashedAt == null;
      if (!inFolder) return false;
      if (
        n &&
        !`${str(r, "counterpartyName", "counterpartyEmail")} ${str(r, "subject")}`.toLowerCase().includes(n)
      )
        return false;
      return true;
    });
  }, [data, source, folder, dq]);

  return (
    <>
      <MobileHeader
        title="Mail Center"
        onBack={() => navigate(-1)}
        trailing={
          <button
            onClick={() => setComposeSpec(newMailSpec())}
            aria-label="Compose"
            style={{ width: 34, height: 34, borderRadius: 10, border: "none", backgroundColor: M.taupe, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", WebkitTapHighlightColor: "transparent" }}
          >
            <Plus size={20} strokeWidth={2.2} />
          </button>
        }
      />

      <div style={{ padding: "12px 18px 4px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "11px 13px", backgroundColor: M.card, border: `1px solid ${M.hairline}`, borderRadius: 12 }}>
          <Search size={18} strokeWidth={1.75} color={M.faint} />
          <input
            value={q}
            placeholder="Search subject · party"
            onChange={(e) => setQ(e.target.value)}
            style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontSize: 14, color: M.raisin }}
          />
        </div>
      </div>

      <div style={{ display: "flex", gap: 7, padding: "10px 18px 4px" }}>
        {(["inbox", "sent"] as const).map((f) => {
          const on = folder === f;
          return (
            <button
              key={f}
              onClick={() => setFolder(f)}
              style={{ height: 30, padding: "0 15px", borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: "pointer", border: `1px solid ${on ? M.taupe : M.hairline}`, background: on ? M_ACCENT.gold.bg : M.card, color: on ? M.taupe : M.muted, WebkitTapHighlightColor: "transparent" }}
            >
              {f === "inbox" ? "Inbox" : "Sent"}
            </button>
          );
        })}
      </div>

      {loading && !data ? (
        <Msg text="Loading…" />
      ) : error && !data ? (
        <Msg text="Couldn’t load mail." />
      ) : rows.length === 0 ? (
        <Msg text={`Nothing in ${folder}.`} />
      ) : (
        <div style={{ padding: "8px 18px 120px" }}>
          {rows.map((r) => {
            const party = str(r, "counterpartyName", "counterpartyEmail") || "—";
            const unread = r.unread === true;
            return (
              <div
                key={str(r, "id")}
                onClick={() => navigate(`/m/mail-center/${encodeURIComponent(str(r, "id"))}`)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    navigate(`/m/mail-center/${encodeURIComponent(str(r, "id"))}`);
                  }
                }}
                style={{ display: "flex", gap: 11, background: M.card, border: `1px solid ${M.border}`, borderRadius: 16, padding: "12px 14px", marginBottom: 10, cursor: "pointer", boxShadow: "0 1px 0 rgba(31,29,27,.03),0 6px 20px -12px rgba(31,29,27,.14)", WebkitTapHighlightColor: "transparent" }}
              >
                <div style={{ width: 38, height: 38, flex: "none", borderRadius: "50%", background: avColor(party), color: "#fff", fontSize: 13, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  {ini(party)}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: unread ? 800 : 600, color: M.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{party}</span>
                    <span style={{ fontSize: 10, color: M.faint }}>{shortDate(dateOnly(r, "lastMessageAt"))}</span>
                  </div>
                  <div style={{ fontSize: 12.5, fontWeight: unread ? 700 : 500, color: M.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>
                    {str(r, "subject") || "(No subject)"}
                    {num(r, "messageCount") > 1 ? ` (${num(r, "messageCount")})` : ""}
                  </div>
                </div>
                {unread ? <span style={{ width: 8, height: 8, flex: "none", borderRadius: "50%", background: M.taupe, marginTop: 6 }} /> : null}
              </div>
            );
          })}
        </div>
      )}

      <FormSheet open={composeSpec != null} onClose={() => setComposeSpec(null)} spec={composeSpec} onSaved={() => setComposeSpec(null)} />
    </>
  );
}

// ---- THREAD ----------------------------------------------------------------
type ThreadResp = { thread?: Record<string, unknown>; messages?: Record<string, unknown>[] };

export function MailThreadScreen() {
  const navigate = useNavigate();
  const { id = "" } = useParams();
  const { data, loading, error } = useCachedJson<ThreadResp>(
    `/api/mail-center/threads/${encodeURIComponent(id)}`,
  );
  const [composeSpec, setComposeSpec] = useState<FormSpec | null>(null);
  const [signed, setSigned] = useState(false);
  const [signing, setSigning] = useState(false);

  const thread = data?.thread ?? null;
  const messages = Array.isArray(data?.messages) ? (data!.messages as Record<string, unknown>[]) : [];

  // "Sign receipt" (design, inbound mail) = acknowledge = mark the thread read +
  // closed via the real PATCH /api/mail-center/threads/:id. Forward (the design's
  // sent-side action) has no backend endpoint, so it's intentionally absent.
  // window.fetch is globally CSRF-patched, so a raw fetch is fine.
  const signReceipt = async () => {
    if (signing) return;
    setSigning(true);
    try {
      const r = await fetch(`/api/mail-center/threads/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "closed", unread: false }),
      });
      if (r.ok) {
        setSigned(true);
        // Broadcast so the mail lists (mobile + desktop Mail Center) drop the
        // unread badge / show closed without a reload (2026-07-04 cache sweep).
        invalidateCachePrefix("/api/mail-center");
      } else window.alert("Couldn’t sign receipt.");
    } catch {
      window.alert("Network error.");
    } finally {
      setSigning(false);
    }
  };

  if (loading && !thread) return <Center text="Loading…" />;
  if (error && !thread) return <Center text="Couldn’t load this thread." />;
  if (!thread) return <Center text="Thread not found." />;

  return (
    <div style={{ paddingBottom: 92 }}>
      <div style={{ background: M.card, padding: "14px 16px 12px", borderBottom: `1px solid ${M.divider}`, position: "sticky", top: 0, zIndex: 5 }}>
        <button onClick={() => navigate(-1)} style={{ background: "none", border: "none", color: M.taupe, fontWeight: 600, fontSize: 12.5, cursor: "pointer" }}>‹ Mail</button>
        <div style={{ fontSize: 16, fontWeight: 700, color: M.ink, marginTop: 4, letterSpacing: "-0.2px" }}>
          {str(thread, "subject") || "(No subject)"}
        </div>
      </div>

      <div style={{ padding: "14px 16px" }}>
        {messages.map((g, i) => {
          const out = str(g, "direction") === "outbound";
          const who = str(g, "fromName", "fromAddress") || (out ? "Sent" : "Received");
          const body = str(g, "textBody", "body", "snippet");
          return (
            <div key={i} style={{ display: "flex", gap: 10, marginBottom: 14 }}>
              <div style={{ width: 34, height: 34, flex: "none", borderRadius: "50%", background: out ? M.raisin : avColor(who), color: "#fff", fontSize: 12, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center" }}>
                {ini(who)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: M.ink }}>{who}</span>
                  <span style={{ fontSize: 10, color: M.faint, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {str(g, "fromAddress")}
                  </span>
                  <span style={{ fontSize: 10, color: M.faint, flex: "none" }}>
                    {dateOnly(g, "sentAt", "receivedAt", "createdAt")}
                  </span>
                </div>
                <div style={{ fontSize: 13, lineHeight: 1.6, color: "#3A352C", marginTop: 5, background: out ? M_ACCENT.gold.bg : "#F5F2ED", borderRadius: 12, padding: "11px 13px", whiteSpace: "pre-wrap" }}>
                  {body || "—"}
                </div>
              </div>
            </div>
          );
        })}
        {num(thread, "attachmentCount") > 0 ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 14px", background: M.card, border: `1px solid ${M.border}`, borderRadius: 14 }}>
            <Paperclip size={16} color={M.taupe} strokeWidth={2} />
            <span style={{ fontSize: 12, fontWeight: 600, color: M.ink }}>
              {num(thread, "attachmentCount")} attachment(s)
            </span>
          </div>
        ) : null}
      </div>

      <div style={{ position: "sticky", bottom: 0, background: M.card, borderTop: `1px solid ${M.divider}`, padding: "12px 16px calc(12px + env(safe-area-inset-bottom))", display: "flex", gap: 9 }}>
        {signed || str(thread, "status") === "closed" ? (
          <div style={{ flex: 1, height: 48, display: "flex", alignItems: "center", justifyContent: "center", border: `1px solid ${M.border}`, borderRadius: 12, background: M.card, color: "#4F7C3A", fontSize: 13.5, fontWeight: 700 }}>
            Receipt signed ✓
          </div>
        ) : (
          <button
            onClick={signReceipt}
            disabled={signing}
            style={{ flex: 1, height: 48, border: `1px solid ${M.taupe}`, borderRadius: 12, background: M.card, color: M.taupe, fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: signing ? "default" : "pointer" }}
          >
            {signing ? "Signing…" : "Sign receipt"}
          </button>
        )}
        <button
          onClick={() => setComposeSpec(newMailSpec())}
          style={{ flex: 1, height: 48, border: "none", borderRadius: 12, background: M.taupe, color: "#fff", fontFamily: "inherit", fontSize: 14, fontWeight: 700, cursor: "pointer" }}
        >
          Reply
        </button>
      </div>

      <FormSheet open={composeSpec != null} onClose={() => setComposeSpec(null)} spec={composeSpec} onSaved={() => setComposeSpec(null)} />
    </div>
  );
}

function Msg({ text }: { text: string }) {
  return <div style={{ padding: "40px 18px", textAlign: "center", color: M.muted, fontSize: 14 }}>{text}</div>;
}
function Center({ text }: { text: string }) {
  return <div style={{ padding: "60px 18px", textAlign: "center", color: M.muted, fontSize: 14 }}>{text}</div>;
}
