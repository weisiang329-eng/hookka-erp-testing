// ---------------------------------------------------------------------------
// public-do-qr.ts — PUBLIC (no-login) QR dispatch/deliver flow for Delivery
// Orders and Packing Lists.
//
// A driver scans the QR printed on a DO or PL with a normal phone camera.
// The QR encodes /d/<token>; that page calls:
//
//   GET  /api/public/do-qr/:token          → minimal document summary
//   POST /api/public/do-qr/:token/advance  → { action: "DISPATCH"|"DELIVER" }
//
// Security model (the token IS the credential):
//   • qrtoken is 64 random hex chars (two UUIDs, migration 0167), minted
//     lazily by the AUTHED /:id/qr-token endpoints only — this route never
//     creates tokens.
//   • Forward-only: DISPATCH moves DRAFT → LOADED, DELIVER moves
//     LOADED/IN_TRANSIT → DELIVERED. Nothing else. No reversals, no edits.
//   • Idempotent: re-scanning after the step is done reports "already
//     dispatched/delivered" per DO instead of erroring.
//   • Minimal exposure: doNo, customer name, delivery area/state, item
//     count + first few product names, status. NO prices, NO addresses
//     beyond the area, NO contact details.
//   • Auth bypass is via PUBLIC_PREFIXES ("/api/public/do-qr/") in
//     lib/auth-middleware.ts; the shared apiRateLimit middleware still
//     applies (keyed by client IP) with a tightened override in
//     lib/api-rate-limit-config.ts.
//
// Cascade reuse (career-critical): the transition is performed by
// applyDeliveryOrderUpdate — the EXACT function behind the office
// PUT /api/delivery-orders/:id — so fg_units stamping, STOCK_OUT movements,
// SO status cascade, FIFO COGS, the auto-DRAFT invoice (+ collision retry)
// and the audit emit all fire identically to an office click. After a
// successful transition the SAME customer notice the office fires is queued
// via queueDoCustomerNotice (dispatch notice / invoice notice with the
// server-rendered PDF fallback). NOTHING is reimplemented here.
//
// Scanning a PL transitions ALL its member DOs together (sequentially, one
// at a time — same rule as the office bulk buttons: parallel DELIVERED
// batches deadlock on shared SO rows and collide on invoice numbers).
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../worker";
import { ensureQrTokenColumns } from "../lib/do-qr-token";
import {
  applyDeliveryOrderUpdate,
  queueDoCustomerNotice,
  ensureDeliveryIncompleteColumn,
  loadProductM3Map,
  loadHubStateMap,
  loadServiceOrderHubMeta,
} from "./delivery-orders";
import {
  poReadyForDelivery,
  type PipelineJobCard,
  type PipelinePO,
} from "../../lib/delivery-pipeline";
import {
  createDeliveryReturnRecord,
  loadDoItemsForReturn,
} from "../lib/delivery-return-create";
import { resolveStateCode } from "../../lib/malaysia-states";

const app = new Hono<Env>();

// Tokens are 64 hex chars. Reject anything else before touching the DB —
// fast 404 for junk paths and no way to probe with empty/odd values.
const TOKEN_RE = /^[0-9a-f]{64}$/i;

const unknownToken = (c: Context<Env>) =>
  c.json(
    {
      success: false,
      error:
        "Unknown or expired QR code. Please ask the Hookka office for a freshly printed copy.",
    },
    404,
  );

type PublicDoRow = {
  id: string;
  doNo: string;
  customerName: string | null;
  customerState: string | null;
  hubName: string | null;
  status: string;
  totalItems: number | null;
  orgId: string | null;
  delivery_incomplete: number | null;
};

// Minimal per-DO summary — the ONLY fields the public page ever sees.
type PublicDoSummary = {
  id: string;
  doNo: string;
  customerName: string;
  area: string;
  status: string;
  itemCount: number;
  productNames: string[];
  // Delivered "with issues" — goods arrived but paperwork incomplete, invoice
  // on hold. Lets the scan page badge it instead of plain "Delivered".
  incomplete: boolean;
};

const DO_SUMMARY_COLS =
  "id, doNo, customerName, customerState, hubName, status, totalItems, orgId, delivery_incomplete";

