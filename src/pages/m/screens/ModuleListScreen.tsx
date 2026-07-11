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
import { useMemo, useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Search, SlidersHorizontal, Plus, ScanLine, FileSearch, ListChecks, X, Download, Check, PackageCheck } from "lucide-react";
import { useCachedJson, invalidateCachePrefix } from "@/lib/cached-fetch";
import { MobileHeader, DocCard, StatusPill, FormSheet, ScanSheet, ScanPOSheet } from "../components";
import { newSalesOrderSpec, type SOCreatePrefill } from "../config/forms";
import { SubTabs } from "../components/SubTabs";
import { FilterSheet } from "../components/FilterSheet";
import { M } from "../theme";
import { type ModuleConfig, type ActiveFilter, type DataSource, type RawRow } from "../config/types";
import { useDebounced } from "../lib/use-debounced";
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
  // Debounced query drives the (heavy) filter over the full list; the <input>
  // stays bound to `search` so typing is instant even on 900–1,800-row lists.
  const debouncedSearch = useDebounced(search);
  const [filterOpen, setFilterOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  // Sticky one-shot scan-result toast — clears after 2.5s.
  const [scanToast, setScanToast] = useState<string | null>(null);
  // OCR Scan-PO (dc12 — sales module only): captures a customer PO photo,
  // extracts via /api/scan-po/extract, opens a prefilled new-SO form.
  const [scanPOOpen, setScanPOOpen] = useState(false);
  const canScanPO = config.slug === "sales";
  // Multi-select mode (dc13 v13 SELECT ACTION BAR). Mark wires to real
  // per-module status-transition endpoints (matches desktop's
  // BatchActionToolbar + delivery bulk-dispatch pattern). Export is a
  // placeholder until owner defines what "bulk export" means per module
  // (one combined PDF vs zip).
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };
  // Per-module bulk-mark target (null = module has no bulk mark wired yet).
  // Matches desktop:
  //   sales      → CONFIRMED        (DRAFT → CONFIRMED)
  //   delivery   → DISPATCHED       (LOADED/READY → DISPATCHED)
  //   procurement→ SENT             (DRAFT → SENT)
  //   invoices   → PAID             (UNPAID → PAID)
  // For modules with no obvious next-status, the Mark button just toasts.
  const bulkMarkConfig: Record<
    string,
    { label: string; status: string; endpoint: (id: string) => string }
  > = {
    sales: {
      label: "Mark Confirmed",
      status: "CONFIRMED",
      endpoint: (id) => `/api/sales-orders/${encodeURIComponent(id)}`,
    },
    delivery: {
      label: "Mark Dispatched",
      status: "DISPATCHED",
      endpoint: (id) => `/api/delivery-orders/${encodeURIComponent(id)}`,
    },
    procurement: {
      label: "Mark Sent",
      status: "SENT",
      endpoint: (id) => `/api/purchase-orders/${encodeURIComponent(id)}`,
    },
    invoices: {
      label: "Mark Paid",
      status: "PAID",
      endpoint: (id) => `/api/invoices/${encodeURIComponent(id)}`,
    },
    announcements: {
      label: "Mark Read",
      status: "READ",
      endpoint: (id) => `/api/announcements/${encodeURIComponent(id)}/read`,
    },
  };
  const bulkCfg = bulkMarkConfig[config.slug];
  /** Procurement-only bulk Convert to GRN. Mirrors desktop pattern in
   * src/pages/procurement/index.tsx:1186 — for each PO id, fetch the PO,
   * build full-receipt items from outstanding qty per line, POST /api/grn,
   * then PUT GRN status=POSTED to fire the cascade. Sequential to avoid
   * deadlock. */
  async function runBulkConvertToGrn() {
    if (selectedIds.size === 0) return;
    setBulkBusy(true);
    const ids = Array.from(selectedIds);
    let ok = 0, failed = 0;
    for (const id of ids) {
      try {
        const poRes = await fetch(`/api/purchase-orders/${encodeURIComponent(id)}`);
        if (!poRes.ok) { failed++; continue; }
        const poJson = (await poRes.json()) as { data?: { id: string; poNo?: string; items?: { quantity: number; receivedQty?: number }[] } };
        const po = poJson.data;
        if (!po?.items) { failed++; continue; }
        const items = po.items
          .map((it, idx) => {
            const outstanding = Math.max(0, it.quantity - (it.receivedQty ?? 0));
            return outstanding > 0
              ? { poItemIndex: idx, receivedQty: outstanding, acceptedQty: outstanding, rejectedQty: 0, rejectionReason: null }
              : null;
          })
          .filter((x): x is NonNullable<typeof x> => x !== null);
        if (items.length === 0) { failed++; continue; }
        const create = await fetch(`/api/grn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ poId: po.id, items, receivedBy: "Bulk Convert", notes: `Auto-created from /m bulk Convert (${po.poNo ?? ""})`, qcStatus: "PENDING" }),
        });
        const cb = (await create.json().catch(() => ({}))) as { success?: boolean; data?: { id?: string } };
        if (!create.ok || !cb.success || !cb.data?.id) { failed++; continue; }
        const post = await fetch(`/api/grn/${cb.data.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "POSTED" }),
        });
        if (post.ok) ok++; else failed++;
      } catch { failed++; }
    }
    setBulkBusy(false);
    // Broadcast so THIS list, the desktop GRN/PO pages and any other open tab
    // refetch — without this the new GRNs were invisible until cache TTL
    // (2026-07-04 cache sweep).
    invalidateCachePrefix("/api/grn");
    invalidateCachePrefix("/api/purchase-orders");
    setScanToast(`Converted ${ok} PO${ok === 1 ? "" : "s"} to GRN${failed > 0 ? ` · ${failed} failed` : ""}`);
    window.setTimeout(() => setScanToast(null), 3000);
    exitSelectMode();
  }
  /** Sequential per-doc PUT — matches desktop's "avoid deadlock" pattern in
   * delivery bulk-dispatch (src/pages/delivery/index.tsx:2851). One at a
   * time, count successes, toast the result. */
  async function runBulkMark() {
    if (!bulkCfg || selectedIds.size === 0) return;
    setBulkBusy(true);
    const ids = Array.from(selectedIds);
    let ok = 0;
    let failed = 0;
    const touchedPrefixes = new Set<string>();
    for (const id of ids) {
      try {
        const url = bulkCfg.endpoint(id);
        // e.g. "/api/grn/<id>" → "/api/grn" — whatever module this list is.
        touchedPrefixes.add(url.replace(/\/[^/]*$/, ""));
        const res = await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: bulkCfg.status }),
        });
        if (res.ok) ok++;
        else failed++;
      } catch {
        failed++;
      }
    }
    setBulkBusy(false);
    // Broadcast so this list + desktop pages refetch (2026-07-04 cache sweep).
    for (const p of touchedPrefixes) invalidateCachePrefix(p);
    setScanToast(
      `${bulkCfg.label}: ${ok} done${failed > 0 ? ` · ${failed} failed` : ""}`,
    );
    window.setTimeout(() => setScanToast(null), 2400);
    exitSelectMode();
  }
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

  // ---- Cross-source search (owner 2026-07-11) -----------------------------
  // Delivery sets crossSourceSearch so ONE query finds an order whether it's
  // still a Sales Order (Planning / Pending Delivery) or already a Delivery
  // Order. The companion SourceSubscriber(s) below fetch the OTHER cross-search
  // source(s); their rows land here, and when the active tab belongs to a
  // cross-search source, a query merges matches from every cross-search source.
  const crossSources = useMemo(
    () => (config.crossSourceSearch ? config.sources.filter((s) => s.crossSearch) : []),
    [config],
  );
  const [crossRowsByUrl, setCrossRowsByUrl] = useState<Record<string, RawRow[]>>({});
  const handleCrossRows = useCallback((url: string, rowsForUrl: RawRow[]) => {
    setCrossRowsByUrl((prev) => (prev[url] === rowsForUrl ? prev : { ...prev, [url]: rowsForUrl }));
  }, []);
  const crossActive =
    !!config.crossSourceSearch && !!source.crossSearch && debouncedSearch.trim().length > 0;
  const crossResults = useMemo<{ row: RawRow; src: DataSource }[] | null>(() => {
    if (!crossActive) return null;
    const out: { row: RawRow; src: DataSource }[] = [];
    for (const s of crossSources) {
      const sr = s.url === source.url ? sourceRows : crossRowsByUrl[s.url] ?? [];
      for (const r of applyFilters(sr, s.columns, {}, debouncedSearch)) {
        out.push({ row: r, src: s });
      }
    }
    return out;
  }, [crossActive, crossSources, source.url, sourceRows, crossRowsByUrl, debouncedSearch]);

  const rows = useMemo(() => {
    // When there's a search query, look across EVERY sub-tab of this source so
    // a record is findable no matter which status tab it currently sits in
    // (owner 2026-07-04: a Loaded DO couldn't be found from the Delivered tab).
    // An empty search respects the active tab as before.
    const searching = debouncedSearch.trim().length > 0;
    const base = searching ? sourceRows : sourceRows.filter((r) => tab.match(r));
    const filtered = applyFilters(base, source.columns, filters, debouncedSearch);
    return applySort(filtered, source.columns, sort);
  }, [sourceRows, source, tab, filters, debouncedSearch, sort]);

  // The list actually painted: cross-source merged {row, src} pairs when a
  // cross-source search is active, else the single active source's rows tagged
  // with that source. Downstream (pagination, render) is source-agnostic — each
  // card uses its OWN source's view-model + detail route.
  const results = useMemo<{ row: RawRow; src: DataSource }[]>(
    () =>
      crossActive && crossResults
        ? crossResults
        : rows.map((r) => ({ row: r, src: source })),
    [crossActive, crossResults, rows, source],
  );

  // Auto-jump to the sub-tab a search lands in (desktop parity, owner
  // 2026-07-04: "bold the term + jump to that page"). If every matching row of
  // this source lives under exactly ONE sub-tab, switch to it so the tab bar
  // shows where the result is; clearing the search then leaves the operator on
  // that tab. Uses the render-time setState pattern (like the visibleCount
  // reset below) — NOT setState-in-effect — and tracks the last applied target
  // so it jumps only when the target changes, never fighting a manual tap.
  const searchJumpKey = useMemo(() => {
    // A cross-source search spans sources/tabs by design — never auto-jump then.
    if (crossActive || debouncedSearch.trim().length === 0) return null;
    const hit = source.subTabs.filter((t) => rows.some((r) => t.match(r)));
    return hit.length === 1 ? hit[0].key : null;
  }, [crossActive, debouncedSearch, source, rows]);
  const [lastJumpKey, setLastJumpKey] = useState<string | null>(null);
  if (searchJumpKey !== lastJumpKey) {
    setLastJumpKey(searchJumpKey);
    if (searchJumpKey && searchJumpKey !== activeTab) setActiveTab(searchJumpKey);
  }

  // How many rows are painted. Reset to the first page whenever the visible set
  // changes (tab / source / filters / search / sort) so "Show more" never
  // strands the list mid-scroll on a different dataset. Render-time state reset
  // (the codebase's endorsed alternative to setState-in-effect).
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const resetKey = `${source.url}|${activeTab}|${debouncedSearch}|${JSON.stringify(
    filters,
  )}|${sort ? sort.key + sort.dir : ""}`;
  const [lastResetKey, setLastResetKey] = useState(resetKey);
  if (resetKey !== lastResetKey) {
    setLastResetKey(resetKey);
    setVisibleCount(PAGE_SIZE);
  }

  const visibleResults = results.slice(0, visibleCount);
  const hiddenCount = results.length - visibleResults.length;

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
      {/* Cross-source search companions — fetch the OTHER order source(s) so a
          query can merge matches across the Sales-Order ↔ Delivery-Order
          boundary. Render null; delivery only. */}
      {crossSources.map((s) => (
        <SourceSubscriber key={s.url} source={s} onRows={handleCrossRows} />
      ))}

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
          #E2DDD8) + a square sliders button that dots when filters are active.
          gap 7px + 40px buttons so the row fits in 380px even on Sales (which
          has the most buttons: Search + ScanQR + ScanPO + Filter + Select). */}
      <div style={{ display: "flex", gap: 7, padding: "12px 18px 6px", minWidth: 0 }}>
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
        {/* Scan QR — dc12 design v12: button next to the filter, opens a
            full-screen camera scanner. Decoded /m/<slug>/<id> URLs auto-
            navigate; anything else shows a toast so the operator can act. */}
        <button
          onClick={() => setScanOpen(true)}
          aria-label="Scan QR code"
          style={{
            width: 40,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: M.card,
            border: `1px solid ${M.hairline}`,
            borderRadius: 12,
            color: M.ink,
            cursor: "pointer",
            flexShrink: 0,
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <ScanLine size={19} strokeWidth={1.75} />
        </button>
        {/* Scan PO (sales only) — OCR a customer PO photo / PDF into a
            prefilled new-SO form. dc12 design v12. */}
        {canScanPO ? (
          <button
            onClick={() => setScanPOOpen(true)}
            aria-label="Scan customer PO"
            style={{
              width: 40,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: M.taupe,
              border: `1px solid ${M.taupe}`,
              borderRadius: 12,
              color: "#fff",
              cursor: "pointer",
              flexShrink: 0,
              WebkitTapHighlightColor: "transparent",
            }}
          >
            <FileSearch size={19} strokeWidth={1.75} />
          </button>
        ) : null}
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
        {/* Select-mode toggle — dc13 v13 SELECT ACTION BAR */}
        <button
          onClick={() => {
            if (selectMode) {
              exitSelectMode();
            } else {
              setSelectMode(true);
            }
          }}
          aria-label={selectMode ? "Exit select mode" : "Select multiple"}
          style={{
            width: 40,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: selectMode ? M.taupe : M.card,
            border: `1px solid ${selectMode ? M.taupe : M.hairline}`,
            borderRadius: 12,
            color: selectMode ? "#fff" : M.ink,
            cursor: "pointer",
            flexShrink: 0,
            WebkitTapHighlightColor: "transparent",
          }}
        >
          <ListChecks size={19} strokeWidth={1.75} />
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
        {loading && results.length === 0 ? (
          <Msg text="Loading…" />
        ) : results.length === 0 ? (
          <Msg
            text={
              error
                ? "Couldn’t load — pull to refresh or use the desktop app."
                : "No records match."
            }
          />
        ) : (
          visibleResults.map(({ row, src }) => {
            const vm = src.toVM(row);
            const dest = config.detailPath?.(vm, row) ?? null;
            const isSelected = selectedIds.has(vm.id);
            return (
              <div
                key={`${src.url}|${vm.id}`}
                style={{
                  position: "relative",
                  outline: selectMode && isSelected ? `2px solid ${M.taupe}` : "none",
                  outlineOffset: -1,
                  borderRadius: 15,
                }}
              >
                <DocCard
                  code={vm.code}
                  title={vm.title}
                  items={vm.items}
                  subLine={vm.subLine}
                  highlight={debouncedSearch}
                  meta={vm.metas ?? [vm.meta1, vm.meta2]}
                  pill={
                    vm.status ? (
                      <StatusPill
                        style={vm.status.style}
                        label={vm.status.label}
                        size="sm"
                      />
                    ) : undefined
                  }
                  onClick={
                    selectMode
                      ? () => toggleSelect(vm.id)
                      : dest
                        ? () => navigate(dest)
                        : undefined
                  }
                />
                {selectMode ? (
                  <span
                    style={{
                      position: "absolute",
                      top: 10,
                      right: 10,
                      width: 22,
                      height: 22,
                      borderRadius: 6,
                      background: isSelected ? M.taupe : "#fff",
                      border: `2px solid ${isSelected ? M.taupe : M.hairline}`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      pointerEvents: "none",
                    }}
                  >
                    {isSelected ? <Check size={14} color="#fff" strokeWidth={3} /> : null}
                  </span>
                ) : null}
              </div>
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

      {/* QR scanner overlay (dc12 design v12). On a decoded `${origin}/m/...`
          URL, parse the path and navigate inside the app; anything else (a
          plain code, or a URL on a different origin) shows a toast so the
          operator can see what scanned and act manually. */}
      <ScanSheet
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        onResult={(value) => {
          setScanOpen(false);
          // Same-origin /m/* deep-link → in-app navigate.
          try {
            const url = new URL(
              value,
              typeof window !== "undefined" ? window.location.origin : "",
            );
            const sameOrigin =
              typeof window === "undefined" ||
              url.origin === window.location.origin;
            if (sameOrigin && url.pathname.startsWith("/m/")) {
              navigate(url.pathname + url.search);
              return;
            }
            if (sameOrigin && url.pathname.startsWith("/")) {
              // Desktop deep-link (e.g. a non-/m route printed on a sticker
              // from desktop) — go anyway; the redirect layer bounces phones
              // back to /m if applicable.
              navigate(url.pathname + url.search);
              return;
            }
          } catch {
            // not a URL — fall through to toast
          }
          setScanToast(value.length > 60 ? `${value.slice(0, 60)}…` : value);
          // eslint-disable-next-line no-restricted-syntax -- one-shot toast clear outside any React effect; useTimeout would over-engineer this
          window.setTimeout(() => setScanToast(null), 2500);
        }}
      />
      {/* OCR — capture a customer PO; on a tapped result, open the new-SO
          form prefilled with the extracted values. Sales module only. */}
      {canScanPO ? (
        <ScanPOSheet
          open={scanPOOpen}
          onClose={() => setScanPOOpen(false)}
          onResult={(extracted, sampleId) => {
            setScanPOOpen(false);
            const prefill: SOCreatePrefill = {
              customerId: extracted.customerId ?? "",
              customerPOId: extracted.customerPO ?? "",
              customerSOId: extracted.customerSO ?? extracted.yourRefNo ?? "",
              customerDeliveryDate: (extracted.deliveryDate ?? "").slice(0, 10),
              hookkaExpectedDD: (extracted.deliveryDate ?? "").slice(0, 10),
              items: extracted.items,
              // OCR accuracy: report the FINAL imported values on submit.
              scanSampleId: sampleId,
              scanRaw: extracted as unknown as Record<string, unknown>,
            };
            setCreateSpec(newSalesOrderSpec(prefill));
          }}
        />
      ) : null}
      {/* Bulk action bar — dc13 v13 SELECT ACTION BAR. Shows when in
          select-mode with 1+ rows ticked. Sits above the bottom tab bar.
          Actions toast for now — real bulk endpoints don't exist on the
          backend yet (bulk-delete / bulk-export / bulk-mark would need
          new routes). Cancel exits select-mode and clears the selection. */}
      {selectMode && selectedIds.size > 0 ? (
        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: "calc(72px + env(safe-area-inset-bottom))",
            zIndex: 40,
            background: M.raisin,
            color: "#fff",
            padding: "12px 14px calc(12px + env(safe-area-inset-bottom))",
            display: "flex",
            alignItems: "center",
            gap: 10,
            boxShadow: "0 -8px 28px rgba(0,0,0,.25)",
          }}
        >
          <button
            onClick={exitSelectMode}
            aria-label="Cancel selection"
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              background: "rgba(255,255,255,.12)",
              border: "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              flex: "none",
            }}
          >
            <X size={18} color="#fff" />
          </button>
          <span style={{ flex: 1, fontSize: 14, fontWeight: 700, color: "#fff" }}>
            {selectedIds.size} selected
          </span>
          <button
            onClick={() => {
              setScanToast(
                `Export ${selectedIds.size} item${selectedIds.size === 1 ? "" : "s"} — bulk endpoint pending`,
              );
              window.setTimeout(() => setScanToast(null), 2200);
            }}
            style={{
              height: 38,
              padding: "0 14px",
              borderRadius: 10,
              background: "#fff",
              color: M.raisin,
              border: "none",
              fontFamily: "inherit",
              fontSize: 12.5,
              fontWeight: 700,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Download size={14} strokeWidth={2} />
            Export
          </button>
          {/* Procurement-only Convert to GRN — mirrors desktop bulk Convert
              (src/pages/procurement/index.tsx:1186). One GRN per selected PO. */}
          {config.slug === "procurement" ? (
            <button
              onClick={() => { if (!bulkBusy) void runBulkConvertToGrn(); }}
              disabled={bulkBusy}
              style={{
                height: 38, padding: "0 14px", borderRadius: 10,
                background: "#3E6570", color: "#fff", border: "none",
                fontFamily: "inherit", fontSize: 12.5, fontWeight: 700,
                cursor: bulkBusy ? "wait" : "pointer",
                opacity: bulkBusy ? 0.7 : 1,
                display: "flex", alignItems: "center", gap: 6,
              }}
            >
              <PackageCheck size={14} strokeWidth={2} />
              {bulkBusy ? "…" : "→ GRN"}
            </button>
          ) : null}
          <button
            onClick={() => {
              if (bulkCfg && !bulkBusy) {
                void runBulkMark();
              } else if (!bulkCfg) {
                setScanToast(
                  `Mark not wired for ${config.title} yet`,
                );
                window.setTimeout(() => setScanToast(null), 2200);
              }
            }}
            disabled={bulkBusy}
            style={{
              height: 38,
              padding: "0 14px",
              borderRadius: 10,
              background: M.taupe,
              color: "#fff",
              border: "none",
              fontFamily: "inherit",
              fontSize: 12.5,
              fontWeight: 700,
              cursor: bulkBusy ? "wait" : "pointer",
              opacity: bulkBusy ? 0.7 : 1,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <Check size={14} strokeWidth={2} />
            {bulkBusy ? "…" : (bulkCfg?.label?.replace("Mark ", "") || "Mark")}
          </button>
        </div>
      ) : null}

      {scanToast ? (
        <div
          style={{
            position: "fixed",
            left: 18,
            right: 18,
            bottom: "calc(80px + env(safe-area-inset-bottom))",
            zIndex: 90,
            background: M.raisin,
            color: "#fff",
            borderRadius: 13,
            padding: "12px 16px",
            fontSize: 13,
            fontWeight: 600,
            boxShadow: "0 12px 30px rgba(31,29,27,.35)",
          }}
        >
          Scanned: {scanToast}
        </div>
      ) : null}
    </>
  );
}

// Invisible companion fetcher — subscribes to ONE cross-search source's endpoint
// (via the shared SWR cache, so it dedupes with the active-source fetch) and
// lifts its selected rows to the parent. Rendered once per cross-search source
// only for a crossSourceSearch module (delivery); a no-op elsewhere. The effect
// fires only when the fetched rows actually change (source.select is memoised on
// the cached data), so there's no render loop.
function SourceSubscriber({
  source,
  onRows,
}: {
  source: DataSource;
  onRows: (url: string, rows: RawRow[]) => void;
}) {
  const { data } = useCachedJson<unknown>(source.url);
  const rows = useMemo(() => (data ? source.select(data) : []), [data, source]);
  useEffect(() => {
    onRows(source.url, rows);
  }, [source, rows, onRows]);
  return null;
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
