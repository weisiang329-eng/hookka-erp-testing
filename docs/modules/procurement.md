# Procurement — Module Guide

> **Last verified: 2026-08-13** against `src/api/routes/{purchase-orders,grn,purchase-invoices,three-way-match,supplier-payments}.ts`, `src/lib/{convert-chain,purchase-edit-rules,pi-posting}.ts`, `src/pages/procurement/*`, and `tests/`.
> Re-verified 2026-08-13 (chore/dead-code-sweep): `/procurement/in-transit` is a `<Navigate>` redirect and `src/pages/procurement/in-transit.tsx` had no importer — the page is deleted, the redirect and the `goods-in-transit` API kept.
> Corrected 2026-08-13: `grn.ts` is 2,592 lines (was 1988), `purchase-invoices.ts` 2,869 (was 2110), `purchase-orders.ts` 1,177 (was 1016). Handler anchors had drifted 100–450 lines — GRN create is :1300 (was 1094), GRN edit :1789 (was 1459), GRN arrival :2174 (was 1807), PI create :1047 (was 729), PI edit :1900 (was 1458). All five named tests exist.

> Self-navigating docs (L2). Repo-wide map: [[CODEBASE-MAP]]. Never grep the whole repo — use the file:line below.

## What it does
Owns the buy-side document chain: **Purchase Orders** (PO) → **Goods Receipt Notes** (GRN) → **Purchase Invoices** (PI), plus **Goods-in-Transit** (GIT/import tracking), **Suppliers** + effective-dated **Supplier Pricing** (material bindings), **Three-Way-Match** (PO↔GRN↔PI variance), supplier **Credit/Debit Notes**, and **Supplier Payments** (MYR + FX allocation). The convert-chain is per-line consumption-tracked (PO line `quantity − receivedQty`, GRN line `accepted_qty − invoiced_qty`). Receiving a GRN is a **cascade**: crossing the DRAFT/CONFIRMED→POSTED boundary posts stock/WIP + `cost_ledger` movements and flips the parent PO status — never a label change. A PI reaching APPROVED posts AP legs to the GL. Money is integer sen throughout.

## Entry points
- Pages
  - `/procurement` → `src/pages/procurement/index.tsx:804` (`ProcurementPage` — PO list, filters, grid; `POFormDialog` deep-link prefill at `:63`)
  - `/procurement/create` → `src/pages/procurement/create.tsx` (`CreatePurchaseOrderPage`; full-page PO create)
  - `/procurement/:id` → `src/pages/procurement/detail.tsx:111` (`PurchaseOrderDetailPage`; status actions + 412-requiresGrn guard; `ThreeWayMatchPanel` at `:1349`)
  - `/procurement/grn` → `src/pages/procurement/grn.tsx:347` (`GRNPage` — GRN list)
  - GRN create → `src/pages/procurement/grn/create.tsx:103` (`GRNCreatePage`; manual default + "Convert from PO")
  - GRN detail → `src/pages/procurement/grn-detail.tsx:129` (`GRNDetailPage`; Edit Quantities → POSTED-line compensating cascade)
  - ~~`/procurement/in-transit`~~ — page **DELETED** (chore/dead-code-sweep). The route has been a bare `<Navigate to="/procurement/grn">` (`src/dashboard-routes.tsx:378`) with no sidebar entry and no importer, so `in-transit.tsx` (869 lines) was unreachable. The redirect stays for bookmarks; the `goods_in_transit` API (`src/api/routes/goods-in-transit.ts`) is untouched.
  - PI list/create/detail → `src/pages/procurement/pi.tsx:93` (`PurchaseInvoicesPage`), `pi/create.tsx:116` (`CreatePurchaseInvoicePage`), `PurchaseInvoiceDetail.tsx:137` (`PurchaseInvoiceDetailPage`; editable DRAFT+APPROVED)
  - Bindings mgmt → `src/pages/procurement/maintenance.tsx:858` (`SupplierMaintenancePage`); SKU/supplier modals `sku-form-dialog.tsx` / `supplier-form-dialog.tsx`
  - Supplier profile/scorecard/price-history → `src/pages/suppliers/detail.tsx:156` (`SupplierDetailPage`)
