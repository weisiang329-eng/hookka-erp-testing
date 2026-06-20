# Hookka ERP — Navigation Map

Look up the module here BEFORE searching the repo — go straight to the listed files and line ranges.
Built to cut token usage: open the named file at the named line range instead of grepping the codebase.

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
- Sofa combo pricing is BACKEND-unified: `applySofaCombos` (`src/api/lib/sofa-combo.ts`) wired into sales-orders POST+PUT — never re-implement combo pricing in the frontend. Piece code = productCode (stored sizeCode is the SEAT size); tier null disqualifies; discount<=0 is idempotent no-op. Old full-price combo SOs re-price down on next edit.
- `so_status_changes` / `co_status_changes` store an autoActions JSON blob and drive cascades to production_orders/job_cards/fg_units/DO/invoices — status transitions are not just label changes.
- sales-orders.ts uses item-catalog-snap on POST (OCR/scan-PO back-door risk; SO PUT + CO POST/PUT historically less covered). `sales_orders_list_snapshot` is cache-aside (filtered fetches bypass cache).
- CN is the consignment DO-equivalent. Owner rulings: CNs NEVER have invoices; 3PL stays DO-side. Amount on CN/CO list derives from CO value, not a stored field. Dispatch/delivered emails idempotent via folded-lowercase dispatchemailat/deliveredemailat.
- consignment/note.tsx renders all 3 tabs inline in one component from L505 — no separate tab components; packing_list block is the bulk (L3469-5219).
- camelCase DB columns in route SQL need a `column-rename-map.json` entry or they 400 'Invalid request body'; folded-lowercase cols read dual-keyed. Prefer snake_case for new columns.
- `sales_orders.caseid` links service-repair SOs onto a service_case; SVs price 0 by default (auto-pricing skipped) — don't reintroduce auto-pricing for service orders.
- Production locks: COMPLETED job_cards / non-PENDING fg_units / cost_ledger refs are inviolate — don't override for cosmetic edits.
- wipKey must use shared `deriveTopLevelWipKey` (one formula); component-level repair picks drop unowned material lines.

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
| `src/pages/procurement/PurchaseInvoiceDetail.tsx` — PI detail DRAFT-only (742) | `src/api/routes/credit-notes.ts` / `debit-notes.ts` | `raw_materials` | |
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
  - GRN create full-page (single component, no section banners) — L1-1174

**Gotchas**
- GRN Post-to-Stock is a cascade: DRAFT/CONFIRMED→POSTED boundary in grn.ts writes stock/WIP movements AND flips parent PO status to RECEIVED (all received) or PARTIAL_RECEIVED (any). Don't write stock outside this boundary; arrival gate guards CONFIRMED/POSTED transitions. COMMITTED_STATUSES = {CONFIRMED,POSTED}.
- PI editable in DRAFT only. Backend returns 409 on item edits when status != DRAFT; lifecycle DRAFT→PENDING_APPROVAL→APPROVED→PAID via VALID_TRANSITIONS; PAID terminal; DELETE gated to DRAFT (row kept for audit).
- PO detail returns 412 with `requiresGrn` when a transition needs a GRN first (detail.tsx handles res.status===412 && data.requiresGrn) — receiving must go through GRN, not a direct PO status flip.
- Supplier line autofill reads `supplier_material_bindings`; per-line supplier+price come from bindings, NOT a separate catalog. PI standalone intentionally excludes catalog autofill.
- Money stored in sen integers (amountSen, unit_cost_sen); use MoneyInput / roundSen, never float RM.
- Migrations INERT unless self-applied at runtime via `ensurePendingMigrations` (ALTER ADD COLUMN IF NOT EXISTS) — a new procurement column reaches prod only that way.
- camelCase write columns (receivedDate, receivedQty) need a `column-rename-map.json` entry or the route silently 400s; prefer snake_case. db-pg toCamel recovers true snake_case but not folded-lowercase camelCase.
- ThreeWayMatchPanel (detail.tsx 1331+) joins PO↔GRN↔PI and is also a standalone route (three-way-match.ts); variance is derived, don't persist a second copy.
- OCR scan-supplier.ts is a catalog-snap back-door; SO/CO PUT paths historically unguarded — verify status-snap before trusting OCR-written prices.
- PENDING task to merge Supplier Pricing (pricing.tsx) into the Supplier module — don't duplicate the comparison surface (a duplicate modal was shipped+reverted before).

