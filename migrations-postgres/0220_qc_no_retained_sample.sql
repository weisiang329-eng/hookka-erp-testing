-- ---------------------------------------------------------------------------
-- 0220 — remove every QC criterion that depends on a RETAINED SAMPLE.
--
-- Owner 2026-08-08: "留样登记应该就不需要了，因为我们正常都不会做留样登记的."
--
-- There is no retained-sample, swatch or golden-sample table anywhere in this
-- database. The only two tables with "sample" in the name are
-- `po_scan_samples` / `supplier_scan_samples`, which are OCR training data for
-- the document scanner and have nothing to do with quality. So the factory
-- keeps no filed reference for anything, and never has.
--
-- Seventeen seeded criteria (0215 / 0217 / 0219) told the inspector to compare
-- the goods against that reference. Every one of them is therefore
-- UNEXECUTABLE — and an unexecutable standard is exactly the fault the whole
-- 2026-08-08 rebuild was spent removing: an item nobody can answer is an item
-- everybody learns to tick, which is how 3,009 inspections sat PENDING for
-- three months.
--
-- Each one is re-stated as something answerable with ONLY the goods, the
-- paperwork and the inspector's own eyes. Four replacement strategies, chosen
-- per item and for a reason:
--
--   (a) THE PAPERWORK — the PO line, the BOM, the sales-order line, the spec
--       drawing / cutting marker. Used wherever the question is really "is
--       this the thing we ordered?" (fabric colour on receipt, plywood face
--       grade, bed filler type, webbing type, accessories, FG-vs-SO fabric).
--       The document already exists, is already in the inspector's hand, and
--       is what a supplier claim is argued from.
--   (b) THE DELIVERY AGAINST ITSELF — roll to roll, panel to panel, sheet to
--       sheet. Catches the failure a filed swatch was really there to catch
--       (a colour step inside one job) and needs nothing but the goods.
--   (c) THE PREVIOUS BATCH STILL IN THE RACK — the newest foam, an older roll
--       of the same code, a sheet from the last bundle. This is the honest
--       version of "compare with the reference": the reference is whatever is
--       physically still here, and the item says to mark N/A when nothing is.
--   (d) AN ABSOLUTE, MEASURED DESCRIPTION — mm, a count, a hand test that
--       distinguishes two materials (tear a corner; pull 200mm). Used where
--       there is no honest comparator at all: elastic vs non-elastic webbing,
--       fibre vs PE vs PU filler, foam yellowing (the block's own fresh inner
--       face is its reference).
--
-- Where a REPLACEMENT DUPLICATED AN EXISTING ITEM the item was re-pointed
-- rather than softened — `qcti-rmf-9` was "cut and file a retained swatch",
-- an instruction to perform a registration this factory does not do, and is
-- now shade continuity against the roll already in the rack, which is a
-- genuinely different question from `qcti-rmf-1` (within-delivery match).
-- Likewise `qcti-stf-3` moved to the dye-lot in the rack because comparing the
-- outer layer of a roll with its inner layer is already `qcti-stf-4`.
--
-- Every statement is guarded on the row STILL depending on a retained sample:
-- if the owner has already edited an item by hand, or this file has already
-- been run, nothing happens. Prod was seeded from 0215-0219 on 2026-08-08, so
-- these same statements are handed to the owner to run directly — a migration
-- file alone is inert in this repo.
--
-- The verification query is at the bottom of this file. After running, it must
-- return zero rows. `tests/qc-no-retained-sample.test.mjs` asserts the same
-- thing against the migration content so it cannot regress in the seed.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- A. INCOMING (IQC) — mig 0215
-- ============================================================================

-- FABRIC, colour on receipt. Strategy (a) + (b): the label states what the
-- supplier says they sent, the PO states what we asked for, and the rolls of
-- one code must match EACH OTHER — which is the mismatch that actually reaches
-- a customer, because a sofa is cut across several rolls.
UPDATE qc_template_items
   SET criteria = 'Read the colour / shade name and the dye-lot printed on the label of EVERY roll and write them down against the fabric code on the PO line — the label is the supplier''s own statement of what they sent. Then unroll about 1m from every roll of the same code, lay them side by side in daylight, and confirm they match EACH OTHER. Write down the roll number of anything that differs. SAMPLE: every roll.'
 WHERE id = 'qcti-rmf-1'
   AND (criteria ILIKE '%retain%' OR criteria ILIKE '%swatch%');

