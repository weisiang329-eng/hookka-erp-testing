# Dashboard & Command Center — Module Guide

> Self-navigating docs (L2). Repo-wide map: [[CODEBASE-MAP]]. Never grep the whole repo — use the file:line below.

## What it does
The homepage **Command Center** at `/dashboard`: a KPI rail (Sales · Invoices · Pending Delivery · Outstanding) plus every operational widget — Daily Report exceptions, Revenue chart, Plant Load, Order Pipeline, Worker efficiency, Revenue by Customer, Top sellers, Fabric usage, Department backlog and Purchasing. The whole page is one file (`dashboard-b/index.tsx`); nearly all of its data is one server-aggregated GET (`dashboard-overview.ts`) that is snapshot-backed and 60s KV-cached. Naming trap: the folder is `dashboard-b` and the API is `dashboard-overview`, but this IS the production dashboard — the legacy `/dashboard` page was retired 2026-05-21. Month-awareness is snapshot-driven: point-in-time widgets (backlog, active jobs, headcount) serve a stored daily snapshot for a past month, else a live value tagged "live (no history)".

## Entry points
- Pages
  - `/dashboard` → `src/pages/dashboard-b/index.tsx:683` (`DashboardBPage` — the entire Command Center)
  - `/dashboard-b` → redirects to `/dashboard` (`src/dashboard-routes.tsx:214`)
  - Lazy recharts wrappers → `src/pages/dashboard-b/charts.tsx` (`RevenueChart:60`, `CustomerPieChart:149`)
  - Route + prefetch wiring → `src/dashboard-routes.tsx:213` (entry), `:525` (chunk prefetch loader)
- API routes
  - Overview aggregate (single GET) → `src/api/routes/dashboard-overview.ts` (2043 lines), mounted at `/api/dashboard/overview` (`src/api/worker.ts:1195`)
  - Read-through snapshot lib → `src/api/lib/dashboard-snapshot.ts` (237)
  - Daily point-in-time state snapshot lib → `src/api/lib/dashboard-state-snapshot.ts` (148)
  - Nightly cron invalidation → `app.post("/api/internal/rebuild-dashboard-snapshot")` `src/api/worker.ts:385`

## Data model
- `dashboard_snapshot` — one row per `org_id`; the `built_from` column makes it data-change-aware (freshness Layer 1). `readSnapshot`/`writeSnapshot`, `ON CONFLICT (org_id)` upsert.
- `dashboard_state_snapshot` — daily point-in-time counts (backlog / active jobs / workforce); PK `(org_id, snap_date)`, idempotent UPSERT. Powers past-month history for state widgets.
- `kv_config` — the 60s KV cache layer (`cached(...)`, key `dashboard:overview:<org>:v22:<period>`).
- Read-only source tables (no writes from this module): `sales_orders` / `sales_order_items`, `invoices`, `delivery_orders` / `delivery_order_items`, `consignment_order_items`, `production_orders` / `job_cards`, `cost_ledger`, `purchase_orders` / `purchase_order_items` / `grns`, `products` / `raw_materials` / `workers`.
- The overview endpoint is READ-ONLY over business data — it only writes the two snapshot/cache tables.

## Core flows
1. **Overview read (three-layer freshness)** — `app.get("/")` `dashboard-overview.ts:49`. For `period=all`: (1) `readSnapshot` + `getMaxSourceUpdatedAt` in parallel (`:128`); if `isSnapshotFresh` (`:132`) serve the stored row. Else (2) 60s KV `cached(...)` (`:140`); else (3) the full ~27-query compute. Fresh compute is written back via `writeSnapshot` (`:2020`).
2. **Daily state capture** — `captureTodayState` (`:78`) extracts backlog/activeJobs/headcount from the live payload and fire-and-forgets `writeStateSnapshot` via `waitUntil`. Called on a snapshot hit (`:135`) and after any live (non-past-month) compute (`:2036`). Guarded so a past-month payload is never written back as "today".
3. **Past-month reconstruction** — when `isPastMonth` (`:70`), the handler reads the stored state snapshot via `readStateSnapshotForMonth` (`:1738`) and overrides the live state widgets with that month's captured values (falling back to a reconstructed backlog `:1877` when no snapshot exists).
4. **Frontend staged fetch** — `DashboardBPage` fires three parallel loads (`ovL`/`soL`/`pendingL`, see comment `:779`): overview drives the KPI rail + most sections, sales-orders/stats drives the Order Pipeline + Outstanding, and 4 heavy live fetches drive Pending Delivery. Each section shows `SectionRowsSkeleton` until its own fetch lands. The overview fetch URL is `dashboard-overview.ts`-backed `index.tsx:713`.
5. **Nightly rebuild** — cron (`.github/workflows/rebuild-dashboard-snapshot.yml`, 02:00 SGT) POSTs `/api/internal/rebuild-dashboard-snapshot` (`worker.ts:385`, CRON_SECRET-gated) which DELETEs every `dashboard_snapshot` row so the next read recomputes — belt-and-braces vs silent drift.

