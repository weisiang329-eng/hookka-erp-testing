# Audit — the routes nobody has swept

**Nothing in this document was measured on prod.** This branch has no
authenticated session (login gate; `.dev.vars` credentials are rotated dead), so
every claim here is derived from reading the code and from numbers already
recorded in this repo (`docs/PERF-BACKLOG.md`, `docs/HEALTH-REVIEW.md`,
`docs/BUG-HISTORY.md`). Where a number is quoted it is labelled with its source.
Where a number would need a probe, the probe is named. **No timing in this file
is invented.**

The 2026-08-13 session measured and cleared: dashboard, sales, procurement,
delivery, invoices, inventory, production, planning (+ mrp + dept/\*), customers,
service-cases, employees, accounting, finance-dashboard, bom,
inventory/stock-value, leads, maintenance/sofa-combos, procurement/pi, and the
four mobile screens. This audit covers **everything else in
`src/dashboard-routes.tsx`**, enumerated from the file rather than from a list.

---

## Ranked suspects

Ranked by **pain × how many people actually hit it**, not by how large the
number is. Each row is one probe away from confirmation.

| # | Route / surface | Shape | Who pays |
|---|---|---|---|
| 1 | app-wide (sidebar) | whole notifications feed re-fetched **every 60 s**, unbounded, raw fetch | every user, every page, always |
| 2 | `/reports` › Inventory | "Stock Valuation" has no quantity in it; "Avg Sell Price" column renders a size label | whoever runs it — and it exports to CSV |
| 3 | `/analytics/forecast` | `84.2%` is a literal; chart frozen at 2026-05; **page is unreachable** | nobody today — that is the finding |
| 4 | global search | 9 offered links render a blank page or the wrong record | every user (Ctrl-K is everywhere) |
| 5 | `/inventory/adjustments` | ~2.3 s whole-org WIP walk on mount + 1.16 MB duplicate; FG on-hand always 0; cost prefilled from the SELL price | few (see note — the table is empty in prod) |
| 6 | 5 call sites | 1.16 MB `/api/inventory` pulled for **one** of its three buckets | scattered |
| 7 | `/delivery-returns` create | full 1.07 MB DO list for one dropdown; fires on page load via `?createFrom=` | office, on the convert-a-DO path |
| 8 | `/purchase-returns` | failed read renders as an empty list, on a page that removes stock and issues Debit Notes | procurement |
| 9 | `/admin/health` | 16 concurrent requests on mount, 16 more per range change | SUPER_ADMIN only |
| 10 | `/mail-center`, `/announcements` | whole list downloaded to produce a count / to fill a dialog nobody opened | office |
| 11 | `/quality` FG picker | whole `fg_units` table, no `?status=` | QC inspector, narrow trigger |
| 12 | `/notifications` | unbounded query + un-windowed render | latent, not current |

---

### 1. The sidebar re-downloads the entire notifications feed every 60 seconds, on every page

`src/components/layout/sidebar.tsx:454-482`

```
const fetchUnreadCount = useCallback(async () => {
  const res = await fetch("/api/notifications");        // :457
  ...
  const count = notifications.filter((n) => n.isRead === false).length;
```
…called on mount (`:471-475`) and then from `useInterval(..., 60_000)` (`:479-482`).

* It is a **raw `fetch`**, so it bypasses `src/lib/cached-fetch.ts` entirely — no
  SWR cache, no in-flight dedupe with the two other consumers of the same URL.
* `src/api/routes/notifications.ts:93` is
  `SELECT * FROM notifications ${whereSql} ORDER BY created_at DESC` — **no
  LIMIT**. The endpoint accepts `?isRead=` (`:84-87`) and this caller does not
  pass it. The whole payload is downloaded to produce one integer.
* It is **duplicated**. `NotificationBell`
  (`src/components/layout/notification-bell.tsx:50-72`) fetches the same URL on
  mount and on every `window` focus and renders the same badge. Its own module
  header (`src/lib/notifications-feed.ts:12`) states *"No polling loop is needed
  for correctness"* — and the sidebar polls anyway.
