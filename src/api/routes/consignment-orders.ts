// ---------------------------------------------------------------------------
// D1-backed Consignment Orders route. Parallel to sales-orders.ts.
//
// CO is structurally a SO clone — same line-item shape (category, divan/leg,
// fabric, pricing breakdown), same lifecycle (DRAFT → CONFIRMED → IN_PRODUCTION
// → SHIPPED → ...), same downstream production pipeline. Only the source
// numbering differs (CO-25001 vs SO-25001) and the terminal states
// (PARTIALLY_SOLD/FULLY_SOLD/RETURNED carried over from the legacy
// consignment-tracking model).
//
// `POST /:id/confirm` is the integration point that triggers production —
// it cascades through `createProductionOrdersForOrder()` (same engine SO
// uses) which writes production_orders rows with consignmentOrderId set
// and salesOrderId NULL.
//
// Sibling file: routes/consignments.ts still handles the legacy
// `consignment_notes` table (lightweight tracking). Once the new UI lands,
// that file will be repurposed for the shipment role (DO equivalent for
// CO) — see PR 3.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import { runSelfApply } from "../lib/self-apply";
import type { Env } from "../worker";
import { createProductionOrdersForOrder } from "./_shared/production-builder";
import {
  snapItemToCatalog,
  loadProductCatalog,
} from "./_shared/item-catalog-snap";
import {
  runSofaComboPass,
  resolveLineBasePriceSen,
  seatHeightOf,
} from "../lib/sofa-combo-pass";
import { checkConsignmentOrderLocked, lockedResponse } from "../lib/lock-helpers";
import { emitAudit, buildAuditStatement } from "../lib/audit";
import { requirePermission } from "../lib/rbac";
import { readIdempotencyKey, withIdempotency } from "../lib/idempotency";
import { getOrgId } from "../lib/tenant";
import {
  invalidateHubChangeSnapshots,
  invalidateOrderCascadeSnapshots,
} from "../lib/snapshot";
import { bumpPoListCacheVersion } from "../lib/po-list-cache";
import { ensureCoStatusChangesTable } from "./production-orders/_helpers";
import {
  consumeEditLockOverrideToken,
  createEditLockOverride,
  lookupActorDisplayName,
  MIN_OVERRIDE_REASON_LEN,
} from "../lib/edit-lock-override";
import {
  validateFabricCodes,
  unknownFabricCodeError,
} from "../lib/fabric-validation";
import {
  validateSofaSizeLabels,
  unknownSofaSizeLabelError,
} from "../lib/sofa-size-validation";
import {
  hasMixedSofaBedframe,
  SO_MIXED_CATEGORY_ERROR,
  findInvalidSofaQty,
  formatSofaQtyError,
} from "../../lib/so-category";

const app = new Hono<Env>();

// ---------------------------------------------------------------------------
// Allowed CO status transitions — mirrors VALID_TRANSITIONS in
// sales-orders.ts but adapted to the CO lifecycle (no SHIPPED step, no
// INVOICED — CN-completion-cascade flips CO to DELIVERED, no manual
// READY_TO_SHIP→DELIVERED PUT path per Wei Siang 2026-05-09).
//
// The legacy header comment mentions PARTIALLY_SOLD/FULLY_SOLD/RETURNED;
// those are CN (consignment_notes) statuses, never set on consignment_orders
// directly. Verified 2026-05-09 by grep `UPDATE consignment_orders SET status`
// across src/api/ — only DRAFT, CONFIRMED, IN_PRODUCTION, READY_TO_SHIP,
// DELIVERED, CLOSED, ON_HOLD, CANCELLED reach a CO row.
//
// Closes DUP-003 in bug_audit_duplicate_logic.md — CO PUT used to accept any
// `body.status` verbatim, while SO has rejected illegal transitions for
// months via VALID_TRANSITIONS at sales-orders.ts:984.
// ---------------------------------------------------------------------------
const CO_VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["CONFIRMED", "IN_PRODUCTION", "CANCELLED"],
  CONFIRMED: ["IN_PRODUCTION", "ON_HOLD", "CANCELLED"],
  IN_PRODUCTION: ["READY_TO_SHIP", "ON_HOLD", "CANCELLED"],
  // READY_TO_SHIP → DELIVERED is NOT allowed via PUT — it must come from
  // cascadeCNCompletionToCO once every CN under the CO is FULLY_SOLD/CLOSED.
  // IN_PRODUCTION is the UPH-rollback target.
  READY_TO_SHIP: ["ON_HOLD", "IN_PRODUCTION"],
  DELIVERED: ["CLOSED"],
  ON_HOLD: ["CONFIRMED", "IN_PRODUCTION", "CANCELLED"],
  CLOSED: [],
  CANCELLED: [],
};

