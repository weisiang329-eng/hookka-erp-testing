# Durable read-performance architecture — decision + plan (2026-07-13)

> **Last verified: 2026-08-13** against `src/api/lib/keyset.ts`, `src/api/lib/snapshot.ts`,
> `src/api/lib/snapshot-freshness.ts`, `src/api/routes/delivery-orders.ts`,
> `src/api/routes/consignment-notes.ts`, `src/lib/delivery-pipeline.ts`,
> `src/pages/delivery/index.tsx`, `package.json`.
>
> Corrected 2026-08-13: **the rollout below is one-third done and Pillar 2 was never
> started** — the plan read as if all of it were in flight. Actual state:
>
> | Item | State (code-verified 2026-08-13) |
> |---|---|
> | Delivery deep-fix spec (bottom section) | ✅ **SHIPPED.** `GET /api/delivery-orders/ready-planning` (`delivery-orders.ts:635`) + shared `buildReadyPlanning()` (`src/lib/delivery-pipeline.ts:374`); FE reads it (`src/pages/delivery/index.tsx:1217`); CN twin at `consignment-notes.ts:235`; Command-Center `/pending-value` at `delivery-orders.ts:666`. |
> | P0 `keysetList()` helper | 🟡 partial. `src/api/lib/keyset.ts` exists with `tests/keyset.test.mjs`, but the export is not named `keysetList` and **exactly one route imports it** (`src/api/routes/production-orders.ts`). |
> | P0 `sqlAggregateByStatus()` | ❌ **does not exist** anywhere in `src/`. |
> | P0/Pillar 2 TanStack Query + `useInfiniteList` | ❌ **never adopted.** `package.json` has `@tanstack/react-table` and `@tanstack/react-virtual` but **no `@tanstack/react-query`**; `useInfiniteList` does not exist; `useCachedJson` is still imported by ~100 files. |
> | P1 Delivery list → keyset + SQL stats | ❌ not done — `/delivery-orders` list is still page/limit + snapshot. |
> | P2–P6 (Purchasing, Consignment, remaining lists, retire `useCachedJson`, cost-ledger) | ❌ not started. |
>
> So snapshots did **not** retire: `src/api/lib/snapshot.ts` + `snapshot-freshness.ts` +
> `kv-cache.ts` + `po-list-cache.ts` + `dashboard-snapshot.ts` remain the live
> read-performance mechanism, which is the opposite of this document's stated
> decision. Treat everything below the Delivery spec as an **unexecuted proposal**,
> not as architecture in place. The data-visibility invariants and the 11-point
> prevention checklist are still the standing rules and were not affected.

**Owner decision (2026-07-13):** stop the snapshot/cache-warming treadmill; adopt a durable
architecture so lists/dashboards stay fast as data grows for 1–2+ years. Both pillars approved.
Approach: build shared tooling first, pilot on **Delivery**, byte-identical verify, then roll out.

## Why warming is only a band-aid
- The whole-org recompute it defers **still grows with the data** (delivery list = 3.5s today at 265 DOs).
- Every new list/stat needs its **own** snapshot — unbounded maintenance.
- Cache **invalidation is a permanent bug source** (shape-version → 0-rows BUG-2026-06-23-002; 3-layer
  snapshot/KV/Hyperdrive drift BUG-2026-06-24-006; two competing client cache hooks).

## Prior art (how large systems do it) — researched 2026-07-13
- **Keyset/cursor pagination** (not offset): O(1) regardless of table size; offset degrades to O(n)
  (0.28ms→138ms at depth on 1M rows) and can skip/duplicate rows mid-traversal. Needs a composite
  index matching the sort. Standard for large list APIs. [stacksync, sequinstream, citusdata]
- **DB-side aggregation** for stats (SUM/COUNT/GROUP BY in Postgres → a few numbers back), never
  ship all rows to the Worker. Expensive cross-table dashboards → rollup tables (process net-new)
  or matviews; cheap aggregates inline. [citusdata rollup-vs-matview]
- **TanStack Query** for client server-state: query-key invalidation, dedup, staleTime, background
  refetch, localStorage persistence — makes cache-invalidation a library guarantee, not hand-rolled.
- **Hyperdrive**: Smart Placement (Worker near DB — sequential queries cost 20–30ms each far, 1–3ms
  near), it caches query results; avoid long transactions (block pool reuse). [cloudflare docs]

## Target architecture — two pillars + infra

