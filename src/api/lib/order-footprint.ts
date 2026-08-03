// ---------------------------------------------------------------------------
// order-footprint.ts — everything attached to ONE sales order, READ-ONLY.
//
// Why this exists (owner 2026-08-03): "这一个 order 是以前旧的… 其实里面已经没有
// 东西了… 帮我把整个数据清洗掉". Before anything is deleted, "已经没有东西了"
// has to be a FACT rather than an impression — a sales order is the head of a
// chain that reaches production orders, job cards, delivery orders and
// invoices, and hard-deleting the head leaves orphans in the accounting and
// dispatch records that month-end reconciliation depends on.
//
// This module answers "what is actually still hanging off this order?" and
// nothing else. It writes NOTHING — the DbLike below deliberately has no
// `run`, so a write cannot be added here without the change being obvious.
//
// The usual right answer for a dead order is CANCELLED, not deleted: both
// ON_HOLD and CANCELLED are already in EXCLUDED_ORDER_STATUSES, so a cancelled
// order stops reaching the planner while its audit trail survives. Deletion is
// only reasonable once this report comes back empty everywhere that matters.
// ---------------------------------------------------------------------------

interface DbLike {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      all<T = unknown>(): Promise<{ results?: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

export interface FootprintRow {
  table: string;
  /** What this table means in business terms, for the person reading it. */
  meaning: string;
  count: number;
  /** True when rows here make deletion unsafe rather than merely untidy. */
  blocksDeletion: boolean;
  /** A few identifying values, so the owner can eyeball what is there. */
  sample: string[];
  /** Set when the table could not be read (absent column / table). */
  error?: string;
}

export interface OrderFootprint {
  /** The resolved sales_orders.id, or null when nothing matched. */
  soId: string | null;
  /** The human reference (companySOId) as stored. */
  soRef: string | null;
  customer: string | null;
  status: string | null;
  found: boolean;
  rows: FootprintRow[];
  /** Total rows across every table. 0 = the order really is empty. */
  totalRows: number;
  /** True when nothing blocks a delete — advisory, never automatic. */
  safeToDelete: boolean;
  recommendation: string;
}

/**
 * Resolve a user-typed reference to the sales order. Accepts the internal id
 * OR the companySOId the owner actually reads off the screen.
 */
async function resolveOrder(
  db: DbLike,
  ref: string,
): Promise<{ id: string; soRef: string | null; customer: string | null; status: string | null } | null> {
  try {
    const row = await db
      .prepare(
        `SELECT id, companySOId AS so_ref, customerName AS customer, status
           FROM sales_orders
          WHERE id = ? OR companySOId = ?
          LIMIT 1`,
      )
      .bind(ref, ref)
      .first<{ id: string; so_ref?: string | null; soRef?: string | null; customer?: string | null; status?: string | null }>();
    if (!row) return null;
    return {
      id: row.id,
      soRef: (row.soRef ?? row.so_ref) ?? null,
      customer: row.customer ?? null,
      status: row.status ?? null,
    };
  } catch {
    return null;
  }
}

interface Probe {
  table: string;
  meaning: string;
  blocksDeletion: boolean;
  sql: string;
  /** How many bind params the SQL needs (id repeated). */
  binds: (id: string, ref: string) => unknown[];
}

/**
 * One probe per table that can hold something belonging to the order.
 * `blocksDeletion` marks the records whose loss would break an audit trail —
 * invoices and delivery orders are financial and dispatch evidence, so an
 * orphan there is materially worse than an orphan job card.
 */
const PROBES: Probe[] = [
  {
    table: "sales_order_items",
    meaning: "Order lines",
    blocksDeletion: false,
    sql: "SELECT id AS k FROM sales_order_items WHERE salesOrderId = ? LIMIT 50",
    binds: (id) => [id],
  },
  {
    table: "production_orders",
    meaning: "Production orders (PO)",
    blocksDeletion: false,
    sql: "SELECT poNo AS k FROM production_orders WHERE salesOrderId = ? LIMIT 50",
    binds: (id) => [id],
  },
  {
    table: "job_cards",
    meaning: "Job cards on those POs",
    blocksDeletion: false,
    sql: `SELECT jc.id AS k
            FROM job_cards jc
            JOIN production_orders po ON po.id = jc.productionOrderId
           WHERE po.salesOrderId = ? LIMIT 50`,
    binds: (id) => [id],
  },
  {
    table: "job_cards (not yet finished)",
    meaning: "Work still open on the floor",
    blocksDeletion: true,
    sql: `SELECT jc.id AS k
            FROM job_cards jc
            JOIN production_orders po ON po.id = jc.productionOrderId
           WHERE po.salesOrderId = ?
             AND jc.status NOT IN ('COMPLETED','CANCELLED','TRANSFERRED') LIMIT 50`,
    binds: (id) => [id],
  },
  {
    table: "delivery_orders",
    meaning: "Delivery orders — dispatch evidence",
    blocksDeletion: true,
    sql: "SELECT doNo AS k FROM delivery_orders WHERE salesOrderId = ? LIMIT 50",
    binds: (id) => [id],
  },
  {
    table: "invoices",
    meaning: "Invoices — financial record",
    blocksDeletion: true,
    sql: "SELECT invoiceNo AS k FROM invoices WHERE salesOrderId = ? LIMIT 50",
    binds: (id) => [id],
  },
  {
    table: "cs_promise_log",
    meaning: "Delivery dates promised to the customer",
    blocksDeletion: false,
    sql: "SELECT id AS k FROM cs_promise_log WHERE so_id = ? LIMIT 50",
    binds: (id, ref) => [ref || id],
  },
  {
    table: "schedule_proposals",
    meaning: "Pending scheduling proposals",
    blocksDeletion: false,
    sql: "SELECT id AS k FROM schedule_proposals WHERE so_ref LIKE ? LIMIT 50",
    binds: (id, ref) => [`${ref || id}%`],
  },
];

/**
 * Build the footprint. Every probe is best-effort: a missing table or renamed
 * column reports as an error on its own row rather than failing the report,
 * because a partial answer is still useful and a crash tells the owner nothing.
 */
export async function buildOrderFootprint(db: DbLike, ref: string): Promise<OrderFootprint> {
  const order = await resolveOrder(db, ref);
  if (!order) {
    return {
      soId: null,
      soRef: null,
      customer: null,
      status: null,
      found: false,
      rows: [],
      totalRows: 0,
      safeToDelete: false,
      recommendation: `No sales order matched "${ref}" — check the reference before doing anything.`,
    };
  }

  const rows: FootprintRow[] = [];
  for (const p of PROBES) {
    try {
      const res = await db
        .prepare(p.sql)
        .bind(...p.binds(order.id, order.soRef ?? ""))
        .all<{ k: string | null }>();
      const hits = res.results ?? [];
      rows.push({
        table: p.table,
        meaning: p.meaning,
        count: hits.length,
        blocksDeletion: p.blocksDeletion,
        sample: hits.slice(0, 5).map((h) => String(h.k ?? "")).filter(Boolean),
      });
    } catch (e) {
      rows.push({
        table: p.table,
        meaning: p.meaning,
        count: 0,
        blocksDeletion: p.blocksDeletion,
        sample: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const totalRows = rows.reduce((s, r) => s + r.count, 0);
  const blockers = rows.filter((r) => r.blocksDeletion && r.count > 0);
  const unreadable = rows.filter((r) => r.error);
  const safeToDelete = blockers.length === 0 && unreadable.length === 0;

  let recommendation: string;
  if (unreadable.length > 0) {
    recommendation =
      `${unreadable.length} table(s) could not be read, so this report is INCOMPLETE — do not delete anything until they are resolved.`;
  } else if (blockers.length > 0) {
    recommendation =
      `Do NOT delete: ${blockers.map((b) => `${b.count} ${b.meaning.toLowerCase()}`).join(", ")}. ` +
      `Set the order to CANCELLED instead — cancelled orders are already excluded from planning, and the audit trail survives.`;
  } else if (totalRows > 0) {
    recommendation =
      `Nothing financial or dispatch-related is attached, but ${totalRows} row(s) still exist. CANCELLED is still the safer action; ` +
      `delete only if you specifically need these rows gone.`;
  } else {
    recommendation =
      "Nothing is attached — this order really is empty. Deleting it would remove only the order header.";
  }

  return {
    soId: order.id,
    soRef: order.soRef,
    customer: order.customer,
    status: order.status,
    found: true,
    rows,
    totalRows,
    safeToDelete,
    recommendation,
  };
}
