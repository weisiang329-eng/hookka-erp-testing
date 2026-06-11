-- ---------------------------------------------------------------------------
-- 0161_outbox_attachments.sql — attachments for the durable email outbox.
--
-- Why: the customer dispatch / invoice notices (delivery-orders
-- notify-customer endpoint) carry the real DO / Invoice PDF. The outbox row
-- stores them as a JSON array of {filename, contentBase64} in a TEXT column
-- (snake_case, matching the sibling columns of 0081_email_outbox.sql) and the
-- cron drain forwards them to the provider (Resend `attachments`, Brevo
-- `attachment`). Rows without a value behave exactly as before.
--
-- Total decoded size is capped at 5 MB by enqueueEmail (oversize payloads are
-- enqueued WITHOUT the attachment + a console.warn) so a runaway PDF can
-- never wedge the drain.
--
-- The same ALTER also self-applies at runtime (ensureOutboxMigrations in
-- src/api/lib/email-outbox.ts) so deploy ordering can't break enqueue/drain.
-- ---------------------------------------------------------------------------

ALTER TABLE outbox_emails ADD COLUMN IF NOT EXISTS attachments_json TEXT;
