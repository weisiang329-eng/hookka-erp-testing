-- ============================================================================
-- Migration 0215 — QC rework: per-receipt IQC, family-routed RM checklists,
--                  and an FG checklist that verifies the unit against its SO.
--
-- OWNER'S MODEL (2026-08-08), which supersedes the day-based RM gate shipped
-- in cc06cf69:
--
--   1. Raw Material 检查 … 基本上是根据进货情况按 batch 来检。只要有了 GR，
--      可能是一张 PI 或者同一天进来的货，我们只需要检查一次 … 总之，原材料
--      这边一定要做到每一 batch 进来都必须抽检，把所有细节全部看一遍。
--   2. WIP 检查 … 这个可能需要每天跟进，比如早上一次、下午一次。
--   3. FG 检查：定期进行抽查，重点看他们有没有做对 order，有没有做错。
--
-- And (2026-08-08) on WHAT to check:
--   "木架要看什么？是看湿度、闻味道，还是检查其他维度？海绵要看什么？布料要
--    看什么？… mechanism 有什么东西是需要检查的？"
--   "你可以看一下我们大部分的供应商都是进的什么货物 … 针对我们是 bedframe
--    或者沙发的生产商，我们的 raw material 基本上都会进什么东西？"
--
-- THREE THINGS HAPPEN HERE
-- ------------------------
-- A. COLUMNS. `qc_templates.material_family` (which incoming-material family a
--    checklist covers) and five columns on `qc_inspections` that carry WHAT an
--    inspection is about: the goods receipt (`source_grn_id` / `source_grn_no`),
--    the family, the sampled finished unit (`source_fg_unit_id`) and a frozen
--    copy of the sales-order line the unit is supposed to satisfy (`so_spec`).
--    NOTE: this file is INERT until `npm run db:migrate:supabase` is run.
--    `ensureQcGenerationSchema()` in src/api/routes/qc-pending.ts self-applies
--    the SAME columns at runtime, which is what actually gets them onto prod.
--
-- B. RM CHECKLIST CONTENT. The four templates seeded by 0068 (fabric / foam /
--    timber / hardware) were thin and left real gaps: PLYWOOD, WEBBING, PACKING
--    and ACCESSORIES had no incoming checklist at all, and plywood was being
--    treated as solid timber even though its failure modes (delamination, core
--    voids, ply count, face grade) are completely different. Every family now
--    has a template, every template is tagged with its family so generation can
--    route a receipt line to it off `raw_materials.item_group`, and every item
--    states a SAMPLE SIZE and something the inspector can WRITE DOWN — a
--    number, a pass/fail, or a comparison against a retained sample. "Looks OK"
--    is not a QC record.
--
-- C. FG CHECKLIST CONTENT. The 0068 FG templates were almost entirely cosmetic
--    and packaging; the single line about the sales order checked the LABEL,
--    not the unit. Seven order-correctness items now come FIRST on both FG
--    templates (product code, size, fabric, configuration, piece count,
--    special-order instructions, customer/hub), and the cosmetic items are
--    re-sequenced to 21+ behind them.
--
-- RE-RUNNABLE. Every INSERT is ON CONFLICT DO NOTHING and every UPDATE sets a
-- literal (never `x = x + n`), so running this twice changes nothing and an
-- item the owner has since edited through the Templates tab is not clobbered.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A. Columns
-- ----------------------------------------------------------------------------
ALTER TABLE qc_templates    ADD COLUMN IF NOT EXISTS material_family   TEXT;
ALTER TABLE qc_inspections  ADD COLUMN IF NOT EXISTS source_grn_id     TEXT;
ALTER TABLE qc_inspections  ADD COLUMN IF NOT EXISTS source_grn_no     TEXT;
ALTER TABLE qc_inspections  ADD COLUMN IF NOT EXISTS material_family   TEXT;
ALTER TABLE qc_inspections  ADD COLUMN IF NOT EXISTS source_fg_unit_id TEXT;
ALTER TABLE qc_inspections  ADD COLUMN IF NOT EXISTS so_spec           TEXT;

-- One inspection per (receipt × family) and per (slot × sampled unit) — the
-- indexes back the idempotency lookups generation does on every run.
CREATE INDEX IF NOT EXISTS idx_qc_inspections_source_grn
  ON qc_inspections(source_grn_id);
CREATE INDEX IF NOT EXISTS idx_qc_inspections_source_fg_unit
  ON qc_inspections(source_fg_unit_id);
CREATE INDEX IF NOT EXISTS idx_qc_templates_material_family
  ON qc_templates(material_family);