- API routes
  - PO CRUD + status lifecycle → `src/api/routes/purchase-orders.ts` (1190)
  - GRN CRUD + arrival + Post-to-Stock cascade → `src/api/routes/grn.ts` (2592)
  - PI CRUD + lifecycle + GL post → `src/api/routes/purchase-invoices.ts` (2869)
  - Suppliers → `src/api/routes/suppliers.ts`; bindings (autofill source) → `src/api/routes/supplier-materials.ts`
  - GIT → `src/api/routes/goods-in-transit.ts`; effective-date pricing → `src/api/routes/price-history.ts`
  - Three-Way-Match → `src/api/routes/three-way-match.ts`; supplier payments → `src/api/routes/supplier-payments.ts`
  - Supplier CN/DN → `src/api/routes/credit-notes.ts` / `debit-notes.ts`; scorecards (read-only) → `src/api/routes/supplier-scorecards.ts`; OCR extract → `src/api/routes/scan-supplier.ts`

## Data model
- `purchase_orders` / `purchase_order_items` — PO header + lines (`receivedQty` per line drives convert-chain availability).
- `grns` / `grn_items` — GRN header + lines; `grn_items.invoiced_qty` = qty pulled into a PI off that line; `grns.supplier_do_no` (mig 0183).
- `goods_in_transit` — import/GIT tracking rows.
- `purchase_invoices` / `purchase_invoice_items` — PI header + lines; `supplier_do_no` + `supplier_invoice_no`; `grn_id` links source GRN.
- `suppliers` / `supplier_materials` / `supplier_material_bindings` — supplier master + per-supplier+material binding (one row; `effective_from` = date current price takes effect, mig 0183).
- `price_histories` — append-only supplier price-change audit trail (carries `effective_from`).
- `supplier_payments` — payment + per-allocation rows (KEPT on void for unvoid); `credit_notes` / `debit_notes` — supplier CN/DN.
- Cascade targets: `raw_materials.balanceQty`, `cost_ledger` (RM_RECEIPT/ADJUSTMENT), `ledger_journal_entries` (AP legs), stock/WIP movements.
- Relationships: PO→GRN keys lines to ONE parent PO by `poItemIndex` (`grns.poId` single column) — pickers are single-source; multi-source consolidation is a follow-up.

## Core flows
1. **Create PO** — `app.post("/")` `purchase-orders.ts:430`. Takes `body.status` verbatim (MANUAL create sends `CONFIRMED`; defaults DRAFT only when omitted). Fills blank supplier SKUs from bindings (`fillBlankSupplierSku` `:172`); column self-apply in `ensurePendingMigrations` (`:1063`).
2. **Receive → Post-to-Stock cascade** — GRN status derives from ARRIVAL on create (`grn.ts:1300`): local-in-hand (arrival ARRIVED) is born POSTED and posts immediately; OCR/import → DRAFT. Crossing to POSTED calls `postGRNToStock` (`:521`, resolves RM via `resolveRmForGRNItem` `:473`, bumps `raw_materials.balanceQty`, writes `cost_ledger`) then `cascadePOStatusAfterGRNPost` (`:811`, flips PO → RECEIVED/PARTIAL_RECEIVED). `COMMITTED_STATUSES = {CONFIRMED,POSTED}` (`:305`).
3. **Edit a POSTED GRN line** — `app.put("/:id")` `grn.ts:1789`; when prev+new both committed, `buildPostedGRNStockAdjustment` (`:670`) posts only the DELTA via the same helpers, and `cascadePOReceivedQtyDelta` (`:1085`) moves the parent PO line. Blocked when `newAccepted < invoiced_qty` or lines added/removed (`checkGrnLineQtyEdit` in `purchase-edit-rules.ts:135`).
4. **PI create → convert-chain + GL post** — `app.post("/")` `purchase-invoices.ts:1068`; `ensurePiMigrations` is defined at `:49` and awaited inside. MANUAL → PENDING_APPROVAL, OCR (`ocrUsed`) → DRAFT. `checkConvertAvailability` (`convert-chain.ts:81`) line-level 409 guard; increments `grn_items.invoiced_qty`. Reaching APPROVED posts AP legs via `mapPurchaseLinesToAccounts` (`:170`) → `buildPiApprovalLegs` (`pi-posting.ts:35`).
5. **Edit PI (DRAFT or APPROVED)** — `app.put("/:id")` `purchase-invoices.ts:1921`, gated by `isPiEditable` (`purchase-edit-rules.ts:34`). Re-syncs `grn_items.invoiced_qty` (floored by `clampDecrement`, ceilinged by `checkInvoicedQtyCeilingAfterEdit` `:665`); an APPROVED edit posts a GL CORRECTION for the amount delta against a fresh sourceId.
6. **Supplier payment allocation** — `app.post("/")` `supplier-payments.ts:124` (multi-allocation MYR/FX; unallocated = advance); `/knock-off` (`:572`) / `/un-knock` (`:733`) reattribute an advance with NO GL move; void/unvoid via `buildSupplierPaymentLifecycle` (`:827`).

