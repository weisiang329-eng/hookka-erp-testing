> **ARCHIVED / SUPERSEDED — Task 1 shipped 2026-07-23, guard rewritten 2026-08-07.** The
> double-invoice race this plan chases was closed by migration `0208`'s partial unique index
> `uniq_invoice_active_delivery_order`, and the rule then deliberately CHANGED (one DO may now
> be billed by several invoices — owner ruling). The current guard and its history are pinned
> by `tests/invoice-dedupe-guard.test.mjs`; read that, not this. Task 2's code bug shipped as
> `7e4ed1ad`. The RM figures here are staging counts from July and must not be quoted as prod.
> Kept for history only. Verified 2026-08-13 against `tests/invoice-dedupe-guard.test.mjs`.

# Invoice Money-Path — dedicated fix (branch: fix/invoice-money-path, off main)

Owner-reported money bugs. Money-sensitive → **investigate → propose → confirm → execute**.
Do NOT run any money mutation (cancel invoice, set price) without owner sign-off.

## Findings so far (measured on staging, 341 invoices)
- **Double invoicing: 64 DOs invoiced 2–4× each → 77 extra duplicate invoices → ~RM 404,819 excess.**
  Status mix incl. 21 PAID + 2 PARTIAL among dup DOs (⚠ cannot blind-cancel paid ones).
  42 already CANCELLED (someone has been cleaning up manually).
  MUST re-check on PROD (staging may hold test/import residue).
- **Zero-amount invoices (11) = mostly LEGIT service orders (SV-*, free by design)** — NOT the
  "SO didn't capture price" bug. Confirmed by tracing INV-2607-048 → SV-2607-010.

## Task 1 — Double invoices
- [ ] Root cause: why does the create-invoice guard (only DELIVERED DO → invoice, then flip to
      INVOICED) let duplicates through? (race? auto-invoice + manual? resolve-incomplete path?
      historical pre-guard data?) — read invoices.ts POST + auto-invoice-on-delivery path.
- [ ] Confirm whether CURRENT code still creates new duplicates (vs historical only).
- [ ] FIX the guard (block invoicing a DO that already has a non-cancelled invoice) — atomic.
- [ ] CLEANUP plan for the 77 existing duplicates: per-case (SENT → cancel; PAID → CN/refund?)
      — propose to owner, do NOT auto-execute. Verify prod scope first.

## Task 2 — SO price backfill (effective-date re-price of OLD orders)
DONE this session — the CODE bug: `fix(sales): include totalHeightPriceSen` (7e4ed1ad).
Server unit-price recompute (POST+PUT) dropped `totalHeightPriceSen` → under-billed.
PRICE AUDIT CONFIRMED: exactly 5 components (base, divan, leg, totalHeight, special/drawer);
after the fix ALL are included. seatHeight folds into base; modular sofa = 1 line/module.
Only totalHeight was the gap. Drawer rides specialOrderPriceSen (already billed).

Backfill of EXISTING under-billed orders (owner asked, "根据 effective date"):
- [ ] Build `POST /api/admin/backfill-so-prices?dryRun=1` (SUPER_ADMIN). For each sales_order_items
      line: re-derive totalHeightPriceSen from its height config (divanHeightInches + legHeightInches
      + gapInches → total height label → kv_config maintenance `totalHeights[label].priceSen`) — this
      is what the FE `calcTotalHeightSurcharge` does. Recompute correct unit =
      base + divan + leg + totalHeight + special. base uses `resolveCustomerPriceAsOf(product,
      customer, SO date)` = the EFFECTIVE-DATED customer price (owner's requirement).
- [ ] Affected = stored unitPriceSen < recomputed. dryRun reports (line, old, new, delta, SO date).
- [ ] EXECUTION updates sales_order_items.unitPriceSen/lineTotalSen + cascades to DO + invoice.
- [ ] ⚠ ALREADY-SENT invoices: owner decision — (a) only fix DRAFT/un-invoiced, sent ones get a
      difference CN; OR (b) re-price all + issue diff CN for the delta. Do NOT auto-touch sent
      invoices without the owner's per-case call.

## Task 2b — Dedupe tool (prod one-click for the duplicate cleanup)
Staging already cleaned (35 cancelled, verified 100% dup: items match DO). For PROD:
- [ ] Build `POST /api/admin/dedupe-invoices?dryRun=1` (SUPER_ADMIN). Group non-cancelled invoices
      by deliveryOrderId; a group of ≥2 = candidates. Verify 100% dup (same item signature +
      itemCount == DO itemCount). Keep 1 (paid one if any, else earliest); the rest are extras.
- [ ] Only CANCEL (status→CANCELLED, GL-void) the UNPAID extras — REUSE the existing invoice-cancel
      path (extract the PUT :id CANCELLED branch into a shared `cancelInvoice(db,id)` so GL void +
      hidden legs + DO status are identical; do NOT re-implement GL). Report paid extras, never
      auto-cancel them.
- [ ] dryRun reports the full plan (DO, keep, cancel[], amounts). Owner runs execute on prod.
- [ ] After cleanup: add the UNIQUE partial index invoices(deliveryOrderId) WHERE status!='CANCELLED'
      (belt-and-suspenders; can only be created once dups are gone).

BOTH tools: money + GL critical. Build CAREFULLY (fresh/focused), dry-run first, owner confirms
numbers before execute, verify byte-identical on staging, then owner runs on prod.

## Task 3 — Cancel / Edit / CN flow verification
- [ ] Verify end-to-end: cancel an invoice, edit (price-edit on SENT), issue a CN — all correct
      (GL, AR, payments consistent).

## Guardrails
- Every money mutation: propose numbers → owner confirms → execute → verify → log BUG-HISTORY.
- Prod scope check BEFORE any cleanup (staging ≠ prod data).
