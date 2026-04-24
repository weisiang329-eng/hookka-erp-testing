// ---------------------------------------------------------------------------
// D1-backed RM FIFO batch reader.
//
// GET /api/rm-batches            -> list all batches (optional ?rmId=)
// GET /api/rm-batches/:id        -> single batch
//
// Writes happen exclusively through the GRN cascade (see routes-d1/grn.ts),
// which INSERTs both the batch row and the cost-ledger RM_RECEIPT entry in
// one atomic batch.  Exposing a POST here would let the UI create orphaned
// batches with no matching ledger → we intentionally don't.
//
// Schema extension: 0008_raw_materials.sql added supplierId / grnId /
// totalValueSen columns.  Legacy rows from the 0001 base table expose NULL
// in those columns; we normalise to empty/0 in rowToApi.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";

const app = new Hono<Env>();

type RmBatchRow = {
  id: string;
  rmId: string;
  source: string;
  sourceRefId: string | null;
  receivedDate: string;
  originalQty: number;
  remainingQty: number;
  unitCostSen: number;
  created_at: string | null;
  notes: string | null;
  supplierId: string | null;
  grnId: string | null;
  totalValueSen: number;
};

function rowToApi(r: RmBatchRow) {
  // Fallback totalValueSen for rows created before the column existed.
  const computed = r.totalValueSen || Math.round(r.remainingQty * r.unitCostSen);
  return {
    id: r.id,
    rmId: r.rmId,
    source: r.source,
    sourceRefId: r.sourceRefId ?? "",
    receivedDate: r.receivedDate,
    originalQty: r.originalQty,
    remainingQty: r.remainingQty,
    unitCostSen: r.unitCostSen,
    totalValueSen: computed,
    supplierId: r.supplierId ?? "",
    // Prefer explicit grnId column; fall back to sourceRefId when source=GRN.
    grnId: r.grnId ?? (r.source === "GRN" ? r.sourceRefId ?? "" : ""),
    notes: r.notes ?? "",
    created_at: r.created_at ?? "",
  };
}

// GET /api/rm-batches  (optional ?rmId=)
app.get("/", async (c) => {
  const rmId = c.req.query("rmId");
  const sql = rmId
    ? "SELECT * FROM rm_batches WHERE rmId = ? ORDER BY receivedDate DESC"
    : "SELECT * FROM rm_batches ORDER BY receivedDate DESC";
  const stmt = rmId
    ? c.var.DB.prepare(sql).bind(rmId)
    : c.var.DB.prepare(sql);
  const res = await stmt.all<RmBatchRow>();
  const data = (res.results ?? []).map(rowToApi);
  return c.json({ success: true, data, total: data.length });
});

// GET /api/rm-batches/:id
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.var.DB.prepare(
    "SELECT * FROM rm_batches WHERE id = ?",
  )
    .bind(id)
    .first<RmBatchRow>();
  if (!row) {
    return c.json({ success: false, error: "Batch not found" }, 404);
  }
  return c.json({ success: true, data: rowToApi(row) });
});

export default app;