**Start here:** Open `src/pages/procurement/index.tsx` (PO list + POFormDialog) or `src/pages/procurement/detail.tsx` (PO detail + ThreeWayMatchPanel); for receiving/stock start at `src/api/routes/grn.ts`.

---

## Delivery & Consignment

| Frontend page | API route | Primary tables | Tests |
|---|---|---|---|
| `src/pages/delivery/index.tsx` — DO workbench + 3PL mgmt (6879) | `src/api/routes/delivery-orders.ts` — DO end-to-end (6189) | `delivery_orders` / `delivery_order_items` | `tests/delivery-pipeline.test.mjs` |
| `src/pages/delivery/detail.tsx` — single DO detail | `src/api/routes/packing-lists.ts` — delivery-side truck runs | `packing_lists` | `tests/do-qr-public.test.mjs` |
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
  - DeliveryPage start + pageTab (orders|3pl) URL state — L801-810
  - 3PL Providers state + vehicles/drivers sub-table state — L911-1090
  - 3PL Provider helpers (CRUD, rates, fleet, drivers) — L1445-1830
  - DO status tally / search / transition logic — L2069-2790
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
| `src/pages/accounting/index.tsx` — mega-page, ~25 tabs (7945) | `src/api/routes/accounting.ts` — the accounting engine (~8147) | `chart_of_accounts` / `account_aliases` | `tests/cashflow-engine.test.mjs` |
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
  - Audit Log tab (document lifecycle trail, F3) — L213-321
  - MAIN PAGE (tab host / nav) — L322-426
  - Overview tab + cards (Cleanup, Contra, LandedCost, DocNumbering, GstRate, Fye, StockMap, Aging) — L427-1320
  - Chart of Accounts tab (COATab) — L1321-1905
  - Journal Entries tab + JournalEntryForm — L1906-2332
  - Accounts Receivable tab (ARControlPanel + ARTab) — L2333-2661
  - Accounts Payable tab (APControlPanel + APTab) — L2662-3081
  - P&L report tabs (CostStructure, CostExpenseClasses, MonthlyTrend, MonthlyPl, PLStatement + ExportButtons) — L3082-3806
  - Other Debtors/Creditors tab — L3807-4579
  - GL Phase 1: Trial Balance tab — L4580-4714
  - GL Phase 2: GeneralLedgerTab — L4715-5172
  - Payment / Expense tab (PaymentsTab) — L5173-5524
  - Official Receipt tab (ReceiptsTab) — L5525-5760
  - Fund Transfer tab — L5761-5968
  - Stock Summary tab + WipDetailCard — L5969-6222
  - Labour month-end posting tab + AddDeptMapRow — L6223-6446
  - Fixed Assets + Depreciation tab — L6447-6734
  - Cash Book / Bank Reconciliation tab — L6735-7076
  - Opening Balance tab — L7077-7480
  - Balance Sheet tab (+ YearCloseCard) — L7481-7778
  - Cash Flow tab — L7779-7945

