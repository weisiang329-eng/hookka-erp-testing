-- 0226_user_active_org.sql — BUG-2026-08-13-097
--
-- "Which company is active" was stored on the SINGLETON row
-- `inter_company_config` (id = 1), so it was GLOBAL state: one user switching
-- company in the sidebar switcher flipped the switcher for every other
-- signed-in user, across all four organisations and every tenant.
--
-- Move it to the user. NULLABLE with NO default on purpose: NULL means "this
-- user has never picked one", and the reader falls back to the old global row
-- so no one's switcher visibly changes on deploy.
--
-- `inter_company_config.active_org_id` is deliberately NOT dropped — it is the
-- fallback for every user who has not switched since this shipped, and dropping
-- it would reset all of them at once. It is now read-only: nothing writes it.
--
-- REMINDER: this file is INERT on deploy. The column reaches production through
-- src/api/lib/ensure-user-active-org.ts, awaited before the switcher's UPDATE.

ALTER TABLE users ADD COLUMN IF NOT EXISTS active_org_id text;
