-- ============================================================================
-- Migration 0217 — the FOURTH rhythm: a daily check on the material actually
--                  being USED, not only on the material arriving.
--
-- OWNER 2026-08-08, after seeing the incoming work:
--
--   "所以基本上就是有货到他才有工作，没有货到他就没有工作，这个是 RM 管理和
--    到货检查。可是有一些东西还是要 daily 检查的，以确保那些货物没有问题。
--    例如我们讲的木头，那天用的木头有没有发霉？还有海绵，那天用的海绵有没有
--    问题？"
--
-- He is right, and it is a GAP, not a refinement. Everything 0215/0216 built is
-- INCOMING: no delivery, no inspection. Meanwhile the timber that passed at 12%
-- moisture in June sits in a Malaysian warehouse through the monsoon and is
-- mouldy in August; foam yellows and takes a compression set under its own
-- stack; fabric mildews on the roll ends; hardware rusts.
--
-- THE TRIGGER IS THE ISSUE, NOT THE RACK. Generation fires on `cost_ledger`
-- RM_ISSUE rows dated today, which name the exact `rm_batches` row FIFO
-- consumed. That is what makes the check run on a day with no deliveries, and
-- it puts the check on the batch about to be built into a customer's sofa
-- rather than on whatever the inspector walks past. The inspection carries the
-- batch, its DAYS IN STORE, and the goods receipt it originally arrived on.
--
-- IT IS A KIND OF RM CHECK, NOT A FOURTH `stage`. `stage` carries a CHECK
-- constraint and a TypeScript union that reach the worker portal, the shared
-- completion core and every list filter, and a stored-material check behaves
-- exactly like an RM check in all of them. `rm_check_kind` ('INCOMING' /
-- 'STORED') is what keeps the two sets of templates apart.
--
-- WORDING IS DELIBERATELY SHARED WITH THE INCOMING TEMPLATES wherever the same
-- defect can arise both ways (mould, damp, moisture, rust), so that comparing
-- the arrival answer with the storage answer actually means something.
--
-- NOTE: this file is INERT until `npm run db:migrate:supabase` is run.
-- `ensureQcGenerationSchema()` self-applies the COLUMNS at runtime; the
-- TEMPLATE CONTENT below is data and only reaches a database through this file.
-- Every INSERT is ON CONFLICT DO NOTHING and every UPDATE sets a literal, so
-- re-running is a no-op and an owner edit is never clobbered.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A. Columns
-- ----------------------------------------------------------------------------
ALTER TABLE qc_templates   ADD COLUMN IF NOT EXISTS rm_check_kind         TEXT;
ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS rm_check_kind         TEXT;
ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS source_rm_batch_id    TEXT;
ALTER TABLE qc_inspections ADD COLUMN IF NOT EXISTS source_batch_age_days INTEGER;

CREATE INDEX IF NOT EXISTS idx_qc_inspections_stored
  ON qc_inspections(rm_check_kind, inspection_date);

-- Everything that existed before this file is an INCOMING check.
UPDATE qc_templates   SET rm_check_kind = 'INCOMING' WHERE stage = 'RM' AND rm_check_kind IS NULL;
UPDATE qc_inspections SET rm_check_kind = 'INCOMING' WHERE stage = 'RM' AND rm_check_kind IS NULL;

