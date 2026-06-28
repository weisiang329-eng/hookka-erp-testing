// ===========================================================================
// ModuleListScreen — the ONE generic L1 list screen that powers every module.
//
// Driven entirely by a ModuleConfig (src/pages/m/config/modules.ts). It:
//   • renders the MobileHeader + a search box + a Filter/Sort button,
//   • renders the SubTabs row (across all of the config's sources),
//   • fetches the active source's endpoint via the shared SWR cache,
//   • applies the sub-tab predicate + active filters + sort,
//   • maps rows → view-models and renders them as ListRow cards,
//   • taps a row → the config's L2 detail route (Phase 3 supplies the screen).
//
// ADDITIVE: pure consumer of existing endpoints + Phase-1 primitives.
// ===========================================================================
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search, SlidersHorizontal, Plus } from "lucide-react";
import { useCachedJson } from "@/lib/cached-fetch";
import { MobileHeader, DocCard, StatusPill, FormSheet } from "../components";
import { SubTabs } from "../components/SubTabs";
import { FilterSheet } from "../components/FilterSheet";
import { M } from "../theme";
import { type ModuleConfig, type ActiveFilter } from "../config/types";
import { type FormSpec } from "../config/form-types";
import { createSpecFor } from "../config/forms";
import {
  applyFilters,
  applySort,
  activeFilterCount,
  findSourceForTab,
} from "../config/helpers";

type Sort = { key: string; dir: "asc" | "desc" } | null;

// Perf cap — the raw list can hold 1,800+ rows (Inventory). Painting that many
// cards freezes a phone, so we render in pages and reveal more on demand. This
// changes ONLY how many of the already-fetched rows are painted; the fetch and
// the filtered/sorted set are untouched (counts, search, etc. still see all).
const PAGE_SIZE = 40;

