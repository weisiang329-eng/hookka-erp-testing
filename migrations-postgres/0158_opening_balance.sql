-- ============================================================================
-- HOOKKA ERP — Finance: opening balances (Phase-5 prerequisite)
--
-- Owner enters opening balances HIMSELF on the new Opening Balance tab:
--   · AR/AP — one opening invoice per customer/supplier (AutoCount style),
--     so aging, statements and the three-card reconciliation all work.
--     These rows live in invoices / purchase_invoices flagged is_opening=1;
--     they NEVER post GL legs themselves (no revenue re-recognition) — the
--     debtor/creditor control legs come from the GL opening batch, locked
--     to the per-party sums so control always equals subledger.
--   · GL — one balanced ledger batch, sourceType 'opening_balance'
--     (re-saving reverses the prior batch via 'opening_balance_reversal').
--     Read surfaces date these legs at the kv 'opening_date', because
--     backdating posted_at would break the hash-chain walk order.
-- ============================================================================

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS is_opening INTEGER NOT NULL DEFAULT 0;

ALTER TABLE purchase_invoices
  ADD COLUMN IF NOT EXISTS is_opening INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_invoices_is_opening
  ON invoices (is_opening) WHERE is_opening = 1;

CREATE INDEX IF NOT EXISTS idx_purchase_invoices_is_opening
  ON purchase_invoices (is_opening) WHERE is_opening = 1;