-- ----------------------------------------------------------------------------
-- B1. Tag the four templates that already exist with their family.
--     'Incoming Foam Check' becomes the SOFA foam checklist — see the split
--     note below.
-- ----------------------------------------------------------------------------
UPDATE qc_templates SET material_family = 'FABRIC'    WHERE id = 'qct-rm-fabric';
UPDATE qc_templates SET material_family = 'TIMBER'    WHERE id = 'qct-rm-wood';
UPDATE qc_templates SET material_family = 'MECHANISM' WHERE id = 'qct-rm-hardware';
UPDATE qc_templates
   SET material_family = 'SOFA_FOAM',
       name  = 'Incoming Sofa Foam Check',
       notes = 'Density-graded PU foam for sofa seats/backs (item group SOFA-FIL). Bedframe filler is a separate checklist.'
 WHERE id = 'qct-rm-foam';

-- ----------------------------------------------------------------------------
-- B2. The families that had NO incoming checklist at all.
--
--     BEDFRAME vs SOFA: only FOAM/FILLER is split. Sofa foam has a stamped
--     density rating and a rebound spec; bedframe filler is sheet/fibre where
--     the measurables are GSM and loft-after-decompression and a "density
--     rating" does not exist — one checklist would be four N/A answers.
--     Fabric is NOT split (same five observations either grade), and webbing
--     and mechanism cannot be split because both product lines share one item
--     group ('WEBBING' / 'EQUIPMEN') — those templates carry a
--     "matches-the-retained-sample" item instead, which is the check that
--     actually catches a wrong-line delivery.
--
--     'Incoming Goods — General Check' is the fallback for a receipt line whose
--     material master could not be resolved or whose item group is unknown. It
--     exists so no receipt is ever silently uninspected.
-- ----------------------------------------------------------------------------
INSERT INTO qc_templates (id, name, dept_code, dept_name, item_category, stage, active, material_family, notes, created_at) VALUES
  ('qct-rm-plywood',     'Incoming Plywood Check',            'WAREHOUSING', 'Warehousing', 'GENERAL', 'RM', 1, 'PLYWOOD',     'Item group PLYWOOD. Delamination / voids / ply count / face grade — NOT the solid-timber checklist.', CURRENT_TIMESTAMP),
  ('qct-rm-bedfiller',   'Incoming Bedframe Filler Check',    'WAREHOUSING', 'Warehousing', 'GENERAL', 'RM', 1, 'BED_FILLER',  'Item group BED-FILL. Sheet / fibre filler — measured by GSM and loft, not by a density rating.', CURRENT_TIMESTAMP),
  ('qct-rm-webbing',     'Incoming Webbing Check',            'WAREHOUSING', 'Warehousing', 'GENERAL', 'RM', 1, 'WEBBING',     'Item group WEBBING (covers both sofa and bedframe webbing — they share one group).', CURRENT_TIMESTAMP),
  ('qct-rm-packing',     'Incoming Packing Material Check',   'WAREHOUSING', 'Warehousing', 'GENERAL', 'RM', 1, 'PACKING',     'Item group PACKING. Cartons, film, corner protectors, foam sheet.', CURRENT_TIMESTAMP),
  ('qct-rm-accessories', 'Incoming Accessories Check',        'WAREHOUSING', 'Warehousing', 'GENERAL', 'RM', 1, 'ACCESSORIES', 'Item group B.OTHERS that is not wood strip — legs, brackets, studs, buttons, fixings.', CURRENT_TIMESTAMP),
  ('qct-rm-general',     'Incoming Goods — General Check',    'WAREHOUSING', 'Warehousing', 'GENERAL', 'RM', 1, 'GENERAL',     'Fallback when a receipt line has no material master or an unknown item group. Never leave a receipt uninspected.', CURRENT_TIMESTAMP)
ON CONFLICT (id) DO NOTHING;

-- Backfill the family tag if the rows already existed from an earlier run.
UPDATE qc_templates SET material_family = 'PLYWOOD'     WHERE id = 'qct-rm-plywood'     AND material_family IS NULL;
UPDATE qc_templates SET material_family = 'BED_FILLER'  WHERE id = 'qct-rm-bedfiller'   AND material_family IS NULL;
UPDATE qc_templates SET material_family = 'WEBBING'     WHERE id = 'qct-rm-webbing'     AND material_family IS NULL;
UPDATE qc_templates SET material_family = 'PACKING'     WHERE id = 'qct-rm-packing'     AND material_family IS NULL;
UPDATE qc_templates SET material_family = 'ACCESSORIES' WHERE id = 'qct-rm-accessories' AND material_family IS NULL;
UPDATE qc_templates SET material_family = 'GENERAL'     WHERE id = 'qct-rm-general'     AND material_family IS NULL;

