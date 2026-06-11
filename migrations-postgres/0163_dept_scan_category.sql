-- Dept-scan v2 (owner 2026-06-11): production-department QRs are per LINE —
-- Fab Sew·Sofa vs Fab Sew·Bedframe are separate wall codes — so the scan
-- captures the category, giving per-PERSON line attribution instead of the
-- department-average split. Nullable: dept-only scans and non-production
-- departments carry no category.
--
-- Lowercase column on purpose (adapter folding rule). Also self-applied at
-- runtime (ensureDeptScanEvents); this file keeps fresh databases complete.

ALTER TABLE dept_scan_events ADD COLUMN IF NOT EXISTS category TEXT;
