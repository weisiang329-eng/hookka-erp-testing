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
import { loadDoValueMap } from "../lib/do-value";

const app = new Hono<Env>();

// NOTE: the SupabaseAdapter rewrites SQL identifiers to snake_case on the way
// IN, and returns result rows with camelCase keys on the way OUT (same as the
// delivery-orders route, which reads row.doNo / row.totalItems). So columns are
// snake_case in the SQL strings below, but every result is read as camelCase.
type PackingListRow = {
  id: string;
  packingNo: string;
  status: string;
  doIds: string;
  stopCount: number;
  totalUnits: number;
  totalM3: number | string;
  remarks: string | null;
  createdAt: string | null;
  createdBy: string | null;
  orgId: string;
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

function rowToPackingList(
  r: PackingListRow,
  // Money fields are computed live by the list endpoint (see computePackingListMoney).
  // revenueSen = Σ goods value of the PL's DOs; costSen = the ONE-trip transport
  // cost (null when no 3PL rate is resolvable). Omitted (undefined) by the
  // single-record GET /:id, which doesn't surface money.
  money?: { revenueSen: number; costSen: number | null },
) {
  return {
    id: r.id,
    packingNo: r.packingNo,
    status: r.status,
    doIds: parseIds(r.doIds),
    stopCount: r.stopCount ?? 0,
    totalUnits: r.totalUnits ?? 0,
    totalM3: Number(r.totalM3 ?? 0),
    remarks: r.remarks ?? "",
    createdAt: r.createdAt,
    createdBy: r.createdBy,
    revenueSen: money?.revenueSen ?? 0,
    costSen: money === undefined ? null : money.costSen,
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
    .first<{ packingNo: string }>();
  if (!res || !res.packingNo) return `${prefix}001`;
  const seq = parseInt(res.packingNo.replace(prefix, ""), 10);
  if (!Number.isFinite(seq)) return `${prefix}001`;
  return `${prefix}${String(seq + 1).padStart(3, "0")}`;
}

const SELECT_COLS =
  "id, packing_no, status, do_ids, stop_count, total_units, total_m3, remarks, created_at, created_by, org_id";

// ---------------------------------------------------------------------------
// Live Revenue + Cost for the Packing List list view.
//
// REVENUE per PL = Σ over the PL's DOs of the DO's goods value (the SAME
// per-DO resolver — loadDoValueMap — that feeds the Delivery per-row Amount
// and the DO /stats tab totals, so the PL figure reconciles to the cent).
//
// COST per PL = the ONE TRIP transport cost, mirroring delivery-orders.ts:
//     ratePerTrip + max(0, distinctDrops − 1) × ratePerExtraDrop
//   - distinctDrops = number of DISTINCT delivery addresses across the PL's
//     DOs (trimmed + whitespace-collapsed + lowercased for comparison only).
//     4 DOs to the SAME address = 1 drop ⇒ cost = just ratePerTrip.
//   - Rates come from each DO's 3PL with the SAME precedence delivery-orders.ts
//     uses on write: the assigned VEHICLE (three_pl_vehicles) takes precedence;
//     else the PROVIDER/company (drivers, keyed by the DO's driverId column,
//     which stores the providerId). A PL's DOs normally share one 3PL; if they
//     differ, the 3PL the most DOs share wins (tie → first seen). costSen is
//     null when no rate is resolvable. This is ONE trip per PL — we do NOT sum
//     the per-DO deliveryCostSen (that multiplies the trip rate).
//
// All bulk: one DO read, one loadDoValueMap, one vehicles read, one drivers
// read — no N+1 across packing lists.
// ---------------------------------------------------------------------------
type PlDoRow = {
  id: string;
  deliveryAddress: string | null;
  driverId: string | null; // = providerId (drivers.id) per the 3PL refactor
  vehicleId: string | null;
};
type RatePair = { ratePerTripSen: number; ratePerExtraDropSen: number };

function normAddr(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

async function computePackingListMoney(
  db: D1Database,
  orgId: string,
  lists: { id: string; doIds: string[] }[],
): Promise<Map<string, { revenueSen: number; costSen: number | null }>> {
  const out = new Map<string, { revenueSen: number; costSen: number | null }>();
  // Pre-seed every PL so the caller always gets an entry (revenue 0, cost null).
  for (const l of lists) out.set(l.id, { revenueSen: 0, costSen: null });

  const allDoIds = [...new Set(lists.flatMap((l) => l.doIds))];
  // Always load the value map (org-scoped, used for revenue even if a PL has
  // no resolvable cost). If there are no DOs at all, revenue stays 0 / cost null.
  const valueMap = await loadDoValueMap(db, orgId);
  if (allDoIds.length === 0) {
    for (const l of lists) out.set(l.id, { revenueSen: 0, costSen: null });
    return out;
  }

  // One bulk read of every DO referenced by any PL.
  const ph = allDoIds.map(() => "?").join(",");
  const doRes = await db
    .prepare(
      `SELECT id, deliveryAddress, driverId, vehicleId
         FROM delivery_orders WHERE orgId = ? AND id IN (${ph})`,
    )
    .bind(orgId, ...allDoIds)
    .all<PlDoRow>();
  const doById = new Map<string, PlDoRow>();
  for (const d of doRes.results ?? []) doById.set(d.id, d);

  // Bulk-resolve rates for every distinct vehicle + provider in one read each.
  const vehicleIds = [
    ...new Set(
      (doRes.results ?? [])
        .map((d) => (d.vehicleId || "").trim())
        .filter((x) => x.length > 0),
    ),
  ];
  const providerIds = [
    ...new Set(
      (doRes.results ?? [])
        .map((d) => (d.driverId || "").trim())
        .filter((x) => x.length > 0),
    ),
  ];
  const vehicleRates = new Map<string, RatePair>();
  if (vehicleIds.length > 0) {
    const vph = vehicleIds.map(() => "?").join(",");
    const vRes = await db
      .prepare(
        `SELECT id, ratePerTripSen, ratePerExtraDropSen
           FROM three_pl_vehicles WHERE id IN (${vph})`,
      )
      .bind(...vehicleIds)
      .all<{ id: string; ratePerTripSen: number; ratePerExtraDropSen: number }>();
    for (const v of vRes.results ?? [])
      vehicleRates.set(v.id, {
        ratePerTripSen: Number(v.ratePerTripSen) || 0,
        ratePerExtraDropSen: Number(v.ratePerExtraDropSen) || 0,
      });
  }
  const providerRates = new Map<string, RatePair>();
  if (providerIds.length > 0) {
    const pph = providerIds.map(() => "?").join(",");
    const pRes = await db
      .prepare(
        `SELECT id, ratePerTripSen, ratePerExtraDropSen
           FROM drivers WHERE id IN (${pph})`,
      )
      .bind(...providerIds)
      .all<{ id: string; ratePerTripSen: number; ratePerExtraDropSen: number }>();
    for (const p of pRes.results ?? [])
      providerRates.set(p.id, {
        ratePerTripSen: Number(p.ratePerTripSen) || 0,
        ratePerExtraDropSen: Number(p.ratePerExtraDropSen) || 0,
      });
  }

  // Resolve ONE DO's rate with the write-path precedence: vehicle over provider.
  // Returns a stable key (so we can pick the 3PL the most DOs share) + the rate.
  // A rate pair of 0/0 means "never set in 3PL Maintenance", NOT "free" — a
  // vehicle without rates must fall through to its company's rates instead of
  // masking them (live PLs were showing RM 0.00), and when neither side has
  // rates we return null so the column shows "—" rather than a free trip.
  const hasRate = (r: RatePair): boolean =>
    r.ratePerTripSen > 0 || r.ratePerExtraDropSen > 0;
  const rateForDo = (d: PlDoRow): { key: string; rate: RatePair } | null => {
    const vid = (d.vehicleId || "").trim();
    if (vid) {
      const r = vehicleRates.get(vid);
      if (r && hasRate(r)) return { key: `v:${vid}`, rate: r };
    }
    const pid = (d.driverId || "").trim();
    if (pid) {
      const r = providerRates.get(pid);
      if (r && hasRate(r)) return { key: `p:${pid}`, rate: r };
    }
    return null;
  };

  for (const l of lists) {
    let revenueSen = 0;
    const addrSet = new Set<string>();
    // Tally which 3PL the PL's DOs resolve to; the most common one wins.
    const rateByKey = new Map<string, RatePair>();
    const keyCount = new Map<string, number>();
    const keyOrder: string[] = []; // first-seen order for deterministic ties
    let sawAnyDo = false;

    for (const did of l.doIds) {
      const d = doById.get(did);
      if (!d) continue; // do_id missing — skip gracefully
      sawAnyDo = true;
      revenueSen += valueMap.get(did) ?? 0;
      addrSet.add(normAddr(d.deliveryAddress));
      const resolved = rateForDo(d);
      if (resolved) {
        if (!keyCount.has(resolved.key)) {
          keyOrder.push(resolved.key);
          rateByKey.set(resolved.key, resolved.rate);
        }
        keyCount.set(resolved.key, (keyCount.get(resolved.key) ?? 0) + 1);
      }
    }

    let costSen: number | null = null;
    if (sawAnyDo && keyOrder.length > 0) {
      // Pick the 3PL the most DOs share; tie → first seen.
      let bestKey = keyOrder[0];
      let bestCount = keyCount.get(bestKey) ?? 0;
      for (const k of keyOrder) {
        const cnt = keyCount.get(k) ?? 0;
        if (cnt > bestCount) {
          bestKey = k;
          bestCount = cnt;
        }
      }
      const rate = rateByKey.get(bestKey);
      if (rate) {
        const distinctDrops = addrSet.size; // distinct delivery addresses
        costSen =
          rate.ratePerTripSen +
          Math.max(0, distinctDrops - 1) * rate.ratePerExtraDropSen;
      }
    }

    out.set(l.id, { revenueSen, costSen });
  }
  return out;
}

// GET / — list all packing lists for the org (newest first).
app.get("/", async (c) => {
  const orgId = getOrgId(c);
  try {
    const res = await c.var.DB.prepare(
      `SELECT ${SELECT_COLS} FROM packing_lists WHERE org_id = ? ORDER BY packing_no DESC`,
    )
      .bind(orgId)
      .all<PackingListRow>();
    const rows = res.results ?? [];
    // Compute Revenue + Cost LIVE so the existing PLs also show values.
    const money = await computePackingListMoney(
      c.var.DB,
      orgId,
      rows.map((r) => ({ id: r.id, doIds: parseIds(r.doIds) })),
    );
    const data = rows.map((r) =>
      rowToPackingList(r, money.get(r.id) ?? { revenueSen: 0, costSen: null }),
    );
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

    const doIds = parseIds(pl.doIds);
    // Full DO objects, shaped like the delivery-orders payload, so the
    // frontend can render each one with the SAME canonical DO PDF.
    let orders: unknown[] = [];
    if (doIds.length > 0) {
      const ph = doIds.map(() => "?").join(",");
      const doRes = await c.var.DB.prepare(
        `SELECT id, doNo, customerName, customerPOId, customerState, hubName, deliveryAddress, contactPerson, contactPhone, deliveryDate, dispatchedAt, driverName, driverPhone, vehicleNo, vehicleType, lorryName, totalM3, totalItems
         FROM delivery_orders WHERE id IN (${ph}) AND orgId = ?`,
      )
        .bind(...doIds, orgId)
        .all<{
          id: string;
          doNo: string;
          customerName: string | null;
          customerPOId: string | null;
          customerState: string | null;
          hubName: string | null;
          deliveryAddress: string | null;
          contactPerson: string | null;
          contactPhone: string | null;
          deliveryDate: string | null;
          dispatchedAt: string | null;
          driverName: string | null;
          driverPhone: string | null;
          vehicleNo: string | null;
          vehicleType: string | null;
          lorryName: string | null;
          totalM3: number | string | null;
          totalItems: number | null;
        }>();
      const itemsRes = await c.var.DB.prepare(
        `SELECT id, deliveryOrderId, productionOrderId, poNo, productCode, productName, sizeLabel, fabricCode, quantity, itemM3, rackingNumber, salesOrderNo
         FROM delivery_order_items WHERE deliveryOrderId IN (${ph}) AND orgId = ?`,
      )
        .bind(...doIds, orgId)
        .all<{
          id: string;
          deliveryOrderId: string;
          productionOrderId: string | null;
          poNo: string | null;
          productCode: string | null;
          productName: string | null;
          sizeLabel: string | null;
          fabricCode: string | null;
          quantity: number | null;
          itemM3: number | string | null;
          rackingNumber: string | null;
          salesOrderNo: string | null;
        }>();
      const byDo = new Map<string, unknown[]>();
      for (const it of itemsRes.results ?? []) {
        const arr = (byDo.get(it.deliveryOrderId) as unknown[]) ?? [];
        arr.push({
          id: it.id,
          productionOrderId: it.productionOrderId ?? "",
          poNo: it.poNo ?? "",
          productCode: it.productCode ?? "",
          productName: it.productName ?? "",
          sizeLabel: it.sizeLabel ?? "",
          fabricCode: it.fabricCode ?? "",
          quantity: Number(it.quantity ?? 0),
          itemM3: Number(it.itemM3 ?? 0),
          rackingNumber: it.rackingNumber ?? "",
          salesOrderNo: it.salesOrderNo ?? "",
        });
        byDo.set(it.deliveryOrderId, arr);
      }
      // Preserve the operator's selection order.
      const orderIndex = new Map(doIds.map((d, i) => [d, i]));
      orders = (doRes.results ?? [])
        .sort((a, b) => (orderIndex.get(a.id) ?? 0) - (orderIndex.get(b.id) ?? 0))
        .map((d) => ({
          id: d.id,
          doNo: d.doNo,
          customerName: d.customerName ?? "",
          customerPOId: d.customerPOId ?? "",
          customerState: d.customerState ?? "",
          hubName: d.hubName ?? "",
          deliveryAddress: d.deliveryAddress ?? "",
          contactPerson: d.contactPerson ?? "",
          contactPhone: d.contactPhone ?? "",
          deliveryDate: d.deliveryDate ?? "",
          dispatchedAt: d.dispatchedAt ?? "",
          driverName: d.driverName ?? "",
          driverPhone: d.driverPhone ?? "",
          vehicleNo: d.vehicleNo ?? "",
          vehicleType: d.vehicleType ?? "",
          lorryName: d.lorryName ?? "",
          totalM3: Number(d.totalM3 ?? 0),
          totalItems: Number(d.totalItems ?? 0),
          items: byDo.get(d.id) ?? [],
        }));
    }

    return c.json({ success: true, data: { ...rowToPackingList(pl), orders } });
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
      .all<{ packingNo: string; doIds: string }>();
    const usedBy = new Map<string, string>(); // doId -> packingNo
    for (const row of existing.results ?? []) {
      for (const did of parseIds(row.doIds)) usedBy.set(did, row.packingNo);
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
