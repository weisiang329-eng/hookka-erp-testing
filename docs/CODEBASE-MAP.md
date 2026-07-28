# Hookka ERP — Codebase Map (the single authoritative map)

**This is THE code map — read it before touching any module; there is no other.** Look up the
module here and go straight to the listed files and line ranges. `Grep`/`Glob` over the whole
repo **time out** (large tree + many worktrees), so use the file:line entries below with
`Read offset/limit` instead of searching. Formerly `docs/context-packs/NAVIGATION-MAP.md`.
Retired duplicates now pointing here: `docs/code-map.md`; the code-location role of
`docs/MODULES.md` (MODULES stays as the higher-level *product* reference).

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
| `src/pages/sales/index.tsx` — SO list (1705), dual-mode SO vs service-order | `src/api/routes/sales-orders.ts` — 5318 lines; SO CRUD + status cascades + snapshot | `sales_orders` / `sales_order_items` / `so_status_changes` | `tests/sofa-combo.test.mjs` |
| `src/pages/sales/create.tsx` — Create SO (3710); OCR/scan-PO lands here | `src/api/routes/consignment-orders.ts` — CO CRUD + co_status_changes (2415) | `consignment_orders` / `consignment_order_items` / `co_status_changes` | `tests/so-category.test.mjs` |
| `src/pages/sales/detail.tsx` — SO detail (1637); linked POs/JCs/DOs/invoices | `src/api/routes/consignment-notes.ts` — CN (DO-equiv) dispatch/delivered (1775) | `consignment_notes` / `consignment_items` | |
| `src/pages/sales/edit.tsx` — Edit SO (1550); re-runs sofa-combo on save | `src/api/routes/consignments.ts` — legacy/shared reads (536) | `sofa_combo_rules` / `customer_products` / `price_overrides` | |
| `src/pages/consignment/index.tsx` — CO list (1197) | `src/api/routes/sofa-combos.ts` — sofa_combo_rules CRUD (650) | `cost_ledger` / `production_orders` / `job_cards` / `fg_units` | |
| `src/pages/consignment/create.tsx` — Create CO (1782) | `src/api/routes/historical-sales.ts` — read-only history (128) | `delivery_orders` / `delivery_order_items` / `invoices` / `invoice_items` | |
| `src/pages/consignment/edit.tsx` — Edit CO (1099) | | `sales_orders_archive` / `sales_order_items_archive` / `sales_orders_list_snapshot` | |
| `src/pages/consignment/detail.tsx` — CO detail (1335); DO-parity P2 | | | |
| `src/pages/consignment/note.tsx` — CN workspace (5219); 3 tabs | | | |
| `src/pages/consignment/return.tsx` — Consignment Return (819) | | | |
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
- Sofa combo pricing is BACKEND-unified: sales-orders.ts imports `runSofaComboPass` (`src/api/lib/sofa-combo-pass.ts:114`), called at POST (~L2449) and PUT (~L3974); that wrapper calls `applySofaCombos` (`src/api/lib/sofa-combo.ts:121`). Do NOT grep `sales-orders.ts` for `applySofaCombos` — it's indirect now (moved 2026-06-11). Never re-implement combo pricing in the frontend. Piece code = productCode (stored sizeCode is the SEAT size); tier null disqualifies; discount<=0 is idempotent no-op. Old full-price combo SOs re-price down on next edit.
- `so_status_changes` / `co_status_changes` store an autoActions JSON blob and drive cascades to production_orders/job_cards/fg_units/DO/invoices — status transitions are not just label changes.
- sales-orders.ts uses item-catalog-snap on POST (OCR/scan-PO back-door risk; SO PUT + CO POST/PUT historically less covered). `sales_orders_list_snapshot` is cache-aside (filtered fetches bypass cache).
- CN is the consignment DO-equivalent. Owner rulings: CNs NEVER have invoices; 3PL stays DO-side. Amount on CN/CO list derives from CO value, not a stored field. Dispatch/delivered emails idempotent via folded-lowercase dispatchemailat/deliveredemailat.
- consignment/note.tsx renders all 3 tabs inline in one component from L505 — no separate tab components; packing_list block is the bulk (L3469-5219).
- camelCase DB columns in route SQL need a `column-rename-map.json` entry or they 400 'Invalid request body'; folded-lowercase cols read dual-keyed. Prefer snake_case for new columns.
- `sales_orders.caseid` links service-repair SOs onto a service_case; SVs price 0 by default (auto-pricing skipped) — don't reintroduce auto-pricing for service orders.
- Production locks: COMPLETED job_cards / non-PENDING fg_units / cost_ledger refs are inviolate — don't override for cosmetic edits.
- wipKey must use shared `deriveTopLevelWipKey` (one formula); component-level repair picks drop unowned material lines.
- Sofa seat-size dropdown options come from Maintenance `sofaSizes` config; a product with NO seatHeightPrices matrix KEEPS the picked seat with manual Base Price (RM0 allowed) — do NOT reintroduce the silent reset (BUG-2026-07-27-001, pinned by `tests/sofa-seat-no-tier.test.mjs`, same logic in all 4 line editors: sales+consignment create/edit). Products SKU-Master sofa price columns are DYNAMIC from the same Maintenance `sofaSizes` list (`buildBaseCols`/`sofaHeightsFromConfig` in `products/index.tsx`, numerically sorted, pinned by `tests/sofa-size-columns.test.mjs`) — adding a size in Maintenance creates its price column; don't hardcode height keys (h24…) anywhere.

**Start here:** Open `src/api/routes/sales-orders.ts` (the 5318-line backend owning SO CRUD, status cascades, snapshot logic) first; pair with `src/pages/sales/create.tsx` for UI or `src/api/lib/sofa-combo.ts` for any pricing work.

---

