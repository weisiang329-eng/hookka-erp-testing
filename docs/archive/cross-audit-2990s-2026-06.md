> **ARCHIVED — HISTORY ONLY. Last had current content 2026-06-19; archived 2026-07-23.**
> This describes work that is finished or a system that has since changed. Its file
> paths, line numbers, counts and open items are as of the date above and were NOT
> re-verified. **Do not use it to decide what the code does today** — read the code, or
> `docs/CODEBASE-MAP.md`. Banner added 2026-08-13; see `docs/archive/README.md`.

# Cross-audit — learning from the 2990s (Houzs) ERP bug history

**Date:** 2026-06-18
**Reference system:** `github.com/wenwei4046/2990s` (sibling ERP — same React + Hono/Workers + Postgres family).
**Method:** Read the full 2990s `docs/BUG-HISTORY.md` (~30 incidents) + `docs/known-issues/` + `docs/audit/`, distilled into 18 bug *classes*, then audited Hookka ERP for each (6 read-only audit passes). Every verdict below cites real Hookka code.

## Headline

Hookka is **markedly more defended** than 2990s. The biggest 2990s clusters — cancel/reopen double-applying ledger effects, reversal movements dropping cost/batch, allocation keyed to the wrong thing, service-fee lines miscategorised, FormData uploads broken by a fetch wrapper, `SELECT *` view drift, under-gated write routes — are **structurally absent or already correctly guarded here** (cited below). The real gaps cluster in **Purchasing** (PO / PO→PI / GRN edit paths), a couple of **frontend edit pages**, and **data hygiene** (early-morning dates, runtime-only tables).

---

## Confirmed findings (ranked)

### P1 / HIGH — money or data loss

1. **PO→PI "Create Invoice" can double-bill the supplier.** `createInvoiceFromPo` (`src/pages/procurement/detail.tsx:518`) copies every PO line at full qty and POSTs to `/api/purchase-invoices`; the button shows for any non-draft PO and isn't disabled when invoices already exist, and the backend (`src/api/routes/purchase-invoices.ts:434`) has no guard against an existing PI for that PO. Two clicks / a re-convert ⇒ two full-value DRAFT PIs ⇒ double AP liability. Price source is correct (supplier cost). **Fix:** reject in the PI POST when a non-CANCELLED PI exists for `purchaseOrderId`; disable the button when `relatedPis` is non-empty.

2. **Editing a SENT invoice's lines doesn't restate the ledger.** `invoices.ts` has two line-edit paths: the `priceEdits` path (`:1860`) correctly reverses + re-posts the GL; the `body.items` wholesale-replace path (`:1692-1755`) recomputes totals + customer outstanding **but never touches the GL**. Post at X → items-replace to Y → later void reverses Y against a GL posting of X ⇒ (X−Y) orphaned in revenue/AR. **Fix:** reject `body.items` when `status !== 'DRAFT'` (the `priceEdits` path already handles sent invoices).