* The two badges use **different unread rules**:
  `isUnread()` (`src/lib/notifications-feed.ts:44-47`) treats `true`, `1` and
  `"1"` as read; the sidebar tests `isRead === false` strictly. On a database
  that stores the flag as an integer these two counters disagree.

**Arithmetic:** 60 unbounded-payload requests per hour per open tab per user,
into the API tier that `docs/PERF-BACKLOG.md` identifies as the actual
bottleneck (12 parallel calls → 1,511–1,902 ms). This is almost certainly the
source of P7's *"`notifications` ×2–4 per navigation"*.

**Probe (one call):** `GET /api/notifications` — byte size + row count; then
`GET /api/notifications?isRead=false` for the same. If the payload is large this
is the highest-leverage fix in the unswept set, because the cost is paid
continuously rather than on a page open.

---

### 2. `/reports` › Inventory publishes a stock valuation with no quantity in it, and mislabels a column

`src/pages/reports.tsx:962-968`, `:975-984`, `:1003`, `:1020`, `:1036`, `:1046`

**2a — "Stock Valuation by Category" is a sum of price tags.**

```
products.forEach((p) => {
  ...
  // Estimate value as costPriceSen (each product is now a single SKU)
  categoryMap[p.category].totalValue += p.costPriceSen;      // :967
});
```

Each product contributes its **unit cost exactly once**, regardless of how many
units are on hand. It is rendered under the title *"Stock Valuation by
Category"* (`:1003`) with the column header *"Total Value"* (`:1020`) and
exported as `stock-valuation.csv` (`:1009`). A real stock-value screen exists
(`/inventory/stock-value`, swept and healthy) and this figure cannot agree with
it. Same family as BUG-2026-08-13-004 / -006 / -009: arithmetic that is not
wrong so much as **not the thing the caption claims**.

**2b — the "Avg Sell Price" column renders the size label.**

Headers (`:1046`): `["Code", "Name", "Category", "Sizes", "Cost Price", "Avg Sell Price"]`
Cells (`:976-983`): `[p.code, p.name, p.category, p.sizeCode, formatCurrency(p.costPriceSen), p.sizeLabel]`

Index 5 is `p.sizeLabel` under a header that says *Avg Sell Price*. It exports
to CSV under the same header (`:1036`).

**Not mechanically fixable.** `products` carries `costPriceSen`,
`basePriceSen`, `price1Sen` and `seatHeightPrices` — which of those is "avg sell
price", and where a per-product quantity should come from, are owner decisions.
Do not invent the mapping to make the table look complete (the standing rule
from BUG-2026-08-13-009).

---

### 3. `/analytics/forecast` — "Forecast Accuracy 84.2%" is a literal, and no link in the app reaches the page

`src/pages/analytics/forecast.tsx:140-152`, `:172-179`, `:183-199`

```
const withActual = forecasts.filter((f) => f.actualQty !== null);
if (withActual.length === 0) {
  const last3 = historicalSales.filter((s) => s.period >= "2026-02");
  return { accuracy: 84.2, count: last3.length };   // Mock accuracy   :145
}
```

Rendered as a `text-3xl` KPI captioned *"Based on historical comparison"*
(`:210-215`).

**`withActual` is empty by construction.** `actualQty` appears in exactly three
places in the tree: this file, `src/types/index.ts:1202`, and the POST body in
`src/api/routes/forecasts.ts:104`. **Nothing in the app POSTs to
`/api/forecasts`** — the forecast page is read-only. So no row can carry a
non-null `actualQty`, the branch is always taken, and the card **always** prints
`84.2%`. This needs no measurement; it follows from the code.

Two more frozen literals on the same tab:

* `const months = ["2026-05" … "2026-10"]` and `capacity: 220` (`:173-177`) —
  the "6-month forecast" bar chart and its capacity line are both hardcoded.
  Today is 2026-08; three of the six bars are already in the past.
* `forecasts.find((f) => … f.period === "2026-05")` (`:189`) — the
  "Next Forecast" column of the product table is pinned to a past month.

