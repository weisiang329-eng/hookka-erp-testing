// ---------------------------------------------------------------------------
// party-name-propagate.ts — push a customer / supplier rename out to every
// table that snapshotted the name at create time.
//
// Owner ruling 2026-08-01: 「全部回填，包括发票」.
//
// Why this exists
// ---------------
// 25 tables denormalise the party name (`customer_name` / `supplier_name`) and
// their read paths do NOT join customers / suppliers — they render the stored
// snapshot. Correcting a misspelt master record therefore fixed nothing the
// operator could see: after renaming supplier 400-A002 from "ADD WOORD TRADING
// SDN. BHD." to "ADD WOOD…", all 24 purchase invoices and 13 purchase orders
// still displayed the typo (measured on staging, 2026-08-01).
//
// Scope decision (owner, after being shown the trade-off): propagate to
// EVERYTHING, financial documents included. The alternative — freezing already
// issued invoices / e-Invoices so the system matches what was filed with LHDN —
// was explicitly declined. Documented here so the choice is discoverable:
//
//   ⚠️ An e-Invoice already submitted to LHDN, or an invoice PDF already sent
//   to a customer, keeps the name it was filed under at the tax authority /
//   in the customer's inbox. After a rename this system will display the NEW
//   name for that same document. Paper and system will disagree for documents
//   issued before the rename. This is intended.
//
// Grouping is unaffected either way: AR/AP aging and reconciliation group by
// customerId / supplierId, never by name — so a rename can never split one
// party into two.
//
// Two classes of table
// --------------------
//   * id-keyed  — has customer_id / supplier_id. Updated by id: exact, safe.
//   * name-only — 7 customer tables carry the name with NO id column
//     (e_invoices, fg_units, production_orders, qc_inspections, rack_items,
//     rack_locations, schedule_entries). These can only be matched on the OLD
//     name string. If two DIFFERENT customers share byte-identical names, a
//     rename of one would touch the other's rows too — accepted, because such a
//     pair is already unresolvable everywhere else in the system (the tolerant
//     matcher rejects ambiguous names outright). Callers get these counts back
//     separately so the audit trail shows which rows were matched by name.
//
// Every statement is wrapped individually: these tables are created across many
// migrations and a few are runtime-applied, so a missing table on some
// environment must not abort the rest of the propagation.
// ---------------------------------------------------------------------------

/** Minimal D1/Postgres-adapter surface this module needs. */
type PropagateDb = {
  prepare: (sql: string) => {
    bind: (...args: unknown[]) => {
      run: () => Promise<{ meta?: { changes?: number } } | unknown>;
    };
  };
};

export type TableUpdate = {
  table: string;
  /** How the rows were located. */
  matchedBy: "id" | "name";
  /** Rows changed, or null when the table is absent / the statement failed. */
  updated: number | null;
  error?: string;
};

export type PropagateSummary = {
  changed: boolean;
  oldName: string;
  newName: string;
  totalRows: number;
  tables: TableUpdate[];
};

// --- table registries (verified against migrations-postgres, 2026-08-01) ----

/** customer_name + customer_id. */
const CUSTOMER_ID_TABLES = [
  "ar_aging",
  "consignment_notes",
  "consignment_orders",
  "credit_notes",
  "debit_notes",
  "delivery_orders",
  "delivery_returns",
  "historical_sales",
  "invoices",
  "payment_records",
  "pl_entries",
  "sales_orders",
  "service_cases",
  "service_orders",
] as const;

/** customer_name but NO customer_id — matched on the old name. */
const CUSTOMER_NAME_ONLY_TABLES = [
  "e_invoices",
  "fg_units",
  "production_orders",
  "qc_inspections",
  "rack_items",
  "rack_locations",
  "schedule_entries",
] as const;

/** supplier_name + supplier_id — every supplier table is id-keyed. */
const SUPPLIER_ID_TABLES = [
  "ap_aging",
  "goods_in_transit",
  "grns",
  "purchase_credit_notes",
  "purchase_invoices",
  "purchase_orders",
  "supplier_payments",
  "three_way_matches",
] as const;

function changesOf(res: unknown): number {
  const meta = (res as { meta?: { changes?: number } } | null)?.meta;
  return typeof meta?.changes === "number" ? meta.changes : 0;
}

async function runUpdate(
  db: PropagateDb,
  sql: string,
  binds: unknown[],
  table: string,
  matchedBy: "id" | "name",
): Promise<TableUpdate> {
  try {
    const res = await db.prepare(sql).bind(...binds).run();
    return { table, matchedBy, updated: changesOf(res) };
  } catch (e) {
    // Absent table (environment drift) or a column that migration never
    // reached — record and carry on; one gap must not stop the rest.
    const error = e instanceof Error ? e.message : String(e);
    console.warn(`[party-name-propagate] ${table} skipped: ${error}`);
    return { table, matchedBy, updated: null, error };
  }
}

