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

ALTER TABLE suppliers ADD COLUMN controlAccount TEXT;
ALTER TABLE suppliers ADD COLUMN creditorType TEXT;
ALTER TABLE suppliers ADD COLUMN registrationNo TEXT;
ALTER TABLE suppliers ADD COLUMN taxEntityTin TEXT;
ALTER TABLE suppliers ADD COLUMN addressLine1 TEXT;
ALTER TABLE suppliers ADD COLUMN addressLine2 TEXT;
ALTER TABLE suppliers ADD COLUMN addressLine3 TEXT;
ALTER TABLE suppliers ADD COLUMN addressLine4 TEXT;
ALTER TABLE suppliers ADD COLUMN postalCode TEXT;
ALTER TABLE suppliers ADD COLUMN area TEXT;
ALTER TABLE suppliers ADD COLUMN website TEXT;
ALTER TABLE suppliers ADD COLUMN attention TEXT;
ALTER TABLE suppliers ADD COLUMN agent TEXT;
ALTER TABLE suppliers ADD COLUMN businessNature TEXT;
ALTER TABLE suppliers ADD COLUMN currency TEXT NOT NULL DEFAULT 'MYR';
ALTER TABLE suppliers ADD COLUMN statementType TEXT NOT NULL DEFAULT 'OPEN_ITEM';
ALTER TABLE suppliers ADD COLUMN agingOn TEXT NOT NULL DEFAULT 'INVOICE_DATE';
ALTER TABLE suppliers ADD COLUMN creditTerm TEXT NOT NULL DEFAULT 'C.O.D.';
ALTER TABLE suppliers ADD COLUMN isActive INTEGER NOT NULL DEFAULT 1;
ALTER TABLE suppliers ADD COLUMN isGroupCompany INTEGER NOT NULL DEFAULT 0;
ALTER TABLE suppliers ADD COLUMN outstandingSen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE suppliers ADD COLUMN secondDescription TEXT;
ALTER TABLE suppliers ADD COLUMN phone2 TEXT;
ALTER TABLE suppliers ADD COLUMN mobile TEXT;
ALTER TABLE suppliers ADD COLUMN fax TEXT;
