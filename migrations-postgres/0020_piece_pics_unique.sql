-- 0020_piece_pics_unique.sql
--
-- Prevent two parallel scans from double-assigning the same piece slot.
-- A UNIQUE constraint on (jobCardId, pieceNo) means a concurrent INSERT
-- attempting to add a duplicate slot fails fast with a constraint error,
-- giving the app a clean way to bail + retry instead of silently producing
-- two rows that both look like "piece 1".
--
-- The piece_pics table already treats (jobCardId, pieceNo) as the logical
-- key — this index is the enforcement of that invariant.
--
-- Idempotent: IF NOT EXISTS guard so this replays safely even if an
-- earlier parallel agent already landed a migration that created the
-- same index under a different filename (e.g. 0010_piece_pics_unique.sql).

CREATE UNIQUE INDEX IF NOT EXISTS piece_pics_jc_piece_uniq
  ON piece_pics (job_card_id, piece_no);
