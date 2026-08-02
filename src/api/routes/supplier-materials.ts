// ---------------------------------------------------------------------------
// D1-backed supplier-materials route.
//
// Mirrors src/api/routes/supplier-materials.ts. Backed by the
// `supplier_material_bindings` table (per-SKU price bindings with a validity
// window and main-supplier flag) — this is DIFFERENT from `supplier_materials`
// (which is the catalogue field nested in each Supplier, see suppliers.ts).
//
// Schema column `isMainSupplier` is INTEGER 0/1; we return it as boolean.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";

const app = new Hono<Env>();

type BindingRow = {
  id: string;
  supplierId: string;
  materialCode: string;
  materialName: string;
  supplierSku: string;
  // Supplier-side description for the SKU. Internal materialName describes
  // what we call the item; supplierDescription is what the supplier prints
  // on their PI/quote (often more detailed: pack size, finish, etc).
  // Wei Siang 2026-05-10: needed alongside Internal/Supplier code pair.
  supplierDescription: string | null;
  unitPrice: number;
  currency: "MYR" | "RMB" | null;
  leadTimeDays: number;
  paymentTerms: string | null;
  moq: number;
  // Legacy validity window (deprecated). Kept on the row so historical
  // bindings still read; the price model is now effective-dated (effectiveFrom).
  priceValidFrom: string | null;
  priceValidTo: string | null;
  // The date THIS price takes effect (effective-dated model, like Customer
  // Quotation / maintenance-config). Current price = newest effectiveFrom
  // <= today. Older bindings predate the column → fall back to priceValidFrom
  // (which was where the "from" date used to live).
  effectiveFrom: string | null;
  isMainSupplier: number;
};