-- FABRIC, the swatch-filing item itself. This one did not merely REFER to a
-- retained sample, it INSTRUCTED the inspector to create one — a registration
-- this factory does not do, so it was a mandatory MAJOR item that was never
-- going to be performed. Re-pointed at strategy (c): the continuity check
-- between deliveries, which is what the file of swatches was supposed to make
-- possible and which the rack can answer today.
UPDATE qc_template_items
   SET item_name = 'Shade continuity against the same fabric already in store',
       criteria  = 'Find a roll of the SAME fabric code already in the rack from an earlier delivery, lay 1m of it beside 1m of a new roll in daylight, and write down BOTH dye-lot numbers and whether they match. A step between deliveries is what shows up months later when a customer orders a matching piece. Mark N/A if this code has never been delivered before, and say so in the notes. SAMPLE: 1 new roll against 1 old roll.'
 WHERE id = 'qcti-rmf-9'
   AND (criteria ILIKE '%retain%' OR criteria ILIKE '%swatch%' OR item_name ILIKE '%retain%' OR item_name ILIKE '%swatch%');

-- PLYWOOD face grade. Strategy (a) + (d): a grade is a defect ALLOWANCE, so
-- counting the defects on the face is the grade, and it can be written down.
UPDATE qc_template_items
   SET criteria = 'Read the grade stamped or stated on the bundle and write it down against the PO grade. Then count, on one face, the open knots, plugs and patches wider than 20mm and write down the count — that count is what the grade means. If sheets of the same grade from an earlier delivery are still in the rack, put one face to face with a new one. SAMPLE: every bundle.'
 WHERE id = 'qcti-rmp-5'
   AND (criteria ILIKE '%retain%' OR criteria ILIKE '%swatch%' OR criteria ILIKE '%reference sample%');

-- BED FILLER type. Strategy (a) + (d). The label is one of the things being
-- checked, so the hand test has to be able to stand alone.
UPDATE qc_template_items
   SET criteria = 'Read the label on the bale, write down the material it states, and compare it with the filler named on the PO line / BOM. Then confirm it by hand, because the label is itself one of the things being checked: tear a corner — fibre wadding pulls apart in strands, PE foam is closed-cell and squeaks when rubbed, PU sheet is open-cell and springs back. Write down which of the three you actually have. They look alike in a bale and are NOT interchangeable. SAMPLE: every bale.'
 WHERE id = 'qcti-rmb-1'
   AND (criteria ILIKE '%retain%' OR criteria ILIKE '%reference sample%');

-- WEBBING type. Sofa and bedframe webbing share one item group so the DATA
-- cannot route them apart — that is why this item existed at all. Strategy
-- (a) + (d): the PO line names the type, and a 200mm pull tells elastic from
-- non-elastic without any reference to compare against.
UPDATE qc_template_items
   SET item_name = 'Type matches the PO — elastic and non-elastic told apart',
       criteria  = 'Sofa and bedframe webbing share one item group and look alike on the roll, so the PO line is the standard. Read the type / part code printed on the roll or its label and write it down against the PO line. Then confirm it by hand: pull a 200mm length — elastic webbing stretches visibly and springs back, non-elastic barely moves. Write down which one you have. SAMPLE: every roll.'
 WHERE id = 'qcti-rmg-6'
   AND (criteria ILIKE '%retain%' OR criteria ILIKE '%reference sample%' OR item_name ILIKE '%retain%');

-- ACCESSORIES. Strategy (a) + (d).
UPDATE qc_template_items
   SET criteria = 'Write down the code printed on the packaging AND the code on the part itself, next to the code on the PO line. Where the part carries no code, measure it instead — length, thread size, finish — and write down what the PO line asks for beside what you measured. SAMPLE: every carton.'
 WHERE id = 'qcti-rma-1'
   AND (criteria ILIKE '%retain%' OR criteria ILIKE '%reference sample%');

-- ============================================================================
-- B. FINISHED UNITS (OQC) — mig 0215
-- ============================================================================

