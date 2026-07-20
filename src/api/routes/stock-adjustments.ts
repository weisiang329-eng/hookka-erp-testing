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
import { readIdempotencyKey, withIdempotency } from "../lib/idempotency";
import { issueStockAdjustmentNumber } from "../lib/stock-adjustment-number";
import {
  createStockAdjustmentSchema,
  type CreateStockAdjustmentInput,
} from "../../lib/schemas/stock-adjustment";

const app = new Hono<Env>();

type AdjustmentType = CreateStockAdjustmentInput["type"];
type AdjustmentReason = CreateStockAdjustmentInput["reason"];

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

// Self-applying migration — 0164. caseid is the optional service_cases.id
// backlink for SERVICE_REPLACEMENT adjustments (the "Replacement Parts" card
// on the case detail page). Module-level promise = one ALTER per isolate.
let pendingColumns: Promise<void> | null = null;
function ensureStockAdjustmentColumns(db: D1Database): Promise<void> {
  if (pendingColumns) return pendingColumns;
  pendingColumns = (async () => {
    try {
      await db
        .prepare("ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS caseid TEXT")
        .run();
    } catch {
      // ignore — column may already exist or DDL transiently rejected
    }
  })();
  return pendingColumns;
}

function genId(): string {
  return `adj-${crypto.randomUUID().slice(0, 8)}`;
}

