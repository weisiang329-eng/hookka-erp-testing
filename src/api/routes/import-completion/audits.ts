import { Hono } from "hono";
import type { Env } from "../../worker";
import { requirePermission } from "../../lib/rbac";
import { loadAndValidatePOAlignment } from "../../lib/po-alignment-validator";
import { type AuditCheck } from "./_shared";

const app = new Hono<Env>();


// ---------------------------------------------------------------------------
// Phase 5.3 — pre-flight probe for the UNIQUE poNo index.
//
// The retry-on-collision path in purchase-orders.ts depends on
// CREATE UNIQUE INDEX ux_purchase_orders_po_no, which is rolled out via
// the self-applying ensurePendingMigrations() in that route. The CREATE
// will FAIL on first run if duplicate poNos exist on prod (556+
// historical POs, imported in two passes, real risk of collision).
//
// This endpoint surfaces any duplicate poNos so the parent agent can
// dedupe BEFORE the migration tries to land. Read-only; never mutates.
// ---------------------------------------------------------------------------
app.get("/po-no-duplicates", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "read");
  if (denied) return denied;
  const res = await c.var.DB.prepare(
    `SELECT poNo       AS "poNo",
            COUNT(*)   AS "count"
       FROM purchase_orders
      GROUP BY poNo
     HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC, poNo ASC`,
  ).all<{ poNo: string; count: number }>();
  const duplicates = (res.results ?? []).map((row) => ({
    poNo: row.poNo,
    count: Number(row.count),
  }));
  return c.json({
    success: true,
    duplicates,
    total: duplicates.length,
  });
});

