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
| `src/pages/sales/edit.tsx` — Edit SO (1634); re-runs sofa-combo on save; unit price + build-up via `@/lib/pricing` | `src/api/routes/consignments.ts` — legacy/shared reads (536) | `sofa_combo_rules` / `customer_products` / `price_overrides` | |
| `src/pages/consignment/index.tsx` — CO list (1197) | `src/api/routes/sofa-combos.ts` — sofa_combo_rules CRUD (650) | `cost_ledger` / `production_orders` / `job_cards` / `fg_units` | |
| `src/pages/consignment/create.tsx` — Create CO (1782) | `src/api/routes/historical-sales.ts` — read-only history (128) | `delivery_orders` / `delivery_order_items` / `invoices` / `invoice_items` | |
| `src/pages/consignment/edit.tsx` — Edit CO (1142); unit price + build-up via `@/lib/pricing` | | `sales_orders_archive` / `sales_order_items_archive` / `sales_orders_list_snapshot` | |
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
- CN is the consignment DO-equivalent. Owner rulings: a CN CAN be converted to a DRAFT invoice — `POST /api/consignment-notes/:id/convert-to-invoice` (`src/api/routes/consignment-notes.ts:1334`) is an OFFICIAL flow (owner re-confirmed 2026-08-01); the link is `consignment_notes.converted_invoice_id`, a real indexed FK to `invoices(id)` (mig 0070), idempotent — one invoice per CN, a second call 409s with the existing id. This REPLACES the older no-CN-invoices ruling that sat here until 2026-08-01 — that line was stale, don't re-assert it. 3PL stays DO-side. Amount on CN/CO list derives from CO value, not a stored field. Dispatch/delivered emails idempotent via folded-lowercase dispatchemailat/deliveredemailat.
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
- **POSTED GRN lines are EDITABLE with a compensating cascade (owner 2026-06-22)**: grn-detail.tsx "Edit Quantities" → PUT items[] on a POSTED GRN corrects per-line acceptedQty; the backend (`buildPostedGRNStockAdjustment`) posts the DELTA via the SAME helpers postGRNToStock uses (resolveRmForGRNItem / makeLedgerEntry / genBatchId) — raw_materials.balanceQty += delta, the GRN batch's original/remaining += delta (clamped ≥0), one cost_ledger entry (RM_RECEIPT IN on +, ADJUSTMENT OUT on −); `cascadePOReceivedQtyDelta` moves the parent PO line's receivedQty + recomputes PO status. invoiced_qty is NOT touched (PI-owned); status stays POSTED (no un-post). Edit BLOCKED when newAccepted < invoiced_qty (a PI already billed it) or when lines are added/removed. Edit-then-revert is a true no-op. The shared rule + message live in `src/lib/purchase-edit-rules.ts` (`checkGrnLineQtyEdit`/`describeGrnStockDelta`/`isGrnLineEditable`) so FE+BE reject identically. Tests: `tests/purchase-edit-rules.test.mjs` + `tests/purchase-edit-cascade.test.mjs`. The line-restructure lock is unchanged (still 409); un-posting is now Cancel Receipt (below).
- **The downstream-PI lock is PER LINE, not per document (owner: "这种转换不是整张单锁死的")**: `isGrnLineLockedByPi` freezes ONLY the lines with `invoiced_qty > 0` (frozen in BOTH directions — an up-edit leaves the PI on a stale qty/price too); every other line on the same receipt stays correctable with the usual compensating movement. Enforced inside `checkGrnLineQtyEdit`, so FE + BE agree line by line. The only document-level 409 left is `isGrnFullyLockedByDownstreamPi` (EVERY line billed → nothing to correct). grn-detail.tsx marks each locked line with a Lock chip + "N of M lines locked" banner instead of refusing the whole document. Previously ANY invoiced line 409'd the entire GRN — bill one line of a ten-line receipt and the other nine were uncorrectable forever.
- **A POSTED GRN can be CANCELLED — `POST /api/grn/:id/cancel` (mig 0213, self-applied by `ensureGrnCancelSchema`: `grns.cancelled_at`/`cancelled_reason` + a status CHECK swap to admit CANCELLED)**. It reverses EXACTLY what `postGRNToStock` wrote, driven off the LOTS (`rm_batches WHERE source='GRN' AND sourceRefId=grnId`) not the lines, since an unresolved line never got a lot and a later qty edit moved originalQty in step: `balanceQty += −originalQty` per lot + DELETE the lot row. It then calls `restorePOReceivedQtyForGRN` (the SAME helper delete/un-post use — no third restore path) so the PO line becomes receivable again. **NO compensating cost_ledger leg, deliberately**: the FIFO/P&L engine sources GRN receipts from `grn_items JOIN grns … WHERE g.status IN ('CONFIRMED','POSTED')` (accounting.ts `loadMaterialCostData`) and reads cost_ledger only for RM_ISSUE/ADJUSTMENT, so CANCELLED removes the receipt from the replay by itself — an ADJUSTMENT OUT would reduce material cost TWICE. Two refusals, because a partial reversal is worse than none: a live PI still drawing on the lines (void the PI first — that path restores invoiced_qty), and any lot already CONSUMED (`remainingQty < originalQty` → the goods are issued/returned; use a purchase return or stock adjustment). CANCELLED is terminal (PUT 409s on edit or resurrect) but IS deletable. UI: "Cancel Receipt" on grn-detail.tsx header + the grn.tsx row menu, both confirming with the PO number and the quantities released. Tests: `tests/purchase-edit-cascade.test.mjs`.
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
- PENDING task to merge Supplier Pricing (pricing.tsx) into the Supplier module — don't duplicate the comparison surface (a duplicate modal was shipped+reverted before).
- Convert-chain availability (PO→GRN→PI, mig 0182): per-line CONSUMED tracking. PO line available = `quantity − receivedQty`; GRN line available = `accepted_qty − invoiced_qty` (both exposed as `availableQty` on item reads, dual-keyed). PI POST takes `body.grnId` + per-line `grnItemId`; a LINE-LEVEL 409 guard (`src/lib/convert-chain.ts` `checkConvertAvailability`) replaced the old PO-level double-bill 409 — a 2nd PI is allowed when qty remains, only the over-drawn line is rejected. Increment `grn_items.invoiced_qty` on PI create (same batch as the line insert); RESTORE on PI delete / PI items-replace / PI→CANCELLED, and on GRN un-post/cancel/delete (`restorePOReceivedQtyForGRN` decrements `purchase_order_items.receivedQty`, recomputes PO status). Stock posting (`postGRNToStock`) is NOT reversed by any restore — availability only. GRN DELETE is blocked while a non-CANCELLED PI references it (`purchase_invoices.grn_id`). **A GRN-sourced PI is capped by the receipt AND by the purchase order (BUG-2026-08-07-003, BUG-CLASS C10): `checkPoRemaining` (`purchase-invoices.ts:945`) is the ONE PO ceiling, called by the PO branch, the GRN branch and the PUT re-line (the last with the edited PI excluded from its own already-invoiced sum). Before this, a GRN-sourced invoice saw only `accepted − invoiced_qty`, so 100 could be billed off the PO and 100 more off its GRN. The ceiling is `poInvoiceCeiling` = max(ordered, receivedQty) so an accepted over-receipt stays invoiceable; requested qty is aggregated per material code; a GRN line with no PO (direct receipt) is not PO-capped. A GRN-sourced line's `purchase_invoice_items.po_id` is resolved the same way the guard resolves it — `line.poId → body.purchaseOrderId → grn_items.po_id → grns.poId`.** Tests: `tests/convert-chain.test.mjs` + `tests/purchasing-convert-flow.test.mjs`.
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
  - Multi-company (Phase 2): `CompanySelect` + `GroupByCompanyCard` (index.tsx) and `useCompanyOptions`/`orgIdParam` (accounting/shared.ts). "" = All companies (group) → report URL unchanged (consolidated); a company appends `&orgId=<code>` (org CODE lower-cased, e.g. `hookka`/`ohana`, NOT org row id). Wired into Balance Sheet (`/pl`), Trial Balance (`/trial-balance`), Debtor/Creditor Aging (`/aging` + `/ar-control`/`/ap-control`). The rich P&L tab (`/pl-statement`) does NOT accept orgId — scoping it needs a backend change (companyFilter threaded through computePnlWindow/FIFO), deliberately out of scope.

