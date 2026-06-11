-- 0157_pay_rule_versions.sql
-- Effective-dated pay-rule versions (owner 2026-06-11): each row is a full
-- snapshot of the configurable pay knobs + the date it takes effect. Append-
-- only; the rules for a date = newest row with effectivefrom <= date, else the
-- built-in defaults (src/lib/pay-rules.ts DEFAULT_PAY_RULES).
--
-- Columns are deliberately ALL-LOWERCASE (no camelCase, no snake_case): the
-- runtime self-apply (ensurePayRuleVersions) runs its DDL through the
-- d1-compat adapter, which folds unknown identifiers to lowercase
-- (BUG-2026-06-11-007). Lowercase-from-the-start keeps DDL, DML and SELECT *
-- keys identical.
CREATE TABLE IF NOT EXISTS pay_rule_versions (
  id TEXT PRIMARY KEY,
  effectivefrom TEXT NOT NULL,
  rulesjson TEXT NOT NULL,
  note TEXT,
  createdat TEXT,
  createdby TEXT
);