**Reachability.** `/analytics/forecast` appears **only** in
`src/dashboard-routes.tsx:181, 548, 577`. It is not in `sidebar.tsx`, not in
`global-search.tsx`, and no `navigate()` in the tree targets it.
`docs/HEALTH-REVIEW.md:159` recorded it once (2,161 nodes / 274 ms), so somebody
typed the URL. **The cheapest correct action is to delete the page and its
route**, as `/production/tracker.tsx` was deleted in #276 — not to source a real
accuracy number for a screen nobody opens. That is an owner call, not mine.

---

### 4. Global search offers nine links that render a blank page

`src/components/layout/global-search.tsx:154-156` and `:166-172`, against
`src/dashboard-routes.tsx` and `src/layouts/DashboardLayout.tsx:193`.

`<Routes>{DASHBOARD_ROUTE_ELEMENTS}</Routes>` has **no `path="*"` fallback
route**. An unmatched dashboard URL therefore renders the sidebar, topbar and
breadcrumbs with a completely **empty `<main>`** — no 404, no message. To a user
that is indistinguishable from a page that failed to load, which is item 4 of
the brief's pattern list ("failure rendered as emptiness") arriving through the
router instead of through a fetch.

| Offered link | Line | What happens |
|---|---|---|
| `/approvals` | :154 | no route → blank page |
| `/documents` | :155 | no route → blank page |
| `/portal` | :156 | no route → blank page |
| `/customers/new` | :170 | `/customers` has no `:id` route → blank page |
| `/products/new` | :171 | only `/products/:id/bom` \| `/documents` → blank page |
| `/production/new` | :172 | the `/production/:id` route was deleted 2026-04-26 → blank page |
| `/sales/new` | :166 | falls into `/sales/:id` → **Sales Detail for an order with id `"new"`** |
| `/delivery/new` | :167 | falls into `/delivery/:id` → wrong record |
| `/invoices/new` | :168 | falls into `/invoices/:id` → wrong record |
| `/procurement/new` | :169 | falls into `/procurement/:id` → wrong record |

Two separate small fixes: prune the static lists (the real paths are
`/sales/create`, `/procurement/create`, `/consignment/create`), and add a
catch-all route so an unknown dashboard URL says so instead of painting nothing.

---

### 5. `/inventory/adjustments` — a 2.3 s whole-org WIP walk on mount, plus two wrong numbers on screen

`src/pages/inventory/adjustments.tsx:184-191` fires **four** fetches on mount:

| Call | What the page uses | Cost |
|---|---|---|
| `/api/raw-materials` | RM dropdown | fine |
| `/api/inventory/wip` | WIP dropdown: `wipCode`, `wipType`, `relatedProduct`, `totalQty` | see below |
| `/api/inventory` | **only** `finishedProducts`, 6 of its ~22 fields | 1.16 MB (PERF-BACKLOG P6) |
| `/api/stock-adjustments` | history table | fine |

**The WIP call.** `src/api/routes/inventory-wip.ts:229-284` runs four queries in
parallel: every active PO, **all job cards of every active PO**, every
`COMPLETED`/`TRANSFERRED` PO, and **all job cards of those too**. Against the
counts in `docs/HEALTH-REVIEW.md` (`job_cards` 32,319 rows; the brief's
36,796 / 2,539) that is essentially the whole job-card table, walked to derive
`sources[] / completedBy / age / unit cost` per WIP row. **The Inventory page
deliberately defers this exact call off its mount** —
`src/pages/inventory/index.tsx:1474-1479` calls it *"a ~2.3s fetch"* and loads it
only when the WIP tab is opened. Adjustments fires it unconditionally, and the
four fields its dropdown reads are plain `wip_items` columns that need none of
that walk.

**The `/api/inventory` call.** `src/api/routes/inventory.ts:148-172` is
`SELECT * FROM products` + `SELECT * FROM wip_items` + `SELECT * FROM raw_materials`
in one envelope. This page already fetches raw materials and WIP from their own
endpoints in the same breath, so **two thirds of a 1.16 MB payload is fetched
twice and thrown away.**

Two correctness bugs on the same screen:

