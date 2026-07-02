// ===========================================================================
// ServiceCasesScreen — L1 Service Cases list.
//
// Owner 2026-07-02 (v20 `MobileServiceCase.tsx`): status chips + cards showing
// Category / Source / Stage. Rebuilt to that look with REAL fields.
//
// NOTE on the detail: v20's mock detail is a "5W" form (issue_what/where/when/
// who/why) that the REAL service-case record does NOT have (it carries
// issueDescription + rootCauses[] + responsibleUnit/preventionStatus). Forcing
// the 5W layout would render empty fabricated fields, so the L2 detail stays on
// the existing config-driven DocumentDetailScreen (which maps the real fields +
// the 8-stage pipeline). This screen only rebuilds the L1 LIST.
//
// ADDITIVE: replaces ONLY the /m/servicecases L1 view (CUSTOM_L1).
// ===========================================================================
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, SlidersHorizontal } from "lucide-react";
import { useCachedJson } from "@/lib/cached-fetch";
import { MobileHeader, StatusPill, FilterSheet } from "../components";
import { M, M_ACCENT } from "../theme";
import { serviceCasesConfig } from "../config/modules";
import { type ActiveFilter } from "../config/types";
import { str, applyFilters, applySort, activeFilterCount } from "../config/helpers";

type Sort = { key: string; dir: "asc" | "desc" } | null;

const CHIPS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "OPEN", label: "Open" },
  { key: "IN_PROGRESS", label: "In Progress" },
  { key: "CLOSED", label: "Closed" },
  { key: "CANCELLED", label: "Cancelled" },
];

export function ServiceCasesScreen() {
  const navigate = useNavigate();
  const source = serviceCasesConfig.sources[0];
  const { data, loading, error } = useCachedJson<unknown>(source.url);
  const [q, setQ] = useState("");
  const [chip, setChip] = useState("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [filters, setFilters] = useState<Record<string, ActiveFilter>>({});
  const [sort, setSort] = useState<Sort>(source.defaultSort ?? null);

  const allRows = useMemo(() => (data ? source.select(data) : []), [data, source]);

  const rows = useMemo(() => {
    const byChip = allRows.filter((r) => chip === "all" || str(r, "status") === chip);
    return applySort(applyFilters(byChip, source.columns, filters, q), source.columns, sort);
  }, [allRows, chip, source, filters, q, sort]);

  const counts = useMemo(() => {
    const searched = applyFilters(allRows, source.columns, filters, q);
    const c: Record<string, number> = { all: searched.length };
    for (const r of searched) {
      const s = str(r, "status");
      c[s] = (c[s] ?? 0) + 1;
    }
    return c;
  }, [allRows, source, filters, q]);

  const fCount = activeFilterCount(filters);

  return (
    <>
      <MobileHeader title="Service Cases" onBack={() => navigate(-1)} />

      <div style={{ display: "flex", gap: 7, padding: "12px 18px 4px", minWidth: 0 }}>
        <div
          style={{
            flex: 1,
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
            placeholder="Search case · customer · category"
            onChange={(e) => setQ(e.target.value)}
            style={{ flex: 1, minWidth: 0, border: "none", outline: "none", background: "transparent", fontSize: 14, color: M.raisin }}
          />
        </div>
        <button
          onClick={() => setFilterOpen(true)}
          aria-label="Filter and sort"
          style={{
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            width: fCount > 0 ? undefined : 44,
            padding: fCount > 0 ? "0 14px" : 0,
            backgroundColor: fCount > 0 ? M.taupe : M.card,
            border: `1px solid ${fCount > 0 ? M.taupe : M.hairline}`,
            borderRadius: 12,
            color: fCount > 0 ? "#fff" : M.ink,
            fontSize: 13,
            fontWeight: 700,
            cursor: "pointer",
            flexShrink: 0,
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <SlidersHorizontal size={19} strokeWidth={1.75} />
          {fCount > 0 ? fCount : ""}
        </button>
      </div>

      <div style={{ display: "flex", gap: 7, overflowX: "auto", padding: "10px 18px 4px", WebkitOverflowScrolling: "touch" }}>
        {CHIPS.map((c) => {
          const on = chip === c.key;
          const n = counts[c.key] ?? 0;
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
                whiteSpace: "nowrap",
                flex: "none",
                cursor: "pointer",
                border: `1px solid ${on ? M.taupe : M.hairline}`,
                background: on ? M_ACCENT.gold.bg : M.card,
                color: on ? M.taupe : M.muted,
                WebkitTapHighlightColor: "transparent",
              }}
            >
              {c.label}
              {n > 0 ? <span style={{ marginLeft: 6, fontSize: 10.5, opacity: 0.7 }}>{n}</span> : null}
            </button>
          );
        })}
      </div>

      {loading && !data ? (
        <Msg text="Loading…" />
      ) : error && !data ? (
        <Msg text="Couldn’t load service cases." />
      ) : rows.length === 0 ? (
        <Msg text={q || chip !== "all" ? "No matching cases." : "No service cases."} />
      ) : (
        <div style={{ padding: "8px 18px 120px" }}>
          {rows.map((r) => {
            const vm = source.toVM(r);
            const cancelled = str(r, "status") === "CANCELLED";
            const affected = [str(r, "sourceNo", "sourceType"), str(r, "rootCauseCategory")]
              .filter(Boolean)
              .join(" · ");
            const metas: [string, string][] = [
              ["Category", str(r, "rootCauseCategory") || "—"],
              ["Source", str(r, "sourceType", "sourceNo") || "—"],
              ["Stage", vm.status?.label || str(r, "status") || "—"],
            ];
            return (
              <div
                key={vm.id}
                onClick={() => navigate(`/m/servicecases/${encodeURIComponent(vm.id)}`)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    navigate(`/m/servicecases/${encodeURIComponent(vm.id)}`);
                  }
                }}
                style={{
                  background: M.card,
                  border: `1px solid ${M.border}`,
                  borderRadius: 16,
                  padding: "13px 15px",
                  marginBottom: 11,
                  cursor: "pointer",
                  opacity: cancelled ? 0.55 : 1,
                  boxShadow: "0 1px 0 rgba(31,29,27,.03),0 6px 20px -12px rgba(31,29,27,.14)",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: M.taupe, fontVariantNumeric: "tabular-nums" }}>
                    {vm.code}
                  </span>
                  {vm.status ? <StatusPill style={vm.status.style} label={vm.status.label} size="sm" /> : null}
                </div>
                <div style={{ fontSize: 15, fontWeight: 700, color: M.raisin, marginTop: 8, letterSpacing: "-0.2px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {vm.title}
                </div>
                {affected ? (
                  <div style={{ fontSize: 12.5, color: M.muted, marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {affected}
                  </div>
                ) : null}
                <div style={{ display: "flex", gap: 18, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${M.divider}` }}>
                  {metas.map(([l, v]) => (
                    <div key={l} style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: ".3px", textTransform: "uppercase", color: M.faint }}>{l}</div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: M.ink, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <FilterSheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        columns={source.columns}
        filters={filters}
        sort={sort}
        onApply={(nextFilters, nextSort) => {
          setFilters(nextFilters);
          setSort(nextSort);
        }}
      />
    </>
  );
}

function Msg({ text }: { text: string }) {
  return <div style={{ padding: "40px 18px", textAlign: "center", color: M.muted, fontSize: 14 }}>{text}</div>;
}
