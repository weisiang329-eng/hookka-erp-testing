// ---------------------------------------------------------------------------
// Stock Adjustments — manual inventory corrections for RM / WIP / FG.
//
// Each adjustment is a 4-row atomic write:
//   1. stock_adjustments         — the adjustment record (who / when / why)
//   2. stock_movements           — audit-ledger entry (physical movement)
//   3. cost_ledger               — financial impact (qty × unitCost, signed)
//   4. UPDATE the parent item    — raw_materials.balanceQty,
//                                  wip_items.stockQty, OR
//                                  fg_batches.remainingQty
//
// Plus, for RM with a positive delta we ALSO insert an rm_batches row so
// the FIFO cost layer has the correct on-hand cost basis going forward.
//
// Per user 2026-04-28:
//   • No approver — adjustments take effect immediately. Audit trail
//     is the safety net.
//   • Reason is required (FOUND / DAMAGED / COUNT_CORRECTION /
//     WRITE_OFF / OTHER).
//   • Cost impact recorded — for write-offs the operator sees how much
//     stock value left the books.
//
// v1 simplification: operator provides unitCostSen on the request. The
// frontend prefills from the item's current weighted-average cost. v2
// can compute server-side from rm_batches FIFO / fg_batches.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

type AdjustmentType = "RM" | "WIP" | "FG";
type AdjustmentReason =
  | "FOUND"
  | "DAMAGED"
  | "COUNT_CORRECTION"
  | "WRITE_OFF"
  | "OTHER";

type StockAdjustmentRow = {
  id: string;
  adjNo: string | null;
  type: AdjustmentType;
  itemId: string;
  itemCode: string;
  itemName: string | null;
  qtyDelta: number;
  unitCostSen: number;
  totalCostSen: number;
  direction: "IN" | "OUT";
  reason: AdjustmentReason;
  notes: string | null;
  adjustedBy: string | null;
  adjustedByName: string | null;
  adjustedAt: string;
};

const VALID_TYPES: AdjustmentType[] = ["RM", "WIP", "FG"];
const VALID_REASONS: AdjustmentReason[] = [
  "FOUND",
  "DAMAGED",
  "COUNT_CORRECTION",
  "WRITE_OFF",
  "OTHER",
];

function genId(): string {
  return `adj-${crypto.randomUUID().slice(0, 8)}`;
}

