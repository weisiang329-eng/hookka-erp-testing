-- ============================================================================
-- HOOKKA ERP — WIP cascade idempotency log.
--
-- Of all cascade targets (cost_ledger, fg_units, fg_batches, job_cards),
-- wip_items is the only one that runs DELTA writes (UPDATE stockQty = stockQty
-- ± qty) without an idempotency key. The BUG-005 short-circuit
-- (prevStatus === newStatus in applyWipInventoryChange) only catches
-- duplicates WITHIN one PATCH request — it does NOT catch the same
-- (jobCardId, fromStatus, toStatus) replayed from:
--   - Migration / backfill scripts that re-fire the cascade on already-final-
--     state JCs (refund-may-2026-pofold, backfill-cascade-wip-producers,
--     backfill-fc-label-refresh — all called applyWipInventoryChange on
--     historical data).
--   - Bulk patch + retry handlers that re-issue the same transition.
--   - Cross-session replay (operator A flips Today, admin override fires
--     cascade again Next Week).
--
-- Net effect: every replay does +wipQty again on the producer-add side, and
-- the consume side hits a different / missing label so the books don't
-- balance. This is the structural reason FOAM showed stock=326 when only
-- 11 JCs were open (operator report 2026-05-12).
--
-- This table is the idempotency claim ticket. Every call to
-- applyWipInventoryChange first INSERTs into wip_cascade_log with
-- ON CONFLICT DO NOTHING; if no row was inserted (already exists) the
-- cascade short-circuits. Atomic, concurrent-safe, no race window.
--
-- Schema design:
--   org_id           — multi-tenant scoping (matches every other table).
--   job_card_id      — the JC whose transition triggered the cascade.
--   from_status      — pre-transition status. Nullable for the rare case
--                      where the caller doesn't know (initial seed).
--   to_status        — post-transition status.
--   source           — debug label so we can see which call path created
--                      the claim ('PATCH' | 'SCAN' | 'BULK_PATCH' | 'BACKFILL').
--   applied_at       — server-side timestamp for forensics.
--
-- UNIQUE (org_id, job_card_id, from_status, to_status) — the idempotency
-- key. The same exact transition can never fire twice.
--
-- Forward (WAITING → COMPLETED) and rollback (COMPLETED → WAITING) are
-- DIFFERENT tuples, so both fire correctly. Going round-trip
-- WAITING → COMPLETED → WAITING → COMPLETED produces 3 distinct rows for the
-- first two transitions, and the 3rd transition (the re-completion) hits
-- the UNIQUE constraint and is silently skipped — which is the right
-- policy for a small furniture shop: real re-completions are operator
-- error and shouldn't double-add stock.
-- ============================================================================

CREATE TABLE IF NOT EXISTS wip_cascade_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- org_id is TEXT (matches the multi-tenant skeleton from 0049) — Hookka
  -- tables use TEXT 'hookka' as the tenant scope, not UUID. First-deploy
  -- erroneously used UUID; idempotent ALTER below corrects in place.
  org_id      TEXT NOT NULL,
  job_card_id TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  source      TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE wip_cascade_log
  ALTER COLUMN org_id TYPE TEXT USING org_id::text;

-- The idempotency key. NULLs are treated as distinct by Postgres, which is
-- the behaviour we want — a NULL from_status means "first emission, no prior
-- state known"; two such emissions for the same (jcId, toStatus) shouldn't
-- collide and silently skip.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_wip_cascade_log_transition
  ON wip_cascade_log (org_id, job_card_id, from_status, to_status)
  WHERE from_status IS NOT NULL;

-- Separate unique for the NULL-from_status case (initial emission per JC):
-- prevents two backfill scripts from both claiming "first emission".
CREATE UNIQUE INDEX IF NOT EXISTS uniq_wip_cascade_log_initial
  ON wip_cascade_log (org_id, job_card_id, to_status)
  WHERE from_status IS NULL;

-- Forensic index — find every cascade hit for a JC over time.
CREATE INDEX IF NOT EXISTS idx_wip_cascade_log_jc
  ON wip_cascade_log (org_id, job_card_id, applied_at DESC);