-- ----------------------------------------------------------------------------
-- B3. Richer items for the four templates that already existed.
--     The 0068 items are KEPT untouched (sequences 1-4); these extend them.
--     Sample sizes are stated on the item so the inspector does not have to
--     decide how much to look at.
-- ----------------------------------------------------------------------------

-- FABRIC (adds width, dye-lot, abrasion cert, backing, retained swatch)
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-rmf-5', 'qct-rm-fabric', 5, 'Roll width matches PO spec',                      'Tape-measure the width at 3 points on each sampled roll and write down the mm. Accept +/-2cm of the PO width. SAMPLE: 3 rolls per receipt.',                                        'MAJOR',    1),
  ('qcti-rmf-6', 'qct-rm-fabric', 6, 'Dye-lot numbers recorded, one lot per SKU',        'Write every dye-lot / batch number on the receipt. Two lots of the same SKU is a FAIL to record, not to reject — a sofa cut across two lots shows a colour step. SAMPLE: every roll.', 'MAJOR',    1),
  ('qcti-rmf-7', 'qct-rm-fabric', 7, 'Abrasion grade on supplier cert matches PO',       'Write down the Martindale / rub-cycle figure printed on the certificate and compare with the PO. No certificate = FAIL. SAMPLE: one cert per delivery.',                            'MAJOR',    1),
  ('qcti-rmf-8', 'qct-rm-fabric', 8, 'Backing / coating intact, no delamination',        'Fold a corner of each sampled roll back on itself. The backing must not flake, powder or separate. SAMPLE: 3 rolls per receipt.',                                                  'MINOR',    1),
  ('qcti-rmf-9', 'qct-rm-fabric', 9, 'Retained swatch cut and filed against this GRN',   'Cut a 10cm x 10cm swatch per dye-lot, label it with the GRN number and roll number, and file it. This swatch is what every later complaint is judged against. SAMPLE: 1 per dye-lot.', 'MAJOR',   1)
ON CONFLICT (id) DO NOTHING;

-- SOFA FOAM (adds weight-vs-density cross-check, core cut, cell structure, count)
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-rmo-5', 'qct-rm-foam', 5, 'Block weight agrees with the labelled density',  'Weigh one block and divide by its measured volume. The result must land within +/-10% of the density stamped on the block. This is what catches a re-labelled lower-grade block. SAMPLE: 1 block per receipt.', 'MAJOR', 1),
  ('qcti-rmo-6', 'qct-rm-foam', 6, 'No voids, hard spots or burn marks in the core', 'Cut one block through the middle and inspect the cut face. Record what you find. SAMPLE: 1 block per receipt.',                                                                                          'MAJOR', 1),
  ('qcti-rmo-7', 'qct-rm-foam', 7, 'Cell structure even across the cut face',        'On the same cut block: uniform cell size, no collapsed bands or coarse patches. SAMPLE: the cut block.',                                                                                                'MINOR', 1),
  ('qcti-rmo-8', 'qct-rm-foam', 8, 'Block count matches GRN',                        'Count the whole delivery and write down counted vs GRN quantity.',                                                                                                                                       'MINOR', 1)
ON CONFLICT (id) DO NOTHING;

-- TIMBER (adds straightness, insect/borer, square ends, count, kiln cert)
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-rmw-5', 'qct-rm-wood', 5, 'Straightness — bow / spring / twist within 3mm per metre', 'Lay each sampled piece on a flat bench and measure the largest gap underneath. Write down the mm. SAMPLE: 10 pieces per batch.',                                              'MAJOR',    1),
  ('qcti-rmw-6', 'qct-rm-wood', 6, 'No insect holes, borer dust or fungal stain',              'Inspect all four faces and both ends. Tap each piece over white paper and look for frass. Any LIVE infestation fails the whole batch. SAMPLE: 10 pieces per batch.',            'CRITICAL', 1),
  ('qcti-rmw-7', 'qct-rm-wood', 7, 'Ends sawn square and clean',                               'Try-square on both ends; write down the out-of-square mm. SAMPLE: 10 pieces per batch.',                                                                                       'MINOR',    1),
  ('qcti-rmw-8', 'qct-rm-wood', 8, 'Piece count and length match GRN',                         'Count the bundle and tape-measure the length of 10 pieces. Write down counted vs GRN quantity.',                                                                              'MINOR',    1),
  ('qcti-rmw-9', 'qct-rm-wood', 9, 'Kiln-dry / treatment certificate present for this batch',  'Write the certificate number against this GRN. No certificate = FAIL. SAMPLE: one cert per delivery.',                                                                         'MINOR',    1)
ON CONFLICT (id) DO NOTHING;

