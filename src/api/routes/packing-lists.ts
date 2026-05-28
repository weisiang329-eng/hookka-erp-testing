// ---------------------------------------------------------------------------
// Packing Lists route.
//
// A "packing list" groups several delivery orders (one truck run, possibly
// many hubs) into one saved document. DOs stay where they are (Pending
// Dispatch etc.) — the packing list only references them so the warehouse can
// print one consolidated loading sheet. Business rule: a DO may belong to at
// most ONE packing list (enforced in POST by scanning existing lists).
//
// do_ids is stored as a JSON array of delivery_orders.id. Summary columns are
// snapshotted on create for the list view; the printed PDF (frontend) re-reads
// the live DO line items.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { getOrgId } from "../lib/tenant";
import { emitAudit } from "../lib/audit";

const app = new Hono<Env>();

type PackingListRow = {
  id: string;
  packing_no: string;
  status: string;
  do_ids: string;
  stop_count: number;
  total_units: number;
  total_m3: number | string;
  remarks: string | null;
  created_at: string | null;
  created_by: string | null;
  org_id: string;
};

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function rowToPackingList(r: PackingListRow) {
  return {
    id: r.id,
    packingNo: r.packing_no,
    status: r.status,
    doIds: parseIds(r.do_ids),
    stopCount: r.stop_count ?? 0,
    totalUnits: r.total_units ?? 0,
    totalM3: Number(r.total_m3 ?? 0),
    remarks: r.remarks ?? "",
    createdAt: r.created_at,
    createdBy: r.created_by,
  };
}

function isMissingTable(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /relation .*packing_lists.* does not exist|no such table/i.test(msg);
}

async function genNextPackingNo(db: D1Database, orgId: string): Promise<string> {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prefix = `PL-${yymm}-`;
  const res = await db
    .prepare(
      "SELECT packing_no FROM packing_lists WHERE org_id = ? AND packing_no LIKE ? ORDER BY packing_no DESC LIMIT 1",
    )
    .bind(orgId, `${prefix}%`)
    .first<{ packing_no: string }>();
  if (!res) return `${prefix}001`;
  const seq = parseInt(res.packing_no.replace(prefix, ""), 10);
  if (!Number.isFinite(seq)) return `${prefix}001`;
  return `${prefix}${String(seq + 1).padStart(3, "0")}`;
}

const SELECT_COLS =
  "id, packing_no, status, do_ids, stop_count, total_units, total_m3, remarks, created_at, created_by, org_id";

// GET / — list all packing lists for the org (newest first).
app.get("/", async (c) => {
  const orgId = getOrgId(c);
  try {
    const res = await c.var.DB.prepare(
      `SELECT ${SELECT_COLS} FROM packing_lists WHERE org_id = ? ORDER BY packing_no DESC`,
    )
      .bind(orgId)
      .all<PackingListRow>();
    const data = (res.results ?? []).map(rowToPackingList);
    return c.json({ success: true, data, total: data.length });
  } catch (e) {
    // Table not migrated yet — don't break the delivery page; return empty.
    if (isMissingTable(e)) return c.json({ success: true, data: [], total: 0 });
    throw e;
  }
});

// GET /:id — one packing list WITH its DOs + items assembled into "stops"
// ready for the consolidated packing-list PDF. Reads the LIVE delivery orders
// (not the snapshot), so the printed sheet reflects current line items.
app.get("/:id", async (c) => {
  const orgId = getOrgId(c);
  const id = c.req.param("id");
  try {
    const pl = await c.var.DB.prepare(
      `SELECT ${SELECT_COLS} FROM packing_lists WHERE id = ? AND org_id = ?`,
    )
      .bind(id, orgId)
      .first<PackingListRow>();
    if (!pl) return c.json({ success: false, error: "Packing list not found." }, 404);

    const doIds = parseIds(pl.do_ids);
    let stops: unknown[] = [];
    if (doIds.length > 0) {
      const ph = doIds.map(() => "?").join(",");
      const doRes = await c.var.DB.prepare(
        `SELECT id, doNo, customerName, customerState, hubName, deliveryAddress, contactPerson, contactPhone, deliveryDate, dispatchedAt, driverName, vehicleNo, totalM3
         FROM delivery_orders WHERE id IN (${ph}) AND orgId = ?`,
      )
        .bind(...doIds, orgId)
        .all<{
          id: string;
          doNo: string;
          customerName: string | null;
          customerState: string | null;
          hubName: string | null;
          deliveryAddress: string | null;
          contactPerson: string | null;
          contactPhone: string | null;
          deliveryDate: string | null;
          dispatchedAt: string | null;
          driverName: string | null;
          vehicleNo: string | null;
          totalM3: number | string | null;
        }>();
      const itemsRes = await c.var.DB.prepare(
        `SELECT deliveryOrderId, productCode, productName, sizeLabel, fabricCode, quantity, itemM3, rackingNumber
         FROM delivery_order_items WHERE deliveryOrderId IN (${ph}) AND orgId = ?`,
      )
        .bind(...doIds, orgId)
        .all<{
          deliveryOrderId: string;
          productCode: string | null;
          productName: string | null;
          sizeLabel: string | null;
          fabricCode: string | null;
          quantity: number | null;
          itemM3: number | string | null;
          rackingNumber: string | null;
        }>();
      const byDo = new Map<string, unknown[]>();
      for (const it of itemsRes.results ?? []) {
        const arr = (byDo.get(it.deliveryOrderId) as unknown[]) ?? [];
        arr.push({
          productCode: it.productCode ?? "",
          productName: it.productName ?? "",
          sizeLabel: it.sizeLabel ?? "",
          fabricCode: it.fabricCode ?? "",
          quantity: Number(it.quantity ?? 0),
          itemM3: Number(it.itemM3 ?? 0),
          rackingNumber: it.rackingNumber ?? "",
        });
        byDo.set(it.deliveryOrderId, arr);
      }
      // Preserve the operator's selection order.
      const orderIndex = new Map(doIds.map((d, i) => [d, i]));
      stops = (doRes.results ?? [])
        .sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0))
        .map((d) => ({
          doNo: d.doNo,
          customerName: d.customerName ?? "",
          hubName: d.hubName ?? "",
          hubState: d.customerState ?? "",
          deliveryAddress: d.deliveryAddress ?? "",
          contactPerson: d.contactPerson ?? "",
          contactPhone: d.contactPhone ?? "",
          deliveryDate: d.deliveryDate ?? "",
          dispatchDate: d.dispatchedAt ?? "",
          driverName: d.driverName ?? "",
          vehicleNo: d.vehicleNo ?? "",
          totalM3: Number(d.totalM3 ?? 0),
          items: byDo.get(d.id) ?? [],
        }));
    }

    return c.json({ success: true, data: { ...rowToPackingList(pl), stops } });
  } catch (e) {
    if (isMissingTable(e)) return c.json({ success: false, error: "Packing list storage is not set up yet." }, 503);
    throw e;
  }
});

