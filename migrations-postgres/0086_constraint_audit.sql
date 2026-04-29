-- ============================================================================
-- Migration 0077 — Sprint 3 constraint audit (data integrity hardening).
--
-- Goal: tighten the schema so application bugs cannot bend the database. Every
-- statement is wrapped in IF EXISTS / IF NOT EXISTS / DO-block guards so this
-- migration is idempotent and re-runnable on any environment.
--
-- Sections (all additive — no destructive operations except DROPing redundant
-- duplicate indexes that were superseded by composite indexes in 0037):
--
--   1. UNIQUE INDEXES on document numbers — every business document has a
--      human-facing identifier (po_no, invoice_no, do_no, grn_number,
--      entry_no, uuid, note_number). The schema declared these NOT NULL but
--      did not enforce uniqueness; only the surrogate id PK guarded against
--      collisions. Two rows with the same po_no would be perfectly legal at
--      the DB level — the application's only defence was the next-number
--      generator, which races under concurrent posts. Adding UNIQUE indexes
--      makes the database itself reject the duplicate, hard.
--      Production_orders.po_no was already covered by 0056_unique_poNo.sql.
--
--   2. NOT NULL DEFAULT NOW() on every transaction table's created_at /
--      updated_at. The original schema declared these as plain TEXT (nullable)
--      and relied on application code to stamp them. A NULL created_at here
--      means "we lost the audit trail for this row" — the database should
--      refuse it. Adding the constraint with a default lets us tighten
--      without back-filling history (existing NULLs stay NULL because of the
--      pre-flight UPDATE in section 2; new INSERTs get NOW() if the caller
--      omits the column).
--
--   3. CHECK constraints on enum-like text columns. purchase_orders.status
--      and invoices.status both omitted CHECK on the original 0001_init —
--      a typo in the application would silently store "DRAFT " (trailing
--      space) and break every status-based filter downstream.
--      bank_transactions.type already had a CHECK in 0001 — included here
--      with a defensive add-if-missing only. Values match the application
--      types declared in src/types/index.ts and the routes' transition maps
--      (src/api/routes/{purchase-orders,invoices}.ts).
--
--   4. journal_lines debit XOR credit. A single ledger leg is either a debit
--      OR a credit, never both, never neither. The application enforces this
--      today — but a forgotten branch could write a row where both columns
--      are zero (a no-op leg that bloats the ledger) or both are non-zero
--      (a contradiction). The CHECK invariant makes both states impossible.
--
--   5. DROP redundant indexes that have been superseded:
--        idx_jc_po_id            → covered by idx_jc_po_dept (0037 composite)
--        idx_jc_department_code  → covered by idx_jc_po_dept (0037 composite)
--        idx_so_status           → covered by idx_so_status_created (0047)
--        idx_po_status           → covered by idx_po_status_updated (0040)
--        idx_cost_ledger_type    → covered by idx_cost_ledger_ref (0037
--                                   composite (ref_type, ref_id, type))
--      (Note: the user-facing names from the sprint brief used camelCase;
--       the actual Postgres index names are snake_case per the rename map.)
--
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Section 1: UNIQUE indexes on document numbers
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS ux_purchase_orders_po_no       ON purchase_orders(po_no);
CREATE UNIQUE INDEX IF NOT EXISTS ux_invoices_invoice_no         ON invoices(invoice_no);
CREATE UNIQUE INDEX IF NOT EXISTS ux_delivery_orders_do_no       ON delivery_orders(do_no);
CREATE UNIQUE INDEX IF NOT EXISTS ux_grns_grn_number             ON grns(grn_number);
CREATE UNIQUE INDEX IF NOT EXISTS ux_journal_entries_entry_no    ON journal_entries(entry_no);
-- e_invoices.uuid: a draft / unsubmitted e-invoice has no uuid yet (it is
-- assigned by MyInvois only after a successful submit). Partial unique index
-- so multiple drafts coexist while submitted UUIDs are still unique.
CREATE UNIQUE INDEX IF NOT EXISTS ux_e_invoices_uuid             ON e_invoices(uuid) WHERE uuid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_credit_notes_note_number    ON credit_notes(note_number);
CREATE UNIQUE INDEX IF NOT EXISTS ux_debit_notes_note_number     ON debit_notes(note_number);

