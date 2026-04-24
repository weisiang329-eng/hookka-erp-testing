-- ---------------------------------------------------------------------------
-- 0023: Align suppliers schema with AutoCount creditor fields.
--
-- Adds the fields used by the existing AutoCount accounting system so the
-- supplier list in hookka-erp mirrors the same information (Control Account,
-- Creditor Type, Billing Address lines, Tax/TIN, Website, Agent, currency,
-- statement type, aging, credit term, Group Company flag, outstanding balance).
--
-- All new columns are nullable / have defaults so existing rows keep working;
-- the row-mapper in src/api/routes-d1/suppliers.ts exposes them in camelCase.
-- Apply:
--   npx wrangler d1 execute hookka-erp-db --remote --file migrations/0023_suppliers_autocount.sql
-- ---------------------------------------------------------------------------

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS control_account TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS creditor_type TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS registration_no TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS tax_entity_tin TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS address_line1 TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS address_line2 TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS address_line3 TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS address_line4 TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS postal_code TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS area TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS attention TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS agent TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS business_nature TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'MYR';
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS statement_type TEXT NOT NULL DEFAULT 'OPEN_ITEM';
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS aging_on TEXT NOT NULL DEFAULT 'INVOICE_DATE';
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS credit_term TEXT NOT NULL DEFAULT 'C.O.D.';
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS is_active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS is_group_company INTEGER NOT NULL DEFAULT 0;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS outstanding_sen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS second_description TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS phone2 TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS mobile TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS fax TEXT;