// ---------------------------------------------------------------------------
// Row types — match the consignment_orders / consignment_order_items
// tables created in migration 0064.
// ---------------------------------------------------------------------------
export type ConsignmentOrderRow = {
  id: string;
  customerCO: string | null;
  customerCOId: string | null;
  customerCODate: string | null;
  reference: string | null;
  customerId: string;
  customerName: string;
  customerState: string | null;
  hubId: string | null;
  hubName: string | null;
  companyCO: string | null;
  companyCOId: string | null;
  companyCODate: string | null;
  customerDeliveryDate: string | null;
  hookkaExpectedDD: string | null;
  subtotalSen: number;
  totalSen: number;
  status: string;
  overdue: string | null;
  notes: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  // ON HOLD reason capture (0185) — CO mirror of the SO columns. snake_case
  // hold_reason / held_by / held_at; toCamel exposes them as holdReason /
  // heldBy / heldAt. Dual-keyed on read. NULL when the CO is not on hold.
  holdReason?: string | null;
  hold_reason?: string | null;
  heldBy?: string | null;
  held_by?: string | null;
  heldAt?: string | null;
  held_at?: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ConsignmentOrderItemRow = {
  id: string;
  consignmentOrderId: string;
  lineNo: number;
  lineSuffix: string | null;
  productId: string | null;
  productCode: string | null;
  productName: string | null;
  itemCategory: string | null;
  sizeCode: string | null;
  sizeLabel: string | null;
  fabricCode: string | null;
  quantity: number;
  gapInches: number | null;
  divanHeightInches: number | null;
  divanPriceSen: number;
  legHeightInches: number | null;
  legPriceSen: number;
  specialOrder: string | null;
  specialOrderPriceSen: number;
  basePriceSen: number;
  unitPriceSen: number;
  // Per-line discount (migration 0179). snake_case DB column `discount_sen`
  // mapped via column-rename-map.json → reads back as `discountSen`.
  discountSen: number;
  lineTotalSen: number;
  notes: string | null;
};

function rowToCO(row: ConsignmentOrderRow, items: ConsignmentOrderItemRow[]) {
  return {
    id: row.id,
    customerCO: row.customerCO ?? "",
    customerCOId: row.customerCOId ?? "",
    customerCODate: row.customerCODate ?? "",
    reference: row.reference ?? "",
    customerId: row.customerId,
    customerName: row.customerName,
    customerState: row.customerState ?? "",
    hubId: row.hubId,
    hubName: row.hubName ?? "",
    companyCO: row.companyCO ?? "",
    companyCOId: row.companyCOId ?? "",
    companyCODate: row.companyCODate ?? "",
    customerDeliveryDate: row.customerDeliveryDate ?? "",
    hookkaExpectedDD: row.hookkaExpectedDD ?? "",
    subtotalSen: row.subtotalSen,
    totalSen: row.totalSen,
    status: row.status,
    overdue: row.overdue ?? "PENDING",
    notes: row.notes ?? "",
    cancelledAt: row.cancelledAt ?? null,
    cancellationReason: row.cancellationReason ?? null,
    // ON HOLD reason capture (0185) — dual-key read.
    holdReason: row.holdReason ?? row.hold_reason ?? "",
    heldBy: row.heldBy ?? row.held_by ?? "",
    heldAt: row.heldAt ?? row.held_at ?? "",
    createdAt: row.createdAt ?? "",
    updatedAt: row.updatedAt ?? "",
    items: items
      .filter((it) => it.consignmentOrderId === row.id)
      .sort((a, b) => a.lineNo - b.lineNo)
      .map(rowToItem),
  };
}

// ---------------------------------------------------------------------------
// rowToCOList — slim variant of rowToCO for the LIST endpoint
// (GET /api/consignment-orders). The list grid ships, per CO, every line
// item's FULL row (23 fields each via rowToItem). The list page never needs
// most of those: the grid columns / filters / CSV only read each item's
// `quantity` + `itemCategory` (item count, total qty, primary-category
// filter), and the in-page "Transfer to Delivery Order" dialog + the "Print
// / Preview" / "Bulk Print PDF" actions (which run off the list row, not a
// re-fetch) read `productCode`, `productName`, `sizeLabel`, `fabricCode`
// and the price/surcharge fields the PDF renderer needs.
//
// So this drops only the genuinely-unused per-item fields — id,
// consignmentOrderId, lineNo, lineSuffix, productId, sizeCode, notes — with
// ZERO change to anything the grid shows, filters, sorts, exports, or
// prints. The CO has no base64 image field, so there is no image to null
// out. The detail endpoint (GET /:id) keeps the full rowToCO payload.
// ---------------------------------------------------------------------------
function rowToCOListItem(it: ConsignmentOrderItemRow) {
  return {
    productCode: it.productCode ?? "",
    productName: it.productName ?? "",
    itemCategory: it.itemCategory ?? "",
    sizeLabel: it.sizeLabel ?? "",
    fabricCode: it.fabricCode ?? "",
    quantity: it.quantity,
    gapInches: it.gapInches,
    divanHeightInches: it.divanHeightInches,
    divanPriceSen: it.divanPriceSen,
    legHeightInches: it.legHeightInches,
    legPriceSen: it.legPriceSen,
    specialOrder: it.specialOrder ?? "",
    specialOrderPriceSen: it.specialOrderPriceSen,
    basePriceSen: it.basePriceSen,
    unitPriceSen: it.unitPriceSen,
    // Per-line discount (migration 0179). Default 0 for rows predating the column.
    discountSen: it.discountSen ?? 0,
    lineTotalSen: it.lineTotalSen,
  };
}

function rowToCOList(row: ConsignmentOrderRow, items: ConsignmentOrderItemRow[]) {
  return {
    ...rowToCO(row, items),
    items: items
      .filter((it) => it.consignmentOrderId === row.id)
      .sort((a, b) => a.lineNo - b.lineNo)
      .map(rowToCOListItem),
  };
}

function rowToItem(it: ConsignmentOrderItemRow) {
  return {
    id: it.id,
    consignmentOrderId: it.consignmentOrderId,
    lineNo: it.lineNo,
    lineSuffix: it.lineSuffix ?? "",
    productId: it.productId ?? "",
    productCode: it.productCode ?? "",
    productName: it.productName ?? "",
    itemCategory: it.itemCategory ?? "",
    sizeCode: it.sizeCode ?? "",
    sizeLabel: it.sizeLabel ?? "",
    fabricCode: it.fabricCode ?? "",
    quantity: it.quantity,
    gapInches: it.gapInches,
    divanHeightInches: it.divanHeightInches,
    divanPriceSen: it.divanPriceSen,
    legHeightInches: it.legHeightInches,
    legPriceSen: it.legPriceSen,
    specialOrder: it.specialOrder ?? "",
    specialOrderPriceSen: it.specialOrderPriceSen,
    basePriceSen: it.basePriceSen,
    unitPriceSen: it.unitPriceSen,
    // Per-line discount (migration 0179). Default 0 for rows predating the column.
    discountSen: it.discountSen ?? 0,
    lineTotalSen: it.lineTotalSen,
    notes: it.notes ?? "",
  };
}

function genCoId(): string {
  return `co-${crypto.randomUUID().slice(0, 8)}`;
}
function genItemId(): string {
  return `coi-${crypto.randomUUID().slice(0, 8)}`;
}

async function nextCompanyCOId(db: D1Database, now: Date): Promise<string> {
  // CO-YYMM-NNN format. Aligned with SO/PO/DO/GRN/PI per user 2026-04-28
  // numbering audit. Sequence is per (year, month) so January resets to
  // 001. Picks max-existing-suffix+1 (NOT count) so deletions don't
  // recycle numbers and clash with old refs.
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `CO-${yy}${mm}-`;
  const res = await db
    .prepare(
      "SELECT companyCOId FROM consignment_orders WHERE companyCOId LIKE ? ORDER BY companyCOId DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ companyCOId: string }>();
  if (!res) return `${prefix}001`;
  const tail = res.companyCOId.replace(prefix, "");
  const seq = parseInt(tail, 10);
  if (!Number.isFinite(seq)) return `${prefix}001`;
  return `${prefix}${String(seq + 1).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// cascadeCOStatusToPOs — CO-side mirror of cascadeSOStatusToPOs.
//
// When a CO flips to CANCELLED, every non-terminal child production_order
// (and its non-terminal job_cards) must follow. Without this cascade, the
// CN page's "Planning" + "Pending CN" filters keep surfacing those POs
// because they still look active (status=PENDING / IN_PROGRESS), which
// is exactly the leak Wei Siang flagged 2026-05-05 on CO-2605-004.
//
// Returns the bound UPDATE statements + a summary so the caller can
// execute them in the same batch as its own UPDATE (atomicity).
// ---------------------------------------------------------------------------
type COCascadeResult = {
  statements: ReturnType<D1Database["prepare"]>[];
  affectedPoCount: number;
  affectedJcCount: number;
  poNos: string[];
};

async function cascadeCOStatusToPOs(
  db: D1Database,
  coId: string,
  newStatus: string,
  now: string,
  fromStatus: string = "",
): Promise<COCascadeResult> {
  const result: COCascadeResult = {
    statements: [],
    affectedPoCount: 0,
    affectedJcCount: 0,
    poNos: [],
  };
  // Tier A fix 2026-05-21 (BUG-2026-05-20 series, Agent A finding A2):
  // Previously this function early-returned on every transition except
  // CANCELLED. CO_VALID_TRANSITIONS allows ON_HOLD from CONFIRMED /
  // IN_PRODUCTION / READY_TO_SHIP and resume from ON_HOLD back to
  // CONFIRMED / IN_PRODUCTION, but neither cascade ran — operator
  // could pause a CO while its child POs / JCs kept running on the
  // shop floor (the symptom Wei Siang flagged: "my CO 设 ON_HOLD 但
  // 工人继续在做").
  //
  // Now mirrors cascadeSOStatusToPOs (sales-orders.ts:524) exactly —
  // 3 branches: ON_HOLD / CANCELLED / RESUME. Memory rule
  // feedback_protect_completed_work honoured: COMPLETED / TRANSFERRED
  // / CANCELLED JCs never touched.
  const isHold = newStatus === "ON_HOLD";
  const isCancel = newStatus === "CANCELLED";
  const isResume =
    fromStatus === "ON_HOLD" &&
    (newStatus === "CONFIRMED" || newStatus === "IN_PRODUCTION");
  if (!isHold && !isCancel && !isResume) return result;

  const posRes = await db
    .prepare(
      "SELECT id, poNo, status FROM production_orders WHERE consignmentOrderId = ?",
    )
    .bind(coId)
    .all<{ id: string; poNo: string; status: string }>();
  const pos = posRes.results ?? [];
  if (pos.length === 0) return result;

  if (isHold) {
    const affected = pos.filter(
      (p) => p.status !== "COMPLETED" && p.status !== "CANCELLED",
    );
    if (affected.length === 0) return result;
    for (const p of affected) {
      result.statements.push(
        db
          .prepare(
            "UPDATE production_orders SET status = 'ON_HOLD', updated_at = ? WHERE id = ?",
          )
          .bind(now, p.id),
      );
      result.poNos.push(p.poNo);
    }
    result.affectedPoCount = affected.length;
    return result;
  }

  if (isResume) {
    // Flip ON_HOLD POs back to PENDING — same as SO resume path.
    // Already-COMPLETED / CANCELLED POs stay put.
    const affected = pos.filter((p) => p.status === "ON_HOLD");
    if (affected.length === 0) return result;
    for (const p of affected) {
      result.statements.push(
        db
          .prepare(
            "UPDATE production_orders SET status = 'PENDING', updated_at = ? WHERE id = ?",
          )
          .bind(now, p.id),
      );
      result.poNos.push(p.poNo);
    }
    result.affectedPoCount = affected.length;
    return result;
  }

  // isCancel — original behaviour, preserved.
  const affected = pos.filter(
    (p) => p.status !== "COMPLETED" && p.status !== "CANCELLED",
  );
  if (affected.length === 0) return result;

  for (const p of affected) {
    result.statements.push(
      db
        .prepare(
          "UPDATE production_orders SET status = 'CANCELLED', updated_at = ? WHERE id = ?",
        )
        .bind(now, p.id),
    );
    result.poNos.push(p.poNo);
  }
  result.affectedPoCount = affected.length;

  // Also cancel non-terminal job_cards under those POs.
  const poIds = affected.map((p) => p.id);
  const placeholders = poIds.map(() => "?").join(", ");
  const jcRes = await db
    .prepare(
      `SELECT id FROM job_cards
         WHERE productionOrderId IN (${placeholders})
           AND status NOT IN ('COMPLETED', 'TRANSFERRED', 'CANCELLED')`,
    )
    .bind(...poIds)
    .all<{ id: string }>();
  const jcIds = (jcRes.results ?? []).map((r) => r.id);
  for (const jcId of jcIds) {
    result.statements.push(
      db
        .prepare(
          "UPDATE job_cards SET status = 'CANCELLED' WHERE id = ?",
        )
        .bind(jcId),
    );
  }
  result.affectedJcCount = jcIds.length;
  return result;
}

// ---------------------------------------------------------------------------
// GET /api/consignment-orders — list
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const status = c.req.query("status");
  const customerId = c.req.query("customerId");
  const clauses: string[] = [];
  const params: string[] = [];
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (customerId) {
    clauses.push("customerId = ?");
    params.push(customerId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";

  const orderRes = await c.var.DB
    .prepare(`SELECT * FROM consignment_orders ${where} ORDER BY created_at DESC`)
    .bind(...params)
    .all<ConsignmentOrderRow>();
  const orderRows = orderRes.results ?? [];
  // Scope items to the COs we return — was a whole-table `SELECT * FROM
  // consignment_order_items` on every list render. Guard the "IN ()" case.
  const coIds = orderRows.map((r) => r.id);
  const itemRes = coIds.length
    ? await c.var.DB
        .prepare(
          `SELECT * FROM consignment_order_items WHERE consignmentOrderId IN (${coIds.map(() => "?").join(", ")})`,
        )
        .bind(...coIds)
        .all<ConsignmentOrderItemRow>()
    : { results: [] as ConsignmentOrderItemRow[] };
  const items = itemRes.results ?? [];
  // Bucket items by consignmentOrderId ONCE (was O(orders×items): rowToCOList
  // -> rowToCO BOTH re-filtered the whole items array per order). Byte-identical
  // — both still filter, now over the pre-scoped bucket (passthrough + sort).
  const itemsByOrder = new Map<string, ConsignmentOrderItemRow[]>();
  for (const it of items) {
    const arr = itemsByOrder.get(it.consignmentOrderId);
    if (arr) arr.push(it);
    else itemsByOrder.set(it.consignmentOrderId, [it]);
  }
  const data = orderRows.map((r) =>
    rowToCOList(r, itemsByOrder.get(r.id) ?? []),
  );
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// POST /api/consignment-orders — create CO in DRAFT status. Items pricing
// breakdown is stored verbatim — the same shape SO uses, so the shared
// <OrderLineItemEditor> form on the frontend can submit identical payloads
// to either endpoint.
// ---------------------------------------------------------------------------
// 0179 + 0185 self-apply — Postgres migration files are applied manually
// (deploy.yml does NOT replay them), so ensure the per-line discount column AND
// the ON HOLD reason columns exist before any CO write touches them. Idempotent
// ADD COLUMN IF NOT EXISTS, once per isolate. The hold columns mirror the SO
// side (sales-orders.ts) so a CO held from the production grid carries the same
// reason / who / when triple; snake_case so no column-rename-map entry needed.
let _coDiscountColMig: Promise<void> | null = null;
function ensureDiscountColumn(db: D1Database): Promise<void> {
  if (!_coDiscountColMig) {
    _coDiscountColMig = (async () => {
      const stmts = [
        "ALTER TABLE consignment_order_items ADD COLUMN IF NOT EXISTS discount_sen INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE consignment_orders ADD COLUMN IF NOT EXISTS hold_reason TEXT",
        "ALTER TABLE consignment_orders ADD COLUMN IF NOT EXISTS held_by TEXT",
        "ALTER TABLE consignment_orders ADD COLUMN IF NOT EXISTS held_at TEXT",
      ];
      await runSelfApply(db, "consignment-orders", stmts);
    })().catch((err) => {
    // A FAILED round must not be remembered as done — otherwise one
    // transient blip leaves the column unapplied for the life of this
    // isolate. Dropping the memo lets the next request retry.
    _coDiscountColMig = null;
    throw err;
  });
  }
  return _coDiscountColMig;
}

app.post("/", async (c) => {
  const denied = await requirePermission(c, "consignments", "create");
  if (denied) return denied;
  await ensureDiscountColumn(c.var.DB);
  // Idempotency — a duplicate retry (e.g. a dropped create response) returns
  // the cached result instead of creating a second CO. No-op without the
  // Idempotency-Key header. Mirrors the sales-orders create path.
  const idemKey = readIdempotencyKey(c);
  return withIdempotency(c, "consignment-orders", idemKey, async () => {
  try {
    const body = await c.req.json();

    // Validate customer exists. Customers table has no `state` column -
    // state lives on delivery_hubs (each customer has many hubs across
    // different states). Bug fix 2026-04-28: SELECT ... state ... was
    // throwing 'column "state" does not exist' on Postgres. Resolve the
    // hub's state below from delivery_hubs instead.
    const customer = await c.var.DB.prepare(
      "SELECT id, name FROM customers WHERE id = ?",
    )
      .bind(body.customerId)
      .first<{ id: string; name: string }>();
    if (!customer) {
      return c.json({ success: false, error: "Customer not found" }, 400);
    }
    // Pull state from the chosen delivery hub so customerState on the
    // consignment row reflects WHERE this CO is being delivered, not a
    // single customer-level state. Empty string when no hub picked yet.
    let customerState: string | null = null;
    const hubId = (body.hubId as string) ?? null;
    if (hubId) {
      const hub = await c.var.DB
        .prepare("SELECT state FROM delivery_hubs WHERE id = ?")
        .bind(hubId)
        .first<{ state: string | null }>();
      customerState = hub?.state ?? null;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const companyCOId = await nextCompanyCOId(c.var.DB, now);
    const id = genCoId();

    const rawItems = Array.isArray(body.items) ? body.items : [];

    // Hard restriction: SOFA + BEDFRAME may NOT coexist on a single CO.
    // Mirrors the SO POST guard — they run on entirely separate
    // production lines (Fab Cut merge keys, BF qty from HB, parallel
    // lead times). Frontend has the check too; this is the curl/API
    // backdoor close.
    if (
      hasMixedSofaBedframe(
        rawItems.map((it: Record<string, unknown>) => ({
          itemCategory:
            typeof it.itemCategory === "string" ? it.itemCategory : null,
        })),
      )
    ) {
      return c.json({ success: false, error: SO_MIXED_CATEGORY_ERROR }, 400);
    }

    // Hard restriction: SOFA lines must use 1 unit each. Per the
    // sales-orders.ts gate added 2026-05-09 (Wei Siang) — sofa BOM is
    // per-piece + a single PO with qty=N is harder to track than N
    // separate POs. Same rule applies to consignment orders since they
    // share the production_orders generator (createProductionOrdersForOrder
    // with sourceType: 'CO').
    {
      const offending = findInvalidSofaQty(
        rawItems.map((it: Record<string, unknown>, i: number) => ({
          itemCategory:
            typeof it.itemCategory === "string" ? it.itemCategory : null,
          quantity:
            typeof it.quantity === "number"
              ? it.quantity
              : Number(it.quantity ?? 1),
          productCode:
            typeof it.productCode === "string" ? it.productCode : null,
          lineNo:
            typeof it.lineNo === "number" ? it.lineNo : i + 1,
        })),
      );
      if (offending) {
        return c.json(
          { success: false, error: formatSofaQtyError(offending) },
          400,
        );
      }
    }

    // Fabric integrity gate — every non-empty incoming fabricCode must
    // resolve to a row in raw_materials with a fabric itemGroup. Mirrors
    // the SO POST guard so CO can't sneak orphan codes into production.
    {
      const fabCheck = await validateFabricCodes(
        c.var.DB,
        rawItems.map(
          (it: Record<string, unknown>) =>
            (it.fabricCode as string | null | undefined),
        ),
      );
      if (!fabCheck.valid) {
        return c.json(unknownFabricCodeError(fabCheck.unknown), 400);
      }
    }

    // SOFA seat-size gate (DUP-001 phase 1 commit C, 2026-05-09). Mirrors
    // the SO POST guard.
    {
      const sofaCheck = await validateSofaSizeLabels(
        c.var.DB,
        rawItems.map((it: Record<string, unknown>) => ({
          itemCategory: typeof it.itemCategory === "string" ? it.itemCategory : null,
          sizeLabel: typeof it.sizeLabel === "string" ? it.sizeLabel : null,
        })),
      );
      if (!sofaCheck.valid) {
        return c.json(
          unknownSofaSizeLabelError(sofaCheck.unknown, sofaCheck.allowed),
          400,
        );
      }
    }

    // OCR back-door closure (BUG-002 fix, 2026-05-09): catalog wins on CO
    // POST. Same shape as SO POST/PUT — when productCode resolves to a
    // catalog product, productId/productName/itemCategory/sizeLabel(BF/ACC)/
    // sizeCode(BF/ACC) all come from the catalog, NOT the request body.
    const productByCodeForCoPost = await loadProductCatalog(c.var.DB);
    // Price resolution + sofa combo — IDENTICAL treatment to Sales Orders
    // (owner 2026-06-11): a line whose request carries no price resolves from
    // the customer price list, then the catalog (same chain as SO POST). No
    // RM0 gate, also per owner. The combo pass below then renegotiates
    // matched sofa sets exactly like SO.
    const coPostAsOf =
      (typeof body.companyCODate === "string" && body.companyCODate) ||
      new Date().toISOString().slice(0, 10);
    const itemRows: ConsignmentOrderItemRow[] = await Promise.all(
      rawItems.map(
      async (it: Record<string, unknown>, idx: number) => {
        const qty = Number(it.quantity) || 1;
        const divanPrice = Number(it.divanPriceSen) || 0;
        const legPrice = Number(it.legPriceSen) || 0;
        const specialPrice = Number(it.specialOrderPriceSen) || 0;
        const snapped = snapItemToCatalog(
          {
            productCode: it.productCode,
            productId: it.productId,
            productName: it.productName,
            itemCategory: it.itemCategory,
            sizeCode: it.sizeCode,
            sizeLabel: it.sizeLabel,
          },
          productByCodeForCoPost,
        );
        const incomingBase = Number(it.basePriceSen) || 0;
        const basePrice =
          incomingBase === 0
            ? await resolveLineBasePriceSen(c.var.DB, {
                productId: snapped.productId || null,
                customerId: customer.id,
                asOf: coPostAsOf,
                seatHeight: seatHeightOf(
                  it,
                  snapped.sizeCode || null,
                  snapped.sizeLabel || null,
                ),
                fallbackSen: 0,
              })
            : incomingBase;
        const unitPrice = basePrice + divanPrice + legPrice + specialPrice;
        // Per-line discount (migration 0179). Clamped ≥ 0.
        const discountSen = Math.max(0, Math.round(Number(it.discountSen) || 0));
        return {
          id: genItemId(),
          consignmentOrderId: id,
          lineNo: Number(it.lineNo) || idx + 1,
          lineSuffix: (it.lineSuffix as string) ?? null,
          productId: snapped.productId || null,
          productCode: snapped.productCode || null,
          productName: snapped.productName || null,
          itemCategory: snapped.itemCategory || null,
          sizeCode: snapped.sizeCode || null,
          sizeLabel: snapped.sizeLabel || null,
          fabricCode: (it.fabricCode as string) ?? null,
          quantity: qty,
          gapInches: it.gapInches != null ? Number(it.gapInches) : null,
          divanHeightInches:
            it.divanHeightInches != null ? Number(it.divanHeightInches) : null,
          divanPriceSen: divanPrice,
          legHeightInches:
            it.legHeightInches != null ? Number(it.legHeightInches) : null,
          legPriceSen: legPrice,
          specialOrder: (it.specialOrder as string) ?? null,
          specialOrderPriceSen: specialPrice,
          basePriceSen: basePrice,
          unitPriceSen: unitPrice,
          discountSen,
          lineTotalSen: Math.max(0, unitPrice * qty - discountSen),
          notes: (it.notes as string) ?? null,
        };
      },
      ),
    );
    // Sofa combo renegotiation — same engine as Sales Orders.
    await runSofaComboPass(c.var.DB, customer.id, itemRows, rawItems);

    const subtotalSen = itemRows.reduce((s, it) => s + it.lineTotalSen, 0);
    const totalSen = subtotalSen; // No tax/discount in v1

    const stmts: D1PreparedStatement[] = [];
    stmts.push(
      c.var.DB.prepare(
        `INSERT INTO consignment_orders (id, customerCO, customerCOId, customerCODate,
           reference, customerId, customerName, customerState, hubId, hubName,
           companyCO, companyCOId, companyCODate, customerDeliveryDate,
           hookkaExpectedDD, subtotalSen, totalSen, status, overdue, notes,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        (body.customerCO as string) ?? null,
        (body.customerCOId as string) ?? null,
        (body.customerCODate as string) ?? null,
        (body.reference as string) ?? null,
        customer.id,
        customer.name,
        customerState,
        (body.hubId as string) ?? null,
        (body.hubName as string) ?? null,
        companyCOId,
        companyCOId,
        (body.companyCODate as string) || nowIso.split("T")[0],
        (body.customerDeliveryDate as string) ?? null,
        (body.hookkaExpectedDD as string) ?? null,
        subtotalSen,
        totalSen,
        "DRAFT",
        "PENDING",
        (body.notes as string) ?? null,
        nowIso,
        nowIso,
      ),
    );

    for (const it of itemRows) {
      stmts.push(
        c.var.DB.prepare(
          `INSERT INTO consignment_order_items (id, consignmentOrderId, lineNo, lineSuffix,
             productId, productCode, productName, itemCategory, sizeCode, sizeLabel,
             fabricCode, quantity, gapInches, divanHeightInches, divanPriceSen,
             legHeightInches, legPriceSen, specialOrder, specialOrderPriceSen,
             basePriceSen, unitPriceSen, discountSen, lineTotalSen, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          it.id,
          it.consignmentOrderId,
          it.lineNo,
          it.lineSuffix,
          it.productId,
          it.productCode,
          it.productName,
          it.itemCategory,
          it.sizeCode,
          it.sizeLabel,
          it.fabricCode,
          it.quantity,
          it.gapInches,
          it.divanHeightInches,
          it.divanPriceSen,
          it.legHeightInches,
          it.legPriceSen,
          it.specialOrder,
          it.specialOrderPriceSen,
          it.basePriceSen,
          it.unitPriceSen,
          it.discountSen,
          it.lineTotalSen,
          it.notes,
        ),
      );
    }

    await c.var.DB.batch(stmts);

    const created = await c.var.DB.prepare(
      "SELECT * FROM consignment_orders WHERE id = ?",
    )
      .bind(id)
      .first<ConsignmentOrderRow>();
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create consignment order" },
        500,
      );
    }
    return c.json({ success: true, data: rowToCO(created, itemRows) }, 201);
  } catch (err) {
    // Surface the real failure — DB constraint violations, missing FKs,
    // bad item category, etc. were silently masked as "Invalid request
    // body" before, which made debugging from the UI impossible.
    console.error("[POST /api/consignment-orders] failed:", err);
    const message = err instanceof Error ? err.message : "Invalid request body";
    return c.json({ success: false, error: message }, 400);
  }
  });
});

// ---------------------------------------------------------------------------
// GET /api/consignment-orders/stats — whole-dataset status bucket counts.
// Mirrors /api/sales-orders/stats. Used by the list-page tab badges.
// MUST be registered BEFORE /:id (Hono matches in registration order; a
// wildcard /:id would otherwise swallow "/stats").
// ---------------------------------------------------------------------------
app.get("/stats", async (c) => {
  const orgId = getOrgId(c);
  const { withSnapshot } = await import("../lib/snapshot");
  // PR 7 — cache-aside snapshot.
  const data = await withSnapshot(
    c.var.DB,
    {
      tableName: "consignment_orders_stats_snapshot",
      sourceTables: ["consignment_orders"],
    },
    orgId,
    async () => {
      const res = await c.var.DB
        .prepare(
          "SELECT status, COUNT(*) AS n FROM consignment_orders GROUP BY status",
        )
        .all<{ status: string; n: number }>();
      const byStatus: Record<string, number> = {};
      let total = 0;
      for (const row of res.results ?? []) {
        byStatus[row.status] = row.n;
        total += row.n;
      }
      return { byStatus, total };
    },
  );
  return c.json({ success: true, ...data });
});

// ---------------------------------------------------------------------------
// GET /api/consignment-orders/status-changes — full audit log.
//
// Tier A fix 2026-05-21 (Agent A finding A1, Wei Siang report
// "CO Detail 页一直显示空白历史"): previously returned hardcoded
// empty array based on the outdated comment "table doesn't exist yet".
// Migration 0104 added `co_status_changes` and the cascades in
// production-orders.ts (lines 2732, 2764, 2902, 2981, 3047, 3106)
// have been writing to it for months. The endpoint just never read.
//
// Reads the same shape as /api/sales-orders/status-changes returns —
// newest-first, capped at 500 rows so a single huge org doesn't
// blow the response.
// ---------------------------------------------------------------------------
app.get("/status-changes", async (c) => {
  // Migrations are inert on deploy, so co_status_changes may not exist yet on
  // this DB — ensure it (idempotent) or the SELECT 500s with
  // relation "co_status_changes" does not exist (prod 2026-08-01). Columns are
  // spelled snake_case: `coId` is NOT in column-rename-map.json, so the compat
  // layer would pass it through verbatim and Postgres would fold it to `coid`
  // ≠ the physical `co_id` — a second, latent 500 the missing table masked.
  // The result columns come back camelCase via the adapter's output transform,
  // so the mapping below (r.coId, r.fromStatus, …) is unchanged.
  await ensureCoStatusChangesTable(c.var.DB);
  let rows: Array<{
    id: string;
    coId: string;
    fromStatus: string | null;
    toStatus: string;
    changedBy: string | null;
    timestamp: string;
    notes: string | null;
    autoActions: string | null;
  }> = [];
  try {
    const res = await c.var.DB
      .prepare(
        `SELECT id, co_id, from_status, to_status, changed_by, timestamp, notes, auto_actions
           FROM co_status_changes
          ORDER BY timestamp DESC, id DESC
          LIMIT 500`,
      )
      .all<{
        id: string;
        coId: string;
        fromStatus: string | null;
        toStatus: string;
        changedBy: string | null;
        timestamp: string;
        notes: string | null;
        autoActions: string | null;
      }>();
    rows = res.results ?? [];
  } catch {
    // A never-created table (or transient DDL failure) must degrade to an empty
    // audit list, never a 500 on the CO detail page.
    rows = [];
  }
  const data = rows.map((r) => ({
    id: r.id,
    coId: r.coId,
    fromStatus: r.fromStatus ?? "",
    toStatus: r.toStatus,
    changedBy: r.changedBy ?? "System",
    timestamp: r.timestamp,
    notes: r.notes ?? "",
    autoActions: r.autoActions
      ? (() => {
          try {
            return JSON.parse(r.autoActions) as string[];
          } catch {
            return [];
          }
        })()
      : [],
  }));
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// GET /api/consignment-orders/:id/edit-eligibility — CO-parity twin of the
// SO endpoint. Rules (per user 2026-04-28):
//   1. Status must be DRAFT / CONFIRMED / IN_PRODUCTION.
//   2. No JC under any of the CO's POs may have a completedDate stamped.
//   3. Earliest JC dueDate > today + 2 days (lock once within 2 days of
//      the first scheduled production step's deadline).
//
// Registered BEFORE /:id so Hono's trie picks the right handler.
// ---------------------------------------------------------------------------
app.get("/:id/edit-eligibility", async (c) => {
  const id = c.req.param("id");
  const co = await c.var.DB
    .prepare("SELECT id, status FROM consignment_orders WHERE id = ?")
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!co) {
    return c.json({ success: false, error: "Consignment order not found" }, 404);
  }

  // Rule 1: status must be one of DRAFT / CONFIRMED / IN_PRODUCTION.
  if (
    co.status !== "DRAFT" &&
    co.status !== "CONFIRMED" &&
    co.status !== "IN_PRODUCTION"
  ) {
    return c.json({
      success: true,
      editable: false,
      reason: "status",
      status: co.status,
    });
  }

  // DRAFT/CONFIRMED short-circuit — no production to inspect.
  if (co.status === "DRAFT" || co.status === "CONFIRMED") {
    return c.json({
      success: true,
      editable: true,
      status: co.status,
    });
  }

  // IN_PRODUCTION — pull earliest completed + earliest scheduled JC dueDate.
  const [completedRes, earliestDueRes] = await Promise.all([
    c.var.DB
      .prepare(
        `SELECT jc.departmentName, jc.departmentCode, jc.completedDate
           FROM job_cards jc
           JOIN production_orders po ON po.id = jc.productionOrderId
          WHERE po.consignmentOrderId = ?
            AND jc.completedDate IS NOT NULL
            AND jc.completedDate <> ''
          ORDER BY jc.completedDate ASC
          LIMIT 1`,
      )
      .bind(id)
      .first<{
        departmentName: string | null;
        departmentCode: string | null;
        completedDate: string | null;
      }>(),
    c.var.DB
      .prepare(
        `SELECT jc.dueDate
           FROM job_cards jc
           JOIN production_orders po ON po.id = jc.productionOrderId
          WHERE po.consignmentOrderId = ?
            AND jc.dueDate IS NOT NULL
            AND jc.dueDate <> ''
          ORDER BY jc.dueDate ASC
          LIMIT 1`,
      )
      .bind(id)
      .first<{ dueDate: string | null }>(),
  ]);

  // Rule 2: any dept stamped a completion → fully locked.
  if (completedRes && completedRes.completedDate) {
    return c.json({
      success: true,
      editable: false,
      reason: "dept_completed",
      status: co.status,
      completedDept: completedRes.departmentName || completedRes.departmentCode || "A department",
      completedAt: completedRes.completedDate,
    });
  }

  // Rule 3: earliest JC dueDate > today + 2 days.
  const earliestDue = earliestDueRes?.dueDate?.slice(0, 10) ?? "";
  if (earliestDue.length === 10) {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() + 2);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    if (earliestDue <= cutoffStr) {
      return c.json({
        success: true,
        editable: false,
        reason: "production_window",
        status: co.status,
        earliestJcDueDate: earliestDue,
        cutoffDate: cutoffStr,
      });
    }
  }

  // IN_PRODUCTION, no JC done, first step > 2 days away — editable.
  return c.json({
    success: true,
    editable: true,
    status: co.status,
  });
});

// ---------------------------------------------------------------------------
// POST /api/consignment-orders/:id/override-edit-lock — CO-parity twin of
// the SO endpoint. See routes/sales-orders.ts for the full security-model
// rationale (admin can override Rule 3 production_window because it is a
// soft schedule-drift guard with no committed output yet; admin CANNOT
// override Rule 2 dept_completed because real WIP exists).
//
// Differences from the SO version:
//   * No so_status_changes mirror — CO has no status-changes table yet
//     (TODO at line ~411 of this file). The override row in
//     edit_lock_overrides + the audit_events emit is the full audit trail
//     until that table lands.
//
// Registered BEFORE /:id so Hono's trie picks the right handler.
// ---------------------------------------------------------------------------
app.post("/:id/override-edit-lock", async (c) => {
  const denied = await requirePermission(c, "consignments", "create");
  if (denied) return denied;
  const id = c.req.param("id");

  const role = (
    c as unknown as { get: (k: string) => string | undefined }
  ).get("userRole")?.toUpperCase();
  if (role !== "SUPER_ADMIN" && role !== "ADMIN") {
    return c.json(
      {
        success: false,
        error:
          "Forbidden — only SUPER_ADMIN or ADMIN can override the edit lock.",
      },
      403,
    );
  }

  let body: { reason?: unknown };
  try {
    body = (await c.req.json()) as { reason?: unknown };
  } catch {
    return c.json({ success: false, error: "Invalid JSON body" }, 400);
  }
  const reasonRaw = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reasonRaw.length < MIN_OVERRIDE_REASON_LEN) {
    return c.json(
      {
        success: false,
        error: `Reason is required (minimum ${MIN_OVERRIDE_REASON_LEN} characters after trimming).`,
      },
      400,
    );
  }

  const co = await c.var.DB
    .prepare("SELECT id, status FROM consignment_orders WHERE id = ?")
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!co) {
    return c.json(
      { success: false, error: "Consignment order not found" },
      404,
    );
  }

  // Rule 1
  if (
    co.status !== "DRAFT" &&
    co.status !== "CONFIRMED" &&
    co.status !== "IN_PRODUCTION"
  ) {
    return c.json(
      {
        success: false,
        error: `Cannot override — order is in status ${co.status}, which is not editable regardless of override.`,
      },
      400,
    );
  }
  if (co.status === "DRAFT" || co.status === "CONFIRMED") {
    return c.json(
      {
        success: false,
        error: "No override needed — this order is already editable.",
      },
      400,
    );
  }

  const [completedRes, earliestDueRes] = await Promise.all([
    c.var.DB
      .prepare(
        `SELECT jc.completedDate
           FROM job_cards jc
           JOIN production_orders po ON po.id = jc.productionOrderId
          WHERE po.consignmentOrderId = ?
            AND jc.completedDate IS NOT NULL
            AND jc.completedDate <> ''
          LIMIT 1`,
      )
      .bind(id)
      .first<{ completedDate: string | null }>(),
    c.var.DB
      .prepare(
        `SELECT jc.dueDate
           FROM job_cards jc
           JOIN production_orders po ON po.id = jc.productionOrderId
          WHERE po.consignmentOrderId = ?
            AND jc.dueDate IS NOT NULL
            AND jc.dueDate <> ''
          ORDER BY jc.dueDate ASC
          LIMIT 1`,
      )
      .bind(id)
      .first<{ dueDate: string | null }>(),
  ]);

  // Rule 2 — NOT bypassable.
  if (completedRes && completedRes.completedDate) {
    return c.json(
      {
        success: false,
        error:
          "Cannot override — production output already exists (a department has stamped completion). Editing would orphan finished WIP. This lock cannot be bypassed.",
      },
      400,
    );
  }

  // Rule 3 must currently be active for the override to be meaningful.
  const earliestDue = earliestDueRes?.dueDate?.slice(0, 10) ?? "";
  let productionWindowActive = false;
  if (earliestDue.length === 10) {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() + 2);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    if (earliestDue <= cutoffStr) productionWindowActive = true;
  }
  if (!productionWindowActive) {
    return c.json(
      {
        success: false,
        error:
          "No override needed — the order is not currently within the 2-day production-window lock.",
      },
      400,
    );
  }

  const actorUserId = (
    c as unknown as { get: (k: string) => string | undefined }
  ).get("userId") ?? null;
  const actorUserName = await lookupActorDisplayName(c.var.DB, actorUserId);

  const created = await createEditLockOverride(c.var.DB, {
    orderType: "CO",
    orderId: id,
    reason: reasonRaw,
    actorUserId,
    actorUserName,
    actorRole: role,
  });

  await emitAudit(c, {
    resource: "consignment-orders",
    resourceId: id,
    action: "override-edit-lock",
    before: {
      editable: false,
      reason: "production_window",
      earliestJcDueDate: earliestDue,
    },
    after: {
      overrideToken: created.token,
      expiresAt: created.expiresAt,
      reason: reasonRaw,
    },
  });

  return c.json({
    success: true,
    overrideToken: created.token,
    expiresAt: created.expiresAt,
  });
});