async function summarizeDos(
  db: D1Database,
  rows: PublicDoRow[],
): Promise<PublicDoSummary[]> {
  if (rows.length === 0) return [];
  const ph = rows.map(() => "?").join(",");
  const itemsRes = await db
    .prepare(
      `SELECT deliveryOrderId, productName, quantity
         FROM delivery_order_items WHERE deliveryOrderId IN (${ph})`,
    )
    .bind(...rows.map((r) => r.id))
    .all<{
      deliveryOrderId: string;
      productName: string | null;
      quantity: number | null;
    }>();
  const byDo = new Map<string, { names: string[]; count: number }>();
  for (const it of itemsRes.results ?? []) {
    const slot = byDo.get(it.deliveryOrderId) ?? { names: [], count: 0 };
    slot.count += Number(it.quantity) || 0;
    const name = (it.productName || "").trim();
    if (name && slot.names.length < 3 && !slot.names.includes(name)) {
      slot.names.push(name);
    }
    byDo.set(it.deliveryOrderId, slot);
  }
  return rows.map((r) => {
    const slot = byDo.get(r.id);
    return {
      id: r.id,
      doNo: r.doNo,
      customerName: r.customerName ?? "",
      area: (r.customerState || "").trim() || (r.hubName || "").trim() || "",
      status: r.status,
      itemCount: slot?.count || Number(r.totalItems) || 0,
      productNames: slot?.names ?? [],
      incomplete: !!Number(r.delivery_incomplete),
    };
  });
}

// Resolve a token against BOTH tables. DOs first (the more common scan),
// then packing lists; the PL branch also loads its member DOs in the
// operator's stored selection order.
async function resolveToken(
  db: D1Database,
  token: string,
): Promise<
  | { kind: "DO"; dos: PublicDoRow[]; pl: null }
  | {
      kind: "PL";
      dos: PublicDoRow[];
      pl: { id: string; packingNo: string; orgId: string | null };
    }
  | null
