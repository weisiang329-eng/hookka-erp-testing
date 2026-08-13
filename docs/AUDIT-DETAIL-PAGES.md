# Audit — detail pages, edit forms and dialogs (the "second click")

**Date:** 2026-08-13 · **Branch:** `audit/detail-pages` · **Scope:** everything a user
reaches by opening ONE record — detail pages, edit forms, create forms and the dialogs
mounted inside them. Every audit before this one measured LIST pages.

---

## READ THIS FIRST — what kind of document this is

**No number in this file was measured on prod.** The app is behind a login gate, the
`.dev.vars` credentials are rotated dead, and this session has no authenticated browser.
Every figure below is one of:

- **CODE** — read out of the source in this tree (line numbers, call chains, gating).
- **DOCS** — a row count or payload size someone else measured and wrote down
  (`docs/PERF-BACKLOG.md` P6, `docs/BUG-HISTORY.md` BUG-2026-08-13-008, the task brief).
- **ARITHMETIC** — CODE × DOCS.

Where a claim rests on something I could not check, it says so in the row. Following
`HOOKKA-GOTCHAS.md` §"how the WRONG answer gets produced", nothing here is rounded up
to a fact, and §3 in particular: **two code comments in this tree describe behaviour the
code does not have** (findings D2 and D6) — both were caught by reading the code, not the
comment.

The baseline this all sits on is the one PERF-BACKLOG already established and I did not
re-derive: **the API tier serializes concurrent requests** (1 call = 41 ms; 6 parallel =
39…194 ms; 12 parallel = 1511…1902 ms). So on a detail page the thing that hurts is
**fan-out and payload**, not any single endpoint. The unit of pain is *how many requests
does opening this record put in the queue, and how many bytes do they drag*.

One mechanism amplifies all of it and is worth stating once, because it is not obvious
from any page: **`useCachedJson` ALWAYS re-fetches on mount.** `src/lib/cached-fetch.ts`
line 478 reads `void ttlSec;` with a comment explaining the TTL was deliberately retired.
The cache serves the first paint; it never suppresses the request. So "the cache is warm
from the list page" is false for the network — the whole burst fires again on every
navigation into a record.

---

## Ranked suspects

Ranked by expected user pain = (requests added to the serialized queue) × (bytes) ×
(how often a real operator does this).