-- ----------------------------------------------------------------------------
-- B. The STORED templates.
--
-- NOT one per family — what degrades in a rack is not what varies at the
-- loading bay:
--   • Sofa foam and bedframe filler SHARE one list. Incoming they are split
--     because the measurables differ (a stamped density rating vs. GSM and
--     loft); in store both fail the same five ways, so one list is five real
--     answers instead of two lists of three.
--   • Accessories share the hardware list: rust, pitting, dried grease.
--   • Packing falls to the general stored list, which is also the fallback so
--     no issued batch is silently unchecked.
--   • The store-condition list is raised ONCE A DAY, not per family and not per
--     batch. It is about the building and about FIFO, which is what removes
--     most of the per-family causes at source.
-- ----------------------------------------------------------------------------
INSERT INTO qc_templates (id, name, dept_code, dept_name, item_category, stage, active, material_family, rm_check_kind, notes, created_at) VALUES
  ('qct-st-timber',    'Stored Timber Check',            'WAREHOUSING', 'Warehousing', 'GENERAL', 'RM', 1, 'TIMBER',     'STORED', 'Daily, on the timber batch actually drawn for production. Mould, re-checked moisture, movement since receipt, borer.', CURRENT_TIMESTAMP),
  ('qct-st-plywood',   'Stored Plywood Check',           'WAREHOUSING', 'Warehousing', 'GENERAL', 'RM', 1, 'PLYWOOD',    'STORED', 'Daily, on the plywood batch drawn. Edge delamination and warp are the storage failures, not the arrival ones.', CURRENT_TIMESTAMP),
  ('qct-st-foam',      'Stored Foam / Filler Check',     'WAREHOUSING', 'Warehousing', 'GENERAL', 'RM', 1, 'SOFA_FOAM',  'STORED', 'Daily, covers BOTH sofa foam and bedframe filler — in store they fail the same five ways.', CURRENT_TIMESTAMP),
  ('qct-st-fabric',    'Stored Fabric Check',            'WAREHOUSING', 'Warehousing', 'GENERAL', 'RM', 1, 'FABRIC',     'STORED', 'Daily, on the roll drawn. Mildew at the roll ends and fade on the outer layer are real causes of panel mismatch.', CURRENT_TIMESTAMP),
  ('qct-st-webbing',   'Stored Webbing Check',           'WAREHOUSING', 'Warehousing', 'GENERAL', 'RM', 1, 'WEBBING',    'STORED', 'Daily, on the roll drawn. Rubber perishes on the shelf long before it looks wrong.', CURRENT_TIMESTAMP),
  ('qct-st-hardware',  'Stored Hardware / Mechanism Check','WAREHOUSING','Warehousing','GENERAL', 'RM', 1, 'MECHANISM',  'STORED', 'Daily, on the carton drawn. Covers accessories too. Rust and dried grease are the rainy-season failures.', CURRENT_TIMESTAMP),
  ('qct-st-general',   'Stored Goods — General Check',   'WAREHOUSING', 'Warehousing', 'GENERAL', 'RM', 1, 'GENERAL',    'STORED', 'Fallback for any issued batch whose family has no stored list of its own (packing, unmapped item groups).', CURRENT_TIMESTAMP),
  ('qct-st-warehouse', 'Raw Material Store Condition',   'WAREHOUSING', 'Warehousing', 'GENERAL', 'RM', 1, NULL,         'STORED', 'ONCE A DAY, not per batch. The building, the stacking, and whether FIFO is actually being followed.', CURRENT_TIMESTAMP)
ON CONFLICT (id) DO NOTHING;

-- Backfill the tags if the rows already existed from an earlier partial run.
UPDATE qc_templates SET rm_check_kind = 'STORED' WHERE id LIKE 'qct-st-%' AND rm_check_kind <> 'STORED';
UPDATE qc_templates SET material_family = 'TIMBER'    WHERE id = 'qct-st-timber'   AND material_family IS NULL;
UPDATE qc_templates SET material_family = 'PLYWOOD'   WHERE id = 'qct-st-plywood'  AND material_family IS NULL;
UPDATE qc_templates SET material_family = 'SOFA_FOAM' WHERE id = 'qct-st-foam'     AND material_family IS NULL;
UPDATE qc_templates SET material_family = 'FABRIC'    WHERE id = 'qct-st-fabric'   AND material_family IS NULL;
UPDATE qc_templates SET material_family = 'WEBBING'   WHERE id = 'qct-st-webbing'  AND material_family IS NULL;
UPDATE qc_templates SET material_family = 'MECHANISM' WHERE id = 'qct-st-hardware' AND material_family IS NULL;
UPDATE qc_templates SET material_family = 'GENERAL'   WHERE id = 'qct-st-general'  AND material_family IS NULL;