async function propagate(
  db: PropagateDb,
  opts: {
    nameCol: "customer_name" | "supplier_name";
    idCol: "customer_id" | "supplier_id";
    idTables: readonly string[];
    nameOnlyTables: readonly string[];
    partyId: string;
    oldName: string | null | undefined;
    newName: string | null | undefined;
  },
): Promise<PropagateSummary> {
  const oldName = (opts.oldName ?? "").trim();
  const newName = (opts.newName ?? "").trim();
  // Nothing to do unless the name actually changed to a non-empty value.
  if (!newName || oldName === newName) {
    return { changed: false, oldName, newName, totalRows: 0, tables: [] };
  }

  const tables: TableUpdate[] = [];
  for (const t of opts.idTables) {
    tables.push(
      await runUpdate(
        db,
        `UPDATE ${t} SET ${opts.nameCol} = ? WHERE ${opts.idCol} = ?`,
        [newName, opts.partyId],
        t,
        "id",
      ),
    );
  }
  // Name-only tables need a non-empty previous name to key on. A party whose
  // old name was blank has nothing to match, so skip rather than touch every
  // NULL-named row in the table.
  if (oldName) {
    for (const t of opts.nameOnlyTables) {
      tables.push(
        await runUpdate(
          db,
          `UPDATE ${t} SET ${opts.nameCol} = ? WHERE ${opts.nameCol} = ?`,
          [newName, oldName],
          t,
          "name",
        ),
      );
    }
  }

  const totalRows = tables.reduce((s, t) => s + (t.updated ?? 0), 0);
  return { changed: true, oldName, newName, totalRows, tables };
}

/**
 * Rewrite `customer_name` across all 21 snapshot tables after a customer
 * rename. Best-effort per table; never throws.
 */
export function propagateCustomerName(
  db: PropagateDb,
  customerId: string,
  oldName: string | null | undefined,
  newName: string | null | undefined,
): Promise<PropagateSummary> {
  return propagate(db, {
    nameCol: "customer_name",
    idCol: "customer_id",
    idTables: CUSTOMER_ID_TABLES,
    nameOnlyTables: CUSTOMER_NAME_ONLY_TABLES,
    partyId: customerId,
    oldName,
    newName,
  });
}

/**
 * Rewrite `supplier_name` across all 8 snapshot tables after a supplier
 * rename. Best-effort per table; never throws.
 */
export function propagateSupplierName(
  db: PropagateDb,
  supplierId: string,
  oldName: string | null | undefined,
  newName: string | null | undefined,
): Promise<PropagateSummary> {
  return propagate(db, {
    nameCol: "supplier_name",
    idCol: "supplier_id",
    idTables: SUPPLIER_ID_TABLES,
    nameOnlyTables: [],
    partyId: supplierId,
    oldName,
    newName,
  });
}

/** Exposed for tests + the one-off backfill script. */
export const PROPAGATE_TABLES = {
  customerIdTables: CUSTOMER_ID_TABLES,
  customerNameOnlyTables: CUSTOMER_NAME_ONLY_TABLES,
  supplierIdTables: SUPPLIER_ID_TABLES,
};

// --- one-shot backfill for names that drifted BEFORE propagation existed ----
//
// Owner 2026-08-01 chose "fix the mechanism first, then backfill once". Every
// rename made before this shipped left its snapshots stale (400-A002 alone:
// 24 PIs + 13 POs). This realigns id-keyed snapshot tables to the master row
// in one statement per table — no old-name knowledge needed, because the join
// back to customers / suppliers IS the source of truth.
//
// The 7 id-less customer tables CANNOT be backfilled this way (nothing to join
// on). They stay stale for pre-existing drift and are reported as skipped;
// from now on the rename hook keeps them current going forward.

export type BackfillResult = {
  tables: TableUpdate[];
  totalRows: number;
  /** Tables that carry no id column and cannot be realigned retroactively. */
  notBackfillable: string[];
};

async function backfill(
  db: PropagateDb,
  master: "customers" | "suppliers",
  nameCol: "customer_name" | "supplier_name",
  idCol: "customer_id" | "supplier_id",
  idTables: readonly string[],
  notBackfillable: readonly string[],
  onlyPartyId?: string | null,
): Promise<BackfillResult> {
  const tables: TableUpdate[] = [];
  for (const t of idTables) {
    // IS DISTINCT FROM so only genuinely stale rows are touched (NULL-safe),
    // keeping the changed-row count an honest measure of the drift fixed.
    const scope = onlyPartyId ? ` AND t.${idCol} = ?` : "";
    const sql =
      `UPDATE ${t} AS t SET ${nameCol} = m.name FROM ${master} AS m ` +
      `WHERE t.${idCol} = m.id AND t.${nameCol} IS DISTINCT FROM m.name${scope}`;
    tables.push(
      await runUpdate(db, sql, onlyPartyId ? [onlyPartyId] : [], t, "id"),
    );
  }
  return {
    tables,
    totalRows: tables.reduce((s, t) => s + (t.updated ?? 0), 0),
    notBackfillable: [...notBackfillable],
  };
}

/** Realign every supplier_name snapshot to the suppliers master. */
export function backfillSupplierNames(
  db: PropagateDb,
  onlySupplierId?: string | null,
): Promise<BackfillResult> {
  return backfill(db, "suppliers", "supplier_name", "supplier_id", SUPPLIER_ID_TABLES, [], onlySupplierId);
}

/** Realign every id-keyed customer_name snapshot to the customers master. */
export function backfillCustomerNames(
  db: PropagateDb,
  onlyCustomerId?: string | null,
): Promise<BackfillResult> {
  return backfill(db, "customers", "customer_name", "customer_id", CUSTOMER_ID_TABLES, CUSTOMER_NAME_ONLY_TABLES, onlyCustomerId);
}
