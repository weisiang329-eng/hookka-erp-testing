-- ############################################################################
-- ## ⛔ DO NOT RUN STEP 2 AS-IS. Checked against PROD on 2026-08-13:         ##
-- ##                                                                        ##
-- ##   service_cases  = 37 rows   (NOT the empty-ish test set this assumed) ##
-- ##   service_orders = 10 rows   (ALL cascade away with them)              ##
-- ##                                                                        ##
-- ## The newest rows are live work, not test data — SC-2608-005..008 are    ##
-- ## OPEN / IN_PROGRESS for real customers (Houzs Century, The Conts),      ##
-- ## created 2026-08-10..12. `DELETE FROM service_cases` would destroy them ##
-- ## and cascade-delete 10 service orders. It is IRREVERSIBLE.              ##
-- ##                                                                        ##
-- ## This script was written when the table held only test rows. Its own    ##
-- ## STEP 1 guard ("only if EVERY row is test data") is still correct — and ##
-- ## as of today that condition is FALSE. If a pre-go-live clear is still   ##
-- ## wanted, it needs a WHERE clause selecting the test rows, not a bare    ##
-- ## DELETE. Ask the owner which rows are test before running anything.     ##
-- ############################################################################
-- ============================================================================
-- HOOKKA — clear ALL test Service Cases before go-live
-- ============================================================================
-- WHERE to run: the PRODUCTION Supabase (the project erp.hookka.com uses) →
--               SQL Editor.  ⚠ NOT the staging project (hookka-erp-staging).
--
-- WHAT it does: deletes every row in service_cases. Any service_orders linked
--               to a case are removed automatically by the foreign key
--               service_orders.case_id → service_cases ON DELETE CASCADE
--               (migration 0074). This is IRREVERSIBLE.
--
-- HOW to run:   run STEP 1 first and read the list. If — and only if — every
--               row is test data, run STEP 2.
-- ============================================================================

-- ── STEP 1 — preview what will be deleted (run this alone first) ────────────
SELECT case_no, status, source_type, customer_name, created_at
FROM service_cases
ORDER BY created_at DESC;

-- (optional) how many service orders will cascade away with them:
SELECT COUNT(*) AS service_orders_that_cascade
FROM service_orders
WHERE case_id IN (SELECT id FROM service_cases);


-- ── STEP 2 — clear everything (run only after the STEP 1 list looks right) ──
DELETE FROM service_cases;

-- After this, the Service Cases list is empty and ready for go-live.
-- Note: if any case had spawned an "SV" sales order, that sales order is a real
-- order record and is NOT deleted here (it only carried a case tag).
