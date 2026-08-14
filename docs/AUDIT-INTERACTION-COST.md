# Interaction Cost — what the app costs AFTER the page has loaded

> **Last verified: 2026-08-13** against `src/components/ui/data-grid.tsx:330-345`,
> `src/components/ui/toast.tsx`, `src/pages/sales/index.tsx`, `vite.config.ts`.
>
> Same-day audit; spot-checks hold. Suspect 4 really did ship in its own PR — the one
> shared module-scope `const COLLATOR = new Intl.Collator(undefined, {numeric:true})`
> is at `data-grid.tsx:345` with the reasoning above it and
> `tests/data-grid-collator.test.mjs` behind it. Suspect 8 is still open: the toast
> context value is still a fresh object literal (no `useMemo` in
> `src/components/ui/toast.tsx`). Suspects 1–3, 5–7 and 9–10 are open. Read its
> provenance table (PROD / LOCAL / CODE / REPO) before quoting any number — nothing in
> this file except the row-count inheritances was measured on prod in that session.

Every performance audit so far measured page LOAD. This one measures what a
click and a keystroke cost once the page is already up. That dimension had
never been looked at, and the one confirmed instance of the owner's original
complaint — the browser offering to kill the tab — was a **scroll**, not a
load (`/employees`, 46,137 DOM nodes, fixed 2026-08-13 in #281).

## Provenance of every number in this document

Read this before quoting anything below.

| Label | Means |
| --- | --- |
| **PROD** | Measured on erp.hookka.com in the main session's authenticated browser. |
| **LOCAL** | Measured by me on this machine — a `vite build`, or `node --test` over the identical function body. Node's ICU/V8 is not Chrome; treat ratios as sound and absolute ms as indicative. |
| **CODE** | Read out of the source. An arithmetic consequence, not a measurement. |
| **REPO** | A figure already recorded in this repo (a code comment, `docs/PERF-BACKLOG.md`, `docs/BUG-HISTORY.md`). Inherited, not re-measured here. |

**I could not measure prod.** No browser session, login-gated, `.dev.vars`
rotated dead. Nothing below carries a timing I took on the live system. Where a
suspect needs a live number to be confirmed, the exact interaction to perform is
written out in "How to confirm each suspect" at the bottom.

Row counts used throughout: 1,342 sales orders · 2,539 production orders ·
36,796 job cards · ~393 delivery orders · 365 products · 695 working-hour rows.
Purchase-order, GRN, invoice and customer counts were **not** available to me;
where they matter I say so instead of guessing.

---

## Ranked suspects

| # | Suspect | Cost | Evidence |
| --- | --- | --- | --- |
| 1 | `/sales` search loads the whole dataset instead of the server's indexed search | **2,215 KB · 4,480 ms on the first keystroke** | PROD |
| 2 | `/production` search drops BOTH the completed-status filter and the date window | payload returns to ~7.6 MB decompressed, ~1.3 s of JSON.parse | REPO + CODE |
| 3 | `/procurement` and `/procurement/grn` do the same, and their route has **no** server search to switch to | whole PO/GRN table **including every line item** | CODE |
| 4 | Sort comparator built a fresh collator per comparison | 99 ms → 3.6 ms at 2,539 rows (**27.6×**) | LOCAL · **fixed in this PR** |
| 5 | 10 grids rebuild `columns` every render → one row click re-filters and re-sorts the whole dataset | full filter + full sort per click, per toast, per poll | CODE |
| 6 | Print / Preview: cold 294 KB-gzip import + up to 2 API round trips with **no** feedback | dead UI for seconds on the first print of a session | LOCAL (build) + CODE |
| 7 | One page chunk still takes a static edge on the 1 MB PDF chunk | +294 KB gzip before that page renders | LOCAL (build) |
| 8 | Toast context value is a fresh object literal | 2 full re-renders of every `useToast()` consumer per toast | CODE |
| 9 | `columns.find()` runs inside the per-row value-filter predicate | 0.92 ms → 0.26 ms at 2,539 rows | LOCAL |
| 10 | Expanding a group turns virtualization off entirely | whole group mounts unwindowed | CODE |

---

## 1 · `/sales` search downloads the whole dataset — 2,215 KB, 4,480 ms cold  🔴

**PROD (main session).** Typing in the `/sales` search box fires exactly one
request — `GET /api/sales-orders?isServiceOrder=false`, no `search=`, no
`limit=`. **2,215 KB decoded. 256 ms warm, 4,480 ms on the first (cold)
keystroke.**

`src/pages/sales/index.tsx:249-266` — `_filtersActive` is a BOOLEAN, and
`gridSearch.trim()` is one of its terms. The moment the first character lands,
the fetch URL flips from the paginated form to the whole-dataset form:

```
_filtersActive ? `/api/sales-orders?${soFilterQs}`                   // whole set, server-capped 5000
               : `/api/sales-orders?page=${page}&limit=${PAGE_SIZE}` // 200 rows
```

**This is deliberate, and the comment says why**: the DRAFT/CONFIRMED split and
the KPI drill-down are applied client-side, so a 200-row page would show an
arbitrary subset. It is a design trade-off, not an oversight. Treat it as one.

**Debouncing is not the problem — do not "fix" it.** PROD: four keystrokes
produce exactly **one** request, and main-thread blocking during typing was
**0 long tasks / 0 ms**. The URL depends on a boolean, so it only changes on the
empty↔non-empty transition. LOCAL confirms the client filter pass is cheap
anyway (§4b).

**The server already has the fast path.** `src/api/routes/sales-orders.ts:501-505`,
behind a pg_trgm GIN index (migration 0150). PROD: `?search=2608&limit=50` →
172 ms then 122 ms; `?search=AKEMI&limit=50` → 89 ms; `?limit=50` → 108 ms. The
same handler already returns `total` (`sales-orders.ts:526`), narrowed by the
same predicate — so "N of M" is available **without** loading everything.

### What a naive swap would silently break

This is the part that has to be settled before anyone writes the fix. The two
searches do not cover the same columns.

The **server** matches 5 columns:

```
company_so_id · customer_so_id · customer_po_id · customer_name · reference
```

The **client grid** matches every VISIBLE column plus `alwaysSearchKeys`
(`data-grid.tsx:2430-2438`). On the sales grid that is **17** columns
(`sales/index.tsx:758+`). Columns the operator would LOSE:

| Column | What the operator types today |
| --- | --- |
| `status` | `confirmed`, `ready` |
| `customerState` | `selangor`, `johor` |
| `salesOrgCode` | `hookka`, `ohana` |
| `currentDept` | `fab-sew` |
| `companySODate` / `customerDeliveryDate` / `hookkaExpectedDD` | `2026-08` |
| `totalQty` · `outstanding` · `totalSen` · `poProgress` | numeric fragments |

One quirk is NOT worth preserving: `items` is an array of objects, and
`String(val)` renders it `"[object Object],[object Object]"` — so typing `obj`
currently matches every row that has line items.

**Recommended shape for the follow-up task** (not done here): keep the client
filter as the presentation layer, but source its rows from `?search=&limit=…`
extended server-side to cover status / state / org / dept / date, and gate the
merge on a before/after result-set comparison per column. A search that quietly
stops matching a column the operator relies on is a worse bug than a slow one.

---

## 2 · `/production` search drops the two filters that make the payload small  🔴

`src/pages/production/index.tsx:1028-1035`:

```ts
const searchActive = fltSearch.trim().length > 0;
const excludeCompletedFrag = clearAllActive || searchActive ? "" : "&excludeCompleted=true";
const dueFrag = searchActive ? "" : dueQueryFrag;
```

One search term therefore removes **both** narrowings at once:

- `excludeCompleted=true` — the file's own measurement (2026-05-24, `/production/fab-sew`):
  **7.6 MB decompressed → ~3 MB** with the flag, and *"~1.3 s of main-thread
  parse on tab switch"*. Searching hands that back. REPO.
- the `dueFrom`/`dueTo` window — on standalone dept routes the cold start seeds
  `from=to=today`, so searching widens from one day to the entire history. CODE.

Both are deliberate and documented ("gate 1 of 3", "gate 2 of 3"): a COMPLETED
or out-of-window order must be in the payload before the client can find it.

**Cleared, and worth saying plainly:** this page is the best-hardened in the
repo. The search input is debounced 200 ms (`index.tsx:897-903`), the heavy
derivations run off `useDeferredValue` (`:2743-2751`), the row build runs in a
Web Worker, and an "Updating…" hint tells the operator the click registered
(`:2753-2773`). The cost here is **payload**, not main-thread jank.

`/api/production-orders` has **no** `search=` parameter — so unlike sales there
is no server-side fast path to switch to. Adding one is the prerequisite for any
fix.

---

## 3 · `/procurement` and `/procurement/grn` — same shape, no server search  🟠

| Page | Flag | Search-active URL | Server `search=`? |
| --- | --- | --- | --- |
| `/procurement` | `poFiltersActive` (`index.tsx:847-855`) | `/api/purchase-orders` — whole table | **NO** (`purchase-orders.ts`, 0 hits) |
| `/procurement/grn` | `grnFiltersActive` (`grn.tsx:376-383`) | `/api/grn` — whole table | **NO** (`grn.ts`, 0 hits) |

Two things make these worse than they look:

1. **Both list handlers return full line items**, not header rows. Purchase
   orders batch-load `purchase_order_items` for every row on the page
   (`purchase-orders.ts:357`); GRN does the same with `grn_items`. So the
   whole-table variant is the whole table *plus every line*. CODE.
2. **The flag is not just search.** `poFiltersActive` also ORs status, supplier,
   company, date-from, date-to and overdue-only. Picking a status from a
   dropdown — one click, no typing — triggers the same whole-table fetch. CODE.

I could not obtain PO or GRN row counts, so I am not ranking these against sales
by payload. The *shape* is confirmed; the size is not.

---

## 4 · The sort comparator — FIXED IN THIS PR

### 4a · `compareValues` built a collator per comparison  ✅ fixed

`src/components/ui/data-grid.tsx:330` (before):

```ts
return String(a).localeCompare(String(b), undefined, { numeric: true });
```

Per ECMA-402, `localeCompare(that, locales, options)` **is** defined as
`%Collator%(locales, options).compare(this, that)` — it resolves a collator on
every call. A sort does n·log₂n comparisons: 2,539 rows ≈ **28,700** collator
resolutions per header click.

LOCAL (`node`, identical function bodies):

| rows | per-call `localeCompare` | one shared `Intl.Collator` | ratio |
| --- | --- | --- | --- |
| 365 | 4.87 ms | 0.14 ms | 35× |
| 1,342 | 37.21 ms | 1.77 ms | 21× |
| 2,539 | 99.39 ms | 3.61 ms | **27.6×** |

This is not only a header click. `sortedData` re-derives on **every**
`filteredData` change (`data-grid.tsx:2507-2543`), so a grid that is sorted pays
it again on each search keystroke and each data refresh.

**Fixed**: one module-level `const COLLATOR = new Intl.Collator(undefined, { numeric: true })`.
Provably the same algorithm and the same locale resolution — only the resolution
*time* moves, from per-call to module load, and a tab's default locale does not
change mid-session.

**Guarded** by `tests/data-grid-collator.test.mjs` (5 tests): a differential over
4,489 ordered pairs of real value shapes (doc numbers with `numeric:true`
ordering, mixed-case customer names, accents, blanks, statuses, dates, numeric
strings), the null/number fast paths, a 4,000-row full sort asserted
`deepEqual`, a speed floor, and a source guard against reverting.

Other `localeCompare` calls in the file (column customizer, unique-value lists)
run over tens of items rather than n·log n over the dataset and are deliberately
left alone.

### 4b · Typing itself is NOT the problem — cleared

The grid's global search is deferred (`data-grid.tsx:2149`, `useDeferredValue`)
and the filter pass is cheap. LOCAL, the exact loop from `data-grid.tsx:2432-2438`
over 17 searched columns:

| rows | no match (full scan, worst case) | match on column 1 (early exit) |
| --- | --- | --- |
| 365 | 1.03 ms | 0.08 ms |
| 1,342 | 3.76 ms | 0.21 ms |
| 2,539 | 6.34 ms | 0.39 ms |

That agrees with the PROD reading of 0 long tasks while typing on `/sales`.
**Do not add a debounce to the DataGrid search box.**

`getNestedValue` (`:326`) does `path.split(".")` on every single cell read —
22,814 array allocations per pass at 1,342 rows, ~1.3 ms of the 3.8 ms. Real,
but not worth a change on its own at these sizes. Recorded, not filed.

---

## 5 · Ten grids rebuild `columns` every render → a row click re-sorts everything  🟠

`filteredData` lists `columns` in its dependency array (`data-grid.tsx:2477`),
and `visibleColumns` derives from `columns` (`:2064-2075`). So a `columns` prop
with a fresh identity invalidates `visibleColumns` → `filteredData` →
`sortedData` (a **full re-sort**) → `allGroupValues`.

`sales/index.tsx:740-743` already carries the scar tissue: *"a fresh `columns`
array every render made the DataGrid's filteredData/sortedData memos recompute
over the full ~690-row dataset on EVERY unrelated re-render (poll, selection,
search-mirror)"*. That fix was applied to sales only. **Twelve** sites still declare
`columns` as a bare array literal inside the component body. (This said "Ten"
and listed ten; re-enumerated 2026-08-14 over every `const …: Column<…>[] = [`
in `src/pages` + `src/components`, classifying each as module-scope /
`useMemo`-wrapped / bare-in-component — the two Employees grids below were
missed, and a sweep of "the ten" would have closed the class with them still
open:)

| File:line | Grid |
| --- | --- |
| `src/pages/customers.tsx:3684` | Customers |
| `src/pages/accounting/index.tsx:3035` | Journal entries |
| `src/pages/accounting/index.tsx:2163` | Recent entries |
| `src/pages/production/folder-detail.tsx:339` | Folder job cards (36,796 job cards system-wide) |
| `src/pages/invoices/credit-notes.tsx:256` | Credit notes |
| `src/pages/invoices/debit-notes.tsx:177` | Debit notes |
| `src/pages/invoices/payments.tsx:352` | Payments |
| `src/pages/consignment/index.tsx:404` | Consignment orders |
| `src/pages/delivery-returns/index.tsx:72` | Delivery returns |
| `src/pages/maintenance/sofa-combos.tsx:589` | Sofa combos |
| `src/pages/employees.tsx:4877` | Department Labor (fed to `<DataGrid columns={columns}>` at `:5260`) |
| `src/pages/employees.tsx:5610` | Labor Cost items (fed to `<DataGrid columns={itemColumns}>` at `:5985`) |

Consequence: on these pages **selecting a single row** re-runs the entire
filter + sort pipeline over the whole dataset — because selection lifts to the
parent via `onSelectionChange` (`data-grid.tsx:2612-2624`), the parent
re-renders, `columns` gets a new identity, and every memo downstream falls over.
Same for every toast (§8) and every background poll.

Combined with §4a this was the worst pairing in the audit: before the collator
fix, one row click on a 2,539-row grid with unmemoised columns cost a ~99 ms
re-sort. It is now ~3.6 ms — but the wasted filter pass and the full re-render
remain.

**Not fixed here.** Twelve sites across eleven files, and each needs its own
dependency array worked out correctly; a wrong dep list produces a stale grid,
which is worse than a slow one.

**Cleared:** `src/pages/inventory/index.tsx:662/769/979` declares `fgColumns` /
`wipColumns` / `rmColumns` at **module scope** (column 0, outside any component) —
stable identity, no problem. `employees.tsx:3939` is `useMemo`-wrapped and is
likewise clear. Both re-checked 2026-08-14.

---

## 6 · Print / Preview stalls with no feedback  🟠

LOCAL (`npm run build`, this branch): `pdf-D0Z4EJlb.js` is **1,035,659 bytes raw
/ 301,219 bytes gzip**. Since #285 it is genuinely lazy — a first print click
now pays a cold ~294 KB-gzip download plus the parse/compile of ~1 MB.

That is the right trade. What is missing is telling the operator it is happening.
A typical context-menu handler (`src/pages/delivery/index.tsx:3690-3722`):

1. `fetch(/api/delivery-orders/:id/print-extras)` — API round trip
2. `fetchDoQrDataUrl(...)` — second round trip
3. `await import("@/lib/generate-do-pdf")` — cold 294 KB gzip + ~1 MB parse
4. `generateDOPdf(...)` — builds the document on the main thread

…with **no busy flag, no spinner, no toast**. The context menu closes on click
and the UI is simply dead. On the API tier that serializes concurrent requests
(`docs/PERF-BACKLOG.md`: 1 call 41 ms, 12 in flight 1,902 ms) those two round
trips are not free either.

**No feedback** — `procurement/index.tsx:1692` · `invoices/credit-notes.tsx:317` ·
`invoices/debit-notes.tsx:238` · `delivery/index.tsx:3717` and `:2715` ·
`delivery/detail.tsx:518` · `consignment/detail.tsx:881` · `consignment/note.tsx:2009, 2028, 2131` ·
`procurement/detail.tsx:643` · `products/documents.tsx:490` · `sales/detail.tsx:1090` ·
`employees.tsx:7113`

**Has feedback** (the pattern to copy) — `sales/index.tsx:720-737` (`downloadingPdf`) ·
`procurement/grn.tsx:502-540` (`downloadingPdf`) · `consignment/index.tsx` (`bulkPrinting`) ·
`worker/pay.tsx:485` (`payslipBusy`).

Bulk paths (`generateCombinedGRNPdf`, `generateCombinedSOPdf`,
`generateConsolidatedDoPdf`) all build one document from N records on the main
thread. They are the ones that already have busy flags, so the operator at least
sees the button change — but the freeze itself is unmeasured, and scales with
selection size.

---

## 7 · One page chunk still statically imports the 1 MB PDF chunk  🟡

BUG-2026-08-13-012 / #285 took the static importers of `pdf-*.js` from **53 to
14**. LOCAL, verified on this branch's build: still 14 — and 13 of them are the
`generate-*-pdf-*.js` chunks themselves (correct — they need pdf-lib) plus the
`index.es` vendor chunk. Exactly **one** page chunk remains:

```
detail-VI76U_z1.js  →  import{i as p,n as m}from"./pdf-D0Z4EJlb.js"
```

Source: **`src/pages/delivery-returns/detail.tsx:16`** —

```ts
import { generateDeliveryReturnPdf } from "@/lib/generate-delivery-return-pdf";
```

the only top-level (non-`await import`) PDF import left in `src/pages`. Opening
a delivery-return detail therefore downloads 294 KB gzip of PDF vendor code
before the page renders. The fix is to match the other 20 call sites — move it
into the click handler as `await import(...)` — and it is the closing item of
#285 rather than a new bug. **Not done here**: it changes a chunk graph, and
#285's own note says prove PDF generation still works before shipping.

---

## 8 · Toast context value is a fresh literal → 2 full re-renders per toast  🟡

`src/components/ui/toast.tsx:285`:

```tsx
<ToastContext.Provider value={{ toast }}>
```

Both `toast` and the wrapping object are rebuilt on every `ToastProvider`
render, and the provider re-renders whenever `toasts` state changes — once when
a toast is added, once when it auto-dismisses 4 s later (`DURATION_MS = 4000`).
Each of those gives the context a new identity, so **all 71 `useToast()`
consumers** re-render. In practice that is the page component holding the grid;
combined with §5 it means every save confirmation costs two full
filter+sort passes on those ten pages. CODE.

`{children}` keeps its element identity, so React does bail out of the rest of
the tree — the blast radius is context consumers only, not the whole app.

**Cleared:** the 50 ms progress-bar tick lives inside `SingleToast`
(`toast.tsx:163-171`), a leaf. It re-renders one toast, not the app. That was
the thing worth being wrong about, and it is fine.

---

## 9 · `columns.find()` inside the per-row value-filter predicate  🟡

`src/components/ui/data-grid.tsx:2467`, inside `result.filter(row => …)`:

```ts
const col = columns.find((c) => c.key === key);
```

A linear column scan per row per active value filter: rows × filters × columns.
At 2,539 rows × 1 filter × 17 columns ≈ 43,000 comparisons. This runs on nearly
every grid because `defaultExcludedValues` seeds a Status filter on first paint.

LOCAL: 0.92 ms as written vs 0.26 ms with the lookup hoisted to a `Map` outside
the loop. Small in absolute terms; filed rather than fixed because it lives in
the same memo as §4a and one change to that hot path per PR is enough.

---

## 10 · Expanding a group switches virtualization off  🟡

`data-grid.tsx:2567`: `virtualizationActive = virtualize && !(groupBy && groupEnabled)`.
While grouping is on, the virtualizer's result is ignored and **every row of
every expanded group mounts**. Groups default to collapsed (`:2496-2505`),
which is what makes first paint fast — the comment records the pre-fix cost as a
*"300-1200 ms freeze on DO + dept pages"*. The freeze returns the moment the
operator expands a large group. That is an interaction nobody has measured.

Grids where grouping is ON by default (no `autoGroup={false}`):
`src/pages/consignment/note.tsx:3178` and `:3223` (`groupBy="customerState"`),
`src/pages/maintenance/sofa-combos.tsx:836` (`groupBy="baseModel"`). Neither
passes `virtualize` at all, so those two are unwindowed regardless.

**Cleared:** `src/pages/delivery/index.tsx:4842-4843, 4906-4907` passes
`autoGroup={false}` — flat on open, virtualization stays active. Correct.

---

## Cleared — do not re-open these

- **The Ctrl+K global search palette.** `src/components/layout/global-search.tsx:255-366`:
  250 ms debounce, an `AbortController` that cancels the superseded request,
  a 2-character minimum, and **one** unified `GET /api/search?q=&limit=8` — the
  six-way per-keystroke fan-out is already gone. The static page/action filters
  run over ~40 and ~9 items. Nothing to do.
- **DataGrid typing latency.** Deferred and cheap — see §4b. PROD showed 0 long
  tasks. Adding a debounce would only make search feel laggier.
- **The Production page's own search box.** Debounced 200 ms, deferred,
  worker-backed, with an "Updating…" hint. The exemplar.
- **`/customers`, `/products`, `/inventory` search.** These pages have no
  pagination to drop — they fetch the whole set on mount (`/api/customers`,
  `/api/products`, `/api/inventory` 1.16 MB per PERF-BACKLOG). Searching fires
  **no** request at all. Their cost is load, already tracked as P6.
- **`/delivery`, `/invoices`, `/consignment/note` search.** These already use the
  server's indexed search — a **separate** fetch (`?search=<term>&limit=2000`)
  that deliberately never disturbs the page's browse load, so the derivations
  built from it (`linkedPOIds`, tab counts) stay whole. This is the good shape;
  it is what sales/procurement/GRN should converge on. One caveat below.
- **Row expansion and per-row fetches.** DataGrid has no expandable-row feature
  at all — only group headers. There is nothing that fetches per row on expand.
- **`inventory/index.tsx` column definitions.** Module scope, stable identity.
- **CSRF.** Untouched, per `docs/context-packs/HOOKKA-GOTCHAS.md` — every
  mutating `/api/*` call is patched globally and no fetch is ever "missing" it.

### One caveat on the good shape

On `/delivery`, `/invoices` and `/consignment/note` the search TERM is
interpolated into the fetch URL (`delivery/index.tsx:1160-1169`,
`invoices/index.tsx:99-101`, `consignment/note.tsx:661-670`), and `useCachedJson`
fires on any URL change with no debounce of its own — `useDeferredValue` in the
grid delays the value by a frame but does not coalesce distinct terms. So unlike
`/sales`, each distinct term is its own request. The previous one **is** properly
aborted (`cached-fetch.ts:359-367`, refcount → 0 → `controller.abort()`), so this
is a sequence of short-lived requests rather than a pile-up — but it puts one
abort per keystroke onto a tier where aborts are already the shape users
experience as errors (`docs/PERF-BACKLOG.md` P8). **This is CODE, not measured.**
It is the first thing to check in the browser (§A below) because if it is real it
is cheap to fix and if it is not, the whole family is clean.

---

## How to confirm each suspect in the browser

Nothing here was measured on prod. Each of these is one probe. Use the exact
query string the product issues — three false alarms in the 2026-08-13 session
came from probing calls the app never makes.

**A · Does `/delivery` fire one request per keystroke?** (highest value: settles
a whole family)
Open `/delivery`, DevTools → Network, filter `delivery-orders`. Type
`2607` one character at a time at normal speed. Count requests carrying
`search=`. **Expect 1 if coalesced, 4 if not.** Check how many show as
`(canceled)`. Repeat identically on `/invoices` (filter `invoices`) and
`/consignment/note`.

**B · `/procurement` — does a dropdown click, not just typing, pull the whole
table?** Open `/procurement`, Network, clear. Pick any value in the **Status**
dropdown — do not type anything. Expect a single `GET /api/purchase-orders`
with **no** `page=`/`limit=`. Record its decoded size and duration cold. Then
repeat on `/procurement/grn` with its Supplier or Status filter (`GET /api/grn`).
These two give the payload figures I could not obtain.

**C · `/production` — how much does one search term cost?** Open
`/production/fab-sew` and let it settle. Network, clear, then type `AKEMI` in the
top-bar search. One `GET /api/production-orders?fields=minimal&dept=fab-sew` with
**no** `excludeCompleted=true` and **no** `dueFrom`/`dueTo` should fire. Record
decoded size and duration, and the Performance-tab scripting time for the
`JSON.parse` that follows. Compare against the same page's pre-search request.

**D · Does the collator fix show up?** (verifies this PR)
On `/production/fab-sew` (2,539 rows) start a Performance recording, click the
**Customer** column header once, stop. Read total blocking time for that click.
On `main` it should include a ~100 ms comparator task; on this branch it should
not. Same probe on `/sales` (1,342 rows): ~37 ms → ~2 ms. If the browser numbers
are much larger than the LOCAL ones, that is expected — the ratio is the claim.

**E · Do unmemoised columns cost a row click?** Open `/customers`, sort by any
column, then Performance-record a **single row click** (select one row, no
navigation). Compare to the same click on `/sales`, whose `columns` **is**
memoised. If §5 is real, `/customers` shows a filter+sort task and `/sales` does
not.

**F · How long is a print click dead?** Hard-refresh `/procurement` so the PDF
chunk is cold. Right-click a PO row → **Print / Preview**. Time from click to the
PDF appearing, and watch Network for `pdf-*.js` (~294 KB gzip) plus any
`print-extras` call. Repeat immediately (warm) for the difference. Then the same
on `/delivery` (right-click a DO → Print), which additionally makes two API round
trips first.

**G · Does expanding a group freeze the tab?** Open `/consignment/note`, go to a
tab whose grid groups by customer state, and expand the **largest** group.
Performance-record the expand click and read the longest task. Compare with
`/delivery`, which passes `autoGroup={false}` and should stay windowed.

**H · Does a toast cost two re-renders?** On `/customers`, React DevTools
Profiler → record, trigger any save that raises a toast, and wait 5 s so the
auto-dismiss fires. Expect two commits touching the page component ~4 s apart,
each carrying a filter+sort.

---

## Changed in this PR

| File | Change |
| --- | --- |
| `src/components/ui/data-grid.tsx` | `compareValues` uses one module-level `Intl.Collator` instead of resolving one per comparison. Same algorithm, same locale, 21–27× less work per sort. |
| `tests/data-grid-collator.test.mjs` | New. Differential over 4,489 ordered pairs + null/number fast paths + a 4,000-row `deepEqual` sort + a speed floor + a source guard. |
| `docs/AUDIT-INTERACTION-COST.md` | This document. |

Nothing else was changed. Every other finding is filed, not fixed — a grid
rewrite, a ten-file memoisation sweep, and a search that changes which columns
it matches all need their own task with their own before/after comparison.