**Gotchas**
- `document_lifecycle` JOIN is load-bearing: list endpoints (PV, journals, etc.) must return lifecycleState or the FE shows wrong actions — voided docs showed void/delete instead of unvoid/delete (commit 8221d726, F3 hotfix). When adding a list query, JOIN document_lifecycle and surface lifecycleState.
- Money stored as integer sen (amountSen / discount_sen). Never floats; rounding through shared roundSen / distributeRoundSen in `src/lib/utils.ts`.
- invoices uses camelCase DB columns; new write columns should be snake_case (e.g. discount_sen mig 0179) and need a `column-rename-map.json` entry or they 400 'Invalid request body'. CI-guarded by `tests/sql-write-column-coverage.test.mjs`.
- Migrations INERT unless runtime-wired: new column reaches prod only via `ensurePendingMigrations` self-apply inside the route before the INSERT — see invoices.ts:980 ALTER for discount_sen.
- cost_ledger is append-only: cost-ledger.ts and stock-value reads are derived; actual cost rows written side-effectually by GRN/production_orders/delivery_orders. Don't write cost_ledger from accounting routes.
- P&L RM/WIP/FG come from the FIFO engine, NOT cost_ledger perpetual totals (ledger stopped being fed after 2026-03). `loadMaterialCost(db, orgId, startIso, endIso)` (accounting.ts, just before `computePnlWindow`) replays GRN receipts + cost_ledger RM_ISSUE/ADJUSTMENT through `src/lib/material-cost-fifo.ts`; `computePnlWindow` now takes `orgId` and reads `mat.rmGroups/wipOpenSen/wipCloseSen/fgOpenSen/fgCloseSen` instead of stockSummaryRange. WIP/FG are reconstructed as-of-date (in-progress = start_date<=D & (completed_date null or >D); FG undelivered = original_qty − fg_units delivered_at<=D). Receipt cost = APPROVED-PI weighted avg per (PO, material_code) else grn_items.unit_price. stockSummaryRange still feeds the closing-stock journal legs (buildClosingStockLegs) — leave it.
- Invoice mutations cascade: create-from-DO / void touches sales_orders, so_status_changes, delivery_orders, and customers running balance. Edit the cascade, not just the invoice row.
- **ONE delivery order, SEVERAL invoices (2026-08-07).** The sales side now has the per-line convert chain purchasing has always had: `delivery_order_items.invoiced_qty` (consumed counter) + `invoice_items.delivery_order_item_id` (which delivery line a bill line draws from), both runtime-self-applied by `ensureDoPartialInvoiceColumns` (`src/api/lib/do-partial-invoice.ts`, migration 0214). Arithmetic is the SHARED seam `src/lib/convert-chain.ts` — the same `availableQty` / `clampDecrement` the PO→GRN→PI chain uses. Billed state is DERIVED (`loadDoBillingState`: Σ invoiced_qty vs Σ quantity), never the status flag; `delivery_orders.status` is kept in step by `buildDoStatusSyncStatement` and only reaches INVOICED on the LAST slice, so a half-billed DO stays DELIVERED and can be finished. `computeDoInvoiceLines(db, doId, soIds, select?)` bills each line's REMAINDER (or the operator's pick) — that one change is what makes the first invoice identical to today and the second bill only what is left; its two SO-level fallbacks are gated behind `freshWholeDo` because they consume nothing and would otherwise re-bill the whole SO. Every increment is paired: `buildInvoiceLineReleaseStatements` runs on void, DRAFT delete AND DRAFT line-replacement (release the whole old set, re-consume what survives). `uniq_invoice_active_delivery_order` (mig 0208) is DROPPED and replaced by the CHECK `chk_doi_invoiced_qty (invoiced_qty <= quantity)` — same race, better invariant; a violation is caught and returned as a 409 with the current remainder. UI: `GET /api/delivery-orders/:id/billable-lines` feeds the line/quantity picker in the Transfer-to-Invoice dialog (`src/pages/delivery/index.tsx`). Tests: `tests/do-partial-invoice.test.mjs`, `tests/invoice-dedupe-guard.test.mjs`.
- **BACKWARDS COMPATIBILITY — read this before touching the billed-state rule.** Existing invoices have NO `delivery_order_item_id` and the new counters start at 0. Deriving billed state from the counters alone would make every already-billed DO read as unbilled and become re-billable — an invitation to double-charge. So `fullyInvoiced = (remaining is 0) OR (a LIVE invoice on this DO has no linked lines)`. That second clause is the LEGACY whole-document bill: today's data keeps behaving exactly as today (one live invoice ⇒ refuse a second, same message), and voiding it makes the DO billable again from zero, which is correct. `legacyInvoices` is a LIST, not one row, so a DO carrying two legacy bills does not release on the death of either. **There is deliberately NO backfill of `invoiced_qty`** — the mapping would have to be guessed by product code, and two of the three invoice-line fallbacks have no DO line behind their rows at all; a guess that lands short silently licenses billing the difference twice.
- Still whole-document, by design: `loadDoInvoiceMap` and the FE notice PDF pick the NEWEST live invoice per DO for the grid's `invoiceNo` column and the customer e-mail. `POST /api/admin/dedupe-invoices` is unaffected — it only flags a group whose invoices have an IDENTICAL item signature AND a full DO item count, which a partial bill never has.
- **An invoice line's per-line enrichment resolves through `invoice_items.production_order_id`, NOT by product code** (`src/api/lib/invoice-print-extras.ts`, BUG-2026-07-17-001). Both halves: `refByPo` for the customer PO / SO / REF, and the PRICE half via `poLink → poToSo → tightBySo/looseBySo/byCodeBySo` — the sales-order item maps are also built SO-scoped, so a line resolves inside its OWN sales order. The global `tight`/`loose`/`byCode` maps are **first-one-wins across every source SO** and survive ONLY as the fallback for lines with no PO link — on a consolidated DO they hand a line another variant's numbers, which is how an invoice printed "Base 0 … = RM 305" on a line the editor then re-summed to RM 308. Don't reintroduce a code-keyed price lookup ahead of the PO link. The endpoint now also returns the line's CHARGE as `unitSen` (`invoice_items.unitPriceSen`, never the sales order's own unit) plus a `buildUpReconciles` verdict.
- **THE invoice-line price rule lives in one module: `src/lib/invoice-line-price.ts`** (importable by both sides — `src/api/lib/` is backend-only). Written out at the top of that file: the charge is `invoice_items.unitPriceSen` and is authoritative; the Base/Divan/Leg/T.Height/Special build-up only EXPLAINS it; a build-up is displayed only when `base+divan+leg+totalHeight+special === unitPriceSen` (and only when there IS a surcharge); editing moves the explanation and the charge together, so the edit SEED (`invoicePriceEditSeed`) always reconciles — Edit → Save with nothing typed can never reprice a line. Callers, all of them: `invoicePriceBreakdown` (`src/lib/build-unified-doc-data.ts`, the Invoice/SO/CO PDF seam), the invoice detail read view AND its editor (`src/pages/invoices/detail.tsx`), `priceLines` in `generate-invoice-pdf.ts`, the backend resolver `invoice-print-extras.ts`, the `priceEdits` write in `src/api/routes/invoices.ts`, and the order-side alias `calculateUnitPrice` (`src/lib/pricing.ts`). Never hand-roll a second breakdown renderer or a second component sum. Tests: `tests/invoice-price-buildup-rule.test.mjs`, `tests/invoice-line-price.test.mjs`, `tests/invoice-pdf-breakdown.test.mjs`.
- **The ORDER edit screens go through the same module** (BUG-2026-08-07-007, 2026-08-07). `src/lib/pricing.ts` carries the order-side seam: `calculateUnitPrice` (the five-term sum), `orderLinePriceBuildUp` + `formatOrderLineUnit` (the guarded inline "Unit: X (Base A + …)" caption — no build-up unless it sums to the charge). `src/pages/sales/edit.tsx` (`getUnitPrice` `:824`, caption `:1614`) hand-rolled `base+divan+leg+special` and never mentioned `totalHeightPriceSen`, while `PUT /api/sales-orders/:id` DERIVES that fifth component when the client omits it — the screen showed RM 830 and the save stored RM 910. It now keeps `totalHeightPriceSen` in state, seeds it from the line's stored column, re-derives it with the server's own `deriveTotalHeightSurchargeSen` when gap/divan/leg change, and posts it. `src/pages/consignment/edit.tsx` (`:479`) uses the same helpers with an explicit `totalHeightPriceSen: 0` — the CO write path charges four components and never fills `consignment_order_items.total_height_price_sen`. ⚠️ Open: `consignment/create.tsx` DOES compute + post a total-height surcharge that `consignment-orders.ts` silently drops. Tests: `tests/order-edit-unit-price.test.mjs`.
- The invoice editor's live sums (`detail.tsx:734` per-line Unit · `:395` header total · `:916` footer Subtotal) must include **all five** components — base, divan, leg, special AND `totalHeight`. The `DiscountInput` base at `:870` is `liveUnit * qty`, so an omission there silently shrinks a `%` discount too and the figure jumps after save (BUG-2026-07-17-001, 2026-08-07). Tests: `tests/invoice-price-buildup-rule.test.mjs`, `tests/invoice-line-price.test.mjs`.
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
- WIP idempotency: `applyWipInventoryChange` in production-orders.ts claims work via wip_cascade_log INSERT-ON-CONFLICT, but ONLY when options.orgId is passed — callers without orgId still unguarded (FOAM-326 class). Don't rebuild the table; audit caller coverage.
- wipKey is derived by a SINGLE shared helper `deriveTopLevelWipKey` (FAB_SEW splits on '::'[2], etc.). Never re-implement; stale picks throw at confirm.
- Repair scope: `production_orders.repairscope` stamps partial repairs (FULL=null=byte-identical). Component-scope picks DROP unowned material lines — not cosmetic.
- COMPLETED job_cards / non-PENDING fg_units are inviolate (production locks). Suggest a UI fix instead.
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
| `src/pages/worker/login.tsx` — PIN login | `src/api/routes/payroll-hour-deductions.ts` — short-hour dock (195) | `employee_advances` (salary advances) | `tests/employee-advances.test.mjs` |
| | `src/api/routes/employee-advances.ts` — advance CRUD + HR payout listing; maths + runtime self-apply in `src/api/lib/employee-advances.ts` | `payslips.advance_deduction_sen` (mig 0211, runtime ALTER) | |
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
  - TAB 5: Payroll (PayrollTab) — L6266-7462 (+ Advance column / drift banner, 2026-08-07)
  - TAB 5c: Salary Advances (AdvancesTab) — just above `// ========== MAIN PAGE ==========`
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
- payroll_hour_deductions (mig 0152) and other module tables are runtime self-applied via ensurePendingMigrations, NOT replayed from migration files on deploy — a migration file alone is INERT. Same for employee_advances + payslips.advance_deduction_sen (mig 0211) via `ensureAdvanceTables`.
- Salary advances are NOT a statutory deduction and NOT an earning: netPay = gross − totalDeductions − advance, and `totalDeductionsSen` stays statutory-only (folding advances in would inflate every YTD/statutory figure). The period an advance belongs to is the month of its `advance_date`. The generated payslip snapshots the figure in `advance_deduction_sen` so editing an advance later cannot move an approved net pay — the Payroll tab shows a red drift banner instead.
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
| `src/pages/planning/index.tsx` — 5-tab PlanningPage (Capacity Overview / Capacity Loading / Lead Times / Master Tracker / Schedule Proposals) + DrilldownModal (4004) | `src/api/routes/planning-schedule.ts` — per-dept daily schedule data (GET /schedule/fabric-cutting, /schedule/:dept) + `computeChainWithAssignments` (Phase-2 engine assignments) + GET /capacity-audit (read-only engine-ceiling vs actual-output reconciliation, over `src/api/lib/planning-capacity-audit.ts`) | `production_orders` (read: active POs, due dates, progress) + `job_cards` (read: rolling actual minutes) | `tests/planning-scheduler.test.mjs` · `tests/planning-capacity-audit.test.mjs` |
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
| `src/pages/quality.tsx` — QC Inspections (Pending/History/Templates) (1063) · `src/pages/worker/qc.tsx` — IPQC on the phone (own dept + today only) | `src/api/routes/qc-inspections.ts` — QC inspections CRUD (qc_inspections + qc_defects) · `worker.ts` GET /qc-today + POST /qc/:id/complete | `qc_inspections` / `qc_defects` / `qc_templates` / `qc_template_items` / `qc_tags` | `tests/qc-wip-completable.test.mjs` / `tests/qc-worker-portal.test.mjs` / `tests/qc-generation-coupling.test.mjs` / `tests/audit.test.mjs` |
| `src/pages/warehouse.tsx` — Grid / Stock In-Out / Movement History (1368) | `src/api/routes/qc-pending.ts` — generation runs 12:00/16:00 on FOUR rhythms: IQC per receipt DAY×supplier×family (`generateRmForGrns`), STORED per batch ISSUED that day (`generateStoredRmChecks`), WIP per working dept (`stageHadActivity`), FG a RISK-WEIGHTED sample (`generateFgSamples` + `lib/qc-fg-risk.ts`); owns `completeInspection` (shared desktop+phone) + `ensureQcGenerationSchema` | `stock_movements` / `stock_adjustments` / `fg_units` / `grns` / `grn_items` / `cost_ledger` / `rm_batches` / `service_cases` / `bom_versions` | `tests/do-scan-sort.test.mjs` / `tests/qc-rm-families.test.mjs` / `tests/qc-fg-risk.test.mjs` / `tests/qc-wip-templates.test.mjs` |
| `src/pages/do-scan.tsx` — mobile DO sticker scanning | `src/api/routes/qc-templates.ts` — checklist templates (qc_templates + qc_template_items); RM templates carry `material_family` and POST refuses an RM template without one · `src/api/lib/qc-rm-families.ts` — item-group → material-family routing + `pickRmTemplate(templates, family, supplierId, kind)` where kind is INCOMING|STORED · `src/api/lib/qc-fg-risk.ts` — `scoreFgUnit` risk weighting for the OQC draw | `fabric_trackings` / `audit_events` / `edit_presence` / `file_assets` | `tests/dept-scan-split.test.mjs` |
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
- **RM routing is off `raw_materials.item_group`, never off supplier free text** (`src/api/lib/qc-rm-families.ts`, mirrors `CATEGORY_TO_ITEM_GROUPS` in `src/lib/material-lookup.ts`). A new material code inherits the right checklist the moment it is filed in the right group. Ten families, ten templates (mig 0215): FABRIC / PLYWOOD / TIMBER / SOFA_FOAM / BED_FILLER / WEBBING / MECHANISM / PACKING / ACCESSORIES / GENERAL. **Only FOAM/FILLER is split bedframe-vs-sofa** (SOFA-FIL has a stamped density + rebound spec; BED-FILL is fibre measured in GSM and loft — one checklist would be four N/A answers). Fabric is not split (same five observations); webbing and mechanism *cannot* be split because both product lines share one item group (`WEBBING` / `EQUIPMEN`) — those templates carry a "matches the retained sample for THIS product line" item instead. **`B.OTHERS` is the one ambiguous group** (wood strip AND accessories) and is the only place a keyword probe runs; unrecognised text falls to ACCESSORIES rather than being guessed into a timber checklist. An unresolvable line falls to the GENERAL template — a receipt is never silently uninspected — and `pickRmTemplate` returning null is COUNTED and reported (`rmNoTemplate`), never substituted. `pickRmTemplate(templates, family, supplierId)` already prefers a supplier-bound template: that is the hook for a per-supplier override, and `qc_templates` has no supplier column yet so every lookup lands on the family default.
- **New QC columns are snake_case + runtime self-applied** (`ensureQcGenerationSchema`, awaited at the top of `generatePendingForSlot` and both `qc-templates` write paths): `qc_templates.material_family` / `rm_check_kind`; `qc_inspections.source_grn_id` / `source_grn_no` / `source_grn_ids` / `source_grn_nos` / `source_receipt_date` / `source_supplier_id` / `material_family` / `rm_check_kind` / `source_rm_batch_id` / `source_batch_age_days` / `source_fg_unit_id` / `so_spec` / `sample_reason`. Migrations 0215-0219 carry the same DDL plus the template CONTENT (every INSERT `ON CONFLICT DO NOTHING`, every criteria backfill guarded on `criteria IS NULL` — re-running is a no-op and an owner-edited item is never clobbered). **The migration files alone are inert** — NONE of 0215-0219 has been run; until they are, `pickRmTemplate` falls back to the seeded ids so the four 0068 families keep working, the six new INCOMING families and all eight STORED templates do not exist, and the enriched WIP criteria are absent. **`STORED` is a KIND of RM check, not a fourth `stage`** — `stage` carries a CHECK constraint and a TS union reaching the worker portal, the shared completion core and every list filter, and a stored check behaves exactly like an RM check in all of them.
- **An RM or FG slot arrives with its subject ALREADY NAMED** — `quality.tsx` renders the receipt / batch / unit banner instead of a dropdown, and skips the `/api/raw-materials` and `/api/fg-units` fetches entirely. An IQC banner lists EVERY GRN in the day's batch; a STORED banner prints the batch's days-in-store and the GRN it arrived on; an FG banner adds `SampleReasonPanel` (why this unit was drawn) above `SoSpecPanel` (what the order asked for). Only WIP still asks the inspector to pick. Picking "some raw material" out of a list of every material in the company was never a record of anything.
- **One completion core, two surfaces.** `completeInspection()` in `qc-pending.ts` owns the FAIL side-effects (qc_tags + qc_defects + JC → BLOCKED + piece_pics clear + parent-PO recompute) and is called by BOTH `POST /api/qc-pending/:id/complete` and `POST /api/worker/qc/:id/complete`. Do NOT re-implement it on a new surface: a caller that skips the piece_pics clear resurrects a QC-blocked card on the next scan (BUG-2026-06-08). A FAIL with no notes is refused there, so it is refused everywhere.
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

**Start here:** For QC work open `src/api/routes/qc-pending.ts` + `src/pages/quality.tsx`; for warehouse/stock-scan work open `src/api/routes/public-rack-qr.ts` (the auth-bypassed stock-in flow) and `src/pages/warehouse.tsx`; for platform/admin work start at `src/api/routes/admin-health.ts`.

---

Before schema/money/ship work read docs/HOOKKA-GOTCHAS.md; for review depth see docs/DEV-OPERATING-FRAMEWORK.md.