### Pillar 1 — Server: never load the whole org
- **Keyset pagination** on every heavy list: `WHERE orgId=? AND (created_at,id) < (?,?) ORDER BY
  created_at DESC, id DESC LIMIT :n` + composite index `(orgId, created_at DESC, id DESC)`.
  List latency becomes a function of PAGE SIZE, not total rows.
- **Stats/tab totals via SQL** `SELECT status, COUNT(*), SUM(value_sen) ... GROUP BY status`
  (value expression must reproduce the current per-DO figure to the cent — same byte-identical gate).
- Snapshots retire for lists; keep only for genuinely expensive cross-table dashboards.
- ⚠ Constraint to verify FIRST: our SQL passes through the d1-compat SupabaseAdapter (camelCase→
  snake_case rewrite; only certain clause shapes handled; explicit projections pass verbatim).
  Keyset tuple comparison may need the **expanded** form `WHERE created_at < ? OR (created_at = ?
  AND id < ?)` rather than row-value `(a,b) < (?,?)`. Confirm before building the helper.

### Pillar 2 — Client: TanStack Query
- Introduce alongside `useCachedJson`; migrate page-by-page (both coexist); delete `useCachedJson`
  (+ its 3-layer drift) at the end. `useInfiniteQuery` pairs with keyset for the grids.
- Kills the shape-version / drift / competing-hooks bug class structurally.

### Infra
- Hyperdrive Smart Placement; reduce sequential per-request queries (batch/parallelize).

## Rollout plan (each phase = own branch, staging-first, byte-identical + scan-realtime gate)

- **P0 — foundation (low risk, no money path):** shared `keysetList()` + `sqlAggregateByStatus()`
  helpers in `src/api/lib/` + unit tests; adapter-compat spike for the keyset WHERE shape; add the
  composite indexes (runtime `CREATE INDEX IF NOT EXISTS`). Client: add TanStack Query provider +
  a `useInfiniteList` wrapper, unused until a page adopts it.
- **P1 — pilot: Delivery list.** Convert `GET /delivery-orders` to keyset + SQL stats; delivery page
  → `useInfiniteQuery`. Prove tab totals byte-identical to the cent (like B: 265 DOs, 0 diff) + scan realtime.
- **P2 — Purchasing list** (20MB → paged). **P3 — Consignment orders + notes** (money path).
  **P4 — remaining lists.** **P5 — retire `useCachedJson` + dead snapshots.** **P6 — cost-ledger.**

## Non-negotiables (unchanged)
Never touch the write/scan path. Money figures byte-identical, proven live on staging under owner
login before prod. New columns/indexes snake_case + runtime self-apply. UI stays English.

## Data-visibility invariants (the owner's #1 fear — validated by 8 past incidents)

**GOLDEN RULE:** search / filter / count / money-total ALWAYS run server-side over the WHOLE
dataset — never over the loaded page/window. A 500-row page bounds what we RENDER, never what the
user can FIND. A record may be "half-dead" (not on page 1, but found on search / openable by id);
it must NEVER be "fully dead" (unsearchable / un-openable).

Past incidents where a list/filter/cap made records unfindable or "dead" (do not regress):
BUG-2026-06-24-001 (completed order search rendered nothing), 05-29-008 (DO unfindable by SO no.),
05-16-004 ("0 of 66" sticky-filter blank), 06-23-002 / 06-23-001 (stale cache SHAPE → 0 rows),
06-12-002 / 06-04-002 (Ctrl+K returned newest-5 not the query), 05-26-003 / 06-05-005 (KPIs
computed on the 200-row page, not the dataset), 06-04-001 (500 body poisoned cache → all lists 0),
06-02-005 (sticker print capped at 10). Full catalogue: docs/BUG-HISTORY.md.

### Prevention checklist — every list conversion must pass ALL of these (each gets a regression test)
1. **Non-empty search term → server query over the whole table** (`?search=`), never a client `.filter`
   over the loaded window. queryKey includes the term. Identifiers stay searchable even when their
   column is hidden (`alwaysSearchKeys`). Test: seed a record beyond page 1, search its PO from page 1
   → returned + openable.
2. **Cap/page window is render-only** — search/filter/sort/select-all/aggregates operate on the FULL
   set; "Show all Y" footer count = full filtered length. (`defaultRowCap` contract preserved.)
3. **Payload SHAPE change → bump queryKey AND server snapshot key** (`v2→v3`). An ABSENT field means
   "not loaded → refetch", never an empty default (the `if(!ids) return null` vs `[]` rule).
