// ---------------------------------------------------------------------------
// stock-breakdown.ts — GET /api/stock/breakdown?type=RM|WIP|FG&itemId=…
//
// ONE endpoint, one response shape, three item types. The drawer that renders
// it is one component; only `lots` changes meaning between types (a FIFO batch
// for RM, a physical piece for FG, a production order's in-flight work for
// WIP). Everything else — header, movements, cogs — is uniform, which is the
// only reason a single component can serve all three.
//
//   { header, lots, movements, cogs }
//
// READ-ONLY. Nothing here writes; the ledger is fed side-effectually by GRN /
// production-order / delivery-order (see docs/CODEBASE-MAP.md "Accounting").
//
// TWO RULES THIS FILE EXISTS TO HONOUR
//
//   • The running balance is COMPUTED, never stored. It is derived in
//     src/lib/stock-breakdown.ts from the movement list itself, so the column
//     and the rows cannot drift apart. `wip_items` drifted precisely because a
//     total was stored alongside the movements that produce it.
//
//   • Where the data cannot support a figure, the response says so instead of
//     showing one. `header.reconciliation` and `header.ledgerVsOnHand` carry
//     plain-English notices that the panel renders verbatim.
//
// SQL NOTE — every alias in here is DOUBLE-QUOTED camelCase on purpose. The
// Postgres compat layer rewrites bare camelCase identifiers to snake_case via
// column-rename-map.json, and Postgres folds any unquoted alias to lower case,
// so `AS grnNo` comes back as `grnno` and every read of `row.grnNo` is
// silently undefined. That exact fault broke the Stock Adjustments picker in
// August. Quote the alias, and check both sides.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import {
  ageDays,
  closingBalance,
  fifoAge,
  ledgerVsOnHand,
  reconciliationOf,
  roundQty,
  sourceDocHref,
  withRunningBalance,
  type CogsRow,
  type RmLot,
  type StockBreakdown,
  type StockItemType,
  type StockMovement,
} from "../../lib/stock-breakdown";

const app = new Hono<Env>();

const ITEM_TYPES: StockItemType[] = ["RM", "WIP", "FG"];

// ---------------------------------------------------------------------------
// Raw row shapes. Field names here MUST match the quoted aliases in the SQL
// below, character for character — that pairing is the bug class this file's
// header warns about, and a type alone will not catch it (the row arrives as
// `any` from the driver).
// ---------------------------------------------------------------------------
type LedgerRow = {
  id: string;
  date: string;
  type: string;
  direction: string;
  qty: number;
  unitCostSen: number;
  totalCostSen: number;
  batchId: string | null;
  refType: string | null;
  refId: string | null;
  notes: string | null;
  workerId: string | null;
  // production order behind an issue / completion
  prodOrderNo: string | null;
  prodSalesOrderId: string | null;
  prodSalesOrderNo: string | null;
  prodCustomerName: string | null;
  // goods receipt behind a receipt
  grnNo: string | null;
  grnPoId: string | null;
  grnPoNo: string | null;
  grnSupplierName: string | null;
};

