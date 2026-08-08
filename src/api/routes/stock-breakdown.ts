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
  fgUnitCostSen,
  fifoAge,
  ledgerVsOnHand,
  piecesNote,
  reconciliationOf,
  roundQty,
  sourceDocHref,
  valuationNote,
  withRunningBalance,
  type CogsRow,
  type FgLot,
  type RmLot,
  type StockBreakdown,
  type StockItemType,
  type StockMovement,
  type WipLot,
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

  // Now that a ROW CLICK opens this drawer, a miss is something an operator can
  // hit by accident on any grid row — most often a row the FG or WIP grid
  // derives from a production order, which has no catalogue record behind it.
  // "Not found" would read as a fault; the panel renders this verbatim instead.
  const NOT_FOUND =
    "No catalogue item matches this row, so there is no stock ledger to read. " +
    "Rows derived from production orders have no item record of their own.";

  if (type === "RM") {
    const data = await buildRmBreakdown(c, orgId, itemId);
    if (!data) return c.json({ success: false, error: NOT_FOUND }, 404);
    return c.json({ success: true, data });
  }

  if (type === "FG") {
    const data = await buildFgBreakdown(c, orgId, itemId);
    if (!data) return c.json({ success: false, error: NOT_FOUND }, 404);
    return c.json({ success: true, data });
  }

  const data = await buildWipBreakdown(c, orgId, itemId);
  if (!data) return c.json({ success: false, error: NOT_FOUND }, 404);
  return c.json({ success: true, data });
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
      qtyNote: null,
      totalValueSen,
      valuationNote: null,
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

// ---------------------------------------------------------------------------
// FINISHED GOODS
//
// Same drawer, same four sections; `lots` becomes one row per PHYSICAL PIECE
// (fg_units) instead of one row per cost layer, because that is what a finished
// good actually is here — a serialised piece with a maker, a date and, usually,
// a customer already waiting for it.
//
// Two facts about the live data shape everything below:
//
//   • fg_units.batchId is NULL on all 4,866 rows on prod — the link from a
//     piece to its cost layer. The write side + backfill landed on 2026-08-08
//     (`src/api/lib/fg-batch-link.ts`) but the backfill has not been RUN, so
//     the column is still empty. A piece's unit cost is therefore looked up
//     through its PRODUCTION ORDER instead, and where even that is absent the
//     cost renders as an em dash. On prod that is most of the shelf, and the
//     panel says so rather than quietly totalling only the priced third. The
//     direct layer takes over on its own once the backfill runs;
//
//   • the two legs of the FG ledger do not count the same thing. FG_COMPLETED
//     books UNITS (2,938 across 1,451 rows); FG_DELIVERED books one row per
//     FIFO slice, always qty 1 (2,680 rows). Their difference is therefore not
//     a stock count, and the panel refuses to present it as one.
// ---------------------------------------------------------------------------
type FgUnitRow = {
  id: string;
  unitSerial: string | null;
  shortCode: string | null;
  status: string;
  mfdDate: string | null;
  pieceNo: number | null;
  totalPieces: number | null;
  pieceName: string | null;
  unitNo: number | null;
  batchId: string | null;
  poId: string | null;
  poNo: string | null;
  soId: string | null;
  soNo: string | null;
  customerName: string | null;
  doId: string | null;
  prodSalesOrderId: string | null;
  doNo: string | null;
  batchUnitCostSen: number | null;
  poUnitCostSen: number | null;
};

type FgLedgerRow = LedgerRow & {
  doNo: string | null;
  doSalesOrderId: string | null;
  doCustomerName: string | null;
};

/** Statuses that mean the piece has left the building. */
const FG_GONE = new Set(["DELIVERED", "RETURNED"]);

