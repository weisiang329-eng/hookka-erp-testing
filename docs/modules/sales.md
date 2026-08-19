# Sales — Module Guide

> **Last verified: 2026-08-19** against `src/api/routes/sales-orders.ts` (**5,733** lines),
> `src/api/routes/sales-orders/_helpers.ts` (1,462), `src/api/routes/{consignment-orders,consignment-notes}.ts`,
> `src/api/lib/{sofa-combo,sofa-combo-pass}.ts`, `src/pages/sales/{index,create,detail}.tsx`,
> `src/pages/consignment/note.tsx`, `src/pages/maintenance/sofa-combos.tsx`, `tests/db-schema.json`.
> Corrected 2026-08-19 — **eight call-site offsets were stale and are re-derived**:
> `runSofaComboPass` is called at `:2133` (POST) and `:3679` (PUT), not `:2043`/`:3589`;
> `createProductionOrdersForSO` is called at `:2547`, not `:2457`; `copy-for-service-order`
> is `:5201`, not `:5094`; `ensurePendingMigrations` is `_helpers.ts:1283`,
> not `:1273`; `seatHeightOf` is `sofa-combo-pass.ts:64`, not `:46`; the snapshot
> invalidation config lines are `:374 / 452 / 522 / 574 / 601` (five, not four, and three of
> the four listed were wrong) and the rationale comment is `:5706`, not `:5599`;
> `SalesOrderDetailPage` is `:338`; CO confirm is `:1700` (was `:1578`) and CO edit `:1817`
> (was `:1695`). The three top-level handler anchors (SO create `:1593`, confirm `:2374`,
> edit `:2976`) and every `_helpers.ts` / `sofa-combo.ts` symbol re-verified **exact**.
> All 18 tables named in Data model exist in `tests/db-schema.json`.>
> ⚠️ **`sales-orders.ts` was being edited by another session WHILE this audit ran**, three
> times — 5,704 → 5,716 (19:10) → **5,733** (19:14, again 19:16:49). Every
> `sales-orders.ts` offset in this guide is re-derived against the **5,733-line** file and was
> re-asserted against the live source at the end of the pass. **If
> `wc -l src/api/routes/sales-orders.ts` does not say 5,733, treat every offset into that ONE
> file as suspect and re-derive** — the other anchors in this guide are in files that did not move.

> Self-navigating docs (L2). Repo-wide map: [[CODEBASE-MAP]]. Never grep the whole repo — use the file:line below.

## What it does
Owns the customer-facing order lifecycle: **Sales Orders** (SO) and their line items, plus the **consignment** track (Consignment Orders, and Consignment Notes = the consignment DO-equivalent). Confirming an SO fans out into production orders / job cards, and status transitions cascade downstream (production_orders, job_cards, fg_units, DOs, invoices) rather than being pure label changes. **Sofa-combo pricing** (renegotiating matched sofa sets down to a combo total) is applied on the backend on every SO create/edit. Service-repair SOs (`caseId`) ride the same tables but price 0 by default.

## Entry points
- Pages
  - `/sales` → `src/pages/sales/index.tsx:172` (`SalesPage` — SO list, dual-mode SO vs service-order)
  - `/sales/create` → `src/pages/sales/create.tsx:214` (`CreateSalesOrderPage`; OCR/scan-PO lands here)
  - `/sales/:id` → `src/pages/sales/detail.tsx:338` (`SalesOrderDetailPage`; linked POs/JCs/DOs/invoices)
  - `/sales/:id/edit` → `src/pages/sales/edit.tsx` (Edit SO; re-runs sofa-combo on save)
  - `/consignment` list/create/edit/detail/return → `src/pages/consignment/{index,create,edit,detail,return}.tsx`
  - `/consignment/note` → `src/pages/consignment/note.tsx:454` (`ConsignmentNotePage`; 3 inline tabs)
  - Sofa combo grid → `src/pages/maintenance/sofa-combos.tsx:370` (`SofaCombosPage`)
- API routes
  - SO **handlers** → `src/api/routes/sales-orders.ts` (5,733 lines); shared helpers in
    `src/api/routes/sales-orders/_helpers.ts` (1,462). Mounted `worker.ts:1195`.
  - Consignment Orders + `co_status_changes` → `src/api/routes/consignment-orders.ts` (2,998)
  - Consignment Notes (dispatch/delivered) → `src/api/routes/consignment-notes.ts` (2152)
  - Sofa combo rule CRUD → `src/api/routes/sofa-combos.ts`
  - Combo pricing engine → `src/api/lib/sofa-combo.ts` + wrapper `src/api/lib/sofa-combo-pass.ts`

