-- 0212_kpi_survey_tokens.sql — one-time links for the public customer
-- satisfaction survey (owner 2026-08-07: "发顾客一个类似 google form submit
-- 选择的，直接评分").
--
-- RECORD ONLY. Deploys do NOT replay migrations-postgres/*.sql in this repo —
-- this table reaches prod through the awaited runtime self-apply in
-- src/api/lib/ensure-kpi-tables.ts, which carries the identical DDL. Keep the
-- two in step; the self-apply is the load-bearing one.

CREATE TABLE IF NOT EXISTS kpi_survey_tokens (
  token          TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  kpi_key        TEXT NOT NULL,
  period         TEXT NOT NULL,
  customer_id    TEXT,
  customer_name  TEXT,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  used_at        TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ NOT NULL,
  org_id         TEXT NOT NULL DEFAULT 'hookka'
);

CREATE INDEX IF NOT EXISTS kpi_survey_tokens_user_period
  ON kpi_survey_tokens (user_id, period);