## Key functions / sections (locate-to-function)
| Symbol / section | file:line | Role |
|---|---|---|
| `ProcurementPage` | `src/pages/procurement/index.tsx:804` | PO list, filters, banner, grid |
| `POFormDialog` | `src/pages/procurement/index.tsx:63` | Create/edit PO modal (deep-link prefill) |
| `PurchaseOrderDetailPage` | `src/pages/procurement/detail.tsx:111` | PO detail; status actions, 412-requiresGrn guard |
| `ThreeWayMatchPanel` | `src/pages/procurement/detail.tsx:1349` | PO↔GRN↔PI variance panel (derived) |
| `app.post("/")` (PO create) | `src/api/routes/purchase-orders.ts:430` | PO create; `body.status` verbatim |
| `app.put("/:id")` (PO edit) | `src/api/routes/purchase-orders.ts:760` | PO edit + status lifecycle |
| `ensurePendingMigrations` (PO) | `src/api/routes/purchase-orders.ts:1063` | Runtime column self-apply |
| `postGRNToStock` | `src/api/routes/grn.ts:521` | Post GRN lines to stock + cost_ledger |
| `cascadePOStatusAfterGRNPost` | `src/api/routes/grn.ts:811` | Flip parent PO → RECEIVED/PARTIAL_RECEIVED |
| `buildPostedGRNStockAdjustment` | `src/api/routes/grn.ts:670` | Compensating DELTA for POSTED-line edit |
| `cascadePOReceivedQtyDelta` | `src/api/routes/grn.ts:1085` | Move PO line receivedQty by delta |
| `restorePOReceivedQtyForGRN` | `src/api/routes/grn.ts:992` | Un-post/cancel/delete: give back PO qty |
| `resolveRmForGRNItem` | `src/api/routes/grn.ts:473` | Resolve GRN line → raw_material |
| `app.post("/")` (GRN create) | `src/api/routes/grn.ts:1300` | GRN create; status derived from arrival |
| `app.put("/:id/arrival")` | `src/api/routes/grn.ts:2183` | Arrival state transition (gate) |
| `app.post("/")` (PI create) | `src/api/routes/purchase-invoices.ts:1068` | PI create + convert-chain + GL post |
| `app.put("/:id")` (PI edit) | `src/api/routes/purchase-invoices.ts:1921` | PI edit (DRAFT+APPROVED) + GL correction |
| `checkInvoicedQtyCeilingAfterEdit` | `src/api/routes/purchase-invoices.ts:686` | Ceiling on re-synced invoiced_qty |
| `mapPurchaseLinesToAccounts` | `src/api/routes/purchase-invoices.ts:183` | PI lines → GL account buckets |
| `buildPiApprovalLegs` | `src/lib/pi-posting.ts:35` | PI AP GL legs on APPROVED |
| `isPiEditable` / `checkGrnLineQtyEdit` | `src/lib/purchase-edit-rules.ts:34 / 135` | Shared FE+BE edit gates |
| `checkConvertAvailability` / `clampDecrement` | `src/lib/convert-chain.ts:81 / 138` | Line-level 409 guard + floor |
| `app.get("/by-po/:poId")` | `src/api/routes/three-way-match.ts:303` | PO-scoped variance read |
| `app.post("/")` / `/knock-off` / `/un-knock` | `src/api/routes/supplier-payments.ts:124 / 572 / 733` | Pay PIs, apply/reverse advance |
| `buildSupplierPaymentLifecycle` | `src/api/routes/supplier-payments.ts:827` | Void/delete/unvoid shared core |