-- ----------------------------------------------------------------------------
-- C. Items. Every one is something an inspector can OBSERVE and RECORD, and
--    every one is about THIS batch, whose age is printed on the inspection.
-- ----------------------------------------------------------------------------

-- TIMBER in store — mould, moisture again, movement, borer.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-stw-1', 'qct-st-timber', 1, 'No mould on faces or ends',                       'Look for black spotting and white bloom, on the ENDS as well as the faces and on the pieces at the bottom of the stack. Write down how many pieces of the sample are affected. Any mould on a piece about to be framed fails the batch.', 'CRITICAL', 1),
  ('qcti-stw-2', 'qct-st-timber', 2, 'Moisture re-measured on stock over 1 month old',  'Moisture meter at mid-length (not the end grain), same as on arrival. Write down EVERY reading. Any single reading of 14% or more fails the batch. Do this whenever the batch age shown on this inspection is over ~30 days, or it has rained heavily. SAMPLE: 5 pieces from this batch.', 'MAJOR', 1),
  ('qcti-stw-3', 'qct-st-timber', 3, 'No new bow, spring or twist since receipt',       'Lay each sampled piece on a flat bench and measure the largest gap underneath. Write down the mm and compare with the 3mm-per-metre limit used on arrival. Timber moves in store — this is the check the arrival one cannot do. SAMPLE: 5 pieces.', 'MAJOR', 1),
  ('qcti-stw-4', 'qct-st-timber', 4, 'No insect holes, borer dust or fungal stain',     'Inspect all four faces and both ends. Tap each piece over white paper and look for frass. Any LIVE infestation fails the whole batch and the stack around it. SAMPLE: 5 pieces.', 'CRITICAL', 1),
  ('qcti-stw-5', 'qct-st-timber', 5, 'No damp staining or water marks on the stack',    'Look at the bottom two layers and at anything against a wall. Write down where the damp is, not just that it exists — it names the leak.', 'MAJOR', 1),
  ('qcti-stw-6', 'qct-st-timber', 6, 'Batch age is acceptable for the model being built','The age of this batch is printed on this inspection. If it is over 6 months, say so in the notes and flag it to production before it is cut.', 'MINOR', 1)
ON CONFLICT (id) DO NOTHING;

-- PLYWOOD in store.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-stp-1', 'qct-st-plywood', 1, 'No delamination at edges or corners',        'Try to part the plies by hand at all four edges, same test as on arrival. A ply that lifts fails the sheet. Write down how many of the sample failed. SAMPLE: 5 sheets from this batch.', 'CRITICAL', 1),
  ('qcti-stp-2', 'qct-st-plywood', 2, 'No mould on faces or edges',                 'Black spotting or white bloom, especially on sheets stored flat against the floor or a wall. Write down how many sheets are affected.', 'CRITICAL', 1),
  ('qcti-stp-3', 'qct-st-plywood', 3, 'Moisture below 14%',                         'Moisture meter on each sampled sheet; write down every reading. Damp plywood delaminates after the frame is assembled — which is the most expensive place to find it. SAMPLE: 5 sheets.', 'MAJOR', 1),
  ('qcti-stp-4', 'qct-st-plywood', 4, 'Still flat — no warp or cupping in store',    'Lay the sheet on a flat bench and measure the largest gap underneath. More than 5mm across 1200mm fails. Write down the mm. SAMPLE: 5 sheets.', 'MAJOR', 1),
  ('qcti-stp-5', 'qct-st-plywood', 5, 'Stored flat and off the floor',              'Sheets stored on edge or directly on concrete are how the two failures above happen. Write down what you found.', 'MINOR', 1)
ON CONFLICT (id) DO NOTHING;