## Data model
- `sales_orders` — SO header (status, parties, totals). `caseId` links a service-repair SO to a service_case.
- `sales_order_items` — SO line items (productCode, sizeCode, pricing in integer sen).
- `so_status_changes` — status-transition audit; `autoActions` is a JSON blob describing the cascade fired.
- `sales_orders_list_snapshot` — cache-aside precomputed list rows (filtered fetches bypass it).
- `sales_orders_archive` / `sales_order_items_archive` — soft-delete/archive copies.
- `consignment_orders` / `consignment_order_items` / `co_status_changes` — consignment mirror of the SO trio.
- `consignment_notes` / `consignment_items` — CN = consignment DO-equivalent (dispatch → delivered).
- `sofa_combo_rules` — per-baseModel combo definitions (component sizes + tiered combo price + effectiveFrom).
- Cascade targets: `production_orders`, `job_cards`, `fg_units`, `delivery_orders`, `invoices` (+ `cost_ledger`, `price_overrides`).
- Relationships: confirming an SO writes `so_status_changes` and inserts one `production_orders` row per SO item; production locks (COMPLETED job_cards / non-PENDING fg_units / cost_ledger refs) are inviolate.

## Core flows
1. **Create SO** — `app.post("/")` `sales-orders.ts:1593`. Validates/normalizes items → item-catalog-snap enrich (import at `:42`) → sofa-combo repricing via `runSofaComboPass` at `:2133` (guarded by `if (!isServiceOrder)` at `:2132`) → insert SO + items (`:2223`) → invalidate list snapshot.
2. **Confirm / status cascade (DRAFT/PENDING → IN_PRODUCTION)** — `app.post("/:id/confirm")` `sales-orders.ts:2374`. Idempotent; flips status, writes `so_status_changes` (autoActions JSON), and calls `createProductionOrdersForSO` (`_helpers.ts:576`, called at `sales-orders.ts:2547`; a second call site for the PUT path sits at `:3994`) to insert one PO per item. Further transitions cascade via `cascadeSOStatusToPOs` (`_helpers.ts:773`).
3. **Sofa-combo pricing** — `runSofaComboPass` `sofa-combo-pass.ts:132` (resolves base prices via `resolveLineBasePriceSen` `:76`, `seatHeightOf` `:64`) → calls `applySofaCombos` `sofa-combo.ts:209` which subset-matches lines (`findComboSubset` `:98`, module-private) and returns `newBaseByKey` + total discount; per-unit split via `distributeComboUnitPrices` (`:165`). Called from SO POST (`sales-orders.ts:2133`) and PUT (`:3679`) — those are the ONLY two call sites.
4. **Edit SO** — `app.put("/:id")` `sales-orders.ts:2976`. Re-resolves items, re-runs `runSofaComboPass` at `:3679` (old full-price combo SOs re-price down here), re-cascades status/locks.
5. **Copy-from-source (draft picker)** — `CopyFromSourceModal` `create.tsx:2395` (2-step) + backend `app.post("/copy-for-service-order")` `sales-orders.ts:5201`.

## Key functions / sections (locate-to-function)
| Symbol / section | file:line | Role |
|---|---|---|
| `SalesPage` | `src/pages/sales/index.tsx:172` | SO list main; service-order-mode flag, filters, tabs |
| `aggregateServiceOrderProgress` | `src/pages/sales/index.tsx:75` | Rolls linked-PO progress into a service-order stage |
| `soStageLabel` | `src/pages/sales/index.tsx:142` | Maps SO status → display stage label |
| `CreateSalesOrderPageWrapper` | `src/pages/sales/create.tsx:206` | Default export; providers shell |
| `CreateSalesOrderPage` | `src/pages/sales/create.tsx:214` | Main create form (parties, items, totals) |
| `CopyFromSourceModal` | `src/pages/sales/create.tsx:2395` | 2-step copy-draft picker |
| `LineItemCard` | `src/pages/sales/create.tsx:3021` | Per-line item editor |
| `SalesOrderDetailPage` | `src/pages/sales/detail.tsx:338` | SO detail; linked POs/JCs/DOs/invoices |
| `app.post("/")` (create) | `src/api/routes/sales-orders.ts:1593` | SO create + combo pass + snapshot invalidation |
| `app.put("/:id")` (edit) | `src/api/routes/sales-orders.ts:2976` | SO edit + re-run combo pass |
| `app.post("/:id/confirm")` | `src/api/routes/sales-orders.ts:2374` | DRAFT/PENDING → IN_PRODUCTION, cascade to POs |
| `createProductionOrdersForSO` | `sales-orders/_helpers.ts:576` | One production_orders row per SO item |
| `cascadeSOStatusToPOs` | `sales-orders/_helpers.ts:773` | Propagate SO status change to POs/JCs |
| `rowToSO` / `rowToSOList` | `sales-orders/_helpers.ts:243 / 307` | Row → API shape (dual-keyed) |
| `ensurePendingMigrations` | `sales-orders/_helpers.ts:1283` | Runtime column self-apply |
| `runSofaComboPass` | `src/api/lib/sofa-combo-pass.ts:132` | Wrapper: resolve prices → applySofaCombos → write back |
| `resolveLineBasePriceSen` | `src/api/lib/sofa-combo-pass.ts:76` | Resolve a line's base price (sen) |
| `applySofaCombos` | `src/api/lib/sofa-combo.ts:209` | Pure combo matcher/renegotiator |
| `findComboSubset` | `src/api/lib/sofa-combo.ts:98` | Subset-match lines against a combo rule (module-private) |
| `app.post("/")` (CO create) | `src/api/routes/consignment-orders.ts:653` | Consignment Order create |
| `app.get("/status-changes")` (CO) | `src/api/routes/consignment-orders.ts:1133` | co_status_changes read |
| `ConsignmentNotePage` | `src/pages/consignment/note.tsx:454` | CN workspace, all 3 tabs inline |

