# Hookka ERP — Codebase Map (the single authoritative map)

> **Restamped 2026-08-14 on branch `fix/dashboard-tiles`:** Planning gains the MRP
> `onOrder` / MOQ / lead-time rows (BUG-2026-08-13-150 / -145) and Production/BOM gains the
> `/production` Overview and `/production/wip-times` observability rows (-146 / -147),
> including the new `coverage.productsWithoutActiveBom` on `GET /api/wip-times`.

> **Last verified: 2026-08-14 on branch `docs/docs-vs-code-audit`** — a PROSE audit (the
> machine gate `check-codebase-map.mjs` only validates `path`, `file:LINE` and symbol anchors;
> it is blind to sentences and to `L1-7606`-style ranges written in prose). Four fixes:
> the Sales table and its "Start here" both still called `sales-orders.ts` **5318 lines** —
> the exact figure this file's own header calls stale, and it is now 5,704; the Planning entry
> pointed a reader at `production-orders.ts` **L1-7606** when that file is 3,944 lines, so the
> range ran ~3,600 lines past EOF; the three "Actually" line counts in the header table had
> drifted 1–3%; and the intro named this file as both its own former name and a retired
> duplicate of itself. See `docs/DOCS-VS-CODE-AUDIT.md` rows D8–D11.
>
> **Restamped 2026-08-14 on branch `fix/efficiency-fabrication`:** the Reports/Employees
> section gains the `attendance_records` warning — that table carries no production or
> efficiency data and never has (BUG-2026-08-13-103).
>
> **Last verified: 2026-08-14** — re-checked mechanically by `node scripts/check-codebase-map.mjs`,
> which validates that every cited path resolves, every `file:LINE` is in range, and every symbol
> named beside a line ref is really defined near it. Exit 0 on this revision. Coverage gap is now
> 13 modules (the `src/pages/m/` mobile subsystem + 3 production components), down from 44
> mechanically against the tree; 434 exist.
> **Restamped 2026-08-14 on branch `fix/security-posture`:** security findings S1, S4 and
> S5 are now FIXED (BUG-2026-08-13-100 / -102 / -101) and their entries rewritten in place,
> along with the `organisations.ts`, `auth-totp.ts` and `customer-crm.ts` route tables and
> the three module index rows. S2, S3 and the singleton `active_org_id` stay open and say so.
> Re-checked 2026-08-13 (BUG-2026-08-13-071): both `src/pages/consignment/return.tsx`
> rows re-read against the file — the page is now a read-only list of recorded
> returns (783 lines), not a "return flow"; returns are recorded from
> `consignment/note.tsx` via `POST /api/consignment-notes/:id/return`.
> **Restamped 2026-08-14 on branch `fix/money-input-parsing` (BUG-2026-08-13-095):** the two
> DUPLICATE `src/pages/accounting/index.tsx` rows — which disagreed with each other AND with the
> file (10627 / 11140 lines vs the real 11230) — collapsed into one accurate row, and the
> money-ENTRY rule added to the Accounting and Procurement gotchas. **The big-file section index
> for that page is NOT re-derived here**: it was already carrying its own warning that "line
> numbers predate the file's growth — anchor by function name", and this change adds ~90 lines
> spread through it, so anchor by function name, not by the ranges below. Nothing else in this
> file was re-checked on that branch.
> **Restamped 2026-08-13 on branch `fix/stock-grn-org-filter`:** the Accounting
> multi-company bullet (its description of the company selector was the bug —
> BUG-2026-08-13-051) and a new bullet on `MinimalPOOut`'s now-pinned key set
> (BUG-2026-08-13-050). Nothing else in this file was re-checked on that branch.
> Corrected 2026-08-13: `src/pages/procurement/pricing.tsx` was deleted in commit
> `b3b42b6c` (Supplier Pricing merged into `procurement/maintenance.tsx`; the old route
> is now a redirect) — both the table row and the "PENDING merge" gotcha said otherwise.
> The one remaining dead link, `docs/context-packs/NAVIGATION-MAP.md`, is a deliberate
> historical reference to this file's former name.
>
> **Also corrected 2026-08-13: 46 stale file line-counts** (drift up to +189%), re-derived
> with `wc -l`. Two of them were not drift but a **file split nothing in the docs mentioned**,
> and it is the single biggest source of wrong line anchors in this repo's docs:
>
> | Handler file | Was documented as | Actually (`wc -l`, 2026-08-14) | Its helpers now live in |
> |---|---|---|---|
> | `src/api/routes/delivery-orders.ts` | 6,189 lines | **3,095** | `src/api/routes/delivery-orders/_helpers.ts` (5,313) |
> | `src/api/routes/production-orders.ts` | 7,606 lines | **3,944** | `src/api/routes/production-orders/_helpers.ts` (5,882) |
> | `src/api/routes/sales-orders.ts` | 5,318 lines | **5,704** | `src/api/routes/sales-orders/_helpers.ts` (1,462) |
>
> Every anchor above the real length pointed **past end-of-file**; the rest landed on
> unrelated code. If a function you expect is not in the handler file, look in its sibling
> `_helpers.ts` before concluding it was deleted.
>
> **Re-verified 2026-08-13 (chore/dead-code-sweep)** against a full import graph over
> `src/` + `tests/` + `scripts/` rooted at `src/main.tsx` and `src/api/worker.ts`. Three
> rows in this map named files that no path could reach and are struck through below:
> `src/pages/procurement/in-transit.tsx`, `src/pages/planning/dept/_PlainDeptSchedulePage.tsx`,
> and `src/lib/material-lookup.ts` (cited in the RM-routing gotcha). All other cited paths
> still exist.

**This is THE code map — read it before touching any module; there is no other.** Look up the
module here and go straight to the listed files and line ranges. `Grep`/`Glob` over the whole
repo **time out** (large tree + many worktrees), so use the file:line entries below with
`Read offset/limit` instead of searching.
Retired duplicate now pointing here: the code-location role of
`docs/archive/MODULES.md` (MODULES stays as the higher-level *product* reference).
*(Until 2026-08-14 these two lines read "Formerly `docs/CODEBASE-MAP.md`. Retired duplicates
now pointing here: `docs/CODEBASE-MAP.md`" — a rename left the file naming ITSELF as both its
former name and a retired duplicate of itself.)*

## 📖 Per-module deep guides — open these FIRST

Every module has a verified, kept-fresh guide (function→line, core flows, gotchas, common tasks).
**The detailed section-indexes further down this file drift as files grow — the guides are the
authoritative current detail.** New here? Start with [ONBOARDING-PATH.md](ONBOARDING-PATH.md).

| Module | Guide | | Module | Guide |
|---|---|---|---|---|
| Sales | [modules/sales.md](modules/sales.md) | | Planning | [modules/planning.md](modules/planning.md) |
| Procurement | [modules/procurement.md](modules/procurement.md) | | Dashboard | [modules/dashboard.md](modules/dashboard.md) |
| Delivery & Consignment | [modules/delivery.md](modules/delivery.md) | | Service & Repair | [modules/service-repair.md](modules/service-repair.md) |
| Accounting & Invoicing | [modules/accounting.md](modules/accounting.md) | | Reports & Analytics | [modules/reports.md](modules/reports.md) |
| Production & BOM | [modules/production.md](modules/production.md) | | R&D | [modules/rnd.md](modules/rnd.md) |
| Inventory | [modules/inventory.md](modules/inventory.md) | | Quality/Warehouse/Platform | [modules/quality-warehouse.md](modules/quality-warehouse.md) |
| Products & MDM | [modules/products.md](modules/products.md) | | Employees & Payroll | [modules/employees.md](modules/employees.md) |
| Customers & Platform | [modules/customers.md](modules/customers.md) | | | |

> **Keeping it fresh (update-on-touch):** file sizes / line numbers below drift as files grow.
> When you edit a module, refresh its `docs/modules/*.md` guide (the authoritative detail) as a
> byproduct. Section *names* stay stable, so grep the named function/section near the listed line
> if the number is off.

---

## Sales (Sales Orders + Consignment Orders/Notes + Sofa Combos)

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/sales/index.tsx` — SO list (2181), dual-mode SO vs service-order | `src/api/routes/sales-orders.ts` — 5,704 lines (+ `sales-orders/_helpers.ts`, 1,462); SO CRUD + status cascades + snapshot | `sales_orders` / `sales_order_items` / `so_status_changes` | `tests/sofa-combo.test.mjs` |
| `src/pages/sales/create.tsx` — Create SO (3710); OCR/scan-PO lands here | `src/api/routes/consignment-orders.ts` — CO CRUD + co_status_changes (2815) | `consignment_orders` / `consignment_order_items` / `co_status_changes` | `tests/so-category.test.mjs` |
| `src/pages/sales/detail.tsx` — SO detail (1637); linked POs/JCs/DOs/invoices | `src/api/routes/consignment-notes.ts` — CN (DO-equiv) dispatch/delivered (2152) | `consignment_notes` / `consignment_items` | |
| `src/pages/sales/edit.tsx` — Edit SO (1634); re-runs sofa-combo on save; unit price + build-up via `@/lib/pricing` | `src/api/routes/consignments.ts` — legacy/shared reads (536) | `sofa_combo_rules` / `customer_products` / `price_overrides` | |
| `src/pages/consignment/index.tsx` — CO list (1197) | `src/api/routes/sofa-combos.ts` — sofa_combo_rules CRUD (650) | `cost_ledger` / `production_orders` / `job_cards` / `fg_units` | |
| `src/pages/consignment/create.tsx` — Create CO (1782) | `src/api/routes/historical-sales.ts` — read-only history (128) | `delivery_orders` / `delivery_order_items` / `invoices` / `invoice_items` | |
| `src/pages/consignment/edit.tsx` — Edit CO (1142); unit price + build-up via `@/lib/pricing` | | `sales_orders_archive` / `sales_order_items_archive` / `sales_orders_list_snapshot` | |
| `src/pages/consignment/detail.tsx` — CO detail (1568); DO-parity P2 | | | |
| `src/pages/consignment/note.tsx` — CN workspace (5219); 3 tabs | | | |
| `src/pages/consignment/return.tsx` — Consignment Return, READ-ONLY (783); rows = CN lines with `status='RETURNED'` (BUG-2026-08-13-071 de-fabrication) | | | `tests/no-fabricated-consignment-returns.test.mjs` |
| `src/pages/maintenance/sofa-combos.tsx` — Sofa Combo grid (1852) | | | |
| `src/pages/maintenance/SofaComboHistoryDialog.tsx` — history dialog (438) | | | |

**Big-file section index**
- `src/pages/sales/create.tsx`
  - CreateSalesOrderPageWrapper (default export, providers) — L212-219
  - CreateSalesOrderPage (main form — parties, items, totals) — L220-2342
  - CopyFromSourceModal (2-step copy-draft picker) — L2343-2967
  - LineItemCard (per-line item editor) — L2968-3710
- `src/pages/sales/index.tsx`
  - aggregateServiceOrderProgress / soStageLabel helpers — L70-166
  - SalesPage main (service-order mode flag, filters, tabs) — L167-885
  - Per-status action-button logic (DRAFT..DELIVERED) — L613-700
  - Date-preset logic (this-month/last-month) — L886-1705
- `src/pages/consignment/note.tsx`
  - cnStatusFromBackend (status mapper) — L227-291
  - displayCoId / mapCNToRow (row helpers) — L344-504
  - ConsignmentNotePage (main component) — L505-5219
  - Tab bar + Planning tab (activeTab==='planning') — L3273-3318
  - Pending CN tab (activeTab==='pending_cn') — L3319-3468
  - Packing List tab (activeTab==='packing_list') — L3469-5219
- `src/pages/maintenance/sofa-combos.tsx`
  - Render/format helpers (renderComponentSizes, fabricTierBadge, statusBadge, fmtPriceCell) — L73-337
  - Grouping helpers (groupByBaseModel, comboGroupKey, groupByCombo, toComboRow) — L156-369
  - SofaCombosPage (main grid) — L370-918
  - BatchEditDialog (%/set-all, append-only rows) — L919-1173
  - CreateComboDialog — L1174-1754
  - CopyMasterCombosButton (copy-to-company) — L1755-1852

**Gotchas**
- Sofa combo pricing is BACKEND-unified: sales-orders.ts imports `runSofaComboPass` (`src/api/lib/sofa-combo-pass.ts:132`), called at POST (~L2449) and PUT (~L3974); that wrapper calls `applySofaCombos` (`src/api/lib/sofa-combo.ts:209`). Do NOT grep `sales-orders.ts` for `applySofaCombos` — it's indirect now (moved 2026-06-11). Never re-implement combo pricing in the frontend. Piece code = productCode (stored sizeCode is the SEAT size); tier null disqualifies; discount<=0 is idempotent no-op. Old full-price combo SOs re-price down on next edit.
- `so_status_changes` / `co_status_changes` store an autoActions JSON blob and drive cascades to production_orders/job_cards/fg_units/DO/invoices — status transitions are not just label changes.
- sales-orders.ts uses item-catalog-snap on POST (OCR/scan-PO back-door risk; SO PUT + CO POST/PUT historically less covered). `sales_orders_list_snapshot` is cache-aside (filtered fetches bypass cache).
- CN is the consignment DO-equivalent. Owner rulings: a CN CAN be converted to a DRAFT invoice — `POST /api/consignment-notes/:id/convert-to-invoice` (`src/api/routes/consignment-notes.ts:1334`) is an OFFICIAL flow (owner re-confirmed 2026-08-01); the link is `consignment_notes.converted_invoice_id`, a real indexed FK to `invoices(id)` (mig 0070), idempotent — one invoice per CN, a second call 409s with the existing id. This REPLACES the older no-CN-invoices ruling that sat here until 2026-08-01 — that line was stale, don't re-assert it. 3PL stays DO-side. Amount on CN/CO list derives from CO value, not a stored field. Dispatch/delivered emails idempotent via folded-lowercase dispatchemailat/deliveredemailat.
- consignment/note.tsx renders all 3 tabs inline in one component from L505 — no separate tab components; packing_list block is the bulk (L3469-5219).
- **The consignment surface spans THREE routers over TWO table pairs, and a change to one usually belongs in all three**: `consignment-orders.ts` (CO), `consignment-notes.ts` (CN), and the legacy `consignments.ts`, which reads the SAME `consignment_notes` / `consignment_items` as the CN router and is easy to miss. Every list, aggregate and entry-point by-id read on all three is now **org-scoped via `withOrgScope` / `AND orgId = ?`** (2026-08-09, BUG-2026-08-09-001) — this is SEPARATE from `customerScopeSql`, which narrows within a tenant; both apply, orgId binds first. Downstream reads keyed off an already-gated id are transitively safe and say so in a comment — don't "fix" them again. Two things are deliberately NOT scoped and are commented in place: `nextCompanyCOId` (org-wide so two tenants can't mint the same CO number) and the post-create re-read (the INSERTs do **not** stamp orgId — the column takes its SQL `DEFAULT 'hookka'`, so the write side is still open; see `BUG-CLASSES.md` C12 row 7 before onboarding a second org). Pinned by `tests/consignment-tenant-scope.test.mjs`.
- `/status-changes` in `consignment-orders.ts` must keep a SHORT body: `tests/co-status-changes-table.test.mjs` pins its try/catch degradation inside a 1600-char window from `app.get(`. Put explanation in the doc block above the handler, not between its statements.
- camelCase DB columns in route SQL need a `column-rename-map.json` entry or they 400 'Invalid request body'; folded-lowercase cols read dual-keyed. Prefer snake_case for new columns.
- `sales_orders.caseid` links service-repair SOs onto a service_case; SVs price 0 by default (auto-pricing skipped) — don't reintroduce auto-pricing for service orders.
- Production locks: COMPLETED job_cards / non-PENDING fg_units / cost_ledger refs are inviolate — don't override for cosmetic edits.
- wipKey must use shared `deriveTopLevelWipKey` (one formula); component-level repair picks drop unowned material lines.
- Sofa seat-size dropdown options come from Maintenance `sofaSizes` config; a product with NO seatHeightPrices matrix KEEPS the picked seat with manual Base Price (RM0 allowed) — do NOT reintroduce the silent reset (BUG-2026-07-27-001, pinned by `tests/sofa-seat-no-tier.test.mjs`, same logic in all 4 line editors: sales+consignment create/edit). Products SKU-Master sofa price columns are DYNAMIC from the same Maintenance `sofaSizes` list (`buildBaseCols`/`sofaHeightsFromConfig` in `products/index.tsx`, numerically sorted, pinned by `tests/sofa-size-columns.test.mjs`) — adding a size in Maintenance creates its price column; don't hardcode height keys (h24…) anywhere.

- **Status tab strips (count + money per state)** are ONE component: `src/components/ui/status-tab-strip.tsx` + `src/lib/status-tab-strip.ts`. Feed it `tabTotals(rowsThisTabLists, valueOf)` so the badge and the RM figure can never describe different rows; a bucket that sums to nothing renders its count alone (never RM 0.00). Do not hand-roll a new one.

**Start here:** Open `src/api/routes/sales-orders.ts` (the 5,704-line backend owning SO CRUD, status cascades, snapshot logic — its helpers live in the sibling `sales-orders/_helpers.ts`, 1,462 lines) first; pair with `src/pages/sales/create.tsx` for UI or `src/api/lib/sofa-combo.ts` for any pricing work.

---

## Procurement (PO / GRN / Goods-in-Transit / Purchase Invoice / Suppliers / Supplier Pricing / Three-Way-Match / Credit & Debit Notes / Supplier Payments)

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/procurement/index.tsx` — PO list + POFormDialog (2175) | `src/api/routes/purchase-orders.ts` — PO CRUD + status lifecycle | `purchase_orders` / `purchase_order_items` | `tests/grn-arrival-state.test.mjs` |
| `src/pages/procurement/detail.tsx` — PO detail + ThreeWayMatchPanel (1497) | `src/api/routes/grn.ts` — GRN CRUD + arrival + Post-to-Stock cascade | `grns` / `grn_items` | `tests/ocr-distill-supplier.test.mjs` |
| `src/pages/procurement/create.tsx` — full-page PO create | `src/api/routes/goods-in-transit.ts` — GIT CRUD | `goods_in_transit` | `tests/supplier-payment-alloc.test.mjs` |
| `src/pages/procurement/grn.tsx` — GRN list (1252) | `src/api/routes/purchase-invoices.ts` — PI CRUD + lifecycle | `purchase_invoices` / `purchase_invoice_items` | `tests/three-pl-state-rates.test.mjs` |
| `src/pages/procurement/grn/create.tsx` — GRN create (1490) | `src/api/routes/three-way-match.ts` — PO↔GRN↔PI variance | `suppliers` | |
| `src/pages/procurement/grn-detail.tsx` — GRN detail + Post-to-Stock (1332) | `src/api/routes/suppliers.ts` — supplier CRUD | `supplier_materials` / `supplier_material_bindings` | |
| ~~`src/pages/procurement/in-transit.tsx`~~ — **DELETED** (chore/dead-code-sweep): `/procurement/in-transit` has been a `<Navigate>` redirect to `/procurement/grn` (`src/dashboard-routes.tsx:378`) with no sidebar entry and no importer. The `goods_in_transit` API stays. | `src/api/routes/supplier-materials.ts` — bindings (autofill source) | `supplier_payments` | |
| `src/pages/procurement/pi.tsx` — PI list (906) | `src/api/routes/supplier-payments.ts` — payments + void + lifecycle | `price_histories` | |
| `src/pages/procurement/pi/create.tsx` — PI create (1144) | `src/api/routes/price-history.ts` — effective-date pricing | `credit_notes` / `debit_notes` | |
| `src/pages/procurement/PurchaseInvoiceDetail.tsx` — PI detail (editable DRAFT+APPROVED) | `src/api/routes/credit-notes.ts` / `debit-notes.ts` | `raw_materials` | |
| ~~`src/pages/procurement/pricing.tsx`~~ — **DELETED** (commit `b3b42b6c`); Supplier Pricing compare/history merged into `procurement/maintenance.tsx` ComparisonTab. `/procurement/pricing` is now a `<Navigate>` redirect to `/procurement/maintenance` (`src/dashboard-routes.tsx:385`) | `src/api/routes/supplier-scorecards.ts` — read-only metrics | | |
| `src/pages/procurement/maintenance.tsx` — bindings mgmt (1336) | `src/api/routes/scan-supplier.ts` — OCR extract (catalog-snap back-door) | | |
| `src/pages/procurement/sku-form-dialog.tsx` (410) / `supplier-form-dialog.tsx` (199) | | | |
| `src/pages/suppliers/detail.tsx` — supplier profile/scorecard/history (1082) | | | |

**Big-file section index**
- `src/pages/procurement/index.tsx`
  - Imports + types/constants — L1-56
  - POFormDialog (create/edit PO modal — supplier picker, line items, low-stock prefill) — L57-781
  - ALL_PO_STATUSES status-option constant — L782-792
  - ProcurementPage default export (PO list, filters, banner, grid) — L798-1870
- `src/pages/procurement/detail.tsx`
  - Imports + status-rank helper — L1-92
  - PurchaseOrderDetailPage default export (header, lines, 412-requiresGrn guard) — L93-1287
  - Status-transition action button block (SUBMITTED/CONFIRMED/PARTIAL_RECEIVED/RECEIVED) — L525-1287
  - ThreeWayMatchPanel (PO↔GRN↔PI variance) — L1331-1497
- `src/pages/procurement/grn/create.tsx`
  - GRN create full-page (manual default; "Convert from PO" line-pick, no mode toggle) — single component
  - Supplier field: read-only display (code + name from linked PO, looked up in `suppliers` list) when PO-linked; editable SearchableSelect in manual mode — both rendered at same grid position
  - Convert-from-PO line-pick modal: `src/components/convert-from-po-modal.tsx`
- `src/pages/procurement/pi/create.tsx`
  - PI create full-page ("Convert from Goods Receipt" line-pick; lines carry grnItemId)
  - Convert-to-PI line-pick modal (GRN + PO tabs): `src/components/convert-to-pi-modal.tsx`

**Gotchas**
- GRN Post-to-Stock is a cascade: DRAFT/CONFIRMED→POSTED boundary in grn.ts writes stock/WIP movements AND flips parent PO status to RECEIVED (all received) or PARTIAL_RECEIVED (any). Don't write stock outside this boundary; arrival gate guards CONFIRMED/POSTED transitions. COMMITTED_STATUSES = {CONFIRMED,POSTED}.
- **POSTED GRN lines are EDITABLE with a compensating cascade (owner 2026-06-22)**: grn-detail.tsx "Edit Quantities" → PUT items[] on a POSTED GRN corrects per-line acceptedQty; the backend (`buildPostedGRNStockAdjustment`) posts the DELTA via the SAME helpers postGRNToStock uses (resolveRmForGRNItem / makeLedgerEntry / genBatchId) — raw_materials.balanceQty += delta, the GRN batch's original/remaining += delta (clamped ≥0), one cost_ledger entry (RM_RECEIPT IN on +, ADJUSTMENT OUT on −); `cascadePOReceivedQtyDelta` moves the parent PO line's receivedQty + recomputes PO status. invoiced_qty is NOT touched (PI-owned); status stays POSTED (no un-post). Edit BLOCKED when newAccepted < invoiced_qty (a PI already billed it) or when lines are added/removed. Edit-then-revert is a true no-op. The shared rule + message live in `src/lib/purchase-edit-rules.ts` (`checkGrnLineQtyEdit`/`describeGrnStockDelta`/`isGrnLineEditable`) so FE+BE reject identically. Tests: `tests/purchase-edit-rules.test.mjs` + `tests/purchase-edit-cascade.test.mjs`. The line-restructure lock is unchanged (still 409); un-posting is now Cancel Receipt (below).
- **The downstream-PI lock is PER LINE, not per document (owner: "这种转换不是整张单锁死的")**: `isGrnLineLockedByPi` freezes ONLY the lines with `invoiced_qty > 0` (frozen in BOTH directions — an up-edit leaves the PI on a stale qty/price too); every other line on the same receipt stays correctable with the usual compensating movement. Enforced inside `checkGrnLineQtyEdit`, so FE + BE agree line by line. The only document-level 409 left is `isGrnFullyLockedByDownstreamPi` (EVERY line billed → nothing to correct). grn-detail.tsx marks each locked line with a Lock chip + "N of M lines locked" banner instead of refusing the whole document. Previously ANY invoiced line 409'd the entire GRN — bill one line of a ten-line receipt and the other nine were uncorrectable forever.
- **A POSTED GRN can be CANCELLED — `POST /api/grn/:id/cancel` (mig 0213, self-applied by `ensureGrnCancelSchema`: `grns.cancelled_at`/`cancelled_reason` + a status CHECK swap to admit CANCELLED)**. It reverses EXACTLY what `postGRNToStock` wrote, driven off the LOTS (`rm_batches WHERE source='GRN' AND sourceRefId=grnId`) not the lines, since an unresolved line never got a lot and a later qty edit moved originalQty in step: `balanceQty += −originalQty` per lot + DELETE the lot row. It then calls `restorePOReceivedQtyForGRN` (the SAME helper delete/un-post use — no third restore path) so the PO line becomes receivable again. **NO compensating cost_ledger leg, deliberately**: the FIFO/P&L engine sources GRN receipts from `grn_items JOIN grns … WHERE g.status IN ('CONFIRMED','POSTED')` (accounting.ts `loadMaterialCostData`) and reads cost_ledger only for RM_ISSUE/ADJUSTMENT, so CANCELLED removes the receipt from the replay by itself — an ADJUSTMENT OUT would reduce material cost TWICE. Two refusals, because a partial reversal is worse than none: a live PI still drawing on the lines (void the PI first — that path restores invoiced_qty), and any lot already CONSUMED (`remainingQty < originalQty` → the goods are issued/returned; use a purchase return or stock adjustment). CANCELLED is terminal (PUT 409s on edit or resurrect) but IS deletable. UI: "Cancel Receipt" on grn-detail.tsx header + the grn.tsx row menu, both confirming with the PO number and the quantities released. Tests: `tests/purchase-edit-cascade.test.mjs`.
- **PI editable in DRAFT *and* APPROVED (owner 2026-06-22)**, NOT PAID/CANCELLED. PurchaseInvoiceDetail.tsx Edit gate = `isPiEditable` (src/lib/purchase-edit-rules.ts). Backend PUT relaxes the old DRAFT-only 409 via `isPiEditable`; an items edit recomputes amountSen, re-syncs grn_items.invoiced_qty (restore-old + re-increment, floored by clampDecrement, CEILINGED by `checkInvoicedQtyCeilingAfterEdit` so it never exceeds acceptedQty), and on an APPROVED edit posts a GL CORRECTION for the amount delta against a fresh sourceId `${id}:edit-${ts}` (the ledger hash chain is append-only — never mutate existing legs). FE preserves grnItemId on draft lines + Confirm dialog before saving an APPROVED edit (it moves AP). lifecycle DRAFT→PENDING_APPROVAL→APPROVED→PAID via VALID_TRANSITIONS; PAID terminal; DELETE gated to DRAFT (row kept for audit).
- No-Draft on MANUAL create (owner 2026-06-21): PO create POSTs `status:"CONFIRMED"` (POST takes body.status verbatim, defaults DRAFT only when omitted); PI manual create → `PENDING_APPROVAL`, OCR/scan (`?scan=1` or in-form Scan) → DRAFT via an `ocrUsed` flag. **GRN create derives status from ARRIVAL (grn.ts POST, no longer hardcoded DRAFT): OCR/scan (`body.ocrUsed`) → DRAFT (review); local goods in hand (effective arrival ARRIVED) → POSTED and posts to stock at create time via the SAME `postGRNToStock` + `cascadePOStatusAfterGRNPost` the PUT uses; import in transit (arrival ≠ ARRIVED, e.g. PO-linked default NOT_ARRIVED) → DRAFT document slot tracked by the arrival pipeline, posts later when arrival reaches ARRIVED. POSTED is NEVER born before ARRIVED — the arrival gate is structurally honoured. FE create.tsx sends `ocrUsed`; button = "Receive & Post to Stock" for born-POSTED, hint reflects the mapping.** Status is independent of the convert-chain guard.
- Supplier reference numbers (mig 0183 / SQLite 0105, all snake_case, self-applied in ensureGrnMigrations + ensurePiMigrations): `grns.supplier_do_no`; `purchase_invoices.supplier_do_no` + `supplier_invoice_no`. FE "Supplier DO No." on GRN create+detail (detail = inline edit via main PUT); "Supplier Invoice No."+"Supplier DO No." on PI create+detail (detail edit DRAFT-only). Read dual-keyed.
- PO detail returns 412 with `requiresGrn` when a transition needs a GRN first (detail.tsx handles res.status===412 && data.requiresGrn) — receiving must go through GRN, not a direct PO status flip.
- Supplier line autofill reads `supplier_material_bindings`; per-line supplier+price come from bindings, NOT a separate catalog. PI standalone intentionally excludes catalog autofill.
- Supplier pricing is EFFECTIVE-DATED (2026-06-21, mig 0183): `supplier_material_bindings.effective_from` = the date the current price takes effect (replaces the old Valid From/Valid To window; SKU dialog now shows a single "Effective From", defaulting to today). The binding stays one-row-per-supplier+material (autofill consumers unchanged); a unit-price change UPDATEs the row's price+effective_from AND APPENDS an audit row to `price_histories` (which now also carries `effective_from`) — the trail is append-only, never overwritten. POST seeds an opening history row (oldPrice 0 = "first price"). `effective_from` is already in `column-rename-map.json`; legacy rows fall back to `price_valid_from`. The suppliers/detail.tsx "Price History" tab Price Change Log reads `/api/price-history` (Effective Date / Material / Old / New / Change% with ▲▼ / Changed By / Status; old = the previous effective row's price). Supplier Quotation PDF (`generate-supplier-quotation-pdf.ts`) now reuses the shared `drawLetterhead`/`drawSectionLabel`/`tableTheme`/`drawDocFooter` (mirrors customer quotation) with an "Effective From" column instead of "Valid To". Tests: `tests/supplier-effective-pricing.test.mjs`.
- Money stored in sen integers (amountSen, unit_cost_sen); use MoneyInput / roundSen, never float RM. Money **entered as text** is parsed only by `src/lib/money-field.ts` → `src/lib/parse-money.ts`; `parseFloat` on a money string truncates at the thousands separator (BUG-2026-08-13-095). FX RATES and QUANTITIES on these pages deliberately keep `parseFloat` — they are not money; `tests/money-input-parsing.test.mjs` holds the allow-list.
- Migrations INERT unless self-applied at runtime via `ensurePendingMigrations` (ALTER ADD COLUMN IF NOT EXISTS) — a new procurement column reaches prod only that way.
- camelCase write columns (receivedDate, receivedQty) need a `column-rename-map.json` entry or the route silently 400s; prefer snake_case. db-pg toCamel recovers true snake_case but not folded-lowercase camelCase.
- ThreeWayMatchPanel (detail.tsx 1331+) joins PO↔GRN↔PI and is also a standalone route (three-way-match.ts); variance is derived, don't persist a second copy.
- The POST matcher follows the receipt across POs. A GRN may span several orders, so the set to match comes from `grn_items.po_id` (dual-keyed read; `grns.poId` is the header fallback), every one of those orders' lines is loaded, and each receipt line is scored against **its own** order's line — by `po_item_id`, else by index on that order. Reading `poItems[poItemIndex]` off the header (as it did) scored a second-PO line against whatever sat at that index on the first order: invented mismatches, or accidental agreement. `poTotal` sums every order the receipt draws down rather than taking the header order's entire value — otherwise the variance compares one order's value against goods partly belonging to another and can land inside the 2% tolerance by coincidence, producing a FULL_MATCH nobody should trust. Identical behaviour for a single-PO receipt. `three_way_matches.po_ids` (JSON array, snake_case, runtime self-applied with a BOOLEAN memo) records the set; `poId` stays the header for existing readers and `poNumber` lists them all. Tests: `tests/three-way-match-multi-po.test.mjs`.
- OCR scan-supplier.ts is a catalog-snap back-door; SO/CO PUT paths historically unguarded — verify status-snap before trusting OCR-written prices.
- A GRN may span SEVERAL purchase orders — owner 2026-08-04: "正常都是 GR 会 generate from 好几张 PO 的". Each `grn_items` row carries `po_id` + `po_item_id` (runtime self-applied) naming the PO line it receives; `grns.poId` is now the header/display PO only. The legacy `po_item_index` is a POSITION into the header PO's line list and is kept ONLY as a fallback for rows written before this, so no backfill is needed — but it is also why the old model was fragile: a changed PO line order routed acceptedQty to the wrong line. `resolveGrnLineTargets` is the single place both the post cascade and its reversal resolve lines, and BOTH must then recompute status for every distinct PO touched (`recomputePoStatusFromReceipts`) — recomputing only the header PO leaves a second PO at CONFIRMED while its goods are in the building. Partial receipt across several GRNs still works because the draw-down is `+=` on the PO line. The create page posts it: "Convert from PO" becomes "Add another PO" once lines exist and APPENDS, each line sending its own `{poId, poItemId}`; rows display their PO number once several are involved. Two guards there — a second PO from a DIFFERENT supplier is refused (one GRN has one supplier), and re-picking a line already on the receipt is skipped so it cannot be double-counted. A line resolves its PO row by `poItemId` first, then by index on **its own** purchase order — `resolvePoItem`. The first cut read `poItems[poItemIndex]` off the HEADER PO and loaded only the header's lines, so a second-PO line took its material, ordered qty and price from whatever sat at that index on the first order, and the 110% over-receipt guard compared the delivery against a quantity from a PO it was not delivering (permissive direction: too much accepted, priced wrong, silent). The API also rejects an unknown PO id (404) and a PO belonging to a different supplier (400) — one GRN has one supplier. Tests: `tests/grn-multi-po.test.mjs`, `tests/grn-create-multi-po.test.mjs`. Purchase Invoices follow the same shape: `purchase_invoice_items.po_id` (self-applied) records the PO a LINE bills, with `purchase_invoices.purchaseOrderId` as the header. The over-invoicing guard groups requested lines BY PO and checks each against that PO's own ceiling — pooling them against the header would over-invoice one PO while wrongly rejecting a line that is in budget on its own. Already-invoiced is read as `COALESCE(pii.po_id, pi.purchaseOrderId)` so a multi-PO invoice still counts toward the right ceiling. A GRN-sourced PI line can also derive its PO through `grn_item_id → grn_items.po_id`. The PI create page posts it: "Convert from GR or PO" becomes "Add another PO" once lines exist and appends, each line sending its own `poId`. A GRN source never appends (it drives `invoiced_qty` draw-down and there can be only one); a second supplier is refused; re-picking a PO skips a (PO, material) already billed. Tests: `tests/pi-multi-po.test.mjs`, `tests/pi-create-multi-po.test.mjs`. The scan-supplier wizard still creates one PI per document with a single header PO — it now warns on a multi-PO document rather than half-linking it.
- A supplier document can name SEVERAL POs in one field — ADD WOOD prints `P/O No : 2607-003/2607-020`. `src/lib/po-ref-match.ts` splits on `/ , ; | &` / "and" and matches each reference alone. The old matcher normalised the whole string and tested `ref.endsWith(poNo)`, which is true for the LAST number — it silently half-linked. `resolvePoLink` returns every resolved id in `matchedPoIds`. **The scan wizard now files such a document as ONE receipt / ONE invoice** (owner 2026-08-04: "一定要来自首两张 PO 进一张 GR 的，这东西是串联的") — it previously refused to link either PO, which was correct while a card held one `purchaseOrderId` but is no longer, since `grn_items.po_id/po_item_id` and `purchase_invoice_items.po_id` record ownership per LINE. `src/lib/po-line-allocate.ts` decides which PO line each scanned line draws down: match by internal material code (supplier SKU only as a fallback), an OUTSTANDING order beats a fully-received one, two equally plausible candidates allocate NOTHING, and a PO line is consumed once. The header PO is derived from the allocation (`headerPoId`) and is display only. A two-PO invoice prices each line off its OWN order — one `applyPoPriceFill` against the header would price the second order's goods at the first order's rates. Both wizards count and report lines that could not be allocated. Tests: `tests/po-ref-match.test.mjs`, `tests/po-line-allocate.test.mjs`, `tests/scan-multi-po-chain.test.mjs`.
- Creating a PI or GRN LEARNS the supplier↔material pairing (`src/api/lib/supplier-binding-learn.ts`). Until 2026-08-04 `supplier_material_bindings` had exactly ONE writer — the maintenance page — so an operator resolving a scanned line got no benefit from it: the same supplier document arrived unrecognised every month and was picked by hand again. That, not the matching algorithm, was the real reason manual picking never stopped. Conservative by design: an EXISTING binding never has its commercial terms (price / lead time / MOQ) rewritten by a scan, only a BLANK supplierSku or supplierDescription is filled in, a line missing either half teaches nothing, and every failure is swallowed — a lost binding costs one future auto-match, a failed document costs the operator their work. Tests: `tests/supplier-binding-learn.test.mjs`.
- Scan line → internal code resolves as: supplierSku binding → supplierDescription binding → `src/lib/supplier-material-candidates.ts`, which searches a LADDER of candidate sets with `src/lib/material-text-match.ts`. The ladder replaced a bindings-only candidate set (`materialsForSupplier`, deleted) that was too narrow to be reachable: a binding only exists after somebody has already picked that line by hand, so the FIRST appearance of any item searched an empty list and always fell through to a manual pick — owner 2026-08-04: "为什么第一次一定要手动 pick 呢？… 他一定要能自己找啊". Order: (1) the LINKED PO's own lines — we wrote that order, so it states what the delivery should contain, and it exists from the very first purchase; (2) everything ever ordered from this supplier (PO history ∪ bindings); (3) the whole active catalogue at a STRICTER bar (`CATALOG_MIN_SCORE` 0.72 / margin 0.25 vs 0.5 / 0.12), so a new supplier's first document still resolves on unambiguous wording without licensing catalogue-wide guesses. Before any text scoring, an exact `supplierSkuIndex` hit (the supplier's own code, learned from PO lines) short-circuits — a code claimed by two materials is DROPPED, not guessed. The PO link is therefore resolved BEFORE the line loop in both modes; resolving it after (as both used to) leaves the strongest evidence unused. Index with `indexByCode`, never the modal's `materialByCode` — the latter is trim+uppercase and would miss every hyphenated code. Each row reports WHICH tier answered (`matchTierHint`), because a PO line and a bare catalogue reading do not deserve equal trust. Tests: `tests/supplier-material-candidates.test.mjs`, `tests/scan-supplier-scoped-match.test.mjs`, `tests/material-text-match.test.mjs`.
- The Internal Code picker in the scan wizard offers the WHOLE catalogue, ranked — this supplier's own materials first, the rest below tagged "not supplied by this supplier before". It was previously narrowed to materials the supplier had a BINDING for (2026-06-29, to stop Internal Code and Supplier SKU drifting apart), which meant a supplier with no bindings got an EMPTY dropdown: no auto-match AND no way to correct one without first creating the binding on another page. The coherence intent is now carried by ORDER rather than exclusion. Owner 2026-08-04: "他可以 manually pick，当错的时候，不过他一定要能自己找啊."
- A catalogue-tier match (the weakest rung — no PO line, no history) is sent as `unverifiedMatch` and the binding learner SKIPS it (`LearnableLine.learnable`). It may fill the field, because the operator sees and can correct it; it may not teach a binding, because a binding resolves silently on every future document and is no longer flagged — learning a wrong one converts a visible, correctable mistake into an invisible, permanent one.
- **The scan wizard's Linked PO is MULTI-SELECT** (owner 2026-08-04: "好几个 PO 都要 convert 这一个"). The picker ADDS to `card.purchaseOrderIds`; each linked PO shows as a chip with the number of lines it actually owns and an × to unlink. `purchaseOrderId` remains the header for display and back-compat, derived from the allocation (`headerPoId`), never picked. **Every change re-runs `relinkToPos`** — that is the substance, not the widget: the first cut computed each line's `poId` once at card build, so changing the Linked PO by hand re-priced the lines while leaving them drawn down against the order they were first matched to, and the document would bill one PO while consuming another. The re-link also re-prices each line off its OWN order (pricing the card off the header charges the second order's goods at the first order's rates), and the GRN re-link carries `poItemId`/`poItemIndex` too, since `grn_items` records the PO LINE. Tests: `tests/scan-multi-po-select.test.mjs`.
- **`deliveryOrderNo` is its own extraction field.** The extraction carried one `docNo` routed by docType — INVOICE → Supplier Invoice No., DELIVERY_NOTE → Supplier DO No. An invoice that also cites its D/O ("INVOICE : 549389" / "Our D/O No : 549389") had nowhere to put the second number, so the DO field could never fill on an invoice — and that field is the only link from an invoice to the goods received. The prompt says to capture it even when it repeats `docNo`, because on that document both numbers are identical. Only affects NEW scans; a reused/cached extraction predates the field. Tests: `tests/scan-delivery-order-no.test.mjs`.
- **A PI create failure used to erase its own cause.** The insert batch's catch existed for a pre-0162 DB (missing currency columns) and retried with a legacy column list — but it swallowed the original error for every non-foreign invoice (`console.error` fired only for `isForeign`) and the retry's rejection reached the global 500 handler, which strips messages. The one fact needed to diagnose was destroyed at runtime. Now the first failure is ALWAYS logged before the `isForeign` branch, and the retry has its own catch returning 400 with the original cause. A fallback for a KNOWN condition must not become a catch-all that erases unknown ones. Tests: `tests/pi-create-error-surfacing.test.mjs`.
- **A `supplierCode` holding the document's line NUMBER is not a code** (`supplierCodeOf` / `looksLikeRowNumber`). ADD WOOD's invoice is `No | Description | Qty | Unit/Price | Amount` — no product code anywhere, and the leading column counts 1, 2, 3. The extractor filled `supplierCode` with it, and that ONE junk character broke three things at once, which is why only this supplier misbehaved: the description fallback was gated on `!rawSku` so it never ran (and the description is their only identifying text — no amount of manual picking could ever make their invoice auto-resolve), the prefix-tolerant binding search matched any SKU ending in that digit, and the digit joined the matching text where a rare token carries high IDF weight and drags the score under the bar. Fixed at both ends: the extractor prompt says a counter column is not a code, and the client refuses to read one regardless. Also `MIN_SKU_SUFFIX_MATCH` — suffix matching needs ≥3 chars on both sides, since a two-character key suffix-matches nearly every binding a supplier has. Tests: `tests/scan-row-number-not-a-code.test.mjs`.
- Supplier bindings resolve by `supplierSku` FIRST, then by `supplierDescription` — and the description path runs whenever the SKU path FAILED, not only when the code column was empty. The description path exists because some suppliers print no product code at all (ADD WOOD's invoice is `No | Description | Qty | Unit/Price | Amount`), so the SKU path can never fire and Internal Code could never auto-resolve for them. `supplierDescription` was always in the table and the API, but was missing from the `SupplierMaterialBinding` FE type, so the scanner could not see it. Description containment matches ONLY when exactly one binding qualifies — two candidates means the line is ambiguous and guessing would book stock against the wrong material. Both scan modes (create-PI and create-GRN) must resolve identically, or the same document maps differently depending on which door it came through.
- ~~PENDING task to merge Supplier Pricing (pricing.tsx) into the Supplier module~~ — **DONE.** Consolidated by `8c12bfb6`, the dead page deleted by `b3b42b6c`; the comparison surface now lives in `procurement/maintenance.tsx` (ComparisonTab) and `/procurement/pricing` redirects there. Still don't duplicate it (a duplicate modal was shipped+reverted before).
- **A bought contact list imports through `POST /api/sales-leads/import`, NOT through
  `POST /`.** The single-lead POST mints a POTENTIAL customer per lead, and that is the
  owner's own ruling (2026-08-01, 「要不然我不习惯」) — someone typing in one lead is about to
  quote it. The bulk path must NOT: the first supplied list was 1,029 Google-Maps-scraped
  names against 7 real customers, and minting accounts for those puts them in the very table
  quotations, invoices and statements read from. Rules live in `src/lib/lead-import.ts` (pure,
  no DB): dedupe key is the PHONE reduced to digits and lifted to +60 — the list carried **zero
  emails and 1,029 phones**, so the phone is the only identity the data has; a row with no
  phone is skipped rather than imported as an uncontactable name; two branches sharing one
  phone collapse into one lead with the other name kept in `also_listed_as`; keyword-stuffed
  Google titles are cut to the business name with the original kept in `original_company`; the
  `&opi=` tracking suffix is stripped from websites. Every import carries `import_batch`, which
  is what makes `DELETE /import/:batch` able to remove a bad list whole (it 409s if any lead in
  it was already worked, unless `?force=true`). `POST /import` with `dryRun` writes nothing and
  returns the counts — always run it first; on the Penang file it reports 939 new / 90 duplicate.
  Pinned by `tests/lead-import.test.mjs` + `tests/lead-import-route.test.mjs`.
- **`GET /api/sales-leads` is paginated and returns `total`.** It used to `SELECT *` the whole
  table on every call, which was fine for hand-typed leads and fatal beside a bought list.
  Default 200, hard cap 500, filters `stage` / `industry` / `batch` / `q` (q matches the phone
  on digits, so a pasted "0102486699" finds "+60 10-248 6699"). The kanban board reads one page
  and shows a banner when `total` exceeds it — a board silently holding 200 of 939 is worse
  than a slow board, because the salesperson would work it believing it was the whole list.
- **Every payment handler is tenant-scoped, and the sweep test says so.** Three were not
  (fixed 2026-08-20): `GET /payments/:id` returned any company's payment to whoever knew the
  id; `POST /supplier-payments/recompute-pi-paid` OVERWRITES `purchase_invoices.paid_amount_sen`
  and status, so unscoped it was a cross-tenant WRITE to the books, not just a disclosure; and
  the restate-error diagnostic used ONE global `kv_config` key, so the last failure from any
  company overwrote and was served to every other. Ownership is settled ONCE on the lookup —
  the repair statement that follows deliberately carries no second predicate, because two
  predicates in two places is how they eventually disagree. A row that is not yours reads as
  **404, never 403**: "not found" and "not yours" must be indistinguishable or the endpoint
  confirms ids in someone else's ledger. `tests/payment-tenant-scope.test.mjs` pins each fix
  AND sweeps every handler in both route files, with an explicitly-empty exemption list, so a
  new handler cannot quietly skip scoping. Only one company uses the system today, so none of
  this was exploitable — it becomes exploitable the day a second is onboarded, which is exactly
  when nobody will think to re-audit payments.
- Convert-chain availability (PO→GRN→PI, mig 0182): per-line CONSUMED tracking. PO line available = `quantity − receivedQty`; GRN line available = `accepted_qty − invoiced_qty` (both exposed as `availableQty` on item reads, dual-keyed). PI POST takes `body.grnId` + per-line `grnItemId`; a LINE-LEVEL 409 guard (`src/lib/convert-chain.ts` `checkConvertAvailability`) replaced the old PO-level double-bill 409 — a 2nd PI is allowed when qty remains, only the over-drawn line is rejected. Increment `grn_items.invoiced_qty` on PI create (same batch as the line insert); RESTORE on PI delete / PI items-replace / PI→CANCELLED, and on GRN un-post/cancel/delete (`restorePOReceivedQtyForGRN` decrements `purchase_order_items.receivedQty`, recomputes PO status). Stock posting (`postGRNToStock`) is NOT reversed by any restore — availability only. GRN DELETE is blocked while a non-CANCELLED PI references it (`purchase_invoices.grn_id`). **A GRN-sourced PI is capped by the receipt AND by the purchase order (BUG-2026-08-07-003, BUG-CLASS C10): `checkPoRemaining` (`purchase-invoices.ts:945`) is the ONE PO ceiling, called by the PO branch, the GRN branch and the PUT re-line (the last with the edited PI excluded from its own already-invoiced sum). Before this, a GRN-sourced invoice saw only `accepted − invoiced_qty`, so 100 could be billed off the PO and 100 more off its GRN. The ceiling is `poInvoiceCeiling` = max(ordered, receivedQty) so an accepted over-receipt stays invoiceable; requested qty is aggregated per material code; a GRN line with no PO (direct receipt) is not PO-capped. A GRN-sourced line's `purchase_invoice_items.po_id` is resolved the same way the guard resolves it — `line.poId → body.purchaseOrderId → grn_items.po_id → grns.poId`.** Tests: `tests/convert-chain.test.mjs` + `tests/purchasing-convert-flow.test.mjs`.
- Convert UX (2026-06): GRN create = manual default + "Convert from PO" line-pick (`convert-from-po-modal.tsx`); PI create = "Convert from Goods Receipt" line-pick with GRN+PO tabs (`convert-to-pi-modal.tsx`). Pickers show per-line `availableQty`, checkbox + qty (≤ available), skip fully-consumed lines. PI GRN-source lines carry `grnItemId` → POST sends `body.grnId` + per-line `grnItemId`. Both pickers are SINGLE-source (one PO→one GRN; one GRN/PO→one PI) because the GRN backend keys lines to ONE parent PO by `poItemIndex` (grns.poId single column). Multi-source consolidation into one doc is a FOLLOW-UP (needs schema work). The GRN "From PO | Manual" mode toggle was removed; `?poId=` deep-link still locks PO mode.

- **Status tab strips (count + money per state)** are ONE component: `src/components/ui/status-tab-strip.tsx` + `src/lib/status-tab-strip.ts`. Feed it `tabTotals(rowsThisTabLists, valueOf)` so the badge and the RM figure can never describe different rows; a bucket that sums to nothing renders its count alone (never RM 0.00). Do not hand-roll a new one.

- `GET /api/purchase-orders` and `GET /api/grn` each bucket their line items by parent id ONCE and hand `rowToPO` / `rowToGRN` its own bucket (BUG-2026-08-13-003, class C14). Both mappers still `.filter()` — as a passthrough, which is what keeps the payload byte-identical — so re-passing the whole items array is a silent O(N×M) regression, not a compile error. Cheap today (165 PO × 369 items = 61 K comparisons / 1.3 ms; 37 GRN × 45 items = 1.7 K) but both lists are **unbounded unless the caller opts into `?page`**, so cost is ~2.24·N² and ~1.2·N² and grows with purchasing forever. Same reason the two `IN (...)` item fetches above them were narrowed. Pinned by `tests/list-endpoint-child-grouping.test.mjs`.

**Start here:** Open `src/pages/procurement/index.tsx` (PO list + POFormDialog) or `src/pages/procurement/detail.tsx` (PO detail + ThreeWayMatchPanel); for receiving/stock start at `src/api/routes/grn.ts`.

---

## Delivery & Consignment

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/delivery/index.tsx` — DO workbench + 3PL mgmt (6879) | `src/api/routes/delivery-orders.ts` — DO end-to-end (3010) | `delivery_orders` / `delivery_order_items` | `tests/delivery-pipeline.test.mjs` |
| `src/pages/delivery/detail.tsx` — single DO detail | `src/api/routes/packing-lists.ts` — delivery-side truck runs | `packing_lists` | `tests/do-qr-public.test.mjs` |
| `src/components/ui/document-detail-drawer.tsx` — the SHARED right slide-over chrome (doc no / type / status badge / "Open full page" / close + a pinned action bar); model in `src/lib/document-drawer.ts` | `GET /api/delivery-orders/:id/print-extras` feeds the spec line | — | `tests/document-drawer.test.mjs` |
| `src/components/ui/status-tab-strip.tsx` — the SHARED status tab strip (per state: count + money); rules in `src/lib/status-tab-strip.ts` (`tabTotals`/`tabValueSen`; a bucket summing to nothing shows its count, never RM 0.00). Used by SO / PO / GRN / PI / Invoices / CO **and DO** lists — `delivery/index.tsx` is the pattern it came from and was folded in on 2026-08-08, so there are no hand-written copies left. Money renders through `formatCurrency` everywhere (`formatRM`'s plain space was the DO page's second spelling of the same amount). | money either from the list rows already fetched, or from that list's `/stats` aggregate (which must carry `customerScopeSql`) | — | `tests/status-tab-strip.test.mjs` |
| `src/pages/delivery/agent-tab.tsx` — Delivery Agent tab (brief strip + proposal approve/reject) | `src/api/routes/delivery-agent.ts` — brief.json / proposals / run / cron trigger; lib `src/api/lib/delivery-agent.ts` (runtime self-apply) | `delivery_proposals` / `delivery_briefs` (snake_case) | |
| `src/pages/consignment/note.tsx` — CN workbench, DO-parity (5219) | `src/api/routes/consignment-notes.ts` — CN lifecycle | `consignment_notes` / `cn_packing_lists` | `tests/do-scan-sort.test.mjs` |
| `src/pages/consignment/index.tsx` — CO list | `src/api/routes/cn-packing-lists.ts` — CN packing lists | `consignment_orders` | `tests/pl-first-autosplit.test.mjs` |
| `src/pages/consignment/create.tsx` — create CO (1782) | `src/api/routes/consignment-orders.ts` — CO CRUD (2815) | `drivers` | `tests/three-pl-state-rates.test.mjs` |
| `src/pages/consignment/edit.tsx` — edit CO | `src/api/routes/consignments.ts` — legacy/aggregate (536) | `three_pl_vehicles` / `three_pl_drivers` / `three_pl_state_rates` | `tests/cn-do-parity-gaps.test.mjs` |
| `src/pages/consignment/detail.tsx` — CO/Note detail | `src/api/routes/drivers.ts` — in-house drivers | `sales_orders` / `fg_units` / `stock_movements` | `tests/cn-packing-list.test.mjs` |
| `src/pages/consignment/return.tsx` — recorded-returns LIST only; the return itself is recorded from `note.tsx` → `POST /api/consignment-notes/:id/return` | `src/api/routes/three-pl-drivers.ts` / `three-pl-vehicles.ts` / `three-pl-state-rates.ts` | `consignment_items.status='RETURNED'` + `returnedDate` (the only return record) | `tests/cn-packing-list-record.test.mjs`, `tests/cn-value.test.mjs`, `tests/no-fabricated-consignment-returns.test.mjs` |

**Big-file section index**
- `src/pages/delivery/index.tsx`
  - EditableExpectedDD helper — L69-280
  - TABS list (planning/pending_delivery/pending_dispatch/dispatched/delivered/packing_list) — L467-490
  - DeliveryPage start + pageTab (orders|3pl|agent) URL state — L801-810
  - 3PL Providers state + vehicles/drivers sub-table state — L911-1090
  - 3PL Provider helpers (CRUD, rates, fleet, drivers) — L1445-1830
  - DO status tally / search / transition logic — L2069-2790
  - Customer-notice helpers: customerEmailFor / warnIfNoCustomerEmail (Feature B no-email warning) / resendCustomerNotice (Feature A per-DO Resend invoice email) — search "Feature A"/"Feature B"
  - runBulkDoTransition + truck-run bulk dispatch — L2785-2840
  - DataGrid column defs — L3437-3910
  - Top-level Orders/3PL tab bar render — L4170-4189
  - Status sub-tab bar render — L4260-4320
  - Orders > Planning tab body — L4327-4349
  - Orders > Pending Delivery tab body — L4350-4517
  - Orders > Packing List tab body (pending_dispatch/dispatched/delivered share main grid) — L4518-6210
  - 3PL section: provider list + header — L6211-6320
  - 3PL Create/Edit Dialog (Info/Rates/Fleet/Drivers sub-tabs) — L6321-6879
- `src/pages/consignment/note.tsx`
  - ConsignmentNotePage start + pageTab/activeTab URL state — L505-690
  - TABS list (planning/pending_cn/pending_dispatch/dispatched/delivered/acknowledged/packing_list) — L261-267
  - DataGrid column defs — L2490-2560
  - Status sub-tab bar render — L3270-3297
  - Planning tab body — L3298-3318
  - Pending CN tab body — L3319-3468
  - Packing List tab body (later statuses share main grid) — L3469-5219

**Gotchas**
- CN front-end is an intentional DO-parity mirror. delivery/index.tsx and consignment/note.tsx share patterns — fixes often must be applied to BOTH. Shared helpers live in `print-extras-shared.ts` (PDF) and FE `runBulkDoTransition` (bulk status moves); don't fork them.
- Owner rulings: a CN CAN be converted to a DRAFT invoice via `POST /api/consignment-notes/:id/convert-to-invoice` — official flow, owner re-confirmed 2026-08-01. Link column is `consignment_notes.converted_invoice_id` (real FK to `invoices(id)`, indexed by `idx_consignment_notes_converted_invoice_id`, mig 0070); conversion is idempotent (one invoice per CN). Reverse lookup is exposed as `sourceConsignmentNote` on GET /api/invoices/:id; the forward link rides on `linkedCNs[].convertedInvoiceId` from GET /api/consignment-orders/:id. 3PL stays DO-side only. CN value = derived from the Consignment Order value, not stored.
- Status machine: DO DRAFT→LOADED→IN_TRANSIT→delivered via VALID_TRANSITIONS; the 'dispatched' tab deliberately includes IN_TRANSIT (row stays visible after loading). 'dispatched' is written as DB status LOADED. Don't bypass the transition guard.
- **CANCELLED is reachable from EVERY live status (2026-08-07), and it is the ONLY way to undo a DO past DRAFT** (DELETE is still DRAFT-only). Before this a wrong DO was immortal and — worse — `validateDoComposition`'s once-only-delivery guard (`_helpers.ts` ~1795, `d.status != 'CANCELLED'`) locked its production orders out of EVERY future delivery note, permanently. Cancelling is what makes that predicate false, so the goods go back on the picker. The whole reversal lives in ONE place, `buildDoCancelReleaseStatements` (`_helpers.ts` ~848), called from the `cancelled` block inside `applyDeliveryOrderUpdate` — statements only, so it lands atomically with the status flip. It undoes exactly what each forward edge wrote: fg_units unstamped to PENDING (both the LOADED and the DELIVERED stamp), one STOCK_IN counter-movement per PO (stock_movements is append-only — never deleted), the FIFO FG_DELIVERED COGS given back slice-for-slice by `reverseFGForDoCancel` (`do-cost-cascade.ts`, idempotent via `refType='DELIVERY_ORDER_CANCEL'`), and SHIPPED/DELIVERED sales orders stepped back to READY_TO_SHIP (skipped when a live sibling DO still carries them). **It REFUSES (409) rather than half-reverse**: while a non-CANCELLED invoice bills the DO (void it first — that path already reverses GL + A/R and hands the DO back), and when a Delivery Return exists (its own FG reversal already ran and cancelling the return does not undo it, so a blanket replay would credit the same goods twice). `rack_items` are deliberately NOT restored — same rule the LOADED→DRAFT reversal follows; nobody physically refilled the rack. Tests: `tests/do-cancel-releases.test.mjs`.
- `checkDeliveryOrderLocked` (`api/lib/lock-helpers.ts`) now ignores CANCELLED invoices. It used to count them, which contradicted the void path (void hands the DO back for re-invoicing) — the DO could be re-billed but never corrected first, and the error text told the operator to "void the invoice", which did nothing.
- PL-first auto-split: DOs auto-split by 3PL state/packing before dispatch. 3PL state rates have a known gap — DO write paths still lack a 0/0 hasRate guard.
- Notify emails: Dispatch→DO PDF, Delivered→Invoice PDF, idempotent via folded-lowercase dispatchemailat/deliveredemailat (db-pg toCamel does NOT recover these — dual-keyed). CN dispatch email uses dispatchemailat (mig 0163).
- Hub integrity: DOs/CNs chain through a hubId / service_orders.hubId composition guard shared by create+edit — don't break it when editing line composition.
- Dispatch/deliver writes movements into stock_movements and reads fg_units; respect production locks (COMPLETED job_cards / non-PENDING fg_units inviolate).
- delivery/index.tsx holds BOTH the DO workbench and the entire 3PL provider management UI behind one pageTab toggle (orders vs 3pl; 3PL block ~L6211). Status tabs pending_dispatch/dispatched/delivered have NO own activeTab=== blocks — they share the main DataGrid above the explicit planning/pending/packing_list blocks.

**Start here:** Open `src/pages/delivery/index.tsx` first (the DO workbench), and remember its consignment mirror `src/pages/consignment/note.tsx` usually needs the same change.

---

## Accounting & Invoicing

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/accounting/index.tsx` — mega-page, ~25 tabs (11230) | `src/api/routes/accounting.ts` — the accounting engine (13054) | `chart_of_accounts` / `account_aliases` | `tests/cashflow-engine.test.mjs` · `tests/accounting-subledger-parity.test.mjs` · `tests/accounting-ui-truthfulness.test.mjs` · `tests/money-input-parsing.test.mjs` |
| `src/pages/accounting/cash-flow.tsx` — standalone cash-flow | `src/api/routes/invoices.ts` — sales invoices (~2310) | `journal_entries` / `journal_lines` / `ledger_journal_entries` | `tests/other-party-payment.test.mjs` |
| `src/pages/invoices/index.tsx` — sales invoice list | `src/api/routes/payments.ts` — customer receipts | `document_lifecycle` | `tests/supplier-payment-alloc.test.mjs` |
| `src/pages/invoices/detail.tsx` (price editor delegates to `src/lib/invoice-price-edit-payload.ts` — the rule for WHICH lines a Save writes; extracted after it zeroed 112 lines, BUG-2026-08-20-158) — invoice editor (per-line discount) | `src/api/routes/supplier-payments.ts` — pay PIs (money-critical) | `invoices` / `invoice_items` / `invoice_payments` / `payment_records` | |
| `src/pages/invoices/payments.tsx` — customer payment receipts | `src/api/routes/e-invoices.ts` — MyInvois | `payment_vouchers` / `official_receipts` / `other_parties` | |
| `src/pages/invoices/supplier-payments.tsx` — pay PIs, FX | `src/api/routes/cash-flow.ts` — bank/forecast/reconcile | `purchase_invoices` / `supplier_payments` / `purchase_credit_notes` | |
| `src/pages/invoices/credit-notes.tsx` / `debit-notes.tsx` | `src/api/routes/cost-ledger.ts` — read-only (append-only) | `credit_notes` / `debit_notes` | |
| `src/pages/invoices/e-invoice.tsx` — MyInvois submission | `src/api/routes/stock-value.ts` — monthly_stock_values | `cost_ledger` / `stock_accounts` / `monthly_stock_values` | |
| `src/pages/procurement/PurchaseInvoiceDetail.tsx` — PI detail | `src/api/routes/stock-accounts.ts` — read-only (~42) | `rm_batches` / `fg_batches` | |

**Big-file section index**
- `src/pages/accounting/index.tsx`
  - TYPES — L48-77
  - AccountPicker — L78-212
  - Audit Log tab (document lifecycle trail, F3) — EXTRACTED to `src/pages/accounting/tabs/AuditLogTab.tsx` (no longer inline in index.tsx)
  - MAIN PAGE (tab host / nav) — L322-426
  - Overview tab + cards (Cleanup, Contra, LandedCost, DocNumbering, GstRate, Fye, StockMap, Aging) — L427-1320
  - Chart of Accounts tab (COATab) — L1321-1905
  - Journal Entries tab + JournalEntryForm — L1906-2332
  - Accounts Receivable tab (ARControlPanel + ARTab) — L2333-2661
  - Accounts Payable tab (APControlPanel + APTab) — L2662-3081
  - P&L report tabs (CostStructure, CostExpenseClasses, MonthlyTrend, MonthlyPl, PLStatement + ExportButtons) — L3082-3806
  - Other Debtors/Creditors tab — L3807-4579
  - GL Phase 1: Trial Balance tab — L4580-4714
  - GL Phase 2: PartyLedgerTab L6851 (per-party + grand DR/CR totals, screen+print) · BackToTopButton L6993 · GeneralLedgerTab L7014-7497, as of 2026-07-24 (grand-totals strip also at TOP of grouped view; neighbouring entries' line numbers predate the file's growth — anchor by function name)
  - Payment / Expense tab (PaymentsTab) — L5173-5524
  - Official Receipt tab (ReceiptsTab) — L5525-5760
  - Fund Transfer tab — L5761-5968
  - Opening Stock tab (OpeningStockTab, F6 FIFO seed — GET/PUT /material-opening-stock) — after StockMapCard
  - Stock Summary tab + WipDetailCard — L5969-6222
  - Labour month-end posting tab + AddDeptMapRow — L6223-6446
  - Fixed Assets + Depreciation tab — L6447-6734
  - Cash Book / Bank Reconciliation tab — L6735-7076
  - Opening Balance tab — L7077-7480
  - Balance Sheet tab (+ YearCloseCard + GroupByCompanyCard) — L7481-7778
  - Cash Flow tab — L7779-7945
  - Multi-company (Phase 2) — **the per-company breakdown is OFF since 2026-08-13 (BUG-2026-08-13-051); do not switch it back on without reading why.** `useCompanyOptions()` (accounting/shared.ts) now returns ONLY `{value:"", label:"All companies (group)"}`, and `CompanySelect` renders `null` for a single-option list, so every report fetch is the unfiltered consolidated read (`orgIdParam("")` is `""`) and `GroupByCompanyCard` renders nothing. The plumbing is intact — `orgIdParam` still appends `&orgId=`, `companyFilter` (`api/lib/tenant.ts`) still binds it — but it binds the **TENANT** column `org_id`, and the option list used to carry the **COMPANY DISPLAY** code (`organisations.code` lower-cased). Those are different dimensions: `0142_organisations_registry.sql:92,100` seeds HOOKKA *and* OHANA with `org_id='hookka'`, so OHANA/HOUZS/HKMFG matched nothing (empty P&L/BS/AR/AP/TB) and HOOKKA matched everything (the whole group under one name). A real per-company report needs a company column on `ledger_journal_entries` + `invoices`, which neither table has. When a second TENANT is seeded, key the options on `organisations.org_id` — which `GET /api/organisations` does not yet emit. Guard: `tests/accounting-company-filter-dimension.test.mjs`. (Separately, the rich P&L tab `/pl-statement` never accepted orgId at all.)

**Gotchas**
- `document_lifecycle` JOIN is load-bearing: list endpoints (PV, journals, etc.) must return lifecycleState or the FE shows wrong actions — voided docs showed void/delete instead of unvoid/delete (commit 8221d726, F3 hotfix). When adding a list query, JOIN document_lifecycle and surface lifecycleState.
- Money stored as integer sen (amountSen / discount_sen). Never floats; rounding through shared roundSen / distributeRoundSen in `src/lib/utils.ts`.
- **Money ENTRY has one parser: `parseMoneyInput` / `parseMoneyToSen` (`src/lib/parse-money.ts`), reached through `src/lib/money-field.ts` (`moneyFieldToSen` / `moneyFieldToRinggit` / `isUnreadableMoney` / `firstMoneyFieldError`).** This page has **119 money inputs and not one is `type="number"`** — they are all `type="text" inputMode="decimal"`, so a comma reaches the parser, and `parseFloat("12,000")` is `12` (BUG-2026-08-13-095: a fixed asset created at RM 12.00). The contract: a **blank** box is `0`, an **unreadable** box is `null` and the caller **REFUSES** — `moneyFieldToSen(x) ?? 0` in a payload is the same bug booking RM 0.00. Each form here has a single `…MoneyError` gate that toasts, returns, disables the post button, and makes the running Total render `"—"` rather than a figure computed with a 0 substituted in (the BUG-2026-08-13-094 rule: the displayed figure and the payload cannot come from different expressions). Guard: `tests/money-input-parsing.test.mjs` — it fails on any `parseFloat` returning to this file, on a missing refusal, and on an unbudgeted `?? 0`.
- invoices uses camelCase DB columns; new write columns should be snake_case (e.g. discount_sen mig 0179) and need a `column-rename-map.json` entry or they 400 'Invalid request body'. CI-guarded by `tests/sql-write-column-coverage.test.mjs`.
- Migrations INERT unless runtime-wired: new column reaches prod only via `ensurePendingMigrations` self-apply inside the route before the INSERT — see invoices.ts:980 ALTER for discount_sen.
- cost_ledger is append-only: cost-ledger.ts and stock-value reads are derived; actual cost rows written side-effectually by GRN/production_orders/delivery_orders. Don't write cost_ledger from accounting routes.
- P&L RM/WIP/FG come from the FIFO engine, NOT cost_ledger perpetual totals (ledger stopped being fed after 2026-03). `loadMaterialCost(db, orgId, startIso, endIso)` (accounting.ts, just before `computePnlWindow`) replays GRN receipts + cost_ledger RM_ISSUE/ADJUSTMENT through `src/lib/material-cost-fifo.ts`; `computePnlWindow` now takes `orgId` and reads `mat.rmGroups/wipOpenSen/wipCloseSen/fgOpenSen/fgCloseSen` instead of stockSummaryRange. WIP/FG are reconstructed as-of-date (in-progress = start_date<=D & (completed_date null or >D); FG undelivered = original_qty − fg_units delivered_at<=D). Receipt cost = APPROVED-PI weighted avg per (PO, material_code) else grn_items.unit_price. stockSummaryRange still feeds the closing-stock journal legs (buildClosingStockLegs) — leave it.
- Invoice mutations cascade: create-from-DO / void touches sales_orders, so_status_changes, delivery_orders, and customers running balance. Edit the cascade, not just the invoice row.
- **The per-line link from an invoice line back to its SALES ORDER line (2026-08-14, BUG-2026-08-13-097).** `invoice_items.so_item_id` — nullable, indexed, snake_case; runtime-self-applied by `ensureInvoiceSoItemLinkColumn` (`src/api/lib/invoice-so-item-link.ts`, migration 0226 is the RECORD only). It exists because 98.5% of invoice lines had no route back to a sales order, so both reconciliation planners reported `0 items to fix` over a book they could not see. **The road out is `production_order_id` (92.6% populated), NOT `delivery_order_item_id` (1.5%)** — and it is per LINE, so a consolidated invoice resolves each line inside its own sales order. ⚠ **Never join `production_orders.lineNo` to `sales_order_items.lineNo`**: the production order's is `poSequence` (`_shared/production-builder.ts:786`), a per-PIECE counter, while the sales-order line's `lineNo` (`routes/sales-orders.ts:3886`) is `idx + 1` per LINE — the two agree only when every line on the order has quantity 1. Identity comes from the production order's SPEC, resolved by `resolveSoItemId`, which **counts claimants and returns null when contested** — the deliberate opposite of `priceForItem`'s first-one-wins in `do-value.ts` (a price may be taken first-one-wins; an identity may not — that is BUG-2026-07-17-001). The index rides on `loadSoLinePriceIndex`'s existing two reads (`SoLinePriceIndex.soItemIdentity`), so the forward fill costs no extra query; `resolveSoItemIdsForPoIds` is the narrow batched variant for the invoice PUT. Backfill: `POST /api/invoices/backfill-so-item-links` — **dry-run by default**, `?execute=1` to write, `?tiers=exact,code` to include the drift tier; reports seven outcome buckets with each one's sen value rather than a single total. Tests: `tests/invoice-so-item-link.test.mjs`.
- **Matching a RECEIPT line to the purchase-order line it belongs to (2026-08-14, BUG-2026-08-13-150, class C21).** `src/api/lib/grn-po-line-link.ts` — pure, counts the claimants and **refuses rather than picks**: `id` → link; `positional` only when the owning order is not in doubt; `unknown-line` / `contested-po` / `index-*` / `no-po` → **NULL with a reason**. There is deliberately NO fall-through from a recorded `po_item_id` to the position. Consumed by `three-way-match.ts`, where an unresolved line now prices **NULL, not 0**, and `allMatched` requires `unresolvedLines === 0` so **an unchecked line cannot reach `FULL_MATCH`**. Two faults made this necessary: `pos.find(p => p.id === grn.poId) ?? pos[0]` took an arbitrary order on a multi-PO receipt, and `poItemIndex` was read against `ORDER BY id` while the stock draw-down binds `PO_ITEMS_ORDER` (`src/api/routes/grn.ts:930`, i.e. `line_no NULLS LAST, id`) — so once a PO's lines were reordered, a receipt line drew stock from one line and was PRICED against another, **on a single-PO receipt**. Blast radius UNMEASURED: run `scripts/check-first-one-wins-blast-radius.mjs`. Tests: `tests/first-one-wins-refusal.test.mjs`, `tests/three-way-match-multi-po.test.mjs`.

- **ONE delivery order, SEVERAL invoices (2026-08-07).** The sales side now has the per-line convert chain purchasing has always had: `delivery_order_items.invoiced_qty` (consumed counter) + `invoice_items.delivery_order_item_id` (which delivery line a bill line draws from), both runtime-self-applied by `ensureDoPartialInvoiceColumns` (`src/api/lib/do-partial-invoice.ts`, migration 0214). Arithmetic is the SHARED seam `src/lib/convert-chain.ts` — the same `availableQty` / `clampDecrement` the PO→GRN→PI chain uses. Billed state is DERIVED (`loadDoBillingState`: Σ invoiced_qty vs Σ quantity), never the status flag; `delivery_orders.status` is kept in step by `buildDoStatusSyncStatement` and only reaches INVOICED on the LAST slice, so a half-billed DO stays DELIVERED and can be finished. `computeDoInvoiceLines(db, doId, soIds, select?)` bills each line's REMAINDER (or the operator's pick) — that one change is what makes the first invoice identical to today and the second bill only what is left; its two SO-level fallbacks are gated behind `freshWholeDo` because they consume nothing and would otherwise re-bill the whole SO. Every increment is paired: `buildInvoiceLineReleaseStatements` runs on void, DRAFT delete AND DRAFT line-replacement (release the whole old set, re-consume what survives). `uniq_invoice_active_delivery_order` (mig 0208) is DROPPED and replaced by the CHECK `chk_doi_invoiced_qty (invoiced_qty <= quantity)` — same race, better invariant; a violation is caught and returned as a 409 with the current remainder. UI: `GET /api/delivery-orders/:id/billable-lines` feeds the line/quantity picker in the Transfer-to-Invoice dialog (`src/pages/delivery/index.tsx`). Tests: `tests/do-partial-invoice.test.mjs`, `tests/invoice-dedupe-guard.test.mjs`.
- **BACKWARDS COMPATIBILITY — read this before touching the billed-state rule.** Existing invoices have NO `delivery_order_item_id` and the new counters start at 0. Deriving billed state from the counters alone would make every already-billed DO read as unbilled and become re-billable — an invitation to double-charge. So `fullyInvoiced = (remaining is 0) OR (a LIVE invoice on this DO has no linked lines)`. That second clause is the LEGACY whole-document bill: today's data keeps behaving exactly as today (one live invoice ⇒ refuse a second, same message), and voiding it makes the DO billable again from zero, which is correct. `legacyInvoices` is a LIST, not one row, so a DO carrying two legacy bills does not release on the death of either. **There is deliberately NO backfill of `invoiced_qty`** — the mapping would have to be guessed by product code, and two of the three invoice-line fallbacks have no DO line behind their rows at all; a guess that lands short silently licenses billing the difference twice.
- Still whole-document, by design: `loadDoInvoiceMap` and the FE notice PDF pick the NEWEST live invoice per DO for the grid's `invoiceNo` column and the customer e-mail. `POST /api/admin/dedupe-invoices` is unaffected — it only flags a group whose invoices have an IDENTICAL item signature AND a full DO item count, which a partial bill never has.
- **An invoice line's per-line enrichment resolves through `invoice_items.production_order_id`, NOT by product code** (`src/api/lib/invoice-print-extras.ts`, BUG-2026-07-17-001). Both halves: `refByPo` for the customer PO / SO / REF, and the PRICE half via `poLink → poToSo → tightBySo/looseBySo/byCodeBySo` — the sales-order item maps are also built SO-scoped, so a line resolves inside its OWN sales order. The global `tight`/`loose`/`byCode` maps are **first-one-wins across every source SO** and survive ONLY as the fallback for lines with no PO link — on a consolidated DO they hand a line another variant's numbers, which is how an invoice printed "Base 0 … = RM 305" on a line the editor then re-summed to RM 308. Don't reintroduce a code-keyed price lookup ahead of the PO link. The endpoint now also returns the line's CHARGE as `unitSen` (`invoice_items.unitPriceSen`, never the sales order's own unit) plus a `buildUpReconciles` verdict.
- **THE invoice-line price rule lives in one module: `src/lib/invoice-line-price.ts`** (importable by both sides — `src/api/lib/` is backend-only). Written out at the top of that file: the charge is `invoice_items.unitPriceSen` and is authoritative; the Base/Divan/Leg/T.Height/Special build-up only EXPLAINS it; a build-up is displayed only when `base+divan+leg+totalHeight+special === unitPriceSen` (and only when there IS a surcharge); editing moves the explanation and the charge together, so the edit SEED (`invoicePriceEditSeed`) always reconciles — Edit → Save with nothing typed can never reprice a line. Callers, all of them: `invoicePriceBreakdown` (`src/lib/build-unified-doc-data.ts`, the Invoice/SO/CO PDF seam), the invoice detail read view AND its editor (`src/pages/invoices/detail.tsx`), `priceLines` in `generate-invoice-pdf.ts`, the backend resolver `invoice-print-extras.ts`, the `priceEdits` write in `src/api/routes/invoices.ts`, and the order-side alias `calculateUnitPrice` (`src/lib/pricing.ts`). Never hand-roll a second breakdown renderer or a second component sum. Tests: `tests/invoice-price-buildup-rule.test.mjs`, `tests/invoice-line-price.test.mjs`, `tests/invoice-pdf-breakdown.test.mjs`.
- **The ORDER edit screens go through the same module** (BUG-2026-08-07-007, 2026-08-07). `src/lib/pricing.ts` carries the order-side seam: `calculateUnitPrice` (the five-term sum), `orderLinePriceBuildUp` + `formatOrderLineUnit` (the guarded inline "Unit: X (Base A + …)" caption — no build-up unless it sums to the charge). `src/pages/sales/edit.tsx` (`getUnitPrice` `:824`, caption `:1614`) hand-rolled `base+divan+leg+special` and never mentioned `totalHeightPriceSen`, while `PUT /api/sales-orders/:id` DERIVES that fifth component when the client omits it — the screen showed RM 830 and the save stored RM 910. It now keeps `totalHeightPriceSen` in state, seeds it from the line's stored column, re-derives it with the server's own `deriveTotalHeightSurchargeSen` when gap/divan/leg change, and posts it. `src/pages/consignment/edit.tsx` (`:479`) uses the same helpers with an explicit `totalHeightPriceSen: 0` — the CO write path charges four components and never fills `consignment_order_items.total_height_price_sen`. ⚠️ Open: `consignment/create.tsx` DOES compute + post a total-height surcharge that `consignment-orders.ts` silently drops. Tests: `tests/order-edit-unit-price.test.mjs`.
- The invoice editor's live sums (`src/pages/invoices/detail.tsx:803` per-line Unit · `:463` header total · `:998` footer Subtotal, rendered `:1021`) must include **all five** components — base, divan, leg, special AND `totalHeight`. All three call the SHARED `invoiceLineUnitSen` (`src/lib/invoice-line-price.ts:84`) rather than each summing the components inline — that is what keeps them from drifting apart, so add a sixth component THERE, not at the three call sites. The `DiscountInput` base at `:953` is `liveUnit * qty`, so an omission silently shrinks a `%` discount too and the figure jumps after save (BUG-2026-07-17-001, 2026-08-07). Tests: `tests/invoice-price-buildup-rule.test.mjs`, `tests/invoice-line-price.test.mjs`.
- `ledger_journal_entries` (posted GL) is distinct from `journal_entries`/`journal_lines` (journal module). P&L/balance sheet/trial balance/GL tabs read ledger_journal_entries + chart_of_accounts — don't confuse the two.
- **The manual-journal surface IS tenant-scoped (2026-08-13, BUG-2026-08-13-083).** `journal_entries` and `journal_lines` both carry `org_id TEXT NOT NULL DEFAULT 'hookka'` (mig 0087 → re-applied by 0206 and by the runtime `ensureFinanceOrgColumns`). An in-file comment used to claim the opposite and was used to justify no predicate at all; it is gone. Every entry-point read (`GET /journals`, `GET/PUT /journals/:id`, `/journals/:id/lifecycle`, `DELETE /journals/:id`) now binds `orgId`, both INSERTs stamp it, and the `journal_lines` reads keyed off an already-gated entry id are deliberately left unscoped with a comment saying why. Byte-identical on today's single tenant. Guard: `tests/accounting-subledger-parity.test.mjs`.
- **A per-party STATEMENT and its all-party LEDGER twin must carry the same filters (2026-08-13, BUG-2026-08-13-080, class C18).** `/customer-statement`↔`/debtor-ledger` and `/supplier-statement`↔`/creditor-ledger` build the identical line model from their own copies of the source queries. The statements were missing the lifecycle `VOID/DELETED` exclusion the ledgers have always had, so a voided receipt credited the document you print and post. When you add a predicate to one of a pair, diff the QUERY against its twin in the same commit.
- **AP relief is `supplier_payments.bookedSen`, never `amountSen` (2026-08-13, BUG-2026-08-13-082).** `amountSen` is `r.bankSen` (cash out of the bank); `bookedSen` is what came off `400-0000`. `supplier-payments.ts` posts DR 400-0000 Σ`bookedSen` · CR bank Σ`bankSen` · ±530-0000 Σ FX and bumps `paid_amount_sen` by `bookedSen`. Both subsidiary ledgers now read `COALESCE(bookedSen, amountSen)` — the COALESCE covers pre-fix `CONTRA` rows that stored no `bookedSen`.
- **`POST /contra` writes the AP side in full (2026-08-13, BUG-2026-08-13-081).** Settling payables against a customer receivable now moves `paid_amount_sen` in the same statement as the `status='PAID'` flip, stores `bookedSen` on its `supplier_payments` row (it was the only INSERT of that table in the repo that did not), and relieves `suppliers.outstandingSen` — the mirror of the `customers.outstandingSen` decrement the same handler always did. Without these, `rebuildApCounterSen` (which sums `amountSen − paidAmountSen` over every non-DRAFT/CANCELLED PI, PAID included) kept counting the contra'd bill at full face and the AP tab's `driftCounterVsPiSen` never cleared. ⬜ Owner decision outstanding: a contra still leaves no row on `/debtor-ledger` / `/customer-statement`, because it writes no `payment_records`.
- A PI posts to GL whenever it REACHES status APPROVED — on the PUT transition AND on create-as-APPROVED (POST). Both call the shared `src/lib/pi-posting.ts buildPiApprovalLegs()` (DR mapped buckets · CR 400-0000), idempotent via `ledgerHasSource(...,"purchase_invoice",id)` (BUG-2026-06-23-007). Don't re-add posting to only one path. Opening PIs use `/opening-balance/ap` (isOpening) and post NO PI legs. ⚠️ Sales invoices (DRAFT→SENT) still post only on the PUT transition — the symmetric create-as-SENT gap is NOT yet fixed.
- Periodic-inventory mode (2026-07-03, owner rule 「不要用 BOM 算先」): kv `rm_valuation_mode` = `stock_take_only` → RM value at every month-end = latest stock-take count + PI purchases since it (`stockTakeChainValue` in `src/lib/material-cost-fifo.ts`; opening seed = `material_opening_stock` before any count). BOM/FIFO consumption is bypassed; consumption surfaces only in counted months, plus the correct immediate consumption of FEE/SERVICE/unmapped PI lines (GL posts every non-TAX line to a purchase account; only STOCKED+group-resolvable lines enter the stock chain — the gap is real cost, not noise). `auto` = original FIFO/BOM + stock-take override. Toggle on the Stock Take tab; `PUT /rm-valuation-mode`; GET /stock-take returns `rmValuationMode`. Flows into P&L, stock summary AND closing-stock GL posting (same engine) — re-Post any posted month after flipping. WIP/FG unaffected.
- Opening-month P&L slice (2026-07-03, report-layer, ZERO ledger rows): opening_balance legs are no longer dropped from the P&L — `glWindowSigned` nets them per account (reversals cancel, so re-posting the opening self-maintains) and, when the window covers the opening month, injects `opening − kv pnl_opening_prior_cum` (prior-month-end TB, {code: signedSen}, DR+/CR−) for REVENUE/COST/EXPENSE accounts; `/cost-expense-classes` has the same injection in its own loop. Pure rules: `src/lib/opening-slice.ts` (`applyOpeningSlice`, `windowCoversMonth`). `PUT /opening-balance/pnl-prior-cum` stores the setting; GET /opening-balance returns `pnlPriorCum`. Months before the opening month still come from `pnl_historical`; TB/BS paths untouched. Same day: P&L raw-material PURCHASE lines read the LEDGER per purchase account (`rmGroups` keyed by account code via DEFAULT_PURCHASE_MAP + kv coa_stock_map; opening/closing stock stays engine-valued and is mapped onto the same account rows).
- Mid-year opening (2026-07-02): `/opening-balance/post` accepts P&L accounts (opening 22/05 sits mid-FY; SDC/SCC controls stay blocked). Pre-opening PIs count as opening BY DEFAULT — rows never edited; exceptions live in runtime-self-applied `opening_ap_excludes` (pure rule `apRowBeforeOpening` in `src/lib/opening-floor.ts`; wired into /aging AP, /ap-control, supplier statement, /creditor-ledger and `openingControlSums`). GET /opening-balance returns `preExistingAp`; POST `/opening-balance/ap-exclude` toggles exclusion (bumps kv_config so the aging snapshot rebuilds). Opening Balance tab: all-postable-accounts grid + "Already-entered supplier invoices" exclude/include card.
- Supplier Discount (purchase CN) = `accounting.ts` `/purchase-credit-notes` POST(DRAFT)+PUT(POSTED, optional `allocations[]`)+`/:id/void`; UI `SupplierDiscountTab` (tab `supplier-discount`). The CN's GL is DR400/CR-purchase (the ONLY GL move). Knocking it off a PI does NOT add a GL leg — it bumps the PI's `paid_amount_sen` + writes a `supplier_payments` `method='CREDIT_NOTE'` marker (`amountSen=0`, `bookedSen=applied`, `paymentNo=<CN no>`). Markers are EXCLUDED from the supplier-payment history list; `/ap-control` nets only the UNALLOCATED CN remainder (`Σ posted CN − Σ marker bookedSen`) over net PI outstanding so drift stays 0. Void deletes markers + restores paid_amount. Allocation math: pure `src/lib/discount-alloc.ts` (#6).
- Other-Party Bills edit-in-place (2026-07-09): `PUT /other-party-bills/:billNo` — restate pattern (reverse visible GL `other_party_bill_restate_rev:<stamp>` + post `_restate_post:<stamp>` + collapse), same number, party FIXED, new total ≥ paidAmountSen (pure `editedBillStatus`). ⚠️ void/delete/unvoid MUST pass the whole leg family via `otherPartyBillLegFamily` (applyLifecycle exact-matches sourceTypes; plain `['other_party_bill']` would leave an edited bill's restate legs visible after void). Previously-voided-then-restored bills refuse edit (void trail pinned to old figures — Copy instead).
- AR drift diagnosis (2026-07-09): `GET /ar-reconciliation` — same pure decomposition via ReconCfg (300-0000 legs fed debit/credit-SWAPPED; invoices=doc family, payment_records allocations=pay family; no advances — /ar-control subtracts none). Known standing item: debtor opening NOT yet entered → −40,000 drift (2 receipts paying 23 un-flagged pre-opening invoices) is EXPECTED until the owner runs the debtor-opening project (v5 list + flag-as-opening switch to build).
- AP drift diagnosis (2026-07-08): `GET /ap-reconciliation` (accounting.ts, right after /ap-control) — read-only, itemizes `driftControlVsPiSen` into per-document items (opening coverage, per-PI GL vs face, per-payment GL vs claim incl. void leaks, voided-advance rows, paid_amount drift, overpaid clamps, CN block, stray sources on 400-0000) whose contributions sum EXACTLY to the drift (pure `src/lib/ap-recon.ts`, tests/ap-recon.test.mjs asserts the identity). Use it BEFORE hand-reconciling any control-vs-subledger gap.
- Two huge files (index.tsx ~11140, accounting.ts ~13054) — index.tsx has `// =============== TAB:` banners; accounting.ts uses `// ----` section headers (NOT TAB banners), so anchor on `app.get/post` handler + `function` lines. Never read either end-to-end. ⚠️ The `index.tsx` section-index line numbers below drift 2-3k lines — grep the named symbol/tab near the listed line.
- `e-invoices.invoiceId` is intentionally NOT FK-enforced — legacy/standalone e-invoices reference invoices that may not exist; don't add a hard FK.
- Service-order invoices price RM 0 by owner ruling; locked SOs (production COMPLETED + DO delivered) refuse header changes — don't override production locks for cosmetic invoice fixes.

- **Status tab strips (count + money per state)** are ONE component: `src/components/ui/status-tab-strip.tsx` + `src/lib/status-tab-strip.ts`. Feed it `tabTotals(rowsThisTabLists, valueOf)` so the badge and the RM figure can never describe different rows; a bucket that sums to nothing renders its count alone (never RM 0.00). Do not hand-roll a new one.

- **Trade finance (2026-08-11)**: money a LENDER (Houzs Century) pays our suppliers = per-draw liability on the reclassed TF account (310-0020, LIABILITY after `POST /accounting/trade-finance/setup`). Draw amounts are NEVER stored — `loadTfDraws` (`src/api/lib/trade-finance.ts`) derives them from the ledger family net per drawing payment and self-heals missing due-date rows (`trade_finance_draws`; allocations in `trade_finance_repay_allocs`; kv `trade_finance_sources`). Pure maths + due-date buckets in `src/lib/trade-finance.ts`. Repayment = ordinary supplier payment to the lender (`method='TF_REPAYMENT'`, DR TF / CR bank, `tfAllocations` body field) — excluded from the advance machinery; a draw with allocations refuses void; a voided repayment refuses unvoid. `/aging` payload carries `tf`; UI = `src/pages/accounting/tabs/TradeFinanceBlock.tsx` on the AP tab + lender mode in `src/pages/invoices/supplier-payments.tsx`. Tests: `tests/trade-finance.test.mjs`, `tests/tf-repayment.test.mjs`.
- **Salary by department (2026-08-11)**: dashboard payload (v7) carries `salaryByDept` per bucket (payslips-aggregated via `src/lib/salary-dept.ts`, snapshot sourceTables include payslips); the Production Salary card stacks departments with CS-style chips. Forecast keys salaries per `dept:<CODE>` pseudo-row; a month with any dept row SUPERSEDES its 750-x account entries (shared rule `monthHasDeptForecast`/`forecastEntryKind` — used by both `forecast.tsx` and the dashboard's forecast loop). `GET /labor/departments` seeds the rows. Tests: `tests/salary-dept.test.mjs`.

- **The Overview tab's three KPI cards read the LEDGER, not `chart_of_accounts.balanceSen` (2026-08-13, BUG-2026-08-13-091).** `balanceSen` is moved by **only** the manual-JV paths (`accounting.ts` PUT `/journals/:id` `:1378`/`:1447`, POST `/journals/:id/lifecycle` `:1640`); every real posting writes `ledger_journal_entries`. Summing it reported hand-keyed journals as the company's revenue, under a "(MTD)" caption with no date filter, with the `COST` type dropped from the expense side. The cards now read `GET /accounting/pl?period=<YYYY-MM>` and publish "—" (never RM 0.00) for a category with no posted account, exactly as `/reports` does since BUG-2026-08-13-009. "Cost & Expenses" is COGS + OpEx so the three tie to the server's own `netProfit = revenue − cogs − opex`. Guard: `tests/accounting-ui-truthfulness.test.mjs`.
- **The aging tabs are READ-ONLY. `POST /api/accounting/aging` writes DEAD tables — never call it (2026-08-13, BUG-2026-08-13-090).** It UPDATEs `ar_aging`/`ap_aging`, which `GET /aging` does not read (it computes live from `invoices`/`purchase_invoices`; `accounting.ts:377,490` and `api/lib/ensure-finance-org.ts:22` all call those tables dead). The "Record Payment" button that used to sit on both tabs therefore recorded nothing and, never checking `res.ok`, swallowed the 404. Customer receipts go through `/invoices/payments`; supplier payments through `/invoices/supplier-payments`.
- **Cash Flow accepts `YYYY-MM` ONLY (2026-08-13, BUG-2026-08-13-092).** `fyMonths` (`src/lib/cashflow-engine.ts`) parses the period with `parseInt`, so a quarter/year value built 13 columns keyed `2026-NaN`: every income and expense line rendered `-` while `balBefore` string-compared TRUE against every real month and printed a large, real Bank b/f and c/f. The optgroups are gone and `fyMonths` now throws on a malformed period. ⚠️ The **P&L Statement's** identical-looking selector is CORRECT — `/pl` and `/pl-statement` route the period through `ymInPeriod`/`periodStartYm`/`periodEndYm` (`accounting.ts:5382-5416`), which do understand `2026-Q1` and `2026`. Do not "fix" that one.
- **Stock Summary's `balanced` flag is a TAUTOLOGY — do not render it (2026-08-13, BUG-2026-08-13-093).** `accounting.ts:5902` computes `opening + purchases − consumption === closing` while `materialWindow` defines `consumedSen = opening + purchase − closing`, so it reduces to `closing === closing`. **Consumption is the balancing plug on this screen, not a measured issue quantity.** The ✓ column and its footnote are removed. The Trial Balance's `balanced` badge IS a real check (ΣDR vs ΣCR over independent columns) — leave it.
- **A money form's displayed total must sum exactly the lines its payload sends (2026-08-13, BUG-2026-08-13-094).** Payment Voucher, Official Receipt, Other-Party Bill and the Journal Entry balanced-check each totalled EVERY line while POSTing only lines carrying an account, and the backend recomputes the header from what it receives — so "Total RM 1,000.00 · Post" wrote RM 800.00, and a JV with an account-less DR row showed a green balanced footer the server then rejected. Each form now has ONE `*LineWillPost` predicate feeding both the figure and the payload, and discloses any filled line that will not post.

**Start here:** Open `src/pages/accounting/index.tsx` (one mega-page hosting ~25 tabs) and jump via the section banners; for customer-billing tasks start at `src/api/routes/invoices.ts`.

---

## Production & BOM

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/production/index.tsx` — dept-tabbed WIP board (8888) | `src/api/routes/production-orders.ts` — PO/job-card/WIP backend (7.6k) | `production_orders` / `production_orders_archive` / `production_orders_list_snapshot` | `tests/bom-explosion.test.mjs` |
| `src/pages/production/folders.tsx` — folder list | `src/api/routes/production-folders.ts` — group/ungroup | `job_cards` / `job_cards_archive` / `job_card_events` | `tests/job-card-id.test.mjs` |
| `src/pages/production/folder-detail.tsx` — folder detail | `src/api/routes/job-cards.ts` — reads + event timeline | `folder_job_cards` / `production_folders` | `tests/production-fresh-po-direct-db.test.mjs` |
| _(no page)_ `/production/tracker` — redirect only, → `/planning?tab=tracker`. The Master Tracker is a Planning TAB; the standalone `production/tracker.tsx` was deleted 2026-08-13 (unreachable since the route became a redirect, imported nowhere) | `src/api/routes/bom.ts` — bom_templates + bom_versions | `wip_items` / `wip_cascade_log` / `piece_pics` | `tests/production-order-builder.test.mjs` |
| `src/pages/production/wip-times.tsx` — per-dept minute rates. All four totals tiles gate on `!isUnknownOutcome(failure) && Array.isArray(resp?.data)` and render "—" otherwise (-147); the Missing-BOM tile also prints how many products have NO active BOM at all, which the row walk structurally cannot see | `src/api/routes/bom-master-templates.ts` — master variants | `bom_templates` / `bom_versions` / `bom_master_templates` | `tests/production-orders-dept-narrow-guard.test.mjs` · `tests/planning-production-tile-truthfulness.test.mjs` |
| `src/pages/production/scan.tsx` — shop-floor dept scan | `src/api/routes/cnc-templates.ts` — Model→Size/Seat derive | `cnc_templates` | `tests/production-overdue-counts.test.mjs` |
| `src/pages/production/fg-scan.tsx` — FG scan | `src/api/routes/inventory-wip.ts` — in-flight WIP per dept/PO | `production_lead_times_history` / `hookka_dd_buffer_history` | `tests/production-wip-producer-output.test.mjs` |
| | `src/api/lib/packing-rack-write.ts` — `applyPackingRack(db, jc, rack, pieceNo?)` (rack set/clear + occupancy mirror; shared by office PATCH / /p/ / worker; per-PIECE rack via `piece_pics.racking_number` when pieceNo+totalPieces>1, else card-level legacy) | `rack_items` / `rack_locations` / `piece_pics.racking_number` (mig 0192) | `tests/packing-piece-identity.test.mjs` / `tests/sticker-rack-public.test.mjs` |
| | `src/api/lib/packing-piece-identity.ts` — `packingPieceIdentity` (shared piece warehouse identity; appends `· pc N of M` to notes when pieceNo set + multi-piece) | | |
| | `src/api/lib/job-card-completed-at.ts` — `ensureJobCardCompletedAt` / `observedCompletionAt` / `reconcileCompletedAt` / `readCompletedAt` (the completion INSTANT, beside the date-only `completed_date`) | `job_cards.completed_at` | `tests/job-card-completed-at.test.mjs` |
| `src/pages/production/dept.tsx` / `overview.tsx` — thin wrappers over `production/index.tsx`, whose Overview counts now gate on `ordersObserved` (cold landing / in flight / dead read all print "—", -146) | `src/api/routes/wip-times.ts` — minute counts + `coverage.productsWithoutActiveBom` (`number \| null`, from `countProductsWithoutActiveBom` in `src/api/lib/wip-times-core.ts`) | `kv_config` · `products` (read: ACTIVE products with no ACTIVE bom_template) | `tests/sofa-combo.test.mjs` · `tests/planning-production-tile-truthfulness.test.mjs` |
| `src/pages/bom.tsx` — BOM Management (7211) | `src/api/routes/production-leadtimes.ts` — due-date buffer | | |
| `src/pages/cnc-templates.tsx` — CNC drilldown | | | |
| `src/pages/production/components/` — BatchActionToolbar / CreateStockPODialog / CellBox / ProductDetailLine | | | |

**Big-file section index**
- `src/pages/production/index.tsx`
  - Helper filter/header components (OverviewHeader, TextContains/NumericRange/DateRange/MultiSelect/DeptStatus) — L154-501
  - ProductionPage main start (state, data fetch, dept tab logic) — L502-2550
  - Dept-gating + visibleOrders/base WIP rows derivation (activeTab ALL vs dept) — L2550-3150
  - PIC list filtering by dept coverage — L3150-3400
  - Grid column definitions (per-dept hidden columns, wipType) — L3400-3780
  - Per-dept row rendering / FAB_SEW / FAB_CUT wipKey logic — L3780-4200
  - Due-date apply + cascade to sibling WIP cards — L3270-3300
  - Print/title + reset handlers (FAB_CUT reset, schedule print) — L5119-5700
  - Main render: dept tab bar + grid (ALL vs dept) — L6353-7180
  - ALL-tab overview render block — L7182-7730
  - FOAM tab sticker/preview render — L7734-7795
  - FAB_CUT tab tiles + FAB_SEW sticker strip render — L7796-7960
  - PACKING tab render — L8078-8370
  - Sticker sizing helpers (FAB_CUT/FAB_SEW large stickers) — L8372-8888
  - FG sticker set: `packingStickerUrl` / `loadFgStickers` (immediate-paint then /p/ upgrade) — L5292-5434
- `src/api/routes/production-orders.ts`
  - PATCH /:id rack-assign — inline rackingNumber UPDATE then `applyPackingRack` (text re-affirm + occupancy) — L4180-4195
  - POST /packing-rack-tokens — authed /p/ token mint (batched: 2 queries + parallel mint) — L6001-6135
- `src/pages/bom.tsx`
  - RoutingPill / WIPCodeBuilder / RawMaterialSelect / MaterialScalingEditor helpers — L568-1092
  - WIPNode (recursive BOM tree node) — L1093-1357
  - BOMTreeView (template tree render, L1 + WIP) — L1358-1718
  - CreateBOMDialog — L1719-2313
  - CollapsibleGroup / SubWIPTree — L2314-2702 (still used by MasterTemplatesDialog; EditBOMDialog no longer renders it)
  - flattenWipTree / wipNodeAt / depthBar — L2690-2752 (two-pane tree helpers)
  - WipNodeDetail (right pane — edits ONE node at any depth) — L2753-2962
  - EditBOMDialog (L1 tab + two-pane WIP tab) — L2963-3892
  - MasterTemplatesDialog (Bedframe/Sofa/Accessory tabs + copy-from) — L3408-4368
  - ProductionTimesDialog (per-dept minute rates) — L4369-4945
  - BatchEditMaterialsDialog — L4946-6165
  - DeptPivotCategoryDialog — L6166-6725
  - BOMManagementPage (default export — page shell, tabs, list) — L6726-7211

**Gotchas**
- index.tsx is 8888 lines, driven entirely by activeTab (dept code: ALL, UPHOLSTERY, PACKING, FOAM, FAB_CUT, FAB_SEW). Almost every column set, row derivation, render block branches on activeTab — never assume one code path. Use the section ranges; don't read end-to-end.
- WIP idempotency: `applyWipInventoryChange` (`production-orders/_helpers.ts`) claims work via a `wip_cascade_log` INSERT-ON-CONFLICT, but ONLY when `options.orgId` is passed — callers without orgId still unguarded (FOAM-326 class). Don't rebuild the table; audit caller coverage. **The ticket names an OCCURRENCE, not a transition (2026-08-08, mig 0222):** key `(org_id, job_card_id, from_status, to_status, attempt)`, and a replay is only recognised when the card's MOST RECENT logged transition is that very same (from → to). The old `(org, jc, from, to)` key made a card completed → reverted → completed collide with its own first ticket, so the redo applied NOTHING while the revert's refund had already run — 792 prod job cards, and the biggest single source of the `wip_items` drift. `attempt` is computed inside the `INSERT … SELECT` so racing callers compute the same value and the unique index admits one. Never re-key this on the transition alone.
- **The WIP→FG boundary is STRUCTURAL, not `departmentCode === 'UPHOLSTERY'` (2026-08-08).** `src/api/lib/wip-expected.ts` is the ONE model of what `wip_items.stock_qty` should be, with exactly two consumers: `settlePoTerminalWip` / `unsettlePoTerminalWip` in the cascade, and `GET /api/inventory/wip/reconcile`. Chains group by `wipKey`; a chain's last stage is its highest-`sequence` card; a SINGLE-card chain is a feeder (the Option-C merged FAB_CUT), not a terminal. On the last stage completing, the PO's own terminal rows AND every upstream row it left standing come off. The rollback mirror walks the identical `byBranch` map the forward consume builds — a refund that reaches further than the consume inflates rows on every revert (it used to). Don't reintroduce a department name here: 108 prod POs end at FAB_SEW / FOAM and had no WIP→FG boundary at all until this.
- wipKey is derived by a SINGLE shared helper `deriveTopLevelWipKey` (FAB_SEW splits on '::'[2], etc.). Never re-implement; stale picks throw at confirm.
- Repair scope: `production_orders.repairscope` stamps partial repairs (FULL=null=byte-identical). Component-scope picks DROP unowned material lines — not cosmetic.
- COMPLETED job_cards / non-PENDING fg_units are inviolate (production locks). Suggest a UI fix instead.
- **A job card now carries TWO completion columns and they mean different things (2026-08-14, BUG-2026-08-13-120).** `job_cards.completed_date` is the DAY the completion is filed under — date-only by design, and depended on by the efficiency scan, the dept sheets, the list filters, the archive union and every `substr(completedDate::text,1,10)` comparison; unchanged. `job_cards.completed_at` (nullable TEXT, ISO-8601, indexed; self-applied by `ensureJobCardCompletedAt`, migration 0228 is the RECORD only) is the INSTANT the system OBSERVED the card complete. **It is written ONLY by the four paths that watch a completion happen** — `/scan-complete`, `/scan-complete-dept`, `/scan-complete-shared` and the office PATCH's auto-stamp (`applyPoUpdate`, `if (isDone)`). Every other writer — a typed date, the Sheets webhook, every import/backfill — goes through `reconcileCompletedAt`, which can only KEEP an existing instant (same day) or DROP it, never mint one. **Historical rows are deliberately NULL and are not backfilled**: the time is gone, and a plausible 09:00 would be C15. The invariant `completedAt travels with completedDate in the SAME statement` is enforced across all of `src/api` by `tests/job-card-completed-at.test.mjs` — a new completion writer fails CI until it is wired. TEXT rather than TIMESTAMPTZ so it is the same shape as `job_cards.distributed_at`, which is what it exists to be subtracted from.
- camelCase DB columns: most at-risk WIP/production cols are dual-keyed (r.camelCase ?? r.snake_case); db-pg toCamel can't recover folded-lowercase camelCase. New columns snake_case; a camelCase write column needs a `column-rename-map.json` entry.
- BOM production-time / minute rates written into `bom_templates.wipComponents` from BOTH bom.tsx (ProductionTimesDialog) and wip-times.tsx/route — keep consistent; feed productionCostRatePerMinuteSen in the PO cost cascade.
- EditBOMDialog's WIP tab is TWO-PANE (2026-08-03): `flattenWipTree` turns the recursive tree into indented rows on the left (selection + collapse, addressed by a `wi.path` key), and `WipNodeDetail` edits the SELECTED node on the right at full width. It replaced an inline recursive render inside a fixed 720px dialog, where each nesting level stole ~20px and the category select clipped to "CAT 3" by level 3, with four clashing background fills stacked inside one another. Depth now reads as a 3px left colour bar. The dialog is `w-[min(1160px,95vw)]` and the WIP tab owns its own scrolling (the body switches to `overflow-hidden` so each pane scrolls independently). Because ONE detail pane serves every depth, EditBOMDialog carries depth-agnostic adapters (`nUpdate`, `nAddProcess`, `nMove`, …) that dispatch on `path.length === 0` between the `xxxWIP(wi,…)` and `xxxAtPath(wi,path,…)` handler families — BOTH families are still live and must stay in sync. MasterTemplatesDialog still uses the old recursive `SubWIPTree`. Pins: `tests/bom-editor-reorder.test.mjs`.
- Sofa combo pricing is BACKEND-unified (`applySofaCombos`) wired into sales-orders POST/PUT — production reads the priced SO; don't re-price in the production layer.
- CNC hierarchy (Model→Size/Seat→Files) is DERIVED on the frontend; cnc_templates has no category column (from products.category) and total_height doubles as sofa seat size. No migration for the hierarchy.
- `production_orders_list_snapshot` is a denormalized snapshot for fast list reads — writes to production_orders must keep it in sync.
- Dept-narrow guard: dept-tab views must not leak cross-dept rows (production-orders-dept-narrow-guard.test.mjs). Overdue counts have ship-exclusion logic the FE grid isOverduePO may lack (known latent gap).
- Overdue chips (filter bar) FILTER THE MAIN GRID (owner 2026-06-23): clicking "Bedframe ⚠ N" / "Sofa ⚠ N" narrows the grid below to that category's overdue set instead of popping a separate SO-list panel (panel removed). The grid filter reuses the SAME server overdue set the chip count comes from — `/api/production-orders/overdue-counts` now returns `overdueBedframePoIds` / `overdueSofaPoIds`; FE builds `overduePoIdSet` (state `overduePanelMode`, kept) and drops rows not in it inside `filteredOrders`, also skipping the date-window while active. Clicking again clears; Clear-all clears it (setOverduePanelMode(null)). Tests: production-overdue-counts.test.mjs (§6). Don't reintroduce the drill-down panel.
- Packing-rack assign → warehouse occupancy (BUG-2026-06-25-007): the office Packing-sheet rack dropdown (PATCH /:id {jobCardId,rackingNumber}), the public /p/ piece-sticker scan, and the worker scan ALL funnel through `applyPackingRack` (`src/api/lib/packing-rack-write.ts`). It used to write ONLY the text rackingNumber (job_cards + production_orders); it now ALSO mirrors ONE `rack_items` row per piece (SET inserts / re-assign MOVES the old row / "" CLEARS, then recomputes `rack_locations.status` via the SAME CASE as DO-dispatch stock-out) so the Warehouse grid shows the piece. The PATCH calls `applyPackingRack` AFTER its inline UPDATE (idempotent text re-affirm + occupancy; best-effort, hot-card only). Piece identity comes from the shared `packingPieceIdentity` (`src/api/lib/packing-piece-identity.ts`) — same formula the /r/ rack-QR scan uses — so office / /p/ / /r/ converge on ONE row (no duplicates; a move finds the old row by productName+notes). Don't re-inline the description/notes formula.
- FG-sticker speed (BUG-2026-06-25-008a): `loadFgStickers` (index.tsx ~L5375) paints the preview IMMEDIATELY with the `/worker/scan` fallback URL, then upgrades QRs to /p/<token> in the background (Print still awaits the enriched set, so the PRINTED QR deep-links /p/<token>). The mint endpoint POST `/packing-rack-tokens` (production-orders.ts ~L6001) replaced its serial per-(poNo,pieceName) loop (~6 DB calls each) with 2 batched queries + a parallel mint — byte-identical output (same pickPackingCard narrowing, null-token guard). Mint is read-auth-gated; the public route only RESOLVES tokens, never mints.

- **`MinimalPOOut`'s key set is now pinned by a test** (`tests/minimal-po-stocked-in.test.mjs`) — dropping a field from `rowToMinimalPO` fails CI with the full list. That guard exists because `stockedIn` was dropped by the 2026-05-23 slim-down and `warehouse.tsx`'s `!po.stockedIn` guard silently became a no-op, letting one delivery be racked twice and write a second `STOCK_IN` (BUG-2026-08-13-050, BUG-CLASS **C16**). The projection still drops `notes` / `rackingNumber` / `createdAt` / `startDate` / `updatedAt`; four consumers read three of those and render `-`, enumerated in C16. **Do not "complete" the projection by adding them all** — `actualMinutes` on the sibling `jobCards-lite` projection must stay dropped (see the ⚠️ OPEN note below).
- PO→job-card assembly on the MINIMAL path is O(N+M) and must stay that way (BUG-2026-08-13-001). `rowToMinimalPO` takes an optional pre-grouped `jcByPoId` map (`groupJobCardsByPoId`); without it, it falls back to a per-PO `jobCards.filter(...)` full scan — 957 POs × 36,796 job cards ≈ 35 M comparisons, measured at **6,473 ms of a 9,587 ms `/planning` cold call**. The non-minimal path was batched back in 2026-05-21 (`rowsToPOsBatch`); the minimal path — which is what `/planning` and `/delivery` use — was not, until now. Keep passing the map at every multi-PO call site; the fallback exists only for single-PO callers (worker scan lookup). Its sibling fix: the no-dept/no-status job-card fetch is scoped by `jcNarrowWhere`, which **reuses the PO query's own `poWhereSql` as a sub-select** (36,796 rows / 30.8 MB → 13,418 / 10.8 MB). Never hand-write a second PO predicate there — a JC fetch scoped to a different PO set than the PO fetch silently drops job cards. Tests: `production-orders-jobcard-grouping.test.mjs`.
- `dueFrom` / `dueTo` do **NOT** filter `targetEndDate`, whatever the comment above them at `src/api/routes/production-orders.ts:791` says (it still reads "Server-side targetEndDate window"; the vars are at `:795`). Since 2026-06-10 the OVERVIEW branch (no `dept`) windows the PO's SO `hookkaExpectedDD` (`ddExpr` in `_helpers.ts`) and the DEPT branch windows that dept's `job_cards.dueDate`. Undated rows pass on both sides deliberately. Also note there is no far-future tail to trim on this dataset — every active PO's expected DD sits inside ~7 months, so a `dueTo` horizon removes ~0.2 % of rows and is not a perf lever (measured 2026-08-13).

**Start here:** Open `src/pages/production/index.tsx` (jump to the activeTab section ranges) for UI and `src/api/routes/production-orders.ts` for the PO/job-card/WIP backend; for BOM tasks start in `src/pages/bom.tsx` + `src/api/routes/bom.ts`.

---

## Inventory

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/inventory/index.tsx` — 3-tab FG/WIP/RM grids (3994) | `src/api/routes/inventory.ts` — aggregate read + drill-downs (661) | `raw_materials` / `rm_batches` | `tests/production-wip-producer-output.test.mjs` |
| `src/pages/inventory/adjustments.tsx` — stock adjustments (769) | `src/api/routes/inventory-wip.ts` — WIP derived view (761) | `fg_units` / `fg_batches` | `tests/cascade-fc-aggregator.test.mjs` |
| `src/pages/inventory/fabrics.tsx` — fabric tracking (707) | `src/api/routes/raw-materials.ts` — RM CRUD + dup-code toggle (776) | `fabric_trackings` / `fabrics` | `tests/hub-cascade-completeness.test.mjs` |
| `src/pages/inventory/stock-value.tsx` — valuation snapshots (1037) | `src/api/routes/rm-batches.ts` — read-only (95) | `stock_adjustments` / `stock_movements` | |
| | `src/api/routes/fg-units.ts` — FG lifecycle + backfills (1216) | `stock_accounts` / `monthly_stock_values` | |
| | `src/api/routes/fabrics.ts` — DEPRECATED (writes 410) (68) | `rack_locations` / `rack_items` | |
| | `src/api/routes/fabric-tracking.ts` — active fabric CRUD (443) | `wip_items` / `cost_ledger` | |
| | `src/api/routes/_fabric-cascade.ts` — internal helper, not mounted (216) | `production_orders` / `job_cards` / `grns` / `delivery_hubs` | |
| | `src/api/routes/warehouse.ts` — racks + movements (801) | `fg_stock_events` (append-only FG ledger, mig 0221) | `tests/fg-stock-events.test.mjs` |
| | `src/api/lib/fg-stock-events.ts` — the FG stock ledger (emit + on-hand set + `balanceDelta`) | | `tests/fg-ledger-reconcile.test.mjs` |
| | `src/api/lib/fg-ledger-reconcile.ts` — events vs units vs cost lots; `scripts/check-fg-ledger.mjs` | | |
| | `src/api/routes/stock-adjustments.ts` — adjustment create/list (567) | | |
| | `src/api/routes/stock-value.ts` (287) / `stock-accounts.ts` (42) | | |
| `src/pages/inventory/StockBreakdownDrawer.tsx` — per-item right-hand drawer | `src/api/routes/stock-breakdown.ts` — `GET /api/stock/breakdown?type=RM\|WIP\|FG&itemId=…` | `cost_ledger` / `rm_batches` / `fg_units` / `wip_items` / `job_cards` | `tests/stock-breakdown.test.mjs` |
| | `src/lib/stock-breakdown.ts` — the pure rules (running balance, reconcilability, doc links) | | |

**Big-file section index**
- `src/pages/inventory/index.tsx`
  - Types — L111-244
  - Mock data generation — L245-707
  - Column definitions (FG/RM/WIP: code/name/category/size/unitM3/stockQty/reservedQty/unitCost) — L708-1083
  - InventoryPage default export — header + tab switcher (TABS at 117) — L1088-2960
  - FINISHED PRODUCTS tab render — L1821-2116
  - WIP tab render — L2118-2171
  - RAW MATERIALS tab render — L2173-2960
  - BatchEditRMDialog component — L2961-3446

**Gotchas**
- fabrics.ts is DEPRECATED: writes return HTTP 410 — all fabric mutation goes through `fabric-tracking.ts`. Don't add write logic to fabrics.ts.
- raw-materials.ts has `_unlock-duplicate-codes` / `_relock-duplicate-codes` one-shot endpoints; the dup-code unique index is intentionally OFF (distinct items BO315-21/23, 9MM AA/AB) — don't relock without owner sign-off.
- fg-units.ts holds `backfill-dedupe-fg-units` + `backfill-hub` one-shot migration endpoints and an optional-Bearer public GET; COMPLETED/non-PENDING fg_units inviolate.
- Stock writes go through stock_movements + stock_adjustments together — a reversal/adjustment must carry batch_no/unit_cost_sen (prior bug B3 dropped these). WIP idempotency guarded via wip_cascade_log only when callers pass orgId.
- index.tsx renders three tabs off one activeTab state; FG/RM/WIP share the column-definition block (L708-1083). It has a local Product type differing from @/types Product — watch category typing under strict tsc.
- camelCase columns in route SQL need a `column-rename-map.json` entry or they 400; prefer snake_case for new inventory columns.
- `_fabric-cascade.ts` is an internal helper (underscore prefix), not a mounted Hono router; covered by cascade-fc-aggregator.test.mjs.
- inventory-wip.ts derives WIP quantities from job_cards/production_orders rather than a stored qty — a computed view; changing production status models affects WIP counts.
- **`GET /api/inventory/wip/reconcile` (2026-08-08) — READ-ONLY, safe any time.** Recomputes every `wip_items` balance from the job cards via `src/api/lib/wip-expected.ts` (the same module the cascade's settle uses, so the fix and the audit cannot drift) and lists the disagreements; `diff = stored − expected`. Totals always cover the WHOLE ledger, never just the returned page. `?limit=N` (0 = all), `?nonZeroOnly`. Prod 2026-08-08: 1,293 of 5,286 codes disagree, net +2,133; of the 1,440 non-zero rows 1,286 are wrong by net +2,145 (2,462 over, 317 under), 162 rows negative — derived on-hand WIP is ≈337 units against a ledger claiming 2,470. `scripts/reset-wip-quantities.mjs` writes the derived value (dry-run default, backs up every prior value first) and is **NOT RUN** — the reset is owner-gated.
- **Stock Breakdown drawer (2026-08-08) — ONE endpoint, ONE component, three types.** `GET /api/stock/breakdown?type=RM|WIP|FG&itemId=…` returns `{ header, lots, movements, cogs }` for all three; only `lots` changes meaning (an `rm_batches` FIFO layer / an `fg_units` piece / a `job_cards` unit of work). **Opened by CLICKING A ROW** on any of the three Inventory tabs (2026-08-08, Houzs parity); the kebab's "Stock breakdown" item was REMOVED once the row click landed (a second door to the thing you are already opening), and with it "View" on the FG and RM tabs, which called the very same handler as "Edit". Double-click still opens that tab's edit / detail dialog, so the row click is deferred `ROW_CLICK_DELAY_MS` (220ms) and cancelled by the second click — otherwise every edit leaves the drawer open behind the dialog. Row→target mapping is `fgBreakdownTarget` / `wipBreakdownTarget` / `rmBreakdownTarget` in `src/lib/stock-breakdown.ts`, not inline in the handler. Presentation follows the Houzs `ProductBreakdownDrawer` (panel title + code chip, uppercase stat cards, accent-bar section eyebrows, IN/OUT pill + signed qty + running column, value-subtotal row); Movements and COGS collapse INDEPENDENTLY and both start open, `pieces` (FG only) starts closed (`toggleBreakdownSection`). **The three types are NOT the same panel (owner 2026-08-08)** — see the next two entries. No `(owned)` qualifier and no Warehouse column — this system has neither consignment stock nor a warehouse dimension. **The running balance is DERIVED, never stored** — `withRunningBalance` (`src/lib/stock-breakdown.ts`) replays the movements, which is the property that stops the `wip_items` drift repeating; don't add a stored column "for speed". Where the data cannot support a figure the response carries a plain-English notice the panel renders verbatim (`header.reconciliation.notice`, `header.ledgerVsOnHand.note`, `header.qtyNote`, `header.valuationNote`) instead of a plausible number. Three known, systematic gaps it reports rather than hides: **RM** — the ledger closes short of on-hand by exactly the opening seed (opening lots were written straight into `rm_batches` with no `cost_ledger` IN row; 278 of 279 materials), and only 37 of 542 referenced GRN documents survive, so most receipts show a number with no link. **FG** — the two ledger legs count different things (FG_COMPLETED books whole units, FG_DELIVERED one row per FIFO slice), so its closing balance is not a piece count; and unit cost falls back to the PO's FG completion while `fg_units.batch_id` is empty. **WIP** — `cost_ledger` WIP rows are keyed by PRODUCTION ORDER and only the `refType='JOB_CARD'` ones can be narrowed to a WIP item (via `job_cards.wip_label`); a per-PO pull drags in every other department's labour on that order (one WIP code touches 696 POs / 9,176 rows, of which 629 are its own). WIP gets NO running balance at all and says why; its COGS is empty by construction.
- **RM: the lots and the inbound movements are ONE section (2026-08-08).** "Stock lots" and "Movements in" listed the same GRN receipts — same dates, quantities, unit costs, GR numbers — down two different query paths (owner: "你的 movement in 还有你的 stock lots 应该要 merge 在一起"). For raw material every inbound movement IS the creation of a lot, so `mergeRmReceipts` (`src/lib/stock-breakdown.ts`, pure + tested) folds them, matched on `batchId`, and ships as `lots`. **Nothing is dropped in either direction, and that is the contract**: a lot with no ledger row (the opening seed, 278/279 materials) keeps its quantities and gets `balanceAfter: null`; a ledger receipt whose FIFO layer is gone keeps its received qty and gets `qty: null` + `valueSen: null` (an absent layer is UNKNOWN, not empty — zero would claim it was consumed, and would silently join the value subtotal). Columns: Received · GR no · Supplier · PO no · Qty (rem / recd) · Unit cost · Value · Running · Age (+ Attributes only when some row has one). **Movements out stays and is legitimately EMPTY** — there is no material-requisition step yet, so a raw material leaves stock at the moment a job consumes it; the panel says that under the empty table rather than leaving a gap somebody chases. Do NOT merge for FG (a per-piece unit is not a movement) or WIP.
- **RM COGS says who and on what.** Columns: Consumed at · Production order · Department · Consumed by · Qty · Unit cost · Total cost · From lot. The row is written by `consumeRawMaterialsForPO` (`src/api/lib/po-cost-cascade.ts`) when the **FAB_CUT job card completes** (moved there from PO completion 2026-05-07), with a fallback at FG completion, `refType='PRODUCTION_ORDER'`. That INSERT names **neither a department nor a worker** — `workerId` is not even in its column list — so both columns render em dashes and a line under the table says why. They exist now because today one BOM completion both ISSUES and CONSUMES the material; when a requisition step splits those events this row is still the one that answers "who used it". Do not derive "FAB_CUT" from the trigger: the FG fallback path fires from elsewhere and the row does not know which wrote it.
- **FG: two movement tables, no stock-lots section, no COGS (owner 2026-08-08).** Movements in = Date · Production order · **Completed by dept** · **Completed by** · Qty · Unit cost · Balance; Movements out = Dispatched · DO no · Sales order · Customer · Qty · Unit cost (no running balance — the two legs do not count the same thing). "Completed by" is `fg_units.upholsteredByName`, **not** `packerName`: a piece is a finished good the moment it is upholstered, packing happens to something already in stock. The department comes off that PO's **UPHOLSTERY** job card — the same rule `deriveFGStock` (`@/lib/fg-stock`) uses to call the row stock at all, not a label pasted on. The per-serial list survives as a **collapsed "Pieces on hand"** section: it is the only per-serial view and the source of the Age (FIFO) and Available · Reserved figures, so it was folded away rather than deleted — raise with the owner before removing it outright. The stat card is **"Available · Reserved"**, matching the Finished Products grid (was "Assigned · Free"); one thing must not have two names on two screens.
- **The product's own details live IN the panel (2026-08-08).** The centred edit dialog's identity/spec fields (category, base model, size code/label, prices, unit M3, fabric usage, SKU code, fabric colour, description) render read-only via `fgProductDetails` (`src/lib/stock-breakdown.ts`) from the SAME product object the dialog fills its form from — deliberately not a second fetch. Code + name are not repeated; the title bar carries them. Off-catalogue `fg-dyn-*` rows get NO details section (their prices are placeholder zeros nobody entered). Editing did not move: an **Edit product** button hands over to that dialog and the drawer reopens after Save/Cancel (`reopenBreakdownAfterEdit` in `index.tsx`). The dialog's **"Source Production Orders" table is GONE** — it listed the production orders the panel's inbound movements already list, from `/api/inventory/fg-source` instead of the cost ledger. That endpoint had no consumer left and is **deleted** (2026-08-08); the cost ledger is the one that reconciles.
- Source-document links resolve through `sourceDocHref`: GRN → `/procurement/grn/:id`, PO → `/procurement/:id`, DO → `/delivery/:id`, SO → `/sales/:id`. **A production order opens its SALES ORDER** (`/production/:id` was deleted 2026-04-26) and **a job card opens its DEPARTMENT BOARD** (`/production/<dept-slug>`) — neither has a detail page. No sales order / no department → no link, deliberately, rather than a dead one.
- **FG on-hand is now an append-only LEDGER, not only a derivation (2026-08-08).** `fg_stock_events` (`src/api/lib/fg-stock-events.ts`, mig 0221 / SQLite 0211, runtime self-applied by `ensureFgStockEventsSchema`) carries ONE immutable row per `fg_units.status` change: unit, from→to, server clock, actor, and the document **TYPE + ID** that caused it (`PRODUCTION_ORDER` / `DELIVERY_ORDER` / `CONSIGNMENT_NOTE` / `DELIVERY_RETURN` / `FG_SCAN` / `OPENING_BALANCE`) — a real joinable id, unlike `stock_movements.reason`, which is a sentence. **`direction` is computed in ONE place** as `onHand(to) − onHand(from)` (`balanceDelta`), never chosen per call site, so Σ direction per product == the on-hand unit count by construction and every reversal is automatically the mirror of the edge it undoes. On-hand set = `PENDING/PENDING_UPHOLSTERY/UPHOLSTERED/PACKED/RETURNED` (RETURNED is IN — every writer of it also credits `fg_batches.remaining_qty` back). **Reversals are COUNTER-ROWS; nothing ever UPDATEs or DELETEs an event** (pinned by a source guard in `tests/fg-stock-events.test.mjs`). Wired into all 14 `fg_units.status` writers across `fg-units.ts` (generate + /scan), `delivery-orders/_helpers.ts` (dispatch / LOADED→DRAFT / cancel / DELIVERED), `consignment-note-shared.ts` (×4), `consignment-notes.ts` (return + convert-to-invoice), `consignments.ts` (delete rollback), `delivery-returns.ts` (return-to-stock). Each site READS the from-side with the SAME predicate its UPDATE uses and appends the event to the SAME batch. `POST /api/fg-units/seed-stock-events?execute=1` writes the one-row-per-unit opening balance (dry-run default) — without it Σ events reads 0 against a real on-hand count.
- **`fg_units.batch_id` is now FILLED — a piece finally knows its cost lot (2026-08-08).** It had existed since 0001_init and was NULL on all 4,866 rows, so the 2,250 `fg_batches` lots (the only place a finished piece's unit cost lives) were unreachable from the piece: no unit cost, no stock value, no age. Write-time: `postProductionOrderCompletion` (`src/api/lib/fg-completion.ts`) stamps it the moment the lot is created — and it now reads ALL of a PO's lots, not `LIMIT 1`, because with one row it cannot tell a clean order from one carrying replay duplicates. Backfill: `POST /api/fg-units/backfill-batch-link?execute=1` (dry-run default, idempotent, only fills a BLANK link) driven by the EVIDENCE LADDER in `src/api/lib/fg-batch-link.ts` — (A) the PO's `FG_COMPLETED` `cost_ledger` rows agreeing on ONE `batch_id` (the only thing that can disentangle the 145 POs carrying duplicate lots), else (B) the PO having exactly one lot; a product-code guard applies to BOTH rungs. **Verified against prod: 4,447 of 4,866 units link (2,472 by ledger, 1,975 sole-lot); 419 stay NULL — 284 whose PO has no lot at all, 133 on multi-lot POs no completion row names, 2 whose lot describes a neighbouring SKU (5543-CNR vs 5543-SQCNR).** A wrong cost link is worse than a missing one — do NOT add a "pick the newest/cheapest lot" rung. 772 of the 2,051 lots behind the links still carry `unit_cost_sen = 0`; that is the pre-existing zero-cost-lot problem and is owner-gated, not a linking bug.
- **The reconciliation is not optional and ships with the ledger** — `src/api/lib/fg-ledger-reconcile.ts`, `GET /api/fg-units/ledger-reconciliation`, `node --import tsx/esm scripts/check-fg-ledger.mjs` (read-only, exit 1 on disagreement, 2 on setup failure). Checks TWO identities per product: `Σ events == on-hand fg_units` and `on-hand == Σ fg_batches.remaining_qty − inFlight(LOADED)`. The in-flight bridge is REAL and named on purpose: `fg_units`/`stock_movements` book a dispatch at LOADED, `fg_batches` books it at DELIVERED. Houzs shipped this same two-ledger shape with no check and the halves diverged in prod. **It is RED on prod today and must stay that way until the owner decides**: 379 `fg_batches` lots hold a NEGATIVE `remaining_qty` (−911 units) and 145 POs carry duplicate lots that double-count output. Do NOT "fix the drift" inside the check.
- `rack_items` (warehouse occupancy) now has TWO writers, not just the /r/ rack-QR stock-in: assigning a PACKING rack via `applyPackingRack` (`src/api/lib/packing-rack-write.ts`) also mirrors one `rack_items` row per piece + recomputes `rack_locations.status` (BUG-2026-06-25-007, see Production module). Both writers share `packingPieceIdentity` (`src/api/lib/packing-piece-identity.ts`) for the row's productName(description)+notes(SO) so they converge on ONE row — don't introduce a third identity formula.

**Start here:** Open `src/pages/inventory/index.tsx` (the 3-tab UI, jump to the relevant tab section), then its backing route `src/api/routes/inventory.ts` or the specific domain route (raw-materials/fg-units/fabric-tracking/stock-adjustments).

---

## Products & MDM

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/products/index.tsx` — 3-way view (SKU Master/Catalog/Maintenance) (5307) | `src/api/routes/products.ts` — core CRUD, nested bomComponents (1245) | `products` / `bom_components` / `dept_working_times` | `tests/bom-explosion.test.mjs` |
| `src/pages/products/catalog.tsx` — model-based photo grid | `src/api/routes/customer-products.ts` — per-customer SKU + overrides (1122) | `product_prices` / `product_dept_configs` | |
| `src/pages/products/bom.tsx` — Master BOM Templates editor | `src/api/routes/bom.ts` — /api/bom=versions, /templates=bom_templates (1438) | `customer_products` / `customer_product_prices` | |
| `src/pages/products/documents.tsx` — Production Docs per-variant | `src/api/routes/bom-master-templates.ts` — master CRUD | `bom_versions` / `bom_templates` / `bom_master_templates` | |
| `src/pages/products/MaintenanceConfigHistoryDialog.tsx` — effective-dated config | `src/api/routes/product-configs.ts` — dept config defaults (88) | `maintenance_config_history` | |
| `src/pages/products/MaintenanceItemHistoryDialog.tsx` — per-item history | `src/api/routes/mdm.ts` — detection-only review queue | `mdm_review_queue` / `kv_config` | |
| `src/pages/products/MasterPriceHistoryDialog.tsx` — master price history | `src/api/routes/maintenance-config.ts` — append-only effective-dated | | |

**Big-file section index**
- `src/pages/products/index.tsx`
  - CategoryBadge helper — L343-355
  - ProductionConfig (per-dept config display) — L356-448
  - CustomerAssignmentsSection (per-customer SKU assignment) — L449-630
  - VariantEditorDialog (add/edit a product variant) — L631-1042
  - MaintenanceView (Maintenance config, Edit/Save/Cancel) — L1043-1752
  - ProductsPage default export (viewMode state at 1756: skuMaster|catalog|maintenance) — L1753-4545
  - SKU Master per-column sort state — L2044-2063
  - SKU Master per-column text filters — L2064+
  - Header + 3-way view toggle buttons — L3024-3062
  - viewMode skuMaster main block — L3063-3390
  - SKU Master subtitle + table block — L3390-3397
  - viewMode catalog → ProductCatalog render — L3398
  - viewMode maintenance → MaintenanceView render — L3401
  - skuMaster table IIFE render — L3405-4423
  - Variant Editor Dialog mount (skuMaster only) — L4424-4545

**Gotchas**
- products.ts returns DENORMALIZED nested arrays: bomComponents + deptWorkingTimes JOINed from child tables, JSON columns subAssemblies/pieces/seatHeightPrices parsed back to objects on read — keep read+write shape symmetric.
- customer_products price-override semantics: NULL in basePriceSen/price1Sen/seatHeightPrices means INHERIT global product price; a non-null value WINS. Don't write 0 when you mean 'inherit'.
- maintenance-config.ts is APPEND-ONLY effective-dated: edits create NEW rows, resolver picks newest WHERE effective_from <= today. Never UPDATE-in-place; same pattern in MasterPriceHistoryDialog.
- Catalog/Modular tiles are AUTO-DERIVED from each distinct baseModel in Products (no dedicated table); photos go through `/api/files` resourceType=modular, not a products column. baseProductCode splits on first dash.
- camelCase columns (basePriceSen, seatHeightPrices) need a `column-rename-map.json` entry or the write 400s; new columns prefer snake_case.
- mdm.ts is DETECTION-ONLY — review-queue merge just closes the flag; it does not rewrite product/customer/supplier rows.
- index.tsx is a 4545-line single page — three views share one ProductsPage via viewMode state (L1756); MaintenanceView (1043) and VariantEditorDialog (631) are large sub-components above the default export, not separate files.
- Product master price lives in `product_prices` (history dialog), per-customer overrides in `customer_product_prices` — two separate price tables; reconcile both when changing pricing.
- `GET /api/products` buckets `bom_components` + `dept_working_times` by productId ONCE and hands `rowToProduct` its own bucket (BUG-2026-08-13-003, class C14). `rowToProduct` still `.filter()`s — as a passthrough, which is what keeps the payload byte-identical — so passing it the WHOLE array again is a silent O(N×M) regression, not a compile error. This is the steepest-slope quadratic in the app: the list has no `LIMIT` and dwts run ~4.65 per SKU, so cost is ~4.65·N² (365 SKUs = 619 K comparisons / 18 ms today; 2,000 SKUs = 18.6 M). Pinned by `tests/list-endpoint-child-grouping.test.mjs`.

**Start here:** Open `src/pages/products/index.tsx` and jump to the viewMode toggle at L~3024 / state at L1756 to find the right view; for API work start in `src/api/routes/products.ts`.

---

## Employees & Payroll

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/employees.tsx` — 9-tab admin shell (11,784) | `src/api/routes/workers.ts` — employee master + salary effective-dating (1047) | `workers` / `worker_salary_history` | `tests/labor-engine.test.mjs` · `tests/virtual-group-window.test.mjs` |
| `src/pages/worker/index.tsx` — worker mobile home | `src/api/routes/worker.ts` — self-service mobile backend (4130) | `departments` / `attendance_records` | `tests/attendance-rules.test.mjs` |
| `src/pages/worker/scan.tsx` — clock/dept-scan/packing (3203) | `src/api/routes/worker-auth.ts` — PIN auth | `working_hour_entries` | `tests/auto-attendance-deduct.test.mjs` |
| `src/pages/worker/pay.tsx` — payslip view | `src/api/routes/attendance.ts` — admin attendance (374) | `payroll_runs` / `payroll_*` (generated) / `payroll_payslips` | `tests/worker-auth.test.mjs` |
| `src/pages/worker/me.tsx` — profile | `src/api/routes/departments.ts` — dept CRUD (431) | `payroll_hour_deductions` | `tests/worker-auth-default-protect.test.mjs` |
| `src/pages/worker/team.tsx` — team view | `src/api/routes/working-hour-entries.ts` — efficiency source (1640) | `leaves` / `worker_issues` | `tests/jc-minutes-total.test.mjs` |
| `src/pages/worker/issue.tsx` — issue submission | `src/api/routes/payroll.ts` — run generation (308) | `public_holidays` (via kv_config['public_holidays']) | |
| `src/pages/worker/login.tsx` — PIN login | `src/api/routes/payroll-hour-deductions.ts` — short-hour dock (418) | `employee_advances` (salary advances) | `tests/employee-advances.test.mjs` |
| | `src/api/routes/employee-advances.ts` — advance CRUD + HR payout listing; maths + runtime self-apply in `src/api/lib/employee-advances.ts` | `payslips.advance_deduction_sen` (mig 0211, runtime ALTER) | |
| | `src/api/routes/department-performance.ts` — read-only aggregate (807) | | |
| | `src/api/routes/leaves.ts` — leave CRUD + `GET /balances` (server-computed) | `workers.annual_leave_entitlement_days` / `.medical_leave_entitlement_days` (mig 0229, runtime ALTER via `src/api/lib/ensure-leave-columns.ts`) | `tests/leave-entitlement.test.mjs` |
| | `src/lib/leave-entitlement.ts` — **the ONE leave policy module** (entitlement, leave year, holiday exclusion); called by `leaves.ts`, `worker.ts` and `employees.tsx` | | |
| | `src/api/routes/payslips.ts` — payslip read/persist (OT buckets) | | |
| | `src/api/routes/leaves.ts` — leave CRUD | | |
| | `src/api/routes/payslips.ts` — payslip read/persist (OT buckets) + `calcStatutory` (EPF/SOCSO/EIS + **PCB**) | `payslips.pcb_status` (mig 0229, runtime ALTER) · `workers.tax_residency` / `tax_category` / `tax_child_relief_sen` | `tests/pcb-calculation.test.mjs` · `tests/pcb-not-fabricated.test.mjs` |
| `src/pages/announcements.tsx` — office compose + per-card **read-receipt panel** (`ReadReceiptPanel`: lazy GET `/:id/acks`, acked/pending lists, **Remind** → POST `/:id/remind`) | `src/api/routes/announcements.ts` — admin + worker sub-apps; auto-translate on POST/PATCH via `src/api/lib/translate-announcement.ts` (Claude, ANTHROPIC_API_KEY). **Read-receipts:** worker POST `/:id/ack` (idempotent upsert), worker GET returns `ackedIds` (SERVER-driven popup gate), admin GET `/:id/acks` (acked-vs-ACTIVE-roster split), admin POST `/:id/remind` (stamps `reminded_at` → re-pop) | `announcements` (snake_case; `translations` JSONB + `reminded_at`, runtime ALTER) · `announcement_acks` (PK `announcement_id,worker_id`; runtime CREATE TABLE) | `tests/announcement-translate.test.mjs` · `tests/announcement-acks.test.mjs` |

**Big-file section index** (re-measured 2026-08-14 — the file is 11,784 lines.
Every number below is the line of the `function` keyword, read out of the file,
not carried forward: the previous stamp was 3 lines light on every entry.)
- `src/pages/employees.tsx`
  - SortableHeader helper (Working Hours grid) — L469
  - TAB 1: Working Hours — flat grid (WorkingHoursTab) — L996-2080 (windowed; see gotcha below)
  - Public Holidays panel (PublicHolidaysCard) — L2082
  - TAB 2: Employee Master (EmployeeMasterTab) — L2345
  - TAB 3: Efficiency Overview (EfficiencyOverviewTab) — L3776
  - TAB: Department Labor (DepartmentLaborTab) — L4341
  - TAB 4: Employee Detail (EmployeeDetailTab, guarded-unmount) — L5318
  - TAB 4b: Department Performance (DepartmentPerformanceTab) — L6024
  - DailyDrillDown helper — L6432
  - RuleDraftExplainer helper (payroll) — L6583
  - TAB 5: Payroll (PayrollTab) — L6653 (+ Advance column / drift banner, 2026-08-07)
  - DepartmentsManager (inside Labor Cost section) — L8234
  - TAB 5b: Labor Cost (LaborCostTab) — L8481
  - TAB 6: Leave Management (LeaveManagementTab) — L10104. **Entitlement is no
    longer a constant in this file** — it is per-worker data and the balance is
    read from `GET /api/leaves/balances`. See `src/lib/leave-entitlement.ts`.
  - TAB 5c: Salary Advances (AdvancesTab) — L10481
  - MAIN PAGE — TABS array L11078, EmployeesPage shell + tab switch L11450+
  - AttLocBadge / PunchThumb helpers — L11163
  - TAB: Attendance (AttendanceTab) — L11218

- `src/pages/worker/scan.tsx`
  - WorkerScanPage — single mobile clock/dept-scan/packing component (Kpi helper at 2791) — L29-2816

**This page's reads are narrow on purpose (2026-08-14, BUG-2026-08-13-110/-104).**
Three of its fetches used to pull whole-org / whole-drilldown payloads and throw
almost all of it away in the browser:
- the page-level KPI cards (L11544) and the Attendance tab's month efficiency
  (L11271) read ONLY `data.totals` off `/api/department-performance`, so both ask
  for `?view=summary`. The **Department Performance tab itself (L6065) must keep
  the FULL payload** — it is the one caller that renders
  `daily[].workers[].jobs[]` when the operator expands a day.
- the Employee Performance tab (L5435) scopes its attendance read with
  `?employeeId=`, matching the `jcUrl` / `wheUrl` lines directly above it.
`tests/dept-perf-summary-projection.test.mjs` locks all four (three positive, one
negative); `tests/dept-perf-summary-red-proof.mjs` is the by-hand mutation harness
that proves those locks can actually go red.

**Gotchas**
- The payroll/cost math is the single most coupled and fragile part. THE engine is `src/lib/labor-engine.ts`; costing divisor logic is `src/lib/costing.ts`. Pay side = unified ÷26 (workingDaysPerMonth) for absence, late/short docks, OT base; hourly = ÷26 ÷ the worker's DAY SPAN (daily hours + lunch, e.g. 9h→÷10). Cost side = ÷ ACTUAL Mon-Sat working days minus holidays (countElapsedWorkingDays / costingDailyRateSen). NEVER revert either to fixed-26 or ÷calendar.
- Day-typed OT: OT splits into weekday(1.5×)/Sunday(2×)/holiday(3×) buckets via dayTypedOt; payslips persist these, premium routes to the dept line not Overhead. Holidays from kv_config['public_holidays']. Weekday-only must stay byte-identical.
- Money rounding shared and load-bearing: roundSen + distributeRoundSen (largest-remainder) in `src/lib/utils.ts`. DeptLabor ties per-dept costs to the integer payroll total via distributeRoundSen (leftover sen → largest-fraction dept). All 3 screens (Payroll / Dept Labor / Labor Cost) reconcile to the sen. Don't add per-screen ad-hoc plugs.
- Salary is effective-dated (worker_salary_history, mig 0153) — never read a single current salary; use GET /salary/effective for a date. join/resign does NO proration; unworked working days dock ÷26 as absences.
- payroll_hour_deductions (mig 0152) and other module tables are runtime self-applied via ensurePendingMigrations, NOT replayed from migration files on deploy — a migration file alone is INERT. Same for employee_advances + payslips.advance_deduction_sen (mig 0211) via `ensureAdvanceTables`.
- **PCB is computed by `src/lib/pcb.ts` and NOWHERE else** (2026-08-14, BUG-2026-08-13-121). It was `pcb: pcbOn ? 0 : 0` in `calcStatutory` until then, so no payslip has ever withheld tax. `resolvePcb` returns a STATUS — `DISABLED` / `COMPUTED` / `ZERO_PROVEN` / `UNKNOWN` — never a bare number, and `pcbSen` is a real withholding only under `COMPUTED`. **A stored `pcb_sen` is unreadable without the `pcb_status` beside it**: NULL (every pre-2026-08-14 row) means nothing was computed, and every screen must ask `pcbHasFigure(normalizeStoredPcbStatus(...))` before printing an amount, else it prints `—`. The three tax-declaration columns on `workers` are NULLABLE WITH NO DEFAULT on purpose — a default would manufacture the declaration. LHDN's method is cumulative across the year, so both payroll paths feed it `loadYtdPcbInputs`; the remuneration basis is `labor.payroll.grossSen` (basic earned + OT, excluding the efficiency allowance — an OWNER decision, see the bug entry). Additional remuneration (bonus), TP1 reliefs, zakat and CP38 are deliberately NOT implemented (`PCB_NOT_IMPLEMENTED`).
- Salary advances are NOT a statutory deduction and NOT an earning: netPay = gross − totalDeductions − advance, and `totalDeductionsSen` stays statutory-only (folding advances in would inflate every YTD/statutory figure). The period an advance belongs to is the month of its `advance_date`. The generated payslip snapshots the figure in `advance_deduction_sen` so editing an advance later cannot move an approved net pay — the Payroll tab shows a red drift banner instead.
- camelCase DB columns are folded-lowercase by toCamel and can silently return undefined (clockinphoto↛clockInPhoto); at-risk cols dual-keyed r.camelCase ?? r.snake_case. New columns snake_case; a write to a camelCase col needs a `column-rename-map.json` entry.
- **The Working Hours grid is WINDOWED and its row heights are hard-coded constants.** Measured on prod 2026-08-13, a month of entries built **695 rows / 46,137 DOM nodes** (every other page in the app is 900-1,900) and a plain scroll froze the renderer for **45 s+** — the owner's "page unresponsive". The 22 API calls totalled 0.17 MB, so none of it was the network. `WorkingHoursTab` now renders only the visible window via `useVirtualGroups` (`src/components/ui/virtual-groups.tsx`, math in `src/lib/virtual-group-window.ts`), and the grid scrolls **inside its own `max-h-[70vh]` box** instead of with the page. It could not use the flat `useVirtualRows`: a worker-day's Date / Employee / Punch cells are one `<td rowSpan>`, so the window snaps to whole GROUPS, and the two row heights differ — `WH_ROW_SOLO_PX = 71` (a one-row group, whose Employee cell stacks the `<select>` above the day-total chip) vs `WH_ROW_SEG_PX = 50` per row from two rows up. **If you change the row markup, re-measure both constants** or the scrollbar drifts. Sorting / filtering / editing are untouched by this: every handler addresses `originalIdx` into the flat `rows` array, and Save All / Print read `rows` / `filteredRows`, never the DOM — so an edit on a row that scrolls out of the window survives.
- employees.tsx Employee Detail tab is intentionally guard-unmounted via {activeTab === 'detail' && ...} (~L11700) — don't refactor to always-mounted.
- UI must be 100% English — no Chinese strings/comments. EmployeesPage tab shell at L11450; add new tabs to both the TABS array (L11078) and the activeTab render block near the end of the file.

**Start here:** Open `src/pages/employees.tsx` (the 11,784-line tabbed shell; `EmployeesPage` at L11450, tab array at L11078, the `activeTab` render block at the end of the file) and jump to the specific tab via the section ranges.

---

## Customers & Platform

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/customers.tsx` — customer hub, nested pricing/maintenance/combos (4473) | `src/api/routes/customers.ts` — customer CRUD (795) | `customers` / `customer_products` / `customer_product_prices` | `tests/customer-notify.test.mjs` |
| `src/pages/settings/Users.tsx` — Users/Org/Mailbox tabs, SUPER_ADMIN-gated (2922) | `src/api/routes/customer-products.ts` — per-customer pricing + bulk (1122) | `customer_hubs` / `delivery_hubs` | `tests/hub-cascade-completeness.test.mjs` |
| `src/pages/settings/index.tsx` — settings shell | `src/api/routes/customer-maintenance.ts` — snapshot mirror (185) | `maintenance_config_history` / `sofa_combo_rules` | `tests/service-hub-chain.test.mjs` |
| `src/pages/settings/organisations.tsx` — sister-company config | `src/api/routes/customer-hubs.ts` — per-customer hubs (75) | `product_prices` / `products` | `tests/sofa-combo.test.mjs` |
| `src/pages/maintenance.tsx` — master variant config editor | `src/api/routes/customer-quotation.ts` — quotation pricing (259) | `users` / `user_invites` / `user_sessions` / `password_reset_tokens` | `tests/worker-auth.test.mjs` |
| `src/pages/maintenance/sofa-combos.tsx` — master combo grid | `src/api/routes/users.ts` — accounts, requireSuperAdmin gate (1037) | `role_permissions` / `kv_config` | `tests/worker-auth-default-protect.test.mjs` |
| `src/pages/maintenance/SofaComboHistoryDialog.tsx` — combo history | `src/api/routes/auth.ts` — login/session/reset (1096) | `email_threads` / `email_messages` / `email_addresses` | |
| `src/pages/mail-center/index.tsx` — Mail Center shell (3389) | `src/api/routes/auth-oauth.ts` (239) / `auth-totp.ts` (549) | `email_attachments` / `email_labels` / `email_address_access` | |
| `src/pages/mail-center/detail.tsx` — thread detail | `src/api/routes/worker-auth.ts` — factory-worker auth (349) | `mail_user_scope` / `audit_events` | |
| `src/pages/mail-center/compose.tsx` — compose | `src/api/routes/mail-center.ts` — email engine (2476) | | |
| | `src/api/routes/files.ts` — generic upload/download (571) | | |
| | `src/api/routes/kv-config.ts` — KV config store (93) | | |

**Big-file section index**
- `src/pages/customers.tsx`
  - Constants + StateBadge (priced-item keys, sofa tiers, badge colours) — L59-173
  - CustomerProductsPanel (per-customer pricing, mirror of Products bulk-edit) — L174-1196
  - CustomerMaintenancePanel (per-customer config snapshot tabs) — L1215-1989
  - CustomerSofaCombosPanel (per-customer combo pricing) — L1996-2352
  - CustomerPriceHistoryDialog — L2353-2875
  - AssignSkuModal — L2876-3077
  - CustomersPage default export (list/KPI/columns/CRUD/context menu) — L3078-3846
- `src/pages/settings/Users.tsx`
  - Role/Dept/Position option constants + DeptBadge — L73-258
  - UsersPage default export (shared state + tab shell) — L259-1897
  - Users tab (account list, invite, disable/reset/delete — SUPER_ADMIN gated) — L1898-2197
  - Org tab (departments + positions) — L2198-2608
  - Mailbox tab (mailbox scope, canManageUsers gated) — L2609-3235
  - Th/Td table cell helpers — L3236-3263
- `src/pages/mail-center/index.tsx` (~2470 lines after the Gmail-view redesign)
  - Dept/mailbox constants (canonical dept mailboxes, panes) + useMailPrefs hook — L180-280
  - ThreadList (density router) + CompactRow / ComfortableRow / RowLead / RowActions — L255-590
  - DraftsList — after the rows
  - MailCenterPage default export (main shell, folders, bulk, fetch, prefs/category state) — ~L850-1770
  - CategoryTabs (All/Primary/Notifications) + ViewSettingsMenu (density/pane/tabs gear) + SegButton — after the main export
  - Sidebar items (FolderItem/MailboxItem/DeptGroup/PersonItem) + LabelManagerDialog + colour swatches
- `src/pages/mail-center/mail-prefs.ts` — localStorage view toggles (density / reading-pane / category-tabs) external store + `classifyCategory` sender heuristic (Primary vs Notifications). All client-side; no backend, no API change.

**Gotchas**
- customer-maintenance.ts is a SNAPSHOT mirror: copies EVERY master maintenance_config_history snapshot per customer and REFUSES to write if the master config is corrupt — don't bypass that guard or write per-customer config directly.
- RBAC is a hard gate: users.ts uses `requireSuperAdmin(c)` on all 7 account mutations — rejects any role != SUPER_ADMIN even with *:*; Users.tsx hides Disable/Reset/Delete/invite unless SUPER_ADMIN. ADMIN deliberately cannot manage accounts.
- Two separate auth systems: auth.ts/auth-oauth/auth-totp (office users) vs worker-auth.ts (factory workers) — NOT interchangeable; worker-auth has a 'default-protect' invariant with its own test.
- camelCase/snake_case: read paths dual-key (r.effectiveFrom ?? r.effective_from ?? r.effectivefrom); any new camelCase WRITE column needs a `column-rename-map.json` entry or it 400s. Prefer snake_case.
- Sofa combo pricing is BACKEND-unified via `applySofaCombos` wired into sales-orders POST/PUT — do NOT re-implement combo math in customers.tsx or maintenance/sofa-combos.tsx; those are config editors only.
- Per-customer product prices (customer_products/customer_product_prices) shadow master product_prices; customers.tsx CustomerProductsPanel intentionally MIRRORS the Products page bulk-edit dirtyEdits pattern — keep in sync, don't fork.
- Customer hubs feed the DO/Service hub chain (delivery_hubs, customer_hubs); hub-cascade-completeness + service-hub-chain tests guard the cascade — editing hub routes can break downstream delivery/consignment integrity.
- Hub deletions are EXPLICIT-ONLY (BUG-2026-07-27-002, `tests/hub-wipe-guard.test.mjs`): customers.ts PUT deletes only ids named in `body.deletedHubIds` and UPSERTs the rest — never reintroduce the replace-diff (it let stale-tab saves wipe hubs). Hub INSERT inherits the customer's org; hub state pickers include SGR (canonical Selangor, `malaysia-states.ts`); scan-PO create shows a confirm gate before creating hub-less SOs.
- /api/files (files.ts) serves customer, product-doc and modular uploads with attachment disposition but `<img src=.../download>` still renders — shared endpoint, don't special-case per resourceType.
- kv_config is a shared generic store (e.g. public_holidays consumed by payroll) — changing its shape can affect unrelated modules.
- **Mail Center permissions are TWO independent layers, and confusing them is the mistake.**
  (1) RBAC `mail-center:<action>` — what you may DO. The action names mislead: `create` is
  SEND (it backs `POST /compose` and `POST /threads/:id/reply`, so it is the send switch);
  `update` is star / mark-read / trash plus editing a label; `delete` deletes a LABEL, not
  mail, and labels are a shared catalogue so one deletion hits everyone. (2) `mail_user_scope`
  — which MAILBOXES you see: `personal` (own alias + `email_address_access` grants) /
  `department` / `company`, defaulting to `personal` when the user has no row. **The table is
  empty on prod and should stay that way** unless someone genuinely must cover a shared box;
  widen one user at a time, never the default. Both layers are bypassed by SUPER_ADMIN by
  design — there are seven of them on prod (owner's decision, 2026-08-19), so neither layer
  constrains that group. Every read handler calls BOTH `requirePermission` and `getMailScope`:
  a permission grant alone must never widen which mailboxes someone sees, and
  `tests/mail-center-rbac.test.mjs` pins that. Configuration (`/addresses`, `/access`,
  `/scope-level`, `/test-inject`) is `requireSuperAdmin`, never permission-gated.
  **2026-08-19: the seed had granted all four actions to all twelve roles**, so every role
  including `WORKER` could send from an @hookka.com address, and `READ_ONLY` — whose only
  member is a person at a customer company — held 75 permissions covering payroll, payslips,
  workers, users and accounting. Corrected by `scripts/fix-rbac-mail-and-readonly.mjs` (the
  grant matrix lives in that file, report-only by default).
- **The sidebar shows only what `GET /addresses` returned.** That endpoint is scoped, so an
  absent mailbox means "not visible to you", NOT "does not exist" — the canonical
  Support/Finance/HR injection (`CANONICAL_DEPT_MAILBOXES`) is therefore SUPER_ADMIN-only.
  Before 2026-08-19 it ran for everyone and labelled the three "not set up", which told a
  Sales user that Finance had no mailbox while `finance@hookka.com` held 1,039 threads.
  Inbound mail has been LIVE since the MX cutover (prod received on 2026-08-19); any copy
  claiming otherwise is stale.
- Mail Center is GMAIL-STYLE with 3 localStorage view toggles (mail-prefs.ts, surfaced via the header "View" gear): density (compact single-line default ↔ comfortable old multi-line cards), reading-pane (split 3-pane default ↔ full-width list that opens /mail-center/:id), category-tabs (All/Primary/Notifications strip, default on). These ARE the owner's "可以开关" — we did NOT fork two full layouts. The category split is a CLIENT-SIDE heuristic (`classifyCategory` over counterpartyEmail: no-reply/system/alert/eservices/statement local-parts + known bank/payment domains → Notifications, else Primary) — NO backend columns, the threads API is unchanged (still GET /threads, 300-row cap). Both row densities share RowLead+RowActions so star/select/hover-actions can't drift. Don't re-add the old single-layout ThreadList; don't move the category heuristic server-side.

**Start here:** For a customer-facing task open `src/pages/customers.tsx`; for users/RBAC/org/mailbox-scope open `src/pages/settings/Users.tsx`; for internal email open `src/pages/mail-center/index.tsx`.

---

## Planning (Production Planning / Scheduling / MRP / Lead Times)

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/planning/index.tsx` — 5-tab PlanningPage (Capacity Overview / Capacity Loading / Lead Times / Master Tracker / Schedule Proposals) + DrilldownModal (4004) | `src/api/routes/planning-schedule.ts` — per-dept daily schedule data (GET /schedule/fabric-cutting, /schedule/:dept) + `computeChainWithAssignments` (Phase-2 engine assignments) + GET /capacity-audit (read-only engine-ceiling vs actual-output reconciliation, over `src/api/lib/planning-capacity-audit.ts`) | `production_orders` (read: active POs, due dates, progress) + `job_cards` (read: rolling actual minutes) | `tests/planning-scheduler.test.mjs` · `tests/planning-capacity-audit.test.mjs` |
| `src/pages/planning/mrp.tsx` — MRP view (reads/posts /api/mrp). Requirements table renders **On Order** (open-PO quantity, added -144) and prints "—" for an unstated MOQ / lead time (-145); reads `meta.onOrderUnresolvedLines` to state when On Order is a floor | `src/api/routes/production-leadtimes.ts` — lead-time config + history (GET /, PUT /settings, PUT /, POST /recalc-all, GET /history, POST /schedule, DELETE /history/:id) | `job_cards` (read: per-PO dept sequence, wipKey, earliest pending due date) | `tests/scheduler.test.mjs` · `tests/planning-production-tile-truthfulness.test.mjs` |
| `src/pages/planning/LeadTimeHistoryDialog.tsx` — lead-time history + scheduled changes | `src/api/routes/mrp.ts` — MRP runs (GET /, GET /runs, GET /runs/:id, POST /). **`onOrder` reads `purchase_order_items` × `purchase_orders`** (open = status NOT IN RECEIVED/CANCELLED/CLOSED), same definition as `src/api/lib/fabric-usage.ts` PO Outstanding. `moq` / `leadTimeDays` are `number \| null` — the binding columns are `NOT NULL DEFAULT 0`, so 0 means unstated. Self-apply adds `mrp_requirements.moq` + `mrp_runs.on_order_unresolved_lines` (migration 0230) | `production_lead_times` (legacy) / `production_lead_times_history` | **NONE.** This row named `tests/scheduling.test.mjs`, which has never existed in this repo; no test references `production_lead_times_history` at all. Nearest neighbours cover the scheduler, not lead-time history: `tests/scheduler.test.mjs`, `tests/planning-scheduler.test.mjs`, `tests/scheduler-sent-lock.test.mjs`. Treat this table as UNCOVERED. |
| `src/pages/planning/dept/_DepartmentSchedulePage.tsx` — shared generic dept-schedule renderer (calendar, by-day lanes, grouped cards) | `src/api/routes/scheduling.ts` — GET /, POST /, GET /capacity | `hookka_dd_buffer_history` (due-date buffer history) | |
| ~~`src/pages/planning/dept/_PlainDeptSchedulePage.tsx`~~ — **DELETED** (chore/dead-code-sweep): all nine dept pages import `_DepartmentSchedulePage`; nothing ever imported the plain-table variant | `src/api/routes/production-orders.ts` — 3903 lines; Planning READS only (Production-owned) | `mrp_runs` / `mrp_requirements` | |
| `src/pages/planning/dept/fabric-cutting.tsx` / `fabric-sewing.tsx` / `wood-cutting.tsx` — dept config shells | `src/api/routes/production-folders.ts` — folder grouping (peripheral) | `kv_config` (public_holidays / schedule settings) | |
| `src/pages/planning/dept/foam-bonding.tsx` / `framing.tsx` / `webbing.tsx` / `upholstery.tsx` / `packing.tsx` — dept config shells | `src/api/routes/schedule-proposals.ts` — Phase-2 due-date proposals (POST /proposals/generate — pause-gated + agent-run-logged, GET /proposals, POST /proposals/approve|reject) over `src/api/lib/schedule-proposals.ts` | `schedule_proposals` / `plan_snapshots` (runtime self-apply) + `job_cards.dueDate` (approve writes) | |
| `src/pages/agents/index.tsx` — Agent Console (SUPER_ADMIN, /agents): status lights, Run now / Pause / Kill all / Rollback last batch / Auto-approve gate, parameter-proposal approvals | `src/api/routes/agent-console.ts` — /api/agents (requireSuperAdmin): GET /status, POST /run-now|/pause|/kill-all|/gate|/rollback-last-batch, GET /config-proposals + POST /config-proposals/decide; libs `src/api/lib/agent-console.ts` (agent_runs/agent_controls + recordAgentRun/isAgentPaused) and `src/api/lib/agent-learning.ts` (P3 learning loop: plan-vs-actual adherence, flexible-handoff drift → config proposals, humane forward-OT ≤2h/day) | `agent_runs` / `agent_controls` / `config_proposals` (runtime self-apply) + `kv_config['planning_capacity']` (config-proposal approve writes chain handoffs) + `audit_events` (one row per console action) | |

**Big-file section index**
- `src/pages/planning/index.tsx`
  - Constants + TABS def (LOADING_CHART windows, TABS, TabId, DEPT route map) — L154-205
  - Master Tracker helpers + TrackerSortIcon component — L206-440
  - PlanningPage component (default export) — state incl activeTab — L441-1863
  - Tab bar render (isActive = activeTab === tab.id) — L1851-1871
  - Tab: Capacity Overview panel — L1876-2361
  - Tab: Capacity Loading (chart) panel — L2362-2619
  - Tab: Master Tracker panel — L2620-2927
  - Tab: Lead Times panel (inline Save Lead Times form) — L2929-3143
  - Tab: Schedule Proposals mount — L3147; ScheduleProposalsTab component — L3208-3505
  - DrilldownModal component — L3507-4004
- `src/api/routes/production-orders.ts`
  - NOTE: 3,944-line route (its helpers were split out into `production-orders/_helpers.ts`, 5,882 lines) — Planning only READS it (production_orders/job_cards for capacity, tracker, lead-time recalc). Not a Planning-owned file; grep targeted handlers rather than reading whole. — L1-3944. **This entry said "7606-line … L1-7606" until 2026-08-14: that is the PRE-SPLIT length, so the range ran ~3,600 lines past EOF — exactly the failure this file's header warns about.**

**Gotchas**
- Backend planning logic lives in `src/api/lib` (NOT routes): planning-capacity.ts, planning-chain.ts, planning-scheduler.ts, lead-times.ts — change schedule/capacity math there, the routes are thin.
- Phase-2 proposals: the chain engine takes an OPTIONAL `collect` callback (ChainInput/SchedulerInput) that emits per-(card, day) assignments — all pre-Phase-2 call sites pass none, so schedules stay byte-identical. job_cards.dueDate is written ONLY through the shared lib `decideProposals` / `applyPendingProposals` (`src/api/lib/schedule-proposals.ts`) — callers: POST /api/planning/proposals/approve, the heartbeat auto-approve drain, and (owner ruling 2026-07-27) the chat tool `decide_schedule_proposals` which hard-requires the operator's explicit in-chat confirm (`confirmed:true`, `tests/assistant-schedule-decide.test.mjs`). Generation stays read-only. `schedule_proposals`/`plan_snapshots` are runtime self-apply tables (ensureProposalTables), NOT migration files.
- Hookka AI chat (assistant.ts + lib/assistant-tools.ts) is READ-ONLY for business documents with ONE exception: the agent-workforce toolset (`agent_overview`/`agent_control`/`teach_agent` v1.9 + `list_schedule_proposals`/`decide_schedule_proposals` v2.0). BUG-2026-07-27-003: the SYSTEM_PROMPT's old blanket "STRICTLY READ-ONLY" clause predated the v1.9 tools, so the model refused every scheduling/teaching ask although the tools existed — when adding assistant capabilities, UPDATE THE PROMPT (module map + intent table + tool reference) in the same PR or the model will never use them.
- planning-chain.ts + planning-scheduler.ts each contain ONE intentional NUL sentinel/separator string (written as the 6-char source escape backslash-u-0000) — never save it as a raw 0x00 byte (a raw NUL makes git/grep treat the file as binary).
- Lead-time recalc (production-leadtimes.ts POST /recalc-all) walks production_orders + every job_cards row and re-derives wipKey — coupled to the shared deriveTopLevelWipKey formula; don't re-implement wip keys here.
- All `dept/*` daily-schedule pages are config-only shells over the ONE shared renderer `_DepartmentSchedulePage.tsx`; layout/column changes belong in the shared file, not per-dept copies.
- index.tsx PlanningPage is one ~3270-line component with TAB-gated render blocks keyed off activeTab — section is selected by the activeTab string, not separate files; edit the matching tab block (line ranges above).
- production_lead_times is legacy; history/buffer tables are the live source. The inline /planning Save Lead Times form and LeadTimeHistoryDialog both hit /api/production/leadtimes — keep them consistent (dialog comment flags this).
- Capacity Loading chart uses working-day (Mon-Sat, Sundays excluded) windows of 14 past / 21 future days (constants at index.tsx:193-194), not calendar days — matches divisor conventions used elsewhere in the ERP.
- Many root-level *.xlsx + scripts/*.py (build_*_xlsx.py, dept_flow_scheduler.py) in the repo are throwaway export/planning-data tooling, NOT part of the app's Planning module — ignore them when editing the module.
- The Capacity Loading chart's 100% line is the ROLLING 7-working-day ACTUAL output; the scheduler's per-department budgets in planning-capacity.ts are hardcoded 2026-06-01 constants (pre-CNC-changeover). GET /api/planning/capacity-audit prints both sides per department (plus an `adaptive` preview and a zero-production-time card count) — run it before touching any capacity constant. `src/api/lib/planning-adaptive-capacity.ts` derives the measured budget with three guard rails (cold-start fallback, ±20%/day drift limit, 3× first-run ceiling) and only writes kv `planning_effective_capacity` when called with `{persist:true}` — the audit previews without writing. Tests: `tests/planning-adaptive-capacity.test.mjs`.
- Scheduler budget UNITS are not uniform: FAB_SEW / FRAMING / FOAM / UPHOLSTERY are minutes/day, FAB_CUT is cut SLOTS/day, WOOD_CUT is SETS/day, PACKING + WEBBING have no budget at all (they ride the upstream unit's day). Only minutes compares across all eight. `src/api/lib/planning-packer.ts` is the shared minutes packer every department is being migrated onto — it is pure (no DB/clock) and carries the owner's OT red lines (≤2h/day, spread flat from day 0, never a spike; what capped OT can't save is REPORTED, not silently scheduled late). Tests: `tests/planning-packer.test.mjs`.
- FAB_CUT bedframe gets `min(laneCap.BEDFRAME, max(1, poolCap(day) - sofaMin))` cuts/day — under the shipped defaults that is 2/day from day 8 on. Raising `reserveTiers` alone changes nothing; `laneCap.BEDFRAME` clamps it (pinned by tests/planning-capacity-audit.test.mjs).
- Before deleting a sales order, run `GET /api/sales-orders/:ref/footprint` (`src/api/lib/order-footprint.ts`, read-only by type — its `DbLike` has no `run`). It reports every row still attached across sales_order_items / production_orders / job_cards / delivery_orders / invoices / cs_promise_log / schedule_proposals and says whether anything BLOCKS deletion. Invoices, delivery orders and unfinished job cards block: they are financial and dispatch evidence, and orphaning them breaks month-end reconciliation irreversibly. An unreadable table makes the report INCOMPLETE, never "safe". The usual right action for a dead order is CANCELLED — both ON_HOLD and CANCELLED are already in `EXCLUDED_ORDER_STATUSES`, so it stops reaching the planner while the audit trail survives. Tests: `tests/order-footprint.test.mjs`.
- **Adding a department is a TWO-SOURCE change.** Departments live in the `departments` table (runtime self-applied in `src/api/routes/departments.ts`), so anything reading `GET /api/departments` picks a new one up for free — sidebar, employee/worker dropdowns, org chart, Employee Master. The SCHEDULER does not read that table: it uses hardcoded rosters, and a code missing from them is dropped with NO error (`if (!chainDept) continue;`). FOAM_CUTTING was added to the table on 2026-07-xx and stayed invisible to planning until 2026-08-03 because of exactly this. When adding a department, update ALL of: `DEPT_CODE_TO_CHAIN` + `DEPT_SLUGS` (planning-schedule.ts), `ChainDept` + its `runFraming` scheduling block + the `collect` emitter (planning-chain.ts), `ChainConfig` capacity/lead fields + defaults + `cloneChain` + `mergeChain` (planning-capacity.ts), `ChainDeptId` + `deptDeadlines` (planning-deadlines.ts), `DEPTS` + `configuredMinutes` (planning-adaptive-capacity.ts), `DEPT_ORDER` + `DEPT_LABELS` (planning-capacity-audit.ts), and the FE `DEPARTMENTS` constant in `src/pages/planning/index.tsx`. The roster assertions in `tests/planning-adaptive-capacity.test.mjs` and `tests/planning-capacity-audit.test.mjs` fail loudly when a department is missing a budget — keep them as rosters, never as counts. Files referencing a dept code for a SPECIFIC RULE (`wip-name.ts`, `qr-utils.ts` FG sentinels, `worker/scan.tsx`) are NOT lists; adding a new code to them is wrong.
- Measured capacity is a TRIMMED MEAN of per-day output over `CAPACITY_WINDOW_DAYS` (60 working days), NOT a 7-day plain mean. Daily output swings 35%-165% of its own average, so a short mean measures which days landed in the window and one bad day drags the whole budget down. Zero-output days are dropped (absence of data, not low capacity), Sundays/holidays are excluded (weekend work must not set the everyday budget), and the top/bottom decile is discarded. `DeptBudget` also reports `sampleDays` / `observedMin` / `observedMax` so the spread stays visible. Tests: `tests/planning-capacity-robust.test.mjs`.
- SENT-LOCK: a job card with `distributedAt` set ("Sent" ticked on the production sheet) has been handed to the floor and its dueDate is COMMITTED — NOTHING may move it, automated or manual. Enforced in every writer: proposal generation (skip), proposal approve (route), auto-apply (`schedule-proposals.ts`), lead-time recalc (`production-leadtimes.ts`), SO-date re-derivation (`sales-orders.ts`), rollback-last-batch (`agent-console.ts`), and the manual PATCH (`production-orders/_helpers.ts` — returns 409). The last four were UNGUARDED until 2026-08-03: recalculating lead times, changing an SO date, or a hand edit silently re-dated work the departments were already building to. The deliberate escape hatch is untick-Sent (in the same PATCH or first), which is an explicit act of pulling the card back. Any new dueDate writer needs `AND (distributedAt IS NULL OR distributedAt = '')`. Exception: `import-completion/fg-fabric.ts` writes dueDate alongside completedDate on ALREADY-COMPLETED cards — no floor confusion is possible there.
- Capacity NUMBERS said in chat go through the `set_capacity` tool (SUPER_ADMIN only), never `teach_agent`. teach_agent stores free text that is injected into an LLM prompt — unbounded, untyped, unaudited — so scheduling arithmetic must not travel that way; `set_capacity` is the validated write into kv `planning_capacity_pins`. It PINS rather than sets, because measured capacity drifts ±20%/day and would otherwise walk a plain "set" back to reality within a week. A pin beats measurement outright (no drift limit, no cold-start fallback) and is clamped to [MIN_PIN_MIN, MAX_PIN_MIN]. Tests: `tests/planning-capacity-pin.test.mjs`.
- WALK-IN RESERVE (2026-08-04, owner: inserts arrive constantly): the first `chain.reserveAfterDay` (3) WORKING days are planned to FULL capacity — that work is imminent and holding room back from it helps nobody — and every day beyond keeps `chain.reservePct` (15%) unplanned so an insert has somewhere to go instead of reshuffling work already promised to the floor. Applied by `dayBudget()` in planning-chain.ts and the mirrored `usable()` in planning-scheduler.ts CNC pass, so ALL departments obey it. It is a ceiling on PLANNING, not a cut in capacity. OVERTIME deliberately ignores the reserve — once a promise is at risk, a hypothetical future order is the wrong thing to protect. Tests: `tests/planning-walkin-reserve.test.mjs`.
- COMMITTED work is PINNED (2026-08-03). `ChainCard.pinnedDue` carries the real day of a card that is already sent to the floor (`distributedAt`) or due inside the 3-day freeze window — the same guard schedule-proposals.ts uses, and the two MUST agree. A pinned unit is placed on that day, charges that day's budget, and is sorted FIRST so it claims its capacity before free work competes for it. Before this the engine re-planned frozen cards and charged their minutes to a day of its own choosing, so the near-term days were handed out twice — the one window where over-commitment cannot be recovered. Pinning is additive: no `pinnedDue` reproduces the old plan exactly. Tests: `tests/planning-frozen-capacity.test.mjs`.
- Foam Cutting is a SOURCE stage: no upstream department (raw foam is simply there), so its floor is day 1 like FAB_CUT / WOOD_CUT. It is pulled back `chain.foamCutLeadDays` (default 1) working days from the day its output is needed — Foam Bonding for sofas, Framing for a bedframe headboard. Owner 2026-08-03: "把它放成 Foam Bonding 的前一天就是了", revisit later. Tests: `tests/planning-foam-cutting.test.mjs`.
- Scheduler rebuild (2026-08-03). MEASURED capacity is now LIVE: `loadChainInputs` resolves `planning-adaptive-capacity.ts` (read-only, no persist) and passes `dailyBudgetByDept` into `computeChain`, which forwards `FAB_CUT` into `runCutting` as `dailyBudgetMin`. Departments on measured minutes: FAB_CUT (slot model → CNC minutes, fabric changeover priced at `cnc.fabricChangeMin`), FAB_SEW, WOOD_CUT (sets → minutes), FRAMING, FOAM, UPHOLSTERY, PACKING (previously had NO budget at all — it inherited the upholstery day, so the plan could not represent a packing bottleneck; now packs forward from that day against a measured budget, floor = upholstery day, no lane split). WEBBING still rides the FRAMING day by design (same team, same day). Per-lane budgets are the measured department total split in the CONFIGURED lane proportions, so the sofa-not-starved rule survives; FAB_CUT's sofa reserve is additionally clamped to ≤30% of the day (an unclamped cut-count reserve exceeds a small measured budget and starves bedframe). Omitting the budgets — or passing 0/NaN — reproduces the legacy run byte-identically; pinned by `tests/planning-chain-adaptive.test.mjs` and `tests/planning-cutting-minutes.test.mjs`. Renderers read caps from `FrameResult.caps` / `WoodResult.inMinutes`, never from `chain.*CapMin`, so displayed capacity always equals scheduled capacity. SLACK PRIORITY is also live: FAB_SEW / WOOD_CUT / FRAMING / FOAM / UPHOLSTERY sort on `slackFor(...)` (backward pass via `planning-deadlines.ts`) then `[cdd, modelKey, soId]`, replacing the old `[cdd, floor, modelKey, soId]` — which broke ties between same-due-date orders on the SO reference string. Undated work carries `UNDATED_SLACK` so it can never displace a promised order. Note the day budget must be resolved BEFORE the sort (slack needs it to size a unit's duration). Pinned by `tests/planning-chain-slack.test.mjs`. All six chain departments now share ONE placement rule, `firstDayWithRoom` in planning-chain.ts — the pin check plus the "an empty day accepts any size" escape (without which the walk never terminates for an oversized unit, and which is also why capacity is a SOFT ceiling). PLANNED OT is now live in the schedule (`placeUnitsWithOt`, 2026-08-03): each department packs once at normal capacity, and only if something lands past its backward-pass deadline is the shortfall spread FLAT across the horizon at ≤`OT_MAX_MIN_PER_DAY` (120, matching agent-learning's OT_MAX_HOURS_PER_DAY) and the department re-packed. If the OT pass rescues nothing it is discarded and the plain plan stands. No day can exceed cap+2h. Applied to WOOD_CUT (minutes mode only — a sets/day cap has no hours to add), FRAMING, FOAM, UPHOLSTERY, PACKING. Pinned units bypass it entirely. Tests: `tests/planning-chain-ot.test.mjs`. The packer's OVERSIZE SPLITTING is deliberately NOT adopted: it contradicts the engine's explicit grouping rule "a whole SO is cut the same day, never split", so OT raises the day's ceiling instead of cutting a unit in half. `planning-packer.ts` therefore remains the standalone reference implementation + its own tests. The forward topology: FAB_CUT -sewHandoff→ FAB_SEW -woodHandoff→ WOOD_CUT -frameHandoff→ FRAMING -foamHandoff→ FOAM (sofa only) -uphHandoff→ UPHOLSTERY → PACKING (same day); WEBBING rides the FRAMING day. Change one side and you must change the other.
- `src/api/lib/planning-late-risk.ts` (GET /api/planning/late-risk, plus section 9 of the morning brief) runs the same chain engine and reports orders whose LAST scheduled operation falls after `customerDeliveryDate − shipBufferDays` (working days). It is the input that makes early, spread OT possible — the brief's section 8 says how much OT, section 9 says which promises are already unreachable. Read-only by type (its `DbLike` deliberately omits `run`). Tests: `tests/planning-late-risk.test.mjs`.
- Proposal approve/reject caps each request at 500 ids (`MAX_IDS_PER_REQUEST`) because it runs one UPDATE per proposal — an unbounded batch killed the Worker on 2026-07-16. That cap used to truncate SILENTLY, so "select all → Approve" reported success while leaving a backlog (the queue once hit 1,715). The route now returns `requested`/`dropped` and the Planning UI chunks at 200 and loops. Do not "simplify" the loop back into a single call.
- planning-chain.ts floor fallbacks are a KNOWN HOLE: when an upstream day is unknown (`cutLastDay`/`sewEnd`/`woodDay` miss), the floor silently becomes day 1 (`reason: "cut-pending-unplanned"`) — so a downstream card can be scheduled before its upstream is planned at all. This fires hardest exactly when FAB_CUT is starved. Fixing it is part of the rebuild; do not "tidy" it into something that hides the case.

- ⚠️ OPEN (found 2026-08-13, decision owed — do NOT silently "fix" by adding the field): **every "actual time" figure on /planning is really the ESTIMATE.** The page reads `jc.actualMinutes ?? jc.estMinutes` in ~10 places (index.tsx:327, 948, 1158, 1503, 1518, 1639, 1695, 1778) but `actualMinutes` is **not in the `jobCards-lite` projection** (`slimJobCardsToPlanningLite`, `_helpers.ts` — its comment says the omission is deliberate), so it is always `undefined` and every `??` falls through to `estMinutes`. The `useActual` flag in `jcMinutes` (index.tsx:947) is therefore a no-op — both branches compute the same number. This is NOT because the column is empty: prod has **4,340 of 36,796 job cards with a non-null `actual_minutes`, 4,289 of them non-zero**, and Planning ignores all of them. Affects Capacity Overview's "Production Time" / Efficiency %, the rolling capacity baseline, and the Capacity Loading chart. Adding the field to the lite projection would change every displayed figure on the page, which is an owner call, not a refactor.

**Start here:** For most Planning tasks open `src/pages/planning/index.tsx` (3709 lines, the 4-tab PlanningPage: Capacity Overview / Capacity Loading / Lead Times / Master Tracker); for per-department daily schedules the real renderer is `src/pages/planning/dept/_DepartmentSchedulePage.tsx` fed by `src/api/routes/planning-schedule.ts`.

---

## Performance / KPI

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/kpi/index.tsx` — three tabs: Library (the catalogue + assign + `SurveyLinkMaker`, the Super-Admin "generate a customer link" box) / People (everyone's score + prev-month delta) / Card (one person's month). Super Admin sees all three; everyone else only their own Card | `src/api/routes/kpi.ts` — `/me`, `/users/:id`, `/library`, `/people`, `/catalog`, `/assignments/:id`, `/kpi/:kpiKey/assignees`, `/checklist/:kpiKey`, `/survey/:kpiKey`, `/survey/:kpiKey/link` (MINT, Super Admin), `/rating/:kpiKey`, `/payout/:id` | `kpi_assignments` / `kpi_periods` / `kpi_checklist_ticks` / `kpi_user_settings` / `kpi_survey_responses` / `kpi_survey_tokens` / `kpi_manual_ratings` | `tests/kpi-module.test.mjs` · `tests/kpi-sql-identifiers.test.mjs` · `tests/kpi-survey-public.test.mjs` |
| `src/pages/survey.tsx` — the PUBLIC customer survey page at `/s/:token`. No login, no shell, mobile-first: five questions × five NAMED rungs, one submit, thank-you | `src/api/routes/public-kpi-survey.ts` — PUBLIC no-login `GET /api/public/survey/:token` (questions + scale ONLY) and `POST` (five answers + optional comment). Single-use token, time-limited | | |
| | `src/api/lib/kpi-catalog.ts` — the 7 KPIs, their scoring type, curve and published rules. THE source of truth; both the ERP UI and the public survey page read questions / scale / checklist items / rating bands from here, never a copy | | |
| | `src/api/lib/kpi-metrics.ts` — one function per KPI's ACTUAL. `customerDeliveryLate` · `setupCompleteness` · `documentsStuck` (composite) · `productionEfficiency` · `serviceCaseResolution` · `checklistProgress` · `surveyMean` · `manualRating` | `products` / `bom_templates` / `delivery_orders` / `invoices` / `service_cases` / `reports_compliance_snapshot` | |
| | `src/api/lib/ensure-kpi-tables.ts` — runtime self-apply. Migrations are inert; every column arrives here | | |
| | `src/api/lib/kpi-survey-token.ts` — mint / URL / state / answer validation for the public survey link | | |
| | `src/lib/kpi-drill.ts` — the "See the list →" contract shared by the card and every landing page: `drillHref` (stamps `{period}`), `narrowToIds`, `serviceCaseCountedIn`, `validPeriod` | | `tests/kpi-drilldown.test.mjs` |
| | Drill-down list endpoints: `GET /api/sales-orders/late-to-customer?period=` (`sales-orders.ts`, before `/:id`, `customerScopeSql` in SQL) · `GET /api/products/setup-incomplete?missing=` (`products.ts`, before `/:id`) | | |

**Read before touching this module:**
- Four scoring types (`AUTO` / `CHECKLIST` / `SURVEY` / `MANUAL`) and six attainment
  curves (`TARGET_RATIO` / `PENALTY_PER_PCT` / `PENALTY_PER_UNIT` / `SURVEY_MEAN` /
  `MANUAL_SCORE` / `COMPOSITE` / `EFFICIENCY_BANDS`). Each is documented at its
  declaration in kpi-catalog.ts with the owner ruling that produced it — read the
  ruling before changing a number, the numbers are not arbitrary.
- **The card iterates ASSIGNMENT ROWS, not `kpisForRole(role)`.** `roles` is a
  suggestion for the picker. Reverting that silently drops any cross-role assignment
  from the person's card while leaving the row in the table (owner 2026-08-07).
- `documents_not_stuck` swallowed the retired `exceptions_cleared`. Its exception half
  MUST keep excluding `soNoInvoice` + `doNotInvoiced`, or one late invoice is charged
  twice — that double count is the whole reason the two were merged.
- Routing lives in `bom_templates.wip_components`, NOT `l1_processes` (near-empty
  legacy column). `setup_completeness` read the wrong one and under-reported by 160 SKUs.
- **`drillPath` must open EXACTLY the rows the card counted, for the card's month.**
  Owner 2026-08-07: 「如果是 showable 的话，就要确保这些全部数据是可以被看到的」.
  All five AUTO links were decorative (BUG-2026-08-07-001) — two `?filter=` params
  nothing read, and `/reports/operations`, a route that has never existed, rendering
  a blank page. The predicate now lives ONCE (`FIRST_DISPATCH_CTE` / `IS_LATE` /
  `SETUP_FIELD_SQL` in kpi-metrics.ts) and is interpolated by both the count and the
  drill-down list, so they cannot drift. `{period}` in a drillPath is substituted by
  `drillHref`; omit it only for a genuinely point-in-time metric. If a page cannot
  honour the filter, DELETE the drillPath — a missing link is honest, a link to
  unfiltered data is not. `tests/kpi-drilldown.test.mjs` checks every drillPath
  against the real route table.
- **Quoted camelCase SELECT aliases only.** Unquoted `AS has_bom` returns as `hasBom`
  and every lookup reads undefined. `tests/kpi-sql-identifiers.test.mjs` guards the
  camelCase-in-SQL half of this across BOTH kpi.ts and kpi-metrics.ts.
- A metric with no data returns `actual: null` and says so. It must never return 0 —
  a zero is a failure, an absence is not, and the score divides by measurable weight only.
- **`/api/public/survey/` is a PUBLIC WRITE surface** (2026-08-07) — the only one in
  this module. The token is the whole credential: 64 hex chars, minted ONLY by the
  Super-Admin `POST /api/kpi/survey/:kpiKey/link`, single-use (claimed by an atomic
  `UPDATE … WHERE used_at IS NULL`) and time-limited. The GET returns the catalogue's
  questions + named scale and NOTHING else — no employee, no customer, no ids, no
  period. Who/which KPI/which month all come off the token's OWN row, never off the
  request body. Widening any of that means updating
  `tests/security-public-endpoints.test.mjs` in the same commit, on purpose.

## Dashboard & Command Center

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/dashboard-b/index.tsx` — the entire Command Center (2576); KPI rail + month switcher + all widgets | `src/api/routes/dashboard-overview.ts` — single GET / (2249), 60s KV-cached, owns ALL dashboard data | `sales_orders` / `sales_order_items` | `tests/snapshot-freshness.test.mjs` |
| ↳ PENDING DELIVERY tile only — **and the `/m` Home card of the same name** (`src/pages/m/screens/Home.tsx`), which folds the identical dispatch chain on top | `src/api/routes/delivery-orders.ts` — `GET /pending-value` (Σ ready-row `valueSen`, server-side). Neither surface may go back to `/ready-planning`: that returns the whole row set to be re-summed in the browser (BUG-2026-08-13-011) | `production_orders` / `job_cards` / `delivery_order_items` | `tests/pending-delivery-value.test.mjs` |
| ↳ `/m` Home **"Orders due this week"** card only (`src/pages/m/screens/Home.tsx`) — URL is the shared `ORDERS_DUE_URL` in `src/pages/m/lib/preload.ts`, imported by both so preload + screen can never warm different cache keys | `src/api/routes/sales-orders.ts` — `GET /?fields=orders-due&top=N` → `soListToOrdersDue` in `sales-orders/_helpers.ts`. Never go back to the BARE `/api/sales-orders` here: that ships 1,342 rows to render 6 (BUG-2026-08-13-013). The sort MUST stay a stable `localeCompare` over rows pre-ordered `created_at DESC, id DESC` — a SQL `ORDER BY` breaks ties under the DB's collation instead | `sales_orders` (+ `sales_orders_list_snapshot`, `cache_key = orders-due:<top>`) | `tests/sales-orders-orders-due.test.mjs` |
| ↓ `/m` Home **Stock alerts** card (`src/pages/m/screens/Home.tsx`) — URL is the shared `STOCK_ALERTS_URL` in `src/pages/m/lib/preload.ts`, imported by both for the same reason as `ORDERS_DUE_URL` above | `src/api/routes/inventory.ts` — `GET /?buckets=rawMaterials`. Never go back to the BARE `/api/inventory`: that is 1.16 MB / three buckets to read one (BUG-2026-08-13-021) | `raw_materials` | `tests/inventory-buckets-projection.test.mjs` |
| `src/pages/dashboard-b/OcrAccuracyCard.tsx` — self-contained OCR-accuracy block at the foot of the Command Center; owns its own fetch and follows the page's `period` selector | `src/api/routes/ocr-accuracy.ts` — `GET /` (`?from=&to=`) | `ocr_*` scan/import audit rows | `tests/dashboard-truthfulness.test.mjs` |
| `src/pages/dashboard-b/charts.tsx` — lazy recharts wrappers (RevenueChart, CustomerPieChart) (240) | `src/api/lib/dashboard-snapshot.ts` — daily snapshot for cumulative revenue | `invoices` / `delivery_orders` / `delivery_order_items` / `consignment_order_items` | `tests/snapshot-freshness-latestts.test.mjs` |
| `src/dashboard-routes.tsx` — maps /dashboard → dashboard-b; redirects legacy /dashboard-b → /dashboard | `src/api/lib/dashboard-state-snapshot.ts` — daily point-in-time state snapshot (upsert on org_id+snap_date) | `production_orders` / `job_cards` / `cost_ledger` | |
| | | `purchase_orders` / `purchase_order_items` / `grns` | |
| | | `products` / `raw_materials` / `workers` / `kv_config` (snapshot/cache storage) | |

**Big-file section index**
- `src/pages/dashboard-b/index.tsx`
  - Header comment + lazy chart imports (RevenueChart, CustomerPieChart) — L1-28
  - Type/interface declarations for overview payload (csRevenueSen, monthlyRevenue, weeklyRevenue, topSellers, monthlySalesByCustomer, fabric) — L29-249
  - Constants: PROD_DEPTS set, DEPT_LABEL map, CUR_YM, PIE_COLORS, brand color tokens — L250-345
  - Small presentational helpers: Spark sparkline, DeltaChip — L346-390
  - KTile (the KPI card component used by the four Command Center cards) — L391-472
  - SectionRowsSkeleton (per-section loading placeholder) — L473-487
  - Modal helper — L488-529
  - MiniTable helper — L530-574
  - SectionTitle helper — L575-599
  - Gauge helper — L600-653
  - DashboardBPage main component — state + month default + parallel staged fetches (ovL/soL/pendingL), Pending Delivery computation, useMemos for pipeline/sparklines/labels — L654-1040
  - JSX: Header — L1041-1064
  - JSX: KPI rail — Sales / Invoices / Pending Delivery / Outstanding cards — L1065-1124
  - JSX: Daily Report (process/SOP exceptions) — L1125-1196
  - JSX: Revenue chart + Plant Load — L1197-1492
  - JSX: Order Pipeline + Worker efficiency — L1493-1632
  - JSX: Revenue by Customer (concentration exhibit, category modes) — L1633-1945
  - JSX: Top sellers (bedframe/sofa) — L1946-2058
  - JSX: Fabric usage (past/next 30d by category) — L2059-2296
  - JSX: Department backlog + Purchasing (to end) — L2297-2469

**Gotchas**
- Naming trap: the file/folder is 'dashboard-b' and the API file is 'dashboard-overview', but this IS the production Command Center on the '/dashboard' route — there is no separate 'dashboard' page. '/dashboard-b' just redirects to '/dashboard' (src/dashboard-routes.tsx:203).
- **Data-truth trap (audited 2026-08-14, `docs/DASHBOARD-DATA-AUDIT.md`):** "Daily Capacity", the Plant Load gauge and "Worker Efficiency" are built on `job_cards.estMinutes` — a dept×category constant from `kv_config['variants-config'].productionTimes`. `actualMinutes` and `productionTimeMinutes` are byte-identical copies of it (`src/api/routes/production-orders.ts:441`), so **no tile here reports a measured duration**, whatever its caption says. Only the Worker-Efficiency DENOMINATOR (clocked hours from `working_hour_entries`) is measured. Also: none of the page's eight `useCachedJson` calls reads `failure`, so a dead fetch still paints `RM 0.00` / `0d` / `0` on the money tiles and the gauge — the Daily Report and OCR tiles were fixed (BUG-2026-08-13-120/-104), the rest are open.
- **Customer concentration is computed SERVER-side (2026-08-14, BUG-2026-08-13-142).** `aovByCustomer` is `.slice(0, 12)`, so the browser cannot see the period's real revenue — the card used to divide the top-3 subtotal by the sum of those same 12 rows and read ~100% by construction. `customerConcentration` in the overview payload carries, per category, `totalSen` / `customerCount` / `largestPct` / `top10Pct` over ALL customers, and the page's single denominator is `concTotalSen`. `shownCustRev` (the old `totalCustRev`) is the visible-rows subtotal and is a FALLBACK ONLY — never a denominator. Tests: the concentration block in `tests/dashboard-truthfulness.test.mjs`.
- The entire backend is ONE GET '/' handler ~2000 lines with no sub-routes — every dashboard number flows through it. It's 60s KV-cached (`dashboard:overview:<org>:v23:<period>` — **bump the version when the payload shape changes**, or a stale body serves a missing field as a blank figure), so edits won't reflect for up to a minute on live.
- Month-awareness is snapshot-driven: current-state-only tables (pending delivery, outstanding) are captured into a DAILY snapshot (dashboard-state-snapshot, upsert on org_id+snap_date). For a PAST month it serves the stored snapshot; never write an old snapshot back as 'today' (guarded in the handler ~line 77). Snapshot freshness is the only thing the two tests cover.
- KPI semantics are owner-pinned (2026-06-12, see MEMORY): Sales = confirmed-SO value; Invoices = invoice-sourced (Σ invoice totals by invoice date, excl. cancelled); Pending Delivery is the consolidated made-but-not-shipped card; Outstanding is point-in-time/'live'. Don't redefine these card sources.
- Sales/Delivery value figures in the overview endpoint are intentionally NOT recomputed live (cached/snapshot) — see header comment at top of dashboard-overview.ts; cross-check with sales-orders stats endpoint which the page also calls for pipeline.
- Frontend fetches are staged (ovL/soL/pendingL) so KPI numbers paint before heavy sections; each section shows SectionRowsSkeleton until its own fetch lands — don't collapse into one fetch.
- recharts is lazy-loaded via ./charts.tsx (~357KB). Keep chart code there, not in index.tsx, or you regress first-paint.

**Start here:** Open `src/pages/dashboard-b/index.tsx` — it IS the Command Center (the `/dashboard` route lazy-loads it); its live data all comes from the single GET handler in `src/api/routes/dashboard-overview.ts`.

---

## Service & Repair

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/service-cases/index.tsx` — Service Cases list (1522) | `src/api/routes/service-cases.ts` — service_cases CRUD + status + photos + stock top-ups (959) | `service_cases` / `service_orders` / `service_order_lines` / `service_order_returns` | `tests/case-pipeline.test.mjs` |
| `src/pages/service-cases/detail.tsx` — Service Case command center (3493) | `src/api/routes/service-orders.ts` — SV-order returns/repair lifecycle + mode/scope (1859) | `sales_orders` (caseid links SV→case; isServiceOrder mode flag) / `sales_order_items` | `tests/repair-scope.test.mjs` |
| `src/pages/service-orders/index.tsx` — SV-order list + CreateServiceOrderModal (1224) | `src/api/routes/sales-orders.ts` — co-owns the SO MODE (isServiceOrder) for the re-export pages | `production_orders` (repairscope) / `job_cards` / `fg_batches` | `tests/service-cases-rootcauses.test.mjs` |
| `src/pages/service-orders/detail.tsx` — SV-order detail (returns, repair scope) (961) | | `stock_adjustments` / `stock_movements` / `cost_ledger` | `tests/service-hub-chain.test.mjs` |
| `src/lib/service-order-modes.ts` — **per-mode line requirements + tolerant catalogue lookup; shared by the Spawn dialog AND the route** (380) | | `products` / `fg_batches` | `tests/service-order-spawn-product.test.mjs` |
| `src/pages/service-order/index.tsx` — thin re-export of @/pages/sales in SV mode (18) | | `consignment_orders` / `products` | |
| `src/pages/service-order/create.tsx` / `detail.tsx` / `edit.tsx` — re-exports of @/pages/sales/* in SV mode | | | |

**Big-file section index**
- `src/pages/service-cases/detail.tsx`
  - ServiceCaseDetailPage (default export — main detail page, header/tabs/orchestration) — L191-811
  - CasePipeline — auto-computed display-only progress stepper — L812-889
  - RootCausePanel — multi root-cause editor with explicit Add/Save — L890-1168
  - IssueDescriptionPanel — editable issue description (5W template) — L1169-1273
  - CategoryDetailsForm — per-category structured second-level inputs — L1274-1834
  - DamagedPartOption type + CaseDamagedPartsEditor — L1835-1948
  - AffectedProductsPanel — attach 0..N product SKUs to the case — L1949-2255
  - StockTopUpPanel — stock-only part top-ups recorded against the case — L2256-2611
  - PhotosPanel — view/add/remove case photos after creation — L2612-2756
  - ActionLogPanel — service-agent action log over case lifetime — L2837-2985
  - SpawnServiceOrderModal — spawn an SV order under this case — L2986-3493

**Gotchas**
- TWO parallel directories with confusingly similar names: src/pages/service-order/* (SINGULAR) = thin re-exports of the Sales pages running in Service-Order mode via useSOMode() (src/lib/so-mode.ts); src/pages/service-orders/* (PLURAL) = a real, separate repair/returns module with its own list+detail. Don't confuse them.
- The /service-order (singular) pages have NO own data model — they hit /api/sales-orders with isServiceOrder:true. Editing service-order behavior often means editing src/pages/sales/* (NOT a fork) or src/api/routes/sales-orders.ts. Memory: 'never fork the 1400-line sales list'.
- sales_orders.caseid (mig 0165) links SV orders onto a case; Replacement Parts on a case = stock_adjustments with reason SERVICE_REPLACEMENT + stock_adjustments.caseid (mig 0164) — NO production order created. Don't route replacement parts through production.
- Repair scope lives on production_orders.repairscope (FULL=null=byte-identical legacy path); component-level picks stored on affectedProducts[].components and resolved via shared deriveTopLevelWipKey — ONE wipKey formula, never re-implement. Stale picks throw at confirm.
- Owner ruling: Service orders price RM 0 by default (auto-pricing fully skipped, BUG-016) — don't reintroduce auto-pricing on SV orders. Locked SO headers (production COMPLETED + DO delivered) cannot be zeroed.
- **What each resolution mode needs from an affected item is `src/lib/service-order-modes.ts`, and BOTH the Spawn dialog and the route call it** (BUG-2026-08-10-001, class C13). Derived from what the mode WRITES, not from taste: REPRODUCE inserts a `production_orders` row (`product_id` is a FK to `products`) and STOCK_SWAP decrements an `fg_batch` (which belongs to one product) → both REQUIRE a catalogue product; REPAIR writes neither → free text is allowed **on purpose**, because a case can be about a unit that was never in our catalogue. Don't re-encode the rule in a screen. `normaliseProductKey` folds to `[A-Z0-9]`, so `1041 (Q)` resolves to `1041-(Q)` — verified zero collisions across all 375 prod codes; a fold that hits several rows is reported ambiguous, never guessed. **Never bind `productId ?? ""` into an id column** — an empty string is not NULL, so a nullable FK still runs its check and rejects.
- Route catch-alls go through `operatorSafeError` (`src/lib/humanize-error.ts`) — a hand-written sentence survives, anything `looksTechnical` is swapped for a plain fallback. Returning `err.message` raw is how a shop-floor user got shown `production_orders_product_id_fkey`; the client's `humanizeError` then correctly buries it under "Something went wrong", which is worse. Refuse BEFORE composing statements so the message can name the line.
- **`/api/inventory` takes `?buckets=<csv>` (2026-08-13).** `finishedProducts` | `wipItems` | `rawMaterials`, comma-separated; omitting the param returns all three exactly as before, and an unrecognised value falls back to all three rather than to an empty page. Every emitted bucket is byte-identical to the unprojected one (same SELECT, same ORDER BY, same row mapper) — `tests/inventory-buckets-projection.test.mjs` pins that, and pins that the unrequested SELECTs do not run. **19 of the 20 request-issuing call sites now name their bucket** (`inventory/index.tsx`'s fallback is the exception — it reads two), and the two that only need it behind an edit toggle / a modal (`procurement/detail.tsx` on `editing`, `suppliers/detail.tsx` on `showSKUForm`) gate the fetch as well (BUG-2026-08-13-020/-021). `invalidateCachePrefix("/api/inventory")` still clears every variant — it matches on `startsWith`.
- **Other narrow reads added the same day:** `GET /api/delivery-orders?fields=case-pipeline&scope=<soIds>` (six columns for the Service Case stepper; a bare `?fields=case-pipeline` with no scope returns `[]` on purpose) and `GET /api/sales-orders?fields=customer-mini` (the eight keys the `/m` customer panel reads; deliberately NOT customer-filtered, because that panel matches on `customerId` **OR** `customerName`). Tests: `tests/service-case-do-scope-equivalence.test.mjs`, `tests/so-customer-mini-projection.test.mjs`.
- `/api/inventory` `finishedProducts` is the **products** table with `stockQty` hardcoded 0 — it is NOT an fg_batches list. Every "FG Batch" picker in this module was feeding `prod-*` ids into a `fg_batches` lookup. The route now derives the batch FIFO from the resolved product (`resolveSwapBatch`) and tolerates a product-id hint; don't "fix" a picker by pointing it back at `/api/inventory` and calling the ids batches.
- `CreateServiceOrderModal` in `src/pages/service-orders/index.tsx` is **dead** — `setCreateOpen(true)` is never called, nothing imports it, and it POSTs without `caseId` (required since 0074). Delete it or rebuild it on the shared module; do not re-enable it as-is.
- **Both Service Case pages fetch production orders SCOPED — never bare.** The Case Pipeline (`src/lib/case-pipeline.ts`) needs `po.jobCards[].completedDate` matched by `salesOrderId` against the case's SV order ids, and both pages used to pull `?fields=minimal&include=jobCards` for the WHOLE org (~2,539 POs with every job card — 30,721 ms cold, past api-client's 30 s global abort, so the pages hung). They now append `&scope=<sv order ids>` (matched against `salesOrderId` in `fetchFilteredPOs`); `detail.tsx` uses one URL (a case has a handful of SV orders), `index.tsx` chunks 100 ids per URL via `cachedFetchJson` because it scopes across every case. **`include=jobCards` must stay** — dropping it silently stalls every case at the "Service Order" stage.
- service_order_returns scrap path (POST /:id/returns/:rid/scrap) writes stock_movements/cost_ledger — integrity-sensitive, mind idempotency.
- UI must stay 100% English; window.confirm replaced by useConfirm; manual-save surfaces here use verifiedSave + unsaved-nav guard (RootCausePanel is the reference impl).

**Start here:** For a typical Service Case task open `src/pages/service-cases/detail.tsx` (the 3493-line command center) paired with `src/api/routes/service-cases.ts`; for repair/return ORDER behavior open the PLURAL `src/pages/service-orders/detail.tsx` + `src/api/routes/service-orders.ts` — and remember the SINGULAR `src/pages/service-order/*` is just a re-export of the Sales pages in SV mode (edit sales-orders.ts / src/pages/sales/* instead).

---

## Reports & Analytics

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/reports.tsx` — tabbed hub (Sales/Production/Inventory/Financial/Employee) (1936) | `src/api/routes/reports.ts` — /api/reports/* efficiency/schedule/overdue (GET+JSON+send) + compliance.json (1016) | `sales_orders` / `sales_order_items` / `invoices` | `tests/efficiency-allowance.test.mjs` · `tests/no-fabricated-efficiency.test.mjs` · `tests/no-fabricated-worker-metrics.test.mjs` · `tests/no-fabricated-financials.test.mjs` · `tests/reports-failed-fetch-is-not-empty.test.mjs` · `tests/production-report-summary.test.mjs` · `tests/cached-fetch-result.test.mjs` |
| `src/pages/daily-report.tsx` — newspaper-style compliance exceptions (1815) | `src/api/routes/dashboard-overview.ts` — single GET / consolidated dashboard payload (2249) | `purchase_orders` / `purchase_order_items` / `purchase_invoices` / `grns` | |
| `src/pages/analytics/forecast.tsx` — demand forecast vs historical sales | `src/api/routes/forecasts.ts` — demand-forecast data (131) | `production_orders` / `job_cards` / `delivery_orders` / `delivery_order_items` | |
| `src/pages/dashboard-b/index.tsx` — experimental Dashboard B / reporting view | | `products` / `workers` / `attendance_records` / `working_hour_entries` / `piece_pics` | |
| `src/pages/dashboard-b/charts.tsx` — lazy recharts/d3 chart chunk | | `departments` / `bom_templates` / `rd_projects` / `cost_ledger` / `per_po` / `kv_config` / `users` | |

**Big-file section index**
- `src/pages/reports.tsx` (1929 lines, refreshed 2026-08-13)
  - Types mirroring API response shapes — L21-163
  - Date helpers — L164-199
  - Fetch-result helper (`firstError`) — L200-213
  - CSV helper — L214-239
  - Shared Components (Spinner / **ReportError** / DateRangeSelector / SummaryCard / ReportTable) — L240-403
  - Tab definitions — L404-423
  - SalesReportTab — L428-658
  - ProductionReportTab — L663-917
  - InventoryReportTab — L922-1055
  - FinancialReportTab (+ `LedgerPl` types) — L1060-1540
  - EmployeeReportTab — L1545-1843
  - ReportsPage (default export, tab router + ?tab= URL sync) — L1844-1929

**Gotchas**
- No page file exceeds the ~2000-line threshold (reports.tsx 1704, daily-report.tsx 1815), so bigFileSections is only provided for reports.tsx as the highest-value map; daily-report.tsx is large but a single page. The 2009-line file is src/api/routes/dashboard-overview.ts, a ROUTE not a page.
- reports.tsx tabs do NOT call /api/reports/* — Sales / Inventory / Financial fetch the source module's own list API (sales-orders, invoices, products, purchase-orders) and summarise client-side. Only daily-report.tsx consumes /api/reports/compliance.json. Don't expect the Reports hub and the reports.ts route to share data shapes.
- **Financial tab: the P&L comes from the LEDGER, and an unsourced line is "—" (2026-08-13, BUG-2026-08-13-009).** `GET /api/accounting/pl` nets the posted `ledger_journal_entries` per account and classifies by that account's own `type` in `chart_of_accounts`; accounts netting to zero are omitted, so the entry count per category IS the provenance and is printed beside each subtotal. **A category with no posted account renders "—", never RM 0.00**, and gross/net profit propagate the dash instead of laundering it. Until this date COGS was `revenue × 0.65` and Salaries/Utilities/Rent/Others were the literals `5000000`/`800000`/`1500000`/`500000` sen. **Do not add a Rent/Utilities grouping** — no such bucket exists in `src/lib/pnl-bucket.ts` (only `OPEX_SALARIES` = `900-S0*` vs `OPERATING_EXPENSE`), and choosing which accounts roll into which is an owner decision. Expense lines are listed under their own code + name. Guarded by `tests/no-fabricated-financials.test.mjs`.
- **The Financial tab's purchase-order card is NOT accounts payable (BUG-2026-08-13-010).** It ages orders that have *not* been received, by `expectedDate` — the opposite population from a payable. It was headed "Accounts Payable Aging" until 2026-08-13. Real AP: `GET /api/accounting/aging?kind=ap` / Accounting › AP Aging.
- **Production tab = ONE server aggregate, never a list read (2026-08-13, BUG-2026-08-13-005).** `GET /api/production-orders/report-summary?from=&to=` returns status counts, the average completion days, the per-department paired efficiency subtotals and the overdue list, all in SQL. It used to fetch bare `/api/production-orders` (2,539 orders × every job card) and add it up in the browser: **30,012 ms, killed by api-client's 30 s `API_TIMEOUT_MS`**, after which the page printed "No data available" over the dead request. `from`/`to` are REQUIRED and 400 if malformed — the endpoint must not be able to become an unbounded scan again. Registered before `/:id`.
- **A failed fetch must never render as an empty result (page-wide rule).** Use `cachedFetchJsonResult` (`src/lib/cached-fetch.ts`) — `cachedFetchJson` returns `null` for a timeout, an abort, a 500 and a `_stub` body alike, so `json?.data || []` silently states "nothing happened in this range". All five tabs branch on `ok`, keep data `null` on failure and render `<ReportError>` (message + Retry + an explicit denial of the "no activity" reading). Tabs with two sources fail as a whole. Pinned by `tests/reports-failed-fetch-is-not-empty.test.mjs`.
- **The same rule one level down: a record that could not be LOADED is not a record that does not EXIST (2026-08-13, BUG-2026-08-13-016, class C15).** `useCachedJson` now returns a `failure: {kind, status, message}` alongside `error`; `kind` is `notFound` **only** for an observed HTTP 404, and `isUnknownOutcome(failure)` is the guard every "…not found" branch sits behind. Detail pages render `<RecordLoadError subject=… failure=… onRetry=…>` (`src/components/ui/record-load-error.tsx`) — the `<ReportError>` of the record surface. Before this, `api-client`'s 30 s abort was swallowed with no error set, so eleven pages printed "Order not found" / "Invoice not found" over dead requests and four hung on "Loading…". **Cancellation (unmount / URL change) stays silent — do not make it noisy.** `cachedFetchJson` (plain) still cannot express the distinction: use the hook or `cachedFetchJsonResult`. Pinned by `tests/record-load-failure-class.test.mjs` (enumerates every consumer; fails on a new unguarded one) + `tests/cached-fetch-result.test.mjs`.
- **Employee tab: every figure names a source; there is no placeholder left (2026-08-13, BUG-2026-08-13-006).** Worker Efficiency / Clocked Hours / Job Cards Completed come from `GET /api/department-performance?view=summary&from=&to=`; the attendance cards come from `GET /api/attendance?from=&to=`. They used to come from `seed(w.id)` — a hash of the worker's primary key — beside hardcoded "Attendance Rate 94.5%" / "Avg Hours/Day 8.7" / "12.5 OT hours". **Attendance Rate is now "—" on purpose**: `attendance_records` gets a row only when somebody punches (2,780 of 2,780 rows in 2026 are `PRESENT`, zero `ABSENT`), so a rate is 100% by construction; absence lives in `labor-engine.ts`. A worker with no clocked time reads "—", never 0%. Tests: `tests/no-fabricated-worker-metrics.test.mjs`.
- **`?view=summary` on `/api/department-performance` is a PROJECTION, not a second computation** (`projectPerformanceSummary`, exported for the test). It drops `daily[].jobs` + `daily[].workers[].jobs` and folds the per-day worker rows into range totals: **9,573 KB → 10 KB** on a 61-day range, identical figures. Applied at BOTH returns (a snapshot hit would otherwise still ship 9.5 MB) and deliberately NOT in the snapshot `cacheKey` — one cached full payload serves both views. Never re-express the efficiency formula here; the /employees drilldown still needs the full shape.
- **Department Efficiency: the recorded minutes are a COPY of the standard minutes.** 4,340 of 36,796 job cards carry a non-null `actualMinutes` (4,289 non-zero) — and on **all 4,289** the value equals that card's own `estMinutes` exactly, all on orders started 2026-04/05. A ratio over them is 100.0% by construction, so `report-summary` also returns `measuredDistinctCards` (recording ≠ estimate; currently 0 org-wide) and the page shows a percentage only when that is > 0, else `"—"` plus the reason. The **Measured Cards** count is still shown. Tests: `tests/no-fabricated-efficiency.test.mjs`.
- **`attendance_records` has NO production/efficiency data — do not build one off it (2026-08-14, BUG-2026-08-13-103, class C15).** `production_time_minutes` was `working_minutes × 0.85` on every row ever written (prod Aug 2026: 180,928/212,850 = 0.85005), `efficiency_pct` was that number ÷ the standard day, and `dept_breakdown` republished it under an empty `productCode`. All four writers — `POST /api/attendance`, `POST /api/worker/clock`, `autoCloseForgottenPunch` (which produced a flat, unvarying **85%**) and the auto-created row in `working-hour-entries.ts` — now leave the columns unwritten, and BOTH readers (`rowToAttendance`, `GET /api/worker/history`) publish `null` / `[]` **unconditionally** because every stored value is fabricated. Column made nullable by `migrations-postgres/0227_*` + the runtime `ensureAttendanceMetricsNullable`. **No pay figure ever read these** (`payroll-hour-deductions.ts` takes only clock in/out; the efficiency ALLOWANCE uses `job_cards.productionTimeMinutes` ÷ `working_hour_entries.hours` — a different column on a different table). The real labour-efficiency metric is `/api/department-performance`, which now also returns `totals.cards` / `totals.measuredCards` so both surfaces can caption it *"standard minutes earned ÷ clocked minutes"* with its actual-capture coverage. Tests: `tests/no-fabricated-attendance-production-time.test.mjs`.
- Heavy business logic lives in src/api/lib/* not in the route file: compliance-report.ts (1519 lines, the Daily Report engine), efficiency-report.ts (644), schedule-overdue-report.ts. The route file (reports.ts, 973) is a thin wrapper around these. Edit logic in lib, not the route.
- Two shared client engines: src/lib/print-report.ts (305 lines, THE dashboard print/report engine — see MEMORY arch_report_print_engine; WYSIWYG, wire onFilteredDataChange for sort-follow) and src/lib/export-report.ts (74, export helper). Reuse these — don't hand-roll print/export. Per-line "Detail Listing" builders live in src/lib/so-detail-listing.ts, doc-detail-listings.ts (PO/GRN/CO/DO) and invoice-detail-listing.ts; the invoice one is paired with invoice-detail-export.ts because the invoice LIST payload ships items: [] and the lines must be fetched per invoice (2026-08-20). The round trip back in is invoice-price-import-sheet.ts (headers by NAME) -> invoice-price-import.ts (the plan, stated as refusals) -> POST /api/invoices/import-line-prices (dry-run by default) -> src/components/invoice-price-import-modal.tsx (no path from the file picker to a write).
- dashboard-b/ is explicitly disposable/experimental and mirrors /dashboard numbers; charts.tsx is lazy-loaded to defer the ~357KB recharts/d3 bundle. Don't import recharts eagerly into index.tsx or you reintroduce the load-order regression.
- reports.ts exposes both HTML/JSON GET pairs AND POST .../send email endpoints (efficiency/schedule/overdue) that pull recipients from kv_config + users — sending touches the email/cron path, not just reads.
- **The brief is HTML-only (2026-08-14, BUG-2026-08-13-143).** `GET /api/reports/brief.json` was deleted: it fed a Command Center card removed on 2026-08-05 and had no caller. `buildBriefJsonCached` and `warmBriefReport` (and its call in `worker.ts`'s warm-lists cron) went with it. **`GET /api/reports/brief` — the HTML one — is LIVE**: emailed 07:00 MYT by `.github/workflows/daily-reports.yml` → `brief-trigger`, and opened in a tab to read/print. `GET /api/delivery-agent/brief.json` is a DIFFERENT live endpoint on a different router — a grep for "brief.json" hits it. Tests: `tests/reports-brief-json-removed.test.mjs`.
- Routes mounted in src/api/app.ts (there is no src/api/index.ts): /api/reports + /api/internal/reports (reports.ts), /api/forecasts (forecasts.ts), plus dashboard-overview.

**Start here:** For a Reports & Analytics task, open `src/pages/reports.tsx` first if it's the tabbed hub UI, or `src/api/lib/compliance-report.ts` if it's the Daily Report / exception logic; the thin route shim is `src/api/routes/reports.ts` and the print/export engines are `src/lib/print-report.ts` and `src/lib/export-report.ts`.

---

## R&D / New-Model Development

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/rd/index.tsx` — R&D home, tabbed views + Create Project dialog (1566) | `src/api/routes/rd-projects.ts` — full R&D lifecycle: CRUD + transitions + pricing + material issuance + labour hours (2261) | `rd_projects` / `rd_prototypes` | No dedicated R&D test files exist under tests/ (verified). R&D module is currently untested. |
| `src/pages/rd/detail.tsx` — single-project dashboard (3143) | `src/api/routes/rd-team-members.ts` — rd_team_members CRUD (feeds labour cost) (305) | `rd_team_members` / `rd_labour_hours` | |
| `src/pages/rd/maintenance.tsx` — R&D Team Members CRUD grid (488) | | `rd_material_issuances` | |
| `src/pages/rd/health.ts` — project health-scoring helper (non-page) (135) | | `stock_movements` (written on material issuance / reversal) | |

**Big-file section index**
- `src/pages/rd/detail.tsx`
  - Helpers + constants (getStageLabels by projectType, makeBlankIssuanceLine, MilestoneStatusChip, ModalOverlay) — L78-221
  - RDProjectDetailPage component start — state, data load, save/edit handlers, status-flip + clone logic — L222-1356
  - Derived totals + photo/crop handlers (issuance totals, cover/milestone photo replace) — L1036-1356
  - Render: Project Info card + Pricing Targets + material-vs-target gauge + R&D Cost Breakdown — L1504-1700
  - Render: Status action buttons (Hold/Resume/Complete/Reopen/Move-to-Draft/advance stage) — L1764-1858
  - Render: Header banner + 2-column layout + Stage Timeline — L1859-1953
  - Render: Clone source card (CLONE projects only) — L1954-2000
  - Render: Milestones (full-width, editable target dates + photos) — L2001-2136
  - Render: Prototypes (split by Improvements / Defects) — L2137-2224
  - Render: Material Issuance Log — L2228-2301
  - Render: Labour Hours table (rd_labour_hours joined to team members) — L2302-2389
  - Render: Right rail (sticky cover + project info) + per-record Audit trail — L2390-2420
  - Edit Project Modal (incl. clone-source fieldset + pricing targets) — L2421-2628
  - Add/Edit Prototype Modal — L2629-2738
  - Issue Material Modal — L2742-end
- `src/pages/rd/index.tsx`
  - Constants + StageProgressBar + ProjectHealthChips — L42-196
  - DraftCard + ProjectCard — L197-484
  - SummaryView + KpiCard — L485-715
  - PipelineView — L716-775
  - ReportsView — L776-983
  - CreateProjectDialog — L984-1489
  - Main page render — tab switcher + activeTab routing (summary/drafts/projects/completed/pipeline/reports) — L1490-1566

**Gotchas**
- Material issuance writes real stock_movements (rd-projects.ts ~lines 1224, 1460, 1699, 1852) and updates rd_projects.actualCost — issuance/reversal must roll back cleanly or you get orphan stock_movements with no matching issuance row. Treat issue-material as an inventory-affecting cascade, not a log.
- Labour cost is auto-computed from rd_labour_hours JOIN rd_team_members: FULL_TIME rows contribute hours*hourlyRateSen; PART_TIME rows contribute ZERO to project cost (rd-projects.ts ~232-281). Don't 'fix' PT contributing 0 — it's intentional.
- Stage labels are project-type dependent: getStageLabels() returns different labels for IMPROVEMENT and CLONE projects (detail.tsx 78-95). CLONE projects also surface a clone-source card + sourcePriceSen fields.
- Pricing-target columns are snake_case in SQL (target_selling_price_sen, target_material_cost_sen, started_at) while most other R&D columns are camelCase (projectId, productCategory). Per the column-rename-map gotcha, prefer snake_case for new columns; camelCase write columns need a rename-map entry or they silently 400.
- **A cancel is UNDOABLE** (owner 2026-08-04: "i silap cancel" … "reverse 或者 undo 这样的意思，不是吗？"). It was terminal (`CANCELLED: []` on SO, service order, and PO `/resume` gated to `from === 'ON_HOLD'`) for one reason only: the cascade was LOSSY — it overwrote every in-flight job card's status with `CANCELLED` and recorded nothing, so WAITING / IN_PROGRESS / PAUSED all collapsed and there was no honest way back. `pre_cancel_status` (snake_case, runtime self-applied on `production_orders`, `job_cards`, `sales_orders`, `service_orders`) is captured IN THE SAME WRITE as the cancel, which makes the reverse exact instead of a guess. Undo restores each row to ITS OWN prior status. Three invariants: COMPLETED/TRANSFERRED work is never cancelled so there is nothing to restore; a row cancelled for another reason has no `pre_cancel_status` and is stepped over (undoing one cancel is not a licence to revive unrelated work); and WIP cost is RE-POSTED (`type <> 'ADJUSTMENT'` rows re-inserted in their original direction) rather than un-deleted, because `cost_ledger` is append-only and hash-chained — both the cancel and the undo stay in the trail. `POST /api/production-orders/:id/uncancel`; SO `CANCELLED → DRAFT|CONFIRMED|IN_PRODUCTION|READY_TO_SHIP` (never SHIPPED+, which has a DO/invoice behind it — that needs a credit note); service order `CANCELLED → OPEN|IN_PRODUCTION|RESERVED|IN_REPAIR`, and a STOCK_SWAP undo re-consumes the fg_batch qty the cancel handed back. Undo buttons on sales detail, service-order detail and the mobile SO screen. Tests: `tests/cancel-undo.test.mjs`.
- **Service CASES are a separate table from service ORDERS** (`service_cases` vs `service_orders`) with their own status enum, route, page and undo — a fix to one does NOT cover the other. Case cancel/undo follows the same `pre_cancel_status` pattern; a case is an operator record so cancelling it spawns nothing to unwind, and the reverse is just the status plus a CLEARED `closedAt` (COALESCE would keep the cancel timestamp and every surface that dates the case would still read it as closed). `CANCELLED → OPEN|IN_PROGRESS`.
- **A cancelled case used to read as still progressing.** The list's Stage column and the detail stepper both come from `computeCasePipeline` (`src/lib/case-pipeline.ts`), which is DERIVED from the case's service orders, their delivery orders and job cards — and it only ever checked `CLOSED`. So a case whose SV order had already been delivered kept reporting "Delivered" after being cancelled, and the cancel was invisible outside the detail badge (owner 2026-08-04: "在外面也看不到这个地方已经变 cancel 了"). The result now carries `cancelled`; the list renders "Cancelled" in place of the derived label and the stepper says the chain stopped. Any new consumer of `computeCasePipeline` must render `cancelled` instead of `label`, not alongside it.
- **`preHoldStatus` was read but never written.** `src/pages/sales/detail.tsx` has decided the Resume target from `order.preHoldStatus` since 2026-04, and nothing ever populated it — so it always fell back to `"CONFIRMED"` and an IN_PRODUCTION order put on hold resumed a stage BACKWARDS, while the confirm dialog announced it as normal. `sales_orders.pre_hold_status` is now written on the way into ON_HOLD, cleared on the way out, and surfaced dual-keyed by `rowToApi`.
- Project status model: DRAFT / ACTIVE / ON_HOLD / COMPLETED / CANCELLED with dedicated transition endpoints (start/hold/resume/complete/move-to-draft/reopen) — change status via these, not a raw PUT, so audit trail + started_at stay consistent.
- No automated tests cover R&D — verify lifecycle + issuance changes manually before shipping.
- Production BOM was removed (Task #8); leftover comments at detail.tsx ~2225 and ~2739 are dead markers, not a missing feature.

**Start here:** For most R&D tasks open `src/pages/rd/detail.tsx` (the 3143-line project dashboard) for UI, paired with `src/api/routes/rd-projects.ts` for the lifecycle/issuance/labour backend; `src/pages/rd/index.tsx` is the entry list page.

---

## Quality, Warehouse, Scanning & Platform

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/quality.tsx` — QC Inspections (Pending/History/Templates) (1063) · `src/pages/worker/qc.tsx` — IPQC on the phone (own dept + today only) | `src/api/routes/qc-inspections.ts` — QC inspections CRUD (qc_inspections + qc_defects) · `worker.ts` GET /qc-today + POST /qc/:id/complete | `qc_inspections` / `qc_defects` / `qc_templates` / `qc_template_items` / `qc_tags` | `tests/qc-wip-completable.test.mjs` / `tests/qc-worker-portal.test.mjs` / `tests/qc-generation-coupling.test.mjs` / `tests/qc-no-retained-sample.test.mjs` / `tests/audit.test.mjs` |
| `src/pages/warehouse.tsx` — Grid / Stock In-Out / Movement History (1559) | `src/api/routes/qc-pending.ts` — generation runs 12:00/16:00 on FOUR rhythms: IQC per receipt DAY×supplier×family (`generateRmForGrns`), STORED per batch ISSUED that day (`generateStoredRmChecks`), WIP per working dept (`stageHadActivity`), FG a RISK-WEIGHTED sample (`generateFgSamples` + `lib/qc-fg-risk.ts`); owns `completeInspection` (shared desktop+phone) + `ensureQcGenerationSchema` | `stock_movements` / `stock_adjustments` / `fg_units` / `grns` / `grn_items` / `cost_ledger` / `rm_batches` / `service_cases` / `bom_versions` | `tests/do-scan-sort.test.mjs` / `tests/qc-rm-families.test.mjs` / `tests/qc-fg-risk.test.mjs` / `tests/qc-wip-templates.test.mjs` |
| `src/pages/do-scan.tsx` — mobile DO sticker scanning | `src/api/routes/qc-templates.ts` — checklist templates (qc_templates + qc_template_items); RM templates carry `material_family` and POST refuses an RM template without one · `src/api/lib/qc-rm-families.ts` — item-group → material-family routing + `pickRmTemplate(templates, family, supplierId, kind)` where kind is INCOMING|STORED · `src/api/lib/qc-fg-risk.ts` — `scoreFgUnit` risk weighting for the OQC draw | `fabric_trackings` / `audit_events` / `edit_presence` / `file_assets` | `tests/dept-scan-split.test.mjs` |
| `src/pages/rack-scan.tsx` — rack QR stock-in; carries pieceNo/totalPieces per line (1249) | `src/api/routes/public-rack-qr.ts` — PUBLIC no-login rack stock-in + /p/ piece-sticker rack-write (auth-bypassed, idempotent); /item + stock-in are PER-PIECE (pieceNo+totalPieces → distinct rack_items row; multi-piece stamps piece_pics.racking_number not card-level) | `kv_config` / `hookka_erp_metrics` / `piece_pics` | `tests/rack-qr-per-piece.test.mjs` / `tests/scan-per-piece.test.mjs` |
| | `src/api/lib/packing-rack-write.ts` — `applyPackingRack` (rack set/clear + `rack_items` occupancy mirror); exports `ensurePiecePicsRackingColumn` (shared mig-0192 DDL) | `rack_items` / `rack_locations` / `piece_pics` | `tests/packing-piece-identity.test.mjs` |
| | `src/api/lib/packing-piece-identity.ts` — `packingPieceIdentity` (shared /p/ + /r/ + office piece identity; appends "· pc N of M" to notes when pieceNo set + totalPieces>1) | | |
| `src/pages/notifications.tsx` — in-app notifications | `src/api/routes/admin.ts` — archive/restore (writes *_archive tables) (2040) | `sales_orders_archive` / `job_cards_archive` / `production_orders_archive` / `sales_order_items_archive` | `tests/security-public-endpoints.test.mjs` |
| `src/pages/maintenance.tsx` — Equipment List / Schedule / History | `src/api/routes/admin-health.ts` — platform health/metrics aggregation (2332) | | `tests/security-permission-matrix.test.mjs` |
| `src/pages/track/index.tsx` — public order/fabric tracking timeline | `src/api/routes/audit-events.ts` — audit log read/write | | `tests/tenant-isolation.test.mjs` |
| `src/pages/admin/health.tsx` — admin health dashboard (1791) | `src/api/routes/presence.ts` — edit-presence (edit_presence) | | |
| `src/pages/settings/index.tsx` — Company/Numbering/Production/System tabs (1069) | `src/api/routes/fe-rum.ts` — frontend RUM perf ingest | | |
| `src/pages/settings/organisations.tsx` — sister-company / org mgmt | `src/api/routes/sheets-sync.ts` — Google Sheets sync | | |
| `src/pages/settings/Users.tsx` — (adjacent; owned by RBAC/Users module) | `src/api/routes/kv-config.ts` — generic KV config (kv_config) / `files.ts` — file assets (/api/files) / `fabric-tracking.ts` — fabric_trackings CRUD | | |

**Big-file section index**
- `src/pages/warehouse.tsx`
  - WarehousePage (root) — L122-1252
  - Grid tab (rack/stock view) — L649-1003
  - Stock In/Out tab — L1004-1197
  - History tab — L1198-1252
  - MovementTable helper — L1253-1368
- `src/pages/admin/health.tsx`
  - Sparkline — L62-94
  - KpiCard — L95-181
  - DailyTrendChart — L182-332
  - HourlyErrorChart — L333-400
  - SectionHeader — L401-421
  - HealthStatusCard — L422-448
  - AdminHealthPage (root) — L449-1791
- `src/pages/settings/index.tsx`
  - SaveToast — L245-278
  - SettingsPage (root, tab state) — L279-1069
  - Company tab (renderCompanyTab) — L1063
  - Numbering tab (renderNumberingTab) — L1064
  - Production tab (renderProductionTab) — L1065
  - System tab (renderSystemTab) — L1066
- `src/pages/quality.tsx`
  - QualityPage (root) — L158-194
  - PendingTab + PendingRow — L215-405
  - DoInspectionForm (subject picker + checklist + submit/skip) — L406-701
  - HistoryTab — L702-770
  - TemplatesTab + TemplateEditor — L771-1077
- `src/pages/rack-scan.tsx`
  - RackScanPage (single component) — L103-1097
- `src/pages/maintenance.tsx`
  - MaintenancePage (root) — L76-356
  - Tab 1 Equipment List — L369-536
  - Tab 2 Maintenance Schedule — L538-713
  - Tab 3 Maintenance History — L715-812

**Gotchas**
- public-rack-qr.ts is auth-BYPASSED via PUBLIC_PREFIXES ('/api/public/rack-qr/'). Any new endpoint added under that prefix is exposed with no login — guard tenancy/idempotency manually. Covered by tests/security-public-endpoints.test.mjs.
- **QC was 100% theatre until 2026-08-07.** Prod: 3,009 inspections, ALL PENDING, ZERO ever completed since the first slot on 2026-04-28. Three independent causes, all now fixed. (1) WIP was UNSUBMITTABLE: `quality.tsx` asked `/api/job-cards?status=IN_PROGRESS&departmentCode=…` but `job-cards.ts` required `picId`, hard-coded `status IN ('COMPLETED','TRANSFERRED') AND completedDate IS NOT NULL`, and never read `departmentCode` — empty dropdown, Submit permanently disabled, and the empty list rendered as the reassuring "No active job cards… Use Skip if no production today". The endpoint now serves BOTH reads (picId = finished cards, departmentCode+status = live cards) and a failed fetch renders as a red ERROR. (2) The shop floor could not REACH QC: "qc" appeared zero times in `src/pages/worker/` and `worker.ts`. Now `/worker/qc` (WIP only, own current dept only, today only, FAIL requires text), surfaced on the worker home only when a slot is actually open. (3) Generation was a BLIND SCHEDULE (`SELECT * FROM qc_templates WHERE active = 1`, 34 rows/day forever). Now gated by `stageHadActivity` — WIP needs a card IN_PROGRESS/PAUSED or completed that day, RM needs a CONFIRMED/POSTED GRN that day, FG needs a unit produced that day; probes FAIL OPEN. Also `inspectionNo` used to COLLIDE (COUNT(*) inside the loop, all INSERTs deferred to one `db.batch()`, so every row in a slot shared one number) — now one allocator per run off the max suffix.
- **FOUR RHYTHMS, ONE CRON — do not "unify" them (owner 2026-08-08, twice).** Generation still runs 12:00/16:00, but each rhythm fires on a different EVENT and answers a different question. **(1) IQC = one inspection per (receipt DAY × supplier × material family)** (`generateRmForGrns`). The batch is the DAY, not the document — "同一天的话，通常是验一次就够了" — so two GRNs of one family from one supplier on one day are ONE inspection carrying BOTH receipt numbers in `source_grn_ids`/`source_grn_nos`; `source_grn_id` stays singular and stays the FIRST receipt so every existing read/index/subject link resolves. **A GRN confirmed later the same day ATTACHES to that inspection while it is PENDING/IN_PROGRESS** (the case that actually happens — receipts trickle in across the day and the cron fires twice); once it is COMPLETED/SKIPPED a late receipt raises a NEW row, because you cannot add goods to a signed record. Idempotency is `(grnId, templateId)` read out of the LIST as well as the singular column. **Two SUPPLIERS on one day stay two inspections** — two batches, two risks, two corrective actions; a claim goes back to a supplier, not to a Tuesday. Lookback 7 days on purpose. A MIXED day raises one inspection PER FAMILY, deliberately not one blended checklist (a single PASS/FAIL lets a fabric finding condemn the timber). **(2) STORED = daily, on the material ISSUED to production** (`generateStoredRmChecks`, `rm_check_kind='STORED'`) — the gap the incoming rhythms leave: "有货到他才有工作，没有货到他就没有工作 … 可是有一些东西还是要 daily 检查的 … 那天用的木头有没有发霉？" Fires on `cost_ledger` RM_ISSUE rows dated today, which name the exact `rm_batches` row FIFO consumed, so it runs on a day nothing is delivered and checks the batch about to go into a customer's sofa. Carries `source_rm_batch_id` + `source_batch_age_days` + the originating GRN. **The draw is by AGE, oldest first**, capped at `STORED_SAMPLE_PER_FAMILY`=2 per family per day, idempotent per (day, batch). One store-CONDITION inspection per day (`qct-st-warehouse`) covers the building and FIFO. **(3) WIP = per working department per run**, unchanged. **(4) OQC = a RISK-WEIGHTED sample of units produced** — see the FG weighting gotcha below.
- **The FG draw is WEIGHTED, and every drawn unit records WHY** (`src/api/lib/qc-fg-risk.ts` `scoreFgUnit`, frozen into `qc_inspections.sample_reason`, rendered by `SampleReasonPanel`). The SHARE was never wrong (`fgSampleTarget`: 10%, floor 1, ceiling 5 per slot per category); the DRAW was — units came back in database order, so a day of repeat production spent the inspection on the model built 400 times. Three signals, weights ADD (a max() would flatten the rare hand-heavy model that ALSO has a complaint, which is the exact unit that should top the draw): **(a) PRIOR SERVICE CASE — strongest**, read off `service_cases` → `service_orders` → `service_order_lines.product_code` AND off the case's source sales order (`sourceType='SO'` → `sales_order_items`, which is how cases logged without a repair order are caught — omitting that shape silently loses the complaints nobody followed up), plus `service_cases.customer_id`; a `root_cause_category` in PRODUCTION/DESIGN/MATERIAL/PROCESS weighs more than TRANSPORT/CUSTOMER because only ours repeats at the bench; repeats add but are CAPPED so one pathological code cannot own the draw forever. **(b) RARITY = COUNT of `fg_units` on that product code over 180 days**, banded — counted, never a hand-kept list. **(c) WORKMANSHIP = `bom_versions.total_minutes` (ACTIVE) against the MEDIAN of the whole active catalogue**, plus `sales_order_items.special_order` and the line notes. **There is NO tufting/button field in this schema** — the only occurrence of the word is a WIP checklist item — so buttoned models are reached via standard minutes and the special-order flag; a tufting spec on the BOM would slot in as one more signal. Every lookup is bounded and caught on its own: a missing signal weakens the ranking and the draw degrades toward the old arbitrary one, never toward generating nothing. Tie-break is the unit id, NOT randomness, so a re-run re-derives the same ranking and a double cron cannot swap the unit out from under the inspector.
- **RM routing is off `raw_materials.item_group`, never off supplier free text** (`src/api/lib/qc-rm-families.ts` `ITEM_GROUP_TO_FAMILY` — the SOLE copy since `src/lib/material-lookup.ts`, which held the forward `CATEGORY_TO_ITEM_GROUPS` map over `mock-data.ts` fixtures and had no importer, was deleted in chore/dead-code-sweep). A new material code inherits the right checklist the moment it is filed in the right group. Ten families, ten templates (mig 0215): FABRIC / PLYWOOD / TIMBER / SOFA_FOAM / BED_FILLER / WEBBING / MECHANISM / PACKING / ACCESSORIES / GENERAL. **Only FOAM/FILLER is split bedframe-vs-sofa** (SOFA-FIL has a stamped density + rebound spec; BED-FILL is fibre measured in GSM and loft — one checklist would be four N/A answers). Fabric is not split (same five observations); webbing and mechanism *cannot* be split because both product lines share one item group (`WEBBING` / `EQUIPMEN`) — those templates carry a PO-line + hand-test conformance item instead (webbing: read the type code, then pull 200mm — elastic springs back, non-elastic barely moves). **`B.OTHERS` is the one ambiguous group** (wood strip AND accessories) and is the only place a keyword probe runs; unrecognised text falls to ACCESSORIES rather than being guessed into a timber checklist. An unresolvable line falls to the GENERAL template — a receipt is never silently uninspected — and `pickRmTemplate` returning null is COUNTED and reported (`rmNoTemplate`), never substituted. `pickRmTemplate(templates, family, supplierId)` already prefers a supplier-bound template: that is the hook for a per-supplier override, and `qc_templates` has no supplier column yet so every lookup lands on the family default.
- **New QC columns are snake_case + runtime self-applied** (`ensureQcGenerationSchema`, awaited at the top of `generatePendingForSlot` and both `qc-templates` write paths): `qc_templates.material_family` / `rm_check_kind`; `qc_inspections.source_grn_id` / `source_grn_no` / `source_grn_ids` / `source_grn_nos` / `source_receipt_date` / `source_supplier_id` / `material_family` / `rm_check_kind` / `source_rm_batch_id` / `source_batch_age_days` / `source_fg_unit_id` / `so_spec` / `sample_reason`. Migrations 0215-0219 carry the same DDL plus the template CONTENT (every INSERT `ON CONFLICT DO NOTHING`, every criteria backfill guarded on `criteria IS NULL` — re-running is a no-op and an owner-edited item is never clobbered). **A migration file alone is inert** — 0215-0219 were run by the owner against prod on 2026-08-08 (251 template items, every one carrying criteria); anything added after that reaches prod only through the self-apply or a hand-run UPDATE. **`STORED` is a KIND of RM check, not a fourth `stage`** — `stage` carries a CHECK constraint and a TS union reaching the worker portal, the shared completion core and every list filter, and a stored check behaves exactly like an RM check in all of them.
- **An RM or FG slot arrives with its subject ALREADY NAMED** — `quality.tsx` renders the receipt / batch / unit banner instead of a dropdown, and skips the `/api/raw-materials` and `/api/fg-units` fetches entirely. An IQC banner lists EVERY GRN in the day's batch; a STORED banner prints the batch's days-in-store and the GRN it arrived on; an FG banner adds `SampleReasonPanel` (why this unit was drawn) above `SoSpecPanel` (what the order asked for). Only WIP still asks the inspector to pick. Picking "some raw material" out of a list of every material in the company was never a record of anything.
- **One completion core, two surfaces.** `completeInspection()` in `qc-pending.ts` owns the FAIL side-effects (qc_tags + qc_defects + JC → BLOCKED + piece_pics clear + parent-PO recompute) and is called by BOTH `POST /api/qc-pending/:id/complete` and `POST /api/worker/qc/:id/complete`. Do NOT re-implement it on a new surface: a caller that skips the piece_pics clear resurrects a QC-blocked card on the next scan (BUG-2026-06-08). A FAIL with no notes is refused there, so it is refused everywhere.
- **THERE ARE NO RETAINED SAMPLES — never write a criterion that compares against one** (owner 2026-08-08: "留样登记应该就不需要了，因为我们正常都不会做留样登记的"). No retained-sample / swatch / golden-sample table exists; `po_scan_samples` / `supplier_scan_samples` are OCR training data for the document scanner and are nothing to do with quality. 0215/0217/0219 seeded **17** items telling the inspector to compare against a filed reference, which made every one of them unanswerable — the same fault (an item nobody can answer is an item everybody ticks) that the whole rebuild existed to remove. **mig 0220** rewrites all 17 onto four comparators that physically exist: **(a) the paperwork** (PO line / BOM / sales-order line / spec drawing / cutting marker), **(b) the delivery against itself** (roll to roll, panel to panel — the colour step INSIDE one job is what a swatch was really guarding), **(c) the previous batch still in the rack** (with an explicit N/A when there is none), **(d) an absolute measurement or hand test** (mm, a defect count, tear a corner, pull 200mm — elastic springs back, non-elastic barely moves). Two items were re-POINTED rather than reworded because the obvious rewrite duplicated a neighbouring item: `qcti-rmf-9` (was "cut and file a retained swatch", an instruction to perform a registration this factory does not do) is now shade continuity against the roll already in store, and `qcti-stf-3` is now the dye-lot in the rack because outer-vs-inner layer is already `qcti-stf-4`. Every 0220 statement is guarded on the row STILL mentioning a retained sample, so an owner edit is never clobbered and a re-run is a no-op. **Prod was seeded before 0220 existed — the owner runs those UPDATEs by hand.** `tests/qc-no-retained-sample.test.mjs` replays 0068+0215-0220 into each item's FINAL text and fails on any of retained / swatch / reference sample / reference unit / golden sample (note: "SAMPLE: 5 sheets" is a sample SIZE and is exactly what these criteria should say — only the reference phrases are banned).
- **WHO and WHEN are the server's, never the body's.** `completedAt` = the server clock inside `completeInspection`; `inspectionDate` = the server-computed slot date stamped at generation and `COALESCE`d (never overwritten) on completion, so a Monday slot answered on Tuesday still reads Monday and `completedAt` says when it was actually signed; `inspectorId`/`inspectorName` = `sessionInspector(c)` on the desk (`c.get("userId")` → `users.displayName`/`email`) and `auth.workerId`/`auth.worker.name` on the phone. **`POST /api/qc-pending/:id/complete` and `/:id/start` no longer read inspector identity from the request JSON** — until 2026-08-08 they did, and `quality.tsx` posted `me.displayName ?? me.email ?? "QC"`, so a quality record could be signed by the literal string "QC". A signature the client chooses is a claim, not a record. `CompleteInspectionInput` documents this: do not wire a new surface to pass a client-supplied name through it. **Per-item answer times do NOT exist**: `qc_inspection_items` has `result` / `notes` / `photoUrl` and no `answered_at`, and adding one is a column, not a fix — the inspection header carries the time.
- **A FAIL REQUIRES A PHOTO; a PASS does not** (owner 2026-08-08: "全部东西都要有照片、有记录"). Refused in `completeInspection` — the core, not the screen — so the phone posting to the same endpoint cannot skip it. `qc_inspection_items.photoUrl` had been plumbed end to end since the rebuild (written in `completeInspection`, echoed by `rowToInspection`, forwarded by `quality.tsx`) with **no uploader on either surface**, so it was always null: a plumbed field nobody can reach is not a record. Capture is a plain `<input type="file" accept="image/*" capture="environment">` on BOTH `src/pages/quality.tsx` and `src/pages/worker/qc.tsx`, compressed by `@/lib/image-compress` (`maxDim 1280`, `quality 0.7`) into a **JPEG data URL stored in the TEXT column** — the same path `service_cases.issue_photos` and `worker_issues.photoDataUrl` already use. **Deliberately NOT `/api/files`**: that route is `requirePermission(c, "files", "create")` behind the session cookie and would 401 an X-Worker-Token request, and the phone is the surface that matters (the inspector is at the bench with the defect in front of them). The core also rejects a non-image / oversized attachment (`photoProblem`, 3 MB of base64) and accepts an `https://` URL, so moving the desktop to `/api/files` later needs no change here. The worker route must keep forwarding `photoUrl` — it silently dropped it while building the items array until 2026-08-08. History (`quality.tsx` HistoryTab) has a Photos column and a click-to-open per-item panel, because a picture nobody can look at afterwards is not a record either.
- **The worker QC endpoints are token-guarded, not public.** `/api/worker/*` is NOT in PUBLIC_PREFIXES — `getWorker()` / X-Worker-Token is the credential. The completion additionally re-checks the inspection's department against the caller's CURRENT dept AND that the named job card is live in that same dept, because a WIP FAIL is a WRITE against whatever id you hand it.
- **`POST /api/qc-pending/bulk-skip` exists and has NEVER BEEN RUN.** It is the reviewed way to retire the 3,009-row legacy backlog: dry-run unless `confirm:true`, `beforeSlotIso` + a >=10-char `reason` both mandatory, only touches PENDING/IN_PROGRESS. Clearing the backlog is the owner's call.
- QC Phase 2 is DESCOPED (memory project_qc_phase2_descoped): qc_tags rows still get written on FAIL but owner does NOT want them surfaced in Inventory or as DO warnings. Don't re-surface qc_tags.
- **WIP templates check the DEPARTMENT, not the batch** (mig 0219). 0068 left all 11 at 3-5 bare phrases with NULL criteria — "Stitch consistency", "Overall finish look acceptable" — which is a list people learn to tick. Every item now states HOW, HOW MANY and what to WRITE DOWN, and the items added are METHOD + CONFORMANCE: built to the document not to memory (the marker/cut list for THIS model is at the station), the first-off measured before the batch ran (cutting stations), the process STEP actually performed (glue before fastening, corner blocks, centre rail, locked seam ends), the tolerance as a number, and the station's known expensive-later defects (nap reversal at Fab Cut is a re-cut; at Packing it is a rebuild). The two 0068 OPINIONS are re-stated as measurements, guarded on the old text. `tests/qc-wip-templates.test.mjs` parses the migrations and fails the build if any WIP item loses its criteria, records nothing, or reads as an opinion.
- files.ts serves images via attachment Content-Disposition yet <img src=/api/files/:id/download> still renders — relied on by the Products Catalog modular photo grid. Don't change disposition.
- rack stock-in is move-aware and idempotent (writes fg_units / job_cards). WIP idempotency uses wip_cascade_log claim (created at runtime, opt-in via orgId) — see arch_wip_idempotency_gap; don't double-apply.
- THREE paths put a piece into a rack and must agree on its `rack_items` identity (BUG-2026-06-25-007): the office Packing-sheet dropdown + the /p/ piece-sticker scan + the worker scan all funnel through `applyPackingRack` (`packing-rack-write.ts`); the /r/ rack-QR "scan items" stock-in goes through `public-rack-qr.ts` (resolve + `currentRackOfPiece` + `pieceNotes`). All four sites call `packingPieceIdentity` (`packing-piece-identity.ts`) for `description`(=rack_items.productName) + `notes`(="SO <no>") — the move-match key. Before this only /r/ wrote rack_items, so an office/worker-assigned piece never showed in the Warehouse grid. Don't re-inline the formula or a re-assign MOVE can't find the old row (= duplicate).
- CSRF is GLOBAL, not per-call: `src/lib/api-client.ts:58` monkey-patches `window.fetch` to auto-inject `X-CSRF-Token` on EVERY mutating /api/* request (unless the caller already set it) + `credentials:'include'`. So NO raw fetch is ever "missing CSRF" — an audit flagging "N fetches missing the CSRF token" is ALL false positives; do NOT add `csrfHeaders()` to "fix" it (a patchRack CSRF "fix" shipped then proved a no-op for exactly this reason).
- QR/sticker URLs encode `window.location.origin` (the PRINT-TIME domain): `packingStickerUrl` / `packingRackScanUrl` / the DO-QR / the rack-QR all embed whatever host the sticker was printed from (erp.hookka.com prod custom domain, the old hookka-erp-testing.pages.dev fallback, or staging.*). Scanning is PATH-BASED + domain-agnostic — it resolves against the DB of whatever site you scan ON, so a prod-printed token scanned on staging FAILS (different DB). The prod fallback origin IS now canonicalized → erp.hookka.com on every QR / printed link (src/lib/app-origin.ts canonicalizeOrigin/appOrigin, 2026-06-26); staging/preview/localhost unchanged. erp.hookka.com is treated as prod (worker.ts isPreviewHostname → custom domain = prod).
- Codes are ALWAYS-SCANNABLE, NO time expiry (owner ruling 2026-06-26): the old "QR expired / scan failed" was never a timer — it was STRUCTURAL resolution failures (archived cards under the hot-only query, re-exploded/edited orders whose old card was deleted+rebuilt, bedframe multi-piece ambiguity, an unpersisted qr_token, old pre-token login-link stickers). DO NOT build time-based code expiry; keep fixing structural dying (archive-aware resolveCard + pickPackingCard + token re-read already shipped).
- admin.ts archive/restore writes to *_archive shadow tables (sales_orders_archive etc.); restore must repopulate child tables in FK order.
- kv_config is the generic config store (public_holidays consumed by payroll/costing). A bad key here silently breaks unrelated modules.
- New columns referenced in route SQL writes need a column-rename-map.json entry or they 400 'Invalid request body' (CI-guarded); prefer snake_case for new columns (arch_column_rename_map_gotcha).
- do-scan / rack-scan are mobile-first floor tools; per-piece scan splits are tested (dept-scan-split, scan-per-piece) — keep wipKey derivation via the shared deriveTopLevelWipKey, never re-implement.
- **The shared list-grid seams are all OPT-IN PROPS on `src/components/ui/data-grid.tsx`, and three of them spent months switched off.** (1) `gridId` is the key EVERYTHING per-grid persists under — column visibility, order, org default, print preset, and now Saved Views. A grid without one resets the operator's columns on every visit (only widths survive, via the `auto:` key derived from the column set), and RENAMING an id does not migrate a saved layout, it discards it. Ids are unique-checked by `tests/grid-ids.test.mjs`. Delivery's three grids were the last ones missing ids and got them on 2026-08-08 (`delivery-orders-list` for the DO list, `delivery-planning-pos` / `delivery-pending-delivery-pos` for the two PO queues); the DO grid also passes `valueFilterKey={activeTab}` so its four stage tabs share ONE column layout but never one value-filter selection (BUG-CLASSES C7). (2) `viewStorageKey` now DEFAULTS TO `gridId` (2026-08-08) — Saved Views was fully built (save/apply/delete/reset, per-user localStorage) and no page had ever passed the prop, so the entire feature ran zero times. (3) `exportName` / `exportSheetLabel` / `detailExport` enable the WYSIWYG export, built from `visibleColumns × sortedData` — the columns on screen over the rows the filter left. It NEVER fetches, so it cannot widen what `customer-scope.ts` already narrowed; keep it that way. A per-line `detailExport` is only honest where the LIST payload actually carries items: CO does (`rowToCOList`), Invoices and PI deliberately do not (`items: []` / `rowToPI`), and `/products` has no DataGrid at all (hand-rolled `<table>`). (4) `clearSelectionToken` (2026-08-08) is the only way to clear the grid's OWN `selectedKeys` — a page that empties its own mirror of the selection leaves every checkbox visibly ticked. `src/components/ui/bulk-action-bar.tsx` is the shared selection toolbar (first mounted on `procurement/pi.tsx`); most other list pages still render their own inline toolbars, which is why it looked unused. (5) **INTERACTION COST — `docs/AUDIT-INTERACTION-COST.md` (2026-08-13) is the map of what a click/keystroke costs here, and it is where to look before "optimising" this file.** Two things it settles: the search box is ALREADY deferred (`useDeferredValue`, `:2149`) and its filter pass costs 3.8 ms at 1,342 rows — **do NOT add a debounce**, prod measured 0 long tasks while typing; and `compareValues` (`:330`) now uses ONE module-level `Intl.Collator` instead of `localeCompare`'s per-call collator (99.4 ms → 3.6 ms per sort at 2,539 rows, guarded by `tests/data-grid-collator.test.mjs`). Still open in that doc and NOT fixed: `filteredData` depends on the `columns` PROP (`:2477`), so the ten pages that declare `columns` as a bare array literal re-filter AND re-sort the whole dataset on every render — including a single row click; `columns.find()` sits inside the per-row value-filter predicate (`:2467`); and `virtualizationActive` (`:2567`) switches windowing OFF whenever a group is expanded.
- **There are THREE ways to stop a long list from building its whole DOM, and picking the wrong one is the mistake.** (1) `<DataGrid virtualize>` — a flat list in the shared grid; it hard-disables itself when `groupBy` is on. (2) `useVirtualRows` (`src/components/ui/virtual-rows.tsx`, math in `src/lib/virtual-window.ts`) — hand-rolled `<tbody>` tables of **uniform-height** rows inside a sized scroll box (the accounting ledgers). (3) `useVirtualGroups` (`src/components/ui/virtual-groups.tsx`, math in `src/lib/virtual-group-window.ts`, 2026-08-13) — rows that come in **indivisible `rowSpan` groups of unequal height**; the /employees Working Hours grid is the case that needed it. When a list has neither a uniform height nor a sized box (Mail Center's `<li>`s), the answer is `useIncrementalList` instead, not a virtualiser. All three windowers derive their spacer heights from the CALLER's list inside the render pass, never from the virtualiser's lagging `getTotalSize()` — see the header comments for the two production bugs that rule prevents.
- The top-bar bell (`src/components/layout/notification-bell.tsx`) and `/notifications` read ONE feed (`src/lib/notifications-feed.ts`) and mark read through ONE helper, which broadcasts to the other surface. Don't PUT `/api/notifications` directly from a page — the bell's unread dot goes stale. The dot renders only when the real unread count is > 0. `notifications.is_read` is read dual-typed (integer OR boolean): a strict `=== 1` reports every row unread, which is how the dot was permanently lit before. **Both `/api/notifications` handlers scope to `withOrgScope` + `(userId IS NULL OR userId = <caller>)`** (2026-08-08) — a NULL `user_id` is how "broadcast to the whole org" is expressed, so don't "tighten" it to a bare `userId = ?` or the bell empties. Tests: `tests/notifications-scope.test.mjs` (runs the route's real SQL on node:sqlite).

- `GET /api/qc-inspections` buckets `qc_defects` + `qc_inspection_items` by parent id ONCE and hands `rowToInspection` its own buckets (BUG-2026-08-13-003, class C14). The mapper still `.filter()`s and `.sort()`s — as a passthrough, which is what keeps the payload byte-identical, and `.filter()` copies before the sort so the shared bucket is never reordered. Re-passing the whole arrays is a silent O(N×M) regression, not a compile error. At 500 inspections (the route's `LIMIT`) × 2,151 items that was **1,075,500 comparisons / 20.8 ms — the largest surviving quadratic in the app**, though a bounded one: both sides are capped by that `LIMIT` and the id-scoped child fetch. Pinned by `tests/list-endpoint-child-grouping.test.mjs`. The `qc-pending.ts:388` and `qc-templates.ts:91` filters are the same shape and were measured cheap (3.5 K / 7.8 K comparisons, 2026-08-13) — do not re-audit them.

**Start here:** For QC work open `src/api/routes/qc-pending.ts` + `src/pages/quality.tsx`; for warehouse/stock-scan work open `src/api/routes/public-rack-qr.ts` (the auth-bypassed stock-in flow) and `src/pages/warehouse.tsx`; for platform/admin work start at `src/api/routes/admin-health.ts`.


## Previously unmapped modules (added 2026-08-13)

These sections cover ~35,000 lines of routes and pages that this map had never
named — including `login.tsx` at 1,289 lines and the 15,279-line `/api/import`
family. They were written by reading each file, not by summarising its header
comments: several of those comments turned out to be wrong, and are corrected in
place below.
### Map fragment — Historical Import & Backfill (`/api/import`)

> **Last verified: 2026-08-13** — every claim below was read out of the code, not out of the
> header comments above each handler. All 65 handlers, all 9 files (15,279 lines) were opened;
> route lines, permission gates, dry-run defaults, SQL write statements and idempotency guards
> were each checked at the line cited. Helper idempotency was chased into
> `src/api/lib/po-cost-cascade.ts` and `src/api/routes/production-orders/_helpers.ts`.
>
> **This section is a fragment for assembly into `docs/CODEBASE-MAP.md`.** It exists because the
> map has never mentioned this family — ~15k lines that no reader could find.

---

## Historical Import & Backfill (`/api/import` — one-shot migration endpoints)

**Status: (a) LIVE AND CALLABLE — every one of the 65 handlers.** None is dead code, none is
commented out, none is feature-flagged. The barrel `src/api/routes/import-completion.ts` (65
lines) mounts all eight sub-routers at `/` (`import-completion.ts:56`-`:63`) and
`src/api/worker.ts:1411` mounts that barrel at `/api/import` — **after** the global auth gate at
`src/api/worker.ts:913`, and `/api/import` is in no PUBLIC_PATHS/PUBLIC_PREFIXES list. So every
endpoint requires a logged-in session, and 64 of 65 additionally call `requirePermission`.

**No frontend page calls any of them** — there is no UI surface. The only callers in the tree are
11 hand-run driver scripts (`scripts/import-historical-purchases.py`,
`scripts/import-prod-completions-2026-04-30.mjs`, `scripts/fix-so-088.mjs`,
`scripts/smoke-*.mjs`, `scripts/sweep-audit-po-alignment.mjs`,
`scripts/summarize-regen-fg-units.mjs`). They are written as one-shots for the 2026-04→08
data migration — several hard-code a document id (`/backfill-5543-co2606002`) or a date clamp —
but **the code cannot tell you whether a given one already ran, and nothing prevents it running
again.** Treat every entry here as a loaded gun that is still on the table.

| File | Lines | What it does | Endpoints | Tests |
|---|---|---|---|---|
| `src/api/routes/import-completion/_shared.ts` | 2109 | No routes. Types, constants, lookup helpers, and `processRow` — the per-row engine that flips a JC to COMPLETED and fires the WIP + labor + PO-completion cascades | 0 | **NONE** |
| `src/api/routes/import-completion/wip-fixes.ts` | 2890 | WIP-inventory repair: pofold backfills, refund/dedupe/zero/rebuild of `wip_items`, JC time + label refresh, JC/FG deletes | 11 | **NONE** |
| `src/api/routes/import-completion/procurement-backfills.ts` | 2384 | Supplier/binding seeding, historical PO+GRN+PI+stock import, PO status recompute, PO line-no + SKU backfills | 12 | `tests/sql-identifier-safety.test.mjs:84` (dropped-column guard only) |
| `src/api/routes/import-completion/sofa-pricing.ts` | 1950 | Price-history seeding, the Houzs sofa price sheet, SO/CO sofa re-pricing and total resync, size/leg-height migrations | 9 | `tests/sofa-combo-drift-guard.test.mjs` (guards the *canonical* engine, not these routes — see gotchas) |
| `src/api/routes/import-completion/so-co-do-backfills.ts` | 1802 | DO migration from Excel, DO revert, SO field backfills (expected DD, product name, reference, OCR fields), PO rebuild, line-qty cascade | 11 | **NONE** |
| `src/api/routes/import-completion/fg-fabric.ts` | 1679 | FAB_CUT merge, FC label refresh, multi-qty PO split, fabric-code audit/fix, `fg_units` delete/regen, pillow PACKING JC | 8 | **NONE** |
| `src/api/routes/import-completion/date-fixes.ts` | 1013 | Maintenance-history sync, snapshot cleanup, misparsed DD/MM date repair, full-width paren normalisation, `updated_at` indexes, punch autofill | 7 | **NONE** |
| `src/api/routes/import-completion/completion-cascades.ts` | 962 | The original importer (`/job-card-completion`) plus the anchor-relative cascade fills and the future-date cleanup | 4 | **NONE** |
| `src/api/routes/import-completion/audits.ts` | 490 | Read-only integrity probes (PO duplicates, procurement invariants, SO↔PO alignment) | 3 | **NONE** |

### 🚩 Read this before calling anything here

1. **`/backfill-fabcut-rm-issue` (`wip-fixes.ts:1843`) has NO `requirePermission` call** — it is the
   only handler in the family without one, and it is one of the handlers that moves raw-material
   **stock and money** (`rm_batches`, `raw_materials.balanceQty`, `cost_ledger` RM_ISSUE, via
   `consumeRawMaterialsForPO` — `src/api/lib/po-cost-cascade.ts:803`). Any authenticated user of
   any role can fire it. It is *safe on re-run* (see below), but the missing gate is real: line
   1844 goes straight to `const dryRun = …` with no `denied` check above it.
2. **Most endpoints default to LIVE WRITE — 49 of the 65.** The dominant idiom is
   `c.req.query("dryRun") === "true"`, which means **a bare POST with no query string and no body
   writes to production.** The exact split: **39** derive `dryRun` with a `=== true` form (live
   unless you opt out), **10 more have no dry-run code path at all** (`procurement-backfills.ts`
   :110, :180, :330; `so-co-do-backfills.ts` :335, :404, :444, :745, :830, :953;
   `sofa-pricing.ts` :1690), **12 are safe-by-default** (8 use the `!== false` form, 4 are
   audit-first behind `{"apply":true,"confirm":…}`), and **4 are read-only**. The four different
   dryRun spellings in this family
   (`=== "true"`, `!== "false"`, `body.dryRun === true`, `body.dryRun !== false`) mean muscle
   memory from one endpoint produces a live write on the next.
3. **Two endpoints are NOT idempotent and corrupt data on a second run** — see the table below.
4. **Test coverage is essentially zero.** Two test files touch this family and neither exercises a
   handler. Nothing else in `tests/` does.

### The non-idempotent ones (a second run does damage)

| Endpoint | Why it breaks | Undo |
|---|---|---|
| `/refund-backfill-overconsume` `wip-fixes.ts:590` | `wip-fixes.ts:824` is `UPDATE wip_items SET stockQty = stockQty + ?` — a raw delta with no marker row. The candidate SELECT keys on fields the endpoint never mutates, so run #2 builds the identical plan and credits every WIP label a second time. Defaults to LIVE (`:595`). | `?revert=true` (`:801`) flips the sign — the built-in one-shot undo |
| `/queen-price-correction-rm5` `sofa-pricing.ts:315` | `sofa-pricing.ts:454` binds `r.basePriceSen - 500` and `:412` computes `active.basePriceSen - 500` — read-then-subtract off *current* DB state. Every run removes another RM5 from every Queen `product_prices` row at `effectiveFrom='2026-04-26'` and from each customer's active price row. Defaults to LIVE (`:320`). Worse: the customer side targets "newest row with `effectiveFrom <= today`" (`:396`-`:401`), so the target row can change between runs. | none |

Also delta-shaped, but self-limiting rather than broken:
`/migrate-do-from-excel` (`so-co-do-backfills.ts:28`) appends `SET totalM3 = totalM3 + ?,
totalItems = totalItems + ?` at `so-co-do-backfills.ts:246`, and its skip guard
(`:122`) only fires when **every** PO of the SO is already migrated — a partially-migrated SO
double-adds its DO header totals and blind-INSERTs duplicate `delivery_order_items`
(`:282`, random id, no `ON CONFLICT`). `/correct-so-line-qty-cascade`
(`so-co-do-backfills.ts:1487`) computes `so.subtotalSen + lineTotalDelta` (`:1564`) but is saved by
a no-op guard at `:1539` plus a PO selector that stops matching after the first run.

### Endpoints that write money or stock tables

`cost_ledger` / `rm_batches` / `raw_materials` / `purchase_invoices` / `product_prices` /
`customer_product_prices` / `wip_items` / `fg_units` — anything below is a money or stock write.

| Endpoint | Money/stock tables written | Default | Re-run safe? |
|---|---|---|---|
| `/historical-purchases-backfill` `procurement-backfills.ts:330` | `purchase_orders` :489, `purchase_order_items` :519, `grns` :541, `grn_items` :569, **`rm_batches`** :593, **`cost_ledger`** :611, **`raw_materials`** :630, **`purchase_invoices`** :641, `purchase_invoice_items` :686 | **no dry-run exists — always live** | only via ONE guard: `SELECT id FROM purchase_invoices WHERE piNo = ?` at :412. See gotchas |
| `/backfill-fabcut-rm-issue` `wip-fixes.ts:1843` | `rm_batches`, `cost_ledger`, `raw_materials` (via `consumeRawMaterialsForPO`) | dry-run (`:1844` uses `!== "false"`) | **yes** — double-guarded (`NOT EXISTS` on the RM_ISSUE ledger row at :1864, plus the helper's own check at `po-cost-cascade.ts:803`) |
| `/refund-backfill-overconsume` `wip-fixes.ts:590` | `wip_items` :824 | **live** | **NO — double-credits** |
| `/dedupe-wip-items` `wip-fixes.ts:886` | `wip_items` UPDATE :1091, DELETE :1095 | **live** | yes (absolute `stockQty = ?`; the `HAVING COUNT(*) > 1` driver returns nothing on run #2) |
| `/zero-out-negative-wips` `wip-fixes.ts:1159` | `wip_items` :1206 (`SET stockQty = 0 WHERE stockQty < 0`) | **live** | yes (self-negating predicate) — but irreversibly destroys the negative balances that are the evidence of an upstream bug |
| `/rebuild-wip-from-jcs` `wip-fixes.ts:1219` | `wip_items` UPDATE :1741, INSERT :1749 (`ON CONFLICT … DO UPDATE`), DELETE :1767 | **live** | yes — full absolute rewrite recomputed from `job_cards` |
| `/queen-price-correction-rm5` `sofa-pricing.ts:315` | `product_prices` :453, `customer_product_prices` :458 | **live** | **NO — subtracts RM5 every run** |
| `/derive-historical-price-baselines` `sofa-pricing.ts:10` | `customer_product_prices` :234, `product_prices` :258 | **live** | yes (pre-existence SELECT at :227/:251, all rows pinned to `PRICE_BASELINE_DATE`) |
| `/apply-houzs-sofa-pricesheet` `sofa-pricing.ts:481` | `product_prices` :588/:597, `customer_product_prices` :631/:640, `customer_products` :657, `products` :674 | **live**, `scope` defaults to `both` | yes — values come from a static in-code sheet, `effectiveFrom` hard-coded |
| `/recompute-so-sofa-prices` `sofa-pricing.ts:689` | `sales_order_items` :1165, `sales_orders` :1200 | **live**, all active statuses | yes arithmetically — but `:1204` binds `sub, sub`, forcing `totalSen = subtotalSen` and discarding any tax/discount |
| `/recompute-co-sofa-prices` `sofa-pricing.ts:1228` | `consignment_order_items` :1559, `consignment_orders` :1573 | **live** | same as above, same tax/discount flattening |
| `/resync-so-totals` `sofa-pricing.ts:1624` / `/resync-co-totals` `sofa-pricing.ts:1583` | `sales_orders` :1661 / `consignment_orders` :1605 | **live** | yes (absolute `SUM(lineTotalSen)`, skip-if-equal) — same `total := subtotal` flattening |
| `/correct-so-line-qty-cascade` `so-co-do-backfills.ts:1487` | `sales_order_items` :1766, `sales_orders` :1771, `production_orders` :1776, `job_cards` :1783 | **live** | delta-based but no-op-guarded — see above |
| `/rebuild-production-orders-from-soi` `so-co-do-backfills.ts:1211` | DELETE `fg_units` :1409, `job_cards` :1415, `production_orders` :1420, then rebuild | **live** | converges, but the FG stubs never come back — see gotchas |
| `/backfill-split-multi-qty` `fg-fabric.ts:516` | DELETE `fg_units` :805, `production_orders` :810, then rebuild | **live** | same FG-loss shape; pre-flight guards at :570/:588/:610/:637/:660 |
| `/delete-fg-units-by-ids` `fg-fabric.ts:1191` | DELETE `fg_units` :1259 | **live** (body with `unitIds`, no `dryRun`) | yes (explicit id list) — refuses DELIVERED/RETURNED/LOADED at :1229 |
| `/regen-fg-units` `fg-fabric.ts:1307` | DELETE `fg_units` :1415 + INSERT via `generateFGUnitsForPO` (`src/api/routes/fg-units.ts:326`) | dry-run (`:1317`) | converges but re-mints serials/ids each run |
| `/cleanup-headboard-only-divans` `wip-fixes.ts:2727` | DELETE `job_cards` :2839, `fg_units` :2855 | dry-run (`:2737`) | yes; skips COMPLETED JCs (:2831) and non-PENDING units (:2847) |
| `/job-card-completion` `completion-cascades.ts:17` + `/cascade-upstream-completion` `completion-cascades.ts:199` | `job_cards`, `production_orders`, then `wip_items` + `cost_ledger` (+ `fg_units`/`fg_batches`/`rm_batches` on PO completion) via the cascade helpers | **live** | yes — see the cascade-guard note below |
| `/cleanup-snapshot-from-master-rows` `date-fixes.ts:141` | DELETE `customer_product_prices` :177 | **live** | yes (`WHERE notes LIKE 'Snapshot from Master%'`) |
| `/normalize-fullwidth-parens` `date-fixes.ts:561` | `wip_items` merge `stockQty = stockQty + ?` :803 then DELETE :808, orphan rename :818 | **live** | yes — the merge is pair-driven and the full-width row is deleted in the same atomic `db.batch` (:824), so run #2 finds no pairs |

### Read-only endpoints (safe to call)

`audits.ts` is the only fully read-only file — all three handlers issue SELECTs and nothing else:
`GET /po-no-duplicates` `audits.ts:22`, `POST /audit-procurement-integrity` `audits.ts:44` (10
named invariant checks), `GET /audit-po-alignment` `audits.ts:441` (delegates to
`loadAndValidatePOAlignment` — `src/api/lib/po-alignment-validator.ts:228`, zero write statements
in that file). Also read-only despite its POST verb and `production-orders:update` gate:
`/audit-orphan-fabric-codes` `fg-fabric.ts:862`.

### Remaining endpoints (no money/stock table)

- `wip-fixes.ts` — `/uph-pofold-backfill` :14, `/fab-cut-pofold-backfill` :289 (both flip
  `job_cards` then fire the WIP + labor cascades), `/backfill-jc-production-time-from-bom` :1967
  (`includeCompleted` defaults **true**, so it rewrites minutes on already-COMPLETED cards),
  `/refresh-jcs-by-id` :2256, `/delete-jcs-by-ids` :2613 (refuses COMPLETED/TRANSFERRED at :2657).
- `procurement-backfills.ts` — `/cancel-leaked-co-pos` :24, `/suppliers-from-history` :110
  (no dry-run), `/supplier-bindings-from-history` :180 (no dry-run),
  `/backfill-supplier-material-bindings` :864, `/backfill-supplier-bindings-multi` :991,
  `/backfill-historical-grns` :1308 (writes `grns`/`grn_items` only, `NOT EXISTS`-guarded at
  :1338), `/recompute-po-status-progress` :1508, `/backfill-po-from-so-lines` :1699,
  `/append-missing-pos` :1999, `/backfill-po-line-no` :2129 (dry-run default),
  `/backfill-supplier-sku-1to1` :2304 (dry-run default).
- `so-co-do-backfills.ts` — `/migrate-do-from-excel` :28, `/revert-dos-to-draft` :335 (**no
  dry-run path; an empty POST reverts every LOADED DO to DRAFT**), `/backfill-so-expected-dd` :404,
  `/backfill-so-item-product-name` :444, `/backfill-5543-co2606002` :505 and
  `/backfill-complete-stray-jc-co2606002` :657 (both audit-first: need
  `{"apply":true,"confirm":…}`), `/backfill-downstream-product-names` :745 (touches
  `invoice_items.productName` at :812), `/backfill-so-reference` :830,
  `/backfill-ocr-so-fields` :953.
- `fg-fabric.ts` — `/backfill-fab-cut-merge` :13 (DELETEs sibling `job_cards` at :256 including
  COMPLETED ones), `/backfill-fc-label-refresh` :283, `/apply-fabric-code-fixes` :1008,
  `/backfill-pillow-packing-jc` :1470 (DELETEs PACKING `job_cards` at :1597 with no status guard,
  then blind-INSERTs at :1605).
- `date-fixes.ts` — `/sync-maintenance-history-from-kv` :23, `/fix-misparsed-jan-dates` :192,
  `/fix-misparsed-dates` :376 (dry-run default), `/create-updated-at-indexes` :860 and
  `/backfill-punch-autofill-blocked` :934 (both audit-first, gated `users:create` +
  `{"apply":true,"confirm":…}`).
- `completion-cascades.ts` — `/clear-future-completions` :129, `/cascade-leak-pass` :683.

**Gotchas**

- **`/historical-purchases-backfill` (`procurement-backfills.ts:330`) is the single widest blast
  radius in the repo's backfill surface and has no dry-run.** It writes nine tables including
  `cost_ledger`, `rm_batches` and `raw_materials` (`balanceQty = balanceQty + ?` at :630 — a blind
  delta), in one atomic `db.batch` at :706. Its *only* duplicate defence is a pre-existence check
  on the invoice number (`piNo`) at :412. Everything else uses fresh random UUIDs (:475-:480), so
  the "deterministic" ids (`rmb-grn-${grnId}-…` :587) are derived from a random parent and are not
  stable dedupe keys across runs. Consequences that follow directly from that: the same physical
  invoice under a renamed `docNo` duplicates PO+GRN+batch+ledger and adds stock twice; deleting or
  voiding the PI row and re-running does the same; and a first run with `skipStock:true` still
  writes the PI, so the corrective re-run with `skipStock:false` is **skipped and the stock never
  lands** (silent under-apply). `poNo` is deterministic (`PO-IMPORT-${docNo}` :476) but is never
  checked in this loop.
- **The WIP + labor cascades ARE replay-guarded, but only when `orgId` is threaded.**
  `applyWipInventoryChange` (`src/api/routes/production-orders/_helpers.ts:2616`) claims an
  idempotency ticket by INSERTing into `wip_cascade_log` (:2645) and returns early when it loses
  the race — but that whole block is wrapped in `if (options.orgId)` at :2635. `processRow`
  (`src/api/routes/import-completion/_shared.ts:317`) passes `{ orgId, source: "BACKFILL" }` at
  :529 and `/cascade-upstream-completion` passes it at `completion-cascades.ts:642`, so both are
  covered. `postJobCardLabor` (`src/api/lib/po-cost-cascade.ts:1116`) is independently guarded on an
  existing LABOR_POSTED row (:966). **If you add a new backfill that calls the WIP cascade, pass
  `orgId` or you silently get no guard at all.**
- **`/cascade-leak-pass` (`completion-cascades.ts:683`) flips `job_cards` to COMPLETED and fires
  NOTHING else.** Its only write is the UPDATE at :927. Compare `/cascade-upstream-completion`,
  which after its own UPDATE (:559) deliberately calls `applyWipInventoryChange` (:635) and
  `postJobCardLabor` (:653) — the comment at :579 records that the metadata-only version left ~1300
  phantom consumes without compensating producer-adds. The leak pass still has that shape. Running
  it produces COMPLETED cards with no producer-add in `wip_items` and no labor row in
  `cost_ledger`.
- **`/clear-future-completions` (`completion-cascades.ts:129`) reverses only the metadata.** Its
  UPDATE at :171 resets status/date/PIC/minutes on `job_cards`, and the handler does nothing else —
  the `wip_items` movements and `cost_ledger` LABOR_POSTED rows that those completions already
  created are left behind.
- **`CASCADE_DATE_CLAMP` is a hand-maintained constant, currently `"2026-05-11"`
  (`src/api/routes/import-completion/_shared.ts:684`).** Both cascade endpoints clamp every
  backfilled completion date to it (`completion-cascades.ts:412` and `:837`). The comment above it
  records that it was already stale once. Re-running a cascade today without bumping it pins every
  backfilled date to 2026-05-11.
- **The two rebuild endpoints delete `fg_units` and never recreate them.**
  `/rebuild-production-orders-from-soi` (`so-co-do-backfills.ts:1211`) and
  `/backfill-split-multi-qty` (`fg-fabric.ts:516`) both DELETE the SO's entire `fg_units` set
  (:1409 / :805) and then rebuild from `createProductionOrdersForOrder`, which emits only
  `production_orders` and `job_cards` INSERTs — no `fg_units`. The split endpoint at least gates on
  every unit being PENDING (`fg-fabric.ts:637`); the SO rebuild has **no `fg_units` status check at
  all**, only a JC-status one at :1297.
- **`/migrate-nonstandard-sofa-sizes` (`sofa-pricing.ts:1690`) has no dry-run of any kind** and
  blanks both `sizeLabel` and `sizeCode` (:1750, :1761). `sizeCode` is the sofa *seat height* that
  `/recompute-so-sofa-prices` requires — it skips lines with `missing sizeCode (seat height)`
  (`sofa-pricing.ts:896`). Running the size migration before a re-price silently converts priced
  sofa lines into un-repriceable ones. Its `sales_order_items` SELECT is org-scoped (:1707) but the
  `production_orders` UPDATE at :1761 matches on `salesOrderId` + `lineNo` with no org filter.
- **Sofa combo maths is re-implemented inline here, not imported.** The canonical engine is
  `applySofaCombos` (`src/api/lib/sofa-combo.ts`); `/recompute-so-sofa-prices` and
  `/recompute-co-sofa-prices` carry their own copy with a *deliberate* divergence (no round-up to
  whole ringgit) documented at `sofa-pricing.ts:927`. `tests/sofa-combo-drift-guard.test.mjs` pins
  the canonical engine only — it does **not** execute either endpoint, and its header comment still
  points at the pre-split `import-completion.ts`. Treat it as a drift alarm on the source of truth,
  not as coverage of these routes.
- **`/append-missing-pos` (`procurement-backfills.ts:1999`) runs DDL even on a dry run.** It calls
  `createProductionOrdersForSO` at :2068 before checking `dryRun`, and that helper's inner
  `createProductionOrdersForOrder` executes `ALTER TABLE production_orders ADD COLUMN IF NOT EXISTS
  repairScope` (`src/api/routes/_shared/production-builder.ts:389`). Same for the two rebuild
  endpoints. A "dry run" here is not side-effect-free.
- **Three binding writers disagree about `orgId`.** `/supplier-bindings-from-history` (:294) and
  `/backfill-supplier-material-bindings` (:942) INSERT `supplier_material_bindings` without an
  `orgId` column, while `/backfill-supplier-bindings-multi` probes existing rows with
  `WHERE orgId = ?` (:1135) and inserts *with* `orgId` (:1206). Rows written by the first two are
  invisible to the third, which will then insert duplicate bindings for the same
  (materialCode, supplierId).
- `/regen-fg-units` queries `fg_units … WHERE poId = ?` (`fg-fabric.ts:1415`) while every other
  `fg_units` write in this family uses `po_id` (`fg-fabric.ts:805`, `so-co-do-backfills.ts:1424`).
  Both work only because of `src/api/lib/column-rename-map.json` — see the camelCase rule in
  `CLAUDE.md` before adding another.

**Start here:** `src/api/routes/import-completion.ts` (the 65-line barrel) tells you which
sub-router owns a path. For the completion engine itself read `processRow`
(`src/api/routes/import-completion/_shared.ts:317`) — it is the one function the whole family's
riskiest behaviour flows through. Before running ANY endpoint here, find its row above and check
the Default column: assume live-write unless the table says otherwise.

### Map fragment — unmapped pages + their paired routes

> **Last verified: 2026-08-13** against every file cited below, read in full (not grepped).
> Line counts re-derived with `wc -l`; every `file:LINE` opened and checked; route paths
> checked against `src/dashboard-routes.tsx` / `src/router.tsx`; the Hono route-ordering
> claim in §8 was **executed** against `hono@4.12.14` from this repo's lockfile, not inferred.
>
> **This is a FRAGMENT, not a doc.** It is written to be pasted into
> `docs/CODEBASE-MAP.md` by the assembling session, in the map's own table format
> (`Frontend page | API route | Primary tables | Tests`). Delete this file once merged in.

## What was NOT in the map before this fragment

| File | Lines | Prior mention in `CODEBASE-MAP.md` |
|---|---|---|
| `src/pages/login.tsx` | 1288 | **none** |
| `src/pages/finance-dashboard.tsx` | 1263 | **none** |
| `src/pages/leads/index.tsx` | 929 | **none** |
| `src/pages/hookka-report-editions.tsx` | 697 | `tests/dashboard-truthfulness.test.mjs` — receivables aging strip only (BUG-2026-08-13-106) |
| `src/pages/forecast.tsx` | 575 | **none** |
| `src/pages/component-kits/index.tsx` | 502 | **none** |
| `src/pages/invoices/debit-notes.tsx` | 500 | only as the bare shorthand `debit-notes.tsx` (map L277), no full path, no route/table/test row |
| `src/api/routes/debit-notes.ts` | 450 | named twice (map L143, L277) but never described |
| `src/pages/delivery-returns/index.tsx` | 419 | **none** |
| `src/api/routes/delivery-returns.ts` | 483 | one clause inside the FG-stock-events gotcha (map L471); no row |
| `src/api/routes/three-pl-vehicles.ts` | 446 | named in the Sales table's route column (map L222); never described |
| `src/api/routes/equipment.ts` | 405 | **none** |

Nothing here is dead code — every one is reachable. Two are **not pages** despite living
under `src/pages/` (§4, §5); say so in the map or the next reader will hunt for their route.

---

## 1. Auth — Login

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/login.tsx` — `/login`, **PUBLIC / standalone** (declared in `src/router.tsx:92`, NOT in `dashboard-routes.tsx`); email+password, remember-me, soft-2FA branch, role-aware landing (1288) | `src/api/routes/auth.ts` — `POST /login` (`:148`), `GET /me/permissions` (`:487`), `POST /change-password` (`:613`), `POST /forgot-password` (`:745`), `POST /reset-password` (`:901`) | `users` (session cookie is the credential; no client token) | **NONE dedicated.** `tests/api-rate-limit.test.mjs` and `tests/security-public-endpoints.test.mjs` touch `/api/auth/login` as an endpoint only — neither reads `src/pages/login.tsx` |

**Endpoints it calls** — `POST /api/auth/login` (`src/pages/login.tsx:319`),
`GET /api/auth/me/permissions` (`:295`, inside `landingPage()`),
`POST /api/auth/totp/dismiss-prompt` (`:394`, fire-and-forget).

**Why a login page is 1,288 lines.** The auth logic is ~110 lines (`LoginPage` L227 →
`handleSubmit` end L417). The other ~90% is **two complete, independent presentations plus
their palettes**, all inlined:

- **L39–117 `LOGIN_PALETTE`** — a 20-key `Palette` type rendered twice (dark + light),
  ported verbatim from the owner's design source. Every colour is a JS style value, not a
  Tailwind class, so nothing collapses into a class string.
- **L129–205 seeded snow** — `Flake` type, a mulberry32 LCG (`makeRng` L143), two frozen
  flake arrays (`SNOW_BACK` 16, `SNOW_FRONT` 5) and the `SnowLayer` renderer.
- **L420–856 the MOBILE branch** (`< 1024px`, gated by `useMediaQuery` at L245) — the
  owner's phone-first design: `<style>` keyframe block, 64px grid, radial glow, parallax
  snow layers, theme toggle, frosted-glass form sheet. Roughly 435 lines.
- **L858–1274 the DESKTOP branch** (`>= 1024px`) — the older premium split-panel:
  shimmer/orbit keyframes, three orbit rings, three orbiting dots, brand column. Roughly
  415 lines.

Both branches share ONE form state and ONE `handleSubmit`; only presentation differs. If
you are changing auth behaviour you want L227–417 and nothing else.

**Gotchas**

- **`Math.random` here is NOT fabricated data.** L130 explains it: the design source used
  `Math.random` for snowflake positions and it was replaced by a seeded LCG so flakes are
  stable across renders. It decides pixel positions, never a figure. A fabricated-data
  sweep will hit this line — it is a false positive, don't "fix" it.
- **The 2FA hard gate is a documented dead end (BUG-2026-08-04-006).** The server can
  answer `{ success:true, totpRequired:true, userId }` with **no `data` blob**; the
  login-verify step was never built. L346–351 handles that shape explicitly and shows
  "Two-factor sign-in isn't available yet — ask an admin to reset your 2FA". The gate is
  currently disabled server-side; this branch exists so a stale worker or a re-enable
  cannot white-screen login again. The `LoginResponse` union at L207–225 models all three
  shapes — keep it that way.
- **`/dashboard` is deliberately NOT the default landing page** (L281–305). Under the RBAC
  policy `/dashboard` is Management + Super Admin only, so the page asks the SERVER for the
  role's front door via `GET /api/auth/me/permissions` → `body.home`, falling back to
  `/settings` (which everyone has). Do not reintroduce a hardcoded `/dashboard` default —
  a salesperson would land on a screen whose every figure 403s.
- **`rememberMe` defaults to `true`** (L240) and is a real behaviour switch, not cosmetics:
  unchecked ⇒ session cookie + `sessionStorage`, which incognito drops on tab close
  ("mysteriously logged out", owner 2026-06-27).
- The right panel's `SYSTEM ONLINE` dot (L1232–1241), `ERP v2.0 // 2026` (L1255) and
  `ISO 9001:2015` (L1269) are **static decorative strings** — no health check behind them.
  Their bigger sibling (a `156 ACTIVE PO / 8 DEPARTMENTS / 99.7% UPTIME` stat panel) was
  deleted 2026-05-27 for exactly that reason; the comment recording it is at L1201–1204.
  If a live status indicator is ever wanted, it must be wired, not styled.

---

## 2. Forecasting — Financial Dashboard + Forecast P&L

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/finance-dashboard.tsx` — `/finance-dashboard` (`src/dashboard-routes.tsx:472`; sidebar FORECASTING → "Dashboard"); 6 cards, monthly or calendar-quarterly (1263) | `src/api/routes/accounting.ts` — `GET /dashboard` (`:10109`), SWR-cached | `accounting_dashboard_snapshot` (runtime-created at `accounting.ts:10134`) over the ledger + `kv_config['forecast_pnl']` (`:10192`) | `tests/dashboard-forecast-pct.test.mjs` (BUG-2026-08-06-002 only) |
| `src/pages/forecast.tsx` — `/forecast` (`src/dashboard-routes.tsx:471`; sidebar FORECASTING → "Forecast P&L"); planning grid, zero contact with the books (575) | `src/api/routes/accounting.ts` — `GET /forecast` (`:10743`), `PUT /forecast` (`:10758`), `GET /coa` (`:829`), `GET /pnl/section-map` (`:9827`), `GET /labor/departments` (`:9561`) | `kv_config` row `key='forecast_pnl'` (`:10789`) — **no forecast table exists**; plus `chart_of_accounts` for the line structure | **NONE** |

> **Name collision — read this before touching either.** `/forecast` (`src/pages/forecast.tsx`,
> the owner's keyed P&L plan) and `/analytics/forecast` (`src/pages/analytics/forecast.tsx`,
> `dashboard-routes.tsx:548`) are **different pages with different data**. The map must not
> collapse them. `dashboard-routes.tsx` even imports them under two names —
> `ForecastPnl` (L143) and `Forecast` (L181).

**finance-dashboard.tsx — endpoints:** exactly ONE.
`GET /api/accounting/dashboard?granularity=&periods=&from=&to=` at
`src/pages/finance-dashboard.tsx:262`. All six cards are `useMemo` projections of that one
`rows` array, which is why a card can never disagree with its report.

**Cards, in render order:** Income Statement (`:657`, 10 tabs from `PL_TABS` L40) → Production
Salary stacked-by-department (`:714`) → Cost Structure (`:915`) → Material Trend (`:1074`) →
Cash Flow with Summary/Detail (`:1133`) → Balance Sheet (`:1200`) → Financial Ratios (`:1227`).

**Money / honesty notes**

- Money is integer sen end to end. `rm` / `rm2` (L83–86) divide by 100 **for display only**;
  every derived figure uses `Math.round(... * 10000) / 100` on sen ints.
- **The forecast-percentage rule (BUG-2026-08-06-002) is load-bearing and is stated three
  times in this file** — `csForecastSales` L468, `csData` L524–529, `csTrend` L568–573: a
  forecast share divides by FORECAST revenue, an actual share by ACTUAL revenue. Dividing a
  plan by a part-billed actual once read 121.30% for a target that was 15% of plan. Pinned
  by `tests/dashboard-forecast-pct.test.mjs`.
- **This page volunteers a known-wrong figure rather than hide it** — L906–909 renders a
  standing warning that `RM / unit` uses completed-batch quantities that double-count some
  completions, so the unit count runs high and the cost runs low. Do not delete that banner
  while the defect is open; it is the difference between a weighable figure and a
  misleading one.
- No fabricated data anywhere in this file: `rows === null` renders "Loading…", `rows.length
  === 0` renders "No data yet.", and every card is gated on real content
  (`csCats.length > 0`, `labourData.some(d => d.amount !== null)`).

**forecast.tsx — endpoints:** four parallel GETs on mount (`:111`, `:112`, `:113`, `:114`)
and one `PUT /api/accounting/forecast` on Save (`:287`).

**Gotchas**

- **It stores nothing in a table.** The whole grid is one JSON blob in
  `kv_config.value WHERE key='forecast_pnl'`. `PUT` is a whole-blob replace
  (`accounting.ts:10789`, `INSERT … ON CONFLICT DO UPDATE`) — there is no per-cell write, so
  two people saving concurrently is last-write-wins over the entire forecast.
- **A cell is percent OR amount, never both** (L237–241 clear the other side). Storage:
  `{ bp }` (basis points, `strToBp` L83) or `{ amtSen }` (L273–286). A **legacy third
  shape** — a bare `bp` number — is still read at L127. Any new reader must handle all three.
- **Department rows SUPERSEDE the 750-x labour accounts** for any month that carries one
  (`monthHasDeptForecast` / `forecastEntryKind` from `src/lib/salary-dept.ts`, applied at
  `forecast.tsx:227–229` and again at `:526`). The account rows stay visible, greyed, marked
  "superseded". Summing both would double-count labour — that is what `sumGuard` (L228)
  prevents. `finance-dashboard.tsx` reads the same blob through the same rule.
- Pseudo-line keys are a deliberate namespace: `cat:<TYPE>` for material groups (L180–182),
  `dept:<CODE>` for salary departments (L195). They sit in the same `pct` map as real
  account codes. A reader that assumes every key is a COA code will break.

---

## 3. Sales — Sales Pipeline (Leads)

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/leads/index.tsx` — `/leads` (`src/dashboard-routes.tsx:414`; sidebar "SALES & CUSTOMERS → Sales Pipeline"); 6-column kanban, drag-to-move, full CRM drawer, convert-to-customer (929) | `src/api/routes/sales-leads.ts` (437) — CRUD + `/:id/stage` + `/:id/convert` + `/lead-products` | runtime-created: `sales_leads` (`src/api/routes/sales-leads.ts:35`), `lead_products` (`src/api/routes/sales-leads.ts:63`); plus `customers` — a POTENTIAL row is minted with the lead (`src/api/routes/sales-leads.ts:121`) | `tests/sales-leads.test.mjs`, `tests/sales-pipeline-lead-detail.test.mjs`, `tests/lead-convert.test.mjs`, `tests/lead-catalog.test.mjs`, `tests/crm-followups.test.mjs` |

**Endpoints called, with line refs in `src/pages/leads/index.tsx`**

| Call | Page line | Handler |
|---|---|---|
| `GET /api/sales-leads` | `:70` | `sales-leads.ts:102` |
| `GET /api/customer-crm/follow-ups` | `:81` | `src/api/routes/customer-crm.ts` |
| `POST /api/sales-leads` | `:132` | `sales-leads.ts:155` |
| `PUT /api/sales-leads/:id` | `:400` | `sales-leads.ts:228` |
| `PUT /api/sales-leads/:id/stage` | `:162` | `sales-leads.ts:258` |
| `DELETE /api/sales-leads/:id` | `:171` | `sales-leads.ts:359` |
| `POST /api/customers` | `:594` | `src/api/routes/customers.ts` |
| `PUT /api/customers/:id` | `:583`, `:609` | `src/api/routes/customers.ts` |
| `POST /api/sales-leads/:id/convert` | `:631` | `sales-leads.ts:295` |
| `GET /api/sales-leads/lead-products?leadId=` | `:740` | `sales-leads.ts:374` |
| `POST /api/sales-leads/lead-products` | `:810` | `sales-leads.ts:389` |
| `DELETE /api/sales-leads/lead-products/:id` | `:832` | `sales-leads.ts:427` |
| `GET /api/products` | `:751` | `src/api/routes/products.ts` |

Sub-components: `LeadDetailDrawer` (L370), `ConvertLeadDialog` (L529), `LeadCatalogPanel`
(L719). The drawer also mounts `CrmPanel` and `KycPanel` (L512, L514) **keyed on the LEAD
id** — those carry their own endpoints.

**Gotchas**

- **`STAGES` (L45–52) is the single source of every stage label on the page.** `key` is the
  persisted value and must stay in lockstep with `LEAD_STAGES` in `sales-leads.ts:20`;
  `label` is display-only. Owner 2026-08-01 renamed New/Won/Lost → **Potential / Confirmed /
  Dropped** by editing labels alone — no migration. Don't "tidy" the keys.
- **Convert PROMOTES, it does not create.** A `customers` row is minted as POTENTIAL when the
  lead is entered (`sales-leads.ts:121`), and has been carrying SKU assignments, combos and
  quotations ever since. `ConvertLeadDialog.submit` (L557) therefore `PUT`s that existing
  `lead.customer_id` (L582–592) and only falls through to `POST /api/customers` (L594) for
  pre-change leads that have none. Minting a second customer here would strand everything
  assigned to the first.
- **Snake-case reads here are correct, not a bug.** `sales-leads.ts:107` is
  `SELECT * FROM sales_leads`, and the physical columns are snake_case, so the page's
  `l.est_value_sen` / `l.next_follow_up` / `l.lost_reason` land. Do not "fix" them to
  camelCase — the map's dual-key rule applies where a column has BOTH forms.
- **Both writers are deliberately sequential, not `Promise.all`** — `addTicked` (L809, the
  endpoint self-applies DDL on first write and concurrent creates race it) and the analogous
  loop in Component Kits (§6). Keep them sequential.
- Money is sen: `Math.round((parseFloat(...) || 0) * 100)` at L143, L411, L574.

---

## 4. Reports — The Hookka Report, Weekly/Monthly editions

| Frontend module | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/hookka-report-editions.tsx` — **NOT a page and NOT a route.** No default export; it exports `EditionToggle` (`src/pages/hookka-report-editions.tsx:157`), `OperationsEdition` (`src/pages/hookka-report-editions.tsx:235`) and the `Edition` type (line 17). Imported ONLY by `src/pages/daily-report.tsx` (import block L16-20), which imports both at `src/pages/daily-report.tsx:17-18` and renders `OperationsEdition` at `src/pages/daily-report.tsx:1134` and `EditionToggle` at `src/pages/daily-report.tsx:1097` + `:1180`. (`--fix` rewrites these to the IMPORT lines, because the import is the first occurrence of each name — if this row comes back reading `:17` / `:18`, re-point it at the render sites rather than trusting the auto-fix.) Reachable only via the `/daily-report` route entry — `DailyReport` (`src/dashboard-routes.tsx:474`) (759) | `src/api/routes/reports.ts` — `GET /operations.json` (`:345`), collector `src/api/lib/operations-report.ts` (1248) | `sales_orders` / `sales_order_items` / `job_cards` / `payslips` / `attendance_records` / `workers` / `products` / `raw_materials` / `rm_batches` / `cost_ledger` / `purchase_orders` / `invoices` / `invoice_payments` / `delivery_orders` / `service_cases` / `qc_inspection_items` / `price_histories` / `departments` | **NONE** |

**Endpoints:** `GET /api/reports/operations.json?period=<edition>&date=<anchorYmd>`
(`:230-231`), `GET /api/files?resourceType=modular` (`:236-237`) for the product photos,
and `/api/files/:id/download` as an `<img src>` (`:671`).

**Gotchas**

- **Its file name looks like a page and it is filed under `src/pages/`.** It is a component
  module. `node scripts/check-codebase-map.mjs --coverage` demands a map entry for it (697
  lines > the 400 threshold) even though no route can ever point at it. Record it under
  Reports next to `daily-report.tsx`, not as a route.
- The `OperationsReport` interface (L54–~132) mirrors `src/api/lib/operations-report.ts`
  field for field. Changing a collector field without changing this interface produces
  silent `undefined`s in the newspaper, not a type error — the response is cast, not parsed.
- Daily is a different report entirely: `GET /api/reports/compliance.json` +
  `src/api/lib/compliance-report.ts`, rendered by `src/pages/daily-report.tsx` itself.
  Weekly/Monthly is the only thing this module draws.
- **"On-time delivery %" now means what it says (2026-08-14, BUG-2026-08-13-140).** It is
  `delivery_orders.delivered_at ≤ sales_orders.customer_delivery_date`, per SALES ORDER,
  last delivery counts — computed in `src/api/lib/on-time-delivery.ts` and consumed by
  `collectDelivery`. It used to be `dispatched_at ≤ hookka_expected_dd`: our own internal
  target, at the wrong end of the journey, over a population that excluded anything never
  dispatched. `hookka_expected_dd` must never be scored against (`kpi-metrics.ts:18-19`).
  The figure travels with `delivery.onTime`, which publishes `judged` / `population` /
  `excludedNotDelivered` / `excludedNoCustomerDate` / `coveragePct`; print the coverage
  wherever you print the percentage. `production.onTimePct` is the SAME number mirrored for
  the Production headline, not a second measurement.
  Tests: `tests/on-time-delivery.test.mjs`.
- **The Daily Report can say "I could not check" (2026-08-14, BUG-2026-08-13-141).** All 15
  checks in `compliance-report.ts` used to `catch → return []`, so a thrown check was
  indistinguishable from a clean one and the page printed a green `0` under *"A Quiet Day on
  the Floor"*. Checks now rethrow; `runCheck` records the failure; the per-check counts are
  `number | null` (**null = could not run, never 0**) and `counts.checksRun` /
  `checksTotal` / `data.unavailable` publish the coverage. The same rethrow was applied to
  the two money detectors in the sweep (`pricing-integrity.ts`, `cogs-integrity.ts`).
  Tests: `tests/compliance-unknown-outcome.test.mjs`.

---

## 5. Accounting — Debit Notes

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/invoices/debit-notes.tsx` — `/invoices/debit-notes`, gated `RequirePermission resource="invoices" action="read"` (`src/dashboard-routes.tsx:349-356`); DataGrid list + create modal + batch voucher print/export (500) | `src/api/routes/debit-notes.ts` (450) — `GET /` (`:122`), `POST /` (`:137`), `GET /:id` (`:282`), `PUT /:id` (`:302`) | `debit_notes` (items are JSON TEXT in one column), and on POSTED: `customers.outstandingSen`, `invoices.totalSen/subtotalSen/status`, the GL via `buildDebitNoteLedgerLegs` | **NONE dedicated.** Only cross-cutting sweeps name the file — `tests/tenant-isolation.test.mjs` lists it at line 151, plus `tests/security-route-coverage.test.mjs`, `tests/security-permission-matrix.test.mjs`, `tests/audit-coverage.test.mjs` |

**Endpoints called:** `GET /api/debit-notes` (`:78`, via `useCachedJson`),
`GET /api/invoices` (`:84`, only while the create modal is open),
`POST /api/debit-notes` (`:152`).

**Gotchas — three, all worth knowing before you touch this**

1. **The page cannot post a debit note.** `PUT /api/debit-notes/:id` (`debit-notes.ts:302`)
   is the ONLY transition that charges the customer (`:339` `outstandingSen + ?`), bumps the
   linked invoice and re-opens its status (`:375-381`), and writes the GL legs (`:396-410`).
   **No frontend calls it** — the only `/api/debit-notes` references in `src/` are the list,
   the create, and the generic CRUD factory `src/lib/api/resources/billing.ts:36`. Every DN
   raised from this screen stays DRAFT, while the page's own "Posted" tile (`:254`) counts a
   status nothing in the UI can reach.
2. **Per-id handlers are not tenant-scoped.** `GET /` scopes on `WHERE orgId = ?` (`:128`),
   but `GET /:id` (`:287`), `PUT /:id` (`:309`, `:331`) and the POST re-read (`:257`) select
   and update **by id alone**. `tests/tenant-isolation.test.mjs` passes anyway because it
   only asserts each route scopes *at least one* query. This is BUG-CLASSES C12 territory —
   check it before onboarding a second org.
3. **Money is sen and is read dual-keyed on the way out** (`item.unitPriceSen ?? item.unitPrice`,
   `item.totalSen ?? item.total`) at page `:49-50` and `:342-343`, and again in the route's
   `parseItems` (`:69-70`) — the Tier-D D2 back-compat for legacy rows written before the
   `unitPrice` → `unitPriceSen` rename. POST **rejects** a body carrying `unitPrice`
   (`:185-193`). Keep both halves.

**⚠ Read bug found — the MOBILE Debit Notes list shows RM 0.00 for every note.**
`src/pages/m/config/modules.ts:819-838` builds its rows with `str(r,"dnNo","debitNoteNo")`
and `num(r,"totalSen")`. The API returns **`noteNumber`** and **`totalAmount`**
(`debit-notes.ts:80`, `:89`) — neither `dnNo`, nor `debitNoteNo`, nor `totalSen` exists in
the response. `read()` in `src/pages/m/config/helpers.ts:35-41` returns `undefined`, so
`num` yields `0` (`:48-52`) and `str` yields `""`. Result: the Reference column is blank,
`code` falls back to the raw `dn-xxxxxxxx` id, and both the card amount and the Amount
column read RM 0.00. The **credit-notes source three rows above it has the identical shape**
(`cnNo` / `creditNoteNo` / `totalSen` vs `credit-notes.ts:87`, `:96` returning
`noteNumber` / `totalAmount`), so this is a two-instance class — fix both or it recurs
(fix-then-sweep, `docs/PLAYBOOKS.md`).

---

## 6. BOM — Component Kits

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/component-kits/index.tsx` — `/bom/component-kits` (`src/dashboard-routes.tsx:482`; sidebar PRODUCTION → "Component Kits"); kit cards + inline editor with multi-parent create (502) | `src/api/routes/component-boms.ts` (87) — `GET /` (`:30`), `GET /:parentCode` (`:38`), `PUT /:parentCode` (`:51`), `DELETE /:parentCode` (`:75`); logic in `src/api/lib/component-bom.ts` (`saveKit`, `explodeKits`) | `component_bom_lines` (runtime-created, `src/api/lib/component-bom.ts:32`) | `tests/component-kit-subbom.test.mjs` (functional explosion math + structural pins) |

**Endpoints called:** `GET /api/component-boms` (`:65`),
`GET /api/inventory?buckets=rawMaterials` (`:69`),
`PUT /api/component-boms/:parentCode` (`:150`),
`DELETE /api/component-boms/:parentCode` (`:190`).

**Gotchas**

- **`?buckets=rawMaterials` is a measured perf fix, not decoration** (`:66-69`,
  BUG-2026-08-13-021). Without it this uncached raw fetch pulled a 1.16 MB three-bucket
  payload on every `reload()`. Don't drop the query param.
- **A failed list read now THROWS on purpose** (`:75`). It used to fall through silently and
  leave the page on "No component kits yet" — indistinguishable from a genuinely empty list,
  which is exactly how a camelCase read bug in the backend stayed invisible *after a
  successful save*. This is the same de-fabrication rule the map applies elsewhere: an
  unknown must not render as a zero. Keep it loud.
- **Multi-parent save writes sequentially and reports partials** (`:144-172`). One rejected
  promise would hide which parents actually landed; the loop reports "3 of 4 saved, X
  failed" and keeps the editor open to retry. The self-reference guard runs BEFORE the loop
  (`:136-140`) so one bad pick cannot half-apply the save.
- The kit is the orthodox multi-level-BOM / phantom pattern: every product BOM referencing
  the parent SKU auto-explodes its children into consumption and costing via `explodeKits`
  (`src/api/lib/component-bom.ts:221`) and `po-cost-cascade.ts`. Never re-list the children
  in a product BOM.

---

## 7. Delivery — Delivery Returns

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/delivery-returns/index.tsx` — `/delivery-returns` (`src/dashboard-routes.tsx:300`; sidebar SALES & CUSTOMERS → "Delivery Return"); DataGrid list + create-from-DO modal; `?createFrom=<doId>` deep link from a DO (419). Detail page: `src/pages/delivery-returns/detail.tsx` at `/delivery-returns/:id` (`:302`) | `src/api/routes/delivery-returns.ts` (483) — 8 handlers, see below | `delivery_returns`, `delivery_return_items` (runtime-ensured by `ensureDeliveryReturnTables`, `src/api/lib/delivery-return-create.ts`); cascades touch `fg_batches`, `fg_units`, `cost_ledger`, `fg_stock_events` | **NONE dedicated.** The file appears only inside cross-cutting suites: `tests/fg-stock-events.test.mjs`, `tests/customer-scope.test.mjs`, `tests/customer-scope-sql.test.mjs`, `tests/derived-permissions.test.mjs`, `tests/nav-permissions.test.mjs`, `tests/permission-wildcards.test.mjs`, `tests/record-load-failure-class.test.mjs`, `tests/reverse-doc-links.test.mjs` |

**Route surface — `src/api/routes/delivery-returns.ts`**

| Handler | Line | Note |
|---|---|---|
| `GET /` | `:162` | org-scoped **and** `customerScopeSql` narrowed (`:169`), `LIMIT 500` |
| `GET /:id` | `:189` | by id only — **not** org-scoped |
| `GET /do-items?doId=` | `:213` | enrichment for the picker — **unreachable, see below** |
| `POST /` | `:227` | delegates to `createDeliveryReturnRecord` so the office flow and the driver "Not received" flow write an identical record |
| `POST /:id/return-to-stock` | `:340` | reverses COGS + flags `fg_units` RETURNED + status |
| `POST /:id/set-outcome` | `:387` | `PURE_RETURN` also runs the restock half |
| `POST /:id/mark-redelivered` | `:444` | |
| `POST /:id/cancel` | `:460` | refuses CLOSED / REDELIVERED / CN_ISSUED |

**Endpoints called by the page:** `GET /api/delivery-returns` (`:52`),
`GET /api/delivery-orders` (`:210-212`, filtered to DELIVERED/INVOICED at `:216`),
`GET /api/delivery-orders/:id` (`:233`),
`GET /api/delivery-returns/do-items?doId=` (`:243-245`),
`POST /api/delivery-returns` (`:292`).

**Gotchas**

- **Restock and repair are mutually exclusive by design.** Both `return-to-stock` (`:357`)
  and `set-outcome` (`:404`) 409 unless the DR is `OPEN`. That is what stops a unit being
  booked back as good stock *and* remade — a double count of inventory and COGS. The
  reversal itself is separately idempotent (`reverseFGForDeliveryReturn` no-ops on
  `refType='DELIVERY_RETURN' AND refId=drId`). Do not relax the OPEN check.
- `PURE_RETURN` = goods back in sellable stock **and** money refunded by CN, so `set-outcome`
  runs the restock statements inline (`:417-421`). `REPAIR_REDELIVER` touches no inventory.
- Creating a return invalidates the DO cache (`page :149`) because
  `GET /api/delivery-orders/:id` now returns `linkedReturns`.

**⚠ Route bug found and REPRODUCED — `GET /api/delivery-returns/do-items` is unreachable.**

`app.get("/:id")` is registered at `:189`; `app.get("/do-items")` at `:213`, **24 lines
later**. Hono matches in registration order here, so the param handler wins. Executed
against this repo's own `hono@4.12.14`, replicating the exact registration order:

```
/          -> list
/abc       -> byid:abc
/do-items  -> byid:do-items      ← should be "do-items"
```

So the request lands on the `/:id` handler, looks up a delivery return whose id is the
literal string `"do-items"`, finds none, and returns
`404 { success:false, error:"Delivery return not found" }`.

**Why nobody noticed:** the caller at `src/pages/delivery-returns/index.tsx:242-266` does not
throw on a 404 — `r2.json()` parses fine, `j2?.data ?? []` becomes an empty array, every
`refs.get(...)` misses, and each item is kept unmodified. No error, no toast, not even the
`catch` fallback at `:264`. The enrichment simply never happens, silently.

**What that costs:** the Cust PO / Ref line at `:383-395` is what tells two identical
products on one DO apart. Those fields are exactly the ones the DO's own items do **not**
carry — which is why `/do-items` was built (`:207-212`, and `:237-241`). The owner's
2026-07-16 complaint ("要不然我怎麼知道要選那個" — how am I supposed to know which one to
pick) is therefore still live in production. The list column at `:87-91` reads
`row.items[0].reference` off the persisted record, so it is unaffected; only the picker is.

**Fix:** move `app.get("/do-items")` above `app.get("/:id")`. The sibling route
`src/api/routes/three-pl-vehicles.ts:153-156` already documents this exact rule in a comment
and gets it right — cite it in the fix.

---

## 8. Fleet & Maintenance — 3PL Vehicles, Equipment

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| No page of its own — consumed by `src/pages/delivery/index.tsx` (provider/vehicle dialogs: `:1751`, `:2036`, `:2061`), `src/pages/consignment/note.tsx` (`:873`, `:927`, `:963`) and `src/pages/m/config/modules.ts:3999` | `src/api/routes/three-pl-vehicles.ts` (446) — `GET /collisions` (`:165`), `GET /` (`:195`), `POST /` (`:211`), `GET /:id` (`:305`), `PUT /:id` (`:320`), `DELETE /:id` (`:428`) | `three_pl_vehicles` (FK to the misnamed `drivers` table = 3PL **providers**) | `tests/tenant-isolation.test.mjs`, `tests/houzs-sweep-hardening.test.mjs` — **no feature test** |
| `src/pages/maintenance.tsx` — `/maintenance` (`src/dashboard-routes.tsx:480`); calls `/api/equipment` at `:79`, `:176`, `:211`, `:253`, `:257` | `src/api/routes/equipment.ts` (405) — `GET /` (`:110`), `POST /` (`:163`), `GET /:id` (`:213`, nested `logs`), `PUT /:id` (`:236`), `DELETE /:id` (`:389`) | `equipment`, `maintenance_logs` | `tests/equipment-assets-docs.test.mjs`, `tests/tenant-isolation.test.mjs` |

**`three-pl-vehicles.ts` gotchas**

- **`drivers` holds PROVIDERS, not people.** Migration 0014's naming misnomer; each provider
  row owns many vehicles here, and pricing follows the truck (`ratePerTripSen`,
  `ratePerExtraDropSen`) because a 3-ton and a 5-ton from the same dispatcher quote
  different rates. DO POST/PUT looks a vehicle up here to denormalise plate + type onto the
  DO row and recompute `deliveryCostSen`.
- **This file is the repo's reference example of Hono route ordering** — `/collisions` is
  mounted at `:165`, before `/:id` at `:305`, with the reason written down at `:153-156`.
  §7 above is the same file family getting it wrong; use this one as the fix template.
- **`plate_norm` is deliberately NON-unique** (`:55-59`). Production already contains
  collisions and a unique index would either fail to build or start rejecting saves before
  anyone decides which duplicate wins and what happens to the delivery history on the loser.
  `GET /collisions` reports them; the repair is the owner's call. New duplicates are blocked
  at POST (`:249-262`), so the list can only shrink. Renaming a plate re-normalises it
  (`:400-402`) or the row keeps matching its old identity forever.
- **`GET /` (`:195`) and `GET /:id` (`:305`) carry NO `requirePermission` gate**; only
  POST/PUT/DELETE do (`lorries` create/update/delete). And only `GET /` is org-scoped
  (`:200-201`) — `/:id`, PUT and DELETE act by id alone, and the POST duplicate check
  (`:250`) is org-WIDE with no comment saying whether that is intentional. Contrast the
  consignment routers, where the deliberate org-wide reads are commented in place.
- **Minor read bug: `createdAt` / `updatedAt` are always `""` in this route's responses.**
  `rowToVehicle` (`:128-129`) reads `row.created_at` / `row.updated_at`, but the queries are
  `SELECT *` and the PG adapter rewrites snake→camel on read
  (`src/api/lib/db-pg.ts:47-59`, using the inverse of `column-rename-map.json`, which maps
  `createdAt→created_at` and `updatedAt→updated_at`). So the row keys are `createdAt` /
  `updatedAt` and the snake reads miss. The `boxLengthFt` family two lines below is dual-keyed
  correctly (`:133-135`) — these two were missed. No current caller displays them, hence low
  severity; fix with `row.createdAt ?? row.created_at`.

**`equipment.ts` gotchas**

- `PUT /:id` is **two endpoints in one**: a `{ logMaintenance: {...} }` body appends a
  `maintenance_logs` row, advances `lastMaintenanceDate`/`nextMaintenanceDate` by
  `maintenanceCycleDays`, and clears MAINTENANCE/REPAIR back to OPERATIONAL (`:254-306`);
  anything else is a partial merge update (`:308-347`). The `pick()` helper (`:311`) exists
  so a partial PUT from one dialog cannot blank fields another dialog owns.
- The asset-identity columns (model / serial_no / manufacturer / supplier /
  purchase_price_sen / warranty_expiry, owner 2026-08-01) are **runtime self-applied** by
  `ensureEquipmentAssetColumns` (`:133-155`) — migration files are inert on deploy. The memo
  flag is set only when EVERY statement lands (`ok`, `:135`/`:154`) so a half-applied schema
  is retried rather than remembered as done. Reads are dual-keyed (`:72`, `:77`, `:78`).
- `maintenance_logs` has **no `created_at` column in production** — the INSERT at `:262-264`
  omits it deliberately (BUG-2026-08-13-031); the note lives in `routes/maintenance-logs.ts`.
- Money: `toSen` (`:158-161`) converts the form's ringgit to integer sen on the way in;
  storage is `purchase_price_sen`. Never store the ringgit.
- **`GET /` (`:110`) and `GET /:id` (`:213`) carry no `requirePermission` gate**; and only
  `GET /` is org-scoped (`:114`). Same shape as the 3PL route above.

---

## Verification performed

- `node scripts/check-codebase-map.mjs` — see the PR body for the run output.
- `wc -l` on all 12 target files + `src/dashboard-routes.tsx`; every count in the tables above
  is that command's output. **`wc -l` is this map's convention** — checked against a row that
  has not drifted: the map says `src/pages/sales/index.tsx` (2181) and `wc -l` says 2181.
  `scripts/check-codebase-map.mjs` prints counts **one higher** (`login.tsx (1289 lines)`)
  because it measures `split(/\r?\n/).length`, which yields a trailing empty element on any
  newline-terminated file. Both numbers are right about different things; the MAP uses
  `wc -l`. Recording this so the two figures stop being "corrected" into each other.
- Every `file:LINE` in this fragment was opened and read; no claim rests on grep or on a
  comment alone.
- The §7 routing bug was reproduced by executing the registration order against
  `hono@4.12.14` resolved from this repo — not inferred from documentation.
- The §5 mobile read bug was confirmed by reading `read()`/`str()`/`num()` in
  `src/pages/m/config/helpers.ts:35-52` against the response builders in
  `src/api/routes/debit-notes.ts:77-93` and `src/api/routes/credit-notes.ts:87,96`.
- Fabricated-data sweep over all 12 files: **clean**. The only `Math.random` hits are
  `src/pages/login.tsx:130` (a comment recording that it was REPLACED by a seeded LCG for
  snowflake positions) and `src/api/routes/debit-notes.ts:100` (a comment recording a fixed
  2026-04-28 DN-numbering bug). No mock rows, no invented document numbers, no statuses
  rendered as real. `login.tsx:1201-1204` records an earlier fabricated stat panel that was
  already deleted.
- **No test names were invented.** Where a file has no test, this fragment says **NONE** and
  names the cross-cutting suites that merely mention it.

### Map fragment — Scanning Queue, OCR, Public QR, AI Assistant, TOTP, Orgs & CRM/Leads

> **Last verified: 2026-08-13** against the eight route files below, `src/api/worker.ts`
> (mount lines), `src/api/lib/auth-middleware.ts` (`PUBLIC_PATHS` / `PUBLIC_PREFIXES`),
> `src/api/lib/rbac.ts` (`requirePermission`), `src/api/lib/tenant.ts` (`getOrgId`),
> `src/api/lib/api-rate-limit-config.ts`, `migrations/0026_po_scan_samples.sql`,
> `migrations/0049_multi_tenant_skeleton.sql`, `src/router.tsx`, `src/dashboard-routes.tsx`,
> and every test named here. Every endpoint line ref was read in the file, not grepped.
>
> **This is a FRAGMENT** staged for assembly into `docs/CODEBASE-MAP.md` — none of these
> eight routers had ever been named in the map. Do not treat it as a second map.
>
> **Line counts are `wc -l`.** Editors that count a final unterminated line report +1.

**All eight routers are LIVE** (mounted in `src/api/worker.ts`). Every mount below sits
*after* the global gate `app.use("/api/*", authMiddleware)` (`src/api/worker.ts:913`), so a
route is public only when its path is listed in `PUBLIC_PATHS` / `PUBLIC_PREFIXES` inside
`src/api/lib/auth-middleware.ts`. `customerScopeMiddleware` (`src/api/worker.ts:927`),
`tenantMiddleware` (`src/api/worker.ts:934`) and `apiRateLimit` (`src/api/worker.ts:949`)
run after it, so **public routes still pass through the rate limiter** but reach the
handler with no `userId`, no `userRole` and no orgId on the context.

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/components/scan-po-modal.tsx` — customer-PO scan wizard, in-modal queue polling (3439) · `src/lib/so-original.ts` — keeps the customer's original PO on the SO for EVERY create path (94); extracted out of the modal because the in-modal version silently saved nothing for a month, see BUG-2026-08-19-155 | `src/api/routes/scan-queue.ts` — async OCR queue for PO + supplier scans (1541); mounted `src/api/worker.ts:1406` | `scan_queue` (self-created, `src/api/routes/scan-queue.ts:108`) | `tests/ocr-accuracy-sampleid.test.mjs` |
| `src/components/scan-supplier-modal.tsx` — supplier PI/GRN scan wizard (5876) · `src/lib/scan-queue-client.ts` — consume + source-doc upload helpers (143) — the source-doc upload takes a local File OR a queue row, because a direct upload has no queue row (BUG-2026-08-19-156) | `src/api/routes/scan-po.ts` — customer-PO OCR + few-shot samples + per-customer prompt rules (1075); mounted `src/api/worker.ts:1396` | `po_scan_samples` (**no org column** — `migrations/0026_po_scan_samples.sql`) / `customers.ocrPromptRules` | `tests/ocr-accuracy-customer-grouping.test.mjs` |
| `src/pages/do-scan.tsx` — PUBLIC driver scan page, routed `/d/:token` (`src/router.tsx:105`) (1031) | `src/api/routes/public-do-qr.ts` — **PUBLIC** DO / packing-list dispatch+deliver QR flow (1019); mounted `src/api/worker.ts:1210` | `delivery_orders` / `delivery_order_items` / `packing_lists` / `production_orders` / `sales_orders` / `job_cards` (+ everything the DO cascade writes) | `tests/do-qr-public.test.mjs` / `tests/security-public-endpoints.test.mjs` / `tests/delivery-incomplete-dual-key.test.mjs` |
| `src/components/assistant/AssistantSlideOver.tsx` — chat panel (1318) · `src/components/assistant/FloatingChatButton.tsx` | `src/api/routes/assistant.ts` — Hookka AI SSE chat + tool loop (995); mounted `src/api/worker.ts:1441` (history router first at `src/api/worker.ts:1440`) | `audit_events` (one row per tool call) + whatever `src/api/lib/assistant-tools.ts` reads (60 tools incl. an arbitrary-SELECT tool) | `tests/assistant-agent-command-prompt.test.mjs` |
| `src/pages/setup-2fa.tsx` — soft-prompt 2FA setup (278) · `src/pages/login.tsx` — step-2 code entry | `src/api/routes/auth-totp.ts` — TOTP enroll / verify / login-verify / disable (612); mounted `src/api/worker.ts:1278` · `src/api/lib/totp-pending.ts` — pending-2FA token (the password gate) | `users` (`totpSecret` / `totpEnrolledAt` / `totpRecoveryHashes`) / `user_sessions` / `totp_pending_logins` / `audit_events` | `tests/totp-login-password-gate.test.mjs` (real handlers) · the public-path snapshot `tests/security-public-endpoints.test.mjs` |
| `src/pages/settings/organisations.tsx` — sister-company registry (796) | `src/api/routes/organisations.ts` — org registry CRUD + active-org switch (680); mounted `src/api/worker.ts:1193` · `src/lib/org-letterhead-row.ts` — is a registry row printable? | `organisations` / `inter_company_config` / `suppliers.purchase_org_code` | `tests/organisations-registry-projection.test.mjs` |
| `src/components/customer/CrmPanel.tsx` — contacts + timeline (294) · `src/components/customer/KycPanel.tsx` — onboarding/KYC (124) | `src/api/routes/customer-crm.ts` — contacts / activities / follow-ups / onboarding / send-quote (583); mounted `src/api/worker.ts:1190` | `customer_contacts` / `customer_activities` / `customer_onboarding` / `customers` (recipient allow-list) / `customer_wishlist` (retired, rows kept) | `tests/customer-crm.test.mjs` / `tests/crm-activity-and-catalog.test.mjs` / `tests/customer-kyc.test.mjs` / `tests/customer-crm-wishlist-send.test.mjs` / `tests/customer-crm-quote-recipient.test.mjs` |
| `src/pages/leads/index.tsx` — pipeline board, routed `/leads` (`src/dashboard-routes.tsx:414`) (929) | `src/api/routes/sales-leads.ts` — pre-sale pipeline + lead catalog + convert (437); mounted `src/api/worker.ts:1191` | `sales_leads` / `lead_products` / `customers` / `customer_products` / the four CRM side-tables | `tests/sales-leads.test.mjs` / `tests/lead-catalog.test.mjs` / `tests/lead-convert.test.mjs` |

> **Every test in the right-hand column is a SOURCE-TEXT test** — it `readFileSync`s the
> route and asserts the source contains (or no longer contains) a pattern. None of them
> boot the worker or hit a DB. They pin shape, not behaviour: a handler can be structurally
> correct and still return the wrong rows. Treat "covered" here as "a rename or a deletion
> trips CI", nothing stronger.

---

## Endpoints + auth posture

Posture is read off the handler body, not the header comment. `requirePermission`
(`src/api/lib/rbac.ts:188`) short-circuits `null` for SUPER_ADMIN and ADMIN
(`src/api/lib/rbac.ts:210`), so every "permission-gated" row below is fully open to those
two roles. "Org-scoped" means the SQL carries an `org_id` / `orgId` bind.

### `src/api/routes/scan-queue.ts` — async OCR queue

| Method + path | Ref | Posture | Org scope |
|---|---|---|---|
| POST `/api/scan-queue/upload` | `src/api/routes/scan-queue.ts:698` | `purchase-orders:create` | writes `org_id` from `getOrgId` |
| GET `/api/scan-queue/batch/:batchId` | `src/api/routes/scan-queue.ts:876` | `purchase-orders:create` | `(org_id = ? OR org_id IS NULL)` |
| GET `/api/scan-queue/pending` | `src/api/routes/scan-queue.ts:956` | `purchase-orders:create` | org + `created_by = <caller>` |
| GET `/api/scan-queue/:id` | `src/api/routes/scan-queue.ts:1081` | `purchase-orders:create` | org-filtered |
| GET `/api/scan-queue/:id/bytes` | `src/api/routes/scan-queue.ts:1141` | `purchase-orders:create` | org-filtered; returns raw PDF/image bytes |
| POST `/api/scan-queue/:id/retry` | `src/api/routes/scan-queue.ts:1201` | `purchase-orders:create` | org-filtered SELECT, then an id-only UPDATE (transitively safe) |
| POST `/api/scan-queue/:id/consume` | `src/api/routes/scan-queue.ts:1273` | `purchase-orders:create` | org-filtered |

The sweeper is **not** in this router: `sweepStuckScans` (`src/api/routes/scan-queue.ts:1414`)
is exported and mounted by hand as `POST /api/internal/scan-queue-sweep`
(`src/api/worker.ts:790`), registered **before** `authMiddleware` and gated by a
constant-time `CRON_SECRET` compare that 503s when the secret is unset or under 16 chars
(`src/api/worker.ts:791-798`). Its SQL is deliberately org-blind — it is a system sweep.

Internals: `ensureScanQueueTable` (`src/api/routes/scan-queue.ts:101`) ·
`hydrateRow` (`src/api/routes/scan-queue.ts:235`) ·
`processBatch` (`src/api/routes/scan-queue.ts:317`) ·
`processOneAtATime` (`src/api/routes/scan-queue.ts:328`) ·
`sweepStuckBatch` (`src/api/routes/scan-queue.ts:1495`, the real recovery path — Pages has
no cron, so the poll endpoints self-heal).

### `src/api/routes/scan-po.ts` — customer-PO OCR

| Method + path | Ref | Posture | Org scope |
|---|---|---|---|
| GET `/api/scan-po/catalog` | `src/api/routes/scan-po.ts:486` | `purchase-orders:create` | org-scoped catalog load |
| POST `/api/scan-po/extract` | `src/api/routes/scan-po.ts:525` | `purchase-orders:create` **plus a secret-header bypass** (below) | reads org-scoped catalog; writes an org-less sample row |
| POST `/api/scan-po/samples/:id/confirm` | `src/api/routes/scan-po.ts:712` | `purchase-orders:create` | **none** on the sample UPDATE; the customer-name read at `:767` is also org-blind |
| GET `/api/scan-po/samples/by-po/:poIdentifier` | `src/api/routes/scan-po.ts:847` | `purchase-orders:create` | **none** |
| PATCH `/api/scan-po/samples/by-po/:poIdentifier` | `src/api/routes/scan-po.ts:904` | `purchase-orders:create` | **none** |
| GET `/api/scan-po/customer-rules/:customerId` | `src/api/routes/scan-po.ts:946` | `customers:read` | `AND orgId = ?` |
| PUT `/api/scan-po/customer-rules/:customerId` | `src/api/routes/scan-po.ts:977` | `customers:update` | `AND orgId = ?` |
| POST `/api/scan-po/customer-rules/:customerId/distill` | `src/api/routes/scan-po.ts:1033` | `customers:update` | orgId passed to the distiller |

**The secret-header bypass is real and easy to miss.** `authMiddleware` grants a
SUPER_ADMIN identity to any POST to exactly `/api/scan-po/extract` or
`/api/scan-supplier/extract` that presents a matching `x-scan-worker` header
(`src/api/lib/auth-middleware.ts:338-357`, constant-time compare, secret must be ≥16
chars). It stamps `userId = "scan-worker"` / `userRole = "SUPER_ADMIN"`, which is what
makes the in-route `requirePermission` pass. The comment above it describes a self-fetch
that **no longer happens** — `src/api/routes/scan-queue.ts:690-691` records that the queue
worker now calls `runExtract` directly, with "no self-fetch, no SCAN_WORKER_TOKEN". The
bypass is dead code with a live key.

Post-processing helpers: `reparseSpec` (`src/api/routes/scan-po.ts:115`) ·
`applySofaLhfRhfFromTv` (`src/api/routes/scan-po.ts:176`) ·
`normalizeForMatch` (`src/api/routes/scan-po.ts:259`) ·
`validateAndEnrichPO` (`src/api/routes/scan-po.ts:268`).

### `src/api/routes/public-do-qr.ts` — PUBLIC, unauthenticated

Auth bypass is the prefix `"/api/public/do-qr/"` (`src/api/lib/auth-middleware.ts:93`).
**The 64-hex `qrtoken` IS the entire credential** — there is no session, no CSRF (the CSRF
check only fires when a session cookie is present, `src/api/lib/auth-middleware.ts:383`),
and no expiry on the token. Rate limit is tightened to 30/min + 300/hr per client IP
(`src/api/lib/api-rate-limit-config.ts:63`).

| Method + path | Ref | Posture |
|---|---|---|
| GET `/api/public/do-qr/:token/edit` | `src/api/routes/public-do-qr.ts:616` | **PUBLIC** — DRAFT-only item-edit model |
| GET `/api/public/do-qr/:token` | `src/api/routes/public-do-qr.ts:665` | **PUBLIC** — minimal summary |
| POST `/api/public/do-qr/:token/advance` | `src/api/routes/public-do-qr.ts:713` | **PUBLIC** — forward-only DISPATCH / DELIVER |

Token shape is pinned by a regex at `src/api/routes/public-do-qr.ts:67` and checked before
any DB touch in all three handlers. Resolution covers both tables:
`resolveToken` (`src/api/routes/public-do-qr.ts:187`) tries `delivery_orders.qrtoken`
first, then `packing_lists.qrtoken` (a PL token fans out to all its member DOs).
`summarizeDos` (`src/api/routes/public-do-qr.ts:126`) and
`buildSummaryPayload` (`src/api/routes/public-do-qr.ts:261`) build the no-price payload.
`loadDoEditModel` (`src/api/routes/public-do-qr.ts:322`) builds the trusted edit set.

**Why the write path is safe despite being public** — worth reading before touching it:

- The transition is not reimplemented. `applyDeliveryOrderUpdate` (imported from
  `src/api/routes/delivery-orders.ts`) is the *same* function behind the office
  `PUT /api/delivery-orders/:id`, called at `src/api/routes/public-do-qr.ts:944`, so
  fg_units stamping, STOCK_OUT movements, the SO cascade, FIFO COGS and the auto-DRAFT
  invoice all fire identically. A guard added to the office path protects the QR path for
  free — and one removed there is removed here too.
- Forward-only by table lookup at `src/api/routes/public-do-qr.ts:686`: DISPATCH is
  DRAFT→LOADED, DELIVER is LOADED/IN_TRANSIT→DELIVERED. Past statuses are SKIPPED, not
  errored; anything else is BLOCKED. No reversal is reachable.
- The item edit never trusts the body. The page posts only production-order **ids**; the
  server rebuilds each line from `allowedById` (current DO items ∪ same-customer,
  same-state, delivery-ready POs) and 409s on an id outside that set
  (`src/api/routes/public-do-qr.ts:836-849`).
- Tenancy comes off the resolved row, not the request: the DO's own `orgId` is stashed onto
  the context at `src/api/routes/public-do-qr.ts:908` before the cascade runs, and a row
  with no org is FAILED rather than defaulted (`src/api/routes/public-do-qr.ts:899`).

### `src/api/routes/assistant.ts` — Hookka AI

| Method + path | Ref | Posture |
|---|---|---|
| POST `/api/assistant/chat` | `src/api/routes/assistant.ts:501` | **any logged-in user**; SUPER_ADMIN gets all tools, everyone else gets 3 |

**The file's own header comment (`src/api/routes/assistant.ts:6`) and the mount comment
(`src/api/worker.ts:1433`) both say "SUPER_ADMIN only". Both are stale.** The owner opened
the chat to all staff on 2026-07-28; the code now allows any authenticated caller and
narrows the *tools* instead, in two independent places:

1. Schema filter — non-super-admins are only offered `agent_overview`, `agent_control`,
   `teach_agent` (set at `src/api/routes/assistant.ts:568`, applied at
   `src/api/routes/assistant.ts:738`).
2. Dispatch guard — even a hallucinated tool name is refused at the dispatcher for a
   non-super-admin (`src/api/routes/assistant.ts:915`).

So the data / SQL / payroll tools (including the arbitrary-`SELECT` tool in
`src/api/lib/assistant-tools.ts`) stay owner-only. Other things read from the code, not the
comments: a kill switch fires before anything else when `ASSISTANT_ENABLED === "false"` and
returns a normal 200 SSE stream (`src/api/routes/assistant.ts:510`); the per-user daily
question cap is checked at `src/api/routes/assistant.ts:591` and **SUPER_ADMIN is exempt**
(`src/api/routes/assistant.ts:588`). Wire format helper: `sseEvent`
(`src/api/routes/assistant.ts:496`). The prompt is exported for the offline eval harness
(`src/api/routes/assistant.ts:72`).

### `src/api/routes/auth-totp.ts` — second factor

| Method + path | Ref | Posture |
|---|---|---|
| POST `/api/auth/totp/enroll` | `src/api/routes/auth-totp.ts:84` | session required; acts on `c.get("userId")` only |
| POST `/api/auth/totp/verify` | `src/api/routes/auth-totp.ts:141` | session required |
| POST `/api/auth/totp/login-verify` | `src/api/routes/auth-totp.ts:197` | **PUBLIC** (`src/api/lib/auth-middleware.ts:40`) — issues a full session, **but only against a pending-2FA token minted by `/login` when the password verified** (BUG-2026-08-13-101) |
| POST `/api/auth/totp/setup-start` | `src/api/routes/auth-totp.ts:396` | session required |
| POST `/api/auth/totp/setup-confirm` | `src/api/routes/auth-totp.ts:472` | session required |
| POST `/api/auth/totp/dismiss-prompt` | `src/api/routes/auth-totp.ts:543` | session required |
| POST `/api/auth/totp/disable` | `src/api/routes/auth-totp.ts:565` | session required **+ password re-auth** |

Only `/login-verify` is public, and that is explicit in the middleware — the sibling
`/setup-start`, `/setup-confirm` and `/dismiss-prompt` are NOT public, and the middleware
says so in place (`src/api/lib/auth-middleware.ts:41-44`). Every session-required handler
resolves its subject from the context via `ctxUserId` (`src/api/routes/auth-totp.ts:76`) and
never from the body, so there is no cross-user reach. `/login-verify` is throttled at 10
attempts / 15 min keyed on `totp:<userId>` (`src/api/routes/auth-totp.ts:217-219`), burns a
recovery-code hash on use (`src/api/routes/auth-totp.ts:293-299`), and audits both the fail
and the success.

**The password gate (BUG-2026-08-13-101, fixed 2026-08-13).** `/login-verify` used to take
`{ userId, code }` and issue a session with no proof that step 1 had happened — for an
enrolled user a user id plus one TOTP or recovery code was the whole credential. `/login`
now mints a short-lived (5 min), single-use, SHA-256-hashed pending token when the PASSWORD
verifies (`src/api/lib/totp-pending.ts`, table `totp_pending_logins`, migration record
`migrations-postgres/0225_totp_pending_logins.sql`) and `/login-verify` refuses without it.
The check runs BEFORE the code is read, so a token-less request cannot burn a recovery code;
the row is burned only once a session exists, so a mistyped code does not cost the operator
their password step. Deliberately not the sessions table — a pending row must never be
resolvable by the auth middleware. Guarded by `tests/totp-login-password-gate.test.mjs`.

Two schema facts that stop repeat archaeology: there is **no `user_totp_secrets` table** —
state lives on `users`, and "pending vs enabled" is `totpEnrolledAt IS NULL` vs a timestamp
(`src/api/routes/auth-totp.ts:378-382`). Enrollment writes the secret immediately and only
flips `totpEnrolledAt` on a proven code, so an abandoned enrollment is inert.

### `src/api/routes/organisations.ts` — org registry

| Method + path | Ref | Posture | Org scope |
|---|---|---|---|
| GET `/api/organisations` | `src/api/routes/organisations.ts:285` | authenticated; deliberately **no `requirePermission`** — the RECORD narrows instead (see below) | `WHERE org_id = ?` |
| POST `/api/organisations` | `src/api/routes/organisations.ts:328` | `organisations:update` | stamps `getOrgId(c)`; dedupes on `(org_id, code)` |
| PATCH `/api/organisations/:id` | `src/api/routes/organisations.ts:422` | `organisations:update` | `id = ? AND org_id = ?` on the read, the UPDATE and the read-back |
| DELETE `/api/organisations/:id` | `src/api/routes/organisations.ts:530` | `organisations:update` | `id = ? AND org_id = ?`; soft-delete, refuses the default org |
| PUT `/api/organisations` | `src/api/routes/organisations.ts:557` | `organisations:update` | `id = ? AND org_id = ?`; three body shapes (`orgId` switch / `organisation` patch / `interCompanyConfig`) |

The GET response shape has no `success` wrapper — the Settings page and the sidebar switcher
consume `{ organisations, activeOrgId, interCompanyConfig }` directly. It degrades in two
steps: `loadOrganisations` (`src/api/routes/organisations.ts:201`) falls back to a legacy
column list when migration 0142's columns are missing, then to a hardcoded two-org constant
(`src/api/routes/organisations.ts:147`) when the table itself is absent. The new columns
reach prod only through the runtime self-apply `ensureOrganisationRegistry`
(`src/api/routes/organisations.ts:228`) — called by POST/PATCH/DELETE/PUT but **not**
by GET, which is why GET needs the fallback at all. That legacy fallback is also why the
`org_id` predicate degrades to an UNSCOPED read rather than to the two-org constant: losing
the predicate is a smaller wrong than replacing a real registry with a hardcoded one.

**Two response shapes (BUG-2026-08-13-100).** The endpoint stays open to every signed-in
caller because the sidebar switcher renders for all staff — the ROW is what narrows. A
caller holding `organisations:read` **or** `purchase-orders:read` gets the full registry row
plus `interCompanyConfig`. Everyone else gets `{ id, code, name, isActive, displayOrder }`
and `restricted: true`, with `tin` / `regNo` / `address` / `phone` / `email` /
`businessType` / `transferPricingPct` / `interCompanyConfig` **omitted, not blanked** —
because `letterheadForPurchaseOrg` prints whatever it is handed, and a blank string would
put "Reg.  | TIN " on a purchase order (C16). The absence is what lets
`hasLetterheadDetails` (`src/lib/org-letterhead-row.ts`) fall back to the hardcoded
letterhead. `purchase-orders:read` is the second key precisely so QA keeps its PO letterhead
without `organisations:read` also unhiding `/settings/organisations` in its menu
(`nav-permissions.ts` maps that path to `organisations`, and `hiddenNavPrefixes` unhides on
`:read`).

**The active organisation is PER USER (BUG-2026-08-13-097).** It used to be written to
`inter_company_config`, a **singleton row `id = 1`**, so one operator switching company
flipped the switcher for every other signed-in user in every tenant. The switcher now writes
`users.active_org_id` for the caller (`src/api/routes/organisations.ts:680`) and reads it
back per request (`:256`). Resolution order is `resolveActiveOrgId` (`:285`): the user's own
pick → the legacy singleton → the first visible org, with **both stored ids checked against
the organisations this caller can see** (a pick can now go stale, and an unresolvable id
makes `sidebar.tsx` print its hardcoded "HOOKKA INDUSTRIES" label for a company that is not
active). Keeping the singleton as the second rung is what stops every mid-session user from
being snapped to a different company on deploy — nothing writes it any more, and it is
deliberately not dropped.

**This field is NOT the tenant boundary, and never was.** `getOrgId(c)`
(`src/api/lib/tenant.ts:109`) resolves the request's org from the session's `users.orgId`
and never reads `inter_company_config`, so switching company has never rescoped a single
query — despite `switchOrg` in `sidebar.tsx:444` doing a full `window.location.reload()`,
which reads as though it should. `activeOrgId` drives exactly two things: the switcher's
label + tick (`sidebar.tsx:894`/`:949`) and the highlight ring on Settings → Organisations
(`settings/organisations.tsx:329`). **Open owner question:** `PUT /api/organisations` is
gated on `organisations:update`, so SALES / HR / R&D see a switcher whose clicks 403 and are
swallowed. That was defensible for a company-wide config; for a personal UI preference it is
probably the wrong gate — not changed unilaterally.

`users.active_org_id` reaches prod via `src/api/lib/ensure-user-active-org.ts` (awaited
before the switcher's UPDATE — migrations are inert on deploy), DDL mirrored in
`migrations-postgres/0226_user_active_org.sql`. Tests: `tests/user-active-org.test.mjs`,
red-proved by `tests/user-active-org-red-proof.mjs`.

### `src/api/routes/customer-crm.ts` — CRM layer

| Method + path | Ref | Posture | Org scope |
|---|---|---|---|
| GET `/api/customer-crm/contacts` | `src/api/routes/customer-crm.ts:175` | `customers:read` | yes |
| POST `/api/customer-crm/contacts` | `src/api/routes/customer-crm.ts:191` | `customers:update` | yes |
| PUT `/api/customer-crm/contacts/:id` | `src/api/routes/customer-crm.ts:224` | `customers:update` | yes |
| DELETE `/api/customer-crm/contacts/:id` | `src/api/routes/customer-crm.ts:252` | `customers:delete` | yes |
| GET `/api/customer-crm/activities` | `src/api/routes/customer-crm.ts:266` | `customers:read` | yes |
| POST `/api/customer-crm/activities` | `src/api/routes/customer-crm.ts:285` | `customers:update` | yes |
| DELETE `/api/customer-crm/activities/:id` | `src/api/routes/customer-crm.ts:322` | `customers:delete` | yes |
| GET `/api/customer-crm/follow-ups` | `src/api/routes/customer-crm.ts:336` | `customers:read` | yes |
| GET `/api/customer-crm/onboarding` | `src/api/routes/customer-crm.ts:359` | `customers:read` | yes |
| PUT `/api/customer-crm/onboarding` | `src/api/routes/customer-crm.ts:374` | `customers:update` | writes org, but see the upsert note |
| POST `/api/customer-crm/send-quote` | `src/api/routes/customer-crm.ts:425` | `customers:update`, **and** the recipient must be an address on the customer's own file (`recipientsForCustomer`, BUG-2026-08-13-102) | customer + contacts lookups and the activity row all carry org |

This is the best-scoped router of the eight: every read and every write carries
`AND org_id = ?`. Two edges to know. (1) The onboarding upsert is
`ON CONFLICT(customer_id)` (`src/api/routes/customer-crm.ts:385`) and
`customer_onboarding.customer_id` is the whole primary key
(`src/api/routes/customer-crm.ts:109`) — the conflict target does not include `org_id`, so
in a real second tenant two orgs sharing a customer id would overwrite each other's KYC
block. (2) PUT/DELETE return `success: true` without checking `changes`, so a wrong id and
a cross-org id are both reported as a successful edit.

Tables are runtime self-applied by `createCrmTables`
(`src/api/routes/customer-crm.ts:55`) behind the promise memo `ensureTables`
(`src/api/routes/customer-crm.ts:45`) — a boolean memo here was a real bug (concurrent
first-requests each ran the whole DDL block, and a failed round was remembered as done).
The wishlist feature is retired but its table is deliberately kept
(`src/api/routes/customer-crm.ts:409-413`) — do not "clean it up".

### `src/api/routes/sales-leads.ts` — pre-sale pipeline

| Method + path | Ref | Posture | Org scope |
|---|---|---|---|
| GET `/api/sales-leads` | `src/api/routes/sales-leads.ts:102` | `customers:read` | yes |
| POST `/api/sales-leads` | `src/api/routes/sales-leads.ts:155` | `customers:update` | lead row yes; the customer it mints, **no** |
| PUT `/api/sales-leads/:id` | `src/api/routes/sales-leads.ts:228` | `customers:update` | yes |
| PUT `/api/sales-leads/:id/stage` | `src/api/routes/sales-leads.ts:258` | `customers:update` | yes |
| POST `/api/sales-leads/:id/convert` | `src/api/routes/sales-leads.ts:295` | `customers:update` | side-tables yes; `customer_products` copy **no** |
| DELETE `/api/sales-leads/:id` | `src/api/routes/sales-leads.ts:359` | `customers:delete` | yes |
| GET `/api/sales-leads/lead-products` | `src/api/routes/sales-leads.ts:374` | `customers:read` | yes |
| POST `/api/sales-leads/lead-products` | `src/api/routes/sales-leads.ts:389` | `customers:update` | yes |
| DELETE `/api/sales-leads/lead-products/:id` | `src/api/routes/sales-leads.ts:427` | `customers:delete` | yes |

A lead **is** a potential customer (owner 2026-08-01): POST mints a real `customers` row
immediately via `createPotentialCustomerForLead` (`src/api/routes/sales-leads.ts:233`),
stamped `customer_stage = 'POTENTIAL'` with no creditor code and zero credit limit, and
links it back onto `sales_leads.customer_id`. That insert is **best-effort on purpose**
(`src/api/routes/sales-leads.ts:199`) — losing the typed-in lead because a customer insert
hiccuped would be worse than a lead without an account. Convert
(`src/api/routes/sales-leads.ts:295`) never creates the customer; it re-points the four
entity-keyed CRM side-tables listed at `src/api/routes/sales-leads.ts:288` from the lead id
to the customer id, copies `lead_products` into `customer_products`, and stamps WON. Lead
products live in their own table specifically so an unconfirmed lead cannot leak into the
pricing engine (`src/api/routes/sales-leads.ts:56-60`).

---

## Gotchas

- **`assistant.ts`'s own header says SUPER_ADMIN-only and is wrong** (`src/api/routes/assistant.ts:6`,
  echoed at `src/api/worker.ts:1433`). The gate moved from the route to the tool list on
  2026-07-28. Any staff role can open the chat; only the tool set differs. `tests/assistant-agent-command-prompt.test.mjs`
  pins the current behaviour — trust the test and the code, not the two comments.
- **`scan-queue.ts` says the browser navigates to `/scan-queue/<batchId>`** (`src/api/routes/scan-queue.ts:19`).
  **That page does not exist** — no such route is registered in `src/router.tsx` or
  `src/dashboard-routes.tsx`. Polling happens inside the modals: `src/components/scan-po-modal.tsx:109`
  and `src/components/scan-supplier-modal.tsx:581` poll `/batch/:batchId`, and both resume
  via `/pending`. Do not go looking for a queue page.
- **`(org_id = ? OR org_id IS NULL)` is the scan-queue tenancy idiom** (seven places in
  `src/api/routes/scan-queue.ts`). It is legacy tolerance for rows written before the
  column existed — but it also means any row that lands with a NULL org is visible to
  every tenant. New writes always stamp the org, so the null-tolerant half should shrink,
  not grow.
- **`po_scan_samples` has no org column at all** — see `migrations/0026_po_scan_samples.sql`.
  Every read, write and the few-shot selection over that table is therefore global. This is
  the root of finding S2 below; treat the table as a single shared pool until a column is
  added.
- **The DO QR token never expires and is not rotated.** Minting is authed-only (the
  `/:id/qr-token` endpoints on the DO and PL routers) and `public-do-qr.ts` never mints —
  `tests/do-qr-public.test.mjs` pins both properties. But a printed DO that leaves the
  building carries a permanently valid dispatch/deliver credential for that document.
- **`public-do-qr.ts`'s header claims "minimal exposure"** (`src/api/routes/public-do-qr.ts:19`).
  True for `GET /:token`. **Not true for `GET /:token/edit`**, added later for the item-edit
  flow: it also returns every *addable* production order for that customer and state — PO
  number, product code and name, size, fabric code, quantity, racking number, SO number and
  customer PO number (`src/api/routes/public-do-qr.ts:517-531`). Still no prices, still one
  customer, but it is a pipeline listing, not a document summary.
- **`delivery_incomplete` must be read dual-keyed.** The row type declares both spellings
  with the reason in place (`src/api/routes/public-do-qr.ts:88-94`) and
  `tests/delivery-incomplete-dual-key.test.mjs` fails any reader that drops the camelCase
  fallback. This is the camelCase read trap from `docs/BUG-CLASSES.md`, and this column is
  one of its recorded instances.
- **`organisations` GET is still unpermissioned — deliberately — but the ROW now narrows.**
  ✅ 2026-08-13 (BUG-2026-08-13-100). Gating the endpoint would empty the sidebar company
  switcher for ordinary staff, so the endpoint stays open and the projection does the work:
  registration number, TIN, address, phone, email, business type, transfer-pricing pct and
  `interCompanyConfig` go only to `organisations:read` or `purchase-orders:read`. It is now
  org-filtered too.
- **Active-org is global, not per-user.** `PUT /api/organisations` with `{ orgId }` writes
  `inter_company_config.active_org_id` on the singleton row
  (`src/api/routes/organisations.ts:577`). One user switching the org switcher changes it
  for everybody. ⬜ **Open, deliberately** — raised to the owner 2026-08-13 as a product
  decision, not touched by the security pass.
- **A lead's customer row is minted org-blind.** `createPotentialCustomerForLead`
  (`src/api/routes/sales-leads.ts:121-150`) does not list `orgId` in its INSERT, so the row
  takes the SQL default `'hookka'` from `migrations/0049_multi_tenant_skeleton.sql:32`
  regardless of who created it. Same shape as the write-side gap already recorded for
  consignments in `docs/BUG-CLASSES.md` C12 — see finding S3.
- **`send-quote` is bound to the customer's own addresses.** ✅ 2026-08-13
  (BUG-2026-08-13-102). `to` must match `customers.email` or one of that customer's
  `customer_contacts.email` rows, both looked up inside the caller's org; a customer with no
  address on file is a clear refusal, never a fall-through to whatever the caller sent.
  Before this it was an authenticated open mail relay — see finding S4.
- **Tests here pin source text, not behaviour.** `tests/sales-leads.test.mjs` asserting
  "tenant-scoped" means the string `org_id = ?` appears in the file — it did not notice that
  the `customers` INSERT three functions down has no org at all. When you add a scope, add
  the assertion for *that statement*, not for the file.

---

## Security findings (raised to the owner 2026-08-13, not silently filed)

Ranked by what an attacker actually gets. **S1–S3 are cross-tenant issues that are inert
today because prod is a single org (`'hookka'`)** — they are pre-existing traps for the
second tenant, not live leaks. S4 and S5 apply now.

**S1 — `organisations.ts` was entirely org-blind, read AND write. ✅ FIXED 2026-08-13
(BUG-2026-08-13-100).** `loadOrganisations` now binds `WHERE org_id = ?`; PATCH, DELETE and
PUT all resolve `id = ? AND org_id = ?` on the read, the UPDATE and the read-back; POST
stamps `getOrgId(c)` instead of the literal `'hookka'` and dedupes on `(org_id, code)`,
matching the unique index the router itself creates. The three write handlers call
`ensureOrganisationRegistry` first so the new predicate cannot 500 on an environment that
never ran 0142.

The GET is the interesting half. It is still ungated **on purpose** — the sidebar company
switcher calls it on every page load for every user, and the four companies are one owner's
group whose staff work across all of them, so a gate would break ordinary work to close a
lesser exposure. Instead the RECORD narrows: `organisations:read` **or**
`purchase-orders:read` gets the registry row, everyone else gets
`{ id, code, name, isActive, displayOrder }` + `restricted: true`. `purchase-orders:read` is
the second key because the PO / GRN / PI letterhead is resolved client-side from this
endpoint — and granting QA `organisations:read` instead would have unhidden the registry
ADMIN page in its menu, which `tests/role-policy.test.mjs` caught. The withheld keys are
OMITTED rather than blanked, so `hasLetterheadDetails` can fall back instead of printing
"Reg.  | TIN " (C16). Guarded by `tests/organisations-registry-projection.test.mjs`.

**S2 — the OCR few-shot pool is a shared, unpartitioned corpus.** `po_scan_samples` has no
org column (`migrations/0026_po_scan_samples.sql`), and `GET /api/scan-po/samples/by-po/:poIdentifier`
(`src/api/routes/scan-po.ts:847`) returns the full extracted PO JSON — customer, PO number,
line items, unit prices — to anyone with `purchase-orders:create` who can name the PO
string, with no org filter. `PATCH .../by-po/:poIdentifier` (`:904`) writes across orgs the
same way. Worse than a read: few-shot selection at `src/api/lib/scan-engine.ts:1090-1103`
draws the top 3 confirmed samples with **no org predicate**, so one tenant's confirmed
customer PO can be injected verbatim into another tenant's OCR prompt.

**S3 — `sales-leads.ts` mints customers into the wrong org.** `createPotentialCustomerForLead`
(`src/api/routes/sales-leads.ts:121`) omits `orgId`, which defaults to `'hookka'`
(`migrations/0049_multi_tenant_skeleton.sql:32`). A lead created by a second tenant produces
a customer account in tenant one. `POST /:id/convert`'s `customer_products` copy
(`src/api/routes/sales-leads.ts:332`) has the same omission.

**S4 — `POST /api/customer-crm/send-quote` was an authenticated open mail relay. ✅ FIXED
2026-08-13 (BUG-2026-08-13-102), owner authorised.** Recipient, subject, note and the entire
base64 attachment were all caller-supplied and nothing tied the recipient to the named
customer or the caller's org, so anyone with `customers:update` could send an arbitrary
≤5 MB PDF from the company's sending identity to any address — and log it on an unrelated
customer's timeline. `recipientsForCustomer` now builds the allowed set from
`customers.email` plus that customer's `customer_contacts.email` rows, both org-scoped, and
`to` must be in it (case-insensitively). No addresses on file is a 400 that names the fix,
never a fall-through. Both UI callers already prefill the prompt from `customer.email`, so
the ordinary send is unchanged; sending to a new person at that company means adding them
under Contacts first. Guarded by `tests/customer-crm-quote-recipient.test.mjs`.

**S5 — 2FA step 2 did not re-check the password. ✅ FIXED 2026-08-13
(BUG-2026-08-13-101), owner authorised.** `POST /api/auth/totp/login-verify` took
`{ userId, code }` and issued a full session without ever verifying that step 1 happened, so
for an enrolled user the password stopped being a factor: a user id plus one TOTP code or
one recovery code was the whole credential.

`/login` now mints a pending-2FA token when the PASSWORD verifies, and `/login-verify`
requires it (`src/api/lib/totp-pending.ts`). Five-minute TTL, single-use, stored SHA-256
hashed in its own `totp_pending_logins` table — deliberately not `user_sessions`, so a
pending row can never be resolved as a session by the middleware. The recorded decision at
`src/api/routes/auth.ts` is preserved rather than reversed: step 1 still hands back nothing
that grants access to the app. The check runs before the code is read (a token-less request
cannot burn a recovery code) and the row is burned only after a session exists (a typo does
not cost the operator their password step). A storage failure is a 503, never a bypass.

**Nobody is locked out by this.** `TOTP_LOGIN_ENFORCEMENT_ENABLED` is `false`
(`src/api/routes/auth.ts`, the 2026-08-04 kill switch), so `/login` never returns
`totpRequired` and no client can be mid-two-step when this deploys; `login.tsx` has no
step-2 screen to break. The change removes the currently-live password-free path and adds
nothing an ordinary login has to pass. Guarded by
`tests/totp-login-password-gate.test.mjs`.

**Still open after the 2026-08-13 pass: S2 and S3** — both inert on a single-tenant prod,
both untouched, because they live in other routers and were not in scope — plus the
singleton `active_org_id`, which is a product decision.

**Not a finding, checked and clear:** the public QR write path (org taken from the resolved
row, forward-only, server-rebuilt item set, shared cascade); `scan-queue.ts` (org-scoped
throughout, and the `/retry` id-only UPDATE is gated by an org-filtered SELECT above it);
`customer-crm.ts` (org-scoped on every statement); `auth-totp.ts`'s six session-required
handlers (subject always from the context, never the body); and the assistant's two-layer
tool gate.

---

Before schema/money/ship work read docs/HOOKKA-GOTCHAS.md; for review depth see docs/DEV-OPERATING-FRAMEWORK.md.