-- FOAM / FILLER in store — one list for both, see the note above.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-sto-1', 'qct-st-foam', 1, 'Colour compared against the retained sample',      'Hold a block from this batch against the retained reference sample in daylight. Yellowing is normal with age; a block noticeably darker than the sample must not go into a light-fabric unit. Write down whether it matches, and how old this batch is.', 'MAJOR', 1),
  ('qcti-sto-2', 'qct-st-foam', 2, 'Recovers from compression set',                    'Take a block from the BOTTOM of the stack. Measure its thickness, then measure again after 10 minutes off the stack. It must return to within 5% of spec — write down both figures and the minutes it took. This is what stacking does to stock that sat too long.', 'MAJOR', 1),
  ('qcti-sto-3', 'qct-st-foam', 3, 'No damp or musty smell',                           'Smell the cut face, not the wrapper. A musty smell means the block has been damp and will smell in the customer''s living room. Write down which blocks.', 'CRITICAL', 1),
  ('qcti-sto-4', 'qct-st-foam', 4, 'No surface mould',                                 'Inspect the outer faces and one INNER block of the stack. Write down how many blocks are affected. Any mould fails the batch.', 'CRITICAL', 1),
  ('qcti-sto-5', 'qct-st-foam', 5, 'Cut faces not crumbling or powdering',              'Rub a cut face firmly with a flat palm. Old or heat-aged foam sheds. Write down what you see on your hand. SAMPLE: 2 blocks.', 'MAJOR', 1),
  ('qcti-sto-6', 'qct-st-foam', 6, 'Still recovers within 5 seconds after 30s press',   'Same rebound test as on arrival: press for 30 seconds with a flat palm, release, and time the recovery. Write down the seconds and compare with the arrival record. SAMPLE: 2 blocks.', 'MAJOR', 1)
ON CONFLICT (id) DO NOTHING;

-- FABRIC in store.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-stf-1', 'qct-st-fabric', 1, 'No mildew spotting on the outer wrap or roll ends', 'Unwrap and inspect the outer layer AND both ends of the roll — that is where it starts. Write down the roll number of anything affected. Mildew fails the roll.', 'CRITICAL', 1),
  ('qcti-stf-2', 'qct-st-fabric', 2, 'Roll is dry to the touch',                          'Press a flat palm on the outer layer and on one layer 2m in. Damp fabric will mildew even if it looks clean today. Write down what you found.', 'MAJOR', 1),
  ('qcti-stf-3', 'qct-st-fabric', 3, 'Colour still matches the retained swatch',          'Compare against the retained GRN swatch in daylight — the same swatch cut on arrival. Fade in store is a real cause of panel mismatch on a two-piece set. Write down whether it matches.', 'CRITICAL', 1),
  ('qcti-stf-4', 'qct-st-fabric', 4, 'No fade on the OUTERMOST layer',                    'Unroll 1m and compare the outer layer against fabric from inside the roll. Rolls stored near a window or a roller door fade on the outside only, which is invisible until it is cut. Write down what you see.', 'MAJOR', 1),
  ('qcti-stf-5', 'qct-st-fabric', 5, 'No rodent or insect damage',                        'Look for gnaw marks, droppings and nesting at the roll ends and under the rack. Write down what you found and where.', 'MAJOR', 1),
  ('qcti-stf-6', 'qct-st-fabric', 6, 'Stored off the floor and not against a wall',       'Write down which rolls were not. This is the cause of most of the above.', 'MINOR', 1)
ON CONFLICT (id) DO NOTHING;

-- WEBBING in store.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-stg-1', 'qct-st-webbing', 1, 'Elasticity compared against a new length', 'Mark 200mm on a cut length from this batch and on a length from the newest roll in store, hang the same load on both, and write down BOTH stretch figures. Perished webbing has lost stretch and puts the load on the frame.', 'CRITICAL', 1),
  ('qcti-stg-2', 'qct-st-webbing', 2, 'Rubber / latex core not perished',         'Bend a 100mm length back on itself. No cracking, powdering or stickiness. Stickiness is the one that only appears with age. Write down what you found.', 'MAJOR', 1),
  ('qcti-stg-3', 'qct-st-webbing', 3, 'Roll dry, no surface mould',               'Inspect and feel the outer turns and both roll faces. Write down which rolls are affected.', 'MAJOR', 1),
  ('qcti-stg-4', 'qct-st-webbing', 4, 'No fraying at the roll ends',              'Write down the roll number of anything fraying.', 'MINOR', 1)
ON CONFLICT (id) DO NOTHING;