app.post("/audit-procurement-integrity", async (c) => {
  const denied = await requirePermission(c, "purchase-orders", "read");
  if (denied) return denied;
  const db = c.var.DB;
  const checks: AuditCheck[] = [];

  // 1. po_without_items — error. Empty parent rows are invariant violations.
  {
    const r = await db
      .prepare(
        `SELECT po.id      AS "id",
                po.poNo    AS "poNo",
                po.status  AS "status"
           FROM purchase_orders po
          WHERE NOT EXISTS (
                  SELECT 1 FROM purchase_order_items poi
                   WHERE poi.purchaseOrderId = po.id
                )
          ORDER BY po.created_at DESC
          LIMIT 5`,
      )
      .all<{ id: string; poNo: string; status: string }>();
    const sample = r.results ?? [];
    const cnt = await db
      .prepare(
        `SELECT COUNT(*) AS "c"
           FROM purchase_orders po
          WHERE NOT EXISTS (
                  SELECT 1 FROM purchase_order_items poi
                   WHERE poi.purchaseOrderId = po.id
                )`,
      )
      .first<{ c: number }>();
    checks.push({
      name: "po_without_items",
      severity: "error",
      count: Number(cnt?.c ?? 0),
      sample,
    });
  }

  // 2. po_item_orphans — error. Items pointing at a non-existent PO row.
  {
    const r = await db
      .prepare(
        `SELECT poi.id              AS "id",
                poi.purchaseOrderId AS "purchaseOrderId",
                poi.materialName    AS "materialName"
           FROM purchase_order_items poi
          WHERE NOT EXISTS (
                  SELECT 1 FROM purchase_orders po
                   WHERE po.id = poi.purchaseOrderId
                )
          LIMIT 5`,
      )
      .all<{ id: string; purchaseOrderId: string; materialName: string }>();
    const sample = r.results ?? [];
    const cnt = await db
      .prepare(
        `SELECT COUNT(*) AS "c"
           FROM purchase_order_items poi
          WHERE NOT EXISTS (
                  SELECT 1 FROM purchase_orders po
                   WHERE po.id = poi.purchaseOrderId
                )`,
      )
      .first<{ c: number }>();
    checks.push({
      name: "po_item_orphans",
      severity: "error",
      count: Number(cnt?.c ?? 0),
      sample,
    });
  }

  // 3. binding_unknown_material — warning. Catalog drift; binding points
  // at an itemCode that no longer exists in raw_materials.
  {
    const r = await db
      .prepare(
        `SELECT smb.id           AS "id",
                smb.materialCode AS "materialCode",
                smb.supplierId   AS "supplierId"
           FROM supplier_material_bindings smb
          WHERE NOT EXISTS (
                  SELECT 1 FROM raw_materials rm
                   WHERE rm.itemCode = smb.materialCode
                )
          LIMIT 5`,
      )
      .all<{ id: string; materialCode: string; supplierId: string }>();
    const sample = r.results ?? [];
    const cnt = await db
      .prepare(
        `SELECT COUNT(*) AS "c"
           FROM supplier_material_bindings smb
          WHERE NOT EXISTS (
                  SELECT 1 FROM raw_materials rm
                   WHERE rm.itemCode = smb.materialCode
                )`,
      )
      .first<{ c: number }>();
    checks.push({
      name: "binding_unknown_material",
      severity: "warning",
      count: Number(cnt?.c ?? 0),
      sample,
    });
  }

  // 4. po_supplier_orphan — info. Historical PO referencing a deleted
  // supplier row. Not corrupting (the FK on purchase_orders won't allow
  // future inserts) but legacy rows can leak.
  {
    const r = await db
      .prepare(
        `SELECT po.id         AS "id",
                po.poNo       AS "poNo",
                po.supplierId AS "supplierId"
           FROM purchase_orders po
          WHERE po.supplierId IS NOT NULL
            AND po.supplierId <> ''
            AND NOT EXISTS (
                  SELECT 1 FROM suppliers s
                   WHERE s.id = po.supplierId
                )
          LIMIT 5`,
      )
      .all<{ id: string; poNo: string; supplierId: string }>();
    const sample = r.results ?? [];
    const cnt = await db
      .prepare(
        `SELECT COUNT(*) AS "c"
           FROM purchase_orders po
          WHERE po.supplierId IS NOT NULL
            AND po.supplierId <> ''
            AND NOT EXISTS (
                  SELECT 1 FROM suppliers s
                   WHERE s.id = po.supplierId
                )`,
      )
      .first<{ c: number }>();
    checks.push({
      name: "po_supplier_orphan",
      severity: "info",
      count: Number(cnt?.c ?? 0),
      sample,
    });
  }

  // 5. grn_supplier_orphan — info.
  {
    const r = await db
      .prepare(
        `SELECT g.id         AS "id",
                g.grnNumber  AS "grnNumber",
                g.supplierId AS "supplierId"
           FROM grns g
          WHERE g.supplierId IS NOT NULL
            AND g.supplierId <> ''
            AND NOT EXISTS (
                  SELECT 1 FROM suppliers s
                   WHERE s.id = g.supplierId
                )
          LIMIT 5`,
      )
      .all<{ id: string; grnNumber: string; supplierId: string }>();
    const sample = r.results ?? [];
    const cnt = await db
      .prepare(
        `SELECT COUNT(*) AS "c"
           FROM grns g
          WHERE g.supplierId IS NOT NULL
            AND g.supplierId <> ''
            AND NOT EXISTS (
                  SELECT 1 FROM suppliers s
                   WHERE s.id = g.supplierId
                )`,
      )
      .first<{ c: number }>();
    checks.push({
      name: "grn_supplier_orphan",
      severity: "info",
      count: Number(cnt?.c ?? 0),
      sample,
    });
  }

  // 6. pi_supplier_orphan — info.
  {
    const r = await db
      .prepare(
        `SELECT pi.id         AS "id",
                pi.piNo       AS "piNo",
                pi.supplierId AS "supplierId"
           FROM purchase_invoices pi
          WHERE pi.supplierId IS NOT NULL
            AND pi.supplierId <> ''
            AND NOT EXISTS (
                  SELECT 1 FROM suppliers s
                   WHERE s.id = pi.supplierId
                )
          LIMIT 5`,
      )
      .all<{ id: string; piNo: string; supplierId: string }>();
    const sample = r.results ?? [];
    const cnt = await db
      .prepare(
        `SELECT COUNT(*) AS "c"
           FROM purchase_invoices pi
          WHERE pi.supplierId IS NOT NULL
            AND pi.supplierId <> ''
            AND NOT EXISTS (
                  SELECT 1 FROM suppliers s
                   WHERE s.id = pi.supplierId
                )`,
      )
      .first<{ c: number }>();
    checks.push({
      name: "pi_supplier_orphan",
      severity: "info",
      count: Number(cnt?.c ?? 0),
      sample,
    });
  }

  // 7. grn_po_orphan — info. GRN claims a poId that no longer exists.
  {
    const r = await db
      .prepare(
        `SELECT g.id        AS "id",
                g.grnNumber AS "grnNumber",
                g.poId      AS "poId"
           FROM grns g
          WHERE g.poId IS NOT NULL
            AND g.poId <> ''
            AND NOT EXISTS (
                  SELECT 1 FROM purchase_orders po
                   WHERE po.id = g.poId
                )
          LIMIT 5`,
      )
      .all<{ id: string; grnNumber: string; poId: string }>();
    const sample = r.results ?? [];
    const cnt = await db
      .prepare(
        `SELECT COUNT(*) AS "c"
           FROM grns g
          WHERE g.poId IS NOT NULL
            AND g.poId <> ''
            AND NOT EXISTS (
                  SELECT 1 FROM purchase_orders po
                   WHERE po.id = g.poId
                )`,
      )
      .first<{ c: number }>();
    checks.push({
      name: "grn_po_orphan",
      severity: "info",
      count: Number(cnt?.c ?? 0),
      sample,
    });
  }

  // 8. pi_po_orphan — info. PI claims a purchaseOrderId that no longer
  // exists.
  {
    const r = await db
      .prepare(
        `SELECT pi.id              AS "id",
                pi.piNo            AS "piNo",
                pi.purchaseOrderId AS "purchaseOrderId"
           FROM purchase_invoices pi
          WHERE pi.purchaseOrderId IS NOT NULL
            AND pi.purchaseOrderId <> ''
            AND NOT EXISTS (
                  SELECT 1 FROM purchase_orders po
                   WHERE po.id = pi.purchaseOrderId
                )
          LIMIT 5`,
      )
      .all<{ id: string; piNo: string; purchaseOrderId: string }>();
    const sample = r.results ?? [];
    const cnt = await db
      .prepare(
        `SELECT COUNT(*) AS "c"
           FROM purchase_invoices pi
          WHERE pi.purchaseOrderId IS NOT NULL
            AND pi.purchaseOrderId <> ''
            AND NOT EXISTS (
                  SELECT 1 FROM purchase_orders po
                   WHERE po.id = pi.purchaseOrderId
                )`,
      )
      .first<{ c: number }>();
    checks.push({
      name: "pi_po_orphan",
      severity: "info",
      count: Number(cnt?.c ?? 0),
      sample,
    });
  }

  // 9. received_qty_overage — info. PO line where receivedQty exceeds
  // 110% of ordered (the GRN gate enforces this for new posts; historical
  // imports may pre-date it).
  {
    const r = await db
      .prepare(
        `SELECT poi.id              AS "id",
                poi.purchaseOrderId AS "purchaseOrderId",
                poi.materialName    AS "materialName",
                poi.quantity        AS "quantity",
                poi.receivedQty     AS "receivedQty"
           FROM purchase_order_items poi
          WHERE poi.quantity > 0
            AND poi.receivedQty > poi.quantity * 1.1
          LIMIT 5`,
      )
      .all<{
        id: string;
        purchaseOrderId: string;
        materialName: string;
        quantity: number;
        receivedQty: number;
      }>();
    const sample = r.results ?? [];
    const cnt = await db
      .prepare(
        `SELECT COUNT(*) AS "c"
           FROM purchase_order_items poi
          WHERE poi.quantity > 0
            AND poi.receivedQty > poi.quantity * 1.1`,
      )
      .first<{ c: number }>();
    checks.push({
      name: "received_qty_overage",
      severity: "info",
      count: Number(cnt?.c ?? 0),
      sample,
    });
  }

  // 10. status_received_no_grn — info. After Phase 2.4's phantom backfill
  // runs, this should settle to 0; anything that lights up afterwards is
  // a real new-flow gap (a PO marked RECEIVED bypassing the 2.3 gate).
  {
    const r = await db
      .prepare(
        `SELECT po.id     AS "id",
                po.poNo   AS "poNo",
                po.status AS "status"
           FROM purchase_orders po
          WHERE po.status = 'RECEIVED'
            AND NOT EXISTS (
                  SELECT 1 FROM grns g
                   WHERE g.poId = po.id
                )
          LIMIT 5`,
      )
      .all<{ id: string; poNo: string; status: string }>();
    const sample = r.results ?? [];
    const cnt = await db
      .prepare(
        `SELECT COUNT(*) AS "c"
           FROM purchase_orders po
          WHERE po.status = 'RECEIVED'
            AND NOT EXISTS (
                  SELECT 1 FROM grns g
                   WHERE g.poId = po.id
                )`,
      )
      .first<{ c: number }>();
    checks.push({
      name: "status_received_no_grn",
      severity: "info",
      count: Number(cnt?.c ?? 0),
      sample,
    });
  }

  return c.json({ success: true, checks });
});

