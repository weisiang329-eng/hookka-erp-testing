-- ---------------------------------------------------------------------------
-- 0110_rename_smashed_columns.sql
--
-- Audit (2026-05-07) discovered 6 columns in prod stored with smashed-
-- camelCase names because the runtime self-migration ALTER TABLE statements
-- in route code referenced camelCase identifiers that were NOT in
-- src/api/lib/column-rename-map.json. Postgres lowercases unquoted
-- identifiers, producing names like `customerpoimageb64` instead of the
-- project-standard `customer_po_image_b64`. Both ALTER and INSERT/SELECT
-- used the same smashed form so the system "worked," but it violates the
-- camelCase-in-route-SQL → snake_case-in-DB convention enforced by
-- supabase-compat.ts via the rename map.
--
-- This migration:
--   1. Renames the 6 smashed columns to project-standard snake_case.
--   2. Adds the truly missing `last_emailed_at` column on purchase_orders
--      (audit found this column referenced by `lastEmailedAt` in the
--      rename map but never actually applied — the runtime self-migration
--      in purchase-orders.ts:603 hadn't been triggered yet).
--
-- Companion code change in this commit: column-rename-map.json gains six
-- new entries so future translateSql() runs route the camelCase
-- identifiers to the now-correct snake_case columns.
-- ---------------------------------------------------------------------------

ALTER TABLE customers       RENAME COLUMN ocrpromptrules      TO ocr_prompt_rules;
ALTER TABLE job_cards       RENAME COLUMN distributedat       TO distributed_at;
ALTER TABLE job_cards       RENAME COLUMN duedateoverriddenat TO due_date_overridden_at;
ALTER TABLE po_scan_samples RENAME COLUMN isgold              TO is_gold;
ALTER TABLE sales_orders    RENAME COLUMN customerpoimageb64  TO customer_po_image_b64;
ALTER TABLE sales_orders    RENAME COLUMN isprojectorder      TO is_project_order;

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS last_emailed_at TEXT;
