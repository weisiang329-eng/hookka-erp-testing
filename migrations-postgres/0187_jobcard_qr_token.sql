-- 0187_jobcard_qr_token.sql
-- PUBLIC packing-sticker → RACK assignment flow (the ITEM→RACK direction).
--
-- job_cards.qr_token is the unguessable 64-hex credential for the public
-- /p/<token> page, where a storekeeper (no Worker-Portal login) sets the rack
-- number for the one PACKING piece the sticker belongs to. The token is minted
-- lazily by the authed sticker-print endpoint
-- (POST /api/production-orders/packing-rack-tokens); the public route only
-- resolves it. See src/api/lib/jobcard-qr-token.ts and
-- src/api/routes/public-rack-write.ts.
--
-- snake_case column name per the Hookka new-column rule (no rename-map entry
-- needed). NOTE: deploys do NOT replay this file — the runtime self-apply in
-- ensureJobCardQrTokenColumn() is what reaches prod; this migration is the
-- permanent record + the SQLite-test mirror.

ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS qr_token TEXT;
CREATE INDEX IF NOT EXISTS ix_job_cards_qr_token ON job_cards (qr_token);
