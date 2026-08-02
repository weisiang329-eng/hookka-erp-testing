// ---------------------------------------------------------------------------
// D1-backed price-history route.
//
// Mirrors src/api/routes/price-history.ts. Backed by the `price_histories`
// table (note: plural — matches migration schema). Each row records an old→new
// price change for a supplier_material_binding with approval workflow status.
//
// NOTE: the original in-memory route returns `{ error }` (no `success: false`)
// on POST validation errors. Preserving that exact shape.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

type PriceHistoryRow = {
  id: string;
  bindingId: string;
  supplierId: string;
  materialCode: string;
  oldPrice: number;
  newPrice: number;
  currency: "MYR" | "RMB" | null;
  changedDate: string;
  // The date the price takes effect (effective-dated model). Older rows
  // predate the column → fall back to changedDate so the log never blanks.
  effectiveFrom: string | null;
  changedBy: string;
  reason: string | null;
  approvalStatus: "APPROVED" | "PENDING" | "REJECTED" | null;
};

function rowToHistory(r: PriceHistoryRow) {
  return {
    id: r.id,
    bindingId: r.bindingId,
    supplierId: r.supplierId,
    materialCode: r.materialCode,
    oldPrice: r.oldPrice,
    newPrice: r.newPrice,
    currency: r.currency ?? "MYR",
    changedDate: r.changedDate,
    effectiveFrom: r.effectiveFrom ?? r.changedDate,
    changedBy: r.changedBy,
    reason: r.reason ?? "",
    approvalStatus: r.approvalStatus ?? "PENDING",
  };
}

function genId(): string {
  return `ph-${crypto.randomUUID().slice(0, 8)}`;
}

// GET /api/price-history?materialCode=...&supplierId=...
app.get("/", async (c) => {
  const materialCode = c.req.query("materialCode");
  const supplierId = c.req.query("supplierId");
  const where: string[] = [];
  const binds: unknown[] = [];
  if (materialCode) {
    where.push("materialCode = ?");
    binds.push(materialCode);
  }
  if (supplierId) {
    where.push("supplierId = ?");
    binds.push(supplierId);
  }
  const sql =
    where.length > 0
      ? `SELECT * FROM price_histories WHERE ${where.join(" AND ")} ORDER BY changedDate DESC`
      : "SELECT * FROM price_histories ORDER BY changedDate DESC";
  const res = await c.var.DB.prepare(sql)
    .bind(...binds)
    .all<PriceHistoryRow>();
  const data = (res.results ?? []).map(rowToHistory);
  return c.json({ success: true, data });
});

// Runtime self-apply for the effective_from column (effective-dated pricing,
// migration 0183). Mirrors ensureBindingColumns in supplier-materials.ts so
// this route can write effective_from even if it's hit before that route.
let effectiveFromEnsured = false;
async function ensureEffectiveFromColumn(db: D1Database): Promise<void> {
  if (effectiveFromEnsured) return;

  try {
    await db
      .prepare(
        "ALTER TABLE price_histories ADD COLUMN IF NOT EXISTS effective_from TEXT",
      )
      .run();
  } catch {
    /* already exists / transient — ignore */
  }
  effectiveFromEnsured = true;
}

// POST /api/price-history — record a price change entry
app.post("/", async (c) => {
  const denied = await requirePermission(c, "price-history", "create");
  if (denied) return denied;
  await ensureEffectiveFromColumn(c.var.DB);
  try {
    const body = await c.req.json();
    const { bindingId, supplierId, materialCode, oldPrice, newPrice } = body;
    if (
      !bindingId ||
      !supplierId ||
      !materialCode ||
      oldPrice == null ||
      newPrice == null
    ) {
      return c.json(
        {
          error:
            "bindingId, supplierId, materialCode, oldPrice, and newPrice are required",
        },
        400,
      );
    }
    const id = genId();
    const changedDate = body.changedDate ?? new Date().toISOString().slice(0, 10);
    const row = {
      id,
      bindingId: String(bindingId),
      supplierId: String(supplierId),
      materialCode: String(materialCode),
      oldPrice: Number(oldPrice),
      newPrice: Number(newPrice),
      currency: body.currency === "RMB" ? "RMB" : "MYR",
      changedDate,
      // Effective date this price takes effect; default to the change date.
      effectiveFrom: body.effectiveFrom ?? changedDate,
      changedBy: body.changedBy ?? "System",
      reason: body.reason ?? "",
      approvalStatus:
        body.approvalStatus === "APPROVED" ||
        body.approvalStatus === "REJECTED"
          ? body.approvalStatus
          : "PENDING",
    };
    await c.var.DB.prepare(
      `INSERT INTO price_histories (id, bindingId, supplierId, materialCode,
         oldPrice, newPrice, currency, changedDate, effectiveFrom, changedBy,
         reason, approvalStatus)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id,
        row.bindingId,
        row.supplierId,
        row.materialCode,
        row.oldPrice,
        row.newPrice,
        row.currency,
        row.changedDate,
        row.effectiveFrom,
        row.changedBy,
        row.reason,
        row.approvalStatus,
      )
      .run();
    const created = await c.var.DB.prepare(
      "SELECT * FROM price_histories WHERE id = ?",
    )
      .bind(id)
      .first<PriceHistoryRow>();
    if (!created) {
      return c.json(
        { error: "Failed to create price history entry" },
        500,
      );
    }
    return c.json({ success: true, data: rowToHistory(created) }, 201);
  } catch {
    return c.json({ error: "Invalid request body" }, 400);
  }
});

export default app;