-- MECHANISM / HARDWARE (adds part number, latch cycle, hole alignment, fixings,
-- plating, handed pairs). The owner asked specifically what a mechanism needs:
-- it is the model number and the CYCLE, not a look.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-rmh-4', 'qct-rm-hardware', 4, 'Model / part number matches the PO',                 'Read the stamp or label and write down the number you see next to the PO number. A near-identical mechanism with a different travel is the classic wrong delivery and it is invisible on a visual check. SAMPLE: 5% per carton, minimum 3 units.', 'CRITICAL', 1),
  ('qcti-rmh-5', 'qct-rm-hardware', 5, 'Locking / latching engages and releases',            'Engage and release each sampled unit 5 times. It must hold under firm hand pressure. Write down how many failed. SAMPLE: 5% per carton, minimum 3 units.',                                                                            'CRITICAL', 1),
  ('qcti-rmh-6', 'qct-rm-hardware', 6, 'Fixing holes line up with the frame drilling',       'Offer sampled units up to a production frame or the drilling jig. Write down any hole out of position. SAMPLE: 3 units per receipt.',                                                                                                  'MAJOR',    1),
  ('qcti-rmh-7', 'qct-rm-hardware', 7, 'Screws / bolts / fixings present in the stated count','Count one fixings bag per carton against the packing list. Write down counted vs stated. SAMPLE: 1 bag per carton.',                                                                                                                 'MAJOR',    1),
  ('qcti-rmh-8', 'qct-rm-hardware', 8, 'Paint / plating even, no bare metal at the folds',   'Bare metal at a fold rusts in the warehouse before the part is ever used. SAMPLE: 5% per carton.',                                                                                                                                    'MINOR',    1),
  ('qcti-rmh-9', 'qct-rm-hardware', 9, 'Left / right handed parts supplied in matching pairs','Count the lefts and the rights separately and write down both numbers. SAMPLE: full delivery.',                                                                                                                                     'MAJOR',    1)
ON CONFLICT (id) DO NOTHING;

-- Restate the sample size on the three 0068 hardware items that had none.
-- Only fills a blank / stale criteria — never overwrites an owner edit.
UPDATE qc_template_items SET criteria = 'Count every carton on the pallet, then count the contents of a sample of cartons. Write down counted vs GRN quantity. SAMPLE: 5% of cartons.'
 WHERE id = 'qcti-rmh-1' AND criteria = 'Spot-count 1 box';
UPDATE qc_template_items SET criteria = 'Cycle each sampled unit through its FULL travel 5 times (recline / fold / lift). Write down any binding, noise or stiff point. SAMPLE: 5% per carton, minimum 3 units.'
 WHERE id = 'qcti-rmh-2' AND criteria = 'Test 3 random units (recline / fold)';
UPDATE qc_template_items SET criteria = 'Visual on the sampled units; check the parts bag against the packing list and write down what is missing. SAMPLE: 5% per carton.'
 WHERE id = 'qcti-rmh-3' AND criteria = 'Visual on full delivery';
UPDATE qc_template_items SET criteria = 'Moisture meter at mid-length (not the end grain). Write down EVERY reading. Any single reading of 14% or more fails the batch. SAMPLE: 10 pieces per batch.'
 WHERE id = 'qcti-rmw-1' AND criteria = 'Use moisture meter on 3 random pieces';
UPDATE qc_template_items SET criteria = 'Visual on all four faces; sight down each length for bow and twist. Write down how many pieces were rejected. SAMPLE: 10 pieces per batch.'
 WHERE id = 'qcti-rmw-2' AND criteria = 'Visual on full bundle';
UPDATE qc_template_items SET criteria = 'Callipers on width and thickness at both ends and mid-length. Write down the mm. SAMPLE: 10 pieces per batch.'
 WHERE id = 'qcti-rmw-3' AND criteria = 'Tape-measure 5 random pieces';
UPDATE qc_template_items SET criteria = 'Read the density rating stamped on each sampled block (e.g. D28 / D32) and compare with the BOM. Write down the figure. SAMPLE: 3 blocks per receipt.'
 WHERE id = 'qcti-rmo-1' AND criteria = 'Spot-check density rating on label';
UPDATE qc_template_items SET criteria = 'Tape-measure L x W x H and write down all three. SAMPLE: 3 blocks per receipt.'
 WHERE id = 'qcti-rmo-2' AND criteria = 'Tape-measure L*W*H';
UPDATE qc_template_items SET criteria = 'Visual plus smell. A strong amine smell means the foam is under-cured. SAMPLE: 3 blocks per receipt.'
 WHERE id = 'qcti-rmo-3' AND criteria = 'Visual + smell';
UPDATE qc_template_items SET criteria = 'Press for 30 seconds with a flat palm, release, and time the recovery. It must return fully within 5 seconds — write down the seconds. SAMPLE: 3 blocks per receipt.'
 WHERE id = 'qcti-rmo-4' AND criteria = 'Press 30s, release — should fully recover';
