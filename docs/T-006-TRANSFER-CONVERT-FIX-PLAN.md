# T-006 — Transfer / Convert foundation: fix plan

> **Last verified: 2026-09-10** against HEAD `e40d5550` (branch `fix/transfer-convert-duplicate-guard`,
> forked from `origin/main`). All 10 PRD findings independently re-confirmed against current source —
> see file:line citations per requirement below. Source PDF: `T-006-Hookka-transfer-convert - wei siang.pdf`
> (not in repo, user's local Downloads). Nothing in this doc has been implemented yet — plan only.

## Why this exists

May 2026: 13 duplicate Delivery Orders shipped the same production orders, double-consuming
RM 24,647 of stock cost. The guard added afterward only covers the DO create path that sends
`productionOrderIds` — one live UI entry point (Sales page "Transfer to Delivery Order") never
sends them, so it still bypasses the guard entirely today. The same *shape* of bug (check-then-write,
no DB backstop, per-document instead of cumulative) recurs independently on the purchasing side,
in returns, and in consignment. This plan fixes the instance in front of us for R1, but treats R1-R9
as one class per [BUG-CLASSES.md](BUG-CLASSES.md)'s own opening lesson: fix every open row, not just
the one that hurt someone.

## Severity / requirement map

| Req | PRD finding # | Severity | One-line fix |
|---|---|---|---|
| R1 | 1 | P1 | Sales page sends `productionOrderIds`; server refuses SO-linked DO with none |
| R2 | 2 | P1 | Over-receipt check sums across ALL posted GRNs for the PO line, not just this document |
| R3 | 3 | P1 | GRN create becomes one batch (header+lines+stock+PO counter) |
| R4 | 4 | P1 | Voiding a CN-sourced invoice clears `convertedInvoiceId` and reverts CN status |
| R5 | 5 | P1 | DB CHECK on `grn_items.invoiced_qty`, mirroring the sales-side `chk_doi_invoiced_qty` |
| R6 | 6 | P2 | Purchase return writes back `invoiced_qty`/`receivedQty`, caps at source line, rejects dup |
| R7 | 7 | P2 | Delivery return validates qty against DO line + prior returns; cancel-after-restock reverses |
| R8 | 8 | P2 | **Do NOT touch `material_code`** — ceiling matches by `po_item_id` instead (see below) |
| R9 | 9 | P2 | Line-level-only PO ids get the same ceiling check as header/GRN-level |
| R10 | 3 | P3 | `withIdempotency` wrapped on DO/GRN/PI create, CN convert, both returns |

---

## R1 — SO→DO transfer bypasses the duplicate-delivery guard

**Confirmed at:** `src/pages/sales/index.tsx:1881-1900`, `src/api/routes/delivery-orders/_helpers.ts:2256-2337`.

The Sales page's "Transfer to Delivery Order" dialog builds `mappedItems` with no
`productionOrderId`, and the POST body carries only `salesOrderId` + `items` — no
`productionOrderIds` array. `validateDoComposition` (the once-only-delivery guard,
`_helpers.ts:2094-2221`) only runs `if (productionOrderIds.length > 0)`
(`_helpers.ts:2263`). This request never enters that block, so the guard never runs —
the exact bug class that caused the May duplicate-DO incident, on a second entry point
the original fix never reached.

**Fix:**
1. `pages/sales/index.tsx`: the transfer dialog already has the SO's production orders
   loaded (it's how it lists `transferDORow.items`) — thread `productionOrderId` through
   `mappedItems`, and add a top-level `productionOrderIds` array to the POST body.
2. `_helpers.ts` create path: add a server-side refusal — if `body.salesOrderId` is
   present but `productionOrderIds` is empty, reject with 400 rather than silently
   falling through to the no-guard path. This is the actual backstop: even if a future
   caller repeats today's frontend mistake, the server won't accept it.
3. Do NOT weaken this to "guard runs only when ids present" — that's the current (broken)
   behavior. The new rule is: an SO-linked DO with no production-order ids is refused,
   full stop.

**Risk:** the edit/PUT path (`_helpers.ts:4631`) already sends `productionOrderIds`
correctly per the investigation — only the CREATE path from this one screen is broken.
Low blast radius.

**⚠ Found while implementing R1, NOT fixed, logged for later:** the identical bug
(hand-built `items`, no `productionOrderIds`, `salesOrderId` sent — here actually a
mislabeled Consignment Order id) exists in `src/pages/consignment/index.tsx`'s own
"Transfer to Delivery Order" button (~line 1094-1103). R1's new server-side refusal
(`salesOrderId` + zero `productionOrderIds` → 400) means this button now fails on
every click, where before it silently succeeded.

This is very likely CORRECT fail, not a regression: `_helpers.ts:2282-2299` already
has a belt-and-braces guard rejecting any production order carrying a
`consignmentOrderId` from ever reaching a Delivery Order at all ("Consignment-Order
POs cannot be added to a Delivery Order. Use a Consignment Note instead") — and its
own comment says the *working* Delivery page's picker already hides CO-linked POs
from selection. Since every PO under a Consignment Order carries `consignmentOrderId`,
this button could never have legitimately succeeded even before R1 — it only "worked"
by sneaking past the same guard-bypass loophole R1 just closed globally.

The proper path already exists: `/consignment/note` (`src/pages/consignment/note.tsx`,
routed at `dashboard-routes.tsx:544`) is a dedicated page for turning a consignment
order's production orders into a Consignment Note (R4's territory), which is what
should follow this button, not a raw DO create. Options for whoever picks this up:
(a) investigate real usage and redirect the button to `/consignment/note`, (b) disable
it with a message pointing there, (c) remove it outright if provably dead. Not
attempted here — kept in scope for R1/R4 only, this is a sibling finding.

## R2 — GRN over-receipt checked per-document, not cumulatively

**Confirmed at:** `src/api/routes/grn.ts:1538-1549`.

```ts
const tolerance = poItem.quantity * 1.1;
if (item.receivedQty > tolerance) { ... }
```
`tolerance` is 110% of the PO line's *ordered* qty, compared against *this document's*
`receivedQty` only. Two 100-unit GRNs against a 100-unit line each individually read
`100 ≤ 110` and both post.

**Fix:** before this comparison, sum `purchase_order_items.receivedQty` (the
already-posted cumulative total, read inside the same transaction/batch per R3) plus
this document's incoming `item.receivedQty`, and compare THAT sum against the 110%
ceiling. Read must happen inside the same atomic unit as R3's combined batch — a
separate pre-check-then-later-write reopens the exact race R5's CHECK constraint is
there to close.

## R3 — GRN create is three non-atomic batches

**Confirmed at:** `grn.ts:1716` (header+lines batch), `:1759`→`postGRNToStock` (`:653`,
stock batch), `:1760`→`cascadePOStatusAfterGRNPost` (`:843`, PO counter batch).

**Fix:** collect ALL prepared statements — header+lines, stock (`rm_batches`/
`cost_ledger`/`balanceQty`), and the PO counter update — into ONE array and ONE
`db.batch()` call. `postGRNToStock` and `cascadePOStatusAfterGRNPost` need to change
from "build statements AND execute them" to "return statements for the caller to
execute" — same refactor shape as this session's `buildAuditStatement` vs `emitAudit`
split in `src/api/lib/audit.ts`. If true atomicity across all three groups can't be done
in one `db.batch()` call (verify Hyperdrive/postgres.js batch semantics support this
many statements), fall back to R3's PRD-offered alternative: a compensating rollback +
retry queue — but attempt single-batch first, it's simpler and this repo already has the
pattern.

**Test (A3):** kill the connection between what are currently batch 1 and batch 2/3 (or
simulate via a thrown error injected after the header insert) and assert no GRN row
exists with `status='POSTED'` and zero matching `rm_batches` rows.

## R4 — Voiding a CN-sourced invoice never releases the consignment note

**Confirmed at:** `consignment-notes.ts:1578-1629` (invoice created with
`deliveryOrderId: null`), `delivery-orders/_helpers.ts:804-817`
(`buildInvoiceDeathReleaseStatements` returns `[]` when `deliveryOrderId` is falsy),
`invoices.ts:3241-3253` (void handler only calls that DO-shaped release function).

**Fix:** `buildInvoiceDeathReleaseStatements` needs a consignment-note branch, OR
(cleaner) the void handler in `invoices.ts` needs a second release call:
1. Read `consignment_notes` for a row where `convertedInvoiceId = <this invoice id>`.
2. If found: `UPDATE consignment_notes SET status = <previous status>, convertedInvoiceId = NULL WHERE id = ?`.
3. "Previous status" — per migration/status-machine, this is almost certainly
   `DELIVERED` or whatever status precedes `FULLY_SOLD` in the CN lifecycle; confirm the
   exact prior-state value from `consignment-notes.ts`'s own status transitions before
   hardcoding it (don't guess).

**Test (A4):** convert CN → invoice → void invoice → assert CN status reverted and CN
now appears again in the convert-eligible list.

## R5 — No DB backstop on GRN→PI / PO→PI ceilings

**Confirmed at:** `purchase-invoices.ts:1321-1385` (pure application-level
check-then-write), `migrations-postgres/0182_convert_chain_tracking.sql` (adds
`grn_items.invoiced_qty` etc, no CHECK), vs. the sales-side
`migrations-postgres/0214_do_partial_invoice.sql:47-49`
(`CHECK (invoiced_qty >= 0 AND invoiced_qty <= quantity)` on `delivery_order_items`).

**Fix:**
1. New migration: `ALTER TABLE grn_items ADD CONSTRAINT chk_grn_invoiced_qty CHECK (invoiced_qty >= 0 AND invoiced_qty <= accepted_qty)` (confirm the exact accepted-quantity column name — the PRD says `accepted`, verify against `grn_items`' actual schema before writing the migration).
2. Runtime self-apply per CLAUDE.md's non-negotiable rule — migration files are inert in
   prod; add the `ALTER TABLE ... ADD CONSTRAINT IF NOT EXISTS`-equivalent (Postgres has
   no `IF NOT EXISTS` for constraints — wrap in a `DO $$ ... EXCEPTION WHEN duplicate_object
   THEN NULL; END $$` guard, or check `information_schema.constraint_column_usage` first)
   at the top of the PI create route, same pattern as `ensureProductCreatedAtColumn`.
3. The application-level `checkPoRemaining`/`checkConvertAvailability` checks STAY — the
   CHECK constraint is the last-line backstop for the race, not a replacement for the
   user-facing error message. Catch the constraint-violation error code and translate it
   to the same 409 the app-level check already returns, so a raced-past request still
   gets a clean error instead of a raw Postgres exception.

**Test (A5):** two concurrent PI creates against the same GRN line — assert exactly one
succeeds and the other gets 409 (from either the app check or the constraint, doesn't
matter which wins the race, only that no second row commits).

## R6 — Purchase return doesn't write back to GRN/PO, no dup detection

**Confirmed at:** `purchase-return-create.ts:449-512` — writes only `purchase_returns`/
`purchase_return_items`; `grn_items` appears only as a `SELECT` (line 176), never
`UPDATE`; `purchase_order_items` doesn't appear in the file at all; no existing-return
lookup before insert.

**Fix:**
1. In `createPurchaseReturn`, after inserting `purchase_return_items`, add statements to
   the same batch: `UPDATE grn_items SET invoiced_qty = invoiced_qty - ? WHERE id = ?`
   and `UPDATE purchase_order_items SET receivedQty = receivedQty - ? WHERE id = ?`,
   using the GRN-item/PO-item ids already resolvable from `loadGrnItemsForReturn`.
   Clamp at 0 (never go negative — mirrors R5's constraint direction).
2. Duplicate detection: before insert, sum existing `purchase_return_items.quantity` for
   the same source line (grn item / PO item) and reject if `existing + new > original
   received/invoiced qty`. This is the R6 "capped by the source line" requirement — same
   shape as R7's delivery-return cap below, so share logic if practical.

**Test (A6):** return 5 units → assert both the GRN line and the PO line's counters drop
by 5.

## R7 — Delivery return: no qty cap, no dup detection, cancel-after-restock doesn't reverse

**Confirmed at:** `delivery-return-create.ts:382` (quantity taken as-is, no cap check),
`delivery-orders/_helpers.ts:1445-1472` (whole-line exclusion by `productionOrderId`
set-membership, not by quantity), `delivery-returns.ts:459-483` (cancel block-list omits
`RETURNED_TO_STOCK`).

**Fix:**
1. **Cap + dup guard** (`delivery-return-create.ts`): before insert, look up the DO
   line's `quantity` and sum prior non-cancelled returns against the same
   `production_order_id`; reject if `priorReturned + thisReturn > doLineQty`.
2. **Partial exclusion, not whole-line** (`_helpers.ts:1445-1472`): replace the
   `Set<productionOrderId>` membership filter with a quantity-aware one — track
   `returnedQtyByPoId: Map<string, number>` instead of a Set, and when building
   `activeDoItems`, reduce that line's invoiceable quantity by the returned amount
   rather than dropping the whole line. This is the change that makes A7 ("return 1 of 3
   leaves 2 invoiceable") pass — today it leaves 0.
3. **Cancel must reverse restock** (`delivery-returns.ts:459-483`): add
   `RETURNED_TO_STOCK` to the refused-status list (simplest, matches the PRD's "or is
   refused" option) OR implement the reversal (re-run
   `buildReturnToStockStatements`'s inverse against `fg_batches`/`cost_ledger`). Given
   R3/R5's pattern of preferring correctness over convenience, and that a reversal
   implementation risks its own double-reversal bugs, **recommend refusing cancel after
   restock** for this pass — reversal can be a follow-up if the business actually needs
   it, per PRD wording itself ("or is refused").

**Test (A7):** DO line qty 3, return 1, assert invoiceable qty is 2 (not 0, not 3).

## R8 — PO-sourced GRN lines have blank `material_code` (BUG-2026-08-13-052)

**⚠ The PRD's literal wording ("fix the empty material_code") is the exact fix this repo
has already investigated in depth and explicitly rejected — see
[BUG-HISTORY.md#BUG-2026-08-13-052](BUG-HISTORY.md). Filling `material_code` changes
what `resolveRmForGRNItem` resolves stock postings against (risk: silently posts
`rm_batches`/`cost_ledger` to the WRONG raw material) and breaks
`three-way-match.ts`'s reconciliation bucketing, because the PO side's `deriveMatCode`
call reads the same dead key and the two sides currently only agree because both are
broken identically. That entry says outright: "owner-facing decision on a stock +
reconciliation surface, not a dual-key repair." Do not attempt it as part of this ticket.**

**What R8 actually needs:** the PO ceiling in `checkPoRemaining` to apply to PO-sourced
GRN lines. It does not need `material_code` filled — it needs a reliable line-to-line
match, and one already exists and is already used safely elsewhere:

`grn.ts:899-955` resolves every GRN line to its PO line via `po_item_id` (an explicit FK,
with a positional fallback only for legacy rows predating the column) — this is exactly
how `cascadePOStatusAfterGRNPost` already draws down `purchase_order_items.receivedQty`
correctly, without touching `material_code` at all.

**Fix:** change `checkPoRemaining` (`purchase-invoices.ts:1012-1039`) to match by
`po_item_id` (via `grn_items.po_item_id`, reached through
`purchase_invoice_items.grn_item_id` for GRN-sourced lines) instead of `materialCode`.
For PO-sourced-direct PI lines with no GRN, use the line's own `po_item_id`/`poId` if
present (already read at `purchase-invoices.ts:1542-1546`). Fall back to the current
material_code match ONLY for whatever legacy/manual-line case still needs it (verify
there is one before keeping the fallback — don't keep dead code).

**Test:** GRN line sourced from a PO with blank `material_code` (today's normal case) —
assert the PO ceiling now actually rejects an over-limit invoice against it (currently
silently skipped, per finding 8's `continue` at line 1033/1039).

## R9 — Line-level-only PO id skips ceiling entirely

**Confirmed at:** `purchase-invoices.ts:1256` (`if (body.grnId)`), `:1360`
(`else if (body.purchaseOrderId ...)`) — no third branch — and `:1542-1546` (the
INSERT still stores `r.poId` regardless, so it's counted against the PO on the NEXT
invoice's ceiling check even though THIS invoice was never checked).

**Fix:** add the missing branch — when neither `body.grnId` nor
`body.purchaseOrderId` is set but `normalizedItems.rows` carry per-line `poId`s, group
by PO id (same `byPo` pattern already used at line 1352/1377) and run
`checkPoRemaining` against those groups too. This closes the gap without touching the
two existing branches — purely additive.

**Test:** create a PI with only line-level `poId`s exceeding the PO's remaining budget —
assert it's now rejected, where today it silently succeeds.

## R10 — Idempotency not applied to DO/GRN/PI create, CN convert, returns

**Confirmed absent** (zero `withIdempotency`/`readIdempotencyKey` matches) in:
`delivery-orders.ts`/`_helpers.ts` (DO create), `grn.ts` (GRN create),
`purchase-invoices.ts` (PI create), `consignment-notes.ts` (CN convert),
`delivery-returns.ts`, `purchase-returns.ts`. Present and working in 6 other route files
(`sales-orders.ts` is the closest analog to copy from).

**Fix:** wrap each of the 6 create/convert handlers the same way
`sales-orders.ts:1726-1729` does — `readIdempotencyKey(c)` +
`withIdempotency(c, "<resource>", key, async () => { ...existing handler body... })`.
Mechanical, low-risk, do this LAST (after R1-R9 land) since it's wrapping, not changing,
the handler logic — wrapping first would mean re-touching every one of these files twice.

---

## Suggested sequencing

1. **R5 first** (the DB CHECK constraint) — it's the cheapest, most durable backstop and
   makes every other purchasing fix safer to land incrementally, same as how the
   sales-side constraint already protects DO/invoice.
2. **R1, R2, R3 together** (all touch the DO/GRN create paths, P1, same blast-radius
   class as the May incident) — these are the ones with a dollar figure attached.
3. **R4** (CN void) — isolated, no dependency on the above.
4. **R8, R9** (purchasing ceiling correctness) — depend conceptually on R5 being in place
   first (the constraint is the safety net while the application logic is being changed).
5. **R6, R7** (returns) — can be done in parallel with 4/step, independent of the create-path work.
6. **R10 last** — pure wrapping, touch each file once at the very end.

## Before implementing — needs owner input

- **R4**: exact prior CN status to revert to on void (not guessed here — read the CN
  status machine in full before hardcoding).
- **R7 cancel-after-restock**: confirmed recommending "refuse" over "reverse" — flag this
  choice to the owner explicitly, it changes user-facing behavior (a return that reaches
  `RETURNED_TO_STOCK` becomes permanently non-cancellable rather than reversible).
- **R5's exact column name** for the "accepted" quantity ceiling — verify against
  `grn_items`' live schema, the PRD's own wording ("0 ≤ invoiced ≤ accepted") uses a name
  not directly confirmed against source in this pass.
- **R8**: this plan's approach (match by `po_item_id`, leave `material_code` alone) is a
  deliberate deviation from the PRD's literal R8 wording — flag to Mr Lim / whoever wrote
  the PRD before implementing, in case the material_code fill was wanted for a reason
  beyond the ceiling (e.g. GRN PDF display, which BUG-2026-08-13-052 notes is also
  currently blank) — that display concern is explicitly NOT fixed by this plan's R8
  approach and would need its own, separately-scoped decision.