-- HARDWARE / MECHANISM in store (also covers accessories).
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-sth-1', 'qct-st-hardware', 1, 'No rust or pitting',                            'Inspect the sampled units including the folds and any bare-metal edge. Rust is worst in the rainy season and on the bottom carton of a stack. Write down how many of the sample are affected. SAMPLE: 5 units from this batch.', 'MAJOR', 1),
  ('qcti-sth-2', 'qct-st-hardware', 2, 'Grease still present and not dried or gummy',   'Touch the pivot points. Grease that has dried or gone sticky makes the mechanism stiff for the customer, not for you. Write down what you found. SAMPLE: 5 units.', 'MAJOR', 1),
  ('qcti-sth-3', 'qct-st-hardware', 3, 'Cycles smoothly through its FULL travel',       'Cycle each sampled unit 5 times through the whole travel, same test as on arrival. Write down any binding, noise or stiff point. SAMPLE: 3 units.', 'CRITICAL', 1),
  ('qcti-sth-4', 'qct-st-hardware', 4, 'Locking / latching still engages and releases', 'Engage and release 5 times; it must hold under firm hand pressure. Write down how many failed. SAMPLE: 3 units. Mark N/A if nothing on this batch latches.', 'CRITICAL', 0),
  ('qcti-sth-5', 'qct-st-hardware', 5, 'Cartons dry and undamaged',                     'A crushed or damp carton at the bottom of a stack is where the rust above comes from. Write down what you found.', 'MINOR', 1)
ON CONFLICT (id) DO NOTHING;

-- GENERAL stored fallback.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-stz-1', 'qct-st-general', 1, 'No damp, mould or water staining',   'Inspect and smell the batch, including whatever is under it. Write down what you found and where.', 'MAJOR', 1),
  ('qcti-stz-2', 'qct-st-general', 2, 'No rust, vermin or transit damage',  'Write down what you found.', 'MAJOR', 1),
  ('qcti-stz-3', 'qct-st-general', 3, 'Still fit for the job it is drawn for', 'Compare against the retained sample or the BOM. Write down whether it is usable as-is.', 'MAJOR', 1),
  ('qcti-stz-4', 'qct-st-general', 4, 'Say what these goods actually were',  'This batch had no stored checklist of its own, which usually means the material master is filed under an unmapped item group. Write down what the goods are so it can be corrected.', 'MINOR', 0)
ON CONFLICT (id) DO NOTHING;

-- STORE CONDITION — once a day, about the building and about FIFO.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-stc-1', 'qct-st-warehouse', 1, 'No roof leak or standing water',            'Walk the store including the corners and behind the stacks. Write down the location of any drip mark, damp patch or puddle — the location is the finding, not the fact.', 'CRITICAL', 1),
  ('qcti-stc-2', 'qct-st-warehouse', 2, 'Stock is off the floor and clear of walls', 'Everything on pallets or racking, with a gap to the wall. Write down how many stacks were not. This single item prevents most damp and mould findings on the family checklists.', 'MAJOR', 1),
  ('qcti-stc-3', 'qct-st-warehouse', 3, 'Stack heights not crushing what is underneath', 'Look at the BOTTOM layer of each stack — foam compressed flat, cartons bowed, sheets cupped. Write down which stacks and how many layers high.', 'MAJOR', 1),
  ('qcti-stc-4', 'qct-st-warehouse', 4, 'FIFO followed — oldest batch drawn first',  'For two of the materials issued today, check whether an OLDER batch of the same material is still sitting in the racks. Write down the material code and both received dates. Getting this right removes the causes of most of the storage failures above.', 'MAJOR', 1),
  ('qcti-stc-5', 'qct-st-warehouse', 5, 'Aisles clear and batches identifiable',     'Every pallet must carry a readable batch / GRN label, or the checks above cannot name what they found. Write down how many were unlabelled.', 'MINOR', 1),
  ('qcti-stc-6', 'qct-st-warehouse', 6, 'No sign of vermin or insect activity',      'Droppings, gnaw marks, nesting. Write down where.', 'MAJOR', 1)
ON CONFLICT (id) DO NOTHING;
