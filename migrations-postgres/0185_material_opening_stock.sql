-- ============================================================================
-- HOOKKA ERP — material_opening_stock (F6 物料成本 FIFO 引擎).
-- 财务侧只读 FIFO 成本引擎的「期初存货」种子层:业主在 Maintenance 逐料填一次
-- (切换日的数量 + 单价);之后每月期初 = 上月期末,引擎按 FIFO 自动结转。
-- 只财务读,不碰运作的 rm_batches。
--
-- 注意:本表由端点运行时自建(CREATE TABLE IF NOT EXISTS,见
-- src/api/routes/accounting.ts 的 ensureMaterialOpeningStock)。本迁移文件是
-- 双轨记录 + 给 rename-map 扫描器,CI 不会自动跑它。
-- ============================================================================

CREATE TABLE IF NOT EXISTS material_opening_stock (
  id            TEXT PRIMARY KEY,
  rm_id         TEXT NOT NULL,
  qty           DOUBLE PRECISION NOT NULL DEFAULT 0,
  unit_cost_sen INTEGER NOT NULL DEFAULT 0,
  as_of_date    TEXT NOT NULL,
  org_id        TEXT NOT NULL DEFAULT 'hookka',
  created_at    TEXT NOT NULL DEFAULT (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  updated_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mos_key ON material_opening_stock (org_id, rm_id);