// ---------------------------------------------------------------------------
// GET /api/consignment-orders/:id
// ---------------------------------------------------------------------------
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [row, items, cnsRes, posRes, completedByRes] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM consignment_orders WHERE id = ?")
      .bind(id)
      .first<ConsignmentOrderRow>(),
    c.var.DB.prepare(
      "SELECT * FROM consignment_order_items WHERE consignmentOrderId = ?",
    )
      .bind(id)
      .all<ConsignmentOrderItemRow>(),
    // Linked Consignment Notes — used by the FE hub-edit gate so the
    // operator can see whether the hub is still editable (no dispatched CN)
    // before clicking the Edit pencil. Expanded with delivery fields for the
    // Order Progress card.
    //
    // convertedInvoiceId + invoiceNo (2026-08-01): a CN can be converted to
    // a DRAFT invoice via POST /api/consignment-notes/:id/convert-to-invoice
    // (official flow, owner re-confirmed 2026-08-01). The link lives on
    // consignment_notes.converted_invoice_id (mig 0070, FK → invoices(id),
    // indexed). Surfaced here so the CO detail page renders the REAL invoice
    // instead of fabricating a number from order.status. LEFT JOIN keeps
    // unconverted CNs in the result set.
    //
    // NOTE on the JOIN: D1Compat rewrites every BARE identifier through
    // column-rename-map.json, aliases included. `invoiceStatus` has no map
    // entry, so a bare `AS invoiceStatus` would reach Postgres unquoted,
    // fold to `invoicestatus` and come back un-camelCased. The rewriter
    // copies double-quoted spans verbatim, so the one invented alias we
    // need is QUOTED — `AS "invoiceStatus"` survives intact and Postgres
    // preserves its casing. Every other column here is a plain qualified
    // ref whose own name is already in the map.
    c.var.DB.prepare(
      `SELECT cn.id, cn.noteNumber, cn.status, cn.dispatchedAt,
              cn.deliveredAt, cn.driverName, cn.convertedInvoiceId,
              inv.invoiceNo, inv.status AS "invoiceStatus"
         FROM consignment_notes cn
         LEFT JOIN invoices inv ON inv.id = cn.convertedInvoiceId
        WHERE cn.consignmentOrderId = ?
        ORDER BY cn.noteNumber`,
    )
      .bind(id)
      .all<{
        id: string;
        noteNumber: string | null;
        status: string | null;
        dispatchedAt: string | null;
        deliveredAt: string | null;
        driverName: string | null;
        convertedInvoiceId?: string | null;
        converted_invoice_id?: string | null;
        invoiceNo?: string | null;
        invoice_no?: string | null;
        invoiceStatus?: string | null;
      }>(),
    // Linked production orders for the Order Progress card.
    c.var.DB.prepare(
      `SELECT id, poNo, productName, productCode, itemCategory, quantity,
              status, progress, currentDepartment, completedDate
         FROM production_orders
        WHERE consignmentOrderId = ?
        ORDER BY poNo`,
    )
      .bind(id)
      .all<{
        id: string; poNo: string; productName: string | null;
        productCode: string | null; itemCategory: string | null;
        quantity: number | null; status: string | null;
        progress: number | null; currentDepartment: string | null;
        completedDate: string | null;
      }>(),
    // completedBy: worker names from completed job_cards under this CO's POs.
    c.var.DB.prepare(
      `SELECT jc.productionOrderId,
              string_agg(DISTINCT CASE WHEN jc.pic1Name IS NOT NULL AND jc.pic1Name <> '' THEN jc.pic1Name END, ', ') AS names1,
              string_agg(DISTINCT CASE WHEN jc.pic2Name IS NOT NULL AND jc.pic2Name <> '' THEN jc.pic2Name END, ', ') AS names2
         FROM job_cards jc
         JOIN production_orders po ON po.id = jc.productionOrderId
        WHERE po.consignmentOrderId = ?
          AND jc.status = 'COMPLETED'
          AND (jc.pic1Name IS NOT NULL OR jc.pic2Name IS NOT NULL)
        GROUP BY jc.productionOrderId`,
    )
      .bind(id)
      .all<{ productionOrderId: string; names1: string | null; names2: string | null }>(),
  ]);
  if (!row) {
    return c.json(
      { success: false, error: "Consignment order not found" },
      404,
    );
  }
  // Lock status — surfaced to the CO detail / edit pages so they can
  // disable inputs + render a banner when locked (PO COMPLETED or
  // CN already created).
  const lockReason = await checkConsignmentOrderLocked(c.var.DB, id);
  const linkedCNs = (cnsRes.results ?? []).map((cn) => ({
    id: cn.id,
    noteNumber: cn.noteNumber ?? "",
    status: cn.status ?? "",
    dispatchedAt: cn.dispatchedAt ?? null,
    deliveredAt: cn.deliveredAt ?? null,
    driverName: cn.driverName ?? null,
    // Real CN → invoice link (mig 0070). Dual-keyed read per the repo rule.
    // null when the CN has not been converted yet.
    convertedInvoiceId: cn.convertedInvoiceId ?? cn.converted_invoice_id ?? null,
    convertedInvoiceNo: cn.invoiceNo ?? cn.invoice_no ?? null,
    convertedInvoiceStatus: cn.invoiceStatus ?? null,
  }));
  // Build completedBy map: poId → comma-deduped worker names.
  const completedByMap = new Map<string, string>();
  for (const cb of completedByRes.results ?? []) {
    const parts = [
      ...(cb.names1 ? cb.names1.split(",") : []),
      ...(cb.names2 ? cb.names2.split(",") : []),
    ].filter((n, i, a) => n && a.indexOf(n) === i);
    if (parts.length) completedByMap.set(cb.productionOrderId, parts.join(", "));
  }
  // Real AR receipts for whatever invoice this order's CNs converted into.
  // The detail page used to INVENT a receipt number (`AR-<coId>` with a
  // hardcoded "RECEIVED") the moment the order hit CLOSED — the same defect as
  // the invoice node beside it, which was fixed to say "Not linked" rather than
  // make one up. A node that shows a document number the operator cannot find
  // anywhere is worse than one that admits the link is missing.
  const invoiceIds = linkedCNs
    .map((cn) => cn.convertedInvoiceId)
    .filter((v): v is string => !!v);
  let linkedPayments: Array<{
    id: string;
    invoiceId: string;
    date: string | null;
    amountSen: number;
    method: string | null;
    reference: string | null;
  }> = [];
  if (invoiceIds.length > 0) {
    const ph = invoiceIds.map(() => "?").join(",");
    const payRes = await c.var.DB.prepare(
      `SELECT id, invoice_id, date, amount_sen, method, reference
         FROM invoice_payments WHERE invoice_id IN (${ph}) ORDER BY date DESC`,
    )
      .bind(...invoiceIds)
      .all<{
        id: string;
        invoiceId?: string;
        invoice_id?: string;
        date?: string | null;
        amountSen?: number | null;
        amount_sen?: number | null;
        method?: string | null;
        reference?: string | null;
      }>();
    linkedPayments = (payRes.results ?? []).map((p) => ({
      id: p.id,
      invoiceId: p.invoiceId ?? p.invoice_id ?? "",
      date: p.date ?? null,
      amountSen: Number(p.amountSen ?? p.amount_sen ?? 0),
      method: p.method ?? null,
      reference: p.reference ?? null,
    }));
  }

  return c.json({
    success: true,
    data: rowToCO(row, items.results ?? []),
    lockReason,
    linkedCNs,
    linkedPayments,
    linkedPOs: (posRes.results ?? []).map((p) => ({
      id: p.id,
      poNo: p.poNo,
      productName: p.productName ?? "",
      productCode: p.productCode ?? "",
      itemCategory: p.itemCategory ?? "",
      quantity: p.quantity ?? 0,
      status: p.status ?? "",
      progress: p.progress ?? 0,
      currentDepartment: p.currentDepartment ?? "",
      completedDate: p.completedDate ?? null,
      completedBy: completedByMap.get(p.id) ?? null,
    })),
  });
});

