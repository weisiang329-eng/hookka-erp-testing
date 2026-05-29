-- 0140_cnc_templates.sql
-- New "CNC fabric-cutting template" entity. Each row is one cutting template
-- for a product piece — a named set of up to three CAD/cutter files (.dgt /
-- .prj / .emf) that the CNC fabric cutter loads to cut a specific piece
-- (ARM, CUSHION, DIVAN ...) at a specific size and fabric width.
--
-- The file BYTES live in Supabase Storage (bucket "hookka-files") under the
-- key scheme cnc-templates/<product_code>/<display_name>.<ext>; this table
-- stores only the metadata + the opaque storage object keys. dgt_key /
-- prj_key / emf_key are '' when that file kind wasn't uploaded for the row.
--
-- Naming columns (product_code / size_label / fabric_width / piece_label)
-- are parsed out of the original base filename, which is preserved verbatim
-- in display_name so the operator can always recognise the source file.
--
-- The SupabaseAdapter routes camelCase route SQL to these snake_case columns
-- and the postgres.js transform.column.from layer returns rows with camelCase
-- keys (e.g. fabric_width → fabricWidth). The route layer reads camelCase.
CREATE TABLE IF NOT EXISTS cnc_templates (
  id              text PRIMARY KEY,
  org_id          text NOT NULL DEFAULT 'hookka',
  product_code    text NOT NULL DEFAULT '',
  size_label      text NOT NULL DEFAULT '',
  fabric_width    text NOT NULL DEFAULT '',
  piece_label     text NOT NULL DEFAULT '',
  display_name    text NOT NULL DEFAULT '',
  folder          text NOT NULL DEFAULT '',
  dgt_key         text NOT NULL DEFAULT '',
  prj_key         text NOT NULL DEFAULT '',
  emf_key         text NOT NULL DEFAULT '',
  drive_folder_id text NOT NULL DEFAULT '',
  size_bytes      integer NOT NULL DEFAULT 0,
  created_at      text,
  updated_at      text
);

CREATE INDEX IF NOT EXISTS idx_cnc_templates_product_code ON cnc_templates (product_code);
CREATE INDEX IF NOT EXISTS idx_cnc_templates_org ON cnc_templates (org_id);
