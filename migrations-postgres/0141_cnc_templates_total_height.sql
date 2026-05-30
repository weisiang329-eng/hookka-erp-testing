-- 0141_cnc_templates_total_height.sql
-- Adds total_height column to cnc_templates.
--
-- Why: BUYI CNC filenames encode the cutting template's TOTAL HEIGHT in cm
-- as a trailing token with a single apostrophe (e.g., "1005 6 FT 20'" =
-- 6FT bedframe at 20cm total height; "5535 2S 30'" = sofa 5535 2-seater
-- at 30cm seat height). The previous parser mis-stored this in
-- fabric_width because of the apostrophe lookalike, but real fabric width
-- (142cm bedframe / 149cm sofa) is uniform per product category and not
-- per-template. Splitting total_height out of fabric_width lets the
-- operator sort/filter templates by height in the library UI and matches
-- how Delivery Orders already display the `totalHeightInches` field as
-- its own column (see src/components/delivery/print-do.tsx).
--
-- Stored as text (not integer) because operators sometimes type units
-- (e.g. "20", "20cm", "20"") and we don't want to lose their notation.
-- Application code parses leading digits when sorting.

ALTER TABLE cnc_templates
  ADD COLUMN IF NOT EXISTS total_height text NOT NULL DEFAULT '';