// ---------------------------------------------------------------------------
// POST /api/consignment-orders/:id/confirm
//
// Transitions DRAFT → CONFIRMED and cascades through the shared production
// builder. Idempotent: re-confirming after the first call returns the
// existing PO set without duplicating.
// ---------------------------------------------------------------------------
app.post("/:id/confirm", async (c) => {
  const denied = await requirePermission(c, "consignments", "create");
  if (denied) return denied;
  const id = c.req.param("id");

  const [orderRow, itemsRes] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM consignment_orders WHERE id = ?")
      .bind(id)
      .first<ConsignmentOrderRow>(),
    c.var.DB.prepare(
      "SELECT * FROM consignment_order_items WHERE consignmentOrderId = ? ORDER BY lineNo",
    )
      .bind(id)
      .all<ConsignmentOrderItemRow>(),
  ]);
  if (!orderRow) {
    return c.json(
      { success: false, error: "Consignment order not found" },
      404,
    );
  }
  const itemRows = itemsRes.results ?? [];
  if (itemRows.length === 0) {
    return c.json(
      { success: false, error: "Cannot confirm a CO with no line items" },
      400,
    );
  }

  // Hard restriction re-check at confirm. POST + PUT block this upstream,
  // but legacy / pre-rule rows still need the gate so the production
  // cascade never sees a mixed-category CO.
  if (hasMixedSofaBedframe(itemRows)) {
    return c.json({ success: false, error: SO_MIXED_CATEGORY_ERROR }, 400);
  }

  // Sofa qty>1 re-check — same rationale: legacy CO rows that pre-date
  // the rule still need to be blocked here so the production cascade
  // doesn't emit a single PO with sofa qty=N.
  {
    const offending = findInvalidSofaQty(itemRows);
    if (offending) {
      return c.json(
        { success: false, error: formatSofaQtyError(offending) },
        400,
      );
    }
  }

  // Build production orders via the shared service. The same function SO
  // confirm uses — sourceType discriminates which FK column gets written.
  const result = await createProductionOrdersForOrder(
    c.var.DB,
    {
      id: orderRow.id,
      sourceType: "CO",
      companyOrderId: orderRow.companyCOId ?? "",
      companyOrderDate: orderRow.companyCODate,
      customerPOId: null, // CO has no customer PO equivalent
      reference: orderRow.reference,
      customerName: orderRow.customerName,
      customerState: orderRow.customerState,
      hookkaExpectedDD: orderRow.hookkaExpectedDD,
      customerDeliveryDate: orderRow.customerDeliveryDate,
    },
    itemRows.map((it) => ({
      lineNo: it.lineNo,
      productId: it.productId,
      productCode: it.productCode,
      productName: it.productName,
      itemCategory: it.itemCategory,
      sizeCode: it.sizeCode,
      sizeLabel: it.sizeLabel,
      fabricCode: it.fabricCode,
      quantity: it.quantity,
      gapInches: it.gapInches,
      divanHeightInches: it.divanHeightInches,
      legHeightInches: it.legHeightInches,
      specialOrder: it.specialOrder,
      notes: it.notes,
    })),
  );

  // Apply the production-order INSERTs + bump CO status.
  const stmts = [...result.statements];
  if (!result.preExisting) {
    stmts.push(
      c.var.DB.prepare(
        "UPDATE consignment_orders SET status = 'CONFIRMED', updated_at = ? WHERE id = ?",
      ).bind(new Date().toISOString(), id),
    );
  }
  if (stmts.length > 0) {
    await c.var.DB.batch(stmts);
  }

  return c.json({
    success: true,
    data: {
      id: orderRow.id,
      status: result.preExisting ? orderRow.status : "CONFIRMED",
      productionOrders: result.created,
      preExisting: result.preExisting,
    },
  });
});

