// ---------------------------------------------------------------------------
// purchase-returns.ts — supplier-side returns (owner 2026-07-30), the mirror of
// delivery-returns.ts. Slice 1: create a Purchase Return from a Purchase
// Invoice (pick lines + qty + editable return cost + reason), PR numbering, and
// list / detail reads. NO inventory or AP ledger movement yet — status stays
// OPEN (slices 2 + 3 add the stock reversal + the supplier Debit Note, each
// owner-verified). See docs/plans/2026-07-30-purchase-return.md.
//
// RBAC-gated on `purchase-invoices` (same resource as the source doc);
// tenant-scoped by org_id. Tables self-applied at runtime.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import {
  ensurePurchaseReturnTables,
  createPurchaseReturn,
  loadPiItemsForReturn,
  applyPurchaseReturnStockOut,
  type PRCreateItem,
} from "../lib/purchase-return-create";

const app = new Hono<Env>();

function actingUserId(c: Context<Env>): string | null {
  return (c as unknown as { get: (k: string) => string | undefined }).get("userId") ?? null;
}
const pick = (r: Record<string, unknown>, snake: string, camel: string): unknown =>
  r[snake] ?? r[camel];

// GET /api/purchase-returns — list (newest first)
app.get("/", async (c) => {
  const denied = await requirePermission(c, "purchase-invoices", "read");
  if (denied) return denied;
  await ensurePurchaseReturnTables(c.var.DB);
  const res = await c.var.DB.prepare(
    `SELECT * FROM purchase_returns WHERE org_id = ? OR org_id IS NULL
      ORDER BY created_at DESC`,
  )
    .bind(getOrgId(c))
    .all<Record<string, unknown>>();
  return c.json({ success: true, data: res.results ?? [] });
});

// GET /api/purchase-returns/source/pi/:piId — the PI header + its returnable
// (stocked) lines, so the create form can pre-fill the picker.
app.get("/source/pi/:piId", async (c) => {
  const denied = await requirePermission(c, "purchase-invoices", "read");
  if (denied) return denied;
  await ensurePurchaseReturnTables(c.var.DB);
  const piId = c.req.param("piId");
  const pi = await c.var.DB.prepare("SELECT * FROM purchase_invoices WHERE id = ?")
    .bind(piId)
    .first<Record<string, unknown>>();
  if (!pi) return c.json({ success: false, error: "Purchase invoice not found" }, 404);
  const items = await loadPiItemsForReturn(c.var.DB, piId);
  return c.json({
    success: true,
    data: {
      purchaseInvoiceId: piId,
      piNo: String(pick(pi, "pi_no", "piNo") ?? ""),
      supplierId: String(pick(pi, "supplier_id", "supplierId") ?? ""),
      supplierName: String(pick(pi, "supplier_name", "supplierName") ?? ""),
      status: String(pi.status ?? ""),
      paidAmountSen: Number(pick(pi, "paid_amount_sen", "paidAmountSen") ?? 0),
      items,
    },
  });
});

// GET /api/purchase-returns/:id — header + items
app.get("/:id", async (c) => {
  const denied = await requirePermission(c, "purchase-invoices", "read");
  if (denied) return denied;
  await ensurePurchaseReturnTables(c.var.DB);
  const id = c.req.param("id");
  const header = await c.var.DB.prepare(
    "SELECT * FROM purchase_returns WHERE id = ? AND (org_id = ? OR org_id IS NULL)",
  )
    .bind(id, getOrgId(c))
    .first<Record<string, unknown>>();
  if (!header) return c.json({ success: false, error: "Purchase return not found" }, 404);
  const items = await c.var.DB.prepare(
    "SELECT * FROM purchase_return_items WHERE purchase_return_id = ? ORDER BY id ASC",
  )
    .bind(id)
    .all<Record<string, unknown>>();
  return c.json({ success: true, data: { ...header, items: items.results ?? [] } });
});

