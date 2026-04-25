// ---------------------------------------------------------------------------
// D1-backed cost-ledger route.
//
// Mirrors src/api/routes/cost-ledger.ts — read-only views over cost_ledger,
// rm_batches, and fg_batches tables. All writes happen side-effectually in
// the triggering business routes (GRN, production_orders, delivery_orders)
// so the ledger stays append-only.
//
// Endpoints
//   GET /api/cost-ledger                → all entries (+ filters)
//   GET /api/cost-ledger/rm-batches     → RMBatch layers (+ rmId filter)
//   GET /api/cost-ledger/fg-batches     → FGBatch layers (+ productId / productionOrderId filter)
//   GET /api/cost-ledger/summary        → dashboard rollup (on-hand values, COGS)
//
// Schema-note: D1 stores `rm_batches.createdAt` / `fg_batches.createdAt`
// (snake_case); the in-memory type exposes `createdAt` (camelCase). The
// row->API mappers handle the rename.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { laborRateForDate } from "../../lib/costing";

const app = new Hono<Env>();

type CostLedgerRow = {
  id: string;
  date: string;
  type: string;
  itemType: string;
  itemId: string;
  batchId: string | null;
  qty: number;
  direction: string;
  unitCostSen: number;
  totalCostSen: number;
  refType: string | null;
  refId: string | null;
  notes: string | null;
};

type RMBatchRow = {
  id: string;
  rmId: string;
  source: string;
  sourceRefId: string | null;
  receivedDate: string;
  originalQty: number;
  remainingQty: number;
  unitCostSen: number;
  createdAt: string | null;
  notes: string | null;
};

type FGBatchRow = {
  id: string;
  productId: string;
  productionOrderId: string | null;
  completedDate: string;
  originalQty: number;
  remainingQty: number;
  unitCostSen: number;
  materialCostSen: number;
  laborCostSen: number;
  overheadCostSen: number;
  createdAt: string | null;
};

function rowToLedgerEntry(r: CostLedgerRow) {
  return {
    id: r.id,
    date: r.date,
    type: r.type,
    itemType: r.itemType,
    itemId: r.itemId,
    batchId: r.batchId ?? undefined,
    qty: r.qty,
    direction: r.direction,
    unitCostSen: r.unitCostSen,
    totalCostSen: r.totalCostSen,
    refType: r.refType ?? undefined,
    refId: r.refId ?? undefined,
    notes: r.notes ?? undefined,
  };
}

function rowToRMBatch(r: RMBatchRow) {
  return {
    id: r.id,
    rmId: r.rmId,
    source: r.source,
    sourceRefId: r.sourceRefId ?? undefined,
    receivedDate: r.receivedDate,
    originalQty: r.originalQty,
    remainingQty: r.remainingQty,
    unitCostSen: r.unitCostSen,
    createdAt: r.createdAt ?? "",
    notes: r.notes ?? undefined,
  };
}

function rowToFGBatch(r: FGBatchRow) {
  return {
    id: r.id,
    productId: r.productId,
    productionOrderId: r.productionOrderId ?? "",
    completedDate: r.completedDate,
    originalQty: r.originalQty,
    remainingQty: r.remainingQty,
    unitCostSen: r.unitCostSen,
    materialCostSen: r.materialCostSen,
    laborCostSen: r.laborCostSen,
    overheadCostSen: r.overheadCostSen,
    createdAt: r.createdAt ?? "",
  };
}

