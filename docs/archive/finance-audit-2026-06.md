> **ARCHIVED — HISTORY ONLY. Last had current content 2026-06-28; archived 2026-07-23.**
> This describes work that is finished or a system that has since changed. Its file
> paths, line numbers, counts and open items are as of the date above and were NOT
> re-verified. **Do not use it to decide what the code does today** — read the code, or
> `docs/CODEBASE-MAP.md`. Banner added 2026-08-13; see `docs/archive/README.md`.

# Finance module audit — 2026-06-28 (read-only; findings, nothing changed)

Three parallel read-only audits: **GL/accounting engine**, **AR (sales invoices + receipts)**, **AP (purchase invoices + supplier payments + CN/DN + cost ledger)**.

**Verdict:** the finance core is in good shape. Append-only ledger intact, double-entry balances on every posting path traced, money is integer sen throughout. **No active money-loss bug.** Most findings are *latent* (the front-end currently protects the gap, or the trigger condition — GST rate, 2nd org — isn't on yet).

## 🔴 CRITICAL (1 — latent today)
1. **Customer receipt `amount` not reconciled to its allocations** — `payments.ts:432-833`. GL bank/debtor leg posts `amount`; invoice `paidAmount` + `customers.outstandingSen` move by `sum(allocations)`; **no check `amount === Σallocations`**. FE always sends them equal (latent), but the backend money invariant is unguarded → a mismatch permanently diverges GL cash vs AR subledger. Fix: reject when unequal; compute the GL amount from the allocation total.

## 🟠 HIGH (3 — AR / tax, latent)
2. **e-invoice always submits tax = 0** — `e-invoices.ts:175-177`. Hardcodes `taxAmount=0`, `totalExcludingTax=gross`. The moment `kv_config.gst_rate_pct` is non-zero, MyInvois submissions under-report tax to LHDN. Fix: emit `taxSen`/`subtotalSen` from the invoice.
3. **Invoice editable after its e-invoice is submitted/VALID** — `invoices.ts` + `lock-helpers.ts:175`. `checkInvoiceLocked` only locks on payment, not e-invoice state → ERP invoice and the transmitted e-invoice silently diverge. Fix: block money edits once e-invoice SUBMITTED/VALID (or cancel+reissue).
4. **Edit-receipt (restate) has no overpayment guard** — `payments.ts:160-335` (`buildCustomerPaymentRestate`). POST rejects overpayment; the edit path does not → `paidAmount` can exceed `totalSen`, overpayment vanishes from AR. Fix: port the POST overpayment check into restate.

## 🟡 MEDIUM
5. **Invoice PUT `paidAmount` branch bypasses all payment controls** — `invoices.ts:1707-1724`. Writes a payment with no GL leg, no AR decrement, no overpayment guard. Latent/legacy (no current caller found). Fix: remove the branch (force receipts through `/api/payments`).
6. **APPROVED-PI line edit with unchanged total posts no GL reclass** — `purchase-invoices.ts:1468-1475`. Correction gated on header-total change; moving spend across material accounts at equal total drifts the P&L expense-account split (total + AP control stay correct). Fix: fire the reclass when the per-account delta is non-zero even if header delta is 0.
7. **GL report reads omit `orgId`** — `accounting.ts` (trial balance L1395, P&L L2172/L4020/L4930, BS L5775, GL tab L6088). Writes stamp orgId + the hash chain is per-org, but reports don't filter. Latent (single org); becomes CRITICAL if a 2nd org is provisioned (statements would merge all orgs). Fix: add `AND orgId = ?`.
8. **Customer DN POSTED subledger not independently re-entrancy-guarded** — `debit-notes.ts:335-341` (GL leg is `ledgerHasSource`-guarded; subledger bump relies on status flip). Theoretical concurrent double-PUT only.

## 🟢 LOW
- `/contra` (`accounting.ts:7231`) no source-id idempotency key — concurrent double-submit race (sequential retry safe).
- Cash-flow SST band 706 defaults to GENERAL_EXPENSE not TAXATION — display only (cash total anchored to bank legs).
- Customer CN has no clean void/reversal (`credit-notes.ts:503`) — correct a wrong CN only via an offsetting DN.
- e-invoice submit generates a new id each call (mock) — make idempotent for real MyInvois.
- Read-side orgId gaps on payment_vouchers list etc. (same single-org caveat).

## ✅ Confirmed CLEAN
- **Sales-invoice → revenue (the owner's question):** Dr AR(net+tax) / Cr Revenue by category (SOFA 500-0020 / BEDFRAME 500-0000 / ACCESSORY 500-0030, reconciled to subtotal) / Cr GST-output 350-0000. Tax excluded from revenue. Past sofa-misroute bug fixed (`itemsOverride`). Only an unexpected/blank product category would default revenue to the bedframe account.
- **GL append-only / hash chain** — nothing deletes/mutates posted legs; `hidden` flag excluded from the hash; voids = new opposite entry.
- **Double-entry balance** — every posting path balances (manual JV, year-close, opening balance, labor, depreciation, transfer, PV, contra, closing stock, invoices, PI, supplier-payment FX).
- **Money = integer sen**, largest-remainder rounding, no lost cents, no float money in posting paths.
- **AP** — over-pay, double-pay-retry, void/unvoid restore, invoiced_qty lifecycle, PI double-billing (convert-chain), PCN double-count netting — all defended.
- **Invoice total vs lines** — re-summed server-side both paths; `totalSen` kept gross; no drift.

## Test gap
No unit test asserts `Σdebit === Σcredit` for the leg builders. A "every builder balances" test would lock the strongest invariant.

## Recommended fix order (when owner approves — finance = propose→confirm, don't auto-fix)
1. The 🔴 receipt amount-vs-allocations guard (cheap, closes the one critical invariant).
2. Before enabling GST: the e-invoice tax (#2) + invoice-lock-after-e-invoice (#3).
3. The restate overpayment guard (#4) + remove the legacy `paidAmount` branch (#5).
4. The rest as cleanup.