export function ModuleListScreen({ config }: { config: ModuleConfig }) {
  const navigate = useNavigate();

  // Flatten every source's sub-tabs into one ordered tab row.
  const allTabs = useMemo(
    () => config.sources.flatMap((s) => s.subTabs),
    [config],
  );
  const [activeTab, setActiveTab] = useState(allTabs[0]?.key ?? "");
  const [search, setSearch] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  // "+" create form for modules that have one (SO / Delivery / Procure /
  // Invoice / Announcements / Mail). null = this module has no mobile create.
  const [createSpec, setCreateSpec] = useState<FormSpec | null>(null);
  const canCreate = createSpecFor(config.slug) != null;

  // Per-source filter + sort state (keyed by source url so switching tab groups
  // keeps each group's own filters).
  const [filtersByUrl, setFiltersByUrl] = useState<
    Record<string, Record<string, ActiveFilter>>
  >({});
  const [sortByUrl, setSortByUrl] = useState<Record<string, Sort>>({});

  const resolved = findSourceForTab(config.sources, activeTab);
  const source = resolved?.source ?? config.sources[0];
  const tab = resolved?.tab ?? source.subTabs[0];

  const { data, loading, error } = useCachedJson<unknown>(source.url);

  const filters = useMemo(
    () => filtersByUrl[source.url] ?? {},
    [filtersByUrl, source.url],
  );
  const sort = useMemo(
    () => sortByUrl[source.url] ?? source.defaultSort ?? null,
    [sortByUrl, source.url, source.defaultSort],
  );

  // Rows for the active source (pre-tab), reused for both the count badges and
  // the visible list — avoids re-running select() twice.
  const sourceRows = useMemo(
    () => (data ? source.select(data) : []),
    [data, source],
  );

  const rows = useMemo(() => {
    const byTab = sourceRows.filter((r) => tab.match(r));
    const filtered = applyFilters(byTab, source.columns, filters, search);
    return applySort(filtered, source.columns, sort);
  }, [sourceRows, source, tab, filters, search, sort]);

  // How many rows are painted. Reset to the first page whenever the visible set
  // changes (tab / source / filters / search / sort) so "Show more" never
  // strands the list mid-scroll on a different dataset. Render-time state reset
  // (the codebase's endorsed alternative to setState-in-effect).
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const resetKey = `${source.url}|${activeTab}|${search}|${JSON.stringify(
    filters,
  )}|${sort ? sort.key + sort.dir : ""}`;
  const [lastResetKey, setLastResetKey] = useState(resetKey);
  if (resetKey !== lastResetKey) {
    setLastResetKey(resetKey);
    setVisibleCount(PAGE_SIZE);
  }

  const visibleRows = rows.slice(0, visibleCount);
  const hiddenCount = rows.length - visibleRows.length;

  // Per-tab count badges (design source shows a count on each segment pill).
  // Only the active source's tabs get real counts — tabs from other sources
  // would need their own fetch, so they stay badge-less rather than fabricated.
  const tabCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const t of source.subTabs) {
      out[t.key] = sourceRows.filter((r) => t.match(r)).length;
    }
    return out;
  }, [source, sourceRows]);

  const fCount = activeFilterCount(filters);

  return (
    <>
      <MobileHeader
        title={config.title}
        onBack={() => navigate(-1)}
        trailing={
          canCreate ? (
            <button
              onClick={() => setCreateSpec(createSpecFor(config.slug))}
              aria-label={`New ${config.title}`}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 34,
                height: 34,
                borderRadius: 10,
                border: "none",
                backgroundColor: M.taupe,
                color: "#fff",
                cursor: "pointer",
                WebkitTapHighlightColor: "transparent",
              }}
            >
              <Plus size={20} strokeWidth={2.2} />
            </button>
          ) : undefined
        }
      />

      <SubTabs
        tabs={allTabs}
        active={activeTab}
        onChange={setActiveTab}
        counts={tabCounts}
      />

      {/* Search + Filter bar — design source: white pill (radius 12, border
          #E2DDD8) + a square sliders button that dots when filters are active. */}
      <div style={{ display: "flex", gap: 9, padding: "12px 18px 6px" }}>
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
            value={search}
            placeholder={`Search ${config.title}…`}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              flex: 1,
              minWidth: 0,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: 14,
              color: M.raisin,
            }}
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

      {/* Optional bespoke panel above the list (e.g. Employees → Pending
          requests on the Attendance tab). */}
      {config.topPanel ? (
        <div style={{ padding: "6px 18px 0" }}>{config.topPanel(activeTab)}</div>
      ) : null}

      {/* List — card per document (design source: card-based list). */}
      <div
        style={{
          padding: "6px 18px 0",
          display: "flex",
          flexDirection: "column",
          gap: 11,
        }}
      >
        {loading && rows.length === 0 ? (
          <Msg text="Loading…" />
        ) : rows.length === 0 ? (
          <Msg
            text={
              error
                ? "Couldn’t load — pull to refresh or use the desktop app."
                : "No records match."
            }
          />
        ) : (
          visibleRows.map((row) => {
            const vm = source.toVM(row);
            const dest = config.detailPath?.(vm, row) ?? null;
            return (
              <DocCard
                key={vm.id}
                code={vm.code}
                title={vm.title}
                subLine={vm.subLine}
                meta={[vm.meta1, vm.meta2]}
                pill={
                  vm.status ? (
                    <StatusPill
                      style={vm.status.style}
                      label={vm.status.label}
                      size="sm"
                    />
                  ) : undefined
                }
                onClick={dest ? () => navigate(dest) : undefined}
              />
            );
          })
        )}

        {/* Show more — reveals the next page of the already-fetched rows. */}
        {hiddenCount > 0 ? (
          <button
            onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
            style={{
              marginTop: 3,
              padding: "12px 0",
              borderRadius: 12,
              border: `1px solid ${M.hairline}`,
              backgroundColor: M.card,
              color: M.ink,
              fontSize: 14,
              fontWeight: 700,
              cursor: "pointer",
              WebkitTapHighlightColor: "transparent",
            }}
          >
            Show more ({hiddenCount} more)
          </button>
        ) : null}
      </div>

      <div style={{ height: 12 }} />

      <FilterSheet
        open={filterOpen}
        onClose={() => setFilterOpen(false)}
        columns={source.columns}
        filters={filters}
        sort={sort}
        onApply={(nextFilters, nextSort) => {
          setFiltersByUrl((p) => ({ ...p, [source.url]: nextFilters }));
          setSortByUrl((p) => ({ ...p, [source.url]: nextSort }));
        }}
      />

      {/* "+" create form. On save, navigate to the new doc's L2 detail. */}
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
  return (
    <div
      style={{
        backgroundColor: M.card,
        border: `1px solid ${M.border}`,
        borderRadius: 16,
        padding: "32px 16px",
        textAlign: "center",
        color: M.muted,
        fontSize: 13,
      }}
    >
      {text}
    </div>
  );
}