// POST / — create a packing list from selected delivery orders.
app.post("/", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "create");
  if (denied) return denied;
  const orgId = getOrgId(c);
  try {
    const body = await c.req.json<{ doIds?: string[]; remarks?: string }>();
    const doIds = Array.isArray(body.doIds)
      ? [...new Set(body.doIds.filter((x) => typeof x === "string" && x))]
      : [];
    if (doIds.length === 0) {
      return c.json({ success: false, error: "Select at least one delivery order." }, 400);
    }

    // Validate the DOs exist (in this org) and gather their unit/volume totals.
    const ph = doIds.map(() => "?").join(",");
    const doRes = await c.var.DB.prepare(
      `SELECT id, doNo, totalItems, totalM3 FROM delivery_orders WHERE id IN (${ph}) AND orgId = ?`,
    )
      .bind(...doIds, orgId)
      .all<{ id: string; doNo: string; totalItems: number; totalM3: number | string }>();
    const found = doRes.results ?? [];
    if (found.length !== doIds.length) {
      return c.json(
        { success: false, error: "Some selected delivery orders no longer exist." },
        400,
      );
    }

    // Business rule: a DO can belong to only ONE packing list. Scan existing.
    const existing = await c.var.DB.prepare(
      "SELECT packing_no, do_ids FROM packing_lists WHERE org_id = ?",
    )
      .bind(orgId)
      .all<{ packing_no: string; do_ids: string }>();
    const usedBy = new Map<string, string>(); // doId -> packingNo
    for (const row of existing.results ?? []) {
      for (const did of parseIds(row.do_ids)) usedBy.set(did, row.packing_no);
    }
    const conflictIds = doIds.filter((d) => usedBy.has(d));
    if (conflictIds.length > 0) {
      const labels = found
        .filter((f) => conflictIds.includes(f.id))
        .map((f) => `${f.doNo} (already in ${usedBy.get(f.id)})`);
      return c.json(
        {
          success: false,
          error: `These delivery orders are already in another packing list: ${labels.join(", ")}. Remove them from that list first.`,
        },
        400,
      );
    }

    const stopCount = doIds.length;
    const totalUnits = found.reduce((s, f) => s + (Number(f.totalItems) || 0), 0);
    const totalM3 = found.reduce((s, f) => s + (Number(f.totalM3) || 0), 0);
    const id = `pl-${crypto.randomUUID().slice(0, 8)}`;
    const packingNo = await genNextPackingNo(c.var.DB, orgId);
    const now = new Date().toISOString();
    const remarks = (body.remarks || "").trim() || null;

    await c.var.DB.prepare(
      `INSERT INTO packing_lists (id, packing_no, status, do_ids, stop_count, total_units, total_m3, remarks, created_at, created_by, org_id)
       VALUES (?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        packingNo,
        JSON.stringify(doIds),
        stopCount,
        totalUnits,
        totalM3,
        remarks,
        now,
        null,
        orgId,
      )
      .run();

    await emitAudit(c, {
      resource: "packing-lists",
      resourceId: id,
      action: "create",
      after: { packingNo, doIds, stopCount, totalUnits, totalM3 },
    }).catch(() => {});

    const created = await c.var.DB.prepare(
      `SELECT ${SELECT_COLS} FROM packing_lists WHERE id = ?`,
    )
      .bind(id)
      .first<PackingListRow>();
    return c.json({ success: true, data: created ? rowToPackingList(created) : null }, 201);
  } catch (e) {
    if (isMissingTable(e)) {
      return c.json(
        { success: false, error: "Packing list storage is not set up yet. Apply migration 0139." },
        503,
      );
    }
    return c.json(
      { success: false, error: e instanceof Error ? e.message : "Invalid request body" },
      400,
    );
  }
});

// DELETE /:id — remove a packing list (frees its DOs to be re-grouped).
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "delivery-orders", "delete");
  if (denied) return denied;
  const orgId = getOrgId(c);
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT id FROM packing_lists WHERE id = ? AND org_id = ?",
  )
    .bind(id, orgId)
    .first<{ id: string }>();
  if (!existing) return c.json({ success: false, error: "Packing list not found." }, 404);
  await c.var.DB.prepare("DELETE FROM packing_lists WHERE id = ? AND org_id = ?")
    .bind(id, orgId)
    .run();
  await emitAudit(c, {
    resource: "packing-lists",
    resourceId: id,
    action: "delete",
  }).catch(() => {});
  return c.json({ success: true });
});

export default app;