-- SOFA fabric vs the sales order. Strategy (a) + (b): the SO line is already
-- printed on this inspection, and the unit has to agree with ITSELF — a shade
-- or nap step between panels of one sofa is a rejection on delivery.
UPDATE qc_template_items
   SET criteria = 'Read the fabric code on the unit tag and on the cutting docket and write it down next to the fabric code on the sales-order line shown on this inspection. Then check the unit against ITSELF in daylight: every panel, both faces of every reversible cushion, and any other piece of the same order must be the same shade with the nap running the same way. Write down the code you see and any panel that differs.'
 WHERE id = 'qcti-fgs-so3'
   AND (criteria ILIKE '%retain%' OR criteria ILIKE '%swatch%');

-- BED FRAME headboard fabric vs the sales order. Same strategy; the divan and
-- base of the same order are the comparator that is guaranteed to be present.
UPDATE qc_template_items
   SET criteria = 'Read the fabric code on the unit tag and on the cutting docket and write it down next to the fabric code on the sales-order line shown on this inspection. Then compare the headboard against the divan and base of the same order in daylight — they are cut from one code and must not show a shade step. Write down the code you see.'
 WHERE id = 'qcti-fgb-so3'
   AND (criteria ILIKE '%retain%' OR criteria ILIKE '%swatch%');

-- ============================================================================
-- C. STORED MATERIAL — mig 0217
-- ============================================================================

-- FOAM yellowing. Strategy (d) + (c). Foam yellows from the OUTSIDE IN, so a
-- block that is cut open is its own reference — the fresh inner face is what
-- the block looked like new. The newest batch in the rack is the second
-- comparator, and both are physically present on the day of the check.
UPDATE qc_template_items
   SET item_name = 'Yellowing judged against fresh foam',
       criteria  = 'Foam yellows from the outside in, so the block is its own reference: cut or tear one block open and compare the fresh inner face against the outer face. Then hold it against a block from the NEWEST batch of the same grade in the rack. Yellowing with age is normal; a block noticeably darker than new foam must not go into a light-fabric unit. Write down how old this batch is and what you saw. SAMPLE: 2 blocks.'
 WHERE id = 'qcti-sto-1'
   AND (criteria ILIKE '%retain%' OR criteria ILIKE '%reference sample%' OR item_name ILIKE '%retain%');

-- STORED FABRIC colour. Re-pointed rather than reworded: comparing the outer
-- layer of a roll with its inner layer is already `qcti-stf-4`, so this item
-- would have become a duplicate. Strategy (a) + (b) instead — the dye-lot on
-- the label against the receipt, and every roll of that code in the rack
-- against each other, which is the failure that reaches a finished unit.
UPDATE qc_template_items
   SET item_name = 'Dye-lot still matches what the job expects',
       criteria  = 'Read the fabric code and dye-lot printed on the roll label and write both down against the material code on this inspection and the dye-lot recorded on the receipt. Then, if the store holds more than one roll of this code, lay 1m of each side by side in daylight: a job cut across two lots shows a colour step in the finished unit. Write down every dye-lot in the rack for this code and whether they match.'
 WHERE id = 'qcti-stf-3'
   AND (criteria ILIKE '%retain%' OR criteria ILIKE '%swatch%' OR item_name ILIKE '%retain%' OR item_name ILIKE '%swatch%');

-- STORED GENERAL fallback. Strategy (a) + (c).
UPDATE qc_template_items
   SET criteria = 'Compare against the PO line / BOM for the job this batch is drawn for, and against anything of the same material still in the rack from an earlier delivery. Write down whether it is usable as-is, and if it is not, exactly what is wrong with it.'
 WHERE id = 'qcti-stz-3'
   AND (criteria ILIKE '%retain%' OR criteria ILIKE '%reference sample%');

-- ============================================================================
-- D. IN-PROCESS (IPQC) — mig 0219
-- ============================================================================

-- SOFA UPH, seat sink. The measurement was already good; only the trailing
-- "…and the retained reference unit if one is at hand" was unexecutable — and
-- "if one is at hand" is how an item quietly becomes optional. Strategy (b):
-- another unit of the same model on the floor, which on a production day is
-- always there.
UPDATE qc_template_items
   SET criteria = 'Press the centre of the seat cushion with a flat palm using firm, steady pressure and measure how far the top surface drops; write down the mm. Then do exactly the same on another finished unit of the same model on the floor and write that figure down too — two units of one model must sink by the same amount. "As expected" is not a record: two people expect different things and neither of them can be shown a number later.'
 WHERE id = 'qcti-wsup-3'
   AND (criteria ILIKE '%retain%' OR criteria ILIKE '%reference unit%');