## Gotchas
- **GRN Post-to-Stock is a cascade, not a label.** Crossing DRAFT/CONFIRMED→POSTED in `grn.ts` writes stock/WIP + `cost_ledger` AND flips the parent PO. Never write stock outside this boundary. `COMMITTED_STATUSES = {CONFIRMED,POSTED}`; POSTED is never born before arrival = ARRIVED (gate structurally honoured).
- **POSTED GRN lines are editable via compensating cascade** (owner 2026-06-22). Edit Quantities posts only the DELTA (`buildPostedGRNStockAdjustment`); `invoiced_qty` untouched, status stays POSTED. Blocked when `newAccepted < invoiced_qty` (already billed) or lines added/removed. Edit-then-revert is a true no-op. Un-post / line-restructure still 409.
- **PI editable in DRAFT *and* APPROVED** (owner 2026-06-22), NOT PAID/CANCELLED. An APPROVED edit moves AP: it posts a GL CORRECTION for the delta against a fresh sourceId (`${id}:edit-${ts}`) — the ledger is append-only, never mutate existing legs. FE shows a Confirm dialog before saving an APPROVED edit.
- **No-Draft on manual create.** PO manual create POSTs `status:"CONFIRMED"`; PI manual → PENDING_APPROVAL; only OCR/scan (`ocrUsed`) → DRAFT. GRN status derives from ARRIVAL (local goods → born POSTED + posts at create; import in-transit → DRAFT, posts later when ARRIVED).
- **Convert-chain is per-line consumption-tracked** (mig 0182). Available = `quantity − receivedQty` (PO) / `accepted_qty − invoiced_qty` (GRN), exposed as `availableQty` (dual-keyed). A 2nd PI is allowed when qty remains — only the over-drawn line is rejected. Restore `invoiced_qty` on PI delete/replace/CANCEL and GRN un-post; `postGRNToStock` is NOT reversed by restores (availability only). GRN DELETE blocked while a non-CANCELLED PI references it.
- **Single-source pickers.** PO→GRN keys lines to ONE parent PO by `poItemIndex` (`grns.poId` single column), so one PO→one GRN, one GRN/PO→one PI. Multi-source consolidation needs schema work (follow-up).
- **Supplier pricing is effective-dated** (mig 0183). Binding stays one-row-per-supplier+material; a price change UPDATEs `price`+`effective_from` AND APPENDS a `price_histories` audit row (append-only). `effective_from` is in `column-rename-map.json`; legacy rows fall back to `price_valid_from`. Line autofill reads `supplier_material_bindings`, not a separate catalog; PI standalone excludes catalog autofill.
- **PO receiving must go through GRN.** PO detail returns 412 + `requiresGrn` when a transition needs a GRN first — no direct PO status flip to received.
- **Three-Way-Match variance is derived**, not persisted (panel `detail.tsx:1349` + standalone `three-way-match.ts`). Don't store a second copy.
- **Money = integer sen** (`amountSen`, `unit_cost_sen`); use `MoneyInput`/`roundSen`, never float RM.
- **Migrations are inert** unless self-applied at runtime (`ensurePendingMigrations`/`ensureGrnMigrations`/`ensurePiMigrations` — `ALTER … ADD COLUMN IF NOT EXISTS`). **New columns = snake_case** + a `column-rename-map.json` entry or the route silently 400s; read dual-keyed `r.camelCase ?? r.snake_case`.
- **OCR (`scan-supplier.ts`) is a catalog-snap back-door** — verify status-snap before trusting OCR-written prices.

## Common tasks (mini-playbook)
- **Add a field to a PO/GRN/PI** → snake_case column + runtime `ALTER … ADD COLUMN IF NOT EXISTS` in the route's `ensure*Migrations` before the first write; add a `column-rename-map.json` entry; persist in POST/PUT; surface in the `rowTo*` mapper; render in the page. Read dual-keyed.
- **Change the receive/stock cascade** → edit `postGRNToStock` (`grn.ts:521`) + `cascadePOStatusAfterGRNPost` (`:811`); keep `restorePOReceivedQtyForGRN` (`:992`) symmetric. Verify `tests/grn-arrival-state.test.mjs` + `tests/purchase-edit-cascade.test.mjs`.
- **Adjust a PI GL posting** → change legs in `buildPiApprovalLegs` (`pi-posting.ts:35`) / bucket mapping `mapPurchaseLinesToAccounts` (`purchase-invoices.ts:183`); post on the APPROVED transition AND create-as-APPROVED; never mutate existing ledger legs.
- **Touch the convert-chain** → guard in `checkConvertAvailability` (`convert-chain.ts:81`); keep `invoiced_qty`/`receivedQty` increment+restore paired. Verify `tests/convert-chain.test.mjs` + `tests/purchasing-convert-flow.test.mjs`.
- **Change supplier pricing** → binding CRUD in `supplier-materials.ts`; append audit via `price-history.ts`; render the log in `suppliers/detail.tsx`. Verify `tests/supplier-effective-pricing.test.mjs`.

## Related modules
[[sales]] [[accounting]] [[inventory]] [[production]] [[delivery]]