async function buildFgBreakdown(
  c: Context<Env>,
  orgId: string,
  itemId: string,
): Promise<StockBreakdown | null> {
  const db = c.var.DB;

  const item = await db
    .prepare(
      `SELECT id, code, name, category FROM products WHERE id = ? AND orgId = ?`,
    )
    .bind(itemId, orgId)
    .first<{ id: string; code: string; name: string | null; category: string | null }>();
  if (!item) return null;

  const [unitRes, ledgerRes, doSerialRes] = await Promise.all([
    // One row per piece, oldest first — the same FIFO order the lots table
    // claims at the top of the section.
    //
    // fg_units reaches its product by CODE, not id (there is no productId
    // column), which is why the caller passes a product id and this join goes
    // back through products.code.
    db
      .prepare(
        `SELECT u.id, u.unitSerial, u.shortCode, u.status, u.mfdDate,
                u.pieceNo, u.totalPieces, u.pieceName, u.unitNo, u.batchId,
                u.poId, u.poNo, u.soId, u.soNo, u.customerName, u.doId,
                po.salesOrderId AS "prodSalesOrderId",
                d.doNo          AS "doNo",
                fb.unitCostSen  AS "batchUnitCostSen",
                -- Fallback cost: the completion the accounting cascade booked
                -- for THIS piece's production order — same product, same PO,
                -- the figure that was actually posted rather than an average.
                --
                -- A SCALAR SUBQUERY, not a join, and deliberately so: a PO can
                -- carry several FG_COMPLETED rows (three is common on prod,
                -- from re-postings), and joining would fan one piece out into
                -- three lot rows and treble the shelf. Latest posting wins.
                (SELECT pol.unitCostSen
                   FROM cost_ledger pol
                  WHERE pol.itemType = 'FG'
                    AND pol.type     = 'FG_COMPLETED'
                    AND pol.itemId   = p.id
                    AND pol.refId    = u.poId
                  ORDER BY pol.date DESC, pol.id DESC
                  LIMIT 1)      AS "poUnitCostSen"
           FROM fg_units u
           JOIN products p            ON p.code = u.productCode
           LEFT JOIN production_orders po ON po.id = u.poId
           LEFT JOIN delivery_orders d    ON d.id  = u.doId
           -- Direct cost layer. Matches nothing on prod today (batchId is
           -- still NULL on every row — the backfill that fills it has landed
           -- but not been run) and costs nothing to keep; it takes over on its
           -- own the moment the column is populated. Joined on the primary
           -- key, so it cannot fan out.
           LEFT JOIN fg_batches fb    ON fb.id = u.batchId
          WHERE p.id = ?
            -- STOCK lots means the stock you still have. A delivered piece is
            -- history, and its history is already in Movements and COGS below.
            -- Including it would also bury the shelf: 1013-(Q) has 1,044 pieces
            -- on prod and 30 of them are on hand.
            AND u.status NOT IN ('DELIVERED', 'RETURNED')
          ORDER BY u.mfdDate ASC, u.unitSerial ASC, u.id ASC`,
      )
      .bind(itemId)
      .all<FgUnitRow>(),
    db
      .prepare(
        `SELECT cl.id, cl.date, cl.type, cl.direction, cl.qty,
                cl.unitCostSen, cl.totalCostSen, cl.batchId,
                cl.refType, cl.refId, cl.notes, cl.workerId,
                po.poNo          AS "prodOrderNo",
                po.salesOrderId  AS "prodSalesOrderId",
                po.salesOrderNo  AS "prodSalesOrderNo",
                po.customerName  AS "prodCustomerName",
                d.doNo           AS "doNo",
                d.salesOrderId   AS "doSalesOrderId",
                d.customerName   AS "doCustomerName"
           FROM cost_ledger cl
           LEFT JOIN production_orders po ON po.id = cl.refId
           LEFT JOIN delivery_orders d    ON d.id  = cl.refId
          WHERE cl.itemType = 'FG' AND cl.itemId = ?
          ORDER BY cl.date DESC, cl.id DESC`,
      )
      .bind(itemId)
      .all<FgLedgerRow>(),
    // Which serials left on which delivery order — the "which unit serials"
    // column on FG OUT, and the lot identity on the COGS rows.
    db
      .prepare(
        `SELECT u.doId AS "doId", u.unitSerial AS "unitSerial"
           FROM fg_units u
           JOIN products p ON p.code = u.productCode
          WHERE p.id = ? AND u.doId IS NOT NULL
          ORDER BY u.unitSerial ASC`,
      )
      .bind(itemId)
      .all<{ doId: string; unitSerial: string | null }>(),
  ]);

  const unitRows = unitRes.results ?? [];
  const ledgerRows = ledgerRes.results ?? [];

  const serialsByDo = new Map<string, string[]>();
  for (const r of doSerialRes.results ?? []) {
    if (!r.doId || !r.unitSerial) continue;
    const list = serialsByDo.get(r.doId) ?? [];
    list.push(r.unitSerial);
    serialsByDo.set(r.doId, list);
  }

  // --- lots (one per piece still owned) -----------------------------------
  const lots: FgLot[] = unitRows.map((u) => {
    // The query already excludes delivered pieces; this guard keeps `qty`
    // honest if that filter is ever relaxed.
    const gone = FG_GONE.has(u.status);
    const unitCostSen = fgUnitCostSen(u.batchUnitCostSen, u.poUnitCostSen);
    const attributes =
      [
        u.pieceName,
        u.pieceNo && u.totalPieces ? `piece ${u.pieceNo}/${u.totalPieces}` : null,
        u.unitNo ? `unit ${u.unitNo}` : null,
      ]
        .filter(Boolean)
        .join(" · ") || null;
    return {
      kind: "FG_UNIT" as const,
      id: u.id,
      serial: u.unitSerial ?? u.id,
      shortCode: u.shortCode,
      attributes,
      // A piece is one piece. Delivered pieces stay in the list (they are the
      // history of this SKU) but count zero towards what is owned.
      qty: gone ? 0 : 1,
      unitCostSen,
      valueSen: gone || unitCostSen === null ? null : unitCostSen,
      productionOrderNo: u.poNo,
      productionOrderHref: sourceDocHref("PRODUCTION_ORDER", u.poId, {
        salesOrderId: u.prodSalesOrderId,
      }),
      mfdDate: u.mfdDate,
      ageDays: ageDays(u.mfdDate),
      claimedBySoNo: u.soNo,
      claimedBySoHref: sourceDocHref("SALES_ORDER", u.soId),
      customerName: u.customerName,
      status: u.status,
      deliveryOrderNo: u.doNo,
      deliveryOrderHref: sourceDocHref("DELIVERY_ORDER", u.doId),
    };
  });

  // --- movements ----------------------------------------------------------
  const movements: StockMovement[] = ledgerRows.map((r) => {
    const isIn = r.direction === "IN";
    const docType = isIn ? ("PRODUCTION_ORDER" as const) : ("DELIVERY_ORDER" as const);
    const salesOrderId = isIn ? r.prodSalesOrderId : r.doSalesOrderId;
    return {
      id: r.id,
      date: r.date,
      direction: isIn ? "IN" : "OUT",
      type: r.type,
      qty: roundQty(num(r.qty)),
      unitCostSen: num(r.unitCostSen),
      totalCostSen: num(r.totalCostSen),
      balanceAfter: null, // derived below
      docType,
      docId: r.refId,
      docNo: isIn ? r.prodOrderNo : r.doNo,
      docHref: isIn
        ? sourceDocHref("PRODUCTION_ORDER", r.refId, { salesOrderId })
        : sourceDocHref("DELIVERY_ORDER", r.refId),
      productionOrderNo: isIn ? r.prodOrderNo : null,
      productionOrderHref: isIn
        ? sourceDocHref("PRODUCTION_ORDER", r.refId, { salesOrderId })
        : null,
      salesOrderNo: isIn ? r.prodSalesOrderNo : null,
      salesOrderHref: sourceDocHref("SALES_ORDER", salesOrderId),
      customerName: isIn ? r.prodCustomerName : r.doCustomerName,
      unitSerials: isIn ? undefined : (serialsByDo.get(r.refId ?? "") ?? []),
      batchId: r.batchId,
      notes: r.notes,
    };
  });

  const reconciliation = reconciliationOf("FG", movements);
  const stamped = withRunningBalance(movements, reconciliation);

  // --- COGS ---------------------------------------------------------------
  const cogs: CogsRow[] = stamped
    .filter((m) => m.direction === "OUT")
    .map((m) => {
      const serials = serialsByDo.get(m.docId ?? "") ?? [];
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
        // The ledger names the cost LAYER, not the piece — a FIFO slice is not
        // tied to a serial. The serials that left on that delivery are listed
        // so the trail is still followable; they are the delivery's pieces, not
        // a claim about which one this slice paid for.
        fromLotLabel:
          [m.batchId, serials.length ? `${serials.length} serial(s) on this DO` : null]
            .filter(Boolean)
            .join(" · ") || null,
      };
    });

  // --- header -------------------------------------------------------------
  const onHand = lots.filter((l) => l.qty > 0);
  const onHandPieces = onHand.length;
  const assignedPieces = onHand.filter((l) => l.claimedBySoNo).length;
  const ownedUnits = new Set(
    unitRows
      .filter((u) => !FG_GONE.has(u.status))
      .map((u) => `${u.poId ?? ""}#${u.unitNo ?? ""}`),
  ).size;

  const pricedPieces = onHand.filter((l) => l.unitCostSen !== null).length;
  const totalValueSen = onHand.reduce((s, l) => s + (l.valueSen ?? 0), 0);
  const { ageDays: oldestAgeDays, date: oldestLayerDate } = fifoAge(
    lots.map((l) => ({ date: l.mfdDate, qty: l.qty })),
  );

  return {
    header: {
      itemType: "FG",
      itemId: item.id,
      itemCode: item.code,
      itemName: item.name ?? "",
      uom: "pieces",
      totalQty: onHandPieces,
      assignedQty: assignedPieces,
      freeQty: onHandPieces - assignedPieces,
      qtyNote: piecesNote(onHandPieces, ownedUnits),
      totalValueSen,
      valuationNote: valuationNote(pricedPieces, onHandPieces),
      oldestAgeDays,
      oldestLayerDate,
      reconciliation,
      ledgerVsOnHand: ledgerVsOnHand(
        closingBalance(movements, reconciliation),
        onHandPieces,
        0,
        "The two legs of the finished-goods ledger do not count the same " +
          "thing: a completion books whole units while a delivery books one " +
          "row per FIFO slice, so their difference is a cost-layer figure and " +
          "never was a piece count.",
      ),
    },
    lots,
    movements: stamped,
    cogs,
  };
}