// ---------------------------------------------------------------------------
// PUT /api/consignment-orders/:id — update header + items.
//
// Cascade lock: rejects field edits (items / customer / dates) once any
// production order has reached COMPLETED OR a Consignment Note exists for
// the parent customer. Status-only transitions still pass through (the
// caller wants to flip DRAFT → ON_HOLD or similar, not rewrite the order).
// ---------------------------------------------------------------------------
app.put("/:id", async (c) => {
  const denied = await requirePermission(c, "consignments", "update");
  if (denied) return denied;
  await ensureDiscountColumn(c.var.DB);
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM consignment_orders WHERE id = ?",
    )
      .bind(id)
      .first<ConsignmentOrderRow>();
    if (!existing) {
      return c.json(
        { success: false, error: "Consignment order not found" },
        404,
      );
    }

    const body = await c.req.json();
    const isStatusOnly =
      body.status &&
      !body.items &&
      !body.customerId &&
      !body.companyCODate &&
      !body.customerDeliveryDate &&
      !body.hookkaExpectedDD;

    if (!isStatusOnly) {
      const lockMsg = await checkConsignmentOrderLocked(c.var.DB, id);
      if (lockMsg) {
        return c.json(lockedResponse(lockMsg), 403);
      }

      // ---------------------------------------------------------------
      // Edit-eligibility re-check (defense-in-depth, mirrors the GET
      // /:id/edit-eligibility logic). Same model as sales-orders.ts:
      // Rule 2 (dept_completed) is hard — override cannot bypass; Rule
      // 3 (production_window) is bypassable via a one-shot
      // overrideToken minted by SUPER_ADMIN/ADMIN. See SO PUT block
      // for the full rationale comment.
      // ---------------------------------------------------------------
      if (
        existing.status === "IN_PRODUCTION" ||
        existing.status === "CONFIRMED"
      ) {
        const [completedRes, earliestDueRes] = await Promise.all([
          c.var.DB
            .prepare(
              `SELECT jc.completedDate, jc.departmentName, jc.departmentCode
                 FROM job_cards jc
                 JOIN production_orders po ON po.id = jc.productionOrderId
                WHERE po.consignmentOrderId = ?
                  AND jc.completedDate IS NOT NULL
                  AND jc.completedDate <> ''
                LIMIT 1`,
            )
            .bind(id)
            .first<{
              completedDate: string | null;
              departmentName: string | null;
              departmentCode: string | null;
            }>(),
          c.var.DB
            .prepare(
              `SELECT jc.dueDate
                 FROM job_cards jc
                 JOIN production_orders po ON po.id = jc.productionOrderId
                WHERE po.consignmentOrderId = ?
                  AND jc.dueDate IS NOT NULL
                  AND jc.dueDate <> ''
                ORDER BY jc.dueDate ASC
                LIMIT 1`,
            )
            .bind(id)
            .first<{ dueDate: string | null }>(),
        ]);

        if (completedRes && completedRes.completedDate) {
          const dept =
            completedRes.departmentName ||
            completedRes.departmentCode ||
            "A department";
          return c.json(
            {
              success: false,
              error: `Cannot edit — ${dept} has completed work on this order. Editing items would orphan finished WIP.`,
              reason: "dept_completed",
            },
            403,
          );
        }

        const earliestDue = earliestDueRes?.dueDate?.slice(0, 10) ?? "";
        if (earliestDue.length === 10) {
          const cutoff = new Date();
          cutoff.setUTCDate(cutoff.getUTCDate() + 2);
          const cutoffStr = cutoff.toISOString().slice(0, 10);
          if (earliestDue <= cutoffStr) {
            const overrideToken =
              typeof body.overrideToken === "string"
                ? body.overrideToken
                : "";
            if (!overrideToken) {
              return c.json(
                {
                  success: false,
                  error: `Cannot edit — first production step is due ${earliestDue} (within the 2-day cutoff ${cutoffStr}). An ADMIN override is required.`,
                  reason: "production_window",
                  earliestJcDueDate: earliestDue,
                  cutoffDate: cutoffStr,
                },
                403,
              );
            }
            const consumed = await consumeEditLockOverrideToken(
              c.var.DB,
              overrideToken,
              "CO",
              id,
            );
            if (!consumed.ok) {
              const detail =
                consumed.reason === "expired"
                  ? "Override token has expired (60 min TTL). Request a new override."
                  : consumed.reason === "already_used"
                    ? "Override token has already been used. Request a new override."
                    : consumed.reason === "wrong_order"
                      ? "Override token does not match this order."
                      : "Override token not found.";
              return c.json(
                {
                  success: false,
                  error: detail,
                  reason: "override_invalid",
                },
                403,
              );
            }
            // Token consumed — fall through to the normal PUT flow.
          }
        }
      }
    }

    // Reject illegal status transitions before any further work. CO-parity
    // twin of sales-orders.ts:2624 — without this gate, CO PUT used to
    // accept any string in body.status (verified by 2026-05-09 audit:
    // DUP-003 in bug_audit_duplicate_logic.md). Empty/unchanged status
    // bypasses the check; only same-status retries and explicit transitions
    // hit it.
    if (
      typeof body.status === "string" &&
      body.status &&
      body.status !== existing.status
    ) {
      const requested = body.status;
      const validNext = CO_VALID_TRANSITIONS[existing.status] ?? [];
      if (!validNext.includes(requested)) {
        return c.json(
          {
            success: false,
            error: `Invalid status transition: ${existing.status} -> ${requested}. Valid transitions: ${
              validNext.join(", ") || "none"
            }`,
          },
          400,
        );
      }
      // ON HOLD reason gate (0185) — CO mirror of the SO rule. Holding a CO
      // REQUIRES a non-empty reason (FE hold modal enforces it too).
      if (requested === "ON_HOLD") {
        const reason =
          typeof body.holdReason === "string" ? body.holdReason.trim() : "";
        if (!reason) {
          return c.json(
            {
              success: false,
              error: "A reason is required to put this order on hold.",
            },
            400,
          );
        }
      }
    }

    // Pre-flight: block CANCELLED transition when any job_card under this
    // CO's POs has a completedDate stamped. CO-parity twin of the SO Cancel
    // block in routes/sales-orders.ts — stranded inventory would result if
    // we cascaded CANCELLED through completed work, so operators must first
    // clear the completion dates or reassign those finished units to another
    // order. Returns 409 Conflict (distinct from 4xx validation errors) so
    // the frontend can render a specific blocked-cancel modal.
    if (body.status === "CANCELLED" && existing.status !== "CANCELLED") {
      const blockingRes = await c.var.DB
        .prepare(
          `SELECT jc.id, jc.completedDate, jc.departmentCode, jc.departmentName, po.poNo
             FROM job_cards jc
             JOIN production_orders po ON po.id = jc.productionOrderId
            WHERE po.consignmentOrderId = ?
              AND jc.completedDate IS NOT NULL
              AND jc.completedDate <> ''
              AND jc.status NOT IN ('CANCELLED')
            ORDER BY jc.completedDate ASC
            LIMIT 5`,
        )
        .bind(id)
        .all<{
          id: string;
          completedDate: string;
          departmentCode: string | null;
          departmentName: string | null;
          poNo: string;
        }>();
      const blocking = blockingRes.results ?? [];
      if (blocking.length > 0) {
        const lockedDepts = Array.from(
          new Set(
            blocking
              .map((b) => b.departmentCode || b.departmentName || "")
              .filter((d) => d.length > 0),
          ),
        );
        return c.json(
          {
            success: false,
            error: "Cannot cancel — production has completed work",
            lockedDepts,
            blockingItems: blocking.map((b) => ({
              poNo: b.poNo,
              departmentCode: b.departmentCode || "",
              departmentName: b.departmentName || b.departmentCode || "Department",
              completedDate: b.completedDate,
            })),
            reason:
              "Clear completion dates or reassign these items to another order before cancelling.",
          },
          409,
        );
      }
    }

    const now = new Date().toISOString();

    // Header field updates — preserve existing values when not provided.
    const merged = {
      customerCO: body.customerCO ?? existing.customerCO ?? null,
      customerCOId: body.customerCOId ?? existing.customerCOId ?? null,
      customerCODate: body.customerCODate ?? existing.customerCODate ?? null,
      reference: body.reference ?? existing.reference ?? null,
      hubId: body.hubId ?? existing.hubId ?? null,
      hubName: body.hubName ?? existing.hubName ?? null,
      companyCODate: body.companyCODate ?? existing.companyCODate ?? null,
      customerDeliveryDate:
        body.customerDeliveryDate ?? existing.customerDeliveryDate ?? null,
      hookkaExpectedDD:
        body.hookkaExpectedDD ?? existing.hookkaExpectedDD ?? null,
      notes: body.notes ?? existing.notes ?? null,
      status: body.status ?? existing.status,
    };

    const stmts: D1PreparedStatement[] = [];

    // If items are provided, replace them (and recompute totals)
    let subtotalSen = existing.subtotalSen;
    let totalSen = existing.totalSen;
    if (Array.isArray(body.items)) {
      const itemsArr = body.items as Array<Record<string, unknown>>;

      // Hard restriction: SOFA + BEDFRAME may NOT coexist on a single CO.
      // Same rule as POST — see helper for the why. Validate before any
      // DB writes are queued.
      if (
        hasMixedSofaBedframe(
          itemsArr.map((it) => ({
            itemCategory:
              typeof it.itemCategory === "string" ? it.itemCategory : null,
          })),
        )
      ) {
        return c.json({ success: false, error: SO_MIXED_CATEGORY_ERROR }, 400);
      }

      // Sofa qty>1 — same rule as POST.
      {
        const offending = findInvalidSofaQty(
          itemsArr.map((it, i) => ({
            itemCategory:
              typeof it.itemCategory === "string" ? it.itemCategory : null,
            quantity:
              typeof it.quantity === "number"
                ? it.quantity
                : Number(it.quantity ?? 1),
            productCode:
              typeof it.productCode === "string" ? it.productCode : null,
            lineNo:
              typeof it.lineNo === "number" ? it.lineNo : i + 1,
          })),
        );
        if (offending) {
          return c.json(
            { success: false, error: formatSofaQtyError(offending) },
            400,
          );
        }
      }

      // Fabric integrity gate — see the POST handler. Validate before
      // queuing the DELETE so a bad payload can't wipe the existing
      // items and leave the CO with no lines.
      {
        const fabCheck = await validateFabricCodes(
          c.var.DB,
          itemsArr.map(
            (it) => (it.fabricCode as string | null | undefined),
          ),
        );
        if (!fabCheck.valid) {
          return c.json(unknownFabricCodeError(fabCheck.unknown), 400);
        }
      }

      // SOFA seat-size gate — see the POST handler.
      {
        const sofaCheck = await validateSofaSizeLabels(
          c.var.DB,
          itemsArr.map((it) => ({
            itemCategory: typeof it.itemCategory === "string" ? it.itemCategory : null,
            sizeLabel: typeof it.sizeLabel === "string" ? it.sizeLabel : null,
          })),
        );
        if (!sofaCheck.valid) {
          return c.json(
            unknownSofaSizeLabelError(sofaCheck.unknown, sofaCheck.allowed),
            400,
          );
        }
      }

      stmts.push(
        c.var.DB.prepare(
          "DELETE FROM consignment_order_items WHERE consignmentOrderId = ?",
        ).bind(id),
      );
      // OCR back-door closure (BUG-002 fix, 2026-05-09): catalog wins on CO
      // PUT. Same shape as SO PUT — when productCode resolves to a catalog
      // product, that product is the source of truth for productId/productName/
      // itemCategory/sizeLabel(BF/ACC)/sizeCode(BF/ACC).
      const productByCodeForCoPut = await loadProductCatalog(c.var.DB);
      // Price resolution — IDENTICAL to SO PUT (owner 2026-06-11): SOFA lines
      // ALWAYS re-derive their base from the price list (add a piece → the
      // combo pass discounts the new set; remove a piece → survivors return
      // to full per-piece price); other lines resolve only when the request
      // carries no price. No RM0 gate, per owner.
      const coPutCustomerId =
        (typeof body.customerId === "string" && body.customerId) ||
        existing.customerId ||
        "";
      const coPutAsOf = new Date().toISOString().slice(0, 10);
      const rawPutItems = body.items as Array<Record<string, unknown>>;
      const newRows = await Promise.all(
        rawPutItems.map(async (it, idx) => {
          const qty = Number(it.quantity) || 1;
          const divanPrice = Number(it.divanPriceSen) || 0;
          const legPrice = Number(it.legPriceSen) || 0;
          const specialPrice = Number(it.specialOrderPriceSen) || 0;
          const snapped = snapItemToCatalog(
            {
              productCode: it.productCode,
              productId: it.productId,
              productName: it.productName,
              itemCategory: it.itemCategory,
              sizeCode: it.sizeCode,
              sizeLabel: it.sizeLabel,
            },
            productByCodeForCoPut,
          );
          const incomingBase = Number(it.basePriceSen) || 0;
          const isSofa = (snapped.itemCategory || "") === "SOFA";
          const basePrice =
            isSofa || incomingBase === 0
              ? await resolveLineBasePriceSen(c.var.DB, {
                  productId: snapped.productId || null,
                  customerId: coPutCustomerId,
                  asOf: coPutAsOf,
                  seatHeight: seatHeightOf(
                    it,
                    snapped.sizeCode || null,
                    snapped.sizeLabel || null,
                  ),
                  fallbackSen: isSofa ? 0 : incomingBase,
                })
              : incomingBase;
          const unitPrice = basePrice + divanPrice + legPrice + specialPrice;
          // Per-line discount (migration 0179). Clamped ≥ 0.
          const discountSen = Math.max(0, Math.round(Number(it.discountSen) || 0));
          return {
            id: (it.id as string) || `coi-${crypto.randomUUID().slice(0, 8)}`,
            consignmentOrderId: id,
            lineNo: Number(it.lineNo) || idx + 1,
            lineSuffix: (it.lineSuffix as string) ?? null,
            productId: snapped.productId || null,
            productCode: snapped.productCode || null,
            productName: snapped.productName || null,
            itemCategory: snapped.itemCategory || null,
            sizeCode: snapped.sizeCode || null,
            sizeLabel: snapped.sizeLabel || null,
            fabricCode: ((it.fabricCode as string) ?? null) as string | null,
            quantity: qty,
            gapInches: it.gapInches != null ? Number(it.gapInches) : null,
            divanHeightInches:
              it.divanHeightInches != null ? Number(it.divanHeightInches) : null,
            divanPriceSen: divanPrice,
            legHeightInches:
              it.legHeightInches != null ? Number(it.legHeightInches) : null,
            legPriceSen: legPrice,
            specialOrder: (it.specialOrder as string) ?? null,
            specialOrderPriceSen: specialPrice,
            basePriceSen: basePrice,
            unitPriceSen: unitPrice,
            discountSen,
            lineTotalSen: Math.max(0, unitPrice * qty - discountSen),
            notes: (it.notes as string) ?? null,
          };
        }),
      );
      // Sofa combo renegotiation — same engine as Sales Orders.
      await runSofaComboPass(c.var.DB, coPutCustomerId, newRows, rawPutItems);
      let runningSubtotal = 0;
      for (const r of newRows) {
        runningSubtotal += r.lineTotalSen;
        stmts.push(
          c.var.DB.prepare(
            `INSERT INTO consignment_order_items (id, consignmentOrderId, lineNo, lineSuffix,
               productId, productCode, productName, itemCategory, sizeCode, sizeLabel,
               fabricCode, quantity, gapInches, divanHeightInches, divanPriceSen,
               legHeightInches, legPriceSen, specialOrder, specialOrderPriceSen,
               basePriceSen, unitPriceSen, discountSen, lineTotalSen, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            r.id,
            r.consignmentOrderId,
            r.lineNo,
            r.lineSuffix,
            r.productId,
            r.productCode,
            r.productName,
            r.itemCategory,
            r.sizeCode,
            r.sizeLabel,
            r.fabricCode,
            r.quantity,
            r.gapInches,
            r.divanHeightInches,
            r.divanPriceSen,
            r.legHeightInches,
            r.legPriceSen,
            r.specialOrder,
            r.specialOrderPriceSen,
            r.basePriceSen,
            r.unitPriceSen,
            r.discountSen,
            r.lineTotalSen,
            r.notes,
          ),
        );
      }
      subtotalSen = runningSubtotal;
      totalSen = runningSubtotal;
    }

    stmts.push(
      c.var.DB.prepare(
        `UPDATE consignment_orders SET
           customerCO = ?, customerCOId = ?, customerCODate = ?, reference = ?,
           hubId = ?, hubName = ?, companyCODate = ?, customerDeliveryDate = ?,
           hookkaExpectedDD = ?, subtotalSen = ?, totalSen = ?, status = ?,
           notes = ?, hold_reason = ?, held_by = ?, held_at = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(
        merged.customerCO,
        merged.customerCOId,
        merged.customerCODate,
        merged.reference,
        merged.hubId,
        merged.hubName,
        merged.companyCODate,
        merged.customerDeliveryDate,
        merged.hookkaExpectedDD,
        subtotalSen,
        totalSen,
        merged.status,
        merged.notes,
        // ON HOLD reason (0185). Set on → ON_HOLD (the gate above already
        // proved a non-empty reason); NULLed on a transition out of / not into
        // hold; preserved when the status is unchanged (header-only edit).
        merged.status === "ON_HOLD" && merged.status !== existing.status
          ? (body.holdReason as string).trim()
          : merged.status !== existing.status
            ? null
            : existing.holdReason ?? existing.hold_reason ?? null,
        merged.status === "ON_HOLD" && merged.status !== existing.status
          ? ((body.changedBy as string) || "Admin")
          : merged.status !== existing.status
            ? null
            : existing.heldBy ?? existing.held_by ?? null,
        merged.status === "ON_HOLD" && merged.status !== existing.status
          ? now
          : merged.status !== existing.status
            ? null
            : existing.heldAt ?? existing.held_at ?? null,
        now,
        id,
      ),
    );

    // Cascade through to the CO's child production_orders + job_cards.
    // Mirrors cascadeSOStatusToPOs in routes/sales-orders.ts.
    // Tier A fix 2026-05-21: also triggers on ON_HOLD and RESUME
    // transitions (the function now handles all 3 branches; the
    // ON_HOLD cascade gap was the silent-bug Agent A audit flagged).
    let cascadedPoCount = 0;
    if (
      merged.status !== existing.status &&
      (merged.status === "CANCELLED" ||
        merged.status === "ON_HOLD" ||
        (existing.status === "ON_HOLD" &&
          (merged.status === "CONFIRMED" ||
            merged.status === "IN_PRODUCTION")))
    ) {
      const cascade = await cascadeCOStatusToPOs(
        c.var.DB,
        id,
        merged.status,
        now,
        existing.status,
      );
      stmts.push(...cascade.statements);
      cascadedPoCount = cascade.affectedPoCount;
    }

    await c.var.DB.batch(stmts);

    // Same reason as the SO side (sales-orders.ts, the ON_HOLD cascade
    // comment): the dept sheets serve a cache-aside snapshot behind a KV body,
    // and neither notices a production_orders.status write made from this
    // module. Without this the CO hold stays invisible on the floor — the very
    // symptom quoted in cascadeCOStatusToPOs ("my CO 设 ON_HOLD 但…"). Wipe both
    // layers; best-effort, the cascade has already committed.
    if (cascadedPoCount > 0) {
      try {
        const orgId = getOrgId(c);
        await invalidateOrderCascadeSnapshots(c.var.DB, orgId, "consignment");
        await bumpPoListCacheVersion(c, orgId);
      } catch (err) {
        console.warn(
          "[co-status-cascade] cache invalidation failed:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const [updated, items] = await Promise.all([
      c.var.DB.prepare("SELECT * FROM consignment_orders WHERE id = ?")
        .bind(id)
        .first<ConsignmentOrderRow>(),
      c.var.DB.prepare(
        "SELECT * FROM consignment_order_items WHERE consignmentOrderId = ?",
      )
        .bind(id)
        .all<ConsignmentOrderItemRow>(),
    ]);
    if (!updated) {
      return c.json(
        { success: false, error: "Failed to reload after update" },
        500,
      );
    }
    return c.json({
      success: true,
      data: rowToCO(updated, items.results ?? []),
    });
  } catch (err) {
    console.error("[PUT /api/consignment-orders/:id] failed:", err);
    const message = err instanceof Error ? err.message : "Invalid request body";
    return c.json({ success: false, error: message }, 400);
  }
});

// ---------------------------------------------------------------------------
// POST /api/consignment-orders/:id/cancel — soft-cancel a non-DRAFT order.
//
// The "right semantic" for non-DRAFT orders the operator no longer wants:
// the row stays in the DB (audit trail, finance reports, downstream
// references all keep pointing at a real record) but `status = CANCELLED`
// blocks any further action. Hard-delete is reserved for DRAFTs that have
// never spawned production / consignment-note / inventory rows.
//
// Allowed transitions:
//   DRAFT     → CANCELLED  (operator preference over hard-delete)
//   CONFIRMED → CANCELLED  (main use case — backed out before production)
//   IN_PRODUCTION → 400    ("pause production first")
//   DELIVERED → 400        ("issue a credit note instead")
//   CANCELLED → no-op success (idempotent)
//
// Body (optional): { reason: string } → cancellation_reason column.
// ---------------------------------------------------------------------------
app.post("/:id/cancel", async (c) => {
  const denied = await requirePermission(c, "consignments", "update");
  if (denied) return denied;
  const id = c.req.param("id");

  const existing = await c.var.DB.prepare(
    "SELECT * FROM consignment_orders WHERE id = ?",
  )
    .bind(id)
    .first<ConsignmentOrderRow>();
  if (!existing) {
    return c.json(
      { success: false, error: "Consignment order not found" },
      404,
    );
  }

  // Idempotent — already cancelled, just return current state.
  if (existing.status === "CANCELLED") {
    const items = await c.var.DB
      .prepare(
        "SELECT * FROM consignment_order_items WHERE consignmentOrderId = ?",
      )
      .bind(id)
      .all<ConsignmentOrderItemRow>();
    return c.json({
      success: true,
      data: rowToCO(existing, items.results ?? []),
    });
  }

  if (existing.status === "IN_PRODUCTION") {
    return c.json(
      {
        success: false,
        error:
          "Cannot cancel an order that's already in production. Pause production first or contact admin.",
      },
      400,
    );
  }
  if (existing.status === "DELIVERED") {
    return c.json(
      {
        success: false,
        error:
          "Cannot cancel a delivered order. Issue a credit note instead.",
      },
      400,
    );
  }
  // Anything other than DRAFT / CONFIRMED at this point is also blocked —
  // SHIPPED / PARTIALLY_SOLD / FULLY_SOLD / RETURNED / CLOSED / ON_HOLD all
  // represent post-production states where cancellation would orphan
  // committed work. Be explicit so unexpected statuses don't sneak through.
  if (existing.status !== "DRAFT" && existing.status !== "CONFIRMED") {
    return c.json(
      {
        success: false,
        error: `Cannot cancel an order in status ${existing.status}.`,
      },
      400,
    );
  }

  // Optional reason. Empty body is fine — we don't require JSON at all.
  let reason: string | null = null;
  try {
    const body = (await c.req.json().catch(() => null)) as
      | { reason?: unknown }
      | null;
    if (body && typeof body.reason === "string" && body.reason.trim()) {
      reason = body.reason.trim();
    }
  } catch {
    // No body or invalid JSON — treat as no reason supplied.
    reason = null;
  }

  const now = new Date().toISOString();

  // Build cascade statements BEFORE the CO UPDATE so they all run in one
  // batch. Without this, the CO's child POs stay PENDING/IN_PROGRESS and
  // leak into the CN Planning view (Wei Siang, 2026-05-05).
  const cascade = await cascadeCOStatusToPOs(
    c.var.DB,
    id,
    "CANCELLED",
    now,
  );
  const stmts: ReturnType<D1Database["prepare"]>[] = [
    c.var.DB
      .prepare(
        `UPDATE consignment_orders
            SET status = 'CANCELLED',
                cancelled_at = ?,
                cancellation_reason = ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .bind(now, reason, now, id),
    ...cascade.statements,
  ];
  await c.var.DB.batch(stmts);

  const [updated, items] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM consignment_orders WHERE id = ?")
      .bind(id)
      .first<ConsignmentOrderRow>(),
    c.var.DB.prepare(
      "SELECT * FROM consignment_order_items WHERE consignmentOrderId = ?",
    )
      .bind(id)
      .all<ConsignmentOrderItemRow>(),
  ]);
  if (!updated) {
    return c.json(
      { success: false, error: "Failed to reload after cancel" },
      500,
    );
  }
  return c.json({
    success: true,
    data: rowToCO(updated, items.results ?? []),
    cascade: {
      affectedPoCount: cascade.affectedPoCount,
      affectedJcCount: cascade.affectedJcCount,
      poNos: cascade.poNos,
    },
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/consignment-orders/:id/hub — change the delivery hub for a CO.
//
// Same rule as the SO variant: hub is editable until the goods have
// physically left the warehouse. For CO, "shipped" means at least one
// linked Consignment Note has moved past ACTIVE (i.e. PARTIALLY_SOLD /
// FULLY_SOLD / RETURNED / CLOSED — or dispatched_at is stamped).
//
// :id may be the CO's UUID PK or the user-visible companyCOId code
// (CO-2605-NNN). Body: { hubId: string, reason?: string }.
// ---------------------------------------------------------------------------
app.patch("/:id/hub", async (c) => {
  const denied = await requirePermission(c, "consignments", "update");
  if (denied) return denied;
  const idParam = c.req.param("id");
  try {
    const body = await c.req.json().catch(() => ({}));
    const newHubId = typeof body.hubId === "string" ? body.hubId.trim() : "";
    const reason =
      typeof body.reason === "string" ? body.reason.trim() : "";
    if (!newHubId) {
      return c.json({ success: false, error: "hubId is required" }, 400);
    }

    // 1. Resolve the CO by either UUID PK or companyCOId.
    const co = await c.var.DB
      .prepare(
        `SELECT * FROM consignment_orders
          WHERE id = ?
             OR companyCOId ILIKE ?
          LIMIT 1`,
      )
      .bind(idParam, idParam)
      .first<ConsignmentOrderRow>();
    if (!co) {
      return c.json(
        { success: false, error: "Consignment order not found" },
        404,
      );
    }

    // 2. Resolve the new hub.
    const hub = await c.var.DB
      .prepare(
        "SELECT id, shortName, state, customerId FROM delivery_hubs WHERE id = ?",
      )
      .bind(newHubId)
      .first<{
        id: string;
        shortName: string;
        state: string | null;
        customerId: string;
      }>();
    if (!hub) {
      return c.json({ success: false, error: "Hub not found" }, 404);
    }

    // 3. Hub must belong to the same customer.
    if (hub.customerId !== co.customerId) {
      return c.json(
        {
          success: false,
          error: "Hub does not belong to this customer",
        },
        400,
      );
    }

    // 4. Shipment-state guard. A CO ships via consignment_notes (CN).
    //    CN status starts at ACTIVE (pending dispatch) and flips to
    //    PARTIALLY_SOLD on the first Mark Dispatched click. Any CN
    //    past ACTIVE OR with dispatched_at stamped means the goods
    //    have left the warehouse and the hub is frozen.
    const shippedCnRes = await c.var.DB
      .prepare(
        `SELECT noteNumber, status
           FROM consignment_notes
          WHERE consignmentOrderId = ?
            AND (status <> 'ACTIVE' OR dispatchedAt IS NOT NULL)
          ORDER BY noteNumber
          LIMIT 1`,
      )
      .bind(co.id)
      .first<{ noteNumber: string | null; status: string | null }>();
    if (shippedCnRes) {
      return c.json(
        {
          success: false,
          code: "HUB_LOCKED_SHIPPED",
          error: `Hub cannot be changed once goods have left the hub. CN ${shippedCnRes.noteNumber ?? "(unknown)"} is already in ${shippedCnRes.status ?? "(unknown)"}.`,
          blockingDoNo: shippedCnRes.noteNumber ?? "",
          blockingDoStatus: shippedCnRes.status ?? "",
        },
        409,
      );
    }

    // 5. Early-exit if the hub didn't actually change.
    if (co.hubId === hub.id) {
      const same = await c.var.DB
        .prepare("SELECT * FROM consignment_orders WHERE id = ?")
        .bind(co.id)
        .first<ConsignmentOrderRow>();
      return c.json({
        success: true,
        data: same ? rowToCO(same, []) : null,
        cascade: {
          productionOrdersUpdated: 0,
          consignmentNotesUpdated: 0,
          warningDOs: [],
          noop: true,
        },
      });
    }

    // 6. Discover downstream rows.
    const now = new Date().toISOString();
    const beforeSnap = { hubId: co.hubId, hubName: co.hubName };
    const afterSnap: Record<string, unknown> = {
      hubId: hub.id,
      hubName: hub.shortName,
    };
    if (reason) afterSnap.reason = reason;

    // 6a. production_orders — has no hubId / hubName columns (production
    //     sheet joins back to the parent CO for those), but DOES have a
    //     denormalized `customerState` column populated at PO creation
    //     (production-orders.ts ~line 5008, INSERT INTO production_orders
    //     ... customerState). Delivery Planning page reads po.customerState
    //     directly (src/pages/delivery/index.tsx:889), so a stale value
    //     here makes the operator see the OLD state on a row whose parent
    //     CO has just moved to a different hub.
    //
    //     Update WITHOUT a status filter: even COMPLETED POs may be
    //     reprinted on the production sheet / fabric tag and must show
    //     the correct state. Per BUG-2026-05-30-006 audit + operator
    //     direction "production sheet must show new state even for
    //     COMPLETED POs".
    const posRes = await c.var.DB
      .prepare(
        `SELECT id, customerState
           FROM production_orders
          WHERE consignmentOrderId = ?`,
      )
      .bind(co.id)
      .all<{ id: string; customerState: string | null }>();
    const poRows = posRes.results ?? [];

    // 6b. consignment_notes — pre-dispatch only. CN has hubId (FK) and
    //     branchName (denormalized shortName, mirrors the DO.hubName
    //     pattern). Update both. No customer_state column on CN.
    const cnsRes = await c.var.DB
      .prepare(
        `SELECT id, noteNumber, hubId, branchName
           FROM consignment_notes
          WHERE consignmentOrderId = ?
            AND status = 'ACTIVE'
            AND dispatchedAt IS NULL`,
      )
      .bind(co.id)
      .all<{
        id: string;
        noteNumber: string | null;
        hubId: string | null;
        branchName: string | null;
      }>();
    const cnRows = cnsRes.results ?? [];

    // 7. Build the batch (single transaction).
    const auditAfter = {
      ...afterSnap,
      parentCOId: co.id,
      parentCOCode: co.companyCOId,
    };
    const stmts: import("@cloudflare/workers-types").D1PreparedStatement[] = [];

    stmts.push(
      c.var.DB
        .prepare(
          `UPDATE consignment_orders
              SET hubId = ?, hubName = ?, customerState = ?, updated_at = ?
            WHERE id = ?`,
        )
        .bind(
          hub.id,
          hub.shortName,
          hub.state ?? co.customerState ?? null,
          now,
          co.id,
        ),
    );
    const coAudit = await buildAuditStatement(c, {
      resource: "consignment-orders",
      resourceId: co.id,
      action: "hub-change",
      before: beforeSnap,
      after: afterSnap,
    });
    if (coAudit) stmts.push(coAudit);

    // Effective state — same fallback chain the CO header uses above.
    const effectiveState = hub.state ?? co.customerState ?? null;
    const poAfter: Record<string, unknown> = {
      customerState: effectiveState,
      parentCOId: co.id,
      parentCOCode: co.companyCOId,
    };
    if (reason) poAfter.reason = reason;

    for (const po of poRows) {
      stmts.push(
        c.var.DB
          .prepare(
            `UPDATE production_orders
                SET customerState = ?, updated_at = ?
              WHERE id = ?`,
          )
          .bind(effectiveState, now, po.id),
      );
      const a = await buildAuditStatement(c, {
        resource: "production-orders",
        resourceId: po.id,
        action: "hub-cascade-from-co",
        before: { customerState: po.customerState },
        after: poAfter,
      });
      if (a) stmts.push(a);
    }

    for (const cn of cnRows) {
      stmts.push(
        c.var.DB
          .prepare(
            `UPDATE consignment_notes
                SET hubId = ?, branchName = ?
              WHERE id = ?`,
          )
          .bind(hub.id, hub.shortName, cn.id),
      );
      const a = await buildAuditStatement(c, {
        resource: "consignment-notes",
        resourceId: cn.id,
        action: "hub-cascade-from-co",
        before: { hubId: cn.hubId, branchName: cn.branchName },
        after: auditAfter,
      });
      if (a) stmts.push(a);
    }

    // service_orders — destination inherited from this CO at service-order
    // creation (service-orders.ts, 2026-06-11). Same rule as the SO cascade:
    // the service order follows its source. try/catch: the hubId column
    // self-applies on first service-order POST; an isolate without it has no
    // stored hubs to go stale (the DO path live-derives those from this CO).
    try {
      const svcRes = await c.var.DB
        .prepare(
          `SELECT id, hubId FROM service_orders
            WHERE sourceType = 'CO' AND sourceId = ?`,
        )
        .bind(co.id)
        .all<{ id: string; hubId: string | null }>();
      for (const svc of svcRes.results ?? []) {
        stmts.push(
          c.var.DB
            .prepare(`UPDATE service_orders SET hubId = ? WHERE id = ?`)
            .bind(hub.id, svc.id),
        );
        const a = await buildAuditStatement(c, {
          resource: "service-orders",
          resourceId: svc.id,
          action: "hub-cascade-from-co",
          before: { hubId: svc.hubId },
          after: auditAfter,
        });
        if (a) stmts.push(a);
      }
    } catch {
      // hubId column not present on this isolate yet — nothing stored, skip.
    }

    // 6c. fg_units — packing-sticker branch. Propagate the new hub to this
    //     CO's in-stock FG units so their packing stickers follow the hub
    //     change. Hub change is blocked once goods leave (guard above), so
    //     these are all pre-dispatch; the status filter is belt-and-braces.
    //     Part of the BUG-2026-06-05 sticker-hub fix.
    if (poRows.length > 0) {
      stmts.push(
        c.var.DB
          .prepare(
            "UPDATE fg_units SET customerHub = ? WHERE poId IN (SELECT id FROM production_orders WHERE consignmentOrderId = ?) AND status NOT IN ('LOADED','DELIVERED','RETURNED')",
          )
          .bind(hub.shortName, co.id),
      );
    }

    await c.var.DB.batch(stmts);

    // 7b. Belt-and-braces snapshot invalidation. The cache-aside helpers
    //     (src/api/lib/snapshot.ts) would normally auto-invalidate via
    //     updated_at bumps on the source tables, but consignment_notes has
    //     NO updated_at column (only created_at) — confirmed against
    //     information_schema. The CN-stats snapshot therefore cannot detect
    //     a CN row update via the freshness probe and would serve stale
    //     branchName / hubId rows forever (until the Layer 3 nightly
    //     rebuild). Wipe the affected snapshot rows here so the next CO
    //     stats / CN stats / Production / Dashboard fetch GUARANTEES a
    //     recompute. Internally swallows per-snapshot errors — a wipe
    //     failure must not fail the hub edit (the cascade has already
    //     committed).
    await invalidateHubChangeSnapshots(c.var.DB, getOrgId(c), "consignment");

    // 8. Return refreshed CO header + cascade counts.
    const updated = await c.var.DB
      .prepare("SELECT * FROM consignment_orders WHERE id = ?")
      .bind(co.id)
      .first<ConsignmentOrderRow>();
    return c.json({
      success: true,
      data: updated ? rowToCO(updated, []) : null,
      cascade: {
        productionOrdersUpdated: poRows.length,
        consignmentNotesUpdated: cnRows.length,
        warningDOs: [],
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      "[PATCH /api/consignment-orders/:id/hub] failed:",
      msg,
      err,
    );
    return c.json(
      { success: false, error: msg || "Internal error updating hub" },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/consignment-orders/:id (only DRAFT)
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const denied = await requirePermission(c, "consignments", "delete");
  if (denied) return denied;
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT status FROM consignment_orders WHERE id = ?",
  )
    .bind(id)
    .first<{ status: string }>();
  if (!existing) {
    return c.json(
      { success: false, error: "Consignment order not found" },
      404,
    );
  }
  if (existing.status !== "DRAFT") {
    return c.json(
      {
        success: false,
        error: "Only DRAFT consignment orders can be deleted",
      },
      400,
    );
  }
  await c.var.DB.prepare("DELETE FROM consignment_orders WHERE id = ?")
    .bind(id)
    .run();
  return c.json({ success: true });
});

export default app;