function rowToBinding(r: BindingRow) {
  // Effective date: prefer the new column; fall back to the legacy
  // priceValidFrom for rows that predate the migration (so existing bindings
  // surface a sensible "Effective From" instead of blank).
  const effectiveFrom = r.effectiveFrom ?? r.priceValidFrom ?? "";
  return {
    id: r.id,
    supplierId: r.supplierId,
    materialCode: r.materialCode,
    materialName: r.materialName,
    supplierSku: r.supplierSku,
    supplierDescription: r.supplierDescription ?? "",
    unitPrice: r.unitPrice,
    currency: r.currency ?? "MYR",
    leadTimeDays: r.leadTimeDays,
    paymentTerms: r.paymentTerms ?? "NET30",
    moq: r.moq,
    effectiveFrom,
    // Legacy fields kept in the response for any remaining old consumers; new
    // UI reads effectiveFrom. priceValidFrom mirrors effectiveFrom so nothing
    // that still references the old key breaks.
    priceValidFrom: effectiveFrom,
    priceValidTo: r.priceValidTo ?? "",
    isMainSupplier: r.isMainSupplier === 1,
  };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function genId(): string {
  return `smb-${crypto.randomUUID().slice(0, 8)}`;
}

// Runtime self-apply (same pattern as ensureQrTokenColumns / ensureNotifyEmail
// Columns): the `supplier_description` column was referenced by this route's
// POST/PUT since 2026-05-10 but never migrated in, so EVERY create/edit of a
// SKU binding threw on the missing column and returned 400 "Invalid request
// body" (supplier-code edits silently did nothing). Land it on first use;
// migration 0174 makes it permanent. Idempotent + once per worker instance.
let bindingColumnsEnsured = false;
async function ensureBindingColumns(db: D1Database): Promise<void> {
  if (bindingColumnsEnsured) return;

  // Each ALTER is in its own try/catch so one failing column doesn't block
  // the others (the column may already exist or DDL may transiently reject).
  try {
    await db
      .prepare(
        "ALTER TABLE supplier_material_bindings ADD COLUMN IF NOT EXISTS supplier_description TEXT",
      )
      .run();
  } catch {
    /* already exists / transient — ignore */
  }
  // Effective-dated pricing (migration 0183): the date this price takes
  // effect. Current price = newest effectiveFrom <= today. Append-only audit
  // trail lives in price_histories (also carrying effective_from so the
  // Price Change Log shows the real effective date, not the system clock).
  try {
    await db
      .prepare(
        "ALTER TABLE supplier_material_bindings ADD COLUMN IF NOT EXISTS effective_from TEXT",
      )
      .run();
  } catch {
    /* already exists / transient — ignore */
  }
  try {
    await db
      .prepare(
        "ALTER TABLE price_histories ADD COLUMN IF NOT EXISTS effective_from TEXT",
      )
      .run();
  } catch {
    /* already exists / transient — ignore */
  }
  bindingColumnsEnsured = true;
}

// GET /api/supplier-materials?supplierId=...&materialCode=...
//
// LEFT JOIN suppliers so each binding carries supplierName + supplierCode in
// the response — the mobile Price Comparison view (Raw Material detail) shows
// supplier NAMES, not opaque sup-XXX ids. Desktop reads supplierId direct so
// the addition is purely additive.
app.get("/", async (c) => {
  const supplierId = c.req.query("supplierId");
  const materialCode = c.req.query("materialCode");
  const orgId = getOrgId(c);
  const where: string[] = ["b.orgId = ?"];
  const binds: unknown[] = [orgId];
  if (supplierId) {
    where.push("b.supplierId = ?");
    binds.push(supplierId);
  }
  if (materialCode) {
    where.push("b.materialCode = ?");
    binds.push(materialCode);
  }
  const sql = `
    SELECT b.*, s.name AS _supplier_name, s.code AS _supplier_code
    FROM supplier_material_bindings b
    LEFT JOIN suppliers s ON s.id = b.supplierId
    WHERE ${where.join(" AND ")}
    ORDER BY b.materialCode, b.unitPrice ASC`;
  const res = await c.var.DB.prepare(sql)
    .bind(...binds)
    .all<BindingRow & { _supplierName?: string | null; _supplierCode?: string | null }>();
  const data = (res.results ?? []).map((r) => ({
    ...rowToBinding(r),
    supplierName: r._supplierName ?? "",
    supplierCode: r._supplierCode ?? "",
  }));
  return c.json({ success: true, data });
});

// POST /api/supplier-materials — create a new price binding
app.post("/", async (c) => {
  const denied = await requirePermission(c, "supplier-materials", "create");
  if (denied) return denied;
  await ensureBindingColumns(c.var.DB);
  try {
    const body = await c.req.json();
    const { supplierId, materialCode, materialName, supplierSku, unitPrice } =
      body;
    if (
      !supplierId ||
      !materialCode ||
      !materialName ||
      !supplierSku ||
      unitPrice == null
    ) {
      return c.json(
        {
          success: false,
          error:
            "supplierId, materialCode, materialName, supplierSku, and unitPrice are required",
        },
        400,
      );
    }
    const id = genId();
    // Effective date: when this price takes effect. Accept effectiveFrom; fall
    // back to the legacy priceValidFrom key, then to today. Owner ruling:
    // "today's price effective today" — a blank value means now.
    const effectiveFrom =
      body.effectiveFrom ?? body.priceValidFrom ?? todayIso();
    const row = {
      id,
      supplierId: String(supplierId),
      materialCode: String(materialCode),
      materialName: String(materialName),
      supplierSku: String(supplierSku),
      supplierDescription:
        body.supplierDescription != null ? String(body.supplierDescription) : "",
      unitPrice: Number(unitPrice),
      currency: body.currency === "RMB" ? "RMB" : "MYR",
      leadTimeDays: Number(body.leadTimeDays) || 7,
      paymentTerms: body.paymentTerms ?? "NET30",
      moq: Number(body.moq) || 1,
      effectiveFrom: String(effectiveFrom),
      isMainSupplier: body.isMainSupplier ? 1 : 0,
    };
    // Write both effectiveFrom (new) and priceValidFrom (legacy mirror) so the
    // column is populated either way and old reads still resolve. priceValidTo
    // is no longer collected; we leave it NULL going forward.
    await c.var.DB.prepare(
      `INSERT INTO supplier_material_bindings (id, supplierId, materialCode,
         materialName, supplierSku, supplierDescription, unitPrice, currency, leadTimeDays,
         paymentTerms, moq, effectiveFrom, priceValidFrom, isMainSupplier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id,
        row.supplierId,
        row.materialCode,
        row.materialName,
        row.supplierSku,
        row.supplierDescription,
        row.unitPrice,
        row.currency,
        row.leadTimeDays,
        row.paymentTerms,
        row.moq,
        row.effectiveFrom,
        row.effectiveFrom,
        row.isMainSupplier,
      )
      .run();
    // Seed the Price Change Log with the opening price (old = 0 → "first
    // price"). Append-only audit row carries the effective date so the log
    // shows the real effective date, not the system clock. Best-effort.
    try {
      await c.var.DB.prepare(
        `INSERT INTO price_histories (id, bindingId, supplierId, materialCode,
           oldPrice, newPrice, currency, changedDate, effectiveFrom, changedBy,
           reason, approvalStatus)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          `ph-${crypto.randomUUID().slice(0, 8)}`,
          id,
          row.supplierId,
          row.materialCode,
          0,
          row.unitPrice,
          row.currency,
          todayIso(),
          row.effectiveFrom,
          body.changedBy ?? "System",
          "Initial price",
          "APPROVED",
        )
        .run();
    } catch {
      /* history is best-effort; the binding create already succeeded */
    }
    const created = await c.var.DB.prepare(
      "SELECT * FROM supplier_material_bindings WHERE id = ?",
    )
      .bind(id)
      .first<BindingRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create binding" },
        500,
      );
    }
    return c.json({ success: true, data: rowToBinding(created) }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/supplier-materials/:id
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.var.DB.prepare(
    "SELECT * FROM supplier_material_bindings WHERE id = ?",
  )
    .bind(id)
    .first<BindingRow>();
  if (!row) return c.json({ success: false, error: "Binding not found" }, 404);
  return c.json({ success: true, data: rowToBinding(row) });
});

