-- ---------------------------------------------------------------------------
-- 0136_workers_statutory_default_off.sql — flip existing workers to
-- statutory OFF.
--
-- Migration 0131 added enableEpf / enableSocso / enableEis / enablePcb
-- with DEFAULT TRUE — which silently backfilled EVERY pre-existing worker
-- row (including 7 foreign workers Wei Siang never wanted on EPF) to
-- "all statutory ON". The May 2026 regenerated payslips therefore showed
-- full EPF / SOCSO / EIS / PCB deductions for those 7 workers, which the
-- operator caught in the UI ("我的员工里有那么多是不需要 EPF 的，却显示
-- 成需要 EPF").
--
-- The POST handler in src/api/routes/workers.ts already defaults NEW
-- workers to FALSE on these columns (per Wei Siang's "tick = all have,
-- no tick = all none" spec). This migration brings every existing row
-- in line with that default. Wei Siang can then re-tick the single
-- statutory checkbox in the Employee Master for the Malaysian workers
-- who actually need EPF (per his note "只有 AAN 是有 EPF").
--
-- AFTER applying this migration: the operator must click "Regenerate"
-- on each DRAFT payroll period so the stored payslips recompute against
-- the freshly-FALSE flags. APPROVED rows are protected from regenerate
-- (per payslips.ts regenerate guard) — those would need explicit
-- correction outside this migration.
-- ---------------------------------------------------------------------------

UPDATE workers
   SET epf_enabled = FALSE,
       socso_enabled = FALSE,
       eis_enabled = FALSE,
       pcb_enabled = FALSE;