| # | Where | What it fetches | What it actually consumes | Arithmetic | Verify in one probe |
|---|---|---|---|---|---|
| **D1** | `src/pages/service-cases/detail.tsx:260-268` | `GET /api/delivery-orders` — bare, whole org | `computeCasePipeline` uses ONLY `{salesOrderId, status, createdAt, dispatchedAt, deliveredAt}` of the DOs whose `salesOrderId ∈ svOrderIds`, and `src/lib/case-pipeline.ts:131` filters to exactly that set. Nothing else on the page touches `doResp`. | **1.07 MB** (PERF-BACKLOG P6) / ~393 DOs downloaded so a stepper can read ≤5 rows × 5 fields. The sibling PO fetch three lines below (`:270`) was scoped with `&scope=` in BUG-2026-08-13-003; **this one was left whole-org.** Backend has no `scope=` on `/api/delivery-orders` (`src/api/routes/delivery-orders.ts:121-190` — only `page`/`limit`), so a fix needs the same `scope=` param the PO route already has. | Open any service case with devtools; look for `/api/delivery-orders` with no query string and its transfer size. |
| **D2** | `src/components/ui/document-chain-map.tsx:416` + `:497` | `{open && <StationStrip poId={po.id}/>}` where `const open = openPOs[po.id] ?? true` → **one `GET /api/production-orders/:id` per linked PO, on mount, all at once** | Per-PO job cards, grouped into department chips. | The component's own comment at `:175` says *"Fetched only when the production order is expanded … pulling every one up front would cost more than it shows"* — **the default is expanded, so it pulls every one up front.** The comment describes the intent; `:416` is the behaviour. Cost = **N extra requests where N = linked POs on this SO**, on **four** pages: `sales/detail.tsx:1775`, `invoices/detail.tsx:1512`, `delivery/detail.tsx:1110`, `service-cases/detail.tsx` (`DocumentChainMap`). Org ratio is 2,539 POs / 1,342 SOs ≈ **1.9 average**, but a multi-line order (bedframe + mattress + sofa) explodes one PO per line — **the tail is what an operator opens.** At N=6 this alone puts the page in the 12-parallel band (1.5-1.9 s). | Open a multi-line SO's detail; count `/api/production-orders/<uuid>` requests in the network panel. It should equal the number of PO cards drawn. |
| **D3** ✅ **FIXED 2026-08-13 — BUG-2026-08-13-016** (`useCachedJson` now returns `failure`; `isUnknownOutcome` gates every "not found"; class C15) | `src/lib/cached-fetch.ts:515-521` (+ `src/lib/api-client.ts:100-104`) | — | — | **A failure that is indistinguishable from empty — again, and this time SILENT.** `api-client` aborts every `/api/*` call at `API_TIMEOUT_MS = 30_000` and re-throws the original `AbortError`. `cached-fetch`'s hook catches it, decides `if (isAbortError(err)) return;` — **no `setError`** — and `.finally` still runs `setLoading(false)`. Result on a 30 s timeout: `data = null`, `loading = false`, `error = null`. What the operator sees: `sales/detail.tsx:859` **"Order not found"** · `consignment/detail.tsx:710` **"Order not found"** · `delivery/detail.tsx:442` **"Delivery order not found"** · `invoices/detail.tsx:431` **"Invoice not found"** · `grn-detail.tsx:644` **"GRN not found."** · `PurchaseInvoiceDetail.tsx:547` **"Purchase invoice not found."** — and on `service-cases/detail.tsx:392` / `service-orders/detail.tsx:165`, an **eternal "Loading…"** (neither page reads `loading` or `error` at all). This is BUG-2026-08-13-005's class on the primary read of eight pages. `cachedFetchJsonResult` exists for the non-hook path; **there is no hook equivalent.** The distinguishing signal IS available: the hook's own `cancelled` flag is `true` for every unmount abort, and `releaseInflight` only aborts when refs hit 0 (i.e. all consumers unmounted, all `cancelled`) — so **an `AbortError` reaching a non-cancelled consumer is the 30 s timeout, essentially by construction.** | Throttle to offline (or block `/api/sales-orders/*`) and open an SO. It should say "Order not found", not "couldn't load". |
| **D4** | `src/pages/procurement/detail.tsx:141-142` | `GET /api/inventory` + `GET /api/supplier-materials`, both unconditional on mount | `rawMaterials` only (`:160`), and only inside the edit-mode block — `filteredRMs` (`:282`) renders at `:813`, inside `{editing && isEditable && …}` (`:749`); `supplierMaterialBindings` is used at `:299`, `:337`, `:842`, all edit-only. **A PO detail page that is only being READ uses neither.** | `/api/inventory` = **1.16 MB** (PERF-BACKLOG P6) and is `SELECT * FROM products` (**365** rows) + `SELECT * FROM wip_items` + `SELECT * FROM raw_materials` (**279** rows) — `src/api/routes/inventory.ts:148-171`. The page decodes all three buckets and discards two. **The products bucket is the bulk** (for scale: `/api/products` is 319,231 bytes at 365 rows, BUG-2026-08-13-008). The wip_items count is **UNKNOWN — not measured here**, so I am not putting a percentage on the waste, only that two of three buckets are unused. | Open a PO detail without clicking Edit; `/api/inventory` should be in the waterfall. |
| **D5** | `src/pages/service-cases/detail.tsx:218-232` | `GET /api/customers` — whole customer master | ONE record: `custResp.data.find(c => c.id === caseDetail.customerId)` at `:236`, for name / phone / delivery hub. | **`GET /api/customers/:id` already exists and is already used for exactly this** on `sales/detail.tsx:467` and `consignment/detail.tsx:424`. Customers ≈ **122** (BUG-HISTORY, live `?search=` probe — that figure is older than 2026-08 and is the count I could find, not a fresh one). A whole master pulled to resolve one foreign key, when the scoped read is in the same codebase two pages over. | Open a service case; `/api/customers` (no id) in the waterfall. |
| **D6** | `src/pages/invoices/detail.tsx:87-92` | `GET /api/invoices` — the whole invoice list, fired the moment the single invoice resolves | The **"Customer Statement"** card at `:1120-1209`: rows for `inv.customerName === invoice.customerName && inv.id !== invoice.id`, plus three `reduce` totals. | ~**355 invoices** (BUG-HISTORY 2026-07, was 341 in July — growing) × header-only rows (`rowToInvoiceList` ships `items: []` / `payments: []`, deliberately). **`GET /api/invoices?customerId=` ALREADY EXISTS** — `src/api/routes/invoices.ts:1094` + `:1113-1116`. ⚠️ **But it is NOT a drop-in and must not be treated as one:** the endpoint filters on `customerId`, the page filters on `customerName`. Those keys diverge for invoices produced by `POST /api/consignment-notes/:id/convert-to-invoice` (the page's own comment at `:76-80` says those rows carry no `salesOrderId`). Swapping without checking would silently change which invoices appear on a customer statement — a money-facing surface. Verify the two key sets agree before touching it. | Open any invoice; `/api/invoices` bare in the waterfall. Then compare `?customerId=<id>` row count against the statement's row count. |
| **D7** | `src/pages/service-cases/detail.tsx` — three always-mounted panels | `:2056` `GET /api/products` (from `AffectedProductsPanel`, rendered unconditionally at `:723`) · `:2071` `GET /api/sales-orders/:sourceId` or `/api/consignment-orders/:sourceId` · `:2396-2404` `GET /api/raw-materials` (`StockTopUpPanel`, rendered unconditionally at `:819`, `type` defaults to `"RM"` at `:2385`) | A search-as-you-type product picker and a stock picker the operator may never open. | **365 products (~319 KB) + 279 raw materials + one full order detail, on every service-case open.** Combined with D1, D2 and D5 this page's mount burst is **≈8-11 requests plus N per-PO calls** — squarely in the 12-parallel band PERF-BACKLOG measured at 1511-1902 ms, *before* payload transfer. Add the conditional ones: `CategoryDetailsForm` (`:1405-1437`) fires `/api/workers`, `/api/raw-materials`, `/api/suppliers` or `/api/drivers` whenever a root-cause block has a category — it renders in **view** mode too (`:1147`, only `disabled` is gated). | Open a service case that has a root cause set; count total requests on mount. |
| **D8** | `src/pages/procurement/grn/create.tsx:138-158` and `src/pages/procurement/pi/create.tsx:141-160` | Five whole-org masters each: `/api/purchase-orders` (all) + `/api/suppliers` + `/api/organisations` + `/api/inventory` + `/api/supplier-materials` | GRN create: a PO dropdown, a supplier dropdown, an RM picker for the scan wizard. PI create: the same plus a Linked-PO dropdown. | `/api/purchase-orders` = **165 POs / 158,763 bytes** (BUG-2026-08-13-008, measured) and `/api/inventory` = **1.16 MB** ⇒ **≈1.35 MB before the form paints**, over 5 serialized slots. Sharpest case: `grn/create?poId=…` deep-links from the PO detail page with `isLockedPO = true` (`:134`) — the PO is fixed to one, and it still downloads all 165 with their items. It does also pass `purchaseOrders` to the scan wizard (`:1468`) and builds a Map at `:508`, so **a narrow fix is not one line** — the locked and unlocked paths need separating. | Open `/procurement/grn/create?poId=<any>`; check `/api/purchase-orders` transfer size. |
| **D9** | `src/pages/suppliers/detail.tsx:202-223` and `:261-263` | `:209` `GET /api/inventory` (1.16 MB) on mount · `:261` `GET /api/purchase-orders` (all 165, 158 KB) when the Price History tab opens | `:209` → the SKU dialog's RM autocomplete. `:261` → `poLines`, filtered client-side with `if (po.supplierId !== id) continue`. | Two whole-org lists on one supplier's page. **`/api/purchase-orders` has NO supplier filter** (`src/api/routes/purchase-orders.ts:322-323` — only `page`/`limit`), so unlike D6 there is no existing scoped read to switch to; the fix is a new query param. The `/api/inventory` one is at least deferred behind a tab. **Also a real (small) correctness bug here:** `:214` spreads `invResp.data.finishedGoods` — that key **does not exist**. The endpoint emits `finishedProducts` (`inventory.ts:170`); `finishedGoods` appears nowhere in `src/api` (grep-verified). So the SKU autocomplete has silently never offered finished goods. Do NOT "fix" by renaming — that ADDS rows to a picker, it is not output-identical, and whether FG belongs in a supplier-material binding is an owner question. | Open a supplier → Price History tab; `/api/purchase-orders` bare. |
| **D10** | `src/pages/production/index.tsx:4944-4964` | Inside `fetchFgStickersForOrders`: `await Promise.all(uniqueSoIds.map(id => fetch('/api/sales-orders/'+id)))` | ONE field: `j.data.customerSOId \|\| j.data.customerSO` (`:4959`). | Fires when the operator prints FG stickers for the **visible** PO set (`:5521` `visiblePoIds`), so N is a screenful of orders, not one. Each call is the **full SO detail handler** — `src/api/routes/sales-orders.ts:2596-2800`: linked POs + `string_agg` over job_cards + linked DOs + `delivery_order_items` + invoices + `payment_records LIKE` + status history + price overrides — **eight query groups to read one string.** N unbounded × heavy, all `Promise.all`, straight into the serializing tier. This is the highest per-click cost I found, but it is a print action rather than a page open, so it ranks below the pages an operator hits all day. Note the concurrency cap (`MAX_CONCURRENCY = 10`, `:5106`, applied at `:5116`) applies to sticker *building*, **not** to this `Promise.all` — the SO fetches are uncapped. | Print FG stickers with 20+ orders visible; count `/api/sales-orders/<uuid>` calls. |
| **D11** | `src/pages/sales/create.tsx:233-253` and `src/pages/sales/edit.tsx:213-222` | `/api/customers`, `/api/products`, `/api/organisations`, `/api/fabric-tracking` — all four with `CAT_OPTS = { revalidateOnFocus: true }` (`:232`) | The pickers. | The four heaviest masters on the form **re-fetch every time the window regains focus** (gated only on cache age > 2 s, `cached-fetch.ts:555`). An operator alt-tabs constantly while writing an order — to a spec sheet, to WhatsApp, to the customer's PO. Each return = **4 requests including 365 products (~319 KB) and the whole customer master.** The option is deliberate and its reason is written at `:228-232` (a fabric added in Maintenance must appear here), and `invalidateCache`'s BroadcastChannel already covers the same-machine case — so this is a **question for the owner about the cross-device case**, not an obvious bug. `consignment/create.tsx:201-211` does NOT use `CAT_OPTS` and is unaffected. | Open `/sales/create`, alt-tab away and back, watch the network panel. |
| **D12** | `src/pages/service-orders/detail.tsx:140-146` · `src/pages/rd/detail.tsx:360` · `src/pages/procurement/PurchaseInvoiceDetail.tsx:187-198` · `src/pages/procurement/create.tsx:78` | `GET /api/inventory` (1.16 MB) on mount | `finishedProducts` only (service-orders, for a per-row Scrap dropdown) · `rawMaterials` only (rd, PI detail, procurement create) | The same D4 shape in four more places. Combined with D4 and D9, **`/api/inventory` is fetched on mount by 7 pages in this audit's scope, and not one of them uses more than one of its three buckets.** `GET /api/raw-materials` (`src/api/routes/raw-materials.ts:180-192`) already serves the RM bucket alone — ⚠️ but its `rowToApi` (`:108-132`) is a **wider** per-row shape than inventory's `rowToRawMaterial` (`inventory.ts:127-140`): it adds `unit`, `status`, `notes`, timestamps, `uomCount`, `itemType`, `stockControl`, `mainSupplierCode`, sheet dims. So it is **not** a strictly smaller payload per row, only a smaller response overall. Any swap needs its own before/after measurement, not an assumption. | Open a repair order; `/api/inventory` in the waterfall. |
| **D13** | `src/pages/customers.tsx:215` | `GET /api/products` (365 rows, ~319 KB) from `CustomerProductsPanel` | The SKU-assign picker and a `productById` Map. | The panel is **collapsed by default** (`:248` `useState(true)`) but the fetch is a top-level hook — `{!collapsed && <CardContent>}` (`:1062`) gates only the render. So **expanding a customer row downloads the whole product catalogue for a panel that stays shut.** Lowest-ranked because the fetch is at least behind the row expansion, not the page load. | Expand one customer on `/customers`; `/api/products` fires with the body collapsed. |

---

## Checked and found CHEAP — do not re-audit these

Written down with the reason so the next agent skips them.

**Pages whose mount burst is already tight**
- `src/pages/sales/detail.tsx` — every fetch is scoped: `/api/sales-orders/:id`, `/api/files?resourceType=SO&resourceId=`, `/api/customers/:id` (`:467`), `/api/sales-orders/:id/edit-eligibility`. `linkedPOs` / `linkedDOs` / `linkedInvoices` / `linkedPayments` / `statusHistory` / `priceOverrides` all ride the single detail response (`sales-orders.ts:2780-2800`) — **no list download, no client-side filtering.** Its only fan-out is D2, which it inherits from a shared component. `HubEditModal` (`:1363`) is always mounted but takes `hubs` as a prop and fetches nothing.
- `src/pages/delivery/detail.tsx` — `/api/delivery-orders/:id` + `/api/lorries`. Two calls. Fine.
- `src/pages/consignment/detail.tsx` — `/api/consignment-orders/:id`, `/api/consignment-orders/:id/edit-eligibility`, `/api/customers/:id` (`:424`, the scoped read D5 should be using). Fine.
- `src/pages/procurement/grn-detail.tsx` — `/api/grn/:id` + `/api/suppliers` + `/api/organisations`. No whole-org list, no `/api/inventory`. Notably cleaner than its sibling `procurement/detail.tsx` (D4).
- `src/pages/mail-center/detail.tsx` — `/api/users` + `/api/auth/me`, both small.
- `src/pages/production/folder-detail.tsx` — folder + rows + `/api/workers`. Scoped.
- `src/pages/service-cases/detail.tsx:270-297` — the **production-order** fetch is correctly `?fields=minimal&include=jobCards&scope=<svOrderIds>`, with the reasoning written out. That one is right; it is the DO fetch beside it (D1) that was missed.
- `DocumentChainMap` on `sales/detail.tsx` costs **zero extra SO requests**: `document-chain-map.tsx:296` requests `/api/sales-orders/${soId}` and the page already holds `/api/sales-orders/${id}` — same URL string, so `joinInflight` (`cached-fetch.ts:287`) collapses them to one. It is a genuinely extra call on `invoices/detail`, `delivery/detail` and `service-cases/detail`, where no such fetch exists.

**Patterns that look like the known bugs but are not**
- **No `cachedFetchJson` (the null-on-failure one) anywhere on the detail/create surface.** Grep-verified across all sixteen files in scope. Every one uses `useCachedJson`. The failure-vs-empty problem on these pages is D3 — a different mechanism (a swallowed abort) with the same symptom. Do not go looking for `cachedFetchJson` callers here.
- **No fabricated metrics on the detail surface.** Scanned all eleven detail pages for `* 0.NN`, `* 1.NN`, `Math.random`, `seed(`. The only hits are three id generators (`service-cases/detail.tsx:2508, 2886, 3098` — `act-${Math.random()...}`) and a comment in `rd/detail.tsx:117`. Nothing derives a displayed number from a hash, a constant or itself. The three fabrication bugs found on 2026-08-13 were all on `reports.tsx`; **the detail pages are clean.**
- **`/api/fabric-tracking` fetched twice** in `sales/create.tsx:246,247` and `consignment/create.tsx:210,211` is **ONE network request**, not two — identical URL strings, and `joinInflight` dedupes concurrent callers by URL. Do not "fix" this.
- **`products.find()` inside `.map()` over order items** — `sales/create.tsx:1051`, `:1070`, `:1306`, `:1388`. Genuinely the C14 shape, and genuinely cheap: an SO carries tens of lines, so ≤~50 × 365 ≈ **18 K comparisons**, once, on a seat-height edit. For scale, BUG-2026-08-13-008 measured 619,405 comparisons at 18.2 ms; this is 3% of that. Leave it.
- **`suppliers/detail.tsx:264-285` `poLines`** — a single nested walk over POs × their own items, not a filter-per-row. Linear. Cheap.
- **`service-cases/detail.tsx:236` `custResp.data.find(...)`** — one pass over the customer list. The problem there is the *fetch* (D5), not the scan.
- **`SpawnServiceOrderModal`** (`service-cases/detail.tsx:3005`, fetches `/api/inventory` at `:3030`) is correctly gated: rendered as `{spawnOpen && <SpawnServiceOrderModal …>}` at `:862`. It costs nothing until opened. Contrast D7, where the sibling panels are unconditional.
- **`employees.tsx` Employee Detail tab** is guard-unmounted (`{activeTab === 'detail' && …}`, per CODEBASE-MAP) — not re-checked, and per the map it should stay that way.

**Not examined — stated so nobody assumes coverage**
- The *contents* of `/api/inventory`'s `wip_items` bucket (row count unknown), so D4/D12's waste is described structurally, not as a percentage.
- Backend handler cost of `/api/supplier-scorecards/:id`, `/api/grn/:id`, `/api/purchase-invoices/:id` — I audited what the pages ASK for, not what each handler does internally.
- DOM-node counts. `/employees` (BUG-2026-08-13-007) was a render-cost bug, and I could not reproduce that class of measurement without a browser. The un-windowed candidates on this surface — `invoices/detail.tsx:1161` (customer statement, unbounded in customer size), `suppliers/detail.tsx` `poLines` — are **plain `<table>` renders with no windowing**, and `DataGrid`'s `virtualize` prop is opt-in and off by default (`data-grid.tsx:261`, `:1629`). Whether either is big enough to matter is **UNMEASURED**; both are bounded by one customer's / one supplier's history, so I have not ranked them.

---

## Nothing was changed

This branch contains this document and nothing else. Per the brief, a fix needed to be
unambiguous, small and provably output-identical — and none of the above is:

- D1, D5, D7, D9, D12 change *which endpoint* is called and would need a
  before/after response fingerprint (the technique in PERF-BACKLOG) to prove equivalence.
- D2, D13 change *when* data loads, which is a visible behaviour change (a first click
  would then wait), and D2's default-open was an explicit owner call (`:415`).
- D3 is a fix in a shared primitive used by ~80 callers.
- D6's scoped endpoint filters on a **different key** than the page does.
- D9's `finishedGoods` rename would ADD rows to a picker.

Each is a small PR on its own, with its own proof.

## Suggested order of work

1. ~~**D3**~~ — **done, 2026-08-13** (BUG-2026-08-13-016). The `cancelled` flag did indeed
   separate the two abort causes. The sweep found **19** affected files, not eight: the
   two EDIT forms (`sales/edit`, `consignment/edit`) were a *third* eternal-`Loading…`
   pair the audit missed, because their `loading` flag is cleared inside the effect that
   only runs when the response arrives; `suppliers/detail`, `rd/detail`, `products/bom`,
   `products/documents`, `delivery-returns/detail`, the public `track` QR page and
   `document-chain-map`'s station strip were also in the class. The LIST half
   (~25 grids captioning an empty result over a failed fetch) is enumerated as C15 row 3
   and is still open.
2. **D1** — one page, one endpoint, biggest single payload (1.07 MB), and the `scope=`
   pattern to copy is three lines below it.
3. **D2** — one shared component, four pages, and the fix is a default flip plus honest
   comment.
4. **D4 + D12 together** — one class (`/api/inventory` for one bucket), seven pages, one
   decision to make about `/api/raw-materials`'s wider row shape.
5. Everything else.
