-- ============================================================================
-- HOOKKA ERP — Unified document numbering counter.
-- One running counter per (prefix, ym) so a back-dated voucher draws from
-- its own month's series and each bank+direction prefix runs independently.
-- Atomic issue: INSERT ... ON CONFLICT DO UPDATE next_no = next_no + 1.
-- ============================================================================
CREATE TABLE IF NOT EXISTS doc_no_counters (
  prefix      TEXT NOT NULL,
  ym          TEXT NOT NULL,
  next_no     INTEGER NOT NULL DEFAULT 1,
  updated_at  TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  PRIMARY KEY (prefix, ym)
);