UPDATE qc_template_items SET criteria = 'Compare EVERY roll against the retained PO swatch in daylight. Write down the roll number of any that differs. SAMPLE: every roll.'
 WHERE id = 'qcti-rmf-1' AND criteria = 'Compare with PO swatch — no visible variation';
UPDATE qc_template_items SET criteria = 'Unroll and inspect the first 2m of every roll. Write down the metre mark of any defect. SAMPLE: every roll.'
 WHERE id = 'qcti-rmf-2' AND criteria = 'Inspect the first 2m of the roll';
UPDATE qc_template_items SET criteria = 'Tape-measure 1 metre and multiply by the reported turns. Write down measured vs GRN metres. Accept +/-2%. SAMPLE: every roll.'
 WHERE id = 'qcti-rmf-3' AND criteria = 'Tape-measure 1 metre, multiply by reported turns';
UPDATE qc_template_items SET criteria = 'No misweaves or skipped picks. SAMPLE: 3 rolls per receipt, 2m unrolled from each.'
 WHERE id = 'qcti-rmf-4' AND criteria = 'No misweaves or skipped picks';

-- ----------------------------------------------------------------------------
-- B4. Items for the six new templates.
-- ----------------------------------------------------------------------------

-- PLYWOOD — the failure modes solid timber does not have.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-rmp-1',  'qct-rm-plywood',  1, 'Thickness within +/-0.5mm of spec',        'Callipers at four corners and the centre. Write down the mm. Plywood is sold at a NOMINAL thickness — measure it, do not read the label. SAMPLE: 5 sheets per receipt.', 'MAJOR',    1),
  ('qcti-rmp-2',  'qct-rm-plywood',  2, 'Sheet size within +/-3mm',                 'Tape-measure length and width and write down the mm. SAMPLE: 5 sheets per receipt.',                                                                                       'MAJOR',    1),
  ('qcti-rmp-3',  'qct-rm-plywood',  3, 'No delamination at edges or corners',      'Try to part the plies by hand at all four edges. A ply that lifts fails the sheet. Write down how many sheets failed. SAMPLE: 5 sheets per receipt.',                     'CRITICAL', 1),
  ('qcti-rmp-4',  'qct-rm-plywood',  4, 'Core voids within limit',                  'Look along all four cut edges and count voids wider than 5mm. More than 2 per edge fails the sheet. Write down the count. SAMPLE: 5 sheets per receipt.',                  'MAJOR',    1),
  ('qcti-rmp-5',  'qct-rm-plywood',  5, 'Face grade matches PO',                    'Compare the face veneer against the PO grade and the retained sample. Write down the grade you see. SAMPLE: every bundle.',                                               'MAJOR',    1),
  ('qcti-rmp-6',  'qct-rm-plywood',  6, 'Ply count matches spec',                   'Count the plies on a cut edge and write down the number. SAMPLE: 5 sheets per receipt.',                                                                                  'MAJOR',    1),
  ('qcti-rmp-7',  'qct-rm-plywood',  7, 'Flat — no warp or cupping',                'Lay the sheet on a flat bench and measure the largest gap underneath. More than 5mm across 1200mm fails. Write down the mm. SAMPLE: 5 sheets per receipt.',               'MAJOR',    1),
  ('qcti-rmp-8',  'qct-rm-plywood',  8, 'Moisture content below 14%',               'Moisture meter on each sampled sheet; write down every reading. Damp plywood delaminates after the frame is assembled. SAMPLE: 5 sheets per receipt.',                    'MAJOR',    1),
  ('qcti-rmp-9',  'qct-rm-plywood',  9, 'Glue bond type matches PO (WBP / MR)',     'Read the stamp and write it down. No stamp = FAIL. SAMPLE: one per bundle.',                                                                                              'MINOR',    1),
  ('qcti-rmp-10', 'qct-rm-plywood', 10, 'Sheet count matches GRN',                  'Count the bundle and write down counted vs GRN quantity.',                                                                                                                'MINOR',    1)
ON CONFLICT (id) DO NOTHING;

