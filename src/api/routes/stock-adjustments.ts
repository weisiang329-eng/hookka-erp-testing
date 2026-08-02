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
// For RM with a negative delta we WALK rm_batches in receivedDate ASC and
// decrement each layer's remainingQty until the requested qty is fully
// consumed — keeping balanceQty in lockstep with sum(remainingQty) and
// generating per-batch cost_ledger rows that carry each layer's true
// unitCostSen. Residual qty (when balanceQty has drifted above
// sum(remainingQty) on legacy data) falls back to the operator-provided
// unitCostSen and emits a "no batch" residual cost_ledger row.
//
// Per user 2026-04-28:
//   • No approver — adjustments take effect immediately. Audit trail
//     is the safety net.
//   • Reason is required (FOUND / DAMAGED / COUNT_CORRECTION /
//     WRITE_OFF / OTHER).
//   • Cost impact recorded — for write-offs the operator sees how much
//     stock value left the books.
//
// Cost basis: for RM IN the operator's submitted unitCostSen sets the new
// FIFO layer (frontend pre-fills from current weighted-avg). For RM OUT
// the operator's unitCostSen is ignored at the cost-ledger level — FIFO
// from rm_batches is authoritative. WIP/FG honor the operator value as
// before.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { emitAudit } from "../lib/audit";

const app = new Hono<Env>();

type AdjustmentType = "RM" | "WIP" | "FG";
type AdjustmentReason =
  | "FOUND"
  | "DAMAGED"
  | "COUNT_CORRECTION"
  | "WRITE_OFF"
  | "SERVICE_REPLACEMENT"
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
  // Service-case backlink (SERVICE_REPLACEMENT issues from the case detail
  // page). Runtime-added lowercase column (migration 0164) — read dual-key.
  caseId?: string | null;
  caseid?: string | null;
};

const VALID_TYPES: AdjustmentType[] = ["RM", "WIP", "FG"];
const VALID_REASONS: AdjustmentReason[] = [
  "FOUND",
  "DAMAGED",
  "COUNT_CORRECTION",
  "WRITE_OFF",
  "SERVICE_REPLACEMENT",
  "OTHER",
];

// Self-applying migration — 0164. caseid is the optional service_cases.id
// backlink for SERVICE_REPLACEMENT adjustments (the "Replacement Parts" card
// on the case detail page). Module-level promise = one ALTER per isolate.
let pendingColumns = false;
async function ensureStockAdjustmentColumns(db: D1Database): Promise<void> {
  if (pendingColumns) return;

  try {
    await db
      .prepare("ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS caseid TEXT")
      .run();
  } catch {
    // ignore — column may already exist or DDL transiently rejected
  }
  pendingColumns = true;
}

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
    caseId: r.caseId ?? r.caseid ?? "",
  };
}