// ---------------------------------------------------------------------------
// WORK IN PROGRESS — the honest one.
//
// This panel exists to show what IS recorded and to say plainly what is not. It
// would have been easy to give WIP the same running balance as the other two;
// it would also have been wrong, and wrong in the way that is hardest to catch,
// because a number that adds up looks checked.
//
// THREE THINGS THE LEDGER CANNOT TELL YOU ABOUT A WIP ITEM, all surfaced:
//
//   1. NOTHING IS RECORDED WHEN WIP IS CONSUMED. A WIP piece is booked in when
//      a job card completes and nothing at all is written when the next
//      department eats it or it turns into a finished good. On prod: 32,837
//      inbound rows against 54 outbound, and all 54 of those are labour
//      reversals from cancelled job cards, not consumption. Sum them and the
//      figure only ever grows.
//
//   2. THE INBOUND ROWS ARE MINUTES, NOT PIECES. LABOR_POSTED books the job
//      card's minutes (its qty is 23, 40, 50 — minutes), while the grid above
//      counts pieces. Adding those two together produces a number in no unit at
//      all.
//
//   3. cost_ledger's WIP rows are keyed by PRODUCTION ORDER, not by WIP item.
//      Only the JOB_CARD-referenced rows can be narrowed to one WIP item at
//      all, via job_cards.wipLabel, and that is what this builder uses — a
//      naive per-production-order pull would drag in every other department's
//      labour on the same order (one WIP code on prod touches 696 production
//      orders and 9,176 ledger rows, of which 629 are actually its own).
//      WIP_COMPLETED rows reference the production order and cannot be
//      attributed to a WIP item, so they are excluded rather than smeared
//      across every WIP code on that order.
//
// So: the movements are real and narrowed correctly, the balance column is
// empty, and the panel carries the reason.
// ---------------------------------------------------------------------------
type WipJobCardRow = {
  id: string;
  departmentCode: string | null;
  departmentName: string | null;
  status: string | null;
  wipQty: number | null;
  completedDate: string | null;
  productionOrderId: string | null;
  poNo: string | null;
  prodSalesOrderId: string | null;
  prodSalesOrderNo: string | null;
  laborMinutes: number | null;
  laborPostedSen: number | null;
};