**Gotchas**
- `document_lifecycle` JOIN is load-bearing: list endpoints (PV, journals, etc.) must return lifecycleState or the FE shows wrong actions — voided docs showed void/delete instead of unvoid/delete (commit 8221d726, F3 hotfix). When adding a list query, JOIN document_lifecycle and surface lifecycleState.
- Money stored as integer sen (amountSen / discount_sen). Never floats; rounding through shared roundSen / distributeRoundSen in `src/lib/utils.ts`.
- invoices uses camelCase DB columns; new write columns should be snake_case (e.g. discount_sen mig 0179) and need a `column-rename-map.json` entry or they 400 'Invalid request body'. CI-guarded by `tests/sql-write-column-coverage.test.mjs`.
- Migrations INERT unless runtime-wired: new column reaches prod only via `ensurePendingMigrations` self-apply inside the route before the INSERT — see invoices.ts:980 ALTER for discount_sen.
- cost_ledger is append-only: cost-ledger.ts and stock-value reads are derived; actual cost rows written side-effectually by GRN/production_orders/delivery_orders. Don't write cost_ledger from accounting routes.
- Invoice mutations cascade: create-from-DO / void touches sales_orders, so_status_changes, delivery_orders, and customers running balance. Edit the cascade, not just the invoice row.
- `ledger_journal_entries` (posted GL) is distinct from `journal_entries`/`journal_lines` (journal module). P&L/balance sheet/trial balance/GL tabs read ledger_journal_entries + chart_of_accounts — don't confuse the two.
- Two huge files (index.tsx 7945, accounting.ts 8147) — use the `// =============== TAB:` banners as jump anchors; never read either end-to-end.
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
- `src/pages/mail-center/index.tsx`
  - Dept/mailbox constants (canonical dept mailboxes, panes) — L165-246
  - ThreadList + row icon helpers — L247-578
  - DraftsList — L579-640
  - MailCenterPage default export (main shell, folders, bulk, fetch) — L641-1482
  - Sidebar items (FolderItem/MailboxItem/DeptGroup/PersonItem) — L1483-1989
  - LabelManagerDialog + rows + color swatches — L1990-2274

**Gotchas**
- customer-maintenance.ts is a SNAPSHOT mirror: copies EVERY master maintenance_config_history snapshot per customer and REFUSES to write if the master config is corrupt — don't bypass that guard or write per-customer config directly.
- RBAC is a hard gate: users.ts uses `requireSuperAdmin(c)` on all 7 account mutations — rejects any role != SUPER_ADMIN even with *:*; Users.tsx hides Disable/Reset/Delete/invite unless SUPER_ADMIN. ADMIN deliberately cannot manage accounts.
- Two separate auth systems: auth.ts/auth-oauth/auth-totp (office users) vs worker-auth.ts (factory workers) — NOT interchangeable; worker-auth has a 'default-protect' invariant with its own test.
- camelCase/snake_case: read paths dual-key (r.effectiveFrom ?? r.effective_from ?? r.effectivefrom); any new camelCase WRITE column needs a `column-rename-map.json` entry or it 400s. Prefer snake_case.
- Sofa combo pricing is BACKEND-unified via `applySofaCombos` wired into sales-orders POST/PUT — do NOT re-implement combo math in customers.tsx or maintenance/sofa-combos.tsx; those are config editors only.
- Per-customer product prices (customer_products/customer_product_prices) shadow master product_prices; customers.tsx CustomerProductsPanel intentionally MIRRORS the Products page bulk-edit dirtyEdits pattern — keep in sync, don't fork.
- Customer hubs feed the DO/Service hub chain (delivery_hubs, customer_hubs); hub-cascade-completeness + service-hub-chain tests guard the cascade — editing hub routes can break downstream delivery/consignment integrity.
- /api/files (files.ts) serves customer, product-doc and modular uploads with attachment disposition but `<img src=.../download>` still renders — shared endpoint, don't special-case per resourceType.
- kv_config is a shared generic store (e.g. public_holidays consumed by payroll) — changing its shape can affect unrelated modules.

**Start here:** For a customer-facing task open `src/pages/customers.tsx`; for users/RBAC/org/mailbox-scope open `src/pages/settings/Users.tsx`; for internal email open `src/pages/mail-center/index.tsx`.

---

Before schema/money/ship work read docs/HOOKKA-GOTCHAS.md; for review depth see docs/DEV-OPERATING-FRAMEWORK.md.