> {
  await ensureQrTokenColumns(db);
  await ensureDeliveryIncompleteColumn(db);
  const doRow = await db
    .prepare(`SELECT ${DO_SUMMARY_COLS} FROM delivery_orders WHERE qrtoken = ?`)
    .bind(token)
    .first<PublicDoRow>();
  if (doRow) return { kind: "DO", dos: [doRow], pl: null };

  let plRow: {
    id: string;
    packingNo: string;
    doIds: string;
    orgId: string | null;
  } | null = null;
  try {
    plRow = await db
      .prepare(
        "SELECT id, packing_no, do_ids, org_id FROM packing_lists WHERE qrtoken = ?",
      )
      .bind(token)
      .first<{
        id: string;
        packingNo: string;
        doIds: string;
        orgId: string | null;
      }>();
  } catch {
    // packing_lists table not migrated yet — treat as no match.
  }
  if (!plRow) return null;

  let doIds: string[] = [];
  try {
    const v = JSON.parse(plRow.doIds || "[]");
    doIds = Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    doIds = [];
  }
  let dos: PublicDoRow[] = [];
  if (doIds.length > 0) {
    const ph = doIds.map(() => "?").join(",");
    const res = await db
      .prepare(
        `SELECT ${DO_SUMMARY_COLS} FROM delivery_orders WHERE id IN (${ph})`,
      )
      .bind(...doIds)
      .all<PublicDoRow>();
    const order = new Map(doIds.map((d, i) => [d, i]));
    dos = (res.results ?? []).sort(
      (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    );
  }
  return {
    kind: "PL",
    dos,
    pl: { id: plRow.id, packingNo: plRow.packingNo, orgId: plRow.orgId },
  };
}

// Shared payload builder so GET and POST return the same summary shape.
async function buildSummaryPayload(
  db: D1Database,
  resolved: NonNullable<Awaited<ReturnType<typeof resolveToken>>>,
) {
  const dos = await summarizeDos(db, resolved.dos);
  if (resolved.kind === "DO") {
    return { kind: "DO" as const, dos };
  }
  return {
    kind: "PL" as const,
    packingNo: resolved.pl.packingNo,
    plId: resolved.pl.id,
    dos,
  };
}

// ---------------------------------------------------------------------------
// Item-edit model (Wei Siang 2026-06-15) — the public scan page can adjust
// which items ride on the lorry BEFORE dispatch (DRAFT only), "就跟 delivered
// 一样" (normal-camera scan, no login). To keep the token the ONLY credential
// while still allowing edits, the SERVER owns the trusted item set: the page
// may KEEP any of the DO's current items and ADD any production order that is
// independently deliverable for the SAME customer + hub (ready, not already on
// another DO). The page sends back only a list of production-order ids; the
// server rebuilds the items from this trusted model, so a tampered payload can
// never inject another customer's goods or a wrong volume.
//
// Single-DO tokens only (a packing-list token spans many DOs — no item edit).
// ---------------------------------------------------------------------------
type EditItem = {
  productionOrderId: string;
  poNo: string;
  productCode: string;
  productName: string;
  sizeLabel: string;
  fabricCode: string;
  quantity: number;
  itemM3: number;
  rackingNumber: string;
  packingStatus: string;
  salesOrderNo: string;
  // Per-line customer PO — the SCAN list must sort EXACTLY like the printed DO
  // (customer PO asc, then SO; see compareDoLinesByCustomerPO). Derived from the
  // line's sales order (by SO no.), mirroring the office DO detail builder.
  customerPOId: string;
};

type DoEditModel = {
  doId: string;
  doNo: string;
  status: string;
  customerName: string;
  area: string;
  editable: boolean;
  items: EditItem[];
  addable: EditItem[];
  // Union of production-order ids the page is allowed to dispatch with, each
  // mapped to its server-built item (current items ∪ addable POs).
  allowedById: Map<string, EditItem>;
};

async function loadDoEditModel(
  db: D1Database,
  doId: string,
): Promise<DoEditModel | null> {
  const doRow = await db
    .prepare(
      `SELECT id, doNo, status, customerId, hubId, orgId, customerName,
              customerState, hubName
         FROM delivery_orders WHERE id = ?`,
    )
    .bind(doId)
    .first<{
      id: string;
      doNo: string;
      status: string;
      customerId: string | null;
      hubId: string | null;
      orgId: string | null;
      customerName: string | null;
      customerState: string | null;
      hubName: string | null;
    }>();
  if (!doRow) return null;

  const area =
    (doRow.customerState || "").trim() || (doRow.hubName || "").trim() || "";
  const status = (doRow.status || "").toUpperCase();
  // Items can only be re-arranged before the lorry leaves (DRAFT). After
  // dispatch the set is frozen (fg_units already stamped LOADED + STOCK_OUT).
  const editable = status === "DRAFT";

  // ── Current items on the DO (shown ticked = "on the lorry") ────────────
  const curRes = await db
    .prepare(
      `SELECT productionOrderId, poNo, productCode, productName, sizeLabel,
              fabricCode, quantity, itemM3, rackingNumber, packingStatus, salesOrderNo
         FROM delivery_order_items WHERE deliveryOrderId = ?`,
    )
    .bind(doId)
    .all<{
      productionOrderId: string | null;
      poNo: string | null;
      productCode: string | null;
      productName: string | null;
      sizeLabel: string | null;
      fabricCode: string | null;
      quantity: number | null;
      itemM3: number | null;
      rackingNumber: string | null;
      packingStatus: string | null;
      salesOrderNo: string | null;
    }>();
  const curRows = curRes.results ?? [];
  const productCodes: Array<string | null> = curRows.map((r) => r.productCode);

  // ── Addable: ready POs for the same customer + state, not yet on any DO ─
  // Mirrors the office "Available Production Orders" picker: same customer +
  // same STATE; the one-hub guard in validateDoComposition is the dispatch-time
  // safety net. IMPORTANT: production_orders has NO customerId column, so the
  // customer + hub are derived from the PO's sales order (salesOrderId →
  // sales_orders) or service order (serviceOrderId → service_orders), the same
  // canonical resolution validateDoComposition uses. (The previous version
  // filtered on a non-existent production_orders.customerId, which threw → the
  // "Could not load this delivery for editing" 500.)
  let addable: EditItem[] = [];
  if (editable && doRow.customerId && doRow.orgId) {
    // Candidate POs: non-cancelled, NOT already on a (non-cancelled) DO. The
    // NOT EXISTS bounds the set to undelivered POs (so this stays light even on
    // a big org / high-latency DB).
    const candRes = await db
      .prepare(
        `SELECT * FROM production_orders po
          WHERE po.orgId = ? AND po.status != 'CANCELLED'
            AND NOT EXISTS (
              SELECT 1 FROM delivery_order_items di
              JOIN delivery_orders d ON d.id = di.deliveryOrderId
              WHERE di.productionOrderId = po.id AND d.status != 'CANCELLED'
            )`,
      )
      .bind(doRow.orgId)
      .all<Record<string, unknown>>();
    const cands = candRes.results ?? [];

    if (cands.length > 0) {
      // Resolve each candidate's customer + hub from its SO / service order.
      const soIds = [
        ...new Set(
          cands.map((r) => String((r.salesOrderId as string) ?? "")).filter(Boolean),
        ),
      ];
      const svcIds = [
        ...new Set(
          cands.map((r) => String((r.serviceOrderId as string) ?? "")).filter(Boolean),
        ),
      ];
      const soMeta = new Map<string, { customerId: string | null; hubId: string | null }>();
      if (soIds.length > 0) {
        const ph = soIds.map(() => "?").join(",");
        const soRes = await db
          .prepare(`SELECT id, customerId, hubId FROM sales_orders WHERE id IN (${ph})`)
          .bind(...soIds)
          .all<{ id: string; customerId: string | null; hubId: string | null }>();
        for (const r of soRes.results ?? []) {
          soMeta.set(r.id, { customerId: r.customerId, hubId: r.hubId });
        }
      }
      const svcMeta =
        svcIds.length > 0 ? await loadServiceOrderHubMeta(db, svcIds) : new Map();
      const custOf = (r: Record<string, unknown>): string | null => {
        const so = soMeta.get(String((r.salesOrderId as string) ?? ""));
        if (so?.customerId) return so.customerId;
        const sv = svcMeta.get(String((r.serviceOrderId as string) ?? ""));
        return sv?.customerId ?? null;
      };
      const hubOf = (r: Record<string, unknown>): string | null => {
        const so = soMeta.get(String((r.salesOrderId as string) ?? ""));
        if (so?.hubId) return so.hubId;
        const sv = svcMeta.get(String((r.serviceOrderId as string) ?? ""));
        return sv?.hubId ?? null;
      };

      // Same-customer gate (the real one). Then same-state via the hub.
      const sameCust = cands.filter((r) => custOf(r) === doRow.customerId);
      const hubStateMap = await loadHubStateMap(db, [
        doRow.hubId,
        ...sameCust.map(hubOf),
      ]);
      const doState = resolveStateCode(
        (doRow.hubId ? hubStateMap.get(doRow.hubId) : null) ||
          doRow.customerState ||
          null,
      );
      const candAfterState = sameCust.filter((r) => {
        if (doState === null) return true;
        const h = hubOf(r);
        const st = resolveStateCode((h ? hubStateMap.get(h) : null) || null);
        // Unknown candidate state → keep (validateDoComposition is the
        // dispatch-time safety net); only drop a KNOWN different state.
        return st === null || st === doState;
      });
      const candIds = candAfterState
        .map((r) => String((r.id as string) ?? ""))
        .filter(Boolean);

      if (candIds.length > 0) {
        const ph = candIds.map(() => "?").join(",");
        const jcRes = await db
          .prepare(
            `SELECT productionOrderId, departmentCode, status, wipType, completedDate
               FROM job_cards WHERE productionOrderId IN (${ph})`,
          )
          .bind(...candIds)
          .all<{
            productionOrderId: string | null;
            departmentCode: string | null;
            status: string | null;
            wipType: string | null;
            completedDate: string | null;
          }>();
        const jcByPo = new Map<string, PipelineJobCard[]>();
        for (const j of jcRes.results ?? []) {
          if (!j.productionOrderId) continue;
          const list = jcByPo.get(j.productionOrderId) ?? [];
          list.push({
            departmentCode: j.departmentCode ?? "",
            status: j.status ?? "",
            completedDate: j.completedDate,
            wipType: j.wipType ?? "",
          });
          jcByPo.set(j.productionOrderId, list);
        }
        // The NOT EXISTS already removed on-DO POs, so linkedPOIds is empty.
        const linkedPOIds = new Set<string>();
        const readyCands = candAfterState.filter((r) => {
          const id = String((r.id as string) ?? "");
          if (!id) return false;
          const po: PipelinePO = {
            id,
            status: String((r.status as string) ?? ""),
            consignmentOrderId:
              (r.consignmentOrderId as string) ??
              (r.consignmentorderid as string) ??
              undefined,
            itemCategory: (r.itemCategory as string) ?? undefined,
            specialOrder: (r.specialOrder as string) ?? undefined,
            repairScope:
              (r.repairScope as string) ?? (r.repairscope as string) ?? null,
            jobCards: jcByPo.get(id) ?? [],
          };
          return poReadyForDelivery(po, linkedPOIds);
        });

        productCodes.push(
          ...readyCands.map((r) => (r.productCode as string) ?? ""),
        );
        addable = readyCands.map((r) => ({
          productionOrderId: String((r.id as string) ?? ""),
          poNo: (r.poNo as string) ?? "",
          productCode: (r.productCode as string) ?? "",
          productName: (r.productName as string) ?? "",
          sizeLabel: (r.sizeLabel as string) ?? "",
          fabricCode: (r.fabricCode as string) ?? "",
          quantity: Number(r.quantity) || 0,
          itemM3: 0, // backfilled below once every product code is known
          rackingNumber: (r.rackingNumber as string) ?? "",
          packingStatus: "PACKED",
          salesOrderNo:
            (r.companySOId as string) ?? (r.companysoid as string) ?? "",
          customerPOId: "", // backfilled below once SO→PO is resolved
        }));
      }
    }
  }

  // One product→unitM3 read for both lists (the office read path's helper).
  const m3Map = await loadProductM3Map(db, productCodes);

  // Per-line customer PO → so the SCAN list sorts EXACTLY like the printed DO.
  // The office derives each line's customer PO from its sales order (joined by
  // SO no.; delivery-orders.ts ~4395). Mirror that here with one batched read
  // covering both current + addable lines, keyed by SO no. (companySOId).
  const soNosForPo = [
    ...new Set(
      [
        ...curRows.map((r) => (r.salesOrderNo ?? "").trim()),
        ...addable.map((a) => (a.salesOrderNo ?? "").trim()),
      ].filter(Boolean),
    ),
  ];
  const poBySoNo = new Map<string, string>();
  if (soNosForPo.length > 0) {
    const ph = soNosForPo.map(() => "?").join(",");
    const poRes = await db
      .prepare(
        `SELECT companySOId, customerPOId FROM sales_orders
          WHERE orgId = ? AND companySOId IN (${ph})`,
      )
      .bind(doRow.orgId, ...soNosForPo)
      .all<{ companySOId: string | null; customerPOId: string | null }>();
    for (const r of poRes.results ?? []) {
      if (r.companySOId)
        poBySoNo.set(r.companySOId, (r.customerPOId ?? "").trim());
    }
  }
  const poOf = (soNo: string | null | undefined): string =>
    poBySoNo.get((soNo ?? "").trim()) ?? "";

  const items: EditItem[] = curRows.map((r) => ({
    productionOrderId: r.productionOrderId ?? "",
    poNo: r.poNo ?? "",
    productCode: r.productCode ?? "",
    productName: r.productName ?? "",
    sizeLabel: r.sizeLabel ?? "",
    fabricCode: r.fabricCode ?? "",
    quantity: Number(r.quantity) || 0,
    itemM3: Number(r.itemM3) || m3Map.get(r.productCode ?? "") || 0,
    rackingNumber: r.rackingNumber ?? "",
    packingStatus: r.packingStatus || "PACKED",
    salesOrderNo: r.salesOrderNo ?? "",
    customerPOId: poOf(r.salesOrderNo),
  }));
  addable = addable.map((a) => ({
    ...a,
    itemM3: m3Map.get(a.productCode) || 0,
    customerPOId: poOf(a.salesOrderNo),
  }));

  const allowedById = new Map<string, EditItem>();
  for (const it of items) {
    if (it.productionOrderId) allowedById.set(it.productionOrderId, it);
  }
  for (const a of addable) {
    if (a.productionOrderId) allowedById.set(a.productionOrderId, a);
  }

  return {
    doId: doRow.id,
    doNo: doRow.doNo,
    status,
    customerName: doRow.customerName ?? "",
    area,
    editable,
    items,
    addable,
    allowedById,
  };
}

// GET /api/public/do-qr/:token/edit — DRAFT-only item editor model. Works for
// BOTH a single DO scan and a packing-list scan: returns one edit model per
// member DO (its current items = tick to keep on the lorry, plus the addable
// ready POs for the same customer + hub = tick to add to this trip). A PL with
// two DOs returns two entries so the phone can show + edit each (Wei Siang
// 2026-06-15: "扫 Packing List 也显示对应的 DO 及明细,第二张也显示").
app.get("/:token/edit", async (c) => {
  const token = (c.req.param("token") || "").trim();
  if (!TOKEN_RE.test(token)) return unknownToken(c);
  try {
    const resolved = await resolveToken(c.var.DB, token);
    if (!resolved) return unknownToken(c);
    if (resolved.dos.length === 0) {
      return c.json(
        { success: false, error: "This code has no delivery orders." },
        409,
      );
    }
    const models = await Promise.all(
      resolved.dos.map((d) => loadDoEditModel(c.var.DB, d.id)),
    );
    const dos = models
      .filter((m): m is DoEditModel => !!m)
      .map((m) => ({
        doId: m.doId,
        doNo: m.doNo,
        status: m.status,
        customerName: m.customerName,
        area: m.area,
        editable: m.editable,
        items: m.items,
        addable: m.addable,
      }));
    if (dos.length === 0) return unknownToken(c);
    return c.json({
      success: true,
      data: {
        kind: resolved.kind,
        ...(resolved.kind === "PL" ? { packingNo: resolved.pl.packingNo } : {}),
        dos,
      },
    });
  } catch (err) {
    console.error("[GET /api/public/do-qr/:token/edit] failed:", err);
    return c.json(
      {
        success: false,
        error: "Could not load this delivery for editing. Please try again.",
      },
      500,
    );
  }
});

// GET /api/public/do-qr/:token — document summary for the scan page.
app.get("/:token", async (c) => {
  const token = (c.req.param("token") || "").trim();
  if (!TOKEN_RE.test(token)) return unknownToken(c);
  try {
    const resolved = await resolveToken(c.var.DB, token);
    if (!resolved) return unknownToken(c);
    const data = await buildSummaryPayload(c.var.DB, resolved);
    return c.json({ success: true, data });
  } catch (err) {
    console.error("[GET /api/public/do-qr/:token] failed:", err);
    return c.json(
      { success: false, error: "Could not load this document. Please try again." },
      500,
    );
  }
});

// Forward-only step table. DISPATCH = the office "Mark Dispatched" button
// (DRAFT → LOADED); DELIVER = the office "Mark Delivered" button
// (LOADED / IN_TRANSIT → DELIVERED). Statuses already past the step are
// idempotent skips; anything else (DRAFT on DELIVER, CANCELLED) is blocked.
const STEP: Record<
  "DISPATCH" | "DELIVER",
  { from: string[]; to: "LOADED" | "DELIVERED"; past: string[]; kind: "DISPATCHED" | "DELIVERED" }
> = {
  DISPATCH: {
    from: ["DRAFT"],
    to: "LOADED",
    past: ["LOADED", "IN_TRANSIT", "DELIVERED", "INVOICED"],
    kind: "DISPATCHED",
  },
  DELIVER: {
    from: ["LOADED", "IN_TRANSIT"],
    to: "DELIVERED",
    past: ["DELIVERED", "INVOICED"],
    kind: "DELIVERED",
  },
};

type AdvanceResult = {
  doNo: string;
  outcome: "DONE" | "SKIPPED" | "BLOCKED" | "FAILED";
  from: string;
  to?: string;
  note?: string;
};

// POST /api/public/do-qr/:token/advance — perform the one forward step.
app.post("/:token/advance", async (c) => {
  const token = (c.req.param("token") || "").trim();
  if (!TOKEN_RE.test(token)) return unknownToken(c);

  const body = (await c.req.json().catch(() => ({}))) as {
    action?: string;
    incomplete?: boolean;
    // The 2nd scan is a clean either/or: the customer received the goods
    // (DELIVER) or did NOT (returnGoods → the whole DO comes back). On
    // returnGoods we mark the DO delivered so the fg_units/COGS cascade runs
    // (nothing to reconcile if it never delivered), WITHHOLD the invoice +
    // customer notice, and open a Delivery Return covering every line — the
    // office then decides restock / repair-&-redeliver / credit note.
    returnGoods?: boolean;
    // Optional edited item set for a DISPATCH — "adjust what's on the lorry,
    // then dispatch". `edits` maps each DO id to the production-order ids that
    // ride the lorry (works for a single DO or every DO under a packing list).
    // `poIds` is the single-DO shorthand kept for backward-compat.
    edits?: unknown;
    poIds?: unknown;
  };
  const action =
    body.action === "DISPATCH" || body.action === "DELIVER"
      ? body.action
      : null;
  if (!action) {
    return c.json(
      { success: false, error: 'action must be "DISPATCH" or "DELIVER"' },
      400,
    );
  }
  // Customer did not receive — only meaningful on the deliver step.
  const returnGoods = action === "DELIVER" && body.returnGoods === true;
  // Both "returned" and the legacy "incomplete" flag withhold the invoice +
  // customer notice; the goods are still marked delivered (fg_units/COGS
  // cascade) so a later Delivery Return can cleanly reverse them.
  const incomplete =
    action === "DELIVER" && (body.incomplete === true || returnGoods);

  try {
    const resolved = await resolveToken(c.var.DB, token);
    if (!resolved) return unknownToken(c);
    if (resolved.dos.length === 0) {
      return c.json(
        { success: false, error: "This packing list has no delivery orders." },
        409,
      );
    }

    // Edited dispatch: the page sends, per DO, the production-order ids that
    // ride the lorry. Rebuild the items from the SERVER's trusted edit model
    // (current items ∪ same-customer/hub ready POs) so a tampered payload can
    // never inject another customer's goods or a wrong volume. Works for a
    // single DO (`poIds` shorthand) or every DO under a packing list (`edits`
    // map). Ignored for DELIVER. In edit mode only the DOs the user kept items
    // on are dispatched — a DO fully unticked is left DRAFT for the next trip.
    let editsByDo: Map<string, EditItem[]> | null = null;
    if (action === "DISPATCH") {
      const editsInput: Record<string, unknown> | null =
        body.edits && typeof body.edits === "object" && !Array.isArray(body.edits)
          ? (body.edits as Record<string, unknown>)
          : Array.isArray(body.poIds) && resolved.dos.length === 1
            ? { [resolved.dos[0].id]: body.poIds }
            : null;
      if (editsInput) {
        editsByDo = new Map();
        for (const [doId, rawIds] of Object.entries(editsInput)) {
          if (!resolved.dos.some((d) => d.id === doId)) {
            return c.json(
              {
                success: false,
                error: "An edited delivery order is not on this code.",
              },
              400,
            );
          }
          const model = await loadDoEditModel(c.var.DB, doId);
          if (!model) return unknownToken(c);
          if (!model.editable) {
            return c.json(
              {
                success: false,
                error:
                  "This delivery can no longer be edited (already dispatched).",
              },
              409,
            );
          }
          const requested = [
            ...new Set(
              (Array.isArray(rawIds) ? rawIds : [])
                .map((x) => (typeof x === "string" ? x : ""))
                .filter(Boolean),
            ),
          ];
          if (requested.length === 0) {
            return c.json(
              {
                success: false,
                error: `Pick at least one item to dispatch for ${model.doNo}.`,
              },
              400,
            );
          }
          const built: EditItem[] = [];
          for (const poId of requested) {
            const it = model.allowedById.get(poId);
            if (!it) {
              return c.json(
                {
                  success: false,
                  error:
                    "One of the chosen items is no longer available. Please reload and try again.",
                },
                409,
              );
            }
            built.push(it);
          }
          editsByDo.set(doId, built);
        }
      }
    }

    const step = STEP[action];
    const results: AdvanceResult[] = [];
    for (const d of resolved.dos) {
      const from = (d.status || "").toUpperCase();
      // Edit mode: only dispatch the DOs the user kept items on. A DRAFT DO not
      // in the edits map (everything unticked) is intentionally held for a
      // later trip — skip it instead of dispatching its original contents.
      if (editsByDo && !editsByDo.has(d.id) && from === "DRAFT") {
        results.push({
          doNo: d.doNo,
          outcome: "SKIPPED",
          from,
          note: "Not loaded this trip",
        });
        continue;
      }
      if (step.past.includes(from)) {
        results.push({
          doNo: d.doNo,
          outcome: "SKIPPED",
          from,
          note:
            action === "DISPATCH" ? "Already dispatched" : "Already delivered",
        });
        continue;
      }
      if (!step.from.includes(from)) {
        results.push({
          doNo: d.doNo,
          outcome: "BLOCKED",
          from,
          note:
            action === "DELIVER" && from === "DRAFT"
              ? "Not dispatched yet"
              : `Cannot ${action === "DISPATCH" ? "dispatch" : "deliver"} from ${from}`,
        });
        continue;
      }

      // The DELIVERED cascade reads getOrgId(c) for the invoice ledger
      // legs. There is no session on this route, so stash the DO row's own
      // orgId (the token resolved to this exact row — no cross-tenant
      // reach). Same context-stash cast tenantMiddleware uses.
      const orgId = d.orgId || resolved.pl?.orgId || null;
      if (!orgId) {
        results.push({
          doNo: d.doNo,
          outcome: "FAILED",
          from,
          note: "Document has no organisation",
        });
        continue;
      }
      (c as unknown as { set: (k: string, v: unknown) => void }).set(
        "orgId",
        orgId,
      );

      // THE office transition path — identical guards + cascades. On a
      // "with issues" deliver, deliveryIncomplete withholds the invoice.
      const editedItems = editsByDo?.get(d.id) ?? null;
      const res = await applyDeliveryOrderUpdate(c, d.id, {
        status: step.to,
        ...(incomplete ? { deliveryIncomplete: true } : {}),
        ...(editedItems ? { items: editedItems } : {}),
      });
      let ok = false;
      let errMsg = "";
      try {
        const j = (await res.json()) as { success?: boolean; error?: string };
        ok = res.ok && !!j?.success;
        errMsg = j?.error || "";
      } catch {
        ok = res.ok;
      }
      if (!ok) {
        results.push({
          doNo: d.doNo,
          outcome: "FAILED",
          from,
          note: errMsg || `HTTP ${res.status}`,
        });
        continue;
      }
      results.push({ doNo: d.doNo, outcome: "DONE", from, to: step.to });

      // Customer did not receive → open a Delivery Return for the WHOLE DO so
      // the office can restock / repair-&-redeliver / raise a credit note.
      // Best-effort: the delivery itself is already committed; a DR hiccup must
      // not fail the scan (the office can still "Convert to Delivery Return"
      // from the DO). No item picking — every line on the DO comes back.
      if (returnGoods) {
        try {
          const drItems = await loadDoItemsForReturn(c.var.DB, d.id);
          if (drItems.length > 0) {
            await createDeliveryReturnRecord(c.var.DB, orgId, {
              doId: d.id,
              items: drItems,
              reason: "Customer did not receive — returned at delivery",
            });
          }
        } catch (drErr) {
          console.warn(
            `[public-do-qr] ${d.doNo}: delivery return create failed:`,
            drErr instanceof Error ? drErr.message : drErr,
          );
        }
      }

      // Delivered "with issues" / returned → no invoice was created, so there
      // is no invoice notice to send. The office sends it later on resolve.
      // Dispatch notices and complete deliveries fall through to the normal
      // queue.
      if (incomplete) continue;

      // Queue the SAME customer notice the office click queues (dispatch
      // notice / invoice notice). Best-effort — the transition is already
      // committed; a notice hiccup must not fail the scan. The endpoint is
      // idempotent (dispatchEmailAt / deliveredEmailAt claims), so an
      // office re-click later cannot double-send.
      try {
        const noticeRes = await queueDoCustomerNotice(c, d.id, {
          kind: step.kind,
        });
        // Consume the body so the Response doesn't leak.
        await noticeRes.json().catch(() => undefined);
      } catch (noticeErr) {
        console.warn(
          `[public-do-qr] ${d.doNo}: customer notice after ${action} failed:`,
          noticeErr instanceof Error ? noticeErr.message : noticeErr,
        );
      }
    }

    // Fresh summary so the page can re-render the new statuses without a
    // second round-trip.
    const after = await resolveToken(c.var.DB, token);
    const summary = after
      ? await buildSummaryPayload(c.var.DB, after)
      : undefined;

    const tally = {
      done: results.filter((r) => r.outcome === "DONE").length,
      skipped: results.filter((r) => r.outcome === "SKIPPED").length,
      blocked: results.filter((r) => r.outcome === "BLOCKED").length,
      failed: results.filter((r) => r.outcome === "FAILED").length,
    };
    return c.json({ success: true, data: { action, results, ...tally, summary } });
  } catch (err) {
    console.error("[POST /api/public/do-qr/:token/advance] failed:", err);
    return c.json(
      {
        success: false,
        error: "Could not update this delivery. Please try again or contact the Hookka office.",
      },
      500,
    );
  }
});

export default app;