4. **Keyset cursor ends in a unique tiebreaker** `(sortCol, id)` — no skipped/duped rows on ties.
   Test: ≥3 rows sharing a sort value across a page boundary → union == full set, no dupes/drops.
5. **KPI/stat cards read a server aggregate** with the SAME filter params (canonical buckets
   `src/lib/so-status.ts`); never iterate the paged result.
6. **Persisted filter/column state must not blank the grid** — keep `valueFilterKey` sub-scoping;
   don't apply `defaultExcludedValues` under an explicit external filter; keep `ensureColumns`.
7. **On write: invalidateQueries the list key + `forceShowKeys` keeps a just-edited row visible
   without remounting** (remount wipes selection).
8. **Error/empty never becomes cache data** — queryFn throws on non-2xx and `{success:false}`/`_stub`;
   keep `previousData` (last-known-good).
9. **Virtualizer clipped to `data.length`; `paddingBottom = data.length × ROW_HEIGHT`**; disable under
   `groupBy`. No stale rows / dead-space after a keyset append or filter narrow.
10. **One source of truth for cursor/search column camel↔snake naming**; CI guard fails if a searched/
    cursor column is missing from column-rename-map.
11. **Searchable denormalized columns ship a backfill**; server `?search=` also matches the source
    table (COALESCE), so old rows with blank denorm fields are still found.

Existing defenses to preserve verbatim in the rewrite: `alwaysSearchKeys`, `forceShowKeys`,
`defaultRowCap`+footer, `onSearchChange`→whole-dataset, `valueFilterKey`, `ensureColumns`,
`initialSearch`, server `?search=`+pg_trgm (migration 0150), snapshot key bumps, `?fresh=1` readback,
SWR degraded-200 guard, drafts read-back.

## Delivery deep-fix spec (server-side ready/planning) — 2026-07-13

**Goal:** eliminate the 1.2MB `/api/production-orders?fields=minimal&include=jobCards` the delivery
page pulls ONLY to compute readyPOs/planningPOs client-side.

**Feasibility: CLEAN / zero-divergence.** All decision logic is in the pure shared lib
`src/lib/delivery-pipeline.ts` (imports only `./repair-scope`; no React/DOM) + tested
(`tests/delivery-pipeline.test.mjs`): `poReadyForDelivery`, `pickRelevantUphCards`, `isHbOnlySpecial`,
`poInPlanning`. The API worker imports the SAME functions → identical results by construction.
`aggregateRacksFromPackingCards` is in `src/lib/rack-format.ts` (also pure). The delivery page uses
`poRaw` ONLY to build readyPOs/planningPOs (delivery/index.tsx ~1230–1502) — nothing else.

**New endpoint:** `GET /api/delivery-orders/ready-planning` → `{ ready: ReadyPORow[], planning: ReadyPORow[] }`.
Server steps (mirror delivery/index.tsx mapPO exactly):
1. Load minimal+jobCards PO list (reuse production list — export `fetchFilteredPOs` OR read the
   `production_orders_list_snapshot` `fields=minimal&include=jobCards` blob) + `attachCustomerSO`.
2. linkedPOIds = the `/linked-po-ids` SQL (delivery-orders.ts:1440).
3. Value map = `loadDoValueMap`/`loadPoValueMap` + `loadSoLinePriceIndex` fallback (poValMap ??
   soPriceByProduct[product]*qty). soMap/soRefMap from sales_orders (companySOId/customerSO/
   hookkaExpectedDD/customerId). productM3Map from products. All already loaded server-side elsewhere.
4. siblingsBySo tally (SOFA set completeness) + mapPO → ReadyPORow (the exact 30-field shape at
   delivery/index.tsx:1406–1476).
5. `planning = allPOs.filter(poInPlanning).map(mapPO)`; `ready = allPOs.filter(po =>
   poReadyForDelivery(po, linkedPOIds)).map(mapPO)`.
Snapshot-cacheable later (sourceTables production_orders + job_cards + delivery_order_items).

**FE change (after byte-identical proof):** drop the `poRaw` fetch + the ~270-line client pipeline;
fetch `/ready-planning`; set planningPOs/readyPOs from the response. Mobile Home's Pending-Delivery
card can reuse the same endpoint (it runs the same readiness calc).

**Gate:** additive first (new endpoint, no FE change) → on staging compare server ready/planning vs
the current client-computed rows (same ids, same valueSen to the cent, Planning 179 / RM 136,340.35)
→ then swap the FE → owner byte-identical verify + scan real-time.
