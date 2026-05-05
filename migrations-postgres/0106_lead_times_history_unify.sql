-- ---------------------------------------------------------------------------
-- 0106_lead_times_history_unify.sql
--
-- Follow-up on migration 0105: unify the inline /planning Save Lead Times
-- button with the dialog's scheduled-change flow so there is a single source
-- of truth — the *_history tables — and a single mental model: "every save
-- is a dated row; the resolver picks the latest effective_from <= today".
--
-- Two operations:
--
-- 1. BACKFILL: copy current production_lead_times + hookka_dd_buffer rows
--    into their respective history tables with effective_from='2020-01-01'.
--    This preserves whatever values the user has been saving via the inline
--    form historically — once layer 2 (baseline read) is removed from the
--    resolver, these rows become the de-facto "starting point" for any
--    (cat, dept) that has no later history row.
--
--    Idempotent via NOT EXISTS guard on (category, dept_code, effective_from)
--    so re-running this migration is a no-op.
--
-- 2. UNIQUE CONSTRAINT on (category, dept_code, effective_from) for lead
--    times and (category, effective_from) for hookka buffer. Lets the new
--    PUT /api/production/leadtimes handler do ON CONFLICT DO UPDATE instead
--    of stacking duplicate rows when the user saves the same (cat, dept,
--    today) multiple times. Lead-times has a small fixed set of (cat, dept)
--    pairs (~16 total) and inline-Save is the dominant write path, so the
--    noise-reduction matters here even though product_prices intentionally
--    skips the constraint.
--
-- The legacy production_lead_times + hookka_dd_buffer baseline tables are
-- left in place but go unread by the resolver after this migration ships.
-- They can be DROPped in a future cleanup migration once we're confident
-- nothing external reads them.
-- ---------------------------------------------------------------------------

BEGIN;

-- 1a. Backfill production_lead_times -> production_lead_times_history.
INSERT INTO production_lead_times_history
       (id, category, dept_code, days, effective_from, notes)
SELECT 'lt-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8),
       category,
       dept_code,
       days,
       '2020-01-01',
       'Migrated from baseline (0106)'
  FROM production_lead_times plt
 WHERE NOT EXISTS (
        SELECT 1
          FROM production_lead_times_history h
         WHERE h.category = plt.category
           AND h.dept_code = plt.dept_code
           AND h.effective_from = '2020-01-01'
       );

-- 1b. Backfill hookka_dd_buffer -> hookka_dd_buffer_history.
INSERT INTO hookka_dd_buffer_history
       (id, category, days, effective_from, notes)
SELECT 'hd-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8),
       category,
       days,
       '2020-01-01',
       'Migrated from baseline (0106)'
  FROM hookka_dd_buffer hdb
 WHERE NOT EXISTS (
        SELECT 1
          FROM hookka_dd_buffer_history h
         WHERE h.category = hdb.category
           AND h.effective_from = '2020-01-01'
       );

-- 2. Unique constraints so PUT / can ON CONFLICT DO UPDATE.
--    Names mirror Postgres's auto-naming for index-backed UNIQUEs.
ALTER TABLE production_lead_times_history
  ADD CONSTRAINT production_lead_times_history_cat_dept_eff_uniq
  UNIQUE (category, dept_code, effective_from);

ALTER TABLE hookka_dd_buffer_history
  ADD CONSTRAINT hookka_dd_buffer_history_cat_eff_uniq
  UNIQUE (category, effective_from);

COMMIT;