// ADJ-YYMM-NNN sequential, human-readable adjustment number. Added
// 2026-04-28 — older rows have NULL adjNo until backfilled.
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
//   caseId?: string,        // service_cases.id — SERVICE_REPLACEMENT backlink
// }
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  const denied = await requirePermission(c, "inventory", "create");
  if (denied) return denied;
  await ensureStockAdjustmentColumns(c.var.DB);

  const idemKey = readIdempotencyKey(c);
  if (!idemKey) {
    return c.json(
      { success: false, error: "A valid Idempotency-Key header is required" },
      400,
    );
  }

  return withIdempotency(c, "stock-adjustments", idemKey, async () => {
    try {
      let json: unknown;
      try {
        json = await c.req.json();
      } catch {
        return c.json({ success: false, error: "Invalid JSON body" }, 400);
      }
      const parsed = createStockAdjustmentSchema.safeParse(json);
      if (!parsed.success) {
        return c.json(
          {
            success: false,
            error: parsed.error.issues[0]?.message ?? "Invalid request body",
          },
          400,
        );
      }
      const body = parsed.data;
      const { type, itemId, qtyDelta, unitCostSen, reason } = body;
      const caseId = body.caseId ?? null;
      const notes = body.notes ?? null;
      const orgId = getOrgId(c);
      const userId = (
        c as unknown as { get: (key: string) => string | undefined }
      ).get("userId") ?? null;
      const actor = userId
        ? await c.var.DB
            .prepare("SELECT displayName, email FROM users WHERE id = ?")
            .bind(userId)
            .first<{ displayName: string | null; email: string | null }>()
        : null;
      const actorName = actor?.displayName || actor?.email || userId;

      if (caseId) {
        const serviceCase = await c.var.DB
          .prepare("SELECT id FROM service_cases WHERE id = ? AND orgId = ?")
          .bind(caseId, orgId)
          .first<{ id: string }>();
        if (!serviceCase) {
          return c.json({ success: false, error: "Service case not found" }, 404);
        }
      }

    // ---- look up the item to get itemCode + itemName + current qty ----
    let itemCode = "";
    let itemName: string | null = null;
    let currentQty = 0;

    if (type === "RM") {
      const row = await c.var.DB
        .prepare(
          `SELECT itemCode, itemName, balanceQty
             FROM raw_materials WHERE id = ? AND orgId = ?`,
        )
        .bind(itemId, orgId)
        .first<{ itemCode: string; itemName: string | null; balanceQty: number }>();
      if (!row) {
        return c.json({ success: false, error: "Raw material not found" }, 404);
      }
      itemCode = row.itemCode;
      itemName = row.itemName;
      currentQty = row.balanceQty;
    } else if (type === "WIP") {
      const row = await c.var.DB
        .prepare(`SELECT code, type, stockQty FROM wip_items WHERE id = ? AND orgId = ?`)
        .bind(itemId, orgId)
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
          `SELECT id, productId, remainingQty
             FROM fg_batches WHERE id = ? AND orgId = ?`,
        )
        .bind(itemId, orgId)
        .first<{ id: string; productId: string; remainingQty: number }>();
      if (!row) {
        return c.json({ success: false, error: "FG batch not found" }, 404);
      }
      const prod = await c.var.DB
        .prepare(`SELECT code, name FROM products WHERE id = ? AND orgId = ?`)
        .bind(row.productId, orgId)
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
    const adjNo = await issueStockAdjustmentNumber(c.var.DB, orgId);
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
            WHERE rmId = ? AND orgId = ? AND remainingQty > 0
            ORDER BY receivedDate ASC, id ASC`,
        )
        .bind(itemId, orgId)
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
        `INSERT INTO stock_adjustments (id, orgId, adjNo, type, itemId, itemCode, itemName,
           qtyDelta, unitCostSen, totalCostSen, direction, reason, notes,
           adjustedBy, adjustedByName, adjustedAt, caseid, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        orgId,
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
        notes,
        userId,
        actorName,
        nowIso,
        caseId,
        nowIso,
      ),
    );

    // 2. stock_movements — audit ledger ("what physically moved")
    const movementType = direction === "IN" ? "STOCK_IN" : "STOCK_OUT";
    stmts.push(
      c.var.DB.prepare(
        `INSERT INTO stock_movements (id, orgId, type, productCode, productName,
           quantity, reason, performedBy, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `mv-${id}`,
        orgId,
        movementType,
        itemCode,
        itemName,
        Math.abs(qtyDelta),
        `${reason}: stock adjustment ${id}${body.notes ? " — " + body.notes : ""}`,
        actorName,
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
            `INSERT INTO cost_ledger (id, orgId, date, type, itemType, itemId, batchId,
               qty, direction, unitCostSen, totalCostSen, refType, refId, notes)
             VALUES (?, ?, ?, 'ADJUSTMENT', 'RM', ?, ?, ?, 'OUT', ?, ?, 'STOCK_ADJUSTMENT', ?, ?)`,
          ).bind(
            `cl-${id}-${i}`,
            orgId,
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
          `INSERT INTO cost_ledger (id, orgId, date, type, itemType, itemId, batchId,
             qty, direction, unitCostSen, totalCostSen, refType, refId, notes)
           VALUES (?, ?, ?, 'ADJUSTMENT', ?, ?, ?, ?, ?, ?, ?, 'STOCK_ADJUSTMENT', ?, ?)`,
        ).bind(
          `cl-${id}`,
          orgId,
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
          `UPDATE raw_materials SET balanceQty = balanceQty + ?
            WHERE id = ? AND orgId = ?`,
        ).bind(qtyDelta, itemId, orgId),
      );
      // Positive delta on RM = new FIFO cost layer.
      if (direction === "IN") {
        stmts.push(
          c.var.DB.prepare(
            `INSERT INTO rm_batches (id, orgId, rmId, source, sourceRefId, receivedDate,
               originalQty, remainingQty, unitCostSen, created_at, notes)
             VALUES (?, ?, ?, 'ADJUSTMENT', ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            `batch-${id}`,
            orgId,
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
              `UPDATE rm_batches SET remainingQty = remainingQty - ?
                WHERE id = ? AND orgId = ?`,
            ).bind(layer.qty, layer.batchId, orgId),
          );
        }
      }
    } else if (type === "WIP") {
      stmts.push(
        c.var.DB.prepare(
          `UPDATE wip_items SET stockQty = stockQty + ?
            WHERE id = ? AND orgId = ?`,
        ).bind(qtyDelta, itemId, orgId),
      );
    } else {
      // FG: adjust the batch's remaining qty
      stmts.push(
        c.var.DB.prepare(
          `UPDATE fg_batches SET remainingQty = remainingQty + ?
            WHERE id = ? AND orgId = ?`,
        ).bind(qtyDelta, itemId, orgId),
      );
    }

    await c.var.DB.batch(stmts);

    const created = await c.var.DB
      .prepare(`SELECT * FROM stock_adjustments WHERE id = ? AND orgId = ?`)
      .bind(id, orgId)
      .first<StockAdjustmentRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to reload after insert" },
        500,
      );
    }
    return c.json({ success: true, data: rowToApi(created) }, 201);
    } catch (err) {
      console.error("[stock-adjustments] atomic write failed", err);
      const message = err instanceof Error ? err.message : "";
      const isStockConstraint =
        /nonnegative|check constraint|remaining_qty|balance_qty|stock_qty/i.test(message);
      return c.json(
        {
          success: false,
          error: isStockConstraint
            ? "Stock changed while this adjustment was posting. Refresh and retry with the current quantity."
            : "Could not post the stock adjustment. Nothing was written.",
        },
        isStockConstraint ? 409 : 500,
      );
    }
  });
});

export default app;
