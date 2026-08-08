-- ============================================================================
-- Migration 0219 — what each DEPARTMENT is actually checked on.
--
-- OWNER 2026-08-08: "像我们这些部门，比如我们自己做沙发厂、被褥厂的，去部门检查
--                    需要检查什么东西呢？"
--
-- The 11 WIP templates from 0068 existed but were three to five items long with
-- NO criteria at all — every one of them a bare phrase ("Stitch consistency",
-- "Overall finish look acceptable") with nothing saying how many pieces to look
-- at, what to measure, or what to write down. That is a list people learn to
-- tick. 0215 did this for the incoming checklists; this file does it for the
-- stations.
--
-- WIP IS A DIFFERENT QUESTION FROM RM, AND THE ITEMS REFLECT IT.
-- An incoming check asks "is this batch good?". A WIP check asks "is this
-- DEPARTMENT following the standard?" — so the items are about METHOD and
-- CONFORMANCE:
--
--   • the thing being made matches the BOM / the cut list / the sales-order
--     size, checked against the document rather than against memory;
--   • the process STEP was actually performed — glue before fastening, a
--     first-off measured before the batch was run, backstitch at both ends,
--     every corner block present;
--   • the TOLERANCE held, as a number the inspector writes down;
--   • plus the defects that station is known to produce and that are expensive
--     to find later — a nap reversal found at Fab Cut is a re-cut, found at
--     Packing it is a rebuild.
--
-- EVERY ITEM IS OBSERVABLE AND RECORDABLE. A measurement, a count, a pass/fail,
-- or a comparison against the retained sample or the BOM. Two items from 0068
-- were opinions ("Cushion firmness as expected", "Overall finish look
-- acceptable") and are re-worded here into things that can be measured; every
-- other 0068 item KEEPS its wording and only gains a criteria.
--
-- RE-RUNNABLE. Every INSERT is ON CONFLICT DO NOTHING; every UPDATE that fills
-- a criteria is guarded on `criteria IS NULL`, so an item the owner has since
-- edited through the Templates tab is never clobbered. New items are sequenced
-- from 11 upward so the original ordering is untouched and it stays obvious
-- what arrived when.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A. Fill in the criteria the 0068 items never had. Wording of the item itself
--    is kept — only the "how, how many, and what to write down" is added.
-- ----------------------------------------------------------------------------

-- Sofa — Fabric Cutting
UPDATE qc_template_items SET criteria = 'Tape-measure length and width on 3 cut panels from this job and write down the mm. Anything outside +/-2mm of the cut list is re-cut, not stretched at Upholstery. SAMPLE: 3 panels per job card.' WHERE id = 'qcti-wsfc-1' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Lay the matching left and right panels side by side. The pattern repeat must land at the same point on both. Write down which panels you compared. SAMPLE: one matched pair per job card.' WHERE id = 'qcti-wsfc-2' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Run a thumb along the cut edge of each sampled panel. Fraying or a melted/dragged edge means a blunt or overheated blade. Write down which panels, and which of the two causes it was — the fix is the machine, not the panel. SAMPLE: 3 panels.' WHERE id = 'qcti-wsfc-3' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Read the SKU on the roll and write down what it says, next to the fabric code on the job card / BOM. Do not read it off the trolley label. A wrong SKU here is a complete re-cut and it is invisible until Upholstery.' WHERE id = 'qcti-wsfc-4' AND criteria IS NULL;

-- Sofa — Fabric Sewing
UPDATE qc_template_items SET criteria = 'Run a finger along 300mm of seam on 3 sewn pieces. No skipped stitches, no puckering, no double-back. Write down how many pieces were rejected. SAMPLE: 3 pieces per job card.' WHERE id = 'qcti-wsfs-1' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Pull the seam apart firmly by hand across 100mm. The fabric must take the load, not the thread. Write down any seam that opened. SAMPLE: 3 seams per job card.' WHERE id = 'qcti-wsfs-2' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Compare the thread against the fabric in daylight, not under the machine lamp. Write down the thread colour code used.' WHERE id = 'qcti-wsfs-3' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Check both faces of each sampled piece, including inside the seam allowance. Write down how many were trimmed.' WHERE id = 'qcti-wsfs-4' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'The piping must continue round the corner without a step or a gap. Measure the step in mm if there is one and write it down. SAMPLE: 2 corners per job card.' WHERE id = 'qcti-wsfs-5' AND criteria IS NULL;

-- Sofa — Foam Cutting
UPDATE qc_template_items SET criteria = 'Tape-measure L x W x H on 3 cut pieces against the BOM figure and write down all three. Foam cut oversize is hidden by the cover and shows as a hard, over-stuffed seat. SAMPLE: 3 pieces per job card.' WHERE id = 'qcti-wsfm-1' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Inspect the cut faces for tears, gouges and crushed corners from the saw. Write down how many pieces were rejected. SAMPLE: 3 pieces.' WHERE id = 'qcti-wsfm-2' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Read the density rating stamped on the block being cut (e.g. D28 / D32) and write down the figure next to the BOM one. Substituting a lower grade is invisible once the cover is on and is the single most common source of a "sofa went soft" complaint.' WHERE id = 'qcti-wsfm-3' AND criteria IS NULL;

-- Sofa — Framing
UPDATE qc_template_items SET criteria = 'Tape-measure both diagonals of the frame and write down BOTH figures. They must be within 3mm of each other. A frame out of square cannot be pulled straight at Upholstery — it is fixed here or it ships crooked.' WHERE id = 'qcti-wsfr-1' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Look for glue squeeze-out at each joint AND count the fasteners. A screwed joint with no glue passes a look and fails in the customer''s house. Write down any joint with no visible glue. SAMPLE: 4 joints per frame.' WHERE id = 'qcti-wsfr-2' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Count the brackets and leg plates against the BOM and write down counted vs required. Confirm each is on its specified face.' WHERE id = 'qcti-wsfr-3' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Inspect around every screw and at every rail end — splits start at the fastener. Write down the location of any split. A split rail is replaced, never filled.' WHERE id = 'qcti-wsfr-4' AND criteria IS NULL;

-- Sofa — Webbing
UPDATE qc_template_items SET criteria = 'Press each strap in turn with a flat palm. They must feel the same; a slack strap in the middle is where the seat will drop. Write down how many straps were re-tensioned. SAMPLE: every strap on one seat.' WHERE id = 'qcti-wswb-1' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Tape-measure the gap between straps at 2 points and write down the mm. Compare with the BOM spacing.' WHERE id = 'qcti-wswb-2' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Run a thumb over every staple line — none proud, none through the webbing edge. Write down how many staples were re-driven. A proud staple cuts the webbing under load months later.' WHERE id = 'qcti-wswb-3' AND criteria IS NULL;

-- Sofa — Upholstery
UPDATE qc_template_items SET criteria = 'Look across the panel at a low angle in daylight. Wrinkles that are visible from a standing position at 1m fail. Write down which panel. SAMPLE: every outward-facing panel of the unit.' WHERE id = 'qcti-wsup-1' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'The pattern repeat must continue across the seam without a step. Measure the step in mm if there is one and write it down. SAMPLE: 2 seams per unit.' WHERE id = 'qcti-wsup-2' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Run a flat palm over every seam, staple line and the underside of the frame rail. Write down how many points caught and where. Any point that catches fails. This is the item that stops a customer bleeding on a new sofa — do not sample it, do the whole unit.' WHERE id = 'qcti-wsup-4' AND criteria IS NULL;

-- Bed Frame — Wood Cutting
UPDATE qc_template_items SET criteria = 'Callipers or tape on 3 pieces from this job against the cut list; write down the mm. SAMPLE: 3 pieces per job card.' WHERE id = 'qcti-wbwc-1' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Try-square on both ends of each sampled piece; write down the out-of-square mm. Chip-out on the show face is a reject, not a sanding job. SAMPLE: 3 pieces.' WHERE id = 'qcti-wbwc-2' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Inspect all four faces and both ends of each sampled piece. Write down how many were set aside.' WHERE id = 'qcti-wbwc-3' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Read the material code on the stock being cut and write down what it says, next to the BOM figure. A different species or section size is invisible once the frame is upholstered.' WHERE id = 'qcti-wbwc-4' AND criteria IS NULL;

-- Bed Frame — Framing
UPDATE qc_template_items SET criteria = 'Tape-measure both diagonals and write down BOTH figures; they must be within 3mm. Then measure the internal width and length and write those down too.' WHERE id = 'qcti-wbfr-1' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Look for glue squeeze-out at each joint AND count the fasteners. Write down any joint with no visible glue. SAMPLE: 4 joints per frame.' WHERE id = 'qcti-wbfr-2' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Press down on the centre of each slat in turn. Write down how many moved or lifted. A slat that lifts is what the customer hears as a creak.' WHERE id = 'qcti-wbfr-3' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Count the legs and brackets against the BOM and write down counted vs required.' WHERE id = 'qcti-wbfr-4' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Run a flat palm over every internal edge and every fastener head — the ones a person will reach when they fit a mattress or move the bed. Write down how many points caught and where. Any point that catches fails. Do the whole frame, do not sample.' WHERE id = 'qcti-wbfr-5' AND criteria IS NULL;

-- Bed Frame — HB Fabric Cut
UPDATE qc_template_items SET criteria = 'Tape-measure length and width on each cut panel and write down the mm. SAMPLE: every panel of one headboard per job card.' WHERE id = 'qcti-wbfc-1' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Run a thumb along each cut edge. A frayed or melted edge means a blunt or overheated blade. Write down which panels and which of the two causes it was — the fix is the machine, not the panel.' WHERE id = 'qcti-wbfc-2' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Read the SKU on the roll and write down what it says, next to the fabric code on the job card. Do not read it off the trolley label.' WHERE id = 'qcti-wbfc-3' AND criteria IS NULL;

-- Bed Frame — HB Fabric Sew
UPDATE qc_template_items SET criteria = 'Run a finger along 300mm of seam on 3 sewn pieces. No skipped stitches, no puckering. Write down how many were rejected. SAMPLE: 3 pieces per job card.' WHERE id = 'qcti-wbfs-1' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Pull the seam apart firmly by hand across 100mm; the fabric must take the load, not the thread. Write down any seam that opened. SAMPLE: 3 seams.' WHERE id = 'qcti-wbfs-2' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Check both faces including inside the seam allowance. Write down how many were trimmed.' WHERE id = 'qcti-wbfs-3' AND criteria IS NULL;

-- Bed Frame — HB Upholstery
UPDATE qc_template_items SET criteria = 'Look across the panel at a low angle in daylight. Wrinkles visible from 1m fail. A headboard is looked at from the bed every night — it is the most stared-at surface we make. Write down which panel.' WHERE id = 'qcti-wbup-1' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'The pattern repeat must continue across the headboard without a step. Measure the step in mm if there is one and write it down.' WHERE id = 'qcti-wbup-2' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Press with a flat palm at 5 points across the headboard — centre, both ends, top and bottom. A thin spot feels like the board underneath. Write down where.' WHERE id = 'qcti-wbup-3' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Run a flat palm over every edge and the whole back. Write down how many points caught and where. Any point that catches fails. Do the whole headboard, do not sample.' WHERE id = 'qcti-wbup-4' AND criteria IS NULL;
UPDATE qc_template_items SET criteria = 'Lay a straight edge across the button rows. Every button must sit on the line and be pulled to the same depth — measure the depth at 3 buttons and write down the mm. Uneven pull is the defect that gets a headboard rejected on delivery.' WHERE id = 'qcti-wbup-5' AND criteria IS NULL;

-- ----------------------------------------------------------------------------
-- B. Two 0068 items were OPINIONS, not observations. An item an inspector
--    cannot answer with evidence is an item they learn to tick, so both are
--    re-stated as something measurable. Guarded on the old text: if the owner
--    has already edited either one, nothing happens.
-- ----------------------------------------------------------------------------
UPDATE qc_template_items
   SET item_name = 'Seat sinks within spec under a standard load',
       criteria  = 'Press the centre of the seat cushion with a flat palm using firm, steady pressure and measure how far the top surface drops; write down the mm, and write down the same figure for the retained reference unit if one is at hand. "As expected" is not a record — two people expect different things and neither of them can be shown a number later.'
 WHERE id = 'qcti-wsup-3' AND item_name = 'Cushion firmness as expected';

UPDATE qc_template_items
   SET item_name = 'Unit matches the retained reference sample',
       criteria  = 'Stand the unit next to the retained reference sample (or its photo and spec sheet) and compare shape, seam positions, arm profile and leg style. Write down anything that differs. "Looks acceptable" cannot be disagreed with, which is exactly why it never catches anything.'
 WHERE id = 'qcti-wsup-5' AND item_name = 'Overall finish look acceptable';

-- ----------------------------------------------------------------------------
-- C. The items that were missing — METHOD and CONFORMANCE.
--    Sequenced from 11 so the 0068 ordering is untouched.
-- ----------------------------------------------------------------------------

-- Sofa — Fabric Cutting: the station where a mistake is a re-cut, and one
-- station later is a rebuild.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-wsfc-11', 'qct-wip-sofa-fabcut', 11, 'Cutting marker for THIS model is at the station and being used', 'The marker / cutting plan, not memory. Write down the model code printed on the marker and confirm it matches the job card. Cutting a model from the wrong marker produces panels that all measure correctly and still do not fit.', 'CRITICAL', 1),
  ('qcti-wsfc-12', 'qct-wip-sofa-fabcut', 12, 'First panel measured before the rest of the batch was cut',     'Ask which panel was the first-off and measure it. If the batch was cut before anything was measured, that is the finding — write it down even when the panels are fine, because next time they will not be.', 'MAJOR', 1),
  ('qcti-wsfc-13', 'qct-wip-sofa-fabcut', 13, 'Nap / pile direction the same on every panel of the unit',       'Brush a palm across each panel and check the pile lies the same way on all of them. Reversed nap reads as two different shades under a lamp and is only visible once the sofa is assembled. Write down any panel that differs. SAMPLE: every panel of one unit.', 'CRITICAL', 1),
  ('qcti-wsfc-14', 'qct-wip-sofa-fabcut', 14, 'Notches and drill marks transferred to every panel',             'Count the notches on 3 panels against the marker. A missing notch is guessed at during sewing and the seam lands in the wrong place. Write down counted vs required.', 'MAJOR', 1),
  ('qcti-wsfc-15', 'qct-wip-sofa-fabcut', 15, 'Panel count per unit matches the cutting list',                  'Count the bundle for one unit against the cutting list and write down counted vs required. A short bundle is found at Sewing and stops the line.', 'MAJOR', 1),
  ('qcti-wsfc-16', 'qct-wip-sofa-fabcut', 16, 'Remnants labelled back to the sales order and dye lot',          'Write down whether the off-cuts carry the SO number. An unlabelled remnant is either scrap or, worse, gets used on another order and puts two dye lots on one sofa.', 'MINOR', 1)
ON CONFLICT (id) DO NOTHING;

-- Sofa — Fabric Sewing.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-wsfs-11', 'qct-wip-sofa-fabsew', 11, 'Stitch density matches the standard for this fabric',   'Count the stitches across 100mm of seam on a sampled piece and write down the number. Too few and the seam opens; too many and it perforates the fabric and tears along the line. SAMPLE: 2 seams per job card.', 'MAJOR', 1),
  ('qcti-wsfs-12', 'qct-wip-sofa-fabsew', 12, 'Seam allowance consistent',                             'Measure the allowance at 3 points along a seam and write down the mm. A wandering allowance is what makes a cover 10mm too small at Upholstery, where it is blamed on the cutter.', 'MAJOR', 1),
  ('qcti-wsfs-13', 'qct-wip-sofa-fabsew', 13, 'Needle and thread gauge correct for this fabric weight', 'Write down the needle size in the machine and the thread ticket. A fine needle on heavy vinyl skips; a heavy needle on light fabric leaves visible holes. This is a MACHINE SETUP check — it is answered at the machine, not on the piece.', 'MAJOR', 1),
  ('qcti-wsfs-14', 'qct-wip-sofa-fabsew', 14, 'Backstitch or lockstitch at the start and end of every seam', 'Check both ends of 3 seams. An unlocked seam end unravels in the customer''s house, not on the bench. Write down how many were re-done.', 'MAJOR', 1),
  ('qcti-wsfs-15', 'qct-wip-sofa-fabsew', 15, 'Zips and velcro fitted the correct way round and to full length', 'Open and close each zip fully. Write down any that bind or run short. Mark N/A if this model has none.', 'MAJOR', 0),
  ('qcti-wsfs-16', 'qct-wip-sofa-fabsew', 16, 'Care / brand label sewn in the specified position',      'Compare against the retained sample. Write down where the label actually is.', 'MINOR', 1)
ON CONFLICT (id) DO NOTHING;

-- Sofa — Foam Cutting.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-wsfm-11', 'qct-wip-sofa-foam', 11, 'Cut faces square to the block',                        'Try-square against the cut face on 3 pieces and write down the out-of-square mm. A tapered cushion is only visible once it is covered and sat on.', 'MAJOR', 1),
  ('qcti-wsfm-12', 'qct-wip-sofa-foam', 12, 'First piece measured before the batch was cut',        'Ask which was the first-off and measure it. If nothing was measured before the batch ran, write that down even when the pieces are fine.', 'MAJOR', 1),
  ('qcti-wsfm-13', 'qct-wip-sofa-foam', 13, 'Laminated layers glued in the order and coverage the BOM states', 'Check the glue line on a cut edge: full coverage, no gaps, layers in the specified order and orientation. Write down what you see. A missed layer is a soft spot that appears after a month of use. Mark N/A if this model has no laminated build-up.', 'MAJOR', 0),
  ('qcti-wsfm-14', 'qct-wip-sofa-foam', 14, 'Piece count per unit matches the BOM',                  'Count the foam set for one unit against the BOM and write down counted vs required.', 'MAJOR', 1),
  ('qcti-wsfm-15', 'qct-wip-sofa-foam', 15, 'No joined off-cuts used in a seat or back cushion',     'Look at the cut edges for glue lines that are not on the BOM. A patched cushion feels like a ridge through the cover within weeks. Write down any piece set aside.', 'CRITICAL', 1)
ON CONFLICT (id) DO NOTHING;

-- Sofa — Framing.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-wsfr-11', 'qct-wip-sofa-framing', 11, 'Overall frame dimensions match the BOM',              'Tape-measure width, depth and height and write down all three against the BOM figures. Everything downstream — foam, cover, carton — is cut to these numbers.', 'CRITICAL', 1),
  ('qcti-wsfr-12', 'qct-wip-sofa-framing', 12, 'Timber section size and grade as specified',          'Callipers on one rail and one leg; write down the mm and the material code. A thinner section passes a look and fails under a person.', 'MAJOR', 1),
  ('qcti-wsfr-13', 'qct-wip-sofa-framing', 13, 'Fastener count and spacing at each joint per standard','Count the screws or staples at 4 joints and write down counted vs required, plus the spacing in mm.', 'MAJOR', 1),
  ('qcti-wsfr-14', 'qct-wip-sofa-framing', 14, 'Corner blocks / gussets fitted at every specified position', 'Count them against the BOM and write down counted vs required. This is the single part most often left off, and it is the part that stops the frame racking.', 'CRITICAL', 1),
  ('qcti-wsfr-15', 'qct-wip-sofa-framing', 15, 'Frame does not rack under a sideways push',           'Stand the frame on a flat floor and push firmly at one top corner. Write down the movement in mm. Anything that visibly flexes goes back before it is covered.', 'CRITICAL', 1),
  ('qcti-wsfr-16', 'qct-wip-sofa-framing', 16, 'Leg mounting plates square and at the specified height', 'Try-square on the plate and tape-measure from the floor line. Write down the mm. A plate 5mm out gives a sofa that rocks on a flat floor.', 'MAJOR', 1)
ON CONFLICT (id) DO NOTHING;

-- Sofa — Webbing.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-wswb-11', 'qct-wip-sofa-webbing', 11, 'Webbing type matches the BOM for this model',        'Read the label or compare against the retained sample and write down what was used. Elastic and non-elastic webbing look alike on the roll and give completely different seats.', 'CRITICAL', 1),
  ('qcti-wswb-12', 'qct-wip-sofa-webbing', 12, 'Strap count per seat matches the BOM',                'Count the straps in both directions and write down counted vs required. One strap short is a seat that drops in a year.', 'MAJOR', 1),
  ('qcti-wswb-13', 'qct-wip-sofa-webbing', 13, 'Installed stretch measured, not judged',              'Mark 200mm on a strap before it is tensioned, fit it, then measure the marks again and write down the percentage stretch. Compare with the standard for this webbing. "Feels about right" is how one bench ends up 10% tighter than the next.', 'MAJOR', 1),
  ('qcti-wswb-14', 'qct-wip-sofa-webbing', 14, 'Interwoven where the spec requires it',               'Confirm the over/under pattern matches the spec and write down what you found. Mark N/A if this model''s webbing is not interwoven.', 'MAJOR', 0),
  ('qcti-wswb-15', 'qct-wip-sofa-webbing', 15, 'Seat deflection under load within limit',             'Press the centre of the webbed seat with a firm flat palm and measure how far it drops; write down the mm. This is the number that says whether the tension and the strap count together give the right seat.', 'MAJOR', 1)
ON CONFLICT (id) DO NOTHING;

-- Sofa — Upholstery.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-wsup-11', 'qct-wip-sofa-uph', 11, 'All build-up layers present, in the BOM order',          'Lift a corner of the cover or check an unclosed section: wadding, dacron wrap and any barrier cloth, in the specified order. Write down what you found. A missing dacron wrap is invisible on day one and is the reason a cover goes baggy in three months.', 'MAJOR', 1),
  ('qcti-wsup-12', 'qct-wip-sofa-uph', 12, 'Seams land symmetrically left to right',                 'Tape-measure the same seam from the centre line on both sides and write down BOTH figures. More than 5mm apart is visible from across a room.', 'MAJOR', 1),
  ('qcti-wsup-13', 'qct-wip-sofa-uph', 13, 'Staple spacing on the frame within standard',            'Measure the gap between staples at 3 points along a rail and write down the mm. Too far apart and the cover pulls away at the line; too close and the rail splits.', 'MAJOR', 1),
  ('qcti-wsup-14', 'qct-wip-sofa-uph', 14, 'Cushion fill count and weight per BOM',                  'Count the fill pieces for one cushion and, where the BOM states a weight, weigh it. Write down counted / weighed vs required.', 'MAJOR', 1),
  ('qcti-wsup-15', 'qct-wip-sofa-uph', 15, 'Piping and trim continue around every corner',           'Follow the trim right round the unit. Write down the location of any break, step or gap.', 'MAJOR', 1),
  ('qcti-wsup-16', 'qct-wip-sofa-uph', 16, 'Bottom dust cover fitted and closed',                    'Turn the unit or look underneath. Write down whether it is fitted and whether any edge is loose.', 'MINOR', 1)
ON CONFLICT (id) DO NOTHING;

-- Bed Frame — Wood Cutting.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-wbwc-11', 'qct-wip-bf-woodcut', 11, 'Cut list for THIS bed size is at the station and being used', 'Write down the size code on the cut list (S / SS / Q / K) and confirm it matches the job card. Every piece can measure perfectly against the wrong list.', 'CRITICAL', 1),
  ('qcti-wbwc-12', 'qct-wip-bf-woodcut', 12, 'First piece measured before the batch was cut',        'Ask which was the first-off and measure it. A stop block that moved 3mm turns into a whole batch. If nothing was measured first, write that down even when the pieces are fine.', 'MAJOR', 1),
  ('qcti-wbwc-13', 'qct-wip-bf-woodcut', 13, 'Piece count per frame matches the cut list',           'Count the bundle for one frame against the cut list and write down counted vs required.', 'MAJOR', 1),
  ('qcti-wbwc-14', 'qct-wip-bf-woodcut', 14, 'Bundle labelled with the job card and size',           'Write down whether the bundle carries a readable label. An unlabelled bundle of Queen rails becomes a King frame at the next station.', 'MAJOR', 1),
  ('qcti-wbwc-15', 'qct-wip-bf-woodcut', 15, 'No chip-out on the face that will show',               'Identify the show face on 3 pieces and inspect it. Write down how many were set aside. Chip-out on a show face is a reject, not a sanding job.', 'MAJOR', 1)
ON CONFLICT (id) DO NOTHING;

-- Bed Frame — Framing.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-wbfr-11', 'qct-wip-bf-framing', 11, 'Internal dimensions match the bed size ORDERED',        'Tape-measure the internal width and length and write down the mm, then compare against the size on the job card (S / SS / Q / K). A Queen frame built on a King job card fits nothing and is only found on delivery.', 'CRITICAL', 1),
  ('qcti-wbfr-12', 'qct-wip-bf-framing', 12, 'Slat count and spacing match the BOM',                  'Count the slats and measure the gap at 3 points. Write down the count and the mm. Too few slats voids the mattress warranty as well as sagging.', 'MAJOR', 1),
  ('qcti-wbfr-13', 'qct-wip-bf-framing', 13, 'Centre rail and centre leg fitted where specified',     'Confirm against the BOM and write down what is fitted. On a Queen or King this is the part that carries the middle of the bed; leaving it off is the classic expensive omission.', 'CRITICAL', 1),
  ('qcti-wbfr-14', 'qct-wip-bf-framing', 14, 'Fastener count and spacing at each joint per standard', 'Count the fasteners at 4 joints and write down counted vs required, plus the spacing in mm.', 'MAJOR', 1),
  ('qcti-wbfr-15', 'qct-wip-bf-framing', 15, 'Assembly fittings line up with their mating part',      'Offer the two halves together, or up to the jig. Write down any fitting out of position in mm. A frame that will not bolt together in the customer''s bedroom comes back as a whole delivery.', 'CRITICAL', 1),
  ('qcti-wbfr-16', 'qct-wip-bf-framing', 16, 'Frame stands flat on a level floor',                    'Set it on the flat bench and try to rock it. Measure the gap under any leg that lifts and write down the mm.', 'MAJOR', 1)
ON CONFLICT (id) DO NOTHING;

-- Bed Frame — HB Fabric Cut.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-wbfc-11', 'qct-wip-bf-fabcut', 11, 'Marker for THIS headboard size at the station and in use', 'Write down the size code on the marker and confirm it matches the job card.', 'CRITICAL', 1),
  ('qcti-wbfc-12', 'qct-wip-bf-fabcut', 12, 'Nap / pile direction the same on every panel',           'Brush a palm across each panel — the pile must lie the same way on all of them. On a headboard a reversed panel reads as a different colour under the bedroom lamp. Write down any panel that differs.', 'CRITICAL', 1),
  ('qcti-wbfc-13', 'qct-wip-bf-fabcut', 13, 'Panel count per headboard matches the cutting list',     'Count and write down counted vs required.', 'MAJOR', 1),
  ('qcti-wbfc-14', 'qct-wip-bf-fabcut', 14, 'Button positions marked on the panel where the design requires', 'Count the marks against the pattern and write down counted vs required. Buttons positioned by eye at Upholstery is the root of the crooked-headboard complaint. Mark N/A if this model is not buttoned.', 'MAJOR', 0)
ON CONFLICT (id) DO NOTHING;

-- Bed Frame — HB Fabric Sew.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-wbfs-11', 'qct-wip-bf-fabsew', 11, 'Stitch density matches the standard for this fabric', 'Count the stitches across 100mm of seam and write down the number. SAMPLE: 2 seams per job card.', 'MAJOR', 1),
  ('qcti-wbfs-12', 'qct-wip-bf-fabsew', 12, 'Seam allowance consistent',                           'Measure the allowance at 3 points and write down the mm. A wandering allowance gives a cover that will not reach at Upholstery.', 'MAJOR', 1),
  ('qcti-wbfs-13', 'qct-wip-bf-fabsew', 13, 'Backstitch or lockstitch at the start and end of every seam', 'Check both ends of 3 seams and write down how many were re-done.', 'MAJOR', 1),
  ('qcti-wbfs-14', 'qct-wip-bf-fabsew', 14, 'Panel joins land where the design says',              'Compare against the retained sample or the spec drawing and write down the position of any join that is off. On a plain headboard a join 20mm out is the first thing anyone sees.', 'MAJOR', 1)
ON CONFLICT (id) DO NOTHING;

-- Bed Frame — HB Upholstery.
INSERT INTO qc_template_items (id, template_id, sequence, item_name, criteria, severity, is_mandatory) VALUES
  ('qcti-wbup-11', 'qct-wip-bf-uph', 11, 'Padding thickness measured against the BOM',           'Measure the padding at the edge before the cover is closed, or press and compare against the retained sample. Write down the mm against the BOM figure.', 'MAJOR', 1),
  ('qcti-wbup-12', 'qct-wip-bf-uph', 12, 'Button positions match the template, not the eye',      'Lay the template or a marked batten over the headboard. Every button on its mark. Write down the largest deviation in mm. SAMPLE: every button on the unit.', 'MAJOR', 1),
  ('qcti-wbup-13', 'qct-wip-bf-uph', 13, 'Button pull depth even across the headboard',           'Measure the depth at 3 buttons — one at each end and one in the middle — and write down all three. An uneven pull is the defect most often refused on delivery.', 'MAJOR', 1),
  ('qcti-wbup-14', 'qct-wip-bf-uph', 14, 'Staple spacing on the back within standard',            'Measure the gap between staples at 3 points and write down the mm.', 'MAJOR', 1),
  ('qcti-wbup-15', 'qct-wip-bf-uph', 15, 'Back panel / dust cover fitted and closed',             'Write down whether it is fitted and whether any edge is loose. The back of a headboard faces the wall until the customer moves the bed.', 'MINOR', 1),
  ('qcti-wbup-16', 'qct-wip-bf-uph', 16, 'Headboard legs / brackets at the height the SO specifies', 'Tape-measure from the bottom of the leg to the underside of the board and write down the mm against the sales-order figure. Headboard height is an ordered option, not a standard.', 'CRITICAL', 1)
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- D. Say on each template what the department is being asked, so the difference
--    from an incoming check is on the screen and not only in this file.
-- ----------------------------------------------------------------------------
UPDATE qc_templates
   SET notes = 'In-process check on the DEPARTMENT, not on a batch: is the standard being followed? Method, conformance to the BOM / cut list / sales order, the tolerance as a written number, and the defects this station is known to produce that are expensive to find later.'
 WHERE stage = 'WIP';
