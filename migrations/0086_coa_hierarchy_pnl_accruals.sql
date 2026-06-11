-- ============================================================================
-- HOOKKA ERP — Finance Phase 1: COA hierarchy, P&L category, accrual split
-- (SQLite mirror of migrations-postgres/0154_coa_hierarchy_pnl_accruals.sql.
--  D1 is retired — this file exists so scripts/d1-to-postgres.mjs keeps the
--  pnlCategory / isPostable identifiers in column-rename-map.json on regen.)
-- ============================================================================

ALTER TABLE chart_of_accounts ADD COLUMN pnlCategory TEXT;
ALTER TABLE chart_of_accounts ADD COLUMN isPostable INTEGER NOT NULL DEFAULT 1;

INSERT OR IGNORE INTO chart_of_accounts
  (code, name, type, parentCode, balanceSen, isActive, cashFlowCategory, specialAccountType, isPostable)
VALUES
  ('410-0010', 'ACCRUAL - SALARY',  'LIABILITY', '410-0000', 0, 1, 'O', NULL, 1),
  ('410-0020', 'ACCRUAL - EPF',     'LIABILITY', '410-0000', 0, 1, 'O', NULL, 1),
  ('410-0030', 'ACCRUAL - SOCSO',   'LIABILITY', '410-0000', 0, 1, 'O', NULL, 1),
  ('410-0040', 'ACCRUAL - EIS',     'LIABILITY', '410-0000', 0, 1, 'O', NULL, 1);

UPDATE chart_of_accounts SET isPostable = 0 WHERE code IN
  ('310-0000','330-0000','340-0000','440-0000','700-0000','700-1000',
   '701-0000','702-0000','703-0000','704-0000','705-0000','750-0000',
   '780-0000','790-0000','900-0000','902-0000');

UPDATE chart_of_accounts SET parentCode = '310-0000' WHERE code LIKE '310-00%' AND code <> '310-0000';
UPDATE chart_of_accounts SET parentCode = '330-0000' WHERE code LIKE '330-%'   AND code <> '330-0000';
UPDATE chart_of_accounts SET parentCode = '340-0000' WHERE code IN ('340-0010','340-0020','340-0030');
UPDATE chart_of_accounts SET parentCode = '440-0000' WHERE code IN ('440-0010','440-0020');
UPDATE chart_of_accounts SET parentCode = '700-0000' WHERE code IN ('700-1000','700-1015','701-0000','702-0000','703-0000','704-0000','705-0000','706-0000','750-0000','780-0000','790-0000');
UPDATE chart_of_accounts SET parentCode = '701-0000' WHERE code LIKE '701-%' AND code <> '701-0000';
UPDATE chart_of_accounts SET parentCode = '702-0000' WHERE code LIKE '702-%' AND code <> '702-0000';
UPDATE chart_of_accounts SET parentCode = '703-0000' WHERE code LIKE '703-%' AND code <> '703-0000';
UPDATE chart_of_accounts SET parentCode = '704-0000' WHERE code LIKE '704-%' AND code <> '704-0000';
UPDATE chart_of_accounts SET parentCode = '705-0000' WHERE code LIKE '705-%' AND code <> '705-0000';
UPDATE chart_of_accounts SET parentCode = '750-0000' WHERE code LIKE '750-%' AND code <> '750-0000';
UPDATE chart_of_accounts SET parentCode = '780-0000' WHERE code LIKE '780-%' AND code <> '780-0000';
UPDATE chart_of_accounts SET parentCode = '790-0000' WHERE code IN ('700-9005','700-9010');
UPDATE chart_of_accounts SET parentCode = '900-0000' WHERE code LIKE '900-%' AND code NOT IN ('900-0000','900-H001');
UPDATE chart_of_accounts SET parentCode = '902-0000' WHERE code = '900-H001';
UPDATE chart_of_accounts SET parentCode = '410-0000' WHERE code IN ('410-0010','410-0020','410-0030','410-0040');

UPDATE chart_of_accounts SET pnlCategory = 'VARIABLE'
 WHERE pnlCategory IS NULL AND type = 'COST';
