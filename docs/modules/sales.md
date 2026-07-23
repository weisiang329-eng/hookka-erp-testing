# Sales — Module Guide

> Self-navigating docs (L2). Repo-wide map: [[CODEBASE-MAP]]. Never grep the whole repo — use the file:line below.

## What it does
Owns the customer-facing order lifecycle: **Sales Orders** (SO) and their line items, plus the **consignment** track (Consignment Orders, and Consignment Notes = the consignment DO-equivalent). Confirming an SO fans out into production orders / job cards, and status transitions cascade downstream (production_orders, job_cards, fg_units, DOs, invoices) rather than being pure label changes. **Sofa-combo pricing** (renegotiating matched sofa sets down to a combo total) is applied on the backend on every SO create/edit. Service-repair SOs (`caseId`) ride the same tables but price 0 by default.

## Entry points
- Pages
  - `/sales` → `src/pages/sales/index.tsx:168` (`SalesPage` — SO list, dual-mode SO vs service-order)
  - `/sales/create` → `src/pages/sales/create.tsx:221` (`CreateSalesOrderPage`; OCR/scan-PO lands here)
  - `/sales/:id` → `src/pages/sales/detail.tsx:337` (`SalesOrderDetailPage`; linked POs/JCs/DOs/invoices)
  - `/sales/:id/edit` → `src/pages/sales/edit.tsx` (Edit SO; re-runs sofa-combo on save)
  - `/consignment` list/create/edit/detail → `src/pages/consignment/{index,create,edit,detail}.tsx`
  - `/consignment/note` → `src/pages/consignment/note.tsx:505` (`ConsignmentNotePage`; 3 inline tabs)
  - Sofa combo grid → `src/pages/maintenance/sofa-combos.tsx:370` (`SofaCombosPage`)
- API routes
  - SO CRUD + cascades + snapshot → `src/api/routes/sales-orders.ts` (5880 lines)
  - Consignment Orders + `co_status_changes` → `src/api/routes/consignment-orders.ts` (2550)
  - Consignment Notes (dispatch/delivered) → `src/api/routes/consignment-notes.ts` (2033)
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
1. **Create SO** — `app.post("/")` `sales-orders.ts:1995`. Validates/normalizes items → item-catalog-snap enrich (import at `:38`) → sofa-combo repricing via `runSofaComboPass` at `:2449` → insert SO + items → invalidate list snapshot.
2. **Confirm / status cascade (DRAFT/PENDING → IN_PRODUCTION)** — `app.post("/:id/confirm")` `sales-orders.ts:2653`. Idempotent; flips status, writes `so_status_changes` (autoActions JSON), and calls `createProductionOrdersForSO` (`:549`) to insert one PO per item. Further transitions cascade via `cascadeSOStatusToPOs` (`:696`).
3. **Sofa-combo pricing** — `runSofaComboPass` `sofa-combo-pass.ts:114` (resolves base prices via `resolveLineBasePriceSen` `:58`, `seatHeightOf` `:46`) → calls `applySofaCombos` `sofa-combo.ts:121` which subset-matches lines (`findComboSubset` `:88`) and returns `newBaseByKey` + total discount. Called from SO POST (`:2449`) and PUT (`:3974`).
4. **Edit SO** — `app.put("/:id")` `sales-orders.ts:3303`. Re-resolves items, re-runs `runSofaComboPass` at `:3974` (old full-price combo SOs re-price down here), re-cascades status/locks.
5. **Copy-from-source (draft picker)** — `CopyFromSourceModal` `create.tsx:2391` (2-step) + backend `app.post("/copy-for-service-order")` `sales-orders.ts:5349`.