// ---------------------------------------------------------------------------
// GET /api/import/audit-po-alignment?soId=XXX
//
// On-demand audit of an SO's production_orders against its
// sales_order_items. Returns alignment errors, attribute mismatches, and
// unlinked POs. Read-only — no writes.
//
// soId can be either internal id (e.g. "so-0f7cf47b") or companySOId
// (e.g. "SO-2605-027"). Falls back to companySOId lookup when direct id
// query returns nothing.
//
// Permission: sales-orders:read.
// ---------------------------------------------------------------------------
app.get("/audit-po-alignment", async (c) => {
  const denied = await requirePermission(c, "sales-orders", "read");
  if (denied) return denied;

  const soIdRaw = c.req.query("soId");
  if (!soIdRaw) {
    return c.json(
      { success: false, error: "soId query param required" },
      400,
    );
  }

  let soId: string | null = null;
  let companySOId: string | null = null;
  const direct = await c.var.DB.prepare(
    "SELECT id, companySOId FROM sales_orders WHERE id = ? LIMIT 1",
  )
    .bind(soIdRaw)
    .first<{ id: string; companySOId: string | null }>();
  if (direct) {
    soId = direct.id;
    companySOId = direct.companySOId;
  } else {
    const byCompany = await c.var.DB.prepare(
      "SELECT id, companySOId FROM sales_orders WHERE companySOId = ? LIMIT 1",
    )
      .bind(soIdRaw)
      .first<{ id: string; companySOId: string | null }>();
    if (byCompany) {
      soId = byCompany.id;
      companySOId = byCompany.companySOId;
    }
  }
  if (!soId) {
    return c.json(
      { success: false, error: `SO not found: ${soIdRaw}` },
      404,
    );
  }

  const result = await loadAndValidatePOAlignment(c.var.DB, soId);
  return c.json({
    success: true,
    soId,
    companySOId,
    ...result,
  });
});

export default app;