// POST /api/purchase-returns — create from a PI
app.post("/", async (c) => {
  const denied = await requirePermission(c, "purchase-invoices", "create");
  if (denied) return denied;
  await ensurePurchaseReturnTables(c.var.DB);
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const purchaseInvoiceId = String(b.purchaseInvoiceId ?? b.purchase_invoice_id ?? "").trim();
  if (!purchaseInvoiceId) {
    return c.json({ success: false, error: "purchaseInvoiceId required" }, 400);
  }
  const rawItems = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : [];
  const items: PRCreateItem[] = rawItems
    .map((it) => ({
      purchaseInvoiceItemId: it.purchaseInvoiceItemId ? String(it.purchaseInvoiceItemId) : undefined,
      materialCode: (it.materialCode as string) ?? null,
      materialName: (it.materialName as string) ?? "",
      supplierSku: (it.supplierSku as string) ?? null,
      grnItemId: (it.grnItemId as string) ?? null,
      quantity: Number(it.quantity ?? 0),
      unitCostSen: Number(it.unitCostSen ?? 0),
      problem: (it.problem as string) ?? "",
    }))
    .filter((it) => Number(it.quantity) > 0);
  if (items.length === 0) {
    return c.json({ success: false, error: "at least one line with quantity > 0 is required" }, 400);
  }
  // Snapshot the supplier / PI no from the source PI header.
  const pi = await c.var.DB.prepare("SELECT * FROM purchase_invoices WHERE id = ?")
    .bind(purchaseInvoiceId)
    .first<Record<string, unknown>>();
  if (!pi) return c.json({ success: false, error: "Purchase invoice not found" }, 404);
  const created = await createPurchaseReturn(c.var.DB, {
    purchaseInvoiceId,
    piNo: String(pick(pi, "pi_no", "piNo") ?? ""),
    supplierId: String(pick(pi, "supplier_id", "supplierId") ?? ""),
    supplierName: String(pick(pi, "supplier_name", "supplierName") ?? ""),
    reason: String(b.reason ?? ""),
    notes: String(b.notes ?? ""),
    resolution: b.resolution ? String(b.resolution) : "REFUND",
    createdBy: actingUserId(c),
    orgId: getOrgId(c),
    items,
  });
  return c.json({ success: true, data: created });
});

// POST /api/purchase-returns/:id/confirm — slice 2: reverse the stock (the
// goods leave inventory). FIFO-consumes the material's batches + drops
// balanceQty + emits cost_ledger OUT rows, all in one atomic batch. Idempotent:
// fires only while OPEN, flips to STOCK_OUT. The supplier Debit Note + AP is
// slice 3. Inventory-critical → owner verifies on staging before prod.
app.post("/:id/confirm", async (c) => {
  const denied = await requirePermission(c, "purchase-invoices", "update");
  if (denied) return denied;
  await ensurePurchaseReturnTables(c.var.DB);
  const id = c.req.param("id");
  const result = await applyPurchaseReturnStockOut(c.var.DB, id, getOrgId(c));
  if (!result.ok) {
    const code = result.error === "not found" ? 404 : 409;
    return c.json({ success: false, error: result.error || "confirm failed" }, code);
  }
  return c.json({ success: true, data: { id, status: "STOCK_OUT", reversedItems: result.reversedItems } });
});

// DELETE /api/purchase-returns/:id — only while still OPEN (no ledger to unwind
// in slice 1, but the guard is here so slices 2/3 keep the same contract).
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "purchase-invoices", "delete");
  if (denied) return denied;
  await ensurePurchaseReturnTables(c.var.DB);
  const id = c.req.param("id");
  const row = await c.var.DB.prepare(
    "SELECT status FROM purchase_returns WHERE id = ? AND (org_id = ? OR org_id IS NULL)",
  )
    .bind(id, getOrgId(c))
    .first<{ status?: string }>();
  if (!row) return c.json({ success: false, error: "not found" }, 404);
  if ((row.status ?? "OPEN") !== "OPEN") {
    return c.json({ success: false, error: "only OPEN returns can be deleted" }, 409);
  }
  await c.var.DB.prepare("DELETE FROM purchase_return_items WHERE purchase_return_id = ?").bind(id).run();
  await c.var.DB.prepare("DELETE FROM purchase_returns WHERE id = ?").bind(id).run();
  return c.json({ success: true });
});

export default app;
