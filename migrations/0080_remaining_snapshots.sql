-- D1 mirror of 0120_remaining_snapshots.sql. JSONB → TEXT, NOW() → datetime('now').

CREATE TABLE IF NOT EXISTS sales_orders_stats_snapshot (
  org_id TEXT NOT NULL PRIMARY KEY, data TEXT NOT NULL,
  built_from TEXT NOT NULL, built_at TEXT NOT NULL DEFAULT (datetime('now')),
  refresh_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS consignment_orders_stats_snapshot (
  org_id TEXT NOT NULL PRIMARY KEY, data TEXT NOT NULL,
  built_from TEXT NOT NULL, built_at TEXT NOT NULL DEFAULT (datetime('now')),
  refresh_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS consignment_notes_stats_snapshot (
  org_id TEXT NOT NULL PRIMARY KEY, data TEXT NOT NULL,
  built_from TEXT NOT NULL, built_at TEXT NOT NULL DEFAULT (datetime('now')),
  refresh_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS job_cards_summary_snapshot (
  org_id TEXT NOT NULL PRIMARY KEY, data TEXT NOT NULL,
  built_from TEXT NOT NULL, built_at TEXT NOT NULL DEFAULT (datetime('now')),
  refresh_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS whe_summary_snapshot (
  org_id TEXT NOT NULL PRIMARY KEY, data TEXT NOT NULL,
  built_from TEXT NOT NULL, built_at TEXT NOT NULL DEFAULT (datetime('now')),
  refresh_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS whe_dept_category_snapshot (
  org_id TEXT NOT NULL PRIMARY KEY, data TEXT NOT NULL,
  built_from TEXT NOT NULL, built_at TEXT NOT NULL DEFAULT (datetime('now')),
  refresh_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS accounting_aging_snapshot (
  org_id TEXT NOT NULL PRIMARY KEY, data TEXT NOT NULL,
  built_from TEXT NOT NULL, built_at TEXT NOT NULL DEFAULT (datetime('now')),
  refresh_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cost_ledger_summary_snapshot (
  org_id TEXT NOT NULL PRIMARY KEY, data TEXT NOT NULL,
  built_from TEXT NOT NULL, built_at TEXT NOT NULL DEFAULT (datetime('now')),
  refresh_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS supplier_scorecards_summary_snapshot (
  org_id TEXT NOT NULL PRIMARY KEY, data TEXT NOT NULL,
  built_from TEXT NOT NULL, built_at TEXT NOT NULL DEFAULT (datetime('now')),
  refresh_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS worker_team_stats_snapshot (
  org_id TEXT NOT NULL PRIMARY KEY, data TEXT NOT NULL,
  built_from TEXT NOT NULL, built_at TEXT NOT NULL DEFAULT (datetime('now')),
  refresh_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS production_overdue_snapshot (
  org_id TEXT NOT NULL PRIMARY KEY, data TEXT NOT NULL,
  built_from TEXT NOT NULL, built_at TEXT NOT NULL DEFAULT (datetime('now')),
  refresh_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS department_performance_snapshot (
  org_id TEXT NOT NULL PRIMARY KEY, data TEXT NOT NULL,
  built_from TEXT NOT NULL, built_at TEXT NOT NULL DEFAULT (datetime('now')),
  refresh_count INTEGER NOT NULL DEFAULT 0
);
