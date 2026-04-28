-- ============================================================================
-- Migration 0068 — QC Module rebuild, Phase 1
-- (Renumbered from 0066 — main moved while this PR was in flight; 0066 is
--  consignment_notes_dispatch_linkage and 0067 is stock_adjustments_adj_no.)
--
-- BUSINESS MODEL (per design discussion 2026-04-28):
--   Small sofa/bed-frame factory. QC is a "看护" (custodial) role, not a
--   "警察" (gatekeeper). Inspections run on a TIME schedule (12:00 / 16:00
--   daily), not on production events. Each scheduled slot generates a
--   pending inspection per (department × product_category × stage)
--   template. The inspector picks each slot up, samples (or skips if the
--   stage isn't producing today), and records pass/fail per item.
--
--   On FAIL the system creates a "🔶 Issue Tag" against the inspection's
--   subject (RM batch / job card / FG batch). Tags are SOFT — they don't
--   block production or shipping. Visible everywhere the subject appears,
--   only QC can resolve. The point is informational + audit, not gating.
--
-- WHY ALTER vs new table for qc_inspections:
--   The legacy qc_inspections table from 0001_init.sql was thin and assumed
--   "one inspection = one production order, completed immediately". Phase 1
--   introduces the lifecycle (PENDING → IN_PROGRESS → SKIPPED|COMPLETED),
--   templates, item-level results, and stages (RM/WIP/FG). We extend in
--   place so existing rows carry forward as legacy "completed" data with
--   nulls in the new columns.
--
-- TABLES IN THIS MIGRATION:
--   1. qc_templates           — checklist template per (dept, category, stage)
--   2. qc_template_items      — individual checklist items per template
--   3. qc_inspection_items    — per-item results recorded during inspection
--   4. qc_tags                — soft 🔶 markers on RM batch / job card / FG batch
--   PLUS: ALTER qc_inspections to add lifecycle / template / subject columns
--   PLUS: seed standard sofa + bed-frame templates
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. qc_templates — checklist template definitions
-- ----------------------------------------------------------------------------
-- One template per (department × product_category × stage) combination.
-- Inspector sees one PENDING inspection per active template per scheduled
-- slot (12:00 / 16:00) per day. Template gets snapshotted into the
-- qc_inspections row at completion time so historical inspections stay
-- meaningful even if the template is later edited or deactivated.
CREATE TABLE qc_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Department code (e.g., 'FAB_CUT', 'WAREHOUSING'). Free text not FK
  -- because departments live in mock-data.ts not a master table.
  dept_code TEXT NOT NULL,
  dept_name TEXT,
  -- Product category — drives WHICH product family this template applies to.
  -- 'GENERAL' = applies regardless of product (used for RM stage where
  -- the raw material isn't tied to a finished-product category).
  item_category TEXT NOT NULL CHECK (item_category IN ('SOFA','BEDFRAME','ACCESSORY','GENERAL')),
  -- Stage in the IQC / IPQC / OQC three-step model:
  --   RM  = incoming raw material check (IQC)
  --   WIP = in-process check (IPQC) — between depts on a job card
  --   FG  = outgoing finished goods (OQC)
  stage TEXT NOT NULL CHECK (stage IN ('RM','WIP','FG')),
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX idx_qc_templates_dept_cat_stage ON qc_templates(dept_code, item_category, stage);
CREATE INDEX idx_qc_templates_active ON qc_templates(active);

-- ----------------------------------------------------------------------------
-- 2. qc_template_items — individual check items per template
-- ----------------------------------------------------------------------------
-- One row per "check item" on a template (e.g., "Foam density matches spec").
-- Severity drives the visual treatment of fail (Minor=warning, Major=action,
-- Critical=must resolve). is_mandatory rows that are FAIL or N/A both block
-- "PASS" — the inspector must explicitly resolve every mandatory item.
CREATE TABLE qc_template_items (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  item_name TEXT NOT NULL,
  -- Free-form pass criteria. Shown to the inspector below the item name.
  criteria TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('MINOR','MAJOR','CRITICAL')),
  is_mandatory INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (template_id) REFERENCES qc_templates(id) ON DELETE CASCADE
);
CREATE INDEX idx_qc_template_items_template ON qc_template_items(template_id);

-- ----------------------------------------------------------------------------
-- 3. ALTER qc_inspections — add lifecycle / template / subject columns
-- ----------------------------------------------------------------------------
-- Legacy columns (inspectionNo, productionOrderId, ...) stay as-is so the
-- old route + 0001 schema keep working. New columns default to NULL for
-- pre-Phase-1 rows. Going forward, all inspections fill in these new fields.
ALTER TABLE qc_inspections ADD COLUMN template_id TEXT;
ALTER TABLE qc_inspections ADD COLUMN template_snapshot TEXT;            -- JSON of items, frozen at start time
ALTER TABLE qc_inspections ADD COLUMN stage TEXT;                        -- 'RM'|'WIP'|'FG'
ALTER TABLE qc_inspections ADD COLUMN item_category TEXT;                -- 'SOFA'|'BEDFRAME'|'ACCESSORY'|'GENERAL'
-- Subject = WHAT was inspected. Type drives which table subject_id points at:
--   'RM_BATCH'   → rm_batches.id (FIFO cost layer; for now the "default"
--                  batch per RM SKU until proper batch tracking lands)
--   'JOB_CARD'   → job_cards.id
--   'FG_BATCH'   → fg_batches.id
-- subject_label is denormalised display text ("White cloth — batch A",
-- "PO-25030 / Sewing").
ALTER TABLE qc_inspections ADD COLUMN subject_type TEXT;
ALTER TABLE qc_inspections ADD COLUMN subject_id TEXT;
ALTER TABLE qc_inspections ADD COLUMN subject_label TEXT;
-- 'SCHEDULED' (cron-generated) | 'MANUAL' (inspector creates ad-hoc)
ALTER TABLE qc_inspections ADD COLUMN trigger_type TEXT;
-- The 12:00 or 16:00 slot this inspection was generated for. ISO timestamp.
ALTER TABLE qc_inspections ADD COLUMN scheduled_slot_at TEXT;
-- Lifecycle: 'PENDING' (waiting for inspector) → 'IN_PROGRESS' (opened) →
-- 'COMPLETED' (result PASS/FAIL filled in) | 'SKIPPED' (stage had no
-- production today, marked over)
ALTER TABLE qc_inspections ADD COLUMN status TEXT DEFAULT 'COMPLETED';
ALTER TABLE qc_inspections ADD COLUMN skip_reason TEXT;
ALTER TABLE qc_inspections ADD COLUMN completed_at TEXT;

CREATE INDEX idx_qc_inspections_status ON qc_inspections(status);
CREATE INDEX idx_qc_inspections_slot ON qc_inspections(scheduled_slot_at);
CREATE INDEX idx_qc_inspections_template ON qc_inspections(template_id);

-- ----------------------------------------------------------------------------
-- 4. qc_inspection_items — per-item results captured during an inspection
-- ----------------------------------------------------------------------------
-- One row per check item the inspector evaluated. Result is PASS / FAIL / NA.
-- A FAIL row drives qc_tag and qc_defect creation in the API handler.
CREATE TABLE qc_inspection_items (
  id TEXT PRIMARY KEY,
  inspection_id TEXT NOT NULL,
  sequence INTEGER NOT NULL DEFAULT 0,
  item_name TEXT NOT NULL,
  criteria TEXT,
  severity TEXT NOT NULL,
  is_mandatory INTEGER NOT NULL DEFAULT 1,
  result TEXT CHECK (result IN ('PASS','FAIL','NA')),
  notes TEXT,
  photo_url TEXT,
  FOREIGN KEY (inspection_id) REFERENCES qc_inspections(id) ON DELETE CASCADE
);
CREATE INDEX idx_qc_inspection_items_inspection ON qc_inspection_items(inspection_id);
CREATE INDEX idx_qc_inspection_items_result ON qc_inspection_items(result);

-- ----------------------------------------------------------------------------
-- 5. qc_tags — soft 🔶 marker on a subject after a FAIL
-- ----------------------------------------------------------------------------
-- Created automatically when an inspection fails. ACTIVE = the issue is
-- still open; QC must explicitly RESOLVE (with resolution + notes). Tags
-- are SOFT — they don't block any operation. The frontend simply renders
-- the 🔶 icon next to the subject in any list that surfaces it. The
-- "did anything happen with this Tagged batch" weekly report is built
-- on top of these rows in Phase 2.
CREATE TABLE qc_tags (
  id TEXT PRIMARY KEY,
  -- Subject pointer — same convention as qc_inspections.subject_*. We
  -- duplicate (rather than FK-back to qc_inspections) so a tag can
  -- outlive its parent inspection if the user deletes the inspection.
  subject_type TEXT NOT NULL CHECK (subject_type IN ('RM_BATCH','JOB_CARD','FG_BATCH','RAW_MATERIAL','WIP_ITEM')),
  subject_id TEXT NOT NULL,
  subject_code TEXT,
  subject_label TEXT,
  -- Inspection that created the tag. Nullable so tags can also be
  -- created manually (Phase 2+) without going through an inspection.
  inspection_id TEXT,
  reason TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('MINOR','MAJOR','CRITICAL')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RESOLVED')),
  -- How was the issue cleared (only set when status='RESOLVED'):
  --   REWORKED = sent back through the line and reinspected OK
  --   SCRAPPED = written off via stock_adjustments (operator does that
  --              separately in Inventory > Adjustments)
  --   ACCEPTED = decision to use as-is despite the issue ("concession")
  --   OTHER    = catch-all
  resolution TEXT CHECK (resolution IN ('REWORKED','SCRAPPED','ACCEPTED','OTHER')),
  resolution_notes TEXT,
  tagged_by TEXT,
  tagged_by_name TEXT,
  tagged_at TEXT NOT NULL,
  resolved_by TEXT,
  resolved_by_name TEXT,
  resolved_at TEXT,
  FOREIGN KEY (inspection_id) REFERENCES qc_inspections(id) ON DELETE SET NULL
);
CREATE INDEX idx_qc_tags_subject ON qc_tags(subject_type, subject_id);
CREATE INDEX idx_qc_tags_status ON qc_tags(status);
CREATE INDEX idx_qc_tags_inspection ON qc_tags(inspection_id);

-- ============================================================================
-- 6. SEED standard sofa + bed-frame templates
-- ============================================================================
-- Pre-fills the templates the user asked for. Inspector can edit / disable /
-- add more via the Templates tab. The (dept × category × stage) matrix is
-- intentionally sparse — only the combinations that make sense for a small
-- sofa + bedframe factory.
--
-- Department → typical stage mapping used here:
--   WAREHOUSING                 → RM (incoming material)
--   FAB_CUT, FAB_SEW, WOOD_CUT,
--   FOAM, FRAMING, WEBBING,
--   UPHOLSTERY                  → WIP (in-process)
--   PACKING                     → FG (outgoing)

-- --- RM templates (IQC) at WAREHOUSING ---
INSERT INTO qc_templates (id, name, dept_code, dept_name, item_category, stage, active, notes, created_at) VALUES
  ('qct-rm-fabric',    'Incoming Fabric Check',    'WAREHOUSING', 'Warehousing', 'GENERAL',  'RM', 1, 'Sample-check fabric rolls before they go to FAB_CUT', CURRENT_TIMESTAMP),
  ('qct-rm-foam',      'Incoming Foam Check',      'WAREHOUSING', 'Warehousing', 'GENERAL',  'RM', 1, 'Density / dimensions / colour', CURRENT_TIMESTAMP),
  ('qct-rm-wood',      'Incoming Timber Check',    'WAREHOUSING', 'Warehousing', 'GENERAL',  'RM', 1, 'Moisture / cracks / grade', CURRENT_TIMESTAMP),
  ('qct-rm-hardware',  'Incoming Hardware Check',  'WAREHOUSING', 'Warehousing', 'GENERAL',  'RM', 1, 'Mechanism / springs / screws', CURRENT_TIMESTAMP);

-- Items for RM Fabric
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-rmf-1', 'qct-rm-fabric', 1, 'Colour matches purchase order spec',         'Compare with PO swatch — no visible variation',       'MAJOR', 1),
  ('qcti-rmf-2', 'qct-rm-fabric', 2, 'No tears / pulls / stains on roll surface',  'Inspect the first 2m of the roll',                    'MAJOR', 1),
  ('qcti-rmf-3', 'qct-rm-fabric', 3, 'Roll length matches GRN qty',                'Tape-measure 1 metre, multiply by reported turns',    'MINOR', 1),
  ('qcti-rmf-4', 'qct-rm-fabric', 4, 'Pattern / weave consistent across roll',     'No misweaves or skipped picks',                       'MAJOR', 1);

-- Items for RM Foam
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-rmo-1', 'qct-rm-foam', 1, 'Foam density matches BOM spec',          'Spot-check density rating on label',          'MAJOR',    1),
  ('qcti-rmo-2', 'qct-rm-foam', 2, 'Block dimensions within ±5mm tolerance', 'Tape-measure L×W×H',                          'MAJOR',    1),
  ('qcti-rmo-3', 'qct-rm-foam', 3, 'No yellowing / odour / contamination',   'Visual + smell',                              'MINOR',    1),
  ('qcti-rmo-4', 'qct-rm-foam', 4, 'Recovery rate (rebound) acceptable',     'Press 30s, release — should fully recover',   'CRITICAL', 1);

-- Items for RM Wood
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-rmw-1', 'qct-rm-wood', 1, 'Moisture content < 14%',           'Use moisture meter on 3 random pieces',  'CRITICAL', 1),
  ('qcti-rmw-2', 'qct-rm-wood', 2, 'No live knots / cracks / warping', 'Visual on full bundle',                  'MAJOR',    1),
  ('qcti-rmw-3', 'qct-rm-wood', 3, 'Dimensions within ±2mm tolerance', 'Tape-measure 5 random pieces',           'MAJOR',    1),
  ('qcti-rmw-4', 'qct-rm-wood', 4, 'Correct grade per PO',             'Match grade stamp / supplier cert',      'MINOR',    1);

-- Items for RM Hardware
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-rmh-1', 'qct-rm-hardware', 1, 'Quantity matches GRN',           'Spot-count 1 box',                      'MINOR',    1),
  ('qcti-rmh-2', 'qct-rm-hardware', 2, 'Mechanism functions smoothly',   'Test 3 random units (recline / fold)',  'CRITICAL', 1),
  ('qcti-rmh-3', 'qct-rm-hardware', 3, 'No rust / damage / missing parts', 'Visual on full delivery',             'MAJOR',    1);

-- --- WIP templates (IPQC) — Sofa ---
INSERT INTO qc_templates (id, name, dept_code, dept_name, item_category, stage, active, notes, created_at) VALUES
  ('qct-wip-sofa-fabcut',  'Sofa — Fabric Cutting',  'FAB_CUT',    'Fabric Cutting',  'SOFA', 'WIP', 1, NULL, CURRENT_TIMESTAMP),
  ('qct-wip-sofa-fabsew',  'Sofa — Fabric Sewing',   'FAB_SEW',    'Fabric Sewing',   'SOFA', 'WIP', 1, NULL, CURRENT_TIMESTAMP),
  ('qct-wip-sofa-foam',    'Sofa — Foam Cutting',    'FOAM',       'Foam',            'SOFA', 'WIP', 1, NULL, CURRENT_TIMESTAMP),
  ('qct-wip-sofa-framing', 'Sofa — Framing',         'FRAMING',    'Framing',         'SOFA', 'WIP', 1, NULL, CURRENT_TIMESTAMP),
  ('qct-wip-sofa-webbing', 'Sofa — Webbing',         'WEBBING',    'Webbing',         'SOFA', 'WIP', 1, NULL, CURRENT_TIMESTAMP),
  ('qct-wip-sofa-uph',     'Sofa — Upholstery',      'UPHOLSTERY', 'Upholstery',      'SOFA', 'WIP', 1, NULL, CURRENT_TIMESTAMP);

INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  -- Sofa — Fabric Cutting
  ('qcti-wsfc-1', 'qct-wip-sofa-fabcut', 1, 'Cut dimensions within ±2mm',          NULL, 'MAJOR',    1),
  ('qcti-wsfc-2', 'qct-wip-sofa-fabcut', 2, 'Pattern alignment on cut pieces',     NULL, 'MAJOR',    1),
  ('qcti-wsfc-3', 'qct-wip-sofa-fabcut', 3, 'No tears / fray on cut edges',        NULL, 'MINOR',    1),
  ('qcti-wsfc-4', 'qct-wip-sofa-fabcut', 4, 'Correct fabric SKU per BOM',          NULL, 'CRITICAL', 1),
  -- Sofa — Fabric Sewing
  ('qcti-wsfs-1', 'qct-wip-sofa-fabsew', 1, 'Stitch consistency / no skipped',     NULL, 'MAJOR',    1),
  ('qcti-wsfs-2', 'qct-wip-sofa-fabsew', 2, 'Seam strength (tug test)',            NULL, 'MAJOR',    1),
  ('qcti-wsfs-3', 'qct-wip-sofa-fabsew', 3, 'Thread colour matches fabric',        NULL, 'MINOR',    1),
  ('qcti-wsfs-4', 'qct-wip-sofa-fabsew', 4, 'No loose / dangling threads',         NULL, 'MINOR',    1),
  ('qcti-wsfs-5', 'qct-wip-sofa-fabsew', 5, 'Piping / trim alignment at corners',  NULL, 'MAJOR',    1),
  -- Sofa — Foam Cutting
  ('qcti-wsfm-1', 'qct-wip-sofa-foam', 1, 'Foam dimensions match BOM',             NULL, 'MAJOR', 1),
  ('qcti-wsfm-2', 'qct-wip-sofa-foam', 2, 'No deformation / damage on cut blocks', NULL, 'MAJOR', 1),
  ('qcti-wsfm-3', 'qct-wip-sofa-foam', 3, 'Correct foam type per BOM',             NULL, 'MAJOR', 1),
  -- Sofa — Framing
  ('qcti-wsfr-1', 'qct-wip-sofa-framing', 1, 'Frame is square (diagonals equal)',  NULL, 'MAJOR',    1),
  ('qcti-wsfr-2', 'qct-wip-sofa-framing', 2, 'All joints glued + screwed',         NULL, 'CRITICAL', 1),
  ('qcti-wsfr-3', 'qct-wip-sofa-framing', 3, 'Hardware (legs, brackets) installed', NULL, 'MAJOR',   1),
  ('qcti-wsfr-4', 'qct-wip-sofa-framing', 4, 'No splits / cracks at stress points', NULL, 'MAJOR',   1),
  -- Sofa — Webbing
  ('qcti-wswb-1', 'qct-wip-sofa-webbing', 1, 'Webbing tension consistent',         NULL, 'MAJOR', 1),
  ('qcti-wswb-2', 'qct-wip-sofa-webbing', 2, 'Spacing matches BOM spec',           NULL, 'MAJOR', 1),
  ('qcti-wswb-3', 'qct-wip-sofa-webbing', 3, 'Staples flush + secure (no sagging)', NULL, 'MAJOR', 1),
  -- Sofa — Upholstery
  ('qcti-wsup-1', 'qct-wip-sofa-uph', 1, 'Fabric tension even, no wrinkles',       NULL, 'MAJOR',    1),
  ('qcti-wsup-2', 'qct-wip-sofa-uph', 2, 'Pattern matches at seams',               NULL, 'MAJOR',    1),
  ('qcti-wsup-3', 'qct-wip-sofa-uph', 3, 'Cushion firmness as expected',           NULL, 'MAJOR',    1),
  ('qcti-wsup-4', 'qct-wip-sofa-uph', 4, 'No staples / pins exposed',              NULL, 'CRITICAL', 1),
  ('qcti-wsup-5', 'qct-wip-sofa-uph', 5, 'Overall finish look acceptable',         NULL, 'MAJOR',    1);

-- --- WIP templates (IPQC) — Bed Frame ---
INSERT INTO qc_templates (id, name, dept_code, dept_name, item_category, stage, active, notes, created_at) VALUES
  ('qct-wip-bf-woodcut',  'Bed Frame — Wood Cutting',  'WOOD_CUT',   'Wood Cutting',    'BEDFRAME', 'WIP', 1, NULL, CURRENT_TIMESTAMP),
  ('qct-wip-bf-framing',  'Bed Frame — Framing',       'FRAMING',    'Framing',         'BEDFRAME', 'WIP', 1, NULL, CURRENT_TIMESTAMP),
  ('qct-wip-bf-fabcut',   'Bed Frame — HB Fabric Cut', 'FAB_CUT',    'Fabric Cutting',  'BEDFRAME', 'WIP', 1, 'Headboard fabric cutting', CURRENT_TIMESTAMP),
  ('qct-wip-bf-fabsew',   'Bed Frame — HB Fabric Sew', 'FAB_SEW',    'Fabric Sewing',   'BEDFRAME', 'WIP', 1, 'Headboard fabric sewing', CURRENT_TIMESTAMP),
  ('qct-wip-bf-uph',      'Bed Frame — HB Upholstery', 'UPHOLSTERY', 'Upholstery',      'BEDFRAME', 'WIP', 1, 'Headboard upholstery', CURRENT_TIMESTAMP);

INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  -- Bed Frame — Wood Cutting
  ('qcti-wbwc-1', 'qct-wip-bf-woodcut', 1, 'Cut dimensions within ±2mm',           NULL, 'MAJOR',    1),
  ('qcti-wbwc-2', 'qct-wip-bf-woodcut', 2, 'Cut edges square / no chipping',       NULL, 'MAJOR',    1),
  ('qcti-wbwc-3', 'qct-wip-bf-woodcut', 3, 'No splits / cracks',                   NULL, 'MAJOR',    1),
  ('qcti-wbwc-4', 'qct-wip-bf-woodcut', 4, 'Correct timber per BOM',               NULL, 'CRITICAL', 1),
  -- Bed Frame — Framing
  ('qcti-wbfr-1', 'qct-wip-bf-framing', 1, 'Frame square + dimensions correct',    NULL, 'MAJOR',    1),
  ('qcti-wbfr-2', 'qct-wip-bf-framing', 2, 'Joints solid (glue + screw)',          NULL, 'CRITICAL', 1),
  ('qcti-wbfr-3', 'qct-wip-bf-framing', 3, 'Slats / supports level + secure',      NULL, 'MAJOR',    1),
  ('qcti-wbfr-4', 'qct-wip-bf-framing', 4, 'Hardware (legs / brackets) installed', NULL, 'MAJOR',    1),
  ('qcti-wbfr-5', 'qct-wip-bf-framing', 5, 'No protruding screws / sharp edges',   NULL, 'CRITICAL', 1),
  -- Bed Frame — HB Fabric Cut
  ('qcti-wbfc-1', 'qct-wip-bf-fabcut', 1, 'HB fabric dimensions within ±2mm',      NULL, 'MAJOR', 1),
  ('qcti-wbfc-2', 'qct-wip-bf-fabcut', 2, 'No tears / fray on cut edges',          NULL, 'MINOR', 1),
  ('qcti-wbfc-3', 'qct-wip-bf-fabcut', 3, 'Correct fabric SKU per BOM',            NULL, 'MAJOR', 1),
  -- Bed Frame — HB Fabric Sew
  ('qcti-wbfs-1', 'qct-wip-bf-fabsew', 1, 'Stitch consistency',                    NULL, 'MAJOR', 1),
  ('qcti-wbfs-2', 'qct-wip-bf-fabsew', 2, 'Seam strength (tug test)',              NULL, 'MAJOR', 1),
  ('qcti-wbfs-3', 'qct-wip-bf-fabsew', 3, 'No loose threads',                      NULL, 'MINOR', 1),
  -- Bed Frame — HB Upholstery
  ('qcti-wbup-1', 'qct-wip-bf-uph', 1, 'HB fabric tension even, no wrinkles',      NULL, 'MAJOR',    1),
  ('qcti-wbup-2', 'qct-wip-bf-uph', 2, 'Pattern aligned across HB',                NULL, 'MAJOR',    1),
  ('qcti-wbup-3', 'qct-wip-bf-uph', 3, 'Foam padding even (no thin spots)',        NULL, 'MAJOR',    1),
  ('qcti-wbup-4', 'qct-wip-bf-uph', 4, 'No staples / pins exposed',                NULL, 'CRITICAL', 1),
  ('qcti-wbup-5', 'qct-wip-bf-uph', 5, 'Tufting / buttons aligned',                NULL, 'MINOR',    1);

-- --- FG templates (OQC) at PACKING ---
INSERT INTO qc_templates (id, name, dept_code, dept_name, item_category, stage, active, notes, created_at) VALUES
  ('qct-fg-sofa', 'Sofa — Outgoing Final Inspection',     'PACKING', 'Packing', 'SOFA',     'FG', 1, 'Pre-shipment final check on sofa FG', CURRENT_TIMESTAMP),
  ('qct-fg-bf',   'Bed Frame — Outgoing Final Inspection', 'PACKING', 'Packing', 'BEDFRAME', 'FG', 1, 'Pre-shipment final check on bed-frame FG', CURRENT_TIMESTAMP);

INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  -- Sofa FG
  ('qcti-fgs-1', 'qct-fg-sofa', 1, 'Overall appearance — no scratches / stains', NULL, 'MAJOR',    1),
  ('qcti-fgs-2', 'qct-fg-sofa', 2, 'Cushions firm + correctly positioned',       NULL, 'MAJOR',    1),
  ('qcti-fgs-3', 'qct-fg-sofa', 3, 'Pattern matches across panels',              NULL, 'MAJOR',    1),
  ('qcti-fgs-4', 'qct-fg-sofa', 4, 'No sharp edges / exposed staples',           NULL, 'CRITICAL', 1),
  ('qcti-fgs-5', 'qct-fg-sofa', 5, 'All accessories present (legs, manual)',     NULL, 'MAJOR',    1),
  ('qcti-fgs-6', 'qct-fg-sofa', 6, 'Packaging (corner foam, plastic wrap) intact', NULL, 'MINOR',  1),
  ('qcti-fgs-7', 'qct-fg-sofa', 7, 'Label matches the SO product code + size',   NULL, 'CRITICAL', 1),
  -- Bed Frame FG
  ('qcti-fgb-1', 'qct-fg-bf', 1, 'Frame square / no warping',                     NULL, 'MAJOR',    1),
  ('qcti-fgb-2', 'qct-fg-bf', 2, 'Headboard upholstery clean + even',             NULL, 'MAJOR',    1),
  ('qcti-fgb-3', 'qct-fg-bf', 3, 'No protruding hardware',                        NULL, 'CRITICAL', 1),
  ('qcti-fgb-4', 'qct-fg-bf', 4, 'All hardware bag complete (screws / wrenches)', NULL, 'MAJOR',    1),
  ('qcti-fgb-5', 'qct-fg-bf', 5, 'Slats secured for transit',                     NULL, 'MAJOR',    1),
  ('qcti-fgb-6', 'qct-fg-bf', 6, 'Packaging intact, corner protectors in place',  NULL, 'MINOR',    1),
  ('qcti-fgb-7', 'qct-fg-bf', 7, 'Label matches the SO product code + size',      NULL, 'CRITICAL', 1);
