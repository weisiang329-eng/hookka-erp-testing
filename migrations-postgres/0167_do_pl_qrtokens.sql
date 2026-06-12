-- ---------------------------------------------------------------------------
-- 0167_do_pl_qrtokens.sql — unguessable QR tokens for the public
-- dispatch/deliver scan flow (DOs + Packing Lists).
--
-- Why: every DO and every Packing List gets a printed QR. A driver scanning
-- it with a normal phone camera (no login) lands on /d/<token>, which shows
-- a minimal document summary and ONE forward action (Mark Dispatched /
-- Mark Delivered) via the public /api/public/do-qr/:token endpoints. The
-- token IS the credential, so it must be long-random (two UUIDs, 64 hex
-- chars) and stored per row; rows without a token simply have no public
-- page until the office opens the QR dialog (lazy generation).
--
-- The column name is deliberately all-lowercase (qrtoken): unquoted
-- camelCase DDL folds to lowercase on Postgres anyway (BUG-2026-06-11-007),
-- so spelling it folded keeps SQL, runtime ensure, and this migration
-- byte-identical. Reads use SELECT * and the folded key.
--
-- The same ALTERs also self-apply at runtime (ensureQrTokenColumns in
-- src/api/routes/delivery-orders.ts) so deploy ordering can't break the
-- endpoints. Rows without a value behave exactly as before.
-- ---------------------------------------------------------------------------

ALTER TABLE delivery_orders ADD COLUMN IF NOT EXISTS qrtoken TEXT;
ALTER TABLE packing_lists ADD COLUMN IF NOT EXISTS qrtoken TEXT;

-- Token → row lookup is the public page's only access path.
CREATE INDEX IF NOT EXISTS ix_delivery_orders_qrtoken ON delivery_orders (qrtoken);
CREATE INDEX IF NOT EXISTS ix_packing_lists_qrtoken ON packing_lists (qrtoken);
