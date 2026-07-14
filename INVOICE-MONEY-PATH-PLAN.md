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

## Task 2 — SO price backfill
- [ ] Identify SOs with missing/zero line prices (EXCLUDING legit service/replacement SV orders).
- [ ] Find the price source ("根据我的价钱"): customer_product_prices / product_prices catalog.
- [ ] Propose backfill rule (customer-specific price first, else list price) → confirm → execute.

## Task 3 — Cancel / Edit / CN flow verification
- [ ] Verify end-to-end: cancel an invoice, edit (price-edit on SENT), issue a CN — all correct
      (GL, AR, payments consistent).

## Guardrails
- Every money mutation: propose numbers → owner confirms → execute → verify → log BUG-HISTORY.
- Prod scope check BEFORE any cleanup (staging ≠ prod data).
