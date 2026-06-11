-- ============================================================================
-- HOOKKA ERP — Finance Phase 1: COA hierarchy, P&L category, accrual split
--
-- 1. pnl_category — owner-maintained P&L expense classification
--    (FIXED | VARIABLE | OTHERS). NULL = unclassified; the COA editor lets
--    the owner tag accounts, reports group by it later (Phase 5).
-- 2. is_postable — header/parent accounts (e.g. 330-0000 STOCK) become
--    non-postable; journals & auto-postings must hit leaf accounts only.
-- 3. parent_code — populate the AutoCount-style hierarchy that migration
--    0115 deferred ("sub-section hierarchy (parent_code) is a later
--    phase"). Grouping mirrors the owner's Chart of Account workbook.
-- 4. Accruals split (owner decision 2026-06-10): 410-0010 SALARY /
--    410-0020 EPF / 410-0030 SOCSO / 410-0040 EIS payable children under
--    410-0000 ACCRUALS. Payroll posting credits each child separately so
--    "what do we still owe EPF" is one glance. 410-0000 itself STAYS
--    postable — it already carries a live balance and remains the home
--    for miscellaneous accruals.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / ON CONFLICT DO NOTHING / UPDATEs
-- keyed on stable codes.
-- ============================================================================

ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS pnl_category TEXT;
ALTER TABLE chart_of_accounts ADD COLUMN IF NOT EXISTS is_postable INTEGER NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------
-- Accrual children (liability, operating). Parent: 410-0000 ACCRUALS.
-- ---------------------------------------------------------------------------
INSERT INTO chart_of_accounts
  (code, name, type, parent_code, balance_sen, is_active, cash_flow_category, special_account_type, is_postable)
VALUES
  ('410-0010', 'ACCRUAL - SALARY',  'LIABILITY', '410-0000', 0, 1, 'O', NULL, 1),
  ('410-0020', 'ACCRUAL - EPF',     'LIABILITY', '410-0000', 0, 1, 'O', NULL, 1),
  ('410-0030', 'ACCRUAL - SOCSO',   'LIABILITY', '410-0000', 0, 1, 'O', NULL, 1),
  ('410-0040', 'ACCRUAL - EIS',     'LIABILITY', '410-0000', 0, 1, 'O', NULL, 1)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Header accounts → non-postable parents. None of these codes are posting
-- targets anywhere in src/ (verified 2026-06-11); they exist purely as
-- section headers in the owner's workbook.
-- ---------------------------------------------------------------------------
UPDATE chart_of_accounts SET is_postable = 0 WHERE code IN
  ('310-0000',  -- CASH AT BANK            (banks live at 310-00x0)
   '330-0000',  -- STOCK                   (stock accounts 330-xxxx)
   '340-0000',  -- DEPOSIT & PREPAYMENT
   '440-0000',  -- LOAN FROM RELATED PARTIES
   '700-0000',  -- MANUFACTURING ACCOUNT
   '700-1000',  -- RAW MATERIALS (section header inside manufacturing)
   '701-0000',  -- PURCHASE - FABRIC
   '702-0000',  -- PURCHASE - WOODEN
   '703-0000',  -- PURCHASE - FILLER
   '704-0000',  -- PURCHASE - OTHERS
   '705-0000',  -- PACKING MATERIALS
   '750-0000',  -- DIRECT LABOUR
   '780-0000',  -- FACTORY OVERHEAD
   '790-0000',  -- WORK IN PROGRESS
   '900-0000',  -- ADMINISTRATIVE, SELLING & GENERAL EXPS
   '902-0000'); -- FINANCE COSTS

-- ---------------------------------------------------------------------------
-- Hierarchy (parent_code), per the owner's workbook sections. Children only
-- where the parent is a genuine section header; control/posting accounts
-- (300-0000, 400-0000, 500-0000…) are NOT parents.
-- ---------------------------------------------------------------------------
UPDATE chart_of_accounts SET parent_code = '310-0000' WHERE code LIKE '310-00%' AND code <> '310-0000';
UPDATE chart_of_accounts SET parent_code = '330-0000' WHERE code LIKE '330-%'   AND code <> '330-0000';
UPDATE chart_of_accounts SET parent_code = '340-0000' WHERE code IN ('340-0010','340-0020','340-0030');
UPDATE chart_of_accounts SET parent_code = '440-0000' WHERE code IN ('440-0010','440-0020');
UPDATE chart_of_accounts SET parent_code = '700-0000' WHERE code IN ('700-1000','700-1015','701-0000','702-0000','703-0000','704-0000','705-0000','706-0000','750-0000','780-0000','790-0000');
UPDATE chart_of_accounts SET parent_code = '701-0000' WHERE code LIKE '701-%' AND code <> '701-0000';
UPDATE chart_of_accounts SET parent_code = '702-0000' WHERE code LIKE '702-%' AND code <> '702-0000';
UPDATE chart_of_accounts SET parent_code = '703-0000' WHERE code LIKE '703-%' AND code <> '703-0000';
UPDATE chart_of_accounts SET parent_code = '704-0000' WHERE code LIKE '704-%' AND code <> '704-0000';
UPDATE chart_of_accounts SET parent_code = '705-0000' WHERE code LIKE '705-%' AND code <> '705-0000';
UPDATE chart_of_accounts SET parent_code = '750-0000' WHERE code LIKE '750-%' AND code <> '750-0000';
UPDATE chart_of_accounts SET parent_code = '780-0000' WHERE code LIKE '780-%' AND code <> '780-0000';
UPDATE chart_of_accounts SET parent_code = '790-0000' WHERE code IN ('700-9005','700-9010');
UPDATE chart_of_accounts SET parent_code = '900-0000' WHERE code LIKE '900-%' AND code NOT IN ('900-0000','900-H001');
UPDATE chart_of_accounts SET parent_code = '902-0000' WHERE code = '900-H001';
UPDATE chart_of_accounts SET parent_code = '410-0000' WHERE code IN ('410-0010','410-0020','410-0030','410-0040');

-- ---------------------------------------------------------------------------
-- pnl_category seed — manufacturing/COST accounts default VARIABLE (they
-- scale with output); everything else stays NULL for the owner to tag in
-- the COA editor. Re-runnable: only fills NULLs.
-- ---------------------------------------------------------------------------
UPDATE chart_of_accounts SET pnl_category = 'VARIABLE'
 WHERE pnl_category IS NULL AND type = 'COST';