-- ---------------------------------------------------------------------------
-- Section 2: NOT NULL DEFAULT NOW() on created_at / updated_at where missing
--
-- We back-fill any existing NULL rows with NOW() before flipping the NOT NULL
-- bit so the ALTER does not fail. Done as DO blocks so each table is independent
-- and a missing column / type mismatch on one table can't poison the rest.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  -- Note: schema uses TEXT (ISO string) for timestamps everywhere. We keep
  -- that contract — set defaults using to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  -- which matches the format the application writes via
  --   to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  -- (see swapDialect in src/api/lib/supabase-compat.ts).
  iso_default constant text := $iso$to_char((NOW() AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')$iso$;
  t text;
  c text;
  tbl_cols text[][] := ARRAY[
    ARRAY['sales_orders',       'created_at'],
    ARRAY['sales_orders',       'updated_at'],
    ARRAY['purchase_orders',    'created_at'],
    ARRAY['purchase_orders',    'updated_at'],
    ARRAY['delivery_orders',    'created_at'],
    ARRAY['delivery_orders',    'updated_at'],
    ARRAY['invoices',           'created_at'],
    ARRAY['invoices',           'updated_at'],
    ARRAY['production_orders',  'created_at'],
    ARRAY['production_orders',  'updated_at']
  ];
BEGIN
  FOR i IN 1 .. array_length(tbl_cols, 1) LOOP
    t := tbl_cols[i][1];
    c := tbl_cols[i][2];
    -- Only act if both the table and the column exist AND the column is currently nullable.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
        WHERE table_name = t AND column_name = c AND is_nullable = 'YES'
    ) THEN
      EXECUTE format('UPDATE %I SET %I = ' || iso_default || ' WHERE %I IS NULL', t, c, c);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET DEFAULT ' || iso_default, t, c);
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I SET NOT NULL', t, c);
    END IF;
  END LOOP;
END$$;

-- ---------------------------------------------------------------------------
-- Section 3: CHECK constraints on enum-like text columns
--
-- purchase_orders.status — values from src/api/routes/purchase-orders.ts
--   PO_VALID_TRANSITIONS map (see lines ~56-62 of that file).
-- invoices.status — values from src/api/routes/invoices.ts
--   INV_VALID_TRANSITIONS map (see lines ~75-82 of that file).
-- bank_transactions.type — already constrained by 0001_init.sql; defensive
--   re-add only fires if the constraint was somehow dropped on a stray env.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_orders_status_chk'
  ) THEN
    ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_status_chk
      CHECK (status IN ('DRAFT','SUBMITTED','CONFIRMED','PARTIAL_RECEIVED','RECEIVED','CLOSED','CANCELLED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'invoices_status_chk'
  ) THEN
    ALTER TABLE invoices ADD CONSTRAINT invoices_status_chk
      CHECK (status IN ('DRAFT','SENT','PARTIAL_PAID','OVERDUE','PAID','CANCELLED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bank_transactions_type_chk'
  ) THEN
    ALTER TABLE bank_transactions ADD CONSTRAINT bank_transactions_type_chk
      CHECK (type IN ('DEPOSIT','WITHDRAWAL','TRANSFER'));
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- Section 4: journal_lines debit XOR credit invariant
--
-- A leg row is either a debit (debit_sen > 0, credit_sen = 0) or a credit
-- (debit_sen = 0, credit_sen > 0). Never both; never neither. The XOR is
-- expressed as "(debit==0) <> (credit==0)" — exactly one side is zero.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'debit_xor_credit_chk'
  ) THEN
    ALTER TABLE journal_lines ADD CONSTRAINT debit_xor_credit_chk
      CHECK ((COALESCE(debit_sen, 0) = 0) <> (COALESCE(credit_sen, 0) = 0));
  END IF;
END$$;

-- ---------------------------------------------------------------------------
-- Section 5: DROP redundant indexes
--
-- Each name is the ACTUAL postgres index name (snake_case). The composites
-- that supersede them are listed in the section header comment above.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS idx_jc_po_id;
DROP INDEX IF EXISTS idx_jc_department_code;
DROP INDEX IF EXISTS idx_so_status;
DROP INDEX IF EXISTS idx_po_status;
DROP INDEX IF EXISTS idx_cost_ledger_type;