* **The FG "on hand" cell is always `0`.** `src/api/routes/inventory.ts:161-164`
  returns `stockQty: 0` unconditionally — its own comment says the real figure is
  derived elsewhere (`deriveFGStock`). `adjustments.tsx:200` maps it to
  `remainingQty`, `:291` returns it as the row's `qty`, `:533` renders it as the
  current quantity. An operator correcting finished-goods stock is shown
  **"0 unit"** as the current balance for every product.
* **The unit COST is prefilled from the SELL price.** `adjustments.tsx:201`
  reads `unitCostSen: p.basePriceSen ?? 0` — the product's base selling price.
  `costPriceSen` is on the same row and unused. That value is posted as
  `unitCostSen` (`:337`) into the stock and cost ledger.

**Pain weighting — low, deliberately.** The file's own comment (`:72-80`)
records that this screen shipped with a field-shape bug that made every
submission post an `undefined` quantity, and that **`stock_adjustments` has zero
rows in production**: *"the feature was unusable from the day it shipped."* So
nobody is being hurt today. The reason to fix it is that both wrong numbers are
waiting for the first person who starts using it — not the latency.

---

### 6. Class — five call sites download the 1.16 MB `/api/inventory` aggregate to use one of its three buckets

`/api/inventory` returns `{ finishedProducts, wipItems, rawMaterials }` in one
envelope (`src/api/routes/inventory.ts:148-172`), measured at **1.16 MB**
(PERF-BACKLOG P6). Dedicated endpoints already exist for two of the three
(`/api/raw-materials`, `/api/products`).

| Site | Bucket actually read | Note |
|---|---|---|
| `src/pages/component-kits/index.tsx:66` | `rawMaterials[].{itemCode,description}` | **raw `fetch`**, no SWR cache → re-paid in full on every mount of `/bom/component-kits` |
| `src/pages/rd/detail.tsx:360` | `rawMaterials` | `/rd/:id` |
| `src/pages/service-orders/index.tsx:387` | `finishedProducts.{id,code,name,stockQty}` | create dialog only |
| `src/pages/service-orders/detail.tsx:142` | `finishedProducts` | |
| `src/pages/inventory/adjustments.tsx:188` | `finishedProducts` | see #5 |

Same shape on already-swept surfaces, listed so a sweep does not miss them:
`src/pages/bom.tsx:6161`, `src/pages/m/screens/WarehouseScreen.tsx:144`,
`src/pages/m/screens/Home.tsx:344`, `src/pages/m/lib/preload.ts:42`.

**I cannot split the 1.16 MB across the three buckets without measuring.** One
probe does it: `GET /api/inventory` vs `GET /api/raw-materials` vs
`GET /api/products`, byte sizes side by side. If `rawMaterials` is a small
fraction, the three raw-material call sites are a near-free win; if
`finishedProducts` dominates, the fix is a `?fields=` projection instead.

---

### 7. `/delivery-returns` create dialog pulls the full 1.07 MB delivery-order list for one dropdown

`src/pages/delivery-returns/index.tsx:210-219`

Bare `/api/delivery-orders` takes the non-paginated branch
(`src/api/routes/delivery-orders.ts:141-185`): every DO, every line, plus the
value map, the product-m³ map, the hub-state map, the invoice map and the
repair-scope map. **1.07 MB** (PERF-BACKLOG P6). The dialog then filters to
`status === "DELIVERED" || "INVOICED"` **in the browser** (`:213-219`) and reads
seven scalar fields per row.

The endpoint already supports `?page=&limit=&search=` (`:128-130`, `:193-195`)
and `/delivery` uses them (`src/pages/delivery/index.tsx:1154`, `:1167`). There is
no status filter yet, so a scoped variant would be new work, not a parameter.

**Stated honestly, two things soften this:** the dialog is conditionally mounted
(`:135`), and this URL is the shared cache key that `/service-cases`, `/invoices`
and `/sales` already warm — so on a repeat visit SWR paints from localStorage
and the 1.07 MB is a background refetch. **Neither mitigation applies on the
`?createFrom=<doId>` entry** (`:55-60`), which is how the DO page's "Convert to
Delivery Return" button lands here: the modal mounts during page load and the
1.07 MB read is on the critical path.

