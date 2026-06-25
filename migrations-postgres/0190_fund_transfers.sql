-- ============================================================================
-- HOOKKA ERP — fund_transfers: each bank/cash transfer's OWN date.
--
-- Fund transfers post ONLY to the immutable ledger (DR to-bank / CR from-bank),
-- whose legs carry just postedAt (the entry timestamp). The transfer's own date
-- (the form's `date`, which can be back-dated) was never stored day-precise — so
-- financial reports could only bucket a transfer by when it was keyed, not by
-- its document date. This table records (transfer_no → date) so the document-
-- date resolver (src/lib/doc-date.ts DOC_DATE_FAMILIES.fund_transfer) can
-- surface the real date. Self-applied at runtime by POST /fund-transfers; this
-- migration is the record. Existing transfers (no row) fall back to postedAt.
-- ============================================================================
CREATE TABLE IF NOT EXISTS fund_transfers (
  id          TEXT PRIMARY KEY,
  transfer_no TEXT NOT NULL,
  date        TEXT NOT NULL,
  org_id      TEXT NOT NULL DEFAULT 'hookka',
  created_at  TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
);
CREATE INDEX IF NOT EXISTS idx_fund_transfers_no ON fund_transfers (org_id, transfer_no);