## Procurement (PO / GRN / Goods-in-Transit / Purchase Invoice / Suppliers / Supplier Pricing / Three-Way-Match / Credit & Debit Notes / Supplier Payments)

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/procurement/index.tsx` — PO list + POFormDialog (1870) | `src/api/routes/purchase-orders.ts` — PO CRUD + status lifecycle | `purchase_orders` / `purchase_order_items` | `tests/grn-arrival-state.test.mjs` |
| `src/pages/procurement/detail.tsx` — PO detail + ThreeWayMatchPanel (1497) | `src/api/routes/grn.ts` — GRN CRUD + arrival + Post-to-Stock cascade | `grns` / `grn_items` | `tests/ocr-distill-supplier.test.mjs` |
| `src/pages/procurement/create.tsx` — full-page PO create | `src/api/routes/goods-in-transit.ts` — GIT CRUD | `goods_in_transit` | `tests/supplier-payment-alloc.test.mjs` |
| `src/pages/procurement/grn.tsx` — GRN list (964) | `src/api/routes/purchase-invoices.ts` — PI CRUD + lifecycle | `purchase_invoices` / `purchase_invoice_items` | `tests/three-pl-state-rates.test.mjs` |
| `src/pages/procurement/grn/create.tsx` — GRN create (1174) | `src/api/routes/three-way-match.ts` — PO↔GRN↔PI variance | `suppliers` | |
| `src/pages/procurement/grn-detail.tsx` — GRN detail + Post-to-Stock (913) | `src/api/routes/suppliers.ts` — supplier CRUD | `supplier_materials` / `supplier_material_bindings` | |
| `src/pages/procurement/in-transit.tsx` — GIT list (869) | `src/api/routes/supplier-materials.ts` — bindings (autofill source) | `supplier_payments` | |
| `src/pages/procurement/pi.tsx` — PI list (498) | `src/api/routes/supplier-payments.ts` — payments + void + lifecycle | `price_histories` | |
| `src/pages/procurement/pi/create.tsx` — PI create (739) | `src/api/routes/price-history.ts` — effective-date pricing | `credit_notes` / `debit_notes` | |
| `src/pages/procurement/PurchaseInvoiceDetail.tsx` — PI detail (editable DRAFT+APPROVED) | `src/api/routes/credit-notes.ts` / `debit-notes.ts` | `raw_materials` | |
| `src/pages/procurement/pricing.tsx` — Supplier Pricing compare/history (769) | `src/api/routes/supplier-scorecards.ts` — read-only metrics | | |
| `src/pages/procurement/maintenance.tsx` — bindings mgmt (575) | `src/api/routes/scan-supplier.ts` — OCR extract (catalog-snap back-door) | | |
| `src/pages/procurement/sku-form-dialog.tsx` (410) / `supplier-form-dialog.tsx` (199) | | | |
| `src/pages/suppliers/detail.tsx` — supplier profile/scorecard/history (708) | | | |

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
- **POSTED GRN lines are EDITABLE with a compensating cascade (owner 2026-06-22)**: grn-detail.tsx "Edit Quantities" → PUT items[] on a POSTED GRN corrects per-line acceptedQty; the backend (`buildPostedGRNStockAdjustment`) posts the DELTA via the SAME helpers postGRNToStock uses (resolveRmForGRNItem / makeLedgerEntry / genBatchId) — raw_materials.balanceQty += delta, the GRN batch's original/remaining += delta (clamped ≥0), one cost_ledger entry (RM_RECEIPT IN on +, ADJUSTMENT OUT on −); `cascadePOReceivedQtyDelta` moves the parent PO line's receivedQty + recomputes PO status. invoiced_qty is NOT touched (PI-owned); status stays POSTED (no un-post). Edit BLOCKED when newAccepted < invoiced_qty (a PI already billed it) or when lines are added/removed. Edit-then-revert is a true no-op. The shared rule + message live in `src/lib/purchase-edit-rules.ts` (`checkGrnLineQtyEdit`/`describeGrnStockDelta`/`isGrnLineEditable`) so FE+BE reject identically. Tests: `tests/purchase-edit-rules.test.mjs` + `tests/purchase-edit-cascade.test.mjs`. The un-post / line-restructure lock is unchanged (still 409).
- **PI editable in DRAFT *and* APPROVED (owner 2026-06-22)**, NOT PAID/CANCELLED. PurchaseInvoiceDetail.tsx Edit gate = `isPiEditable` (src/lib/purchase-edit-rules.ts). Backend PUT relaxes the old DRAFT-only 409 via `isPiEditable`; an items edit recomputes amountSen, re-syncs grn_items.invoiced_qty (restore-old + re-increment, floored by clampDecrement, CEILINGED by `checkInvoicedQtyCeilingAfterEdit` so it never exceeds acceptedQty), and on an APPROVED edit posts a GL CORRECTION for the amount delta against a fresh sourceId `${id}:edit-${ts}` (the ledger hash chain is append-only — never mutate existing legs). FE preserves grnItemId on draft lines + Confirm dialog before saving an APPROVED edit (it moves AP). lifecycle DRAFT→PENDING_APPROVAL→APPROVED→PAID via VALID_TRANSITIONS; PAID terminal; DELETE gated to DRAFT (row kept for audit).
- No-Draft on MANUAL create (owner 2026-06-21): PO create POSTs `status:"CONFIRMED"` (POST takes body.status verbatim, defaults DRAFT only when omitted); PI manual create → `PENDING_APPROVAL`, OCR/scan (`?scan=1` or in-form Scan) → DRAFT via an `ocrUsed` flag. **GRN create derives status from ARRIVAL (grn.ts POST, no longer hardcoded DRAFT): OCR/scan (`body.ocrUsed`) → DRAFT (review); local goods in hand (effective arrival ARRIVED) → POSTED and posts to stock at create time via the SAME `postGRNToStock` + `cascadePOStatusAfterGRNPost` the PUT uses; import in transit (arrival ≠ ARRIVED, e.g. PO-linked default NOT_ARRIVED) → DRAFT document slot tracked by the arrival pipeline, posts later when arrival reaches ARRIVED. POSTED is NEVER born before ARRIVED — the arrival gate is structurally honoured. FE create.tsx sends `ocrUsed`; button = "Receive & Post to Stock" for born-POSTED, hint reflects the mapping.** Status is independent of the convert-chain guard.
- Supplier reference numbers (mig 0183 / SQLite 0105, all snake_case, self-applied in ensureGrnMigrations + ensurePiMigrations): `grns.supplier_do_no`; `purchase_invoices.supplier_do_no` + `supplier_invoice_no`. FE "Supplier DO No." on GRN create+detail (detail = inline edit via main PUT); "Supplier Invoice No."+"Supplier DO No." on PI create+detail (detail edit DRAFT-only). Read dual-keyed.
- PO detail returns 412 with `requiresGrn` when a transition needs a GRN first (detail.tsx handles res.status===412 && data.requiresGrn) — receiving must go through GRN, not a direct PO status flip.
- Supplier line autofill reads `supplier_material_bindings`; per-line supplier+price come from bindings, NOT a separate catalog. PI standalone intentionally excludes catalog autofill.
- Supplier pricing is EFFECTIVE-DATED (2026-06-21, mig 0183): `supplier_material_bindings.effective_from` = the date the current price takes effect (replaces the old Valid From/Valid To window; SKU dialog now shows a single "Effective From", defaulting to today). The binding stays one-row-per-supplier+material (autofill consumers unchanged); a unit-price change UPDATEs the row's price+effective_from AND APPENDS an audit row to `price_histories` (which now also carries `effective_from`) — the trail is append-only, never overwritten. POST seeds an opening history row (oldPrice 0 = "first price"). `effective_from` is already in `column-rename-map.json`; legacy rows fall back to `price_valid_from`. The suppliers/detail.tsx "Price History" tab Price Change Log reads `/api/price-history` (Effective Date / Material / Old / New / Change% with ▲▼ / Changed By / Status; old = the previous effective row's price). Supplier Quotation PDF (`generate-supplier-quotation-pdf.ts`) now reuses the shared `drawLetterhead`/`drawSectionLabel`/`tableTheme`/`drawDocFooter` (mirrors customer quotation) with an "Effective From" column instead of "Valid To". Tests: `tests/supplier-effective-pricing.test.mjs`.
- Money stored in sen integers (amountSen, unit_cost_sen); use MoneyInput / roundSen, never float RM.
- Migrations INERT unless self-applied at runtime via `ensurePendingMigrations` (ALTER ADD COLUMN IF NOT EXISTS) — a new procurement column reaches prod only that way.
- camelCase write columns (receivedDate, receivedQty) need a `column-rename-map.json` entry or the route silently 400s; prefer snake_case. db-pg toCamel recovers true snake_case but not folded-lowercase camelCase.
- ThreeWayMatchPanel (detail.tsx 1331+) joins PO↔GRN↔PI and is also a standalone route (three-way-match.ts); variance is derived, don't persist a second copy.
- OCR scan-supplier.ts is a catalog-snap back-door; SO/CO PUT paths historically unguarded — verify status-snap before trusting OCR-written prices.
- PENDING task to merge Supplier Pricing (pricing.tsx) into the Supplier module — don't duplicate the comparison surface (a duplicate modal was shipped+reverted before).
- Convert-chain availability (PO→GRN→PI, mig 0182): per-line CONSUMED tracking. PO line available = `quantity − receivedQty`; GRN line available = `accepted_qty − invoiced_qty` (both exposed as `availableQty` on item reads, dual-keyed). PI POST takes `body.grnId` + per-line `grnItemId`; a LINE-LEVEL 409 guard (`src/lib/convert-chain.ts` `checkConvertAvailability`) replaced the old PO-level double-bill 409 — a 2nd PI is allowed when qty remains, only the over-drawn line is rejected. Increment `grn_items.invoiced_qty` on PI create (same batch as the line insert); RESTORE on PI delete / PI items-replace / PI→CANCELLED, and on GRN un-post/cancel/delete (`restorePOReceivedQtyForGRN` decrements `purchase_order_items.receivedQty`, recomputes PO status). Stock posting (`postGRNToStock`) is NOT reversed by any restore — availability only. GRN DELETE is blocked while a non-CANCELLED PI references it (`purchase_invoices.grn_id`). Tests: `tests/convert-chain.test.mjs` + `tests/purchasing-convert-flow.test.mjs`.
- Convert UX (2026-06): GRN create = manual default + "Convert from PO" line-pick (`convert-from-po-modal.tsx`); PI create = "Convert from Goods Receipt" line-pick with GRN+PO tabs (`convert-to-pi-modal.tsx`). Pickers show per-line `availableQty`, checkbox + qty (≤ available), skip fully-consumed lines. PI GRN-source lines carry `grnItemId` → POST sends `body.grnId` + per-line `grnItemId`. Both pickers are SINGLE-source (one PO→one GRN; one GRN/PO→one PI) because the GRN backend keys lines to ONE parent PO by `poItemIndex` (grns.poId single column). Multi-source consolidation into one doc is a FOLLOW-UP (needs schema work). The GRN "From PO | Manual" mode toggle was removed; `?poId=` deep-link still locks PO mode.

**Start here:** Open `src/pages/procurement/index.tsx` (PO list + POFormDialog) or `src/pages/procurement/detail.tsx` (PO detail + ThreeWayMatchPanel); for receiving/stock start at `src/api/routes/grn.ts`.

---

## Delivery & Consignment

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/delivery/index.tsx` — DO workbench + 3PL mgmt (6879) | `src/api/routes/delivery-orders.ts` — DO end-to-end (6189) | `delivery_orders` / `delivery_order_items` | `tests/delivery-pipeline.test.mjs` |
| `src/pages/delivery/detail.tsx` — single DO detail | `src/api/routes/packing-lists.ts` — delivery-side truck runs | `packing_lists` | `tests/do-qr-public.test.mjs` |
| `src/pages/delivery/agent-tab.tsx` — Delivery Agent tab (brief strip + proposal approve/reject) | `src/api/routes/delivery-agent.ts` — brief.json / proposals / run / cron trigger; lib `src/api/lib/delivery-agent.ts` (runtime self-apply) | `delivery_proposals` / `delivery_briefs` (snake_case) | |
| `src/pages/consignment/note.tsx` — CN workbench, DO-parity (5219) | `src/api/routes/consignment-notes.ts` — CN lifecycle | `consignment_notes` / `cn_packing_lists` | `tests/do-scan-sort.test.mjs` |
| `src/pages/consignment/index.tsx` — CO list | `src/api/routes/cn-packing-lists.ts` — CN packing lists | `consignment_orders` | `tests/pl-first-autosplit.test.mjs` |
| `src/pages/consignment/create.tsx` — create CO (1782) | `src/api/routes/consignment-orders.ts` — CO CRUD (2415) | `drivers` | `tests/three-pl-state-rates.test.mjs` |
| `src/pages/consignment/edit.tsx` — edit CO | `src/api/routes/consignments.ts` — legacy/aggregate (536) | `three_pl_vehicles` / `three_pl_drivers` / `three_pl_state_rates` | `tests/cn-do-parity-gaps.test.mjs` |
| `src/pages/consignment/detail.tsx` — CO/Note detail | `src/api/routes/drivers.ts` — in-house drivers | `sales_orders` / `fg_units` / `stock_movements` | `tests/cn-packing-list.test.mjs` |
| `src/pages/consignment/return.tsx` — return flow | `src/api/routes/three-pl-drivers.ts` / `three-pl-vehicles.ts` / `three-pl-state-rates.ts` | | `tests/cn-packing-list-record.test.mjs`, `tests/cn-value.test.mjs` |

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
- Owner rulings: CNs NEVER have invoices; 3PL stays DO-side only. CN value = derived from the Consignment Order value, not stored.
- Status machine: DO DRAFT→LOADED→IN_TRANSIT→delivered via VALID_TRANSITIONS; the 'dispatched' tab deliberately includes IN_TRANSIT (row stays visible after loading). 'dispatched' is written as DB status LOADED. Don't bypass the transition guard.
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
| `src/pages/accounting/index.tsx` — mega-page, ~25 tabs (10627) | `src/api/routes/accounting.ts` — the accounting engine (11525) | `chart_of_accounts` / `account_aliases` | `tests/cashflow-engine.test.mjs` |
| `src/pages/accounting/cash-flow.tsx` — standalone cash-flow | `src/api/routes/invoices.ts` — sales invoices (~2310) | `journal_entries` / `journal_lines` / `ledger_journal_entries` | `tests/other-party-payment.test.mjs` |
| `src/pages/invoices/index.tsx` — sales invoice list | `src/api/routes/payments.ts` — customer receipts | `document_lifecycle` | `tests/supplier-payment-alloc.test.mjs` |
| `src/pages/invoices/detail.tsx` — invoice editor (per-line discount) | `src/api/routes/supplier-payments.ts` — pay PIs (money-critical) | `invoices` / `invoice_items` / `invoice_payments` / `payment_records` | |
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
  - GL Phase 2: GeneralLedgerTab — L6962-7466 as of 2026-07-24 (BackToTopButton at L6962; grand-totals strip also at TOP of grouped view; neighbouring entries' line numbers predate the file's growth — anchor by function name)
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
  - Multi-company (Phase 2): `CompanySelect` + `GroupByCompanyCard` (index.tsx) and `useCompanyOptions`/`orgIdParam` (accounting/shared.ts). "" = All companies (group) → report URL unchanged (consolidated); a company appends `&orgId=<code>` (org CODE lower-cased, e.g. `hookka`/`ohana`, NOT org row id). Wired into Balance Sheet (`/pl`), Trial Balance (`/trial-balance`), Debtor/Creditor Aging (`/aging` + `/ar-control`/`/ap-control`). The rich P&L tab (`/pl-statement`) does NOT accept orgId — scoping it needs a backend change (companyFilter threaded through computePnlWindow/FIFO), deliberately out of scope.

