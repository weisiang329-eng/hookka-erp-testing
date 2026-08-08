-- ---------------------------------------------------------------------------
-- 0221_fg_stock_events.sql — the append-only finished-goods stock ledger.
--
-- RECORD ONLY. Deploys do NOT replay migration files in this repo, so the
-- LOAD-BEARING copy of this DDL is `ensureFgStockEventsSchema` in
-- src/api/lib/fg-stock-events.ts, awaited before the first write. Keep the two
-- in step.
--
-- WHY A SIBLING TABLE AND NOT fg_scan_history
--   fg_scan_history is a shop-floor DEPARTMENT scan record: dept_code is NOT
--   NULL, it carries pic_slot / worker identity, and its action CHECK admits
--   only COMPLETE / UNDO / SIGN / DISPATCH. It has no from/to status, no
--   direction, and — decisively — no document TYPE + ID: nothing in it can say
--   "this piece left on DO-2607-018". Widening it would mean dropping its CHECK,
--   making dept_code nullable and adding six columns, i.e. keeping the name and
--   replacing the table. It also still has zero rows, so nothing is preserved by
--   reusing it.
--
-- WHY THE FK CASCADES
--   Same choice fg_scan_history made, and deliberate. A regenerate / de-dupe
--   repair (admin.ts, import-completion, backfill-dedupe-fg-units) DELETEs
--   fg_units rows; without the cascade those repairs would FK-fail, and with an
--   orphan-tolerant design the ledger would keep claiming a balance for a piece
--   that no longer has an identity. The destruction of the unit is the ONE thing
--   that removes an event. Nothing in the application ever UPDATEs or DELETEs a
--   row here: a reversal (DO cancel, un-dispatch, return) writes a COUNTER-ROW,
--   the same discipline buildDoCancelReleaseStatements follows for
--   stock_movements.
--
-- BALANCE ARITHMETIC
--   `direction` is onHand(to_status) − onHand(from_status), so Σ direction over
--   a unit's events always equals 1 when that unit is on hand and 0 when it is
--   not — by construction, at every call site, with no per-site judgement. See
--   fg-stock-events.ts for the on-hand status set.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS fg_stock_events (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL DEFAULT 'hookka',
  fg_unit_id        TEXT NOT NULL REFERENCES fg_units(id) ON DELETE CASCADE,
  -- IN / OUT / MOVE — derived from `direction`, stored so a reader does not
  -- have to know the arithmetic.
  event_type        TEXT NOT NULL,
  direction         INTEGER NOT NULL,
  from_status       TEXT,
  to_status         TEXT NOT NULL,
  -- The document that CAUSED the transition: a real type + id, not a free-text
  -- reason. doc_no is display only.
  doc_type          TEXT NOT NULL,
  doc_id            TEXT,
  doc_no            TEXT,
  product_code      TEXT,
  -- The cost lot this piece belongs to, as known at event time (step 2).
  batch_id          TEXT,
  unit_cost_sen     INTEGER,
  occurred_at       TEXT NOT NULL,
  actor_type        TEXT NOT NULL DEFAULT 'SYSTEM',
  actor_id          TEXT,
  actor_name        TEXT,
  -- Set on a counter-row so a reversal points at what it undoes.
  reverses_doc_type TEXT,
  reverses_doc_id   TEXT,
  note              TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fg_stock_events_unit    ON fg_stock_events (fg_unit_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_fg_stock_events_product ON fg_stock_events (product_code, occurred_at);
CREATE INDEX IF NOT EXISTS idx_fg_stock_events_doc     ON fg_stock_events (doc_type, doc_id);
CREATE INDEX IF NOT EXISTS idx_fg_stock_events_org     ON fg_stock_events (org_id);
