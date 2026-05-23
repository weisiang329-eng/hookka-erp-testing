-- ---------------------------------------------------------------------------
-- 0131_workers_statutory_toggles.sql — per-worker EPF / SOCSO / EIS / PCB
-- enable toggles.
--
-- Wei Siang 2026-05-23: not every worker should get statutory deductions.
-- Until now `calcStatutory` (src/api/routes/payslips.ts) deducted EPF (11%),
-- SOCSO (RM 7.45) and EIS (RM 3.90) from EVERY worker on every payslip.
-- For workers who are not registered with EPF/SOCSO/EIS/PCB the operator
-- needs to be able to switch each one off per worker. When all four are
-- off, that worker's Net Pay equals their Gross Pay.
--
-- Defaults to TRUE so existing workers keep the current behaviour — the
-- operator opts each non-registered worker out from the Employee Master
-- tab.
-- ---------------------------------------------------------------------------

ALTER TABLE workers ADD COLUMN IF NOT EXISTS epf_enabled   BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS socso_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS eis_enabled   BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS pcb_enabled   BOOLEAN NOT NULL DEFAULT TRUE;