**Gotchas**
- `document_lifecycle` JOIN is load-bearing: list endpoints (PV, journals, etc.) must return lifecycleState or the FE shows wrong actions — voided docs showed void/delete instead of unvoid/delete (commit 8221d726, F3 hotfix). When adding a list query, JOIN document_lifecycle and surface lifecycleState.
- Money stored as integer sen (amountSen / discount_sen). Never floats; rounding through shared roundSen / distributeRoundSen in `src/lib/utils.ts`.
- invoices uses camelCase DB columns; new write columns should be snake_case (e.g. discount_sen mig 0179) and need a `column-rename-map.json` entry or they 400 'Invalid request body'. CI-guarded by `tests/sql-write-column-coverage.test.mjs`.
- Migrations INERT unless runtime-wired: new column reaches prod only via `ensurePendingMigrations` self-apply inside the route before the INSERT — see invoices.ts:980 ALTER for discount_sen.
- cost_ledger is append-only: cost-ledger.ts and stock-value reads are derived; actual cost rows written side-effectually by GRN/production_orders/delivery_orders. Don't write cost_ledger from accounting routes.
- P&L RM/WIP/FG come from the FIFO engine, NOT cost_ledger perpetual totals (ledger stopped being fed after 2026-03). `loadMaterialCost(db, orgId, startIso, endIso)` (accounting.ts, just before `computePnlWindow`) replays GRN receipts + cost_ledger RM_ISSUE/ADJUSTMENT through `src/lib/material-cost-fifo.ts`; `computePnlWindow` now takes `orgId` and reads `mat.rmGroups/wipOpenSen/wipCloseSen/fgOpenSen/fgCloseSen` instead of stockSummaryRange. WIP/FG are reconstructed as-of-date (in-progress = start_date<=D & (completed_date null or >D); FG undelivered = original_qty − fg_units delivered_at<=D). Receipt cost = APPROVED-PI weighted avg per (PO, material_code) else grn_items.unit_price. stockSummaryRange still feeds the closing-stock journal legs (buildClosingStockLegs) — leave it.
- Invoice mutations cascade: create-from-DO / void touches sales_orders, so_status_changes, delivery_orders, and customers running balance. Edit the cascade, not just the invoice row.
- `ledger_journal_entries` (posted GL) is distinct from `journal_entries`/`journal_lines` (journal module). P&L/balance sheet/trial balance/GL tabs read ledger_journal_entries + chart_of_accounts — don't confuse the two.
- A PI posts to GL whenever it REACHES status APPROVED — on the PUT transition AND on create-as-APPROVED (POST). Both call the shared `src/lib/pi-posting.ts buildPiApprovalLegs()` (DR mapped buckets · CR 400-0000), idempotent via `ledgerHasSource(...,"purchase_invoice",id)` (BUG-2026-06-23-007). Don't re-add posting to only one path. Opening PIs use `/opening-balance/ap` (isOpening) and post NO PI legs. ⚠️ Sales invoices (DRAFT→SENT) still post only on the PUT transition — the symmetric create-as-SENT gap is NOT yet fixed.
- Periodic-inventory mode (2026-07-03, owner rule 「不要用 BOM 算先」): kv `rm_valuation_mode` = `stock_take_only` → RM value at every month-end = latest stock-take count + PI purchases since it (`stockTakeChainValue` in `src/lib/material-cost-fifo.ts`; opening seed = `material_opening_stock` before any count). BOM/FIFO consumption is bypassed; consumption surfaces only in counted months, plus the correct immediate consumption of FEE/SERVICE/unmapped PI lines (GL posts every non-TAX line to a purchase account; only STOCKED+group-resolvable lines enter the stock chain — the gap is real cost, not noise). `auto` = original FIFO/BOM + stock-take override. Toggle on the Stock Take tab; `PUT /rm-valuation-mode`; GET /stock-take returns `rmValuationMode`. Flows into P&L, stock summary AND closing-stock GL posting (same engine) — re-Post any posted month after flipping. WIP/FG unaffected.
- Opening-month P&L slice (2026-07-03, report-layer, ZERO ledger rows): opening_balance legs are no longer dropped from the P&L — `glWindowSigned` nets them per account (reversals cancel, so re-posting the opening self-maintains) and, when the window covers the opening month, injects `opening − kv pnl_opening_prior_cum` (prior-month-end TB, {code: signedSen}, DR+/CR−) for REVENUE/COST/EXPENSE accounts; `/cost-expense-classes` has the same injection in its own loop. Pure rules: `src/lib/opening-slice.ts` (`applyOpeningSlice`, `windowCoversMonth`). `PUT /opening-balance/pnl-prior-cum` stores the setting; GET /opening-balance returns `pnlPriorCum`. Months before the opening month still come from `pnl_historical`; TB/BS paths untouched. Same day: P&L raw-material PURCHASE lines read the LEDGER per purchase account (`rmGroups` keyed by account code via DEFAULT_PURCHASE_MAP + kv coa_stock_map; opening/closing stock stays engine-valued and is mapped onto the same account rows).
- Mid-year opening (2026-07-02): `/opening-balance/post` accepts P&L accounts (opening 22/05 sits mid-FY; SDC/SCC controls stay blocked). Pre-opening PIs count as opening BY DEFAULT — rows never edited; exceptions live in runtime-self-applied `opening_ap_excludes` (pure rule `apRowBeforeOpening` in `src/lib/opening-floor.ts`; wired into /aging AP, /ap-control, supplier statement, /creditor-ledger and `openingControlSums`). GET /opening-balance returns `preExistingAp`; POST `/opening-balance/ap-exclude` toggles exclusion (bumps kv_config so the aging snapshot rebuilds). Opening Balance tab: all-postable-accounts grid + "Already-entered supplier invoices" exclude/include card.
- Supplier Discount (purchase CN) = `accounting.ts` `/purchase-credit-notes` POST(DRAFT)+PUT(POSTED, optional `allocations[]`)+`/:id/void`; UI `SupplierDiscountTab` (tab `supplier-discount`). The CN's GL is DR400/CR-purchase (the ONLY GL move). Knocking it off a PI does NOT add a GL leg — it bumps the PI's `paid_amount_sen` + writes a `supplier_payments` `method='CREDIT_NOTE'` marker (`amountSen=0`, `bookedSen=applied`, `paymentNo=<CN no>`). Markers are EXCLUDED from the supplier-payment history list; `/ap-control` nets only the UNALLOCATED CN remainder (`Σ posted CN − Σ marker bookedSen`) over net PI outstanding so drift stays 0. Void deletes markers + restores paid_amount. Allocation math: pure `src/lib/discount-alloc.ts` (#6).
- Other-Party Bills edit-in-place (2026-07-09): `PUT /other-party-bills/:billNo` — restate pattern (reverse visible GL `other_party_bill_restate_rev:<stamp>` + post `_restate_post:<stamp>` + collapse), same number, party FIXED, new total ≥ paidAmountSen (pure `editedBillStatus`). ⚠️ void/delete/unvoid MUST pass the whole leg family via `otherPartyBillLegFamily` (applyLifecycle exact-matches sourceTypes; plain `['other_party_bill']` would leave an edited bill's restate legs visible after void). Previously-voided-then-restored bills refuse edit (void trail pinned to old figures — Copy instead).
- AR drift diagnosis (2026-07-09): `GET /ar-reconciliation` — same pure decomposition via ReconCfg (300-0000 legs fed debit/credit-SWAPPED; invoices=doc family, payment_records allocations=pay family; no advances — /ar-control subtracts none). Known standing item: debtor opening NOT yet entered → −40,000 drift (2 receipts paying 23 un-flagged pre-opening invoices) is EXPECTED until the owner runs the debtor-opening project (v5 list + flag-as-opening switch to build).
- AP drift diagnosis (2026-07-08): `GET /ap-reconciliation` (accounting.ts, right after /ap-control) — read-only, itemizes `driftControlVsPiSen` into per-document items (opening coverage, per-PI GL vs face, per-payment GL vs claim incl. void leaks, voided-advance rows, paid_amount drift, overpaid clamps, CN block, stray sources on 400-0000) whose contributions sum EXACTLY to the drift (pure `src/lib/ap-recon.ts`, tests/ap-recon.test.mjs asserts the identity). Use it BEFORE hand-reconciling any control-vs-subledger gap.
- Two huge files (index.tsx ~10627, accounting.ts ~11525) — index.tsx has `// =============== TAB:` banners; accounting.ts uses `// ----` section headers (NOT TAB banners), so anchor on `app.get/post` handler + `function` lines. Never read either end-to-end. ⚠️ The `index.tsx` section-index line numbers below drift 2-3k lines — grep the named symbol/tab near the listed line.
- `e-invoices.invoiceId` is intentionally NOT FK-enforced — legacy/standalone e-invoices reference invoices that may not exist; don't add a hard FK.
- Service-order invoices price RM 0 by owner ruling; locked SOs (production COMPLETED + DO delivered) refuse header changes — don't override production locks for cosmetic invoice fixes.

**Start here:** Open `src/pages/accounting/index.tsx` (one mega-page hosting ~25 tabs) and jump via the section banners; for customer-billing tasks start at `src/api/routes/invoices.ts`.

---

## Production & BOM

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/production/index.tsx` — dept-tabbed WIP board (8888) | `src/api/routes/production-orders.ts` — PO/job-card/WIP backend (7.6k) | `production_orders` / `production_orders_archive` / `production_orders_list_snapshot` | `tests/bom-explosion.test.mjs` |
| `src/pages/production/folders.tsx` — folder list | `src/api/routes/production-folders.ts` — group/ungroup | `job_cards` / `job_cards_archive` / `job_card_events` | `tests/job-card-id.test.mjs` |
| `src/pages/production/folder-detail.tsx` — folder detail | `src/api/routes/job-cards.ts` — reads + event timeline | `folder_job_cards` / `production_folders` | `tests/production-fresh-po-direct-db.test.mjs` |
| `src/pages/production/tracker.tsx` — progress tracking | `src/api/routes/bom.ts` — bom_templates + bom_versions | `wip_items` / `wip_cascade_log` / `piece_pics` | `tests/production-order-builder.test.mjs` |
| `src/pages/production/wip-times.tsx` — per-dept minute rates | `src/api/routes/bom-master-templates.ts` — master variants | `bom_templates` / `bom_versions` / `bom_master_templates` | `tests/production-orders-dept-narrow-guard.test.mjs` |
| `src/pages/production/scan.tsx` — shop-floor dept scan | `src/api/routes/cnc-templates.ts` — Model→Size/Seat derive | `cnc_templates` | `tests/production-overdue-counts.test.mjs` |
| `src/pages/production/fg-scan.tsx` — FG scan | `src/api/routes/inventory-wip.ts` — in-flight WIP per dept/PO | `production_lead_times_history` / `hookka_dd_buffer_history` | `tests/production-wip-producer-output.test.mjs` |
| | `src/api/lib/packing-rack-write.ts` — `applyPackingRack(db, jc, rack, pieceNo?)` (rack set/clear + occupancy mirror; shared by office PATCH / /p/ / worker; per-PIECE rack via `piece_pics.racking_number` when pieceNo+totalPieces>1, else card-level legacy) | `rack_items` / `rack_locations` / `piece_pics.racking_number` (mig 0192) | `tests/packing-piece-identity.test.mjs` / `tests/sticker-rack-public.test.mjs` |
| | `src/api/lib/packing-piece-identity.ts` — `packingPieceIdentity` (shared piece warehouse identity; appends `· pc N of M` to notes when pieceNo set + multi-piece) | | |
| `src/pages/production/dept.tsx` / `overview.tsx` — thin wrappers | `src/api/routes/wip-times.ts` — minute counts | `kv_config` | `tests/sofa-combo.test.mjs` |
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
  - CollapsibleGroup / SubWIPTree — L2314-2598
  - EditBOMDialog (L1 tab + WIP tab editor) — L2599-3407
  - MasterTemplatesDialog (Bedframe/Sofa/Accessory tabs + copy-from) — L3408-4368
  - ProductionTimesDialog (per-dept minute rates) — L4369-4945
  - BatchEditMaterialsDialog — L4946-6165
  - DeptPivotCategoryDialog — L6166-6725
  - BOMManagementPage (default export — page shell, tabs, list) — L6726-7211

**Gotchas**
- index.tsx is 8888 lines, driven entirely by activeTab (dept code: ALL, UPHOLSTERY, PACKING, FOAM, FAB_CUT, FAB_SEW). Almost every column set, row derivation, render block branches on activeTab — never assume one code path. Use the section ranges; don't read end-to-end.
- WIP idempotency: `applyWipInventoryChange` in production-orders.ts claims work via wip_cascade_log INSERT-ON-CONFLICT, but ONLY when options.orgId is passed — callers without orgId still unguarded (FOAM-326 class). Don't rebuild the table; audit caller coverage.
- wipKey is derived by a SINGLE shared helper `deriveTopLevelWipKey` (FAB_SEW splits on '::'[2], etc.). Never re-implement; stale picks throw at confirm.
- Repair scope: `production_orders.repairscope` stamps partial repairs (FULL=null=byte-identical). Component-scope picks DROP unowned material lines — not cosmetic.
- COMPLETED job_cards / non-PENDING fg_units are inviolate (production locks). Suggest a UI fix instead.
- camelCase DB columns: most at-risk WIP/production cols are dual-keyed (r.camelCase ?? r.snake_case); db-pg toCamel can't recover folded-lowercase camelCase. New columns snake_case; a camelCase write column needs a `column-rename-map.json` entry.
- BOM production-time / minute rates written into `bom_templates.wipComponents` from BOTH bom.tsx (ProductionTimesDialog) and wip-times.tsx/route — keep consistent; feed productionCostRatePerMinuteSen in the PO cost cascade.
- Sofa combo pricing is BACKEND-unified (`applySofaCombos`) wired into sales-orders POST/PUT — production reads the priced SO; don't re-price in the production layer.
- CNC hierarchy (Model→Size/Seat→Files) is DERIVED on the frontend; cnc_templates has no category column (from products.category) and total_height doubles as sofa seat size. No migration for the hierarchy.
- `production_orders_list_snapshot` is a denormalized snapshot for fast list reads — writes to production_orders must keep it in sync.
- Dept-narrow guard: dept-tab views must not leak cross-dept rows (production-orders-dept-narrow-guard.test.mjs). Overdue counts have ship-exclusion logic the FE grid isOverduePO may lack (known latent gap).
- Overdue chips (filter bar) FILTER THE MAIN GRID (owner 2026-06-23): clicking "Bedframe ⚠ N" / "Sofa ⚠ N" narrows the grid below to that category's overdue set instead of popping a separate SO-list panel (panel removed). The grid filter reuses the SAME server overdue set the chip count comes from — `/api/production-orders/overdue-counts` now returns `overdueBedframePoIds` / `overdueSofaPoIds`; FE builds `overduePoIdSet` (state `overduePanelMode`, kept) and drops rows not in it inside `filteredOrders`, also skipping the date-window while active. Clicking again clears; Clear-all clears it (setOverduePanelMode(null)). Tests: production-overdue-counts.test.mjs (§6). Don't reintroduce the drill-down panel.
- Packing-rack assign → warehouse occupancy (BUG-2026-06-25-007): the office Packing-sheet rack dropdown (PATCH /:id {jobCardId,rackingNumber}), the public /p/ piece-sticker scan, and the worker scan ALL funnel through `applyPackingRack` (`src/api/lib/packing-rack-write.ts`). It used to write ONLY the text rackingNumber (job_cards + production_orders); it now ALSO mirrors ONE `rack_items` row per piece (SET inserts / re-assign MOVES the old row / "" CLEARS, then recomputes `rack_locations.status` via the SAME CASE as DO-dispatch stock-out) so the Warehouse grid shows the piece. The PATCH calls `applyPackingRack` AFTER its inline UPDATE (idempotent text re-affirm + occupancy; best-effort, hot-card only). Piece identity comes from the shared `packingPieceIdentity` (`src/api/lib/packing-piece-identity.ts`) — same formula the /r/ rack-QR scan uses — so office / /p/ / /r/ converge on ONE row (no duplicates; a move finds the old row by productName+notes). Don't re-inline the description/notes formula.
- FG-sticker speed (BUG-2026-06-25-008a): `loadFgStickers` (index.tsx ~L5375) paints the preview IMMEDIATELY with the `/worker/scan` fallback URL, then upgrades QRs to /p/<token> in the background (Print still awaits the enriched set, so the PRINTED QR deep-links /p/<token>). The mint endpoint POST `/packing-rack-tokens` (production-orders.ts ~L6001) replaced its serial per-(poNo,pieceName) loop (~6 DB calls each) with 2 batched queries + a parallel mint — byte-identical output (same pickPackingCard narrowing, null-token guard). Mint is read-auth-gated; the public route only RESOLVES tokens, never mints.

**Start here:** Open `src/pages/production/index.tsx` (jump to the activeTab section ranges) for UI and `src/api/routes/production-orders.ts` for the PO/job-card/WIP backend; for BOM tasks start in `src/pages/bom.tsx` + `src/api/routes/bom.ts`.

---

## Inventory

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/inventory/index.tsx` — 3-tab FG/WIP/RM grids (3446) | `src/api/routes/inventory.ts` — aggregate read + drill-downs (583) | `raw_materials` / `rm_batches` | `tests/production-wip-producer-output.test.mjs` |
| `src/pages/inventory/adjustments.tsx` — stock adjustments (769) | `src/api/routes/inventory-wip.ts` — WIP derived view (665) | `fg_units` / `fg_batches` | `tests/cascade-fc-aggregator.test.mjs` |
| `src/pages/inventory/fabrics.tsx` — fabric tracking (707) | `src/api/routes/raw-materials.ts` — RM CRUD + dup-code toggle (685) | `fabric_trackings` / `fabrics` | `tests/hub-cascade-completeness.test.mjs` |
| `src/pages/inventory/stock-value.tsx` — valuation snapshots (1037) | `src/api/routes/rm-batches.ts` — read-only (95) | `stock_adjustments` / `stock_movements` | |
| | `src/api/routes/fg-units.ts` — FG lifecycle + backfills (906) | `stock_accounts` / `monthly_stock_values` | |
| | `src/api/routes/fabrics.ts` — DEPRECATED (writes 410) (68) | `rack_locations` / `rack_items` | |
| | `src/api/routes/fabric-tracking.ts` — active fabric CRUD (443) | `wip_items` / `cost_ledger` | |
| | `src/api/routes/_fabric-cascade.ts` — internal helper, not mounted (216) | `production_orders` / `job_cards` / `grns` / `delivery_hubs` | |
| | `src/api/routes/warehouse.ts` — racks + movements (684) | | |
| | `src/api/routes/stock-adjustments.ts` — adjustment create/list (567) | | |
| | `src/api/routes/stock-value.ts` (287) / `stock-accounts.ts` (42) | | |

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
- `rack_items` (warehouse occupancy) now has TWO writers, not just the /r/ rack-QR stock-in: assigning a PACKING rack via `applyPackingRack` (`src/api/lib/packing-rack-write.ts`) also mirrors one `rack_items` row per piece + recomputes `rack_locations.status` (BUG-2026-06-25-007, see Production module). Both writers share `packingPieceIdentity` (`src/api/lib/packing-piece-identity.ts`) for the row's productName(description)+notes(SO) so they converge on ONE row — don't introduce a third identity formula.

**Start here:** Open `src/pages/inventory/index.tsx` (the 3-tab UI, jump to the relevant tab section), then its backing route `src/api/routes/inventory.ts` or the specific domain route (raw-materials/fg-units/fabric-tracking/stock-adjustments).

---

## Products & MDM

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/products/index.tsx` — 3-way view (SKU Master/Catalog/Maintenance) (4545) | `src/api/routes/products.ts` — core CRUD, nested bomComponents (1088) | `products` / `bom_components` / `dept_working_times` | `tests/bom-explosion.test.mjs` |
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

**Start here:** Open `src/pages/products/index.tsx` and jump to the viewMode toggle at L~3024 / state at L1756 to find the right view; for API work start in `src/api/routes/products.ts`.

---

## Employees & Payroll

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/employees.tsx` — 9-tab admin shell (10,951) | `src/api/routes/workers.ts` — employee master + salary effective-dating (1047) | `workers` / `worker_salary_history` | `tests/labor-engine.test.mjs` |
| `src/pages/worker/index.tsx` — worker mobile home | `src/api/routes/worker.ts` — self-service mobile backend (2878) | `departments` / `attendance_records` | `tests/attendance-rules.test.mjs` |
| `src/pages/worker/scan.tsx` — clock/dept-scan/packing (2816) | `src/api/routes/worker-auth.ts` — PIN auth | `working_hour_entries` | `tests/auto-attendance-deduct.test.mjs` |
| `src/pages/worker/pay.tsx` — payslip view | `src/api/routes/attendance.ts` — admin attendance (374) | `payroll_runs` / `payroll_*` (generated) / `payroll_payslips` | `tests/worker-auth.test.mjs` |
| `src/pages/worker/me.tsx` — profile | `src/api/routes/departments.ts` — dept CRUD (339) | `payroll_hour_deductions` | `tests/worker-auth-default-protect.test.mjs` |
| `src/pages/worker/team.tsx` — team view | `src/api/routes/working-hour-entries.ts` — efficiency source (1082) | `leaves` / `worker_issues` | `tests/jc-minutes-total.test.mjs` |
| `src/pages/worker/issue.tsx` — issue submission | `src/api/routes/payroll.ts` — run generation (308) | `public_holidays` (via kv_config['public_holidays']) | |
| `src/pages/worker/login.tsx` — PIN login | `src/api/routes/payroll-hour-deductions.ts` — short-hour dock (195) | | |
| | `src/api/routes/department-performance.ts` — read-only aggregate (571) | | |
| | `src/api/routes/leaves.ts` — leave CRUD | | |
| | `src/api/routes/payslips.ts` — payslip read/persist (OT buckets) | | |
| `src/pages/announcements.tsx` — office compose + per-card **read-receipt panel** (`ReadReceiptPanel`: lazy GET `/:id/acks`, acked/pending lists, **Remind** → POST `/:id/remind`) | `src/api/routes/announcements.ts` — admin + worker sub-apps; auto-translate on POST/PATCH via `src/api/lib/translate-announcement.ts` (Claude, ANTHROPIC_API_KEY). **Read-receipts:** worker POST `/:id/ack` (idempotent upsert), worker GET returns `ackedIds` (SERVER-driven popup gate), admin GET `/:id/acks` (acked-vs-ACTIVE-roster split), admin POST `/:id/remind` (stamps `reminded_at` → re-pop) | `announcements` (snake_case; `translations` JSONB + `reminded_at`, runtime ALTER) · `announcement_acks` (PK `announcement_id,worker_id`; runtime CREATE TABLE) | `tests/announcement-translate.test.mjs` · `tests/announcement-acks.test.mjs` |

**Big-file section index**
- `src/pages/employees.tsx`
  - WorkerDayDrillIn (per-day drill modal) — L326-528
  - SortableHeader helper (Working Hours grid) — L540-617
  - TAB 1: Working Hours — flat grid (WorkingHoursTab) — L618-1637
  - Public Holidays panel (PublicHolidaysCard) — L1638-1774
  - DepartmentMultiSelect helper — L1897-1983
  - TAB 2: Employee Master (EmployeeMasterTab) — L1984-3613
  - TAB 3: Efficiency Overview (EfficiencyOverviewTab) — L3624-4153
  - TAB: Department Labor (DepartmentLaborTab) — L4186-5101
  - TAB 4: Employee Detail (EmployeeDetailTab, guarded-unmount) — L5127-5700
  - TAB 4b: Department Performance (DepartmentPerformanceTab) — L5761-6044
  - DailyDrillDown helper — L6045-6189
  - RuleDraftExplainer helper (payroll) — L6196-6265
  - TAB 5: Payroll (PayrollTab) — L6266-7462
  - DepartmentsManager (inside Labor Cost section) — L7558-7804
  - TAB 5b: Labor Cost (LaborCostTab) — L7805-10003
  - TAB 6: Leave Management (LeaveManagementTab) — L10010-10375
  - AttLocBadge / PunchThumb helpers — L10461-10515
  - TAB: Attendance (AttendanceTab) — L10516-10641
  - MAIN PAGE — EmployeesPage shell + tab switch — L10642-10951
- `src/pages/worker/scan.tsx`
  - WorkerScanPage — single mobile clock/dept-scan/packing component (Kpi helper at 2791) — L29-2816

**Gotchas**
- The payroll/cost math is the single most coupled and fragile part. THE engine is `src/lib/labor-engine.ts`; costing divisor logic is `src/lib/costing.ts`. Pay side = unified ÷26 (workingDaysPerMonth) for absence, late/short docks, OT base; hourly = ÷26 ÷ the worker's DAY SPAN (daily hours + lunch, e.g. 9h→÷10). Cost side = ÷ ACTUAL Mon-Sat working days minus holidays (countElapsedWorkingDays / costingDailyRateSen). NEVER revert either to fixed-26 or ÷calendar.
- Day-typed OT: OT splits into weekday(1.5×)/Sunday(2×)/holiday(3×) buckets via dayTypedOt; payslips persist these, premium routes to the dept line not Overhead. Holidays from kv_config['public_holidays']. Weekday-only must stay byte-identical.
- Money rounding shared and load-bearing: roundSen + distributeRoundSen (largest-remainder) in `src/lib/utils.ts`. DeptLabor ties per-dept costs to the integer payroll total via distributeRoundSen (leftover sen → largest-fraction dept). All 3 screens (Payroll / Dept Labor / Labor Cost) reconcile to the sen. Don't add per-screen ad-hoc plugs.
- Salary is effective-dated (worker_salary_history, mig 0153) — never read a single current salary; use GET /salary/effective for a date. join/resign does NO proration; unworked working days dock ÷26 as absences.
- payroll_hour_deductions (mig 0152) and other module tables are runtime self-applied via ensurePendingMigrations, NOT replayed from migration files on deploy — a migration file alone is INERT.
- camelCase DB columns are folded-lowercase by toCamel and can silently return undefined (clockinphoto↛clockInPhoto); at-risk cols dual-keyed r.camelCase ?? r.snake_case. New columns snake_case; a write to a camelCase col needs a `column-rename-map.json` entry.
- employees.tsx Employee Detail tab is intentionally guard-unmounted via {activeTab === 'detail' && ...} (~L10922) — don't refactor to always-mounted.
- UI must be 100% English — no Chinese strings/comments. EmployeesPage tab shell at L10642; add new tabs to both the tab array and the activeTab switch (~L10887).

**Start here:** Open `src/pages/employees.tsx` (the 10,951-line tabbed shell; tab switch at L10642 / activeTab block at L10887) and jump to the specific tab via the section ranges.

---

## Customers & Platform

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/customers.tsx` — customer hub, nested pricing/maintenance/combos (3846) | `src/api/routes/customers.ts` — customer CRUD (418) | `customers` / `customer_products` / `customer_product_prices` | `tests/customer-notify.test.mjs` |
| `src/pages/settings/Users.tsx` — Users/Org/Mailbox tabs, SUPER_ADMIN-gated (3263) | `src/api/routes/customer-products.ts` — per-customer pricing + bulk (1122) | `customer_hubs` / `delivery_hubs` | `tests/hub-cascade-completeness.test.mjs` |
| `src/pages/settings/index.tsx` — settings shell | `src/api/routes/customer-maintenance.ts` — snapshot mirror (185) | `maintenance_config_history` / `sofa_combo_rules` | `tests/service-hub-chain.test.mjs` |
| `src/pages/settings/organisations.tsx` — sister-company config | `src/api/routes/customer-hubs.ts` — per-customer hubs (75) | `product_prices` / `products` | `tests/sofa-combo.test.mjs` |
| `src/pages/maintenance.tsx` — master variant config editor | `src/api/routes/customer-quotation.ts` — quotation pricing (259) | `users` / `user_invites` / `user_sessions` / `password_reset_tokens` | `tests/worker-auth.test.mjs` |
| `src/pages/maintenance/sofa-combos.tsx` — master combo grid | `src/api/routes/users.ts` — accounts, requireSuperAdmin gate (890) | `role_permissions` / `kv_config` | `tests/worker-auth-default-protect.test.mjs` |
| `src/pages/maintenance/SofaComboHistoryDialog.tsx` — combo history | `src/api/routes/auth.ts` — login/session/reset (1096) | `email_threads` / `email_messages` / `email_addresses` | |
| `src/pages/mail-center/index.tsx` — Mail Center shell (2274) | `src/api/routes/auth-oauth.ts` (239) / `auth-totp.ts` (549) | `email_attachments` / `email_labels` / `email_address_access` | |
| `src/pages/mail-center/detail.tsx` — thread detail | `src/api/routes/worker-auth.ts` — factory-worker auth (349) | `mail_user_scope` / `audit_events` | |
| `src/pages/mail-center/compose.tsx` — compose | `src/api/routes/mail-center.ts` — email engine (2109) | | |
| | `src/api/routes/files.ts` — generic upload/download (506) | | |
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
- Mail Center is GMAIL-STYLE with 3 localStorage view toggles (mail-prefs.ts, surfaced via the header "View" gear): density (compact single-line default ↔ comfortable old multi-line cards), reading-pane (split 3-pane default ↔ full-width list that opens /mail-center/:id), category-tabs (All/Primary/Notifications strip, default on). These ARE the owner's "可以开关" — we did NOT fork two full layouts. The category split is a CLIENT-SIDE heuristic (`classifyCategory` over counterpartyEmail: no-reply/system/alert/eservices/statement local-parts + known bank/payment domains → Notifications, else Primary) — NO backend columns, the threads API is unchanged (still GET /threads, 300-row cap). Both row densities share RowLead+RowActions so star/select/hover-actions can't drift. Don't re-add the old single-layout ThreadList; don't move the category heuristic server-side.

**Start here:** For a customer-facing task open `src/pages/customers.tsx`; for users/RBAC/org/mailbox-scope open `src/pages/settings/Users.tsx`; for internal email open `src/pages/mail-center/index.tsx`.

---

## Planning (Production Planning / Scheduling / MRP / Lead Times)

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/planning/index.tsx` — 5-tab PlanningPage (Capacity Overview / Capacity Loading / Lead Times / Master Tracker / Schedule Proposals) + DrilldownModal (4004) | `src/api/routes/planning-schedule.ts` — per-dept daily schedule data (GET /schedule/fabric-cutting, /schedule/:dept) + `computeChainWithAssignments` (Phase-2 engine assignments) | `production_orders` (read: active POs, due dates, progress) | `tests/planning-scheduler.test.mjs` |
| `src/pages/planning/mrp.tsx` — MRP view (reads/posts /api/mrp) | `src/api/routes/production-leadtimes.ts` — lead-time config + history (GET /, PUT /settings, PUT /, POST /recalc-all, GET /history, POST /schedule, DELETE /history/:id) | `job_cards` (read: per-PO dept sequence, wipKey, earliest pending due date) | `tests/scheduler.test.mjs` |
| `src/pages/planning/LeadTimeHistoryDialog.tsx` — lead-time history + scheduled changes | `src/api/routes/mrp.ts` — MRP runs (GET /, GET /runs, GET /runs/:id) | `production_lead_times` (legacy) / `production_lead_times_history` | `tests/scheduling.test.mjs` |
| `src/pages/planning/dept/_DepartmentSchedulePage.tsx` — shared generic dept-schedule renderer (calendar, by-day lanes, grouped cards) | `src/api/routes/scheduling.ts` — GET /, POST /, GET /capacity | `hookka_dd_buffer_history` (due-date buffer history) | |
| `src/pages/planning/dept/_PlainDeptSchedulePage.tsx` — plain-table dept variant | `src/api/routes/production-orders.ts` — 7606 lines; Planning READS only (Production-owned) | `mrp_runs` / `mrp_requirements` | |
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
  - NOTE: 7606-line route — Planning only READS it (production_orders/job_cards for capacity, tracker, lead-time recalc). Not a Planning-owned file; grep targeted handlers rather than reading whole. — L1-7606

**Gotchas**
- Backend planning logic lives in `src/api/lib` (NOT routes): planning-capacity.ts, planning-chain.ts, planning-scheduler.ts, lead-times.ts — change schedule/capacity math there, the routes are thin.
- Phase-2 proposals: the chain engine takes an OPTIONAL `collect` callback (ChainInput/SchedulerInput) that emits per-(card, day) assignments — all pre-Phase-2 call sites pass none, so schedules stay byte-identical. Only POST /api/planning/proposals/approve writes job_cards.dueDate; generation is read-only. `schedule_proposals`/`plan_snapshots` are runtime self-apply tables (ensureProposalTables), NOT migration files.
- planning-chain.ts + planning-scheduler.ts each contain ONE intentional NUL sentinel/separator string (written as the 6-char source escape backslash-u-0000) — never save it as a raw 0x00 byte (a raw NUL makes git/grep treat the file as binary).
- Lead-time recalc (production-leadtimes.ts POST /recalc-all) walks production_orders + every job_cards row and re-derives wipKey — coupled to the shared deriveTopLevelWipKey formula; don't re-implement wip keys here.
- All `dept/*` daily-schedule pages are config-only shells over the ONE shared renderer `_DepartmentSchedulePage.tsx`; layout/column changes belong in the shared file, not per-dept copies.
- index.tsx PlanningPage is one ~3270-line component with TAB-gated render blocks keyed off activeTab — section is selected by the activeTab string, not separate files; edit the matching tab block (line ranges above).
- production_lead_times is legacy; history/buffer tables are the live source. The inline /planning Save Lead Times form and LeadTimeHistoryDialog both hit /api/production/leadtimes — keep them consistent (dialog comment flags this).
- Capacity Loading chart uses working-day (Mon-Sat, Sundays excluded) windows of 14 past / 21 future days (constants at index.tsx:193-194), not calendar days — matches divisor conventions used elsewhere in the ERP.
- Many root-level *.xlsx + scripts/*.py (build_*_xlsx.py, dept_flow_scheduler.py) in the repo are throwaway export/planning-data tooling, NOT part of the app's Planning module — ignore them when editing the module.

**Start here:** For most Planning tasks open `src/pages/planning/index.tsx` (3709 lines, the 4-tab PlanningPage: Capacity Overview / Capacity Loading / Lead Times / Master Tracker); for per-department daily schedules the real renderer is `src/pages/planning/dept/_DepartmentSchedulePage.tsx` fed by `src/api/routes/planning-schedule.ts`.

---

## Dashboard & Command Center

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/dashboard-b/index.tsx` — the entire Command Center (2469); KPI rail + month switcher + all widgets | `src/api/routes/dashboard-overview.ts` — single GET / (2009), 60s KV-cached, owns ALL dashboard data | `sales_orders` / `sales_order_items` | `tests/snapshot-freshness.test.mjs` |
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
- The entire backend is ONE GET '/' handler ~2000 lines with no sub-routes — every dashboard number flows through it. It's 60s KV-cached, so edits won't reflect for up to a minute on live.
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
| `src/pages/service-cases/detail.tsx` — Service Case command center (3275) | `src/api/routes/service-orders.ts` — SV-order returns/repair lifecycle + mode/scope (1569) | `sales_orders` (caseid links SV→case; isServiceOrder mode flag) / `sales_order_items` | `tests/repair-scope.test.mjs` |
| `src/pages/service-orders/index.tsx` — SV-order list + CreateServiceOrderModal (1224) | `src/api/routes/sales-orders.ts` — co-owns the SO MODE (isServiceOrder) for the re-export pages | `production_orders` (repairscope) / `job_cards` / `fg_batches` | `tests/service-cases-rootcauses.test.mjs` |
| `src/pages/service-orders/detail.tsx` — SV-order detail (returns, repair scope) (933) | | `stock_adjustments` / `stock_movements` / `cost_ledger` | `tests/service-hub-chain.test.mjs` |
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
  - ActionLogPanel — service-agent action log over case lifetime — L2757-2905
  - SpawnServiceOrderModal — spawn an SV order under this case — L2906-3275

**Gotchas**
- TWO parallel directories with confusingly similar names: src/pages/service-order/* (SINGULAR) = thin re-exports of the Sales pages running in Service-Order mode via useSOMode() (src/lib/so-mode.ts); src/pages/service-orders/* (PLURAL) = a real, separate repair/returns module with its own list+detail. Don't confuse them.
- The /service-order (singular) pages have NO own data model — they hit /api/sales-orders with isServiceOrder:true. Editing service-order behavior often means editing src/pages/sales/* (NOT a fork) or src/api/routes/sales-orders.ts. Memory: 'never fork the 1400-line sales list'.
- sales_orders.caseid (mig 0165) links SV orders onto a case; Replacement Parts on a case = stock_adjustments with reason SERVICE_REPLACEMENT + stock_adjustments.caseid (mig 0164) — NO production order created. Don't route replacement parts through production.
- Repair scope lives on production_orders.repairscope (FULL=null=byte-identical legacy path); component-level picks stored on affectedProducts[].components and resolved via shared deriveTopLevelWipKey — ONE wipKey formula, never re-implement. Stale picks throw at confirm.
- Owner ruling: Service orders price RM 0 by default (auto-pricing fully skipped, BUG-016) — don't reintroduce auto-pricing on SV orders. Locked SO headers (production COMPLETED + DO delivered) cannot be zeroed.
- service_order_returns scrap path (POST /:id/returns/:rid/scrap) writes stock_movements/cost_ledger — integrity-sensitive, mind idempotency.
- UI must stay 100% English; window.confirm replaced by useConfirm; manual-save surfaces here use verifiedSave + unsaved-nav guard (RootCausePanel is the reference impl).

**Start here:** For a typical Service Case task open `src/pages/service-cases/detail.tsx` (the 3275-line command center) paired with `src/api/routes/service-cases.ts`; for repair/return ORDER behavior open the PLURAL `src/pages/service-orders/detail.tsx` + `src/api/routes/service-orders.ts` — and remember the SINGULAR `src/pages/service-order/*` is just a re-export of the Sales pages in SV mode (edit sales-orders.ts / src/pages/sales/* instead).

---

## Reports & Analytics

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/reports.tsx` — tabbed hub (Sales/Production/Inventory/Financial/Employee) (1396) | `src/api/routes/reports.ts` — /api/reports/* efficiency/schedule/overdue (GET+JSON+send) + compliance.json (545) | `sales_orders` / `sales_order_items` / `invoices` | `tests/efficiency-allowance.test.mjs` |
| `src/pages/daily-report.tsx` — newspaper-style compliance exceptions (1815) | `src/api/routes/dashboard-overview.ts` — single GET / consolidated dashboard payload (2009) | `purchase_orders` / `purchase_order_items` / `purchase_invoices` / `grns` | |
| `src/pages/analytics/forecast.tsx` — demand forecast vs historical sales | `src/api/routes/forecasts.ts` — demand-forecast data (131) | `production_orders` / `job_cards` / `delivery_orders` / `delivery_order_items` | |
| `src/pages/dashboard-b/index.tsx` — experimental Dashboard B / reporting view | | `products` / `workers` / `attendance_records` / `working_hour_entries` / `piece_pics` | |
| `src/pages/dashboard-b/charts.tsx` — lazy recharts/d3 chart chunk | | `departments` / `bom_templates` / `rd_projects` / `cost_ledger` / `per_po` / `kv_config` / `users` | |

**Big-file section index**
- `src/pages/reports.tsx`
  - Types mirroring API response shapes — L19-111
  - Date helpers — L112-147
  - CSV helper — L148-173
  - Shared Components (Spinner / DateRangeSelector / SummaryCard / ReportTable) — L174-295
  - Tab definitions — L296-319
  - SalesReportTab — L320-546
  - ProductionReportTab — L547-740
  - InventoryReportTab — L741-871
  - FinancialReportTab — L872-1123
  - EmployeeReportTab — L1124-1314
  - ReportsPage (default export, tab router + ?tab= URL sync) — L1315-1396

**Gotchas**
- No page file exceeds the ~2000-line threshold (reports.tsx 1396, daily-report.tsx 1815), so bigFileSections is only provided for reports.tsx as the highest-value map; daily-report.tsx is large but a single page. The 2009-line file is src/api/routes/dashboard-overview.ts, a ROUTE not a page.
- reports.tsx tabs do NOT call /api/reports/* — each tab fetches the source module's own list API (sales-orders, invoices, production-orders, products, purchase-orders, workers) and computes its own summaries client-side. Only daily-report.tsx consumes /api/reports/compliance.json. Don't expect the Reports hub and the reports.ts route to share data shapes.
- Heavy business logic lives in src/api/lib/* not in the route file: compliance-report.ts (1291 lines, the Daily Report engine), efficiency-report.ts (644), schedule-overdue-report.ts. The route file (reports.ts, 545) is a thin wrapper around these. Edit logic in lib, not the route.
- Two shared client engines: src/lib/print-report.ts (305 lines, THE dashboard print/report engine — see MEMORY arch_report_print_engine; WYSIWYG, wire onFilteredDataChange for sort-follow) and src/lib/export-report.ts (74, export helper). Reuse these — don't hand-roll print/export.
- dashboard-b/ is explicitly disposable/experimental and mirrors /dashboard numbers; charts.tsx is lazy-loaded to defer the ~357KB recharts/d3 bundle. Don't import recharts eagerly into index.tsx or you reintroduce the load-order regression.
- reports.ts exposes both HTML/JSON GET pairs AND POST .../send email endpoints (efficiency/schedule/overdue) that pull recipients from kv_config + users — sending touches the email/cron path, not just reads.
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
- Project status model: DRAFT / ACTIVE / ON_HOLD / COMPLETED / CANCELLED with dedicated transition endpoints (start/hold/resume/complete/move-to-draft/reopen) — change status via these, not a raw PUT, so audit trail + started_at stay consistent.
- No automated tests cover R&D — verify lifecycle + issuance changes manually before shipping.
- Production BOM was removed (Task #8); leftover comments at detail.tsx ~2225 and ~2739 are dead markers, not a missing feature.

**Start here:** For most R&D tasks open `src/pages/rd/detail.tsx` (the 3143-line project dashboard) for UI, paired with `src/api/routes/rd-projects.ts` for the lifecycle/issuance/labour backend; `src/pages/rd/index.tsx` is the entry list page.

---

## Quality, Warehouse, Scanning & Platform

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/quality.tsx` — QC Inspections (Pending/History/Templates) (977) | `src/api/routes/qc-inspections.ts` — QC inspections CRUD (qc_inspections + qc_defects) | `qc_inspections` / `qc_defects` / `qc_templates` / `qc_template_items` / `qc_tags` | `tests/audit.test.mjs` |
| `src/pages/warehouse.tsx` — Grid / Stock In-Out / Movement History (1368) | `src/api/routes/qc-pending.ts` — cron generates PENDING inspections from templates (12:00/16:00) | `stock_movements` / `stock_adjustments` / `fg_units` | `tests/do-scan-sort.test.mjs` |
| `src/pages/do-scan.tsx` — mobile DO sticker scanning | `src/api/routes/qc-templates.ts` — checklist templates (qc_templates + qc_template_items) | `fabric_trackings` / `audit_events` / `edit_presence` / `file_assets` | `tests/dept-scan-split.test.mjs` |
| `src/pages/rack-scan.tsx` — rack QR stock-in; carries pieceNo/totalPieces per line (1097) | `src/api/routes/public-rack-qr.ts` — PUBLIC no-login rack stock-in + /p/ piece-sticker rack-write (auth-bypassed, idempotent); /item + stock-in are PER-PIECE (pieceNo+totalPieces → distinct rack_items row; multi-piece stamps piece_pics.racking_number not card-level) | `kv_config` / `hookka_erp_metrics` / `piece_pics` | `tests/rack-qr-per-piece.test.mjs` / `tests/scan-per-piece.test.mjs` |
| | `src/api/lib/packing-rack-write.ts` — `applyPackingRack` (rack set/clear + `rack_items` occupancy mirror); exports `ensurePiecePicsRackingColumn` (shared mig-0192 DDL) | `rack_items` / `rack_locations` / `piece_pics` | `tests/packing-piece-identity.test.mjs` |
| | `src/api/lib/packing-piece-identity.ts` — `packingPieceIdentity` (shared /p/ + /r/ + office piece identity; appends "· pc N of M" to notes when pieceNo set + totalPieces>1) | | |
| `src/pages/notifications.tsx` — in-app notifications | `src/api/routes/admin.ts` — archive/restore (writes *_archive tables) (705) | `sales_orders_archive` / `job_cards_archive` / `production_orders_archive` / `sales_order_items_archive` | `tests/security-public-endpoints.test.mjs` |
| `src/pages/maintenance.tsx` — Equipment List / Schedule / History | `src/api/routes/admin-health.ts` — platform health/metrics aggregation (1569) | | `tests/security-permission-matrix.test.mjs` |
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
  - QualityPage (root) — L150-187
  - PendingTab + PendingRow — L207-341
  - DoInspectionForm — L342-603
  - HistoryTab — L604-672
  - TemplatesTab + TemplateEditor — L673-977
- `src/pages/rack-scan.tsx`
  - RackScanPage (single component) — L103-1097
- `src/pages/maintenance.tsx`
  - MaintenancePage (root) — L76-356
  - Tab 1 Equipment List — L369-536
  - Tab 2 Maintenance Schedule — L538-713
  - Tab 3 Maintenance History — L715-812

**Gotchas**
- public-rack-qr.ts is auth-BYPASSED via PUBLIC_PREFIXES ('/api/public/rack-qr/'). Any new endpoint added under that prefix is exposed with no login — guard tenancy/idempotency manually. Covered by tests/security-public-endpoints.test.mjs.
- QC Phase 2 is DESCOPED (memory project_qc_phase2_descoped): qc_tags rows still get written on FAIL but owner does NOT want them surfaced in Inventory or as DO warnings. Don't re-surface qc_tags.
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

**Start here:** For QC work open `src/api/routes/qc-pending.ts` + `src/pages/quality.tsx`; for warehouse/stock-scan work open `src/api/routes/public-rack-qr.ts` (the auth-bypassed stock-in flow) and `src/pages/warehouse.tsx`; for platform/admin work start at `src/api/routes/admin-health.ts`.

---

Before schema/money/ship work read docs/HOOKKA-GOTCHAS.md; for review depth see docs/DEV-OPERATING-FRAMEWORK.md.