-- BEDFRAME FILLER — measured by GSM and loft, not by a density rating.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-rmb-1', 'qct-rm-bedfiller', 1, 'Filler type matches BOM',                    'Compare against the retained reference sample. Fibre wadding, PE foam and PU sheet look similar in a bale and are NOT interchangeable. Write down what the label says. SAMPLE: every bale.', 'CRITICAL', 1),
  ('qcti-rmb-2', 'qct-rm-bedfiller', 2, 'Thickness / loft within +/-5mm',             'Lay flat and unweighted for 10 minutes, then measure at 3 points. Write down the mm. SAMPLE: 3 sheets per receipt.',                                                                        'MAJOR',    1),
  ('qcti-rmb-3', 'qct-rm-bedfiller', 3, 'Weight per square metre (GSM) matches spec', 'Cut a 1m x 1m piece and weigh it. Write down the grams. This is the density measure for fibre filler — there is no stamped density rating. SAMPLE: 1 per receipt.',                          'MAJOR',    1),
  ('qcti-rmb-4', 'qct-rm-bedfiller', 4, 'No damp smell, mould or water staining',     'Smell and inspect the outer wrap AND one inner layer of the bale. Write down which bales were affected. SAMPLE: 3 bales per receipt.',                                                      'MAJOR',    1),
  ('qcti-rmb-5', 'qct-rm-bedfiller', 5, 'Roll / sheet count and length match GRN',    'Count and tape-measure. Write down counted vs GRN quantity. SAMPLE: every roll.',                                                                                                           'MINOR',    1),
  ('qcti-rmb-6', 'qct-rm-bedfiller', 6, 'Recovers from compression set',              'Open the bale and wait 10 minutes. The sheet must return to spec thickness. Write down the before and after mm. SAMPLE: 1 per receipt.',                                                    'MINOR',    1)
ON CONFLICT (id) DO NOTHING;

-- WEBBING — a tension / width / elongation check.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-rmg-1', 'qct-rm-webbing', 1, 'Width within +/-2mm of spec',                      'Tape-measure the width at 3 points on each sampled roll. Write down the mm. SAMPLE: every roll.',                                                                                                            'MAJOR',    1),
  ('qcti-rmg-2', 'qct-rm-webbing', 2, 'Roll length matches GRN',                          'Measure 1m and multiply by the turns, or weigh against a known-good full roll. Write down metres vs GRN quantity. SAMPLE: every roll.',                                                                     'MINOR',    1),
  ('qcti-rmg-3', 'qct-rm-webbing', 3, 'Elongation under load within spec',                'Mark 200mm on a cut length, hang the specified test load, measure again and write down the percentage stretch. Elastic webbing is typically 55-70%. Under-stretch means the seat will feel hard and the frame takes the load. SAMPLE: 1 length per roll.', 'CRITICAL', 1),
  ('qcti-rmg-4', 'qct-rm-webbing', 4, 'Rubber / latex core intact, not perished',         'Bend a 100mm length back on itself. No cracking, powdering or stickiness. SAMPLE: 3 rolls per receipt.',                                                                                                   'MAJOR',    1),
  ('qcti-rmg-5', 'qct-rm-webbing', 5, 'Weave / rib count consistent',                     'Count the ribs across the width at 3 points and write down the number. SAMPLE: 3 rolls per receipt.',                                                                                                       'MINOR',    1),
  ('qcti-rmg-6', 'qct-rm-webbing', 6, 'Type matches the PO and the retained sample',      'Sofa and bedframe webbing share one item group and look alike. Compare against the filed reference sample for THIS product line. SAMPLE: every roll.',                                                     'MAJOR',    1),
  ('qcti-rmg-7', 'qct-rm-webbing', 7, 'No fraying, cuts, or joins part-way along the roll','Unroll 2m from BOTH ends. A joined roll is short and fails silently once it is on the machine. SAMPLE: 3 rolls per receipt.',                                                                             'MAJOR',    1)
ON CONFLICT (id) DO NOTHING;

-- PACKING
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-rmk-1', 'qct-rm-packing', 1, 'Material type and thickness match the PO',     'Callipers on film / foam gauge, or read the flute grade on carton board. Write down what you measured or read. SAMPLE: 5 units per pallet.',                          'MAJOR', 1),
  ('qcti-rmk-2', 'qct-rm-packing', 2, 'Dimensions match spec',                        'Tape-measure L x W (x H) and write down the mm. A carton 10mm under does not close over the product. SAMPLE: 5 units per pallet.',                                    'MAJOR', 1),
  ('qcti-rmk-3', 'qct-rm-packing', 3, 'Printing correct — brand, product, handling',  'Compare against the approved artwork and write down any wrong or missing text. SAMPLE: 5 units per pallet.',                                                            'MAJOR', 1),
  ('qcti-rmk-4', 'qct-rm-packing', 4, 'Quantity matches GRN',                         'Count bundles / rolls and the units per bundle. Write down counted vs GRN quantity.',                                                                                  'MINOR', 1),
  ('qcti-rmk-5', 'qct-rm-packing', 5, 'No tears, damp or crushed edges',              'Visual on the outside of every bundle plus 5 units drawn from INSIDE a bundle. Write down what you found.',                                                            'MAJOR', 1),
  ('qcti-rmk-6', 'qct-rm-packing', 6, 'Film roll width and core size correct',        'Tape-measure the width and the core diameter on every roll and write down the mm.',                                                                                    'MINOR', 1),
  ('qcti-rmk-7', 'qct-rm-packing', 7, 'Seal / adhesive test',                         'Seal two samples, wait 1 minute, then pull them apart. The board must tear before the adhesive lets go. SAMPLE: 2 per delivery.',                                      'MINOR', 1)
