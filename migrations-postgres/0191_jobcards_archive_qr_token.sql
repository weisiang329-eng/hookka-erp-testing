-- 0191_jobcards_archive_qr_token.sql
-- Permanence record for the packing-sticker → rack scan archive fallback
-- (FIX 1 of the 2026-06-25 unified non-breaking fix).
--
-- The /p/<token> public packing-sticker page resolves the token across BOTH the
-- hot job_cards table and job_cards_archive (an old printed sticker may belong
-- to a card whose PO has since completed + been archived). The archive sibling
-- was created at migration 0038 via CREATE TABLE … AS SELECT * … and froze the
-- column set of that day, so it lacks the later-added qr_token column.
--
-- The runtime self-heal already covers prod: archiveUnionSource() (used by the
-- public resolver) introspects + ADD COLUMN IF NOT EXISTS the missing qr_token
-- on the archive on first use, and FIX 5 INSERTs preserved PACKING tokens into
-- it. This migration is the PERMANENT record + the SQLite-test mirror; like all
-- Hookka migrations it is INERT on prod (deploys do NOT replay
-- migrations-postgres/*.sql) — the runtime self-apply is what reaches prod.

ALTER TABLE job_cards_archive ADD COLUMN IF NOT EXISTS qr_token TEXT;
