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
import { Search, SlidersHorizontal } from "lucide-react";
import { useCachedJson } from "@/lib/cached-fetch";
import { MobileHeader, MobileCard, ListRow, StatusPill } from "../components";
import { SubTabs } from "../components/SubTabs";
import { FilterSheet } from "../components/FilterSheet";
import { M } from "../theme";
import { type ModuleConfig, type ActiveFilter } from "../config/types";
import {
  applyFilters,
  applySort,
  activeFilterCount,
  findSourceForTab,
} from "../config/helpers";

type Sort = { key: string; dir: "asc" | "desc" } | null;

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

  const rows = useMemo(() => {
    const raw = data ? source.select(data) : [];
    const byTab = raw.filter((r) => tab.match(r));
    const filtered = applyFilters(byTab, source.columns, filters, search);
    return applySort(filtered, source.columns, sort);
  }, [data, source, tab, filters, search, sort]);

  const fCount = activeFilterCount(filters);

  return (
    <>
      <MobileHeader title={config.title} onBack={() => navigate(-1)} />

      <SubTabs tabs={allTabs} active={activeTab} onChange={setActiveTab} />

      {/* Search + Filter bar */}
      <div style={{ display: "flex", gap: 8, padding: "10px 12px 6px" }}>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 12px",
            backgroundColor: M.card,
            border: `1px solid ${M.border}`,
            borderRadius: 12,
          }}
        >
          <Search size={16} strokeWidth={1.75} color={M.muted} />
          <input
            value={search}
            placeholder="Search…"
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
            gap: 6,
            padding: "0 14px",
            backgroundColor: fCount > 0 ? M.taupe : M.card,
            border: `1px solid ${fCount > 0 ? M.taupe : M.border}`,
            borderRadius: 12,
            color: fCount > 0 ? "#fff" : M.body,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <SlidersHorizontal size={16} strokeWidth={1.75} />
          {fCount > 0 ? fCount : ""}
        </button>
      </div>

      {/* List */}
      <div style={{ padding: "6px 12px 0" }}>
        <MobileCard padded={false}>
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
            rows.map((row) => {
              const vm = source.toVM(row);
              const dest = config.detailPath?.(vm, row) ?? null;
              return (
                <ListRow
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
        </MobileCard>
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
    </>
  );
}

function Msg({ text }: { text: string }) {
  return (
    <div
      style={{
        padding: "28px 16px",
        textAlign: "center",
        color: M.muted,
        fontSize: 13,
      }}
    >
      {text}
    </div>
  );
}