// ADJ-YYMM-NNN sequential, human-readable adjustment number. Added
// 2026-04-28 — older rows have NULL adjNo until backfilled.
async function nextAdjNo(db: D1Database): Promise<string> {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(
    now.getMonth() + 1,
  ).padStart(2, "0")}`;
  const prefix = `ADJ-${yymm}-`;
  const res = await db
    .prepare(
      "SELECT adjNo FROM stock_adjustments WHERE adjNo LIKE ? ORDER BY adjNo DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ adjNo: string }>();
  if (!res) return `${prefix}001`;
  const tail = res.adjNo.replace(prefix, "");
  const seq = parseInt(tail, 10);
  if (!Number.isFinite(seq)) return `${prefix}001`;
  return `${prefix}${String(seq + 1).padStart(3, "0")}`;
}

function rowToApi(r: StockAdjustmentRow) {
  return {
    id: r.id,
    adjNo: r.adjNo ?? "",
    type: r.type,
    itemId: r.itemId,
    itemCode: r.itemCode,
    itemName: r.itemName ?? "",
    qtyDelta: r.qtyDelta,
    unitCostSen: r.unitCostSen,
    totalCostSen: r.totalCostSen,
    direction: r.direction,
    reason: r.reason,
    notes: r.notes ?? "",
    adjustedBy: r.adjustedBy ?? "",
    adjustedByName: r.adjustedByName ?? "",
    adjustedAt: r.adjustedAt,
  };
}

// ---------------------------------------------------------------------------
// GET /api/stock-adjustments — list, optionally filtered by type / itemId /
// date range. Newest first.
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const type = c.req.query("type");
  const itemId = c.req.query("itemId");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const clauses: string[] = [];
  const params: string[] = [];
  if (type) {
    clauses.push("type = ?");
    params.push(type);
  }
  if (itemId) {
    clauses.push("itemId = ?");
    params.push(itemId);
  }
  if (from) {
    clauses.push("adjustedAt >= ?");
    params.push(from);
  }
  if (to) {
    clauses.push("adjustedAt <= ?");
    params.push(to);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const res = await c.var.DB
    .prepare(
      `SELECT * FROM stock_adjustments ${where} ORDER BY adjustedAt DESC LIMIT 500`,
    )
    .bind(...params)
    .all<StockAdjustmentRow>();
  const data = (res.results ?? []).map(rowToApi);
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// POST /api/stock-adjustments — create one adjustment, atomically post the
// inventory + cost-ledger + audit entries.
//
// Body: {
//   type: 'RM'|'WIP'|'FG',
//   itemId: string,         // raw_materials.id | wip_items.id | fg_batches.id
//   qtyDelta: number,       // signed; positive = add, negative = subtract
//   unitCostSen: number,    // per-unit cost at adjustment time (from UI prefill)
//   reason: 'FOUND'|'DAMAGED'|'COUNT_CORRECTION'|'WRITE_OFF'|'OTHER',
//   notes?: string,
//   adjustedBy?: string,    // user id (frontend pulls from auth)
//   adjustedByName?: string,
// }
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const type = body.type as AdjustmentType;
    const itemId = body.itemId as string;
    const qtyDelta = Number(body.qtyDelta);
    const unitCostSen = Number(body.unitCostSen) || 0;
    const reason = body.reason as AdjustmentReason;

    // ---- validate ----
    if (!type || !VALID_TYPES.includes(type)) {
      return c.json(
        { success: false, error: "type must be RM, WIP, or FG" },
        400,
      );
    }
    if (!itemId) {
      return c.json({ success: false, error: "itemId is required" }, 400);
    }
    if (!Number.isFinite(qtyDelta) || qtyDelta === 0) {
      return c.json(
        { success: false, error: "qtyDelta must be non-zero" },
        400,
      );
    }
    if (!reason || !VALID_REASONS.includes(reason)) {
      return c.json(
        {
          success: false,
          error: "reason must be one of FOUND/DAMAGED/COUNT_CORRECTION/WRITE_OFF/OTHER",
        },
        400,
      );
    }

    // ---- look up the item to get itemCode + itemName + current qty ----
    let itemCode = "";
    let itemName: string | null = null;
    let currentQty = 0;

    if (type === "RM") {
      const row = await c.var.DB
        .prepare(
          `SELECT itemCode, itemName, balanceQty FROM raw_materials WHERE id = ?`,
        )
        .bind(itemId)
        .first<{ itemCode: string; itemName: string | null; balanceQty: number }>();
      if (!row) {
        return c.json({ success: false, error: "Raw material not found" }, 404);
      }
      itemCode = row.itemCode;
      itemName = row.itemName;
      currentQty = row.balanceQty;
    } else if (type === "WIP") {
      const row = await c.var.DB
        .prepare(`SELECT code, type, stockQty FROM wip_items WHERE id = ?`)
        .bind(itemId)
        .first<{ code: string; type: string; stockQty: number }>();
      if (!row) {
        return c.json({ success: false, error: "WIP item not found" }, 404);
      }
      itemCode = row.code;
      itemName = row.type;
      currentQty = row.stockQty;
    } else {
      // FG: itemId points at fg_batches.id
      const row = await c.var.DB
        .prepare(
          `SELECT id, productId, remainingQty FROM fg_batches WHERE id = ?`,
        )
        .bind(itemId)
        .first<{ id: string; productId: string; remainingQty: number }>();
      if (!row) {
        return c.json({ success: false, error: "FG batch not found" }, 404);
      }
      const prod = await c.var.DB
        .prepare(`SELECT code, name FROM products WHERE id = ?`)
        .bind(row.productId)
        .first<{ code: string; name: string }>();
      itemCode = prod?.code ?? row.productId;
      itemName = prod?.name ?? null;
      currentQty = row.remainingQty;
    }

    // ---- guard against negative-going-below-zero adjustments ----
    if (qtyDelta < 0 && currentQty + qtyDelta < 0) {
      return c.json(
        {
          success: false,
          error: `Cannot subtract ${Math.abs(qtyDelta)} — only ${currentQty} currently on hand for ${itemCode}.`,
        },
        409,
      );
    }

    // ---- compose all writes ----
    const id = genId();
    const adjNo = await nextAdjNo(c.var.DB);
    const direction: "IN" | "OUT" = qtyDelta > 0 ? "IN" : "OUT";
    const totalCostSen = Math.round(Math.abs(qtyDelta) * unitCostSen);
    const nowIso = new Date().toISOString();
    const today = nowIso.split("T")[0];

    const stmts: D1PreparedStatement[] = [];

    // 1. stock_adjustments — the canonical record
    stmts.push(
      c.var.DB.prepare(
        `INSERT INTO stock_adjustments (id, adjNo, type, itemId, itemCode, itemName,
           qtyDelta, unitCostSen, totalCostSen, direction, reason, notes,
           adjustedBy, adjustedByName, adjustedAt, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        adjNo,
        type,
        itemId,
        itemCode,
        itemName,
        qtyDelta,
        unitCostSen,
        totalCostSen,
        direction,
        reason,
        (body.notes as string) ?? null,
        (body.adjustedBy as string) ?? null,
        (body.adjustedByName as string) ?? null,
        nowIso,
        nowIso,
      ),
    );

    // 2. stock_movements — audit ledger ("what physically moved")
    const movementType = direction === "IN" ? "STOCK_IN" : "STOCK_OUT";
    stmts.push(
      c.var.DB.prepare(
        `INSERT INTO stock_movements (id, type, productCode, productName,
           quantity, reason, performedBy, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `mv-${id}`,
        movementType,
        itemCode,
        itemName,
        Math.abs(qtyDelta),
        `${reason}: stock adjustment ${id}${body.notes ? " — " + body.notes : ""}`,
        (body.adjustedByName as string) ?? null,
        nowIso,
      ),
    );

    // 3. cost_ledger — financial impact
    stmts.push(
      c.var.DB.prepare(
        `INSERT INTO cost_ledger (id, date, type, itemType, itemId, batchId,
           qty, direction, unitCostSen, totalCostSen, refType, refId, notes)
         VALUES (?, ?, 'ADJUSTMENT', ?, ?, ?, ?, ?, ?, ?, 'STOCK_ADJUSTMENT', ?, ?)`,
      ).bind(
        `cl-${id}`,
        today,
        type,
        itemId,
        null,
        Math.abs(qtyDelta),
        direction,
        unitCostSen,
        totalCostSen,
        id,
        `${reason}${body.notes ? ": " + body.notes : ""}`,
      ),
    );

    // 4. UPDATE the parent item's qty + (for RM IN) create FIFO batch
    if (type === "RM") {
      stmts.push(
        c.var.DB.prepare(
          `UPDATE raw_materials SET balanceQty = balanceQty + ? WHERE id = ?`,
        ).bind(qtyDelta, itemId),
      );
      // Positive delta on RM = new FIFO cost layer.
      if (direction === "IN") {
        stmts.push(
          c.var.DB.prepare(
            `INSERT INTO rm_batches (id, rmId, source, sourceRefId, receivedDate,
               originalQty, remainingQty, unitCostSen, created_at, notes)
             VALUES (?, ?, 'ADJUSTMENT', ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            `batch-${id}`,
            itemId,
            id,
            today,
            qtyDelta,
            qtyDelta,
            unitCostSen,
            nowIso,
            `Stock adjustment (${reason})`,
          ),
        );
      }
      // NOTE: For RM with negative delta we update balanceQty above but do
      // NOT consume specific rm_batches FIFO layers here — that's a
      // simplification for v1. v2 can walk the batches in receivedDate order.
    } else if (type === "WIP") {
      stmts.push(
        c.var.DB.prepare(
          `UPDATE wip_items SET stockQty = stockQty + ? WHERE id = ?`,
        ).bind(qtyDelta, itemId),
      );
    } else {
      // FG: adjust the batch's remaining qty
      stmts.push(
        c.var.DB.prepare(
          `UPDATE fg_batches SET remainingQty = remainingQty + ? WHERE id = ?`,
        ).bind(qtyDelta, itemId),
      );
    }

    await c.var.DB.batch(stmts);

    const created = await c.var.DB
      .prepare(`SELECT * FROM stock_adjustments WHERE id = ?`)
      .bind(id)
      .first<StockAdjustmentRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to reload after insert" },
        500,
      );
    }
    return c.json({ success: true, data: rowToApi(created) }, 201);
  } catch (err) {
    return c.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Invalid request body",
      },
      400,
    );
  }
});

export default app;