// ---------------------------------------------------------------------------
// GET /api/stock-adjustments — list, optionally filtered by type / itemId /
// date range. Newest first.
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  await ensureStockAdjustmentColumns(c.var.DB);
  const type = c.req.query("type");
  const itemId = c.req.query("itemId");
  const caseId = c.req.query("caseId");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const orgId = getOrgId(c);
  const clauses: string[] = ["orgId = ?"];
  const params: string[] = [orgId];
  if (type) {
    clauses.push("type = ?");
    params.push(type);
  }
  if (itemId) {
    clauses.push("itemId = ?");
    params.push(itemId);
  }
  if (caseId) {
    clauses.push("caseid = ?");
    params.push(caseId);
  }
  if (from) {
    clauses.push("adjustedAt >= ?");
    params.push(from);
  }
  if (to) {
    clauses.push("adjustedAt <= ?");
    params.push(to);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
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
//   reason: 'FOUND'|'DAMAGED'|'COUNT_CORRECTION'|'WRITE_OFF'|'SERVICE_REPLACEMENT'|'OTHER',
//   notes?: string,
//   adjustedBy?: string,    // user id (frontend pulls from auth)
//   adjustedByName?: string,
//   caseId?: string,        // service_cases.id — SERVICE_REPLACEMENT backlink
// }
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  const denied = await requirePermission(c, "inventory", "create");
  if (denied) return denied;
  await ensureStockAdjustmentColumns(c.var.DB);
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
          error:
            "reason must be one of FOUND/DAMAGED/COUNT_CORRECTION/WRITE_OFF/SERVICE_REPLACEMENT/OTHER",
        },
        400,
      );
    }
    const caseId =
      typeof body.caseId === "string" && body.caseId.trim()
        ? body.caseId.trim()
        : null;

    // ---- look up the item to get itemCode + itemName + current qty ----
    let itemCode = "";
    let itemName: string | null = null;
    let currentQty = 0;

    if (type === "RM") {
      const row = await c.var.DB
        .prepare(
          // `description` — raw_materials has no item_name. Every RM stock
          // adjustment died here on a column that does not exist.
          `SELECT itemCode, description, balanceQty FROM raw_materials WHERE id = ?`,
        )
        .bind(itemId)
        .first<{ itemCode: string; description: string | null; balanceQty: number }>();
      if (!row) {
        return c.json({ success: false, error: "Raw material not found" }, 404);
      }
      itemCode = row.itemCode;
      itemName = row.description;
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
    const nowIso = new Date().toISOString();
    const today = nowIso.split("T")[0];

    // FIFO consumption plan for RM OUT — walk rm_batches in receivedDate
    // ASC, id ASC and decide how much to take from each layer. We do this
    // BEFORE composing statements so the cost_ledger / stock_adjustments
    // rows can use the FIFO-derived true cost instead of the operator's
    // claimed unitCostSen (which was a v1 simplification — pre-fill from
    // weighted-avg, accept whatever the user typed).
    type FifoConsumption = {
      batchId: string;
      qty: number;
      unitCostSen: number;
      totalCostSen: number;
    };
    const fifoPlan: FifoConsumption[] = [];
    if (type === "RM" && direction === "OUT") {
      const remaining = Math.abs(qtyDelta);
      const batchesRes = await c.var.DB
        .prepare(
          `SELECT id, remainingQty, unitCostSen
             FROM rm_batches
            WHERE rmId = ? AND remainingQty > 0
            ORDER BY receivedDate ASC, id ASC`,
        )
        .bind(itemId)
        .all<{ id: string; remainingQty: number; unitCostSen: number }>();
      const batches = batchesRes.results ?? [];
      let stillToConsume = remaining;
      for (const b of batches) {
        if (stillToConsume <= 0) break;
        const take = Math.min(b.remainingQty, stillToConsume);
        if (take <= 0) continue;
        const layerCost = Math.round(take * b.unitCostSen);
        fifoPlan.push({
          batchId: b.id,
          qty: take,
          unitCostSen: b.unitCostSen,
          totalCostSen: layerCost,
        });
        stillToConsume -= take;
      }
      // If we couldn't satisfy from FIFO (e.g. balanceQty drifted from
      // sum(remainingQty) on legacy adjustments), fall back to the
      // operator's claimed cost for the residual. That keeps the
      // adjustment runnable while making the FIFO drift visible in the
      // ledger as a residual-cost entry.
      if (stillToConsume > 0) {
        const residualCost = Math.round(stillToConsume * unitCostSen);
        fifoPlan.push({
          batchId: "",
          qty: stillToConsume,
          unitCostSen,
          totalCostSen: residualCost,
        });
      }
    }
    // Effective unitCost + total cost for the stock_adjustments row.
    // For RM OUT the FIFO plan is authoritative; everything else uses the
    // operator-supplied unitCostSen as before.
    const totalCostSen =
      type === "RM" && direction === "OUT"
        ? fifoPlan.reduce((s, l) => s + l.totalCostSen, 0)
        : Math.round(Math.abs(qtyDelta) * unitCostSen);
    const effectiveUnitCostSen =
      type === "RM" && direction === "OUT" && Math.abs(qtyDelta) > 0
        ? Math.round(totalCostSen / Math.abs(qtyDelta))
        : unitCostSen;

    const stmts: D1PreparedStatement[] = [];

    // 1. stock_adjustments — the canonical record. unitCostSen reflects the
    // FIFO-derived effective cost for RM OUT (vs the operator's claimed
    // pre-fill); totalCostSen is the true cost out of stock.
    stmts.push(
      c.var.DB.prepare(
        `INSERT INTO stock_adjustments (id, adjNo, type, itemId, itemCode, itemName,
           qtyDelta, unitCostSen, totalCostSen, direction, reason, notes,
           adjustedBy, adjustedByName, adjustedAt, caseid, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        adjNo,
        type,
        itemId,
        itemCode,
        itemName,
        qtyDelta,
        effectiveUnitCostSen,
        totalCostSen,
        direction,
        reason,
        (body.notes as string) ?? null,
        (body.adjustedBy as string) ?? null,
        (body.adjustedByName as string) ?? null,
        nowIso,
        caseId,
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

    // 3. cost_ledger — financial impact. For RM OUT we emit one row per
    // FIFO layer consumed so each entry carries the batchId + that layer's
    // true unitCostSen — auditors can reconstruct the consumption trail.
    // Other paths (RM IN, WIP, FG) keep the single-row behaviour.
    if (type === "RM" && direction === "OUT" && fifoPlan.length > 0) {
      for (let i = 0; i < fifoPlan.length; i++) {
        const layer = fifoPlan[i];
        stmts.push(
          c.var.DB.prepare(
            `INSERT INTO cost_ledger (id, date, type, itemType, itemId, batchId,
               qty, direction, unitCostSen, totalCostSen, refType, refId, notes)
             VALUES (?, ?, 'ADJUSTMENT', 'RM', ?, ?, ?, 'OUT', ?, ?, 'STOCK_ADJUSTMENT', ?, ?)`,
          ).bind(
            `cl-${id}-${i}`,
            today,
            itemId,
            layer.batchId || null,
            layer.qty,
            layer.unitCostSen,
            layer.totalCostSen,
            id,
            `${reason} (FIFO layer ${i + 1}/${fifoPlan.length}${
              layer.batchId ? "" : " — residual, no batch"
            })${body.notes ? ": " + body.notes : ""}`,
          ),
        );
      }
    } else {
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
    }

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
      // RM with negative delta — consume the FIFO layers we computed up
      // front. Each plan entry knows exactly how much to take from a
      // specific batch; we DECREMENT remainingQty so sum(rm_batches.
      // remainingQty) stays in lockstep with raw_materials.balanceQty.
      // Residual entries (batchId="") leave a cost_ledger trail but no
      // rm_batches mutation — those are the "balanceQty drift" cases.
      if (direction === "OUT") {
        for (const layer of fifoPlan) {
          if (!layer.batchId) continue;
          stmts.push(
            c.var.DB.prepare(
              `UPDATE rm_batches SET remainingQty = remainingQty - ? WHERE id = ?`,
            ).bind(layer.qty, layer.batchId),
          );
        }
      }
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
    // The module header says "No approver — adjustments take effect
    // immediately. Audit trail is the safety net." That safety net did not
    // exist: this endpoint rewrites raw_materials.balanceQty / wip_items.stockQty
    // / fg_batches.remainingQty and writes cost_ledger value off the books with
    // no audit_events row. `before` is the on-hand quantity as read for the
    // below-zero guard, so a disputed count correction or write-off can be
    // traced to who made it.
    await emitAudit(c, {
      resource: "stock-adjustments",
      resourceId: id,
      action: "create",
      before: { type, itemId, itemCode, itemName, qty: currentQty },
      after: rowToApi(created),
    });
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
