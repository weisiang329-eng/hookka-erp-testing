// ===========================================================================
// AnnouncementsScreen — L1 Announcements list.
//
// Owner 2026-07-02 (v20 `MobileAnnouncements.tsx`): a bespoke card — pin + a
// category eyebrow on top, an unread dot on the right, a 2-line body preview,
// and a date · author footer — NOT the generic code/badge card. Rebuilt to that
// look with REAL fields (category/title/body/createdAt/createdBy/isActive).
//
// Chips: All / Pinned. (v20 also has "Unread", but the list rows carry no
// per-user acknowledged flag, so that chip is omitted rather than faked.)
// Detail stays on the existing generic screen (already renders the body card +
// read-receipt roster).
//
// ADDITIVE: replaces ONLY the /m/announcements L1 view (CUSTOM_L1).
// ===========================================================================
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, Plus, Pin } from "lucide-react";
import { useCachedJson } from "@/lib/cached-fetch";
import { MobileHeader, FormSheet } from "../components";
import { M, M_ACCENT } from "../theme";
import { announcementsConfig } from "../config/modules";
import { newAnnouncementSpec } from "../config/forms";
import { type FormSpec } from "../config/form-types";
import { str, dateOnly, shortDate } from "../config/helpers";

const CHIPS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "pinned", label: "Pinned" },
];

export function AnnouncementsScreen() {
  const navigate = useNavigate();
  const source = announcementsConfig.sources[0];
  const { data, loading, error } = useCachedJson<unknown>(source.url);
  const [q, setQ] = useState("");
  const [chip, setChip] = useState("all");
  const [createSpec, setCreateSpec] = useState<FormSpec | null>(null);

  const allRows = useMemo(() => (data ? source.select(data) : []), [data, source]);

  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    return allRows.filter((r) => {
      if (chip === "pinned" && r.isActive !== true) return false;
      if (
        n &&
        !`${str(r, "title")} ${str(r, "body", "description", "content")} ${str(r, "category")}`
          .toLowerCase()
          .includes(n)
      )
        return false;
      return true;
    });
  }, [allRows, chip, q]);

  return (
    <>
      <MobileHeader
        title="Announcements"
        onBack={() => navigate(-1)}
        trailing={
          <button
            onClick={() => setCreateSpec(newAnnouncementSpec())}
            aria-label="New announcement"
            style={{
              width: 34,
              height: 34,
              borderRadius: 10,
              border: "none",
              backgroundColor: M.taupe,
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            <Plus size={20} strokeWidth={2.2} />
          </button>
        }
      />

      <div style={{ padding: "12px 18px 4px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "11px 13px",
            backgroundColor: M.card,
            border: `1px solid ${M.hairline}`,
            borderRadius: 12,
          }}
        >
          <Search size={18} strokeWidth={1.75} color={M.faint} />
          <input
            value={q}
            placeholder="Search title · body"
            onChange={(e) => setQ(e.target.value)}
            style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontSize: 14, color: M.raisin }}
          />
        </div>
      </div>

      <div style={{ display: "flex", gap: 7, padding: "10px 18px 4px" }}>
        {CHIPS.map((c) => {
          const on = chip === c.key;
          return (
            <button
              key={c.key}
              onClick={() => setChip(c.key)}
              style={{
                height: 30,
                padding: "0 13px",
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 600,
                cursor: "pointer",
                border: `1px solid ${on ? M.taupe : M.hairline}`,
                background: on ? M_ACCENT.gold.bg : M.card,
                color: on ? M.taupe : M.muted,
                WebkitTapHighlightColor: "transparent",
              }}
            >
              {c.label}
            </button>
          );
        })}
      </div>

      {loading && !data ? (
        <Msg text="Loading…" />
      ) : error && !data ? (
        <Msg text="Couldn’t load announcements." />
      ) : rows.length === 0 ? (
        <Msg text={q || chip !== "all" ? "No matching announcements." : "No announcements."} />
      ) : (
        <div style={{ padding: "8px 18px 120px" }}>
          {rows.map((r) => {
            const pinned = r.isActive === true;
            const body = str(r, "body", "description", "content");
            return (
              <div
                key={str(r, "id")}
                onClick={() => navigate(`/m/announcements/${encodeURIComponent(str(r, "id"))}`)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    navigate(`/m/announcements/${encodeURIComponent(str(r, "id"))}`);
                  }
                }}
                style={{
                  background: M.card,
                  border: `1px solid ${M.border}`,
                  borderRadius: 16,
                  padding: "13px 15px",
                  marginBottom: 11,
                  cursor: "pointer",
                  boxShadow: "0 1px 0 rgba(31,29,27,.03),0 6px 20px -12px rgba(31,29,27,.14)",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {pinned ? <Pin size={13} color="#C9A961" fill="#C9A961" strokeWidth={1.5} /> : null}
                    <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: ".4px", textTransform: "uppercase", color: M.taupe }}>
                      {str(r, "category") || "Notice"}
                    </span>
                  </span>
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: M.raisin, marginTop: 7, letterSpacing: "-0.2px" }}>
                  {str(r, "title") || "—"}
                </div>
                {body ? (
                  <div style={{ fontSize: 12.5, color: M.muted, marginTop: 4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                    {body}
                  </div>
                ) : null}
                <div style={{ display: "flex", gap: 8, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${M.divider}`, fontSize: 11, color: M.faint }}>
                  <span>{shortDate(dateOnly(r, "createdAt")) || "—"}</span>
                  <span>·</span>
                  <span>{str(r, "createdBy", "createdByName") || "—"}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <FormSheet
        open={createSpec != null}
        onClose={() => setCreateSpec(null)}
        spec={createSpec}
        onSaved={(to) => {
          setCreateSpec(null);
          if (to) navigate(to);
        }}
      />
    </>
  );
}

function Msg({ text }: { text: string }) {
  return <div style={{ padding: "40px 18px", textAlign: "center", color: M.muted, fontSize: 14 }}>{text}</div>;
}