3. **Mid-edit draft wipe on Sales / Consignment order edit.** `src/pages/sales/edit.tsx:534` and `src/pages/consignment/edit.tsx:302` re-seed *all* form state from the cached fetch result in a `useEffect` keyed on the response, with no dirty/hydrated guard. A background refetch (late mount fetch, a sibling tab's `invalidateCachePrefix`, cross-tab edit) silently discards in-progress edits. **Fix:** guard the seed (skip while dirty / seed once via a ref), as `PurchaseInvoiceDetail` already does.

### P2 — integrity / hardening

4. **Editing a POSTED GRN's lines desyncs the receipt from stock.** `grn.ts:656-768` replaces `grn_items` + recomputes `totalAmount` on any status with no edit-lock; `rm_batches`/`cost_ledger`/`balanceQty` stay at the original values (post is idempotent) ⇒ the GRN record drifts from committed inventory. **Fix:** gate the `body.items` branch to `status === 'DRAFT'`.

5. **Editing a PO after goods are received.** `purchase-orders.ts:357-516` PUT has no edit-lock: `supplierId` + items are mutable after a GRN posted `rm_batches`/`cost_ledger` against the original supplier/prices, and the items-replace re-reads `receivedQty` from the body (default 0), so it can silently zero `receivedQty`. **Fix:** add a `checkPurchaseOrderLocked` (a POSTED/CONFIRMED GRN exists ⇒ lock supplier + items), mirroring the DO/Invoice lock pattern.

6. **PO line inputs accept garbage / negatives.** `purchase-orders.ts:233-234` uses `Number(item.quantity) || 0` / `Number(item.unitPriceSen) || 0` — no NaN reject, no negative clamp — flowing verbatim into `totalSen` and integer columns. Inconsistent with the PI path, which validates (`normalizeItems`, `purchase-invoices.ts:274`). **Fix:** reuse a `normalizeItems`-style `Number.isFinite` + `>= 0` rejection (422).

7. **Credit Note re-issue double-credits A/R + invoice total (API-only today).** `credit-notes.ts` PUT (`:471`) has no transition matrix; the A/R reduction (`:540`) and `buildInvoiceCascadeForCN` (`:124`) fire on every transition into "issued" with no idempotency guard (the GL leg *is* guarded), so `APPROVED→DRAFT→APPROVED` subtracts the CN amount twice and drifts the subledger off the GL. No UI path exists today, but the backend lacks the guard. **Fix:** transition matrix (make issued terminal) or idempotency-claim the A/R + invoice cascade.

8. **After GRN "Post to Stock", inventory screens show stale numbers.** `src/pages/procurement/grn-detail.tsx:100` invalidates only `/api/grn`, though the post writes `raw_materials.balanceQty` (`grn.ts:336`). Inventory / Stock Value / raw-materials keep serving stale on-hand until TTL. **Fix:** also `invalidateCachePrefix` `/api/raw-materials`, `/api/inventory`, `/api/stock-value` (as `inventory/adjustments.tsx:369` already does).

### MED — correctness / hygiene

9. **Early-morning (pre-08:00 MYT) "today" defaults save as yesterday.** ~15 write-path sites use UTC `new Date().toISOString().slice(0,10)`; worst: `production/index.tsx:3225` `completedDate`, `procurement/pricing.tsx:298` `priceValidFrom`, `employees.tsx:2318` `effectiveFrom`, `worker/scan.tsx:479`, `rd/detail.tsx` issuances, `service-cases/detail.tsx:2324,2702`. The +8h fix already exists at `employees.tsx:10519`. **Fix:** a shared `todayYmdMY()` helper.

10. **FG stock adjustment is broken / dead.** UI passes the product id (`adjustments.tsx:317`) but the backend looks it up as a batch id (`stock-adjustments.ts:283`), and `fg_batches` isn't the FG system-of-record anyway. **Fix:** repoint to the real FG grain or remove the FG option until one exists.

11. **7 tables exist only via runtime `CREATE TABLE IF NOT EXISTS`, absent from `migrations-postgres/`** — Mail Center suite, `production_folders`, `folder_job_cards`, `supplier_scan_samples`, `wip_cascade_log`. A fresh rebuild wouldn't have them. **Fix:** add catch-up migrations.

### LOW / cosmetic

12. Raw ISO timestamps on a few screens: `_DepartmentSchedulePage.tsx` `{generatedAt}`, `planning/index.tsx:2962` `{ltSavedAt}`, `employees.tsx:2874` `{resignedAt}`. Wrap in the date formatter.
13. **Consignment create lacks the idempotency key** sales/create has (`consignment/create.tsx:799`; route not `withIdempotency`) — a dropped-response retry can duplicate a CO.
14. Stale runtime camelCase `ADD COLUMN` lines re-creating phantom dup columns post-0110-rename (`distributedAt`, `ocrPromptRules`, `isGold`, `customerPOImageB64`); dead `src/api/lib/authz.ts` (0 importers); `sql-write-column-coverage` CI guard doesn't cover `ALTER ADD COLUMN` or finance.
15. `poReadyForDelivery`/`poInPlanning` (`delivery-pipeline.ts:65,83`) don't exclude `ON_HOLD` — a completed-then-held PO still reads "ready for delivery" (near-unreachable).
16. No shared `MoneyInput`; ~12 `value={sen/100}` inputs can't clear-to-blank (cosmetic — all `type="number"`, so the keystroke-eating variant is absent).

---

## Confirmed NOT-PRESENT in Hookka (we already do these right)

- **Cancel/reopen double-apply** (2990s' #1/#2): invoices/SO/DO/PO/stock-adjustments all use explicit transition matrices with terminal `CANCELLED: []` and idempotent void/contra (`invoices.ts:285,2124`; `sales-orders.ts:814`; `delivery-orders.ts:66`; stock adjustments append-only).
- **Reversal drops cost/batch** (B3): every FIFO reversal carries `batchId` + `unitCostSen` (`stock-adjustments.ts:319`, `do-cost-cascade.ts:128`); no AFTER-INSERT trigger / `RETURNING cost` footgun (no triggers exist).
- **Unscoped nested item delete** (B7): no `/:itemId` routes exist; every child delete is parent-scoped.
- **Allocation keyed to provenance / two engines disagree** (C1-C3): make-to-order; readiness has one owner; pipeline predicates consolidated in `delivery-pipeline.ts` + `so-status.ts`.
- **Service/fee-line miscategorisation** (G1/G2): no SERVICE line category, no per-line discount field exists.
- **FormData upload broken by fetch wrapper** (A1): the global interceptor (`api-client.ts:58`) never sets Content-Type, only adds CSRF.
- **`SELECT *` view drift** (E1): no SQL views in the live schema (dashboard MVs dropped in 0123).
- **Under-gated write routes / SUPER_ADMIN lockout** (Z2): every ungated write is auth-domain/public-by-design; SUPER_ADMIN is an unconditional allow.
- **Chinese in office UI** (D3): all CJK is comments / the deliberate worker-portal i18n dict / OCR match data.
- **DataGrid popover-scroll close & defaultHidden reveal** (F1/F5): correctly handled in `data-grid.tsx`.

---

## Recommended fix order

1. **Now (clear, pure-hardening guards, ship to prod):** #1 PO→PI double-bill, #2 invoice body.items lock, #4 GRN POSTED lock, #5 PO post-GRN lock, #6 PO input validation, #8 GRN cache invalidation.
2. **Next (needs a small design choice):** #3 draft-wipe guard (confirm the guard approach), #7 credit-note idempotency, #10 FG adjustment (repoint vs remove), #9 date helper sweep.
3. **Hygiene (batch):** #11 catch-up migrations, #12 cosmetic dates, #13 consignment idempotency, #14 dead code + CI guard, #15 ON_HOLD chip.