type RmBatchRow = {
  id: string;
  source: string;
  sourceRefId: string | null;
  grnId: string | null;
  supplierId: string | null;
  receivedDate: string | null;
  originalQty: number;
  remainingQty: number;
  unitCostSen: number;
  notes: string | null;
  grnDocId: string | null;
  grnDocNo: string | null;
  grnPoId: string | null;
  grnPoNo: string | null;
  grnSupplierName: string | null;
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * The GRN a lot came from, when the lot itself does not say.
 *
 * On prod `rm_batches.grnId` and `supplierId` are NULL on all 1,100 GRN-sourced
 * lots and `sourceRefId` is set on exactly one — the link was never
 * backfilled. The batch id itself encodes it (`rmb-grn-<grnId>-<lineNo>`), and
 * that is a real link, not a guess: `genBatchId` in the GRN post-to-stock
 * cascade builds the id from the GRN id.
 */
export function grnIdFromBatchId(batchId: string | null | undefined): string | null {
  if (!batchId) return null;
  const m = /^rmb-grn-(.+)-\d+$/.exec(batchId);
  return m ? m[1] : null;
}

/**
 * The GRN NUMBER printed in a lot's notes ("GRN GRN-IMPORT-PI-2603-058 line 1")
 * or a receipt's notes ("Received via GRN-IMPORT-PI-2603-058").
 *
 * Worth extracting because on prod only 37 GRN documents survive against 542
 * distinct GRN numbers referenced by the lots — the pre-April receipts were
 * purged. The number is the only trace left. It renders as plain text with no
 * link, which is the honest rendering: we know which receipt it was, and the
 * document is gone.
 */
export function grnNoFromNotes(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const m =
    /^GRN\s+(\S+)\s+line\s+\d+/.exec(notes) ??
    /Received via\s+(\S+)/.exec(notes) ??
    /^Edit\s+(\S+?):/.exec(notes);
  return m ? m[1] : null;
}

/** Lot notes that are just the source stamp carry no attributes worth showing. */
function lotAttributes(notes: string | null): string | null {
  if (!notes) return null;
  if (/^GRN\s+\S+\s+line\s+\d+/.test(notes)) return null;
  if (/^Opening balance seed/i.test(notes)) return null;
  return notes;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// GET /api/stock/breakdown
// ---------------------------------------------------------------------------
app.get("/breakdown", async (c) => {
  const denied = await requirePermission(c, "inventory", "read");
  if (denied) return denied;

  const type = (c.req.query("type") ?? "").toUpperCase() as StockItemType;
  const itemId = (c.req.query("itemId") ?? "").trim();
  if (!ITEM_TYPES.includes(type)) {
    return c.json(
      { success: false, error: "type must be one of RM, WIP, FG" },
      400,
    );
  }
  if (!itemId) return c.json({ success: false, error: "itemId is required" }, 400);

  const orgId = getOrgId(c);

  if (type === "RM") {
    const data = await buildRmBreakdown(c, orgId, itemId);
    if (!data) return c.json({ success: false, error: "Not found" }, 404);
    return c.json({ success: true, data });
  }

  // FG and WIP land in follow-up commits; refuse loudly rather than return an
  // empty shell that reads as "this item has no stock".
  return c.json(
    { success: false, error: `Stock breakdown for ${type} is not available yet` },
    501,
  );
});

// ---------------------------------------------------------------------------
// RAW MATERIALS
//
// The complete case: rm_batches is a real FIFO layer table and cost_ledger
// carries both directions, so every section of the drawer has something true
// to show here.
// ---------------------------------------------------------------------------
async function buildRmBreakdown(
  c: Context<Env>,
  orgId: string,
  itemId: string,
): Promise<StockBreakdown | null> {
  const db = c.var.DB;

  const item = await db
    .prepare(
      `SELECT id, itemCode, description, baseUOM, itemGroup, balanceQty
         FROM raw_materials
        WHERE id = ? AND orgId = ?`,
    )
    .bind(itemId, orgId)
    .first<{
      id: string;
      itemCode: string;
      description: string | null;
      baseUOM: string | null;
      itemGroup: string | null;
      balanceQty: number | null;
    }>();
  if (!item) return null;

  const [lotRes, ledgerRes] = await Promise.all([
    // FIFO order — oldest first, because that is the order the next issue
    // consumes them in. The panel says so above the table.
    db
      .prepare(
        `SELECT b.id, b.source, b.sourceRefId, b.grnId, b.supplierId,
                b.receivedDate, b.originalQty, b.remainingQty, b.unitCostSen,
                b.notes,
                g.id           AS "grnDocId",
                g.grnNumber    AS "grnDocNo",
                g.poId         AS "grnPoId",
                g.poNumber     AS "grnPoNo",
                g.supplierName AS "grnSupplierName"
           FROM rm_batches b
           LEFT JOIN grns g
                  ON g.id = COALESCE(
                       b.grnId,
                       b.sourceRefId,
                       substring(b.id from '^rmb-grn-(.*)-[0-9]+$')
                     )
          WHERE b.rmId = ?
          ORDER BY b.receivedDate ASC, b.id ASC`,
      )
      .bind(itemId)
      .all<RmBatchRow>(),
    db
      .prepare(
        `SELECT cl.id, cl.date, cl.type, cl.direction, cl.qty,
                cl.unitCostSen, cl.totalCostSen, cl.batchId,
                cl.refType, cl.refId, cl.notes, cl.workerId,
                po.poNo          AS "prodOrderNo",
                po.salesOrderId  AS "prodSalesOrderId",
                po.salesOrderNo  AS "prodSalesOrderNo",
                po.customerName  AS "prodCustomerName",
                g.grnNumber      AS "grnNo",
                g.poId           AS "grnPoId",
                g.poNumber       AS "grnPoNo",
                g.supplierName   AS "grnSupplierName"
           FROM cost_ledger cl
           LEFT JOIN production_orders po ON po.id = cl.refId
           LEFT JOIN grns g               ON g.id  = cl.refId
          WHERE cl.itemType = 'RM' AND cl.itemId = ?
          ORDER BY cl.date DESC, cl.id DESC`,
      )
      .bind(itemId)
      .all<LedgerRow>(),
  ]);

  const lotRows = lotRes.results ?? [];
  const ledgerRows = ledgerRes.results ?? [];

  // --- lots ---------------------------------------------------------------
  const lots: RmLot[] = lotRows.map((b) => {
    const grnNo = b.grnDocNo ?? grnNoFromNotes(b.notes);
    const grnId = b.grnDocId ?? null; // only a row that EXISTS gets a link
    return {
      kind: "RM_LOT" as const,
      id: b.id,
      // No warehouse dimension exists for raw material today — rm_batches has
      // no location column and there is no warehouses table. Null, not a
      // placeholder that looks like a real location.
      warehouse: null,
      attributes: lotAttributes(b.notes),
      qty: roundQty(num(b.remainingQty)),
      originalQty: roundQty(num(b.originalQty)),
      consumedQty: roundQty(num(b.originalQty) - num(b.remainingQty)),
      unitCostSen: num(b.unitCostSen),
      valueSen: Math.round(Math.max(0, num(b.remainingQty)) * num(b.unitCostSen)),
      source: b.source,
      grnNo,
      grnHref: sourceDocHref("GRN", grnId),
      purchaseOrderNo: b.grnPoNo ?? null,
      purchaseOrderHref: sourceDocHref("PURCHASE_ORDER", b.grnPoId),
      supplierName: b.grnSupplierName ?? null,
      receivedDate: b.receivedDate,
      ageDays: ageDays(b.receivedDate),
    };
  });
  const lotById = new Map(lots.map((l) => [l.id, l]));

  // --- movements ----------------------------------------------------------
  const movements: StockMovement[] = ledgerRows.map((r) => {
    const isIn = r.direction === "IN";
    const lot = r.batchId ? lotById.get(r.batchId) : undefined;

    // A receipt points at its GRN; an issue points at its production order.
    // Pre-April receipts carry no refId at all (the GRN was purged), so the
    // number falls back to the notes and the row renders un-clickable.
    const docType = isIn ? ("GRN" as const) : ("PRODUCTION_ORDER" as const);
    const docNo = isIn
      ? (r.grnNo ?? grnNoFromNotes(r.notes) ?? lot?.grnNo ?? null)
      : (r.prodOrderNo ?? null);
    const docHref = isIn
      ? sourceDocHref("GRN", r.grnNo ? r.refId : null)
      : sourceDocHref("PRODUCTION_ORDER", r.refId, {
          salesOrderId: r.prodSalesOrderId,
        });

    return {
      id: r.id,
      date: r.date,
      direction: isIn ? "IN" : "OUT",
      type: r.type,
      qty: roundQty(num(r.qty)),
      unitCostSen: num(r.unitCostSen),
      totalCostSen: num(r.totalCostSen),
      balanceAfter: null, // derived below — never read from a column
      docType,
      docId: r.refId,
      docNo,
      docHref,
      supplierName: isIn ? (r.grnSupplierName ?? lot?.supplierName ?? null) : null,
      purchaseOrderNo: isIn ? (r.grnPoNo ?? lot?.purchaseOrderNo ?? null) : null,
      purchaseOrderHref: isIn
        ? (sourceDocHref("PURCHASE_ORDER", r.grnPoId) ?? lot?.purchaseOrderHref ?? null)
        : null,
      productionOrderNo: isIn ? null : (r.prodOrderNo ?? null),
      productionOrderHref: isIn
        ? null
        : sourceDocHref("PRODUCTION_ORDER", r.refId, {
            salesOrderId: r.prodSalesOrderId,
          }),
      // Department, taker and job card are columns the owner asked for and the
      // data does not have. An RM issue is booked against the production order,
      // not the job card, and cost_ledger.workerId is NULL on every one of the
      // 2,967 raw-material rows on prod. Null renders as an em dash rather than
      // a guess at which department happened to be running that PO.
      department: null,
      takenByName: null,
      jobCardNo: null,
      jobCardHref: null,
      salesOrderNo: isIn ? null : (r.prodSalesOrderNo ?? null),
      salesOrderHref: isIn
        ? null
        : sourceDocHref("SALES_ORDER", r.prodSalesOrderId),
      customerName: isIn ? null : (r.prodCustomerName ?? null),
      batchId: r.batchId,
      notes: r.notes,
    };
  });

  const reconciliation = reconciliationOf("RM", movements);
  const stamped = withRunningBalance(movements, reconciliation);

  // --- COGS ---------------------------------------------------------------
  // Every outbound movement is a FIFO consumption of a named lot; batchId says
  // which one, so the operator can see exactly which receipt paid for the job.
  const cogs: CogsRow[] = stamped
    .filter((m) => m.direction === "OUT")
    .map((m) => {
      const lot = m.batchId ? lotById.get(m.batchId) : undefined;
      return {
        id: m.id,
        consumedAt: m.date,
        docType: m.docType,
        docNo: m.docNo,
        docHref: m.docHref,
        qty: m.qty,
        unitCostSen: m.unitCostSen,
        totalCostSen: m.totalCostSen,
        fromLotId: m.batchId ?? null,
        fromLotLabel: lot
          ? [lot.grnNo, lot.receivedDate?.slice(0, 10)].filter(Boolean).join(" · ") ||
            lot.id
          : (m.batchId ?? null),
      };
    });

  // --- header -------------------------------------------------------------
  const onHandQty = roundQty(lots.reduce((s, l) => s + l.qty, 0));
  const totalValueSen = lots.reduce((s, l) => s + l.valueSen, 0);
  const openingSeedQty = roundQty(
    lotRows
      .filter((b) => b.source === "OPENING")
      .reduce((s, b) => s + num(b.originalQty), 0),
  );
  const { ageDays: oldestAgeDays, date: oldestLayerDate } = fifoAge(
    lots.map((l) => ({ date: l.receivedDate, qty: l.qty })),
  );

  return {
    header: {
      itemType: "RM",
      itemId: item.id,
      itemCode: item.itemCode,
      itemName: item.description ?? "",
      uom: item.baseUOM ?? "",
      totalQty: onHandQty,
      // Raw material is not reserved against a customer document anywhere in
      // this system — a production order draws it at issue time, it is never
      // earmarked before that. So everything on hand is free, and saying so is
      // more useful than an "Assigned" figure invented from nothing.
      assignedQty: 0,
      freeQty: onHandQty,
      totalValueSen,
      oldestAgeDays,
      oldestLayerDate,
      reconciliation,
      ledgerVsOnHand: ledgerVsOnHand(
        closingBalance(movements, reconciliation),
        onHandQty,
        openingSeedQty,
      ),
    },
    lots,
    movements: stamped,
    cogs,
  };
}

export default app;
