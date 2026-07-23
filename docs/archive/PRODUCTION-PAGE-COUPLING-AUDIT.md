# Production Page Coupling Audit (F4)

> **Date**: 2026-05-11
> **File**: `src/pages/production/index.tsx` (5,812 lines)
> **Purpose**: Map every place where state-A updates trigger state-B (or state-B's effects), so the operator can see where "上面定一条规则，下面又定矛盾规则" patterns hide.
> **No code changes here** — this is a structural map only.

---

## 1. Hook landscape (one component)

| Hook kind | Count |
|---|---:|
| `useState` | 25 |
| `useRef` | 10 |
| `useUrlState` (URL-backed state) | 8 |
| `useCachedJson` (network) | 4 |
| `useEffect` | 16 |
| `useLayoutEffect` | 1 (added in F1) |
| `useMemo` | 17 |
| `useCallback` | 16 |
| **Total** | **~97** |

97 hooks in one component is well past the "split this up" threshold. Every state update potentially triggers cascading work in the other 96.

---

## 2. The 7 explicit "state-cascade" acknowledgments

Every place where the lint rule `react-hooks/set-state-in-effect` is disabled is a flag the author put down saying *"yes, I know this effect sets state — it's intentional"*. These are the documented coupling points.

| # | Line | What it does | Triggered by | Sets | Risk |
|---|---:|---|---|---|---|
| C1 | L434-442 | Sync `activeTab` to URL `deptCode` on route change | `mode`, `deptCode`, `activeTab` change | `setActiveTabRaw` | 🟡 Two writers to `activeTab` (URL sync + manual click) — fight if both fire same tick |
| C2 | L738-745 | One-shot URL seed: write `from=today&to=today` if both blank | mount (`[]` deps) | `setUrlBatch` → URL → `fltDueFrom/fltDueTo` | 🟡 F1 added a sync today-fallback that mostly subsumes this; the effect still fires for URL bookkeeping |
| C3 | L893-897 | Flip `shouldFetch=true` when any filter activates (lazy overview load) | `anyFilterActive`, `shouldFetch` | `setShouldFetch(true)` | 🟢 One-way ratchet, can't undo. Coupled to 6 filter values via `anyFilterActive` |
| C4 | L934-936 | Reset `gridFilteredDeptRows` on tab change | `activeTab` | `setGridFilteredDeptRows(null)` | 🟢 Defensive clear |
| C5 | L1070-1075 | Collapse panels (`showQRStrip`, `showFgPreview`) on tab change | `activeTab` | 2 setters | 🟢 Defensive cleanup |
| C6 | L3465-3488 | On-demand FG sticker fetch + tab-leave cleanup | tab/visible state | `setFgStickers`, `setLoadingFgPreview`, etc. | 🟠 The cleanup path interacts with manual print triggers (see C6.5 below) |
| C7 | L1192-1207, L1212-ish | "Sync external prop to state" inline-render pattern with `lastSeen*` ref guard | render-time, comparing `*Resp` to `lastSeen*Resp` | `setRackOptions`, `setWorkers` | 🟠 Setting state during render is supported but rare; if the dep object identity ever flickers (e.g. cache-invalidation tick), it re-fires |

**🔥 The pattern**: every one of these is a state-following-other-state path. Each one is justified in isolation, but together they form a graph the operator can't see — exactly the situation the user described as "互相覆盖".

---

## 3. Setters with multiple call sites (drift candidates)

If a state variable is set from multiple places, the places can drift apart over time. Highest-fanout setters in this file:

### `setOrders` — 6 call sites
- L1168: replace from network refetch
- L1173: splice optimistic JC patches over server snapshot
- L1246: optimistic JC patch (date change)
- L1302: optimistic JC patch (status change)
- L1331: optimistic JC patch (worker assignment)
- L5076: optimistic JC patch (rack assignment)

**Risk**: 5 of 6 are "splice my pending change into the latest server snapshot" — but each call site reconstructs the splice inline (different field names, different code paths). Fix to optimistic flow at one site won't propagate to the other 4 unless extracted into a helper.

**Proposed**: extract `spliceOptimisticPatch(prev, patch)` helper. One implementation, 5 call sites.

### `setOverviewFilters` — 9 call sites
- L875: Clear all filters (one-shot)
- L4846, L4863, L4881, L4897, L4916, L4933, L4954, L4961: per-column filter inputs (SO ID, Product, Customer, Special Order, Qty, Due Date, Dept Status, Dept Date)

**Risk**: each per-column input does a `setOverviewFilters((p) => ({ ...p, X: value }))`. Adding a new filter type means another inline updater. If the shape of `OverviewFilters` changes (e.g. add `priorityFlag`), all 9 sites need updating.

**Proposed**: extract `updateOverviewFilter(key, value)` callback. Single update path.

### `setActiveTab(Raw)` — 4 call sites
- L437, L439: URL-driven sync (C1 above)
- L449: manual click via `setActiveTab` wrapper (which also records `tabSwitchStart` for the slow-tab warning)
- L4561, L4573: tab buttons in the JSX

**Risk**: 2 of these go through the wrapped `setActiveTab` (which records timing); the other 2 (URL sync) bypass it via `setActiveTabRaw`. A route-driven tab change doesn't get the slow-tab telemetry that a click-driven one does. Drift potential.

**Proposed**: route the URL-sync writes through `setActiveTab` too, so all tab changes get the same telemetry.

### `setShouldFetch` — 3 call sites
- L403 init: `mode === "dept"` (auto-fetch on dept)
- L895: filter-activation effect (lazy overview)
- L4412: "Load all" button click

**Risk**: low — one-way ratchet, can only flip to `true`, never back. Defensive but redundant: dept mode init covers most cases, the other two are for overview mode.

---

## 4. `useMemo` deps cluster (computation cost amplifier)

The 3 heaviest `useMemo`s in this file and their deps:

| Memo | Line | Deps | Cost | Triggered by |
|---|---:|---|---|---|
| `filteredOrders` | 1397 | orders, haystackByPo, deferredFltSearch, deferredFltState, deferredFltCustomer, deferredFltDueFrom, deferredFltDueTo, fltDateAxis, deferredFltCategory, showCancelled, deferredIncompleteOnly, activeTab | O(N) over ~1.8k POs | Any filter change |
| `visibleOrders` | 1496 | filteredOrders, activeTab, deferredOverviewSort, deferredOverviewFilters | O(N×depts) | filteredOrders OR overview filter/sort change |
| `baseRows` | 1904 | filteredOrders, pickerIndex | O(N×8 depts × picker lookups) | filteredOrders OR pickerIndex change |

**F5 deferred 7 of the 12 `filteredOrders` deps**, so a filter click only enqueues the recompute on the deferred lane — but it still runs eventually. For an 1.8k-PO dataset that's ~50ms client compute per recompute. Click rapid-fire (e.g. typing in search) still piles work behind a stale deferred value.

**Future opportunity**: feed the 1.8k POs through a Web Worker (so the recompute is off-main-thread entirely, not just deprioritised). Half-day work, biggest possible win after F1+F5. (This is F7 from the earlier menu.)

---

## 5. URL state ↔ local state pairs (drift candidates)

`useUrlState` writes URL; another `useState` mirrors related data locally. Drift if the URL changes outside the page (back/forward, deep link, paste).

| URL key | Local mirror | Drift risk |
|---|---|---|
| `from`, `to` | `fltDueFrom/fltDueTo` (via useUrlState) + `effectiveDueFrom/effectiveDueTo` (F1 fallback) | 🟢 Single source after F1 |
| `q` (search) | `fltSearchInput` (debounced UI mirror) | 🟡 Two-state debounce — URL lags input by 300ms |
| `cat` | `fltCategory` | 🟢 Direct |
| `state` | `fltState` | 🟢 Direct |
| `customer` | `fltCustomer` | 🟢 Direct |
| `axis` | `fltDateAxis` | 🟢 Direct (unused — was supposed to drive dateAxis dropdown that got removed) |
| `showCancelled` | `showCancelled` | 🟢 Direct |
| ALL overview column filters | `overviewFilters` (localStorage-backed `useState`) | 🟠 Filters live in localStorage, not URL — shareable links lose them |

The `overviewFilters` localStorage gap is a real workflow drift — an operator can't share a "show only HOOKKA-INDUSTRIES + DUE before 5/15 + FAB_CUT pending" view by pasting the URL.

---

## 6. Render-time `setState` (anti-pattern in 2 spots)

Lines 1191-1207 and 1212-ish use a `lastSeen*Resp` ref pattern to derive `rackOptions` / `workers` state from `*Resp` props *during render*. This is officially supported in React 18+ but is rare in this codebase. If the response identity ever flickers (e.g. cache invalidation tick produces a new object with same content), the setter re-fires on every render.

**Risk**: low today, but if someone adds `revalidateOnFocus` to those `useCachedJson`s, focus events would produce new response objects → re-fire on every focus.

**Proposed**: convert to `useMemo` over `*Resp` content (extract the array once per response). Drop the `lastSeen*` refs.

---

## 7. Effect cycles (real or potential)

A cycle = effect A sets state → triggers effect B → triggers effect A. The file doesn't have a hard cycle today, but two near-misses:

### Near-cycle 1: `activeTab` ↔ URL
- L431-441 effect: when `deptCode` (URL) changes, set `activeTab` = `deptCode`
- L4561/4573: tab button clicks call `setActiveTab(code)` — but this does NOT write back to URL (the route is the source of truth, not the tab state)
- So no cycle today.

If anyone later adds a "tab click writes URL" effect, the cycle closes: tab click → setActiveTab → effect writes URL → URL change fires L431-441 → setActiveTab → infinite loop. The seed comment at L434 doesn't warn about this.

### Near-cycle 2: `shouldFetch` ↔ filters
- L893: `anyFilterActive` change triggers `setShouldFetch(true)`
- `shouldFetch` is read by `ordersUrl` build → useCachedJson fires → `ordersResp` updates → `orders` updates → no filter change → no loop.

If anyone later derives `anyFilterActive` from `orders` (e.g. "fetch was empty, so we filtered too narrowly"), the cycle closes.

---

## 8. Top "watch this if you touch X" warnings

If a future PR touches one of these areas, also check the linked sites:

| If you touch... | Also audit... | Why |
|---|---|---|
| `filteredOrders` filter logic | `visibleOrders`, `baseRows`, `ordersByGroup` | All three reuse the same filtered set |
| `useUrlState("from")` / `useUrlState("to")` defaults | F1 cold-start fallback (`isColdStartRef`), seed effect L738 | All three places must agree on "what `''` means" |
| Any `setOrders` call | Optimistic JC patch flow at L1246, L1302, L1331, L5076 | Each is a hand-written splice; rare patterns can leak |
| Overview filter shape (`OverviewFilters` type) | 9 per-column inputs (see §3) | All 9 inline `setOverviewFilters` updaters need keeping in sync |
| `activeTab` semantics | URL `deptCode`, `setActiveTabRaw` vs `setActiveTab`, slow-tab telemetry | Two writers + one wrapper |
| `baseRows` picker logic | The frontend wipKey-match comment block at L1936-1950 + the SQL outer-WHERE invariant in `production-orders.ts` (locked by `tests/production-orders-dept-narrow-guard.test.mjs`) | These two pieces must agree — `f5657f5` broke them 2026-05-11 morning |

---

## 9. Concrete refactor proposals (ranked by ROI)

Following the audit, here are the highest-leverage refactors. **None of these is urgent today**. Listed for the operator to choose if/when.

| # | Refactor | Effort | Reduces coupling at |
|---|---|---:|---|
| R1 | Extract `spliceOptimisticPatch(prev, patch)` helper | 1h | 5 `setOrders` call sites |
| R2 | Extract `updateOverviewFilter(key, value)` | 30min | 9 `setOverviewFilters` call sites |
| R3 | Route URL-driven `activeTab` writes through `setActiveTab` (not `setActiveTabRaw`) | 15min | Slow-tab telemetry parity |
| R4 | Move `overviewFilters` from localStorage to `useUrlState` | 2-3h | Shareable URL parity (workflow gap) |
| R5 | Move `baseRows` sched matrix to a Web Worker | 4-6h | Main thread fully unblocks (subsumes F5's deferred benefit by an order of magnitude) |
| R6 | Convert render-time `setState` at L1191/L1212 to `useMemo` | 30min | Clean up anti-pattern |
| R7 | Split this 5,812-line component into 4-5 sub-components per "Mode" (Detailed / Total Listing / Print Schedule / Master Tracker / FG Sticker preview) | 1-2 days | The big one — every other refactor gets easier after this |

---

## 10. The original "互相覆盖" concern — verdict

The user's intuition was specifically right about **the morning's SQL narrow being re-introduced despite a comment warning** (commit `f5657f5` ignored the warning at `production-orders.ts` L948-960). That class of bug is now **locked** by `tests/production-orders-dept-narrow-guard.test.mjs` (commit `f989192`).

For the rest of `production/index.tsx`: **there is no individual "ticking bomb" today** — every effect cascade is defensive and runs in a one-way direction. The risk is **structural**: 5,812 lines + 97 hooks in one component is a coupling surface that **future** changes will collide with even if today's code is internally consistent.

The single highest-leverage fix is **R7** (split the component). Everything else (R1-R6) is incremental cleanup that delivers small ROI but doesn't change the structural problem.