// PUT /api/supplier-materials/:id — shallow merge partial update
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "supplier-materials", "update");
  if (denied) return denied;
  await ensureBindingColumns(c.var.DB);
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM supplier_material_bindings WHERE id = ?",
  )
    .bind(id)
    .first<BindingRow>();
  if (!existing) {
    return c.json({ success: false, error: "Binding not found" }, 404);
  }
  try {
    const body = await c.req.json();
    const priceChanged =
      body.unitPrice !== undefined &&
      Number(body.unitPrice) !== existing.unitPrice;
    const existingEffectiveFrom =
      existing.effectiveFrom ?? existing.priceValidFrom ?? "";
    // Effective-dated model: when the PRICE moves we stamp a new effective date
    // (caller-provided effectiveFrom, else today). When price is unchanged we
    // keep the existing effective date so a name/MOQ edit doesn't bump it.
    const newEffectiveFrom = priceChanged
      ? String(body.effectiveFrom ?? body.priceValidFrom ?? todayIso())
      : String(body.effectiveFrom ?? body.priceValidFrom ?? existingEffectiveFrom);
    const merged = {
      supplierId: body.supplierId ?? existing.supplierId,
      materialCode: body.materialCode ?? existing.materialCode,
      materialName: body.materialName ?? existing.materialName,
      supplierSku: body.supplierSku ?? existing.supplierSku,
      supplierDescription:
        body.supplierDescription !== undefined
          ? String(body.supplierDescription)
          : existing.supplierDescription ?? "",
      unitPrice:
        body.unitPrice !== undefined ? Number(body.unitPrice) : existing.unitPrice,
      currency:
        body.currency === "RMB" || body.currency === "MYR"
          ? body.currency
          : existing.currency ?? "MYR",
      leadTimeDays:
        body.leadTimeDays !== undefined
          ? Number(body.leadTimeDays)
          : existing.leadTimeDays,
      paymentTerms: body.paymentTerms ?? existing.paymentTerms ?? "NET30",
      moq: body.moq !== undefined ? Number(body.moq) : existing.moq,
      effectiveFrom: newEffectiveFrom,
      isMainSupplier:
        body.isMainSupplier === undefined
          ? existing.isMainSupplier
          : body.isMainSupplier
            ? 1
            : 0,
    };
    // Write effectiveFrom (new) and mirror into priceValidFrom (legacy) so the
    // current price record always carries the effective date in both columns.
    await c.var.DB.prepare(
      `UPDATE supplier_material_bindings SET
         supplierId = ?, materialCode = ?, materialName = ?, supplierSku = ?,
         supplierDescription = ?, unitPrice = ?, currency = ?, leadTimeDays = ?,
         paymentTerms = ?, moq = ?, effectiveFrom = ?, priceValidFrom = ?,
         isMainSupplier = ?
       WHERE id = ?`,
    )
      .bind(
        merged.supplierId,
        merged.materialCode,
        merged.materialName,
        merged.supplierSku,
        merged.supplierDescription,
        merged.unitPrice,
        merged.currency,
        merged.leadTimeDays,
        merged.paymentTerms,
        merged.moq,
        merged.effectiveFrom,
        merged.effectiveFrom,
        merged.isMainSupplier,
        id,
      )
      .run();
    // Append a price-history entry whenever the unit price moves — the trail is
    // APPEND-ONLY (a new row per change; the prior price is never overwritten),
    // which is what makes the Price Change Log auditable. The row carries
    // effectiveFrom so the log's Effective Date column is the price's effective
    // date, not the system clock. Fire-and-forget inside its own try/catch: a
    // history-write failure must never fail the edit (matches the "binding write
    // throws → 400" gotcha we already guard against).
    if (priceChanged) {
      try {
        await c.var.DB.prepare(
          `INSERT INTO price_histories (id, bindingId, supplierId, materialCode,
             oldPrice, newPrice, currency, changedDate, effectiveFrom, changedBy,
             reason, approvalStatus)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            `ph-${crypto.randomUUID().slice(0, 8)}`,
            id,
            merged.supplierId,
            merged.materialCode,
            existing.unitPrice,
            merged.unitPrice,
            merged.currency,
            todayIso(),
            merged.effectiveFrom,
            body.changedBy ?? "System",
            "Price binding updated",
            "APPROVED",
          )
          .run();
      } catch {
        // history is best-effort; the binding update already succeeded
      }
    }
    const updated = await c.var.DB.prepare(
      "SELECT * FROM supplier_material_bindings WHERE id = ?",
    )
      .bind(id)
      .first<BindingRow>();
    if (!updated) {
      return c.json(
        { success: false, error: "Failed to reload binding" },
        500,
      );
    }
    return c.json({ success: true, data: rowToBinding(updated) });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// DELETE /api/supplier-materials/:id
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "supplier-materials", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM supplier_material_bindings WHERE id = ?",
  )
    .bind(id)
    .first<BindingRow>();
  if (!existing) {
    return c.json({ success: false, error: "Binding not found" }, 404);
  }
  await c.var.DB.prepare("DELETE FROM supplier_material_bindings WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ success: true, data: rowToBinding(existing) });
});

export default app;