ON CONFLICT (id) DO NOTHING;

-- ACCESSORIES (legs, brackets, studs, buttons, fixings)
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-rma-1', 'qct-rm-accessories', 1, 'Item matches the PO code and description',  'Compare against the PO line and the retained sample. Write down the code printed on the packaging. SAMPLE: every carton.',                                    'CRITICAL', 1),
  ('qcti-rma-2', 'qct-rm-accessories', 2, 'Quantity matches GRN',                      'Count every carton, then count the contents of a sample of cartons. Write down counted vs GRN quantity. SAMPLE: 5% of cartons.',                            'MAJOR',    1),
  ('qcti-rma-3', 'qct-rm-accessories', 3, 'Dimensions / thread size match spec',       'Callipers or a thread gauge; write down what you measured. A leg with the wrong thread pitch is scrap at assembly and looks perfect in the box. SAMPLE: 5 units per receipt.', 'MAJOR', 1),
  ('qcti-rma-4', 'qct-rm-accessories', 4, 'Finish even — no rust, chips or scratches', 'Visual on the sampled units; write down how many were rejected. SAMPLE: 5% per carton.',                                                                     'MAJOR',    1),
  ('qcti-rma-5', 'qct-rm-accessories', 5, 'Matched sets complete',                     'For anything supplied as a set (4 legs, hinge pairs), count the complete sets and write down the number. SAMPLE: full delivery.',                            'MAJOR',    1),
  ('qcti-rma-6', 'qct-rm-accessories', 6, 'Moving parts operate through full travel',  'Operate the sampled units and write down how many failed. Mark N/A if nothing on this line moves. SAMPLE: 5 units per receipt.',                             'MAJOR',    0),
  ('qcti-rma-7', 'qct-rm-accessories', 7, 'Load rating sighted on load-bearing parts', 'For legs and brackets, read the stated load rating on the stamp or certificate and write it down. Missing = FAIL. SAMPLE: one per delivery.',                'MAJOR',    1)
ON CONFLICT (id) DO NOTHING;

-- GENERAL fallback
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-rmz-1', 'qct-rm-general', 1, 'Goods match the PO code and description',        'Compare every line on the receipt against the purchase order and write down the code you see on the packaging. SAMPLE: every line.',                       'CRITICAL', 1),
  ('qcti-rmz-2', 'qct-rm-general', 2, 'Quantity matches GRN',                           'Count or weigh each line and write down counted vs GRN quantity.',                                                                                          'MAJOR',    1),
  ('qcti-rmz-3', 'qct-rm-general', 3, 'Packaging intact, no transit damage',            'Visual on the full delivery. Photograph anything damaged BEFORE unloading — after unloading it is our damage.',                                             'MAJOR',    1),
  ('qcti-rmz-4', 'qct-rm-general', 4, 'No damp, rust, mould or contamination',          'Visual plus smell on the full delivery. Write down what you found.',                                                                                        'MAJOR',    1),
  ('qcti-rmz-5', 'qct-rm-general', 5, 'Supplier documents present',                     'Write the supplier DO number and any batch / lot number against this GRN.',                                                                                 'MINOR',    1),
  ('qcti-rmz-6', 'qct-rm-general', 6, 'Say what these goods actually were',             'This receipt did not map to a known material family, which means a material master row is missing or filed under the wrong item group. Write down what the goods are so it can be corrected.', 'MINOR', 0)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- C. FG — verify the unit against the SALES ORDER it was built for.
--
-- Owner 2026-08-08: "重点看他们有没有做对 order，有没有做错". The 0068 FG
-- checklist was appearance, cushions, packaging and one line about the LABEL.
-- A unit can pass every one of those and still be the wrong fabric on the wrong
-- size going to the wrong customer.
--
-- The seven order-correctness items go FIRST (sequence 1-7) and the 0068
-- cosmetic items move behind them (21-27). Sequences are set to literals so
-- re-running this file is a no-op.
-- ----------------------------------------------------------------------------
UPDATE qc_template_items SET sequence = 21 WHERE id IN ('qcti-fgs-1', 'qcti-fgb-1');
UPDATE qc_template_items SET sequence = 22 WHERE id IN ('qcti-fgs-2', 'qcti-fgb-2');
UPDATE qc_template_items SET sequence = 23 WHERE id IN ('qcti-fgs-3', 'qcti-fgb-3');
UPDATE qc_template_items SET sequence = 24 WHERE id IN ('qcti-fgs-4', 'qcti-fgb-4');
UPDATE qc_template_items SET sequence = 25 WHERE id IN ('qcti-fgs-5', 'qcti-fgb-5');
UPDATE qc_template_items SET sequence = 26 WHERE id IN ('qcti-fgs-6', 'qcti-fgb-6');
UPDATE qc_template_items SET sequence = 27 WHERE id IN ('qcti-fgs-7', 'qcti-fgb-7');

INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-fgs-so1', 'qct-fg-sofa', 1, 'Product code on the unit matches the SO line',        'Read the code on the packing label AND on the unit tag, then compare both with the sales-order line shown on this inspection. Write down both codes. A mismatch stops the unit here.', 'CRITICAL', 1),
  ('qcti-fgs-so2', 'qct-fg-sofa', 2, 'Size matches the SO line size',                       'Tape-measure the overall width and depth and write down the mm, then compare with the size on the sales-order line. Do not read it off the label — the label is what we are checking.', 'CRITICAL', 1),
  ('qcti-fgs-so3', 'qct-fg-sofa', 3, 'Fabric code and colour match the SO line',            'Compare the unit against the retained swatch for the sales-order fabric code, in daylight. Check reversible cushions on both faces. Write down the code you see.',              'CRITICAL', 1),
  ('qcti-fgs-so4', 'qct-fg-sofa', 4, 'Configuration matches the SO — chaise side, legs',    'Compare against the sales-order line options: chaise left or right, leg height, arm style. Write down what you SEE, not what you expect.',                                        'CRITICAL', 1),
  ('qcti-fgs-so5', 'qct-fg-sofa', 5, 'All pieces of this unit are present and same serial', 'Count the pieces against the "piece N of M" on the labels and confirm every piece carries the same unit serial. Write down N of M.',                                              'CRITICAL', 1),
  ('qcti-fgs-so6', 'qct-fg-sofa', 6, 'Special-order instructions on the SO line are done',  'Read the sales-order line special-order / notes field and confirm each instruction on the unit. Write down which. Mark N/A if the field is blank.',                               'MAJOR',    0),
  ('qcti-fgs-so7', 'qct-fg-sofa', 7, 'Customer and delivery hub on the label match the SO', 'Compare the label against the sales-order header. A correct sofa on the wrong lorry is still a failure, and it is the most expensive one to undo.',                                'MAJOR',    1),
  ('qcti-fgb-so1', 'qct-fg-bf',   1, 'Product code on the unit matches the SO line',        'Read the code on the packing label AND on the unit tag, then compare both with the sales-order line shown on this inspection. Write down both codes. A mismatch stops the unit here.', 'CRITICAL', 1),
  ('qcti-fgb-so2', 'qct-fg-bf',   2, 'Bed size matches the SO line size',                   'Tape-measure the internal frame width and length and write down the mm, then compare with the size on the sales-order line (S / Q / K). A queen frame in a king box is invisible until delivery.', 'CRITICAL', 1),
  ('qcti-fgb-so3', 'qct-fg-bf',   3, 'Headboard fabric code and colour match the SO line',  'Compare against the retained swatch for the sales-order fabric code, in daylight. Write down the code you see.',                                                                   'CRITICAL', 1),
  ('qcti-fgb-so4', 'qct-fg-bf',   4, 'Configuration matches the SO — HB height, divan, legs','Compare against the sales-order line options: headboard height, divan height, leg height, storage or plain. Write down what you SEE.',                                            'CRITICAL', 1),
  ('qcti-fgb-so5', 'qct-fg-bf',   5, 'All pieces of this unit are present and same serial', 'Headboard, divan and base ship as separate pieces. Count against "piece N of M" and confirm one shared unit serial. Write down N of M.',                                           'CRITICAL', 1),
  ('qcti-fgb-so6', 'qct-fg-bf',   6, 'Special-order instructions on the SO line are done',  'Read the sales-order line special-order / notes field and confirm each instruction on the unit. Write down which. Mark N/A if the field is blank.',                               'MAJOR',    0),
  ('qcti-fgb-so7', 'qct-fg-bf',   7, 'Customer and delivery hub on the label match the SO', 'Compare the label against the sales-order header.',                                                                                                                               'MAJOR',    1)
ON CONFLICT (id) DO NOTHING;

UPDATE qc_templates
   SET notes = 'Periodic sampling of finished units. The unit is drawn for you and named on the inspection — check it against ITS sales-order line first, cosmetics second.'
 WHERE id IN ('qct-fg-sofa', 'qct-fg-bf');