## Key functions / sections (locate-to-function)
| Symbol / section | file:line | Role |
|---|---|---|
| `DashboardBPage` | `src/pages/dashboard-b/index.tsx:683` | Main component: staged fetches, useMemos, all JSX |
| `KTile` | `src/pages/dashboard-b/index.tsx:418` | The KPI card used by the four Command Center cards |
| `Spark` / `DeltaChip` | `src/pages/dashboard-b/index.tsx:373 / 400` | Sparkline + delta-% chip |
| `SectionRowsSkeleton` | `src/pages/dashboard-b/index.tsx:500` | Per-section loading placeholder |
| `Gauge` / `MiniTable` / `SectionTitle` | `src/pages/dashboard-b/index.tsx:629 / 557 / 604` | Presentational helpers |
| KPI rail JSX | `src/pages/dashboard-b/index.tsx:1117` | Sales · Invoices · Pending Delivery · Outstanding cards |
| Revenue chart + Plant Load JSX | `src/pages/dashboard-b/index.tsx:1374` | Area chart + backlog-vs-capacity gauge |
| Order Pipeline + Worker efficiency JSX | `src/pages/dashboard-b/index.tsx:1609` | |
| Revenue by Customer JSX | `src/pages/dashboard-b/index.tsx:1749` | Concentration exhibit (donut + category modes) |
| Top sellers / Fabric usage / Backlog+Purchasing JSX | `src/pages/dashboard-b/index.tsx:2062 / 2059 / 2427` | |
| `RevenueChart` / `CustomerPieChart` | `src/pages/dashboard-b/charts.tsx:60 / 149` | Lazy recharts wrappers (~357 KB chunk) |
| `app.get("/")` (overview) | `src/api/routes/dashboard-overview.ts:49` | Single ~2000-line aggregate handler |
| `captureTodayState` | `src/api/routes/dashboard-overview.ts:78` | Extract + upsert today's state snapshot |
| `readSnapshot` / `writeSnapshot` / `isSnapshotFresh` | `src/api/lib/dashboard-snapshot.ts:94 / 195 / 177` | Read-through snapshot (Layer 1) |
| `getMaxSourceUpdatedAt` | `src/api/lib/dashboard-snapshot.ts:145` | Data-change probe for freshness |
| `writeStateSnapshot` / `readStateSnapshotForMonth` | `src/api/lib/dashboard-state-snapshot.ts:63 / 108` | Daily state UPSERT + past-month read |
| rebuild cron endpoint | `src/api/worker.ts:385` | Nightly force-invalidate all snapshots |

## Gotchas
- **`dashboard-b` IS the production dashboard.** The old `/dashboard` page was retired 2026-05-21; `/dashboard` lazy-loads `dashboard-b`, and `/dashboard-b` just redirects (`dashboard-routes.tsx:214`). There is no separate `dashboard` page.
- **The whole backend is ONE GET `/` handler** (~2000 lines, no sub-routes) — every dashboard number flows through it. It is **60s KV-cached on top of a data-change-aware snapshot**, so edits can take up to a minute to reflect live (bump the `v22` cache key or hit the rebuild cron to force a refresh).
- **Three-layer freshness, not just a cache.** Layer 1 = `dashboard_snapshot` (`built_from` vs `getMaxSourceUpdatedAt`); Layer 2 = 60s KV; Layer 3 = full compute. An admin script that UPDATEs a source table WITHOUT bumping its `updated_at` escapes Layer 1/2 — the nightly `rebuild-dashboard-snapshot` cron is the safety net. The snapshot path only runs for `period=all`; any month filter skips straight to KV + compute.
- **Never write a past-month state snapshot back as "today".** `captureTodayState` is guarded (`:135`, `:2036`) so only a live (`period=all`/current-month) payload is persisted; past-month reads override state widgets from stored history (`:1737`) and must not be re-captured.
- **KPI semantics are owner-pinned** (2026-06-12): Sales = confirmed-SO value; Invoices = Σ invoice totals by invoice date (excl. cancelled); Pending Delivery = consolidated made-but-not-shipped; Outstanding = point-in-time/live. Don't redefine these card sources.
- **Sales/Delivery value figures are intentionally NOT recomputed live** — they come from the snapshot/cache (see header comment top of `dashboard-overview.ts`). The page cross-checks the live `/api/sales-orders/stats` endpoint for the Order Pipeline, so those two can momentarily diverge by design.
- **Frontend fetches are staged** (`ovL`/`soL`/`pendingL`, `index.tsx:779`) so KPI numbers paint before heavy sections — don't collapse them into one fetch.
- **recharts is lazy-loaded** via `./charts.tsx` (~357 KB). Keep chart code there, not in `index.tsx`, or you regress first-paint.
- **Only snapshot freshness is test-covered** — `tests/snapshot-freshness.test.mjs` + `tests/snapshot-freshness-latestts.test.mjs`. The KPI math itself has no unit tests; verify live on prod.

## Common tasks (mini-playbook)
- **Add a KPI/widget** → compute it inside the single `app.get("/")` (`dashboard-overview.ts:49`) and add it to the returned payload; type it in the `Overview` type (`index.tsx:58`); render via `KTile`/`SectionTitle` in `DashboardBPage`. Bump the cache key `v22` if the payload shape changes, so stale snapshots don't serve the old shape.
- **Add a chart** → put the recharts component in `charts.tsx` and lazy-import it (keep recharts out of `index.tsx`); pass computed data + colors as props (parent owns the numbers).
- **Change a point-in-time (state) metric** → update the `DashboardStateMetrics` shape (`dashboard-state-snapshot.ts:37`), the `captureTodayState` extractor (`dashboard-overview.ts:78`), AND the past-month override (`:1737`) so history and live stay consistent.
- **Force a live refresh** → hit `POST /api/internal/rebuild-dashboard-snapshot` (`worker.ts:385`, CRON_SECRET) or bump the `v22` KV key; remember the 60s KV TTL.
- **Debug stale numbers** → check freshness order: `dashboard_snapshot.built_from` vs `getMaxSourceUpdatedAt` (`dashboard-snapshot.ts:145`), then the 60s KV key, then whether a source `updated_at` was bumped on the last write.

## Related modules
[[sales]] [[production]] [[delivery]] [[procurement]] [[accounting]] [[inventory]]
