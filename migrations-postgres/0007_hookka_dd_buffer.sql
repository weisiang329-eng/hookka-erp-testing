-- ============================================================================
-- HOOKKA ERP — hookka_dd_buffer
--
-- Per-category buffer (in days) between the CUSTOMER's requested delivery date
-- and HOOKKA's internal target date (the date production must finish).
--
-- Example: customer wants delivery by 2026-04-30, BEDFRAME buffer = 2 days
--   → PACKING dept anchor = 2026-04-28
--   → remaining 2 days are used for dispatch / loading / shipping
--
-- The buffer shifts the reverse-schedule anchor; it does NOT change the
-- per-dept lead-time math itself. Seeded with values from the user's
-- production-sheet spreadsheet.
-- ============================================================================

CREATE TABLE hookka_dd_buffer (
  category TEXT PRIMARY KEY CHECK (category IN ('BEDFRAME','SOFA')),
  days INTEGER NOT NULL DEFAULT 2
);

INSERT INTO hookka_dd_buffer (category, days) VALUES
  ('BEDFRAME', 2),
  ('SOFA', 1);