---

### 8. `/purchase-returns` renders a failed read as an empty list — on a page that removes stock and issues Debit Notes

`src/pages/purchase-returns/index.tsx:39-46`

```
async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    const j = (await r.json()) as { success?: boolean; data?: T };
    return j.success ? (j.data ?? null) : null;
  } catch { return null; }
}
```

Throw, non-2xx, and `{success:false}` all collapse to `null`; `reload()` then does
`setRows(data ?? []); setLoaded(true)` (`:61-65`). The page draws its "no returns"
state over a dead request. This is BUG-2026-08-13-005's exact shape, and
`cachedFetchJsonResult` (`src/lib/cached-fetch.ts:618`) exists specifically for it.

It matters more here than on a report, because the buttons on this page are
money-path: `confirmStock` removes returned goods from inventory FIFO (`:79`) and
`issueDn` reduces Accounts Payable and posts a balanced GL journal (`:87`). An
operator who is shown an empty list because the read died can re-create a return
that already exists. The same helper also feeds the create dialog's source lists
(`:176` `/api/purchase-invoices`, `:194`, `:207`) — a failed PI read makes the
"pick a source" dropdown look legitimately empty.

Same pattern, lower stakes, worth sweeping in the same pass:

* `src/pages/announcements.tsx:489-503` — raw `fetch`, silent on non-OK *and* on
  throw, leaves the page on its empty state.
* `src/pages/agents/index.tsx:248-255` — `loadReview` swallows and sets
  `review = null`, so the scorecard silently vanishes rather than saying it failed.

---

### 9. `/admin/health` fires 16 concurrent requests on mount, and 16 more on every range change

`src/pages/admin/health.tsx:497-572` — sixteen `useCachedJson` hooks, every URL
carrying `?range=`, so flipping 24h → 7d re-issues all sixteen.

Each is a separate Cloudflare Analytics-Engine SQL round-trip made from the
worker (`src/api/routes/admin-health.ts`). PERF-BACKLOG's measured serialization
table stops at 12 parallel (first 1,511 ms, last 1,902 ms). **16 is past the
measured range and I am not extrapolating it.** Payloads themselves are small —
every endpoint aggregates server-side and returns ≤30–200 rows (e.g. `/fe-perf`
reads up to 50,000 AE rows but `.slice(0, 30)`s the response, `:1674`).

**Ranked last deliberately.** SUPER_ADMIN only, opened on purpose, and the page
already carries a cold-load hint it wrote for itself (`:488-491`). A health
dashboard is the one screen where wide fan-out is arguably the product. It is
listed because it is by far the largest fan-out in the unswept set, so anyone
reading "fan-out is the enemy" should see it accounted for rather than missed.

---

### 10. Whole list downloaded to produce a count, or to fill a dialog nobody opened

* `src/pages/mail-center/index.tsx:975-981` — a **second** full
  `/api/mail-center/threads?status=trashed` fetch whose only consumer is the
  number on the Trash folder badge.
* `src/pages/announcements.tsx:421-424` — `/api/departments` and `/api/workers`
  are fetched in a page-level `useEffect(..., [])` (inside `AnnouncementsPage`,
  which starts at `:381`), feeding **only** the composer dialog's audience
  pickers. Most opens of `/announcements` are reads. Two wasted slots in the
  request queue every time.

---

### 11. `/quality` FG picker pulls the whole `fg_units` table

`src/pages/quality.tsx:622` calls bare `/api/fg-units`.
`src/api/routes/fg-units.ts:590-607` is `SELECT fg.*` with three `LEFT JOIN`s,
`ORDER BY fg.id`, **no LIMIT**. `fg_units` is one row per packed piece per
production order, so it scales with production history, not with what an
inspector can sample. The endpoint accepts `?status=` (`:581-584`) and the picker
passes nothing.

Trigger is narrow — FG-stage inspection whose slot has no assigned subject
(`stage === "FG" && !assignedSubject`) — so rank is low. **The right `status`
value is a product question**; do not guess one.

