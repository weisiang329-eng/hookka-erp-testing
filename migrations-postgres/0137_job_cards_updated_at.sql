-- ---------------------------------------------------------------------------
-- 0137_job_cards_updated_at.sql — add updated_at column to job_cards so the
-- Phase 6 snapshot freshness probe picks up JC mutations.
--
-- Without this column, src/api/lib/snapshot-freshness.ts skipped job_cards
-- entirely (no timestamp-typed column => "no usable freshness column,
-- nightly cron covers it"). The Production page's snapshot cache therefore
-- never invalidated on JC writes — batch Apply PIC / Apply Due Date / Apply
-- Completion silently served stale rows on the next list fetch, which then
-- overwrote the FE's optimistic update with the pre-PATCH state.
--
-- Wei Siang 2026-05-25: "PIC 这边我一个一个点选的时候是可以的。但是当我想要
-- multieselect时，PIC 却做不到。系统好像一直 fail，没什么反应。"
--
-- After this migration:
--   • job_cards has updated_at column, DEFAULT NOW() so every existing row
--     gets a sensible value on apply.
--   • applyPoUpdate's UPDATE job_cards (already bumps updated_at = NOW() per
--     the same-day fix) now actually has the column to write to.
--   • snapshot-freshness's resolveFreshnessColumns picks up the new column
--     on next request (per-isolate cache invalidates on cold start).
--   • production_orders_list_snapshot will invalidate the next read whose
--     MAX(updated_at) on job_cards exceeds the row's built_from.
-- ---------------------------------------------------------------------------

ALTER TABLE job_cards ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW();

-- Mirror on the archive table so a UNION read across hot + archive doesn't
-- error with "column does not exist" on the archive side.
ALTER TABLE job_cards_archive ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;