-- SOFA UPH, overall conformance. Strategy (a): the job card, the model spec /
-- drawing and the sales-order product photo are the documents that DO exist.
UPDATE qc_template_items
   SET item_name = 'Unit matches the drawing and the model spec',
       criteria  = 'Put the job card and the model spec / drawing next to the unit — and the product photo on the sales order if there is one — and compare shape, seam positions, arm profile and leg style one at a time. Where another unit of the same model is on the floor, stand them side by side. Write down anything that differs. "Looks acceptable" cannot be disagreed with, which is exactly why it never catches anything.'
 WHERE id = 'qcti-wsup-5'
   AND (criteria ILIKE '%retain%' OR criteria ILIKE '%reference sample%' OR item_name ILIKE '%retain%');

-- SOFA FAB/SEW, label position. Strategy (a) + (b) + (d): the spec says where,
-- another unit says where, and the mm is what gets written down.
UPDATE qc_template_items
   SET criteria = 'The model spec / job card states where the label goes; where it does not, use another finished unit of the same model on the floor. Write down where the label actually is, measured in mm from the nearest seam or corner — not just that it is there.'
 WHERE id = 'qcti-wsfs-16'
   AND (criteria ILIKE '%retain%' OR criteria ILIKE '%reference sample%');

-- SOFA WEBBING, type at the station. Same substance as the incoming webbing
-- item above: the BOM names it, and a 200mm pull settles it.
UPDATE qc_template_items
   SET criteria = 'Read the type / part code on the roll at the station and write it down against the BOM line for this model. Then confirm it by hand: pull a 200mm length — elastic webbing stretches visibly and springs back, non-elastic barely moves. Elastic and non-elastic look alike on the roll and give completely different seats. Write down which was used.'
 WHERE id = 'qcti-wswb-11'
   AND (criteria ILIKE '%retain%' OR criteria ILIKE '%reference sample%');

-- BED FRAME FAB/SEW, panel joins. The spec drawing was already half of this
-- criterion; the retained sample is dropped and a measurement added so the
-- answer is a number rather than an impression.
UPDATE qc_template_items
   SET criteria = 'Compare against the spec drawing / cutting marker for this model and write down the position of any join that is off, in mm from the nearest edge or seam. Where another headboard of the same model is on the floor, stand them side by side. On a plain headboard a join 20mm out is the first thing anyone sees.'
 WHERE id = 'qcti-wbfs-14'
   AND (criteria ILIKE '%retain%' OR criteria ILIKE '%reference sample%');

-- BED FRAME UPH, padding thickness. The BOM figure was already the standard;
-- the retained-sample press is replaced by another unit of the same model, and
-- the criterion now says which of the two readings is the record.
UPDATE qc_template_items
   SET criteria = 'Measure the padding at the edge before the cover is closed and write down the mm against the BOM figure. If the cover is already closed, press with a flat palm at the centre and at both ends and compare with another headboard of the same model on the floor — but the measurement taken before closing is the record that counts.'
 WHERE id = 'qcti-wbup-11'
   AND (criteria ILIKE '%retain%' OR criteria ILIKE '%reference sample%');

-- ============================================================================
-- VERIFICATION — must return ZERO rows after this file has been run.
--
--   SELECT id, template_id, item_name, criteria
--     FROM qc_template_items
--    WHERE criteria  ILIKE '%retain%'
--       OR criteria  ILIKE '%swatch%'
--       OR criteria  ILIKE '%reference sample%'
--       OR criteria  ILIKE '%reference unit%'
--       OR criteria  ILIKE '%golden sample%'
--       OR item_name ILIKE '%retain%'
--       OR item_name ILIKE '%swatch%'
--       OR item_name ILIKE '%reference sample%'
--    ORDER BY template_id, sequence;
--
-- A row that comes back is either an item this file missed or one the owner
-- has written by hand — read it before rewriting it.
-- ============================================================================