Already known and still open on the same page: `/quality` holds 2,839 pending
inspections across 167 slot cards (`docs/HEALTH-REVIEW.md` §6). The *rendering*
was fixed in #201 (30,303 → 1,747 nodes); whether the screen should default to
recent slots is logged in WORK-TRACKER as an owner decision.

---

### 12. `/notifications` — unbounded query, un-windowed render (latent, not current)

`src/api/routes/notifications.ts:93` has no LIMIT and no date bound.
`src/pages/notifications.tsx:122` renders every returned row, grouped by date,
**with no virtualizer** — while its sibling list pages
(`service-orders`, `inventory/adjustments`, `warehouse`, `invoices/e-invoice`)
all use `useVirtualizer`.

**I found no writer for the `notifications` table anywhere in `src/api`** — no
`INSERT INTO notifications`, no create handler on the route (only `GET` and a
`PUT` mark-as-read). So the table is probably small today and this is a cliff
waiting for whoever adds the generator, not a present pain. **Count the rows
before spending anything on it.** Item 1 above is the reason this endpoint is
worth looking at regardless.

---

## Checked and found CHEAP — do not re-audit these

Numbers in brackets are DOM node counts from the 2026-08-01 render sweep already
recorded in `docs/HEALTH-REVIEW.md` §6.