// GET /api/cost-ledger — list entries with optional filters
app.get("/", async (c) => {
  const itemType = c.req.query("itemType");
  const itemId = c.req.query("itemId");
  const refType = c.req.query("refType");
  const refId = c.req.query("refId");
  const type = c.req.query("type");

  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (itemType) {
    clauses.push("itemType = ?");
    binds.push(itemType);
  }
  if (itemId) {
    clauses.push("itemId = ?");
    binds.push(itemId);
  }
  if (refType) {
    clauses.push("refType = ?");
    binds.push(refType);
  }
  if (refId) {
    clauses.push("refId = ?");
    binds.push(refId);
  }
  if (type) {
    clauses.push("type = ?");
    binds.push(type);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT * FROM cost_ledger ${where} ORDER BY date ASC, id ASC`;

  const res = await c.var.DB.prepare(sql)
    .bind(...binds)
    .all<CostLedgerRow>();
  const rows = (res.results ?? []).map(rowToLedgerEntry);
  return c.json({ success: true, data: rows, total: rows.length });
});

// GET /api/cost-ledger/rm-batches — RM batch layers with on-hand value
app.get("/rm-batches", async (c) => {
  const rmId = c.req.query("rmId");
  const sql = rmId
    ? "SELECT * FROM rm_batches WHERE rmId = ? ORDER BY receivedDate ASC, id ASC"
    : "SELECT * FROM rm_batches ORDER BY receivedDate ASC, id ASC";
  const res = rmId
    ? await c.var.DB.prepare(sql).bind(rmId).all<RMBatchRow>()
    : await c.var.DB.prepare(sql).all<RMBatchRow>();
  const rawRows = res.results ?? [];
  const rows = rawRows.map(rowToRMBatch);
  const totalValueSen = rawRows.reduce(
    (s, b) => s + Math.max(0, b.remainingQty) * b.unitCostSen,
    0,
  );
  return c.json({
    success: true,
    data: rows,
    total: rows.length,
    totalValueSen,
  });
});

// GET /api/cost-ledger/fg-batches — FG batch layers with on-hand value
app.get("/fg-batches", async (c) => {
  const productId = c.req.query("productId");
  const productionOrderId = c.req.query("productionOrderId");
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (productId) {
    clauses.push("productId = ?");
    binds.push(productId);
  }
  if (productionOrderId) {
    clauses.push("productionOrderId = ?");
    binds.push(productionOrderId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const sql = `SELECT * FROM fg_batches ${where} ORDER BY completedDate ASC, id ASC`;

  const res = await c.var.DB.prepare(sql)
    .bind(...binds)
    .all<FGBatchRow>();
  const rawRows = res.results ?? [];
  const rows = rawRows.map(rowToFGBatch);
  const onHandValueSen = rawRows.reduce(
    (s, b) => s + Math.max(0, b.remainingQty) * b.unitCostSen,
    0,
  );
  return c.json({
    success: true,
    data: rows,
    total: rows.length,
    onHandValueSen,
  });
});

// GET /api/cost-ledger/summary — dashboard rollup
app.get("/summary", async (c) => {
  const [rmRes, fgRes, ledgerRes] = await Promise.all([
    c.var.DB.prepare(
      "SELECT remainingQty, unitCostSen FROM rm_batches",
    ).all<{ remainingQty: number; unitCostSen: number }>(),
    c.var.DB.prepare(
      "SELECT remainingQty, unitCostSen FROM fg_batches",
    ).all<{ remainingQty: number; unitCostSen: number }>(),
    c.var.DB.prepare(
      "SELECT date, type, totalCostSen FROM cost_ledger",
    ).all<{ date: string; type: string; totalCostSen: number }>(),
  ]);

  const rmOnHandSen = (rmRes.results ?? []).reduce(
    (s, b) => s + Math.max(0, b.remainingQty) * b.unitCostSen,
    0,
  );
  const fgOnHandSen = (fgRes.results ?? []).reduce(
    (s, b) => s + Math.max(0, b.remainingQty) * b.unitCostSen,
    0,
  );

  const now = new Date();
  const entries = ledgerRes.results ?? [];
  const inMonth = (iso: string) => {
    const d = new Date(iso);
    return (
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth()
    );
  };
  const cogsThisMonthSen = entries
    .filter((e) => e.type === "FG_DELIVERED" && inMonth(e.date))
    .reduce((s, e) => s + e.totalCostSen, 0);
  const laborPostedThisMonthSen = entries
    .filter((e) => e.type === "LABOR_POSTED" && inMonth(e.date))
    .reduce((s, e) => s + e.totalCostSen, 0);

  return c.json({
    success: true,
    data: {
      asOf: now.toISOString(),
      laborRatePerMinuteSen: laborRateForDate(now),
      rmOnHandSen,
      fgOnHandSen,
      totalLedgerEntries: entries.length,
      cogsThisMonthSen,
      laborPostedThisMonthSen,
    },
  });
});

export default app;