type WipLedgerRow = LedgerRow & {
  jcDepartmentCode: string | null;
  jcDepartmentName: string | null;
  jcProductionOrderId: string | null;
  workerName: string | null;
};

async function buildWipBreakdown(
  c: Context<Env>,
  orgId: string,
  itemId: string,
): Promise<StockBreakdown | null> {
  const db = c.var.DB;

  // The Inventory grid hands over a wip_items id; accept the code too, because
  // the WIP code is what the operator can actually read off the screen and it
  // is the key everything downstream joins on anyway.
  const item = await db
    .prepare(
      `SELECT id, code, type, relatedProduct, stockQty, status
         FROM wip_items
        WHERE (id = ? OR code = ?) AND orgId = ?
        ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
        LIMIT 1`,
    )
    .bind(itemId, itemId, orgId, itemId)
    .first<{
      id: string;
      code: string;
      type: string | null;
      relatedProduct: string | null;
      stockQty: number | null;
      status: string | null;
    }>();
  if (!item) return null;

  const [jcRes, ledgerRes] = await Promise.all([
    // The job cards that made this WIP item, oldest first, with the labour
    // booked on each. Aggregated in subqueries rather than joined so a job card
    // with twelve labour postings stays ONE row.
    db
      .prepare(
        `SELECT j.id, j.departmentCode, j.departmentName, j.status, j.wipQty,
                j.completedDate, j.productionOrderId,
                p.poNo           AS "poNo",
                p.salesOrderId   AS "prodSalesOrderId",
                p.salesOrderNo   AS "prodSalesOrderNo",
                (SELECT SUM(cl.qty) FROM cost_ledger cl
                  WHERE cl.itemType = 'WIP' AND cl.refType = 'JOB_CARD'
                    AND cl.refId = j.id AND cl.direction = 'IN')
                                 AS "laborMinutes",
                (SELECT SUM(cl.totalCostSen) FROM cost_ledger cl
                  WHERE cl.itemType = 'WIP' AND cl.refType = 'JOB_CARD'
                    AND cl.refId = j.id AND cl.direction = 'IN')
                                 AS "laborPostedSen"
           FROM job_cards j
           LEFT JOIN production_orders p ON p.id = j.productionOrderId
          WHERE j.wipLabel = ?
          ORDER BY j.completedDate ASC NULLS LAST, j.id ASC`,
      )
      .bind(item.code)
      .all<WipJobCardRow>(),
    // Only the rows that can honestly be attributed to THIS WIP item: those
    // referencing one of its job cards.
    db
      .prepare(
        `SELECT cl.id, cl.date, cl.type, cl.direction, cl.qty,
                cl.unitCostSen, cl.totalCostSen, cl.batchId,
                cl.refType, cl.refId, cl.notes, cl.workerId,
                j.departmentCode AS "jcDepartmentCode",
                j.departmentName AS "jcDepartmentName",
                j.productionOrderId AS "jcProductionOrderId",
                p.poNo           AS "prodOrderNo",
                p.salesOrderId   AS "prodSalesOrderId",
                p.salesOrderNo   AS "prodSalesOrderNo",
                p.customerName   AS "prodCustomerName",
                w.name           AS "workerName"
           FROM cost_ledger cl
           JOIN job_cards j ON j.id = cl.refId
           LEFT JOIN production_orders p ON p.id = j.productionOrderId
           LEFT JOIN workers w           ON w.id = cl.workerId
          WHERE cl.itemType = 'WIP'
            AND cl.refType  = 'JOB_CARD'
            AND j.wipLabel  = ?
          ORDER BY cl.date DESC, cl.id DESC`,
      )
      .bind(item.code)
      .all<WipLedgerRow>(),
  ]);

  const jcRows = jcRes.results ?? [];
  const ledgerRows = ledgerRes.results ?? [];

  // --- lots (one per job card) --------------------------------------------
  const lots: WipLot[] = jcRows.map((j) => ({
    kind: "WIP_LOT" as const,
    id: j.id,
    productionOrderNo: j.poNo,
    productionOrderHref: sourceDocHref("PRODUCTION_ORDER", j.productionOrderId, {
      salesOrderId: j.prodSalesOrderId,
    }),
    department: j.departmentName ?? j.departmentCode,
    // A job card has no number of its own — its id is a generated string
    // nobody reads. The department board it sits on is what an operator can
    // actually open, so that is the link.
    jobCardNo: j.departmentCode ?? null,
    jobCardHref: sourceDocHref("JOB_CARD", j.id, {
      departmentCode: j.departmentCode,
    }),
    salesOrderNo: j.prodSalesOrderNo,
    salesOrderHref: sourceDocHref("SALES_ORDER", j.prodSalesOrderId),
    qty: num(j.wipQty),
    status: j.status,
    laborMinutes: j.laborMinutes === null ? null : num(j.laborMinutes),
    laborPostedSen: j.laborPostedSen === null ? null : num(j.laborPostedSen),
    completedDate: j.completedDate,
    ageDays: ageDays(j.completedDate),
  }));

  // --- movements ----------------------------------------------------------
  const movements: StockMovement[] = ledgerRows.map((r) => ({
    id: r.id,
    date: r.date,
    direction: r.direction === "IN" ? "IN" : "OUT",
    type: r.type,
    qty: roundQty(num(r.qty)),
    unitCostSen: num(r.unitCostSen),
    totalCostSen: num(r.totalCostSen),
    // Stays null: withRunningBalance refuses WIP outright, and this makes the
    // intent legible at the point the row is built.
    balanceAfter: null,
    docType: "JOB_CARD",
    docId: r.refId,
    docNo: r.jcDepartmentCode ?? null,
    docHref: sourceDocHref("JOB_CARD", r.refId, {
      departmentCode: r.jcDepartmentCode,
    }),
    productionOrderNo: r.prodOrderNo,
    productionOrderHref: sourceDocHref(
      "PRODUCTION_ORDER",
      r.jcProductionOrderId,
      { salesOrderId: r.prodSalesOrderId },
    ),
    department: r.jcDepartmentName ?? r.jcDepartmentCode,
    takenByName: r.workerName,
    jobCardNo: r.jcDepartmentCode ?? null,
    jobCardHref: sourceDocHref("JOB_CARD", r.refId, {
      departmentCode: r.jcDepartmentCode,
    }),
    salesOrderNo: r.prodSalesOrderNo,
    salesOrderHref: sourceDocHref("SALES_ORDER", r.prodSalesOrderId),
    customerName: r.prodCustomerName,
    batchId: r.batchId,
    notes: r.notes,
  }));

  const reconciliation = reconciliationOf("WIP", movements);
  const stamped = withRunningBalance(movements, reconciliation);

  const onHandQty = num(item.stockQty);
  const laborPostedSen = lots.reduce((s, l) => s + (l.laborPostedSen ?? 0), 0);
  const { ageDays: oldestAgeDays, date: oldestLayerDate } = fifoAge(
    lots.map((l) => ({ date: l.completedDate, qty: l.qty })),
  );

  return {
    header: {
      itemType: "WIP",
      itemId: item.id,
      itemCode: item.code,
      itemName: item.relatedProduct ?? item.type ?? "",
      uom: "pieces",
      // The grid's own figure, from the same wip_items row the grid reads. It
      // is NOT derived from the movements below and must not be read as if it
      // were — see reconciliation.notice.
      totalQty: onHandQty,
      // Nothing reserves WIP against a customer document, so there is no split
      // to report. Null rather than "0 / N", which would assert that somebody
      // checked and found none committed.
      assignedQty: null,
      freeQty: null,
      qtyNote:
        `This figure comes from the WIP ledger table, not from the movements ` +
        `below. The two are not connected and cannot be checked against each ` +
        `other.`,
      // WIP has no FIFO cost layer at all — nothing in this system costs a WIP
      // piece. Reporting the labour total here as "Total value" would invent a
      // valuation, so the stat stays empty and the labour is shown for what it
      // is, per job card, in the table.
      totalValueSen: null,
      valuationNote:
        `Work in progress carries no cost layer, so there is no stock value to ` +
        `show. What IS recorded is labour: ` +
        `${(laborPostedSen / 100).toFixed(2)} MYR has been posted across the ` +
        `${lots.length} job card(s) that made this item — for every piece they ` +
        `produced, not only the ${onHandQty} still on the floor.`,
      oldestAgeDays,
      oldestLayerDate,
      reconciliation,
      // Deliberately not compared. `closingBalance` returns null for WIP, so
      // this reports "cannot say" rather than manufacturing a disagreement
      // between a piece count and a pile of labour minutes.
      ledgerVsOnHand: ledgerVsOnHand(
        closingBalance(movements, reconciliation),
        onHandQty,
        0,
      ),
    },
    lots,
    // COGS is empty BY CONSTRUCTION, not because this item happens to have
    // none: WIP consumption is never written, so there is nothing to list. The
    // panel says that in the empty state rather than showing a blank table that
    // reads as "nothing has been used".
    movements: stamped,
    cogs: [],
  };
}

export default app;