## Key functions / sections (locate-to-function)
| Symbol / section | file:line | Role |
|---|---|---|
| `SalesPage` | `src/pages/sales/index.tsx:168` | SO list main; service-order-mode flag, filters, tabs |
| `aggregateServiceOrderProgress` | `src/pages/sales/index.tsx:71` | Rolls linked-PO progress into a service-order stage |
| `soStageLabel` | `src/pages/sales/index.tsx:138` | Maps SO status → display stage label |
| `CreateSalesOrderPageWrapper` | `src/pages/sales/create.tsx:213` | Default export; providers shell |
| `CreateSalesOrderPage` | `src/pages/sales/create.tsx:221` | Main create form (parties, items, totals) |
| `CopyFromSourceModal` | `src/pages/sales/create.tsx:2391` | 2-step copy-draft picker |
| `LineItemCard` | `src/pages/sales/create.tsx:3017` | Per-line item editor |
| `SalesOrderDetailPage` | `src/pages/sales/detail.tsx:337` | SO detail; linked POs/JCs/DOs/invoices |
| `app.post("/")` (create) | `src/api/routes/sales-orders.ts:1995` | SO create + combo pass + snapshot invalidation |
| `app.put("/:id")` (edit) | `src/api/routes/sales-orders.ts:3303` | SO edit + re-run combo pass |
| `app.post("/:id/confirm")` | `src/api/routes/sales-orders.ts:2653` | DRAFT/PENDING → IN_PRODUCTION, cascade to POs |
| `createProductionOrdersForSO` | `src/api/routes/sales-orders.ts:549` | One production_orders row per SO item |
| `cascadeSOStatusToPOs` | `src/api/routes/sales-orders.ts:696` | Propagate SO status change to POs/JCs |
| `runSofaComboPass` | `src/api/lib/sofa-combo-pass.ts:114` | Wrapper: resolve prices → applySofaCombos → write back |
| `resolveLineBasePriceSen` | `src/api/lib/sofa-combo-pass.ts:58` | Resolve a line's base price (sen) |
| `applySofaCombos` | `src/api/lib/sofa-combo.ts:121` | Pure combo matcher/renegotiator |
| `findComboSubset` | `src/api/lib/sofa-combo.ts:88` | Subset-match lines against a combo rule |
| `app.post("/")` (CO create) | `src/api/routes/consignment-orders.ts:532` | Consignment Order create |
| `app.get("/status-changes")` (CO) | `src/api/routes/consignment-orders.ts:889` | co_status_changes read |
| `ConsignmentNotePage` | `src/pages/consignment/note.tsx:505` | CN workspace, all 3 tabs inline |

## Gotchas
- **Combo pricing is backend-unified.** Never re-implement it in the frontend. Note the map's `applySofaCombos`-in-sales-orders wiring is now **indirect**: sales-orders imports `runSofaComboPass` (`sofa-combo-pass.ts`, moved 2026-06-11), which calls `applySofaCombos`. Piece code = productCode (stored sizeCode is the SEAT size); a null tier disqualifies the group; `discount <= 0` is an idempotent no-op. Old full-price combo SOs re-price down on next edit.
- **Status changes are cascades, not labels.** `so_status_changes` / `co_status_changes` carry an `autoActions` JSON blob and drive fan-out to production_orders / job_cards / fg_units / DO / invoices.
- **item-catalog-snap OCR back-door.** SO POST enriches via `item-catalog-snap` (import at `sales-orders.ts:38`); SO PUT + CO POST/PUT are historically less covered — a scan/OCR path can inject un-snapped items.
- **Snapshot is cache-aside.** `sales_orders_list_snapshot` is only used for unfiltered list fetches; any filtered fetch bypasses the cache. It's invalidated on write (see tail of the file ~`:5853`).
- **Service orders price 0.** `sales_orders.caseId` marks a service-repair SO; auto-pricing is skipped by design — do not reintroduce it for service orders.
- **Consignment Notes never carry invoices.** Owner ruling: CN = DO-equivalent; 3PL stays DO-side; amount on CN/CO lists is derived from CO value, not stored. Dispatch/delivered emails are idempotent via folded-lowercase `dispatchemailat` / `deliveredemailat`.
- **Production locks are inviolate.** COMPLETED job_cards / non-PENDING fg_units / cost_ledger references must not be overridden for cosmetic edits.
- **camelCase columns need a rename-map entry** (`column-rename-map.json`) or they 400 "Invalid request body"; read folded-lowercase cols dual-keyed (`r.camelCase ?? r.snake_case`). Prefer snake_case for new columns.

## Common tasks (mini-playbook)
- **Add a field to the SO** → column self-apply near `ensurePendingMigrations` (`sales-orders.ts:1910`); persist in `app.post("/")` (`:1995`) and `app.put("/:id")` (`:3303`); surface in `rowToSO` (`:295`) / `rowToSOList` (`:353`); render in `create.tsx:221` and `detail.tsx:337`. New column = snake_case (+ rename-map if camelCase).
- **Change the status cascade** → edit `cascadeSOStatusToPOs` (`sales-orders.ts:696`) and the confirm handler (`:2653`); keep the `so_status_changes` autoActions JSON write in sync.
- **Adjust sofa-combo pricing** → change the engine in `applySofaCombos` (`sofa-combo.ts:121`) / `findComboSubset` (`:88`); never touch the frontend. Rule data via `sofa-combos.ts` + grid `maintenance/sofa-combos.tsx:370`. Verify with `tests/sofa-combo.test.mjs`.
- **Touch consignment flow** → CO in `consignment-orders.ts` (create `:532`, confirm `:1345`, edit `:1460`); CN dispatch/delivered in `consignment-notes.ts`.

## Related modules
[[procurement]] [[delivery]] [[production]] [[accounting]]