## Gotchas
- **Combo pricing is backend-unified.** Never re-implement it in the frontend. Note the map's `applySofaCombos`-in-sales-orders wiring is now **indirect**: sales-orders imports `runSofaComboPass` (`sofa-combo-pass.ts`, moved 2026-06-11), which calls `applySofaCombos`. Piece code = productCode (stored sizeCode is the SEAT size); a null tier disqualifies the group; `discount <= 0` is an idempotent no-op. Old full-price combo SOs re-price down on next edit.
- **Status changes are cascades, not labels.** `so_status_changes` / `co_status_changes` carry an `autoActions` JSON blob and drive fan-out to production_orders / job_cards / fg_units / DO / invoices.
- **item-catalog-snap OCR back-door.** SO POST enriches via `_shared/item-catalog-snap` (import at `sales-orders.ts:42`); SO PUT + CO POST/PUT are historically less covered — a scan/OCR path can inject un-snapped items.
- **Snapshot is cache-aside.** `sales_orders_list_snapshot` is only used for unfiltered list fetches; any filtered fetch bypasses the cache. Five `withSnapshot(...)` configs name it — `sales-orders.ts:374 / 452 / 522 / 574 / 601` — each keyed on a different `cache_key` over the same table; the invalidation rationale comment is at `:5706`.
- **Service orders price 0.** `sales_orders.caseId` marks a service-repair SO; auto-pricing is skipped by design — do not reintroduce it for service orders.
- **Consignment Notes never carry invoices.** Owner ruling: CN = DO-equivalent; 3PL stays DO-side; amount on CN/CO lists is derived from CO value, not stored. Dispatch/delivered emails are idempotent via folded-lowercase `dispatchemailat` / `deliveredemailat`.
- **Production locks are inviolate.** COMPLETED job_cards / non-PENDING fg_units / cost_ledger references must not be overridden for cosmetic edits.
- **camelCase columns need a rename-map entry** (`column-rename-map.json`) or they 400 "Invalid request body"; read folded-lowercase cols dual-keyed (`r.camelCase ?? r.snake_case`). Prefer snake_case for new columns.

## Common tasks (mini-playbook)
- **Add a field to the SO** → column self-apply in `ensurePendingMigrations` (`sales-orders/_helpers.ts:1283`); persist in `app.post("/")` (`sales-orders.ts:1593`) and `app.put("/:id")` (`:2976`); surface in `rowToSO` (`_helpers.ts:243`) / `rowToSOList` (`:307`); render in `create.tsx:214` and `detail.tsx:338`. New column = snake_case (+ rename-map if camelCase).
- **Change the status cascade** → edit `cascadeSOStatusToPOs` (`sales-orders/_helpers.ts:773`) and the confirm handler (`sales-orders.ts:2374`); keep the `so_status_changes` autoActions JSON write in sync.
- **Adjust sofa-combo pricing** → change the engine in `applySofaCombos` (`sofa-combo.ts:209`) / `findComboSubset` (`:98`); never touch the frontend. Rule data via `sofa-combos.ts` + grid `maintenance/sofa-combos.tsx:370`. Verify with `tests/sofa-combo.test.mjs`.
- **Touch consignment flow** → CO in `consignment-orders.ts` (create `:653`, confirm `:1700`, edit `:1817`, cancel `:2487`, hub `:2630`); CN dispatch/delivered in `consignment-notes.ts`.

## Related modules
[[procurement]] [[delivery]] [[production]] [[accounting]]