| Route | Why it is fine |
|---|---|
| `/daily-report` | **1** fetch. `/api/reports/compliance.json` is snapshot-cached + serve-stale **and** kept warm by cron (`src/api/routes/reports.ts:601-673`); the ~6 s cold compute is off the request path by design. [1,154 nodes] |
| `/consignment/note` | 8 hooks, every one narrow: CN list paginated (`:653`), search a separate opt-in fetch (`:667`), Planning/Ready from the snapshot-cached `/ready-planning` aggregate that **replaced** a ~1.2 MB client-side derivation (`:689`), counts from `/stats` (`:783`). Had its perf pass 2026-07-14. |
| `/consignment`, `/consignment/return` | POs via `?fields=minimal&include=` (`index.tsx:142`), list paginated (`:125`), a `/stats` endpoint (`:136`). The `/api/delivery-orders` call at `:526` is inside a click handler. |
| `/warehouse` | `/api/warehouse/movements` is `LIMIT 500` server-side (`src/api/routes/warehouse.ts:483-488`); POs use `?fields=minimal&include=` (`:241`); slot details lazy on selection (`:245`); rows virtualized (`:1451`). [1,158] |
| `/cnc-templates` | 2 narrow hooks (`/api/cnc-templates`, `/api/products` ≈365 rows). [1,193] |
| `/bom/wip-times` | 1 hook, filters pushed into the query string (`:206`). [1,521] |
| `/bom/component-kits` | Payload is item #6; the **failure handling is exemplary** — `:72` throws on `!kRes.success` with a comment explaining exactly why silence was the old bug. [860] |
| `/procurement/maintenance` | 4 hooks, two of them **tab-gated to `price-comparison`** (`:885`, `:888`). |
| `/inventory/fabrics` | 1 hook. [1,474] |
| `/invoices/credit-notes`, `/invoices/debit-notes` | 2 hooks each, and the heavy one (`/api/invoices`) is **null-gated on the modal being open** (`credit-notes.tsx:85`, `debit-notes.tsx:84`). This is the pattern the pages in #5–#7 should copy. |
| `/invoices/e-invoice` | 2 hooks; `invoices` is 426 rows (HEALTH-REVIEW §7); both tables virtualized (`:206`, `:213`). |
| `/invoices/payments`, `/invoices/supplier-payments` | 3 and 2 hooks; supplier-payments scopes its PI reads by `?supplierId=&status=` (`:232`, `:619`). |
| `/purchase-returns` | Payload is cheap — 1 list fetch. Its *failure handling* is item #8. [875] |
| `/production/folders` | 1 fetch. [2,861 / 304 ms] |
| `/production/scan`, `/production/fg-scan` | scan-lookup by code; `/api/workers` only. |
| `/maintenance` | 2 hooks. [961] |
| `/accounting/cash-flow` | 1 hook. |
| `/rd`, `/rd/maintenance` | 1 hook each. (`/rd/:id` is item #6.) |
| `/settings`, `/settings/organisations` | 1 hook each. [914] |
| `/settings/users` | 6 hooks, 3 **permission-gated to `null`** (`:368`, `:371`). [1,712] |
| `/kpi` | 5 hooks, **all conditionally null** on role + active tab (`:123`, `:126`, `:129`). Correct shape. |
| `/agents` | 3 fetches, and the heavy `/review` scorecard is deliberately split off the blocking path (`:246-255`). [1,266] |
| `/forecast` (Forecast P&L) | 4 narrow accounting fetches. |
| `/mail-center` | List is status/mailbox-scoped server-side and capped at 300 threads; render fixed in #199 (11,543 → 2,510 nodes). Only the trash-count fetch (#10) is loose. |
| `/service-orders` | Page load is **1** scoped fetch (`:126`) into a virtualized table (`:136`). The three fat fetches (`:372-387`) live inside `CreateServiceOrderModal`, conditionally mounted at `:295`. |
| `/reports` Sales / Production / Employee | **Generate-on-click, not on mount** (`:483`, `:948`); all use `cachedFetchJsonResult`; the Sales tab fails the *whole* tab rather than half of it (`:452-460`). Production and Employee were fixed in #279. |
| `/reports` Financial | **Already fixed** — PERF-BACKLOG P10 is stale; BUG-2026-08-13-009 and -010 are both 🟢 in `docs/BUG-HISTORY.md`. |
| `/delivery-returns` list itself | 1 hook (`:52`). [904] |
| `/notifications` render today | See #12 — the shape is a cliff, the size is unknown and probably small. |

### One thing that is cheap but not free — noted, not ranked

`/reports` › Sales downloads all ~1,233 sales orders **with every 24-field
line item** to date-filter them in the browser (`:449`, `:461-466`). No existing
`?fields=` projection carries `companySODate` / `totalSen` / `status` /
`customerName`, so narrowing it means a new projection, not a parameter. The
bare list *is* snapshot-cached (`src/api/routes/sales-orders.ts:442-453`), but
`docs/HEALTH-REVIEW.md` §7 records `/api/sales-orders` at **15,298 rows read,
p95 33,008 ms** over 7 days — that is the cold-snapshot rebuild, and the
snapshot dies whenever anyone saves an order. Mitigating factor: the user
clicked *Generate*, so the wait is expected. Worth one probe before any work.

---

## Doc-freshness corrections found while auditing

* `docs/PERF-BACKLOG.md` marks **P10, P11 and P12** as "agent in flight". All
  three have shipped: BUG-2026-08-13-009 (fabricated P&L), -011 (mobile home
  whole-org pull) and -012 (the 1 MB PDF chunk edge) are all 🟢 in
  `docs/BUG-HISTORY.md`, and `main`'s tip commit (`ef5e529e`, #285) covers -011
  and -012. Someone picking up the backlog today would redo finished work.

---

## How to confirm this list — one probe each

| # | Probe |
|---|---|
| 1 | `GET /api/notifications` → bytes + row count; compare `?isRead=false` |
| 2 | none needed — read `src/pages/reports.tsx:962-984` against `:1046` |
| 3 | none needed — `actualQty` has no writer; grep confirms 3 mentions total |
| 4 | Ctrl-K → "Approvals" and watch `<main>` stay empty |
| 5 | `GET /api/inventory/wip` timing; open `/inventory/adjustments`, pick any FG item, read the on-hand cell |
| 6 | `GET /api/inventory` vs `/api/raw-materials` vs `/api/products`, byte sizes side by side |
| 7 | `GET /api/delivery-orders` bytes; then open a delivered DO → "Convert to Delivery Return" and time the landing |
| 8 | Block `/api/purchase-returns` in devtools, reload `/purchase-returns`, observe "no returns" |
| 9 | Open `/admin/health`, count requests in the network panel, then switch range |
| 10 | Network panel on `/mail-center` (two `threads` calls) and `/announcements` (`workers` + `departments`) |
| 11 | `GET /api/fg-units` → bytes + row count |
| 12 | `SELECT count(*) FROM notifications` |
