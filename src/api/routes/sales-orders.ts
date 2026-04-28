// ---------------------------------------------------------------------------
// D1-backed sales-orders route.
//
// Mirrors the old src/api/routes/sales-orders.ts response shape so the SPA
// frontend does not need any changes. `items` is returned as a nested array
// joined from the sales_order_items table. Status history comes from
// so_status_changes and price-override history from price_overrides.
//
// Schema-note: D1 stores timestamps in `created_at`/`updated_at` (snake_case)
// while the TS types expose `createdAt`/`updatedAt` (camelCase). The row->API
// mapper handles the rename. `so_status_changes.autoActions` is a JSON blob.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";
import { emitAudit } from "../lib/audit";
import { calculateUnitPrice, calculateLineTotal } from "../../lib/pricing";
import {
  hasMixedSofaBedframe,
  SO_MIXED_CATEGORY_ERROR,
} from "../../lib/so-category";
import {
  ensureLeadTimesSeeded,
  loadLeadTimes,
  leadDaysFor,
  addDays,
  DEPT_ORDER,
  ensureHookkaDDBufferSeeded,
  loadHookkaDDBuffer,
  hookkaDDBufferFor,
} from "../lib/lead-times";
import { breakBomIntoWips, type BomVariantContext } from "../lib/bom-wip-breakdown";
import { resolveCustomerPriceAsOf } from "./customer-products";
import { withOrgScope } from "../lib/tenant";
import {
  createProductionOrdersForOrder,
  parseL1Processes,
  type CreatedProductionOrder,
} from "./_shared/production-builder";
import { checkSalesOrderLocked, lockedResponse } from "../lib/lock-helpers";
import {
  consumeEditLockOverrideToken,
  createEditLockOverride,
  lookupActorDisplayName,
  MIN_OVERRIDE_REASON_LEN,
} from "../lib/edit-lock-override";
import { readIdempotencyKey, withIdempotency } from "../lib/idempotency";

const app = new Hono<Env>();

export type SalesOrderRow = {
  id: string;
  customerPO: string | null;
  customerPOId: string | null;
  customerPODate: string | null;
  customerSO: string | null;
  customerSOId: string | null;
  reference: string | null;
  customerId: string;
  customerName: string;
  customerState: string | null;
  hubId: string | null;
  hubName: string | null;
  companySO: string | null;
  companySOId: string | null;
  companySODate: string | null;
  customerDeliveryDate: string | null;
  hookkaExpectedDD: string | null;
  hookkaDeliveryOrder: string | null;
  subtotalSen: number;
  totalSen: number;
  status: string;
  overdue: string | null;
  notes: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type SalesOrderItemRow = {
  id: string;
  salesOrderId: string;
  lineNo: number;
  lineSuffix: string | null;
  productId: string | null;
  productCode: string | null;
  productName: string | null;
  itemCategory: string | null;
  sizeCode: string | null;
  sizeLabel: string | null;
  fabricId: string | null;
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
  lineTotalSen: number;
  notes: string | null;
};

type SOStatusChangeRow = {
  id: string;
  soId: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  changedBy: string | null;
  timestamp: string;
  notes: string | null;
  autoActions: string | null;
};

type PriceOverrideRow = {
  id: string;
  soId: string | null;
  soNumber: string | null;
  lineIndex: number;
  originalPrice: number;
  overridePrice: number;
  reason: string | null;
  approvedBy: string | null;
  timestamp: string;
};

function rowToItem(r: SalesOrderItemRow) {
  return {
    id: r.id,
    lineNo: r.lineNo,
    lineSuffix: r.lineSuffix ?? `-${String(r.lineNo).padStart(2, "0")}`,
    productId: r.productId ?? "",
    productCode: r.productCode ?? "",
    productName: r.productName ?? "",
    itemCategory: r.itemCategory ?? "BEDFRAME",
    sizeCode: r.sizeCode ?? "",
    sizeLabel: r.sizeLabel ?? "",
    fabricId: r.fabricId ?? "",
    fabricCode: r.fabricCode ?? "",
    quantity: r.quantity,
    gapInches: r.gapInches,
    divanHeightInches: r.divanHeightInches,
    divanPriceSen: r.divanPriceSen,
    legHeightInches: r.legHeightInches,
    legPriceSen: r.legPriceSen,
    specialOrder: r.specialOrder ?? "",
    specialOrderPriceSen: r.specialOrderPriceSen,
    basePriceSen: r.basePriceSen,
    unitPriceSen: r.unitPriceSen,
    lineTotalSen: r.lineTotalSen,
    notes: r.notes ?? "",
  };
}

function rowToSO(row: SalesOrderRow, items: SalesOrderItemRow[] = []) {
  return {
    id: row.id,
    customerPO: row.customerPO ?? "",
    customerPOId: row.customerPOId ?? "",
    customerPODate: row.customerPODate ?? "",
    customerSO: row.customerSO ?? "",
    customerSOId: row.customerSOId ?? "",
    reference: row.reference ?? "",
    customerId: row.customerId,
    customerName: row.customerName,
    customerState: row.customerState ?? "",
    hubId: row.hubId,
    hubName: row.hubName ?? "",
    companySO: row.companySO ?? "",
    companySOId: row.companySOId ?? "",
    companySODate: row.companySODate ?? "",
    customerDeliveryDate: row.customerDeliveryDate ?? "",
    hookkaExpectedDD: row.hookkaExpectedDD ?? "",
    hookkaDeliveryOrder: row.hookkaDeliveryOrder ?? "",
    items: items
      .filter((i) => i.salesOrderId === row.id)
      .sort((a, b) => a.lineNo - b.lineNo)
      .map(rowToItem),
    subtotalSen: row.subtotalSen,
    totalSen: row.totalSen,
    status: row.status,
    overdue: row.overdue ?? "PENDING",
    notes: row.notes ?? "",
    createdAt: row.createdAt ?? "",
    updatedAt: row.updatedAt ?? "",
  };
}

// L1Process / parseL1Processes moved to _shared/production-builder.ts so
// the consignment-order path can share the same FG-level job-card logic.
// Re-imported above; backfillJobCardsForPo (below) still uses parseL1Processes.

function parseAutoActions(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

type IncompleteProduct = {
  productCode: string;
  productName: string;
  reason: string;
};

// BOM completeness guard: a product is confirm-incomplete when its ACTIVE
// bom_templates row is missing OR both wipComponents[] AND l1Processes[] are
// empty. Accessory SKUs (pillows) legitimately have empty wipComponents but
// at least one l1Process (FAB_CUT/FAB_SEW/PACKING), so those pass. Falls back
// to the most recent version if no ACTIVE row exists — mirrors the cascade's
// reverse-schedule lookup.
async function findIncompleteBomProducts(
  db: D1Database,
  items: SalesOrderItemRow[],
): Promise<IncompleteProduct[]> {
  const incomplete: IncompleteProduct[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const productCode = item.productCode ?? "";
    if (!item.productId || !productCode) continue;
    if (seen.has(productCode)) continue;
    seen.add(productCode);

    let bomRow = await db
      .prepare(
        `SELECT wipComponents, l1Processes FROM bom_templates
           WHERE productCode = ? AND versionStatus = 'ACTIVE'
           ORDER BY effectiveFrom DESC LIMIT 1`,
      )
      .bind(productCode)
      .first<{ wipComponents: string | null; l1Processes: string | null }>();
    if (!bomRow) {
      bomRow = await db
        .prepare(
          `SELECT wipComponents, l1Processes FROM bom_templates
             WHERE productCode = ? ORDER BY effectiveFrom DESC LIMIT 1`,
        )
        .bind(productCode)
        .first<{ wipComponents: string | null; l1Processes: string | null }>();
    }

    const parseLen = (raw: string | null): number => {
      if (!raw) return 0;
      try {
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.length : 0;
      } catch {
        return 0;
      }
    };

    const isIncomplete =
      !bomRow ||
      (parseLen(bomRow.wipComponents) === 0 &&
        parseLen(bomRow.l1Processes) === 0);

    if (isIncomplete) {
      incomplete.push({
        productCode,
        productName: item.productName ?? productCode,
        reason: !bomRow
          ? "No BOM template exists"
          : "BOM has no WIP components and no FG-level processes",
      });
    }
  }
  return incomplete;
}

function rowToStatusChange(r: SOStatusChangeRow) {
  return {
    id: r.id,
    soId: r.soId ?? "",
    fromStatus: r.fromStatus ?? "",
    toStatus: r.toStatus ?? "",
    changedBy: r.changedBy ?? "",
    timestamp: r.timestamp,
    notes: r.notes ?? "",
    autoActions: parseAutoActions(r.autoActions),
  };
}

function rowToPriceOverride(r: PriceOverrideRow) {
  return {
    id: r.id,
    soId: r.soId ?? "",
    soNumber: r.soNumber ?? "",
    lineIndex: r.lineIndex,
    originalPrice: r.originalPrice,
    overridePrice: r.overridePrice,
    reason: r.reason ?? "",
    approvedBy: r.approvedBy ?? "",
    timestamp: r.timestamp,
  };
}

function genSoId(): string {
  return `so-${crypto.randomUUID().slice(0, 8)}`;
}
function genItemId(): string {
  return `soi-${crypto.randomUUID().slice(0, 8)}`;
}
function genStatusId(): string {
  return `sc-${crypto.randomUUID().slice(0, 8)}`;
}
function genOverrideId(): string {
  return `po-${crypto.randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// SO-flavoured wrapper for the shared production-order builder. The bulk of
// the cascade logic (idempotency guard, BOM lookup, WIP breakdown, dept
// scheduling, INSERT statements for production_orders + job_cards) lives
// in `_shared/production-builder.ts` so the consignment-order path
// (consignments.ts) can drive the same pipeline without duplication.
//
// This wrapper exists for backward compatibility — every SO call site
// (line ~1909 confirm-handler, line ~2557 admin backfill) keeps the same
// signature it had before the refactor. New CO call sites should call
// `createProductionOrdersForOrder` directly with `sourceType: 'CO'`.
// ---------------------------------------------------------------------------
export async function createProductionOrdersForSO(
  db: D1Database,
  so: SalesOrderRow,
  items: SalesOrderItemRow[],
): Promise<{ statements: D1PreparedStatement[]; created: CreatedProductionOrder[]; preExisting: boolean }> {
  return createProductionOrdersForOrder(
    db,
    {
      id: so.id,
      sourceType: "SO",
      companyOrderId: so.companySOId ?? "",
      companyOrderDate: so.companySODate,
      customerPOId: so.customerPOId,
      reference: so.reference,
      customerName: so.customerName,
      customerState: so.customerState,
      hookkaExpectedDD: so.hookkaExpectedDD,
      customerDeliveryDate: so.customerDeliveryDate,
    },
    items.map((it) => ({
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
}

// ---------------------------------------------------------------------------
// backfillJobCardsForPo — build the job_cards batch for an already-existing
// production_orders row that has zero job_cards. Used by the one-shot
// admin backfill endpoint below. Idempotent: checks for existing job_cards
// and returns [] if any are present.
// ---------------------------------------------------------------------------
async function backfillJobCardsForPo(
  db: D1Database,
  poId: string,
): Promise<{ statements: D1PreparedStatement[]; jcCount: number; currentDept: string | null }> {
  await ensureLeadTimesSeeded(db);
  await ensureHookkaDDBufferSeeded(db);
  const leadTimes = await loadLeadTimes(db);
  const hookkaDDBuffer = await loadHookkaDDBuffer(db);

  // Skip if any job_cards already exist.
  const existingJc = await db
    .prepare("SELECT id FROM job_cards WHERE productionOrderId = ? LIMIT 1")
    .bind(poId)
    .first<{ id: string }>();
  if (existingJc) {
    return { statements: [], jcCount: 0, currentDept: null };
  }

  const po = await db
    .prepare("SELECT * FROM production_orders WHERE id = ?")
    .bind(poId)
    .first<ProductionOrderRow>();
  if (!po) {
    return { statements: [], jcCount: 0, currentDept: null };
  }
  const so = po.salesOrderId
    ? await db
        .prepare("SELECT * FROM sales_orders WHERE id = ?")
        .bind(po.salesOrderId)
        .first<SalesOrderRow>()
    : null;

  const category = po.itemCategory ?? "BEDFRAME";
  const productCode = po.productCode ?? "";
  // Prefer explicit hookkaExpectedDD; else customerDD − buffer; else
  // po.targetEndDate (already internal target from prior cascades).
  const explicitHookkaDD = so?.hookkaExpectedDD || "";
  const customerDD = so?.customerDeliveryDate || "";
  const bufferDays = hookkaDDBufferFor(hookkaDDBuffer, category);
  const packingAnchor = explicitHookkaDD
    ? explicitHookkaDD
    : customerDD
    ? addDays(customerDD, -bufferDays)
    : po.targetEndDate || "";
  const startDate = so?.companySODate || po.startDate || new Date().toISOString().split("T")[0];

  const deptRes = await db
    .prepare("SELECT id, code, name FROM departments").all<{ id: string; code: string; name: string }>();
  const deptByCode = new Map<string, { id: string; name: string }>();
  for (const d of deptRes.results ?? []) {
    deptByCode.set(d.code, { id: d.id, name: d.name });
  }

  let bomRow = await db
    .prepare(
      `SELECT wipComponents, l1Processes, baseModel FROM bom_templates
         WHERE productCode = ? AND versionStatus = 'ACTIVE'
         ORDER BY effectiveFrom DESC LIMIT 1`,
    )
    .bind(productCode)
    .first<{
      wipComponents: string | null;
      l1Processes: string | null;
      baseModel: string | null;
    }>();
  if (!bomRow) {
    bomRow = await db
      .prepare(
        `SELECT wipComponents, l1Processes, baseModel FROM bom_templates
           WHERE productCode = ? ORDER BY effectiveFrom DESC LIMIT 1`,
      )
      .bind(productCode)
      .first<{
        wipComponents: string | null;
        l1Processes: string | null;
        baseModel: string | null;
      }>();
  }
  const backfillVariants: BomVariantContext = {
    productCode: po.productCode ?? "",
    // Parent model — see BUG-2026-04-27-004.
    model: bomRow?.baseModel ?? (po.productCode ?? ""),
    sizeLabel: po.sizeLabel ?? "",
    sizeCode: po.sizeCode ?? "",
    fabricCode: po.fabricCode ?? "",
    divanHeightInches: po.divanHeightInches ?? null,
    legHeightInches: po.legHeightInches ?? null,
    gapInches: po.gapInches ?? null,
  };
  const wips = breakBomIntoWips(
    bomRow?.wipComponents ?? null,
    productCode,
    backfillVariants,
  );

  const statements: D1PreparedStatement[] = [];
  let currentDept = po.currentDepartment ?? "FAB_CUT";
  let currentDeptIdx = 999;
  let jcCount = 0;

  for (const wip of wips) {
    const wipQty = Math.max(1, Math.floor((po.quantity || 1) * wip.quantityMultiplier));
    const chain = wip.processes;

    const planned: Array<{
      deptCode: string;
      deptId: string;
      deptName: string;
      sequence: number;
      dueDate: string;
      category: string;
      minutes: number;
      branchKey: string;
    }> = [];

    if (packingAnchor) {
      // Same parallel-dept semantics as the confirm path above:
      // dueDate = anchor - leadDays[dept] for every dept independently.
      const anchor = explicitHookkaDD || customerDD || packingAnchor;
      for (let i = 0; i < chain.length; i++) {
        const p = chain[i];
        const deptMeta = deptByCode.get(p.deptCode);
        if (!deptMeta) continue;
        const leadDays = leadDaysFor(leadTimes, category, p.deptCode);
        planned.push({
          deptCode: p.deptCode,
          deptId: deptMeta.id,
          deptName: deptMeta.name,
          sequence: i,
          dueDate: addDays(anchor, -leadDays),
          category: p.category,
          minutes: p.minutes,
          branchKey: p.branchKey ?? "",
        });
      }
    } else {
      let cursor = startDate;
      for (let i = 0; i < chain.length; i++) {
        const p = chain[i];
        const deptMeta = deptByCode.get(p.deptCode);
        const leadDays = leadDaysFor(leadTimes, category, p.deptCode);
        cursor = addDays(cursor, leadDays);
        if (!deptMeta) continue;
        planned.push({
          deptCode: p.deptCode,
          deptId: deptMeta.id,
          deptName: deptMeta.name,
          sequence: i,
          dueDate: cursor,
          category: p.category,
          minutes: p.minutes,
          branchKey: p.branchKey ?? "",
        });
      }
    }

    for (const p of planned) {
      const idx = DEPT_ORDER.indexOf(p.deptCode as (typeof DEPT_ORDER)[number]);
      if (idx >= 0 && idx < currentDeptIdx) {
        currentDeptIdx = idx;
        currentDept = p.deptCode;
      }
      const deptWipCode = chain[p.sequence]?.wipCode || wip.wipCode;
      const deptWipLabel = chain[p.sequence]?.wipLabel || wip.wipLabel;
      // Scope jcId by wipKey (stable per top-level WIP) not wipCode, so two
      // WIPs that share a leaf node name (e.g. both DIVAN and HEADBOARD carry
      // a "Frame" node) don't collapse into a single job_card row.
      const jcId = `jc-${poId}-${wip.wipKey}-${p.deptCode}`
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 128);
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO job_cards (id, productionOrderId, departmentId, departmentCode,
               departmentName, sequence, status, dueDate, wipKey, wipCode, wipType, wipLabel,
               wipQty, prerequisiteMet, pic1Id, pic1Name, pic2Id, pic2Name, completedDate,
               estMinutes, actualMinutes, category, productionTimeMinutes, overdue, rackingNumber, branchKey)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            jcId,
            poId,
            p.deptId,
            p.deptCode,
            p.deptName,
            p.sequence,
            "WAITING",
            p.dueDate,
            wip.wipKey,
            deptWipCode,
            wip.wipType,
            deptWipLabel,
            wipQty,
            p.sequence === 0 ? 1 : 0,
            null,
            "",
            null,
            "",
            null,
            p.minutes,
            null,
            p.category,
            p.minutes,
            "PENDING",
            null,
            // BOM-walker emitted branchKey on each process — use it
            // directly; no category lookup needed.
            p.branchKey ?? "",
          ),
      );
      jcCount++;
    }
  }

  // ------ job_cards — FG-level (one per l1Process) ------
  // Matches createProductionOrdersForSO: anything the BOM declares at
  // FG level (l1Processes JSON) becomes a single job card attached to
  // the PO, with wipKey="FG" and wipQty=po.quantity so the sticker
  // renderer treats it as one assembled unit (see generate-sticker-pdf
  // for the piece-counting logic).
  const l1Procs = parseL1Processes(bomRow?.l1Processes ?? null);
  const packingDue = po.targetEndDate || po.startDate || "";
  for (const l1p of l1Procs) {
    const deptMeta = deptByCode.get(l1p.deptCode);
    if (!deptMeta) continue;
    const jcId = `jc-${po.id}-FG-${l1p.deptCode}`
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 128);
    statements.push(
      db
        .prepare(
          `INSERT OR IGNORE INTO job_cards (id, productionOrderId, departmentId, departmentCode,
             departmentName, sequence, status, dueDate, wipKey, wipCode, wipType, wipLabel,
             wipQty, prerequisiteMet, pic1Id, pic1Name, pic2Id, pic2Name, completedDate,
             estMinutes, actualMinutes, category, productionTimeMinutes, overdue, rackingNumber, branchKey)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          jcId,
          po.id,
          deptMeta.id,
          l1p.deptCode,
          deptMeta.name,
          99,
          "WAITING",
          packingDue,
          "FG",
          productCode,
          "FG",
          productCode,
          po.quantity || 1,
          0,
          null,
          "",
          null,
          "",
          null,
          l1p.minutes,
          null,
          l1p.category,
          l1p.minutes,
          "PENDING",
          null,
          // FG-level UPHOLSTERY/PACKING — joint terminal, branchKey="".
          "",
        ),
    );
    jcCount++;
  }

  if (statements.length > 0) {
    statements.push(
      db
        .prepare("UPDATE production_orders SET currentDepartment = ? WHERE id = ?")
        .bind(currentDept, poId),
    );
  }

  return { statements, jcCount, currentDept };
}

// Minimal inline type used by backfillJobCardsForPo.
type ProductionOrderRow = {
  id: string;
  salesOrderId: string | null;
  productCode: string | null;
  itemCategory: string | null;
  sizeLabel: string | null;
  sizeCode: string | null;
  fabricCode: string | null;
  divanHeightInches: number | null;
  legHeightInches: number | null;
  gapInches: number | null;
  quantity: number;
  currentDepartment: string | null;
  targetEndDate: string | null;
  startDate: string | null;
};

// Generate next SO number by scanning existing companySOId values for the
// current YYMM prefix and incrementing the max sequence. Falls back to 001.
async function generateCompanySOId(db: D1Database): Promise<string> {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prefix = `SO-${yymm}-`;
  const res = await db
    .prepare(
      "SELECT companySOId FROM sales_orders WHERE companySOId LIKE ? ORDER BY companySOId DESC LIMIT 1",
    )
    .bind(`${prefix}%`)
    .first<{ companySOId: string }>();
  const seq = res?.companySOId
    ? Number(res.companySOId.split("-").pop()) + 1
    : 1;
  return `${prefix}${String(seq).padStart(3, "0")}`;
}

async function fetchSOWithItems(
  db: D1Database,
  id: string,
): Promise<ReturnType<typeof rowToSO> | null> {
  const [so, itemsRes] = await Promise.all([
    db
      .prepare("SELECT * FROM sales_orders WHERE id = ?")
      .bind(id)
      .first<SalesOrderRow>(),
    db
      .prepare("SELECT * FROM sales_order_items WHERE salesOrderId = ?")
      .bind(id)
      .all<SalesOrderItemRow>(),
  ]);
  if (!so) return null;
  return rowToSO(so, itemsRes.results ?? []);
}

// ---------------------------------------------------------------------------
// cascadeSOStatusToPOs — ON_HOLD / CANCELLED / RESUME cascade.
//
// When an SO flips to ON_HOLD or CANCELLED, every downstream production_order
// that isn't already in a terminal state (COMPLETED / CANCELLED) must follow.
// Likewise, when an ON_HOLD SO resumes (→ CONFIRMED / IN_PRODUCTION), every
// ON_HOLD PO under that SO flips back to PENDING so the shop floor can
// continue. job_cards follow the same policy:
//
//   SO → CANCELLED  : cascade CANCELLED to all non-terminal POs. Also flip
//                     every job_card under those POs that isn't
//                     COMPLETED/TRANSFERRED to CANCELLED.
//   SO → ON_HOLD    : cascade ON_HOLD to all non-terminal POs. job_cards are
//                     NOT mutated — the scan-complete + PATCH guards block
//                     writes against ON_HOLD POs, so existing WAITING /
//                     IN_PROGRESS states survive the pause untouched and
//                     resume naturally when the SO comes back.
//   SO → RESUME     : flip every ON_HOLD PO back to PENDING. job_cards are
//                     left as-is (WAITING stays WAITING, etc).
//
// The returned `statements` are prepended to the caller's batch so the
// cascade lands atomically with the SO UPDATE + status_changes INSERT.
// `actions` is a human-readable log appended to the status-change row's
// autoActions JSON array ("3 production orders moved to ON_HOLD").
// ---------------------------------------------------------------------------
type SOCascadeResult = {
  statements: D1PreparedStatement[];
  actions: string[];
  affectedPoCount: number;
  affectedJcCount: number;
};

async function cascadeSOStatusToPOs(
  db: D1Database,
  soId: string,
  newStatus: string,
  fromStatus: string,
  now: string,
): Promise<SOCascadeResult> {
  const result: SOCascadeResult = {
    statements: [],
    actions: [],
    affectedPoCount: 0,
    affectedJcCount: 0,
  };

  // Only cascade on these transitions — all others no-op.
  const isHold = newStatus === "ON_HOLD";
  const isCancel = newStatus === "CANCELLED";
  const isResume =
    fromStatus === "ON_HOLD" &&
    (newStatus === "CONFIRMED" || newStatus === "IN_PRODUCTION");
  if (!isHold && !isCancel && !isResume) return result;

  // Load downstream POs for this SO.
  const posRes = await db
    .prepare(
      "SELECT id, poNo, status FROM production_orders WHERE salesOrderId = ?",
    )
    .bind(soId)
    .all<{ id: string; poNo: string; status: string }>();
  const pos = posRes.results ?? [];
  if (pos.length === 0) return result;

  if (isHold) {
    const affected = pos.filter(
      (p) => p.status !== "COMPLETED" && p.status !== "CANCELLED",
    );
    if (affected.length === 0) {
      result.actions.push("No active production orders to hold.");
      return result;
    }
    for (const p of affected) {
      result.statements.push(
        db
          .prepare(
            "UPDATE production_orders SET status = 'ON_HOLD', updated_at = ? WHERE id = ?",
          )
          .bind(now, p.id),
      );
    }
    result.affectedPoCount = affected.length;
    result.actions.push(
      `${affected.length} production order(s) moved to ON_HOLD: ${affected.map((p) => p.poNo).join(", ")}`,
    );
    return result;
  }

  if (isCancel) {
    const affected = pos.filter(
      (p) => p.status !== "COMPLETED" && p.status !== "CANCELLED",
    );
    if (affected.length === 0) {
      result.actions.push("No active production orders to cancel.");
      return result;
    }
    const poIds = affected.map((p) => p.id);
    for (const p of affected) {
      result.statements.push(
        db
          .prepare(
            "UPDATE production_orders SET status = 'CANCELLED', updated_at = ? WHERE id = ?",
          )
          .bind(now, p.id),
      );
    }
    // Cascade CANCELLED to any non-terminal job_cards under those POs.
    // Uses placeholders so D1 parameter binding is safe against the id list.
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
          .prepare("UPDATE job_cards SET status = 'CANCELLED' WHERE id = ?")
          .bind(jcId),
      );
    }
    result.affectedPoCount = affected.length;
    result.affectedJcCount = jcIds.length;
    result.actions.push(
      `${affected.length} production order(s) CANCELLED: ${affected.map((p) => p.poNo).join(", ")}`,
    );
    if (jcIds.length > 0) {
      result.actions.push(`${jcIds.length} job card(s) CANCELLED under those POs.`);
    }
    return result;
  }

  // Resume path: ON_HOLD → CONFIRMED / IN_PRODUCTION.
  const affected = pos.filter((p) => p.status === "ON_HOLD");
  if (affected.length === 0) {
    result.actions.push("No ON_HOLD production orders to resume.");
    return result;
  }
  for (const p of affected) {
    result.statements.push(
      db
        .prepare(
          "UPDATE production_orders SET status = 'PENDING', updated_at = ? WHERE id = ?",
        )
        .bind(now, p.id),
    );
  }
  result.affectedPoCount = affected.length;
  result.actions.push(
    `${affected.length} production order(s) resumed to PENDING: ${affected.map((p) => p.poNo).join(", ")}`,
  );
  return result;
}

// Valid status transitions — mirrors the in-memory route.
//
// 2026-04-28 semantics shift: confirming an SO now lands directly at
// IN_PRODUCTION because PO auto-creation kicks off lead-time scheduling the
// instant confirm runs — there is no meaningful "confirmed but not in
// production" steady state. CONFIRMED is kept as a vestigial node only so
// legacy rows still in that status (or any in-flight transient between the
// confirm POST and the PO cascade) remain transition-able. The cascade
// rollback path (READY_TO_SHIP undo) now drops back to IN_PRODUCTION rather
// than CONFIRMED.
const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["CONFIRMED", "IN_PRODUCTION", "CANCELLED"],
  CONFIRMED: ["IN_PRODUCTION", "ON_HOLD", "CANCELLED"],
  IN_PRODUCTION: ["READY_TO_SHIP", "ON_HOLD", "CANCELLED"],
  READY_TO_SHIP: ["SHIPPED", "ON_HOLD", "IN_PRODUCTION"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: ["INVOICED"],
  INVOICED: ["CLOSED"],
  ON_HOLD: ["CONFIRMED", "IN_PRODUCTION", "CANCELLED"],
  CLOSED: [],
  CANCELLED: [],
};

// ---------------------------------------------------------------------------
// GET /api/sales-orders — list all SOs with nested items
//
// Query params (opt-in pagination; omitting them preserves backward-compatible
// "full list" behavior for legacy consumers):
//
//   ?page=N&limit=M
//     When either is supplied, response includes { page, limit } and `data`
//     is the sliced page. Default page=1, default limit=50, hard cap 500.
//     Uses SQL LIMIT/OFFSET on sales_orders, then scopes
//     sales_order_items to only the page's SO IDs — so a 50-row page no
//     longer pulls every SO item row.
//
//   ?includeArchive=true
//     Phase-5 historical-report hook. When set, UNION ALL hot + archive
//     (sales_orders + sales_orders_archive) before applying ORDER BY /
//     LIMIT. Default off. The archive has an extra `archivedAt` column
//     the hot table doesn't; we project an empty string for hot rows so
//     the UNION column lists line up, then drop the extra column in the
//     row mapper.
// ---------------------------------------------------------------------------
// GET /api/sales-orders — list (and optional archive view) of SOs.
//
// Phase C #1 quick-win: scoped to the active orgId via withOrgScope().
// THIS IS THE PATTERN the rest of the routes will follow as the multi-tenant
// rollout continues — see src/api/lib/tenant.ts:
//
//   const { whereSql, params } = withOrgScope(c, "<table>", "<extra-where>");
//   db.prepare(`SELECT * FROM <table> ${whereSql} ORDER BY ...`)
//     .bind(...params, ...other-binds);
//
// The orgId column was added in migration 0049 with a default of 'hookka',
// so this filter is a no-op in single-tenant mode but enforces isolation
// the moment a second tenant is seeded.
app.get("/", async (c) => {
  const db = c.var.DB;
  const pageParam = c.req.query("page");
  const limitParam = c.req.query("limit");
  const paginate = pageParam !== undefined || limitParam !== undefined;
  const includeArchive = c.req.query("includeArchive") === "true";

  // Union fragment used whenever includeArchive is on. `SELECT * FROM
  // sales_orders` is padded with a literal '' for archivedAt so the
  // column list matches the archive table. Kept as a CTE-ish inline
  // subquery rather than a real view so we stay in one-file-per-route.
  const soSourceSql = includeArchive
    ? `(SELECT *, '' AS "archivedAt" FROM sales_orders
        UNION ALL
        SELECT * FROM sales_orders_archive)`
    : "sales_orders";

  const itemsSourceSql = includeArchive
    ? `(SELECT *, '' AS "archivedAt" FROM sales_order_items
        UNION ALL
        SELECT * FROM sales_order_items_archive)`
    : "sales_order_items";

  // Tenant scope — first bind param on every query against soSourceSql.
  // Items are scoped transitively via salesOrderId IN (...) so they don't
  // need their own orgId filter (the archive table doesn't have orgId yet).
  const { whereSql: orgWhere, params: orgParams } = withOrgScope(
    c,
    "sales_orders",
  );

  if (!paginate) {
    // 2026-04-26 prod 500 fix: cap the unbounded items fetch. The
    // unfiltered `SELECT *` over `sales_order_items` was the prime
    // suspect for the 500 surfaced in the dogfood test (Server-Timing
    // showed app-time + 0 db queries, consistent with a result-set or
    // CPU-budget exception inside the handler before any timer fires).
    // 5,000 rows ≈ ~50 SOs of 100 items — still covers the entire
    // current dataset with headroom. Once the dataset grows past this
    // cap, callers must pass ?page=N&limit=M (the paginated branch
    // below already scopes items via salesOrderId IN (...)).
    const ITEMS_HARD_CAP = 5000;
    const [sos, items] = await Promise.all([
      db
        .prepare(
          `SELECT * FROM ${soSourceSql} ${orgWhere} ORDER BY created_at DESC, id DESC`,
        )
        .bind(...orgParams)
        .all<SalesOrderRow>(),
      db
        .prepare(`SELECT * FROM ${itemsSourceSql} LIMIT ${ITEMS_HARD_CAP}`)
        .all<SalesOrderItemRow>(),
    ]);
    const data = (sos.results ?? []).map((s) =>
      rowToSO(s, items.results ?? []),
    );
    return c.json({ success: true, data, total: data.length });
  }

  const page = Math.max(1, parseInt(pageParam ?? "1", 10) || 1);
  const rawLimit = parseInt(limitParam ?? "50", 10) || 50;
  const limit = Math.min(500, Math.max(1, rawLimit));
  const offset = (page - 1) * limit;

  const [countRes, pageRes] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS n FROM ${soSourceSql} ${orgWhere}`)
      .bind(...orgParams)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT * FROM ${soSourceSql} ${orgWhere} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .bind(...orgParams, limit, offset)
      .all<SalesOrderRow>(),
  ]);
  const total = countRes?.n ?? 0;
  const soRows = pageRes.results ?? [];

  let items: SalesOrderItemRow[] = [];
  if (soRows.length > 0) {
    const ids = soRows.map((s) => s.id);
    const placeholders = ids.map(() => "?").join(",");
    const itemsRes = await db
      .prepare(`SELECT * FROM ${itemsSourceSql} WHERE salesOrderId IN (${placeholders})`)
      .bind(...ids)
      .all<SalesOrderItemRow>();
    items = itemsRes.results ?? [];
  }
  const data = soRows.map((s) => rowToSO(s, items));
  return c.json({ success: true, data, page, limit, total });
});

// ---------------------------------------------------------------------------
// GET /api/sales-orders/status-changes — full audit log
// (defined BEFORE /:id so the route matches first)
// ---------------------------------------------------------------------------
app.get("/status-changes", async (c) => {
  const res = await c.var.DB.prepare(
    "SELECT * FROM so_status_changes ORDER BY timestamp DESC",
  ).all<SOStatusChangeRow>();
  const data = (res.results ?? []).map(rowToStatusChange);
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// GET /api/sales-orders/stats — whole-dataset status bucket counts.
//
// Returns { byStatus: Record<string, number>, total }. Used by the list page
// tab badges / KPI cards so "Confirmed (N)" reflects the full table rather
// than only the current paginated page. Single aggregate SELECT — cheap.
// Registered BEFORE /:id (Hono route ordering: static before wildcards).
// ---------------------------------------------------------------------------
app.get("/stats", async (c) => {
  const res = await c.var.DB
    .prepare("SELECT status, COUNT(*) AS n FROM sales_orders GROUP BY status")
    .all<{ status: string; n: number }>();
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const row of res.results ?? []) {
    byStatus[row.status] = row.n;
    total += row.n;
  }
  return c.json({ success: true, byStatus, total });
});

// ---------------------------------------------------------------------------
// POST /api/sales-orders/backfill-job-cards — admin one-shot backfill.
//
// Walks every production_orders row that has zero job_cards and runs the
// BOM → WIP → job_cards cascade against it, using the same helper as the
// main SO-confirm path. Idempotent per-PO (skips POs that already have jcs).
//
// Intended for one-time recovery of the stuck PO (SO-2604-001-01) that was
// created before this cascade existed. Safe to re-invoke — it's a no-op on
// any PO that already has at least one job_cards row.
// ---------------------------------------------------------------------------
app.post("/backfill-job-cards", async (c) => {
  const db = c.var.DB;
  const empties = await db
    .prepare(
      `SELECT p.id FROM production_orders p
         LEFT JOIN job_cards j ON j.productionOrderId = p.id
         WHERE j.id IS NULL`,
    )
    .all<{ id: string }>();
  const ids = (empties.results ?? []).map((r) => r.id);

  const results: Array<{ poId: string; jcCount: number; currentDept: string | null }> = [];
  for (const poId of ids) {
    const { statements, jcCount, currentDept } = await backfillJobCardsForPo(db, poId);
    if (statements.length > 0) {
      await db.batch(statements);
    }
    results.push({ poId, jcCount, currentDept });
  }
  const total = results.reduce((sum, r) => sum + r.jcCount, 0);
  return c.json({
    success: true,
    data: {
      posScanned: ids.length,
      jobCardsInserted: total,
      details: results,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/sales-orders/:id/edit-eligibility — can this SO be edited right now?
//
// Rules (per user 2026-04-28):
//   1. Status must be DRAFT / CONFIRMED / IN_PRODUCTION.
//   2. No job_card under the SO's POs may have a completedDate stamped.
//   3. The earliest JC's dueDate (i.e. when the first production step is
//      scheduled to finish) must be more than 2 calendar days away.
//      Once we are within 2 days of the first step's deadline, edits
//      lock so material orders / cutting plans don't get out of sync.
//
// Registered BEFORE /:id so Hono's trie picks the right handler.
// ---------------------------------------------------------------------------
app.get("/:id/edit-eligibility", async (c) => {
  const id = c.req.param("id");
  const so = await c.var.DB
    .prepare("SELECT id, status FROM sales_orders WHERE id = ?")
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!so) {
    return c.json({ success: false, error: "Order not found" }, 404);
  }

  // Rule 1: status must be one of DRAFT / CONFIRMED / IN_PRODUCTION.
  if (so.status !== "DRAFT" && so.status !== "CONFIRMED" && so.status !== "IN_PRODUCTION") {
    return c.json({
      success: true,
      editable: false,
      reason: "status",
      status: so.status,
    });
  }

  // DRAFT/CONFIRMED short-circuit — no production to inspect.
  if (so.status === "DRAFT" || so.status === "CONFIRMED") {
    return c.json({
      success: true,
      editable: true,
      status: so.status,
    });
  }

  // IN_PRODUCTION — pull earliest completed JC + earliest scheduled JC
  // dueDate in one round trip.
  const [completedRes, earliestDueRes] = await Promise.all([
    c.var.DB
      .prepare(
        `SELECT jc.departmentName, jc.departmentCode, jc.completedDate
           FROM job_cards jc
           JOIN production_orders po ON po.id = jc.productionOrderId
          WHERE po.salesOrderId = ?
            AND jc.completedDate IS NOT NULL
            AND jc.completedDate <> ''
          ORDER BY jc.completedDate ASC
          LIMIT 1`,
      )
      .bind(id)
      .first<{ departmentName: string | null; departmentCode: string | null; completedDate: string | null }>(),
    c.var.DB
      .prepare(
        `SELECT jc.dueDate
           FROM job_cards jc
           JOIN production_orders po ON po.id = jc.productionOrderId
          WHERE po.salesOrderId = ?
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
      status: so.status,
      completedDept: completedRes.departmentName || completedRes.departmentCode || "A department",
      completedAt: completedRes.completedDate,
    });
  }

  // Rule 3: earliest JC dueDate > today + 2 days. Treat missing dueDates
  // as "not yet scheduled" → no lock (production hasn't been planned far
  // enough to know the first step's deadline).
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
        status: so.status,
        earliestJcDueDate: earliestDue,
        cutoffDate: cutoffStr,
      });
    }
  }

  // IN_PRODUCTION, no JC done yet, earliest step still > 2 days away — editable.
  return c.json({
    success: true,
    editable: true,
    status: so.status,
  });
});

// ---------------------------------------------------------------------------
// POST /api/sales-orders/:id/override-edit-lock — admin escape hatch for the
// Rule-3 production_window edit lock.
//
// Per user 2026-04-28: when the eligibility endpoint returns
// editable=false / reason="production_window" (i.e. the earliest JC's
// dueDate is within 2 calendar days of today), SUPER_ADMIN / ADMIN should
// be able to override the lock with a written reason. Everyone else stays
// locked. Each override is audit-trailed: a row in edit_lock_overrides AND
// an EDIT_LOCK_OVERRIDDEN entry in so_status_changes (so the existing
// <StatusTimeline /> on the SO detail page surfaces it without extra API
// wiring).
//
// SECURITY MODEL — why ADMIN can override Rule 3 but not Rule 2:
//   * Rule 1 (status not in DRAFT/CONFIRMED/IN_PRODUCTION): a CANCELLED /
//     SHIPPED / etc. SO has no live editing semantic — there's nothing
//     to mutate. Override would be meaningless.
//   * Rule 2 (any JC has completedDate): real production OUTPUT exists.
//     Editing items would orphan finished WIP, which is irreversible.
//     No reason text can undo a physical commitment, so this stays a
//     hard lock for everyone including SUPER_ADMIN.
//   * Rule 3 (production_window): a *soft* schedule-drift guard — no
//     output yet, just a "we're inside the 2-day cutoff so material
//     orders may drift" warning. The admin overriding is explicitly
//     accepting that schedule risk. The reason text + actor + timestamp
//     are persisted so the team can review later if drift actually hits.
//
// Returns: { success: true, overrideToken, expiresAt } on success.
// The FE forwards `overrideToken` on the next PUT /:id body to bypass
// the production_window check (only — Rules 1 & 2 still re-check).
//
// Registered BEFORE /:id and other dynamic routes so Hono's trie picks
// the right handler.
// ---------------------------------------------------------------------------
app.post("/:id/override-edit-lock", async (c) => {
  const id = c.req.param("id");

  // Role gate. The auth-middleware stamps `userRole` on the context.
  // SUPER_ADMIN / ADMIN are the only roles that can grant this override —
  // a regular OPERATOR / VIEWER cannot bypass even with a reason. We do the
  // check directly off c.get('userRole') instead of requirePermission()
  // because no granular sales-orders:override-edit-lock permission exists
  // yet; this is intentionally a role-level escape hatch.
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

  // Body validation. The reason is required + non-trivial: anything under
  // 5 chars is almost certainly a smashed-keyboard placeholder ("x", "asdf")
  // and useless for the audit review later.
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

  // Re-run the same eligibility logic the GET endpoint uses. We MUST verify
  // Rule 3 actually fires right now, and Rules 1+2 are clear — otherwise
  // the override is either unnecessary (already editable) or invalid (a
  // hard-locked order). Fetching status + earliest completed JC + earliest
  // scheduled JC dueDate in parallel mirrors the eligibility GET above.
  const so = await c.var.DB
    .prepare("SELECT id, status FROM sales_orders WHERE id = ?")
    .bind(id)
    .first<{ id: string; status: string }>();
  if (!so) {
    return c.json({ success: false, error: "Order not found" }, 404);
  }

  // Rule 1: status must be DRAFT / CONFIRMED / IN_PRODUCTION. Override
  // cannot resurrect a CANCELLED / SHIPPED order.
  if (
    so.status !== "DRAFT" &&
    so.status !== "CONFIRMED" &&
    so.status !== "IN_PRODUCTION"
  ) {
    return c.json(
      {
        success: false,
        error: `Cannot override — order is in status ${so.status}, which is not editable regardless of override.`,
      },
      400,
    );
  }

  // For DRAFT / CONFIRMED there's no production yet, so no Rule-3 lock
  // could even fire — the override is unnecessary. Reject so the FE
  // surfaces "edit normally" instead of writing junk audit rows.
  if (so.status === "DRAFT" || so.status === "CONFIRMED") {
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
          WHERE po.salesOrderId = ?
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
          WHERE po.salesOrderId = ?
            AND jc.dueDate IS NOT NULL
            AND jc.dueDate <> ''
          ORDER BY jc.dueDate ASC
          LIMIT 1`,
      )
      .bind(id)
      .first<{ dueDate: string | null }>(),
  ]);

  // Rule 2: any dept stamped a completion → hard lock, no override allowed.
  // This is the "real production output exists" guard. See block comment at
  // the top of this endpoint for why ADMIN cannot override this.
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

  // Rule 3: production_window must currently be active for the override
  // to be meaningful. If the earliest JC dueDate is > today + 2 days the
  // SO is already editable normally — return 400 so the FE doesn't write
  // junk audit rows for a no-op override.
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

  // All checks pass — mint the token, write the audit-trail rows.
  const actorUserId = (
    c as unknown as { get: (k: string) => string | undefined }
  ).get("userId") ?? null;
  const actorUserName = await lookupActorDisplayName(c.var.DB, actorUserId);

  const created = await createEditLockOverride(c.var.DB, {
    orderType: "SO",
    orderId: id,
    reason: reasonRaw,
    actorUserId,
    actorUserName,
    actorRole: role,
  });

  // Mirror the override into so_status_changes so the existing
  // <StatusTimeline /> on the SO detail page picks it up automatically.
  // We re-use the same fromStatus/toStatus columns: the override doesn't
  // actually transition status, so we stamp both with the current status
  // and flag the row via notes prefix "EDIT_LOCK_OVERRIDDEN: <reason>".
  // The FE formats anything starting with EDIT_LOCK_OVERRIDDEN: with a
  // distinct "Override" badge instead of the default "Status Change".
  const noteTag = `EDIT_LOCK_OVERRIDDEN: ${reasonRaw}`;
  await c.var.DB
    .prepare(
      `INSERT INTO so_status_changes
         (id, soId, fromStatus, toStatus, changedBy, timestamp, notes, autoActions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      genStatusId(),
      id,
      so.status,
      so.status,
      actorUserName ?? actorUserId ?? "Admin",
      new Date().toISOString(),
      noteTag,
      JSON.stringify([
        `Override token issued (60 min TTL). earliestJcDueDate=${earliestDue}.`,
      ]),
    )
    .run();

  // Audit emit — first-class entry in audit_events too, so the global
  // audit log catches this even if status-history is later refactored.
  await emitAudit(c, {
    resource: "sales-orders",
    resourceId: id,
    action: "override-edit-lock",
    before: { editable: false, reason: "production_window", earliestJcDueDate: earliestDue },
    after: { overrideToken: created.token, expiresAt: created.expiresAt, reason: reasonRaw },
  });

  return c.json({
    success: true,
    overrideToken: created.token,
    expiresAt: created.expiresAt,
  });
});

// ---------------------------------------------------------------------------
// POST /api/sales-orders — create a new SO + items atomically
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  // RBAC gate (P3.3) — only roles with sales-orders:create may create SOs.
  const denied = await requirePermission(c, "sales-orders", "create");
  if (denied) return denied;

  // Sprint 3 #4 — idempotency. If the client sends an `Idempotency-Key`
  // header, the handler is wrapped so a duplicate retry returns the
  // cached response instead of creating a duplicate SO. Requests without
  // a key run unwrapped (no-op).
  const idemKey = readIdempotencyKey(c);
  return withIdempotency(c, "sales-orders", idemKey, async () => {
  try {
    const body = await c.req.json();

    // Validate customer
    const customer = await c.var.DB.prepare(
      "SELECT id, name FROM customers WHERE id = ?",
    )
      .bind(body.customerId)
      .first<{ id: string; name: string }>();
    if (!customer) {
      return c.json({ success: false, error: "Customer not found" }, 400);
    }

    // Resolve hub (optional)
    const hubIdField: string = body.hubId || body.deliveryHubId || "";
    let chosenHub: { id: string; state: string | null; shortName: string } | null = null;
    if (hubIdField) {
      chosenHub = await c.var.DB.prepare(
        "SELECT id, state, shortName FROM delivery_hubs WHERE id = ? AND customerId = ?",
      )
        .bind(hubIdField, customer.id)
        .first<{ id: string; state: string | null; shortName: string }>();
    }
    if (!chosenHub) {
      chosenHub = await c.var.DB.prepare(
        "SELECT id, state, shortName FROM delivery_hubs WHERE customerId = ? ORDER BY isDefault DESC LIMIT 1",
      )
        .bind(customer.id)
        .first<{ id: string; state: string | null; shortName: string }>();
    }

    const rawItems: Array<Record<string, unknown>> = Array.isArray(body.items)
      ? body.items
      : [];

    // Hard restriction: SOFA + BEDFRAME may NOT coexist on a single SO. They
    // run on entirely separate production lines (Fab Cut merge keys, BF qty
    // from HB, parallel lead times). Validate before any product/price
    // resolution work to fail fast and cheap.
    if (
      hasMixedSofaBedframe(
        rawItems.map((it) => ({
          itemCategory:
            typeof it.itemCategory === "string" ? it.itemCategory : null,
        })),
      )
    ) {
      return c.json({ success: false, error: SO_MIXED_CATEGORY_ERROR }, 400);
    }

    // Price-resolution date: use companySODate (may be future-dated) when given,
    // fall back to today so price history resolves correctly on confirm.
    const priceAsOf =
      typeof body.companySODate === "string" && body.companySODate
        ? body.companySODate.slice(0, 10)
        : new Date().toISOString().slice(0, 10);

    // Build items — resolve product basePrice fallback
    const items = await Promise.all(
      rawItems.map(async (item, idx) => {
        const productCode = String(item.productCode ?? "");
        let resolvedProduct: {
          id: string;
          name: string;
          category: string;
          sizeCode: string | null;
          sizeLabel: string | null;
          basePriceSen: number | null;
          seatHeightPrices: string | null;
        } | null = null;
        if (productCode) {
          resolvedProduct = await c.var.DB.prepare(
            "SELECT id, name, category, sizeCode, sizeLabel, basePriceSen, seatHeightPrices FROM products WHERE code = ? LIMIT 1",
          )
            .bind(productCode)
            .first();
          if (!resolvedProduct) {
            resolvedProduct = await c.var.DB.prepare(
              "SELECT id, name, category, sizeCode, sizeLabel, basePriceSen, seatHeightPrices FROM products WHERE LOWER(code) = LOWER(?) LIMIT 1",
            )
              .bind(productCode)
              .first();
          }
        }

        const incomingBasePrice = Number(item.basePriceSen) || 0;
        let basePriceSen = incomingBasePrice;

        // Customer-specific price override: only consulted when the request
        // didn't explicitly supply a price. A failed lookup must not break
        // the SO create — fall through to the product-level default below.
        let cpSeatHeightPrices: Array<{ height: string; priceSen: number }> | null = null;
        let cpBasePrice: number | null = null;
        const productIdForLookup = (item.productId as string) || resolvedProduct?.id || "";
        if (incomingBasePrice === 0 && productIdForLookup && customer.id) {
          try {
            const cp = await resolveCustomerPriceAsOf(
              c.var.DB,
              productIdForLookup,
              customer.id,
              priceAsOf,
            );
            if (cp) {
              cpBasePrice = cp.basePriceSen;
              cpSeatHeightPrices = cp.seatHeightPrices ?? null;
            }
          } catch {
            // Non-fatal: fall back to product-level pricing.
          }
        }

        if (basePriceSen === 0 && resolvedProduct) {
          const seatHeight = String(item.seatHeight ?? "");
          if (cpSeatHeightPrices && cpSeatHeightPrices.length > 0 && seatHeight) {
            const shp = cpSeatHeightPrices.find(
              (p) => p.height === seatHeight || p.height === `${seatHeight}"`,
            );
            basePriceSen = shp?.priceSen || cpBasePrice || resolvedProduct.basePriceSen || 0;
          } else if (resolvedProduct.seatHeightPrices && seatHeight) {
            try {
              const shpList = JSON.parse(resolvedProduct.seatHeightPrices) as Array<{
                height: string;
                priceSen: number;
              }>;
              const shp = shpList.find(
                (p) => p.height === seatHeight || p.height === `${seatHeight}"`,
              );
              basePriceSen = shp?.priceSen || cpBasePrice || resolvedProduct.basePriceSen || 0;
            } catch {
              basePriceSen = cpBasePrice ?? resolvedProduct.basePriceSen ?? 0;
            }
          } else {
            basePriceSen = cpBasePrice ?? resolvedProduct.basePriceSen ?? 0;
          }
        }

        const divanPriceSen = Number(item.divanPriceSen) || 0;
        const legPriceSen = Number(item.legPriceSen) || 0;
        const specialOrderPriceSen = Number(item.specialOrderPriceSen) || 0;
        const unitPriceSen = calculateUnitPrice({
          basePriceSen,
          divanPriceSen,
          legPriceSen,
          specialOrderPriceSen,
        });
        const quantity = Number(item.quantity) || 0;
        const lineTotalSen = calculateLineTotal(unitPriceSen, quantity);
        const lineNo = idx + 1;
        const lineSuffix = `-${String(lineNo).padStart(2, "0")}`;

        return {
          id: (item.id as string) || genItemId(),
          lineNo,
          lineSuffix,
          productId: (item.productId as string) || resolvedProduct?.id || "",
          productCode,
          productName:
            (item.productName as string) || resolvedProduct?.name || productCode,
          itemCategory:
            (item.itemCategory as string) ||
            resolvedProduct?.category ||
            "BEDFRAME",
          sizeCode:
            (item.sizeCode as string) || resolvedProduct?.sizeCode || "",
          sizeLabel:
            (item.sizeLabel as string) ||
            resolvedProduct?.sizeLabel ||
            (item.sizeCode as string) ||
            "",
          fabricId: (item.fabricId as string) || "",
          fabricCode: (item.fabricCode as string) || "",
          quantity,
          gapInches: item.gapInches ?? null,
          divanHeightInches: item.divanHeightInches ?? null,
          divanPriceSen,
          legHeightInches: item.legHeightInches ?? null,
          legPriceSen,
          specialOrder: (item.specialOrder as string) || "",
          specialOrderPriceSen,
          basePriceSen,
          unitPriceSen,
          lineTotalSen,
          notes: (item.notes as string) || "",
        };
      }),
    );

    const subtotalSen = items.reduce((sum, i) => sum + i.lineTotalSen, 0);
    const now = new Date().toISOString();
    const companySOId = await generateCompanySOId(c.var.DB);
    const soId = genSoId();
    const today = now.split("T")[0];

    const customerState =
      chosenHub?.state ??
      (typeof body.customerState === "string" ? body.customerState : "") ??
      "";

    const statements = [
      c.var.DB.prepare(
        `INSERT INTO sales_orders (id, customerPO, customerPOId, customerPODate,
           customerSO, customerSOId, reference, customerId, customerName,
           customerState, hubId, hubName, companySO, companySOId, companySODate,
           customerDeliveryDate, hookkaExpectedDD, hookkaDeliveryOrder,
           subtotalSen, totalSen, status, overdue, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        soId,
        body.customerPO ?? "",
        body.customerPOId ?? "",
        body.customerPODate ?? today,
        body.customerSO ?? "",
        body.customerSOId ?? "",
        body.reference ?? "",
        customer.id,
        customer.name,
        customerState,
        chosenHub?.id ?? null,
        chosenHub?.shortName ?? null,
        body.companySO ?? `Sales Order ${companySOId.split("-").pop()}`,
        companySOId,
        body.companySODate ?? today,
        body.customerDeliveryDate ?? "",
        body.hookkaExpectedDD ?? "",
        body.hookkaDeliveryOrder ?? "",
        subtotalSen,
        subtotalSen,
        "DRAFT",
        "PENDING",
        body.notes ?? "",
        now,
        now,
      ),
      ...items.map((item) =>
        c.var.DB.prepare(
          `INSERT INTO sales_order_items (id, salesOrderId, lineNo, lineSuffix,
             productId, productCode, productName, itemCategory, sizeCode, sizeLabel,
             fabricId, fabricCode, quantity, gapInches, divanHeightInches,
             divanPriceSen, legHeightInches, legPriceSen, specialOrder,
             specialOrderPriceSen, basePriceSen, unitPriceSen, lineTotalSen, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          item.id,
          soId,
          item.lineNo,
          item.lineSuffix,
          item.productId,
          item.productCode,
          item.productName,
          item.itemCategory,
          item.sizeCode,
          item.sizeLabel,
          item.fabricId,
          item.fabricCode,
          item.quantity,
          item.gapInches,
          item.divanHeightInches,
          item.divanPriceSen,
          item.legHeightInches,
          item.legPriceSen,
          item.specialOrder,
          item.specialOrderPriceSen,
          item.basePriceSen,
          item.unitPriceSen,
          item.lineTotalSen,
          item.notes,
        ),
      ),
    ];

    await c.var.DB.batch(statements);

    const created = await fetchSOWithItems(c.var.DB, soId);
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create sales order" },
        500,
      );
    }
    // Audit emit (P3.4) — captures the actor + after-state snapshot.
    // emitAudit is fire-and-forget on its own; awaiting just keeps tests
    // deterministic. Non-throwing on internal failure.
    await emitAudit(c, {
      resource: "sales-orders",
      resourceId: soId,
      action: "create",
      after: created,
    });
    return c.json({ success: true, data: created }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[POST /api/sales-orders] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json({ success: false, error: msg || "Internal error creating sales order" }, 500);
  }
  });
});

// ---------------------------------------------------------------------------
// POST /api/sales-orders/:id/confirm
//
// Flips DRAFT/PENDING -> IN_PRODUCTION, writes so_status_changes, and cascades
// production_orders insertion — one PO row per SO item. All writes batched
// so a partial failure leaves no dangling state. Idempotent: re-submitting
// confirm returns the existing production orders without duplicating.
//
// 2026-04-28: confirm now lands at IN_PRODUCTION directly. Previously this
// flipped to CONFIRMED and waited for a downstream cascade to bump it; now
// the PO auto-creation kicks off lead-time scheduling synchronously, so
// CONFIRMED has no meaningful steady state. Legacy CONFIRMED rows are still
// supported through VALID_TRANSITIONS for backfill / migration purposes.
// ---------------------------------------------------------------------------
app.post("/:id/confirm", async (c) => {
  // RBAC gate — confirming an SO is the lock-in moment that fans out POs / JCs.
  // Reuses the dedicated confirm action so a "create-only" role can be
  // configured separately from "create + confirm".
  const denied = await requirePermission(c, "sales-orders", "confirm");
  if (denied) return denied;

  // Sprint 3 #4 — idempotency. Confirm is mutating (writes
  // production_orders, cascades job_cards). Wrap so a duplicate retry
  // returns the cached response instead of running the cascade twice.
  // The path id is folded into the resource so two different SOs can
  // share the same client-generated key without colliding.
  const idemKey = readIdempotencyKey(c);
  return withIdempotency(
    c,
    `sales-orders:confirm:${c.req.param("id")}`,
    idemKey,
    async () => {
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT * FROM sales_orders WHERE id = ?",
  )
    .bind(id)
    .first<SalesOrderRow>();
  if (!existing) {
    return c.json({ success: false, error: "Order not found" }, 404);
  }

  // DRAFT / PENDING orders are confirmable. Already-CONFIRMED orders are
  // also allowed through IF they have no production orders yet — this
  // handles the backfill case (SO was confirmed before the PO cascade
  // existed, now it's CONFIRMED but missing downstream POs). The PO
  // creation helper is idempotent, so this is safe.
  const allowedStatuses = ["DRAFT", "PENDING"];
  if (!allowedStatuses.includes(existing.status)) {
    if (existing.status === "CONFIRMED") {
      const existingPos = await c.var.DB.prepare(
        "SELECT id FROM production_orders WHERE salesOrderId = ? LIMIT 1",
      )
        .bind(id)
        .first<{ id: string }>();
      if (existingPos) {
        return c.json(
          {
            success: false,
            error: `Order ${existing.companySOId ?? id} is already CONFIRMED and its production orders already exist.`,
          },
          400,
        );
      }
      // Fall through: CONFIRMED + zero POs → run cascade to backfill.
    } else {
      return c.json(
        {
          success: false,
          error: `Cannot confirm order with status ${existing.status}. Only DRAFT orders can be confirmed.`,
        },
        400,
      );
    }
  }

  // Customer PO uniqueness (BR-SO-010)
  if (existing.customerPOId) {
    const dup = await c.var.DB.prepare(
      `SELECT id, companySOId FROM sales_orders
         WHERE id != ? AND customerPOId = ? AND customerId = ? AND status != 'CANCELLED'
         LIMIT 1`,
    )
      .bind(id, existing.customerPOId, existing.customerId)
      .first<{ id: string; companySOId: string | null }>();
    if (dup) {
      return c.json(
        {
          success: false,
          error: `Customer PO ${existing.customerPOId} already exists on ${dup.companySOId ?? dup.id}. Each customer PO must be unique.`,
        },
        400,
      );
    }
  }

  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const now = new Date().toISOString();
  const fromStatus = existing.status;

  // Load SO items for PO cascade.
  const itemsRes = await c.var.DB.prepare(
    "SELECT * FROM sales_order_items WHERE salesOrderId = ?",
  )
    .bind(id)
    .all<SalesOrderItemRow>();
  const items = itemsRes.results ?? [];

  // Hard restriction re-check at confirm. POST + PUT already block this,
  // but legacy data created before the rule shipped could still slip in
  // here — keep the gate in place so the production cascade never sees a
  // mixed-category SO.
  if (hasMixedSofaBedframe(items)) {
    return c.json({ success: false, error: SO_MIXED_CATEGORY_ERROR }, 400);
  }

  // BOM completeness guard — blocks confirm if any line's product has an
  // incomplete BOM. Runs BEFORE the status flip and PO cascade so a 422
  // leaves the SO in its prior status and no production_orders are created.
  const incompleteProducts = await findIncompleteBomProducts(c.var.DB, items);
  if (incompleteProducts.length > 0) {
    return c.json(
      {
        success: false,
        error: "BOM incomplete — cannot confirm. Save as draft first.",
        details: { incompleteProducts },
      },
      422,
    );
  }

  const { statements: poStmts, created: productionOrders, preExisting } =
    await createProductionOrdersForSO(c.var.DB, existing, items);

  const autoActions = preExisting
    ? ["Production orders already exist for this SO — skipped duplicate creation."]
    : productionOrders.map((po) => `Created PO ${po.poNo}`);

  // 2026-04-28: confirm lands at IN_PRODUCTION directly. The PO cascade
  // below kicks off lead-time scheduling, so the SO IS in production the
  // moment confirm completes — there is no meaningful CONFIRMED steady
  // state. CONFIRMED is retained as a transition node only for legacy rows.
  await c.var.DB.batch([
    c.var.DB.prepare(
      "UPDATE sales_orders SET status = 'IN_PRODUCTION', updated_at = ? WHERE id = ?",
    ).bind(now, id),
    c.var.DB.prepare(
      `INSERT INTO so_status_changes
         (id, soId, fromStatus, toStatus, changedBy, timestamp, notes, autoActions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      genStatusId(),
      id,
      fromStatus,
      "IN_PRODUCTION",
      (body.changedBy as string) || "Admin",
      now,
      (body.notes as string) || "Order confirmed",
      JSON.stringify(autoActions),
    ),
    ...poStmts,
  ]);

  const order = await fetchSOWithItems(c.var.DB, id);

  // Phase C #3 quick-win — enqueue one PO emission message per newly
  // created production order. Runs AFTER the synchronous DB batch so
  // the SO is durably CONFIRMED before any side-effect fires. When the
  // PO_EMISSION_QUEUE binding is not configured (default until
  // docs/QUEUES-SETUP.md is executed) the helper falls back to the
  // existing inline notify, preserving today's behavior.
  if (!preExisting && productionOrders.length > 0) {
    try {
      const { enqueuePoEmission } = await import("../lib/queue-po-emission");
      const orgId = (c.get as unknown as (k: string) => string | undefined)(
        "orgId",
      );
      const customerEmail =
        (existing as unknown as { customerEmail?: string }).customerEmail ??
        undefined;
      await Promise.all(
        productionOrders.map((po) =>
          enqueuePoEmission(
            c.env as unknown as {
              PO_EMISSION_QUEUE?: { send: (m: unknown) => Promise<void> };
            },
            {
              poId: po.id,
              soId: id,
              poNo: po.poNo,
              customerEmail,
              orgId,
            },
          ),
        ),
      );
    } catch (err) {
      // Never block the confirm response on the queue. The inline
      // fallback inside enqueuePoEmission already covers the common
      // failure case; this catch is the belt for the suspenders.
      console.warn(
        "[sales-orders/confirm] PO emission enqueue failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Audit emit (P3.4) — confirm is the lock-in moment that fans out POs.
  // Snapshot the SO's state before/after so forensic queries can trace the
  // moment a PO chain was kicked off.
  await emitAudit(c, {
    resource: "sales-orders",
    resourceId: id,
    action: "confirm",
    before: existing,
    after: order,
  });

  return c.json({
    success: true,
    data: order,
    productionOrders,
    bomFallbacks: [],
    bomWarnings: [],
    message: preExisting
      ? `Order confirmed. ${productionOrders.length} existing production order(s) reused.`
      : `Order confirmed. ${productionOrders.length} production order(s) created.`,
  });
    },
  );
});

// ---------------------------------------------------------------------------
// GET /api/sales-orders/:id — SO + items + statusHistory + priceOverrides
// ---------------------------------------------------------------------------
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [so, itemsRes, statusRes, overridesRes, posRes] = await Promise.all([
    c.var.DB.prepare("SELECT * FROM sales_orders WHERE id = ?")
      .bind(id)
      .first<SalesOrderRow>(),
    c.var.DB.prepare("SELECT * FROM sales_order_items WHERE salesOrderId = ?")
      .bind(id)
      .all<SalesOrderItemRow>(),
    c.var.DB.prepare(
      "SELECT * FROM so_status_changes WHERE soId = ? ORDER BY timestamp DESC",
    )
      .bind(id)
      .all<SOStatusChangeRow>(),
    c.var.DB.prepare("SELECT * FROM price_overrides WHERE soId = ?")
      .bind(id)
      .all<PriceOverrideRow>(),
    // Linked production orders for the SO detail page's "Linked Production
    // Orders" table + doc-flow Production node + header chip. Wired
    // 2026-04-26 — the original endpoint left this as `[]` with a "Phase
    // 4" TODO from the D1 migration, never backfilled. Frontend uses
    // itemCategory to decide whether to show the line-suffixed poNo
    // (BF/ACC) or the parent companySOId without the -NN suffix (SOFA).
    c.var.DB.prepare(
      `SELECT id, poNo, productName, productCode, itemCategory, quantity,
              status, progress, currentDepartment
         FROM production_orders
        WHERE salesOrderId = ?
        ORDER BY poNo`,
    )
      .bind(id)
      .all<{
        id: string;
        poNo: string;
        productName: string | null;
        productCode: string | null;
        itemCategory: string | null;
        quantity: number | null;
        status: string | null;
        progress: number | null;
        currentDepartment: string | null;
      }>(),
  ]);
  if (!so) {
    return c.json({ success: false, error: "Order not found" }, 404);
  }
  // Lock status — surfaced to the frontend so the SO detail / edit pages
  // can disable inputs + render a banner ("locked because PO X is
  // COMPLETED — cancel that PO to unlock"). Same query the PUT guard
  // runs; cheap (single index lookup on production_orders).
  const lockReason = await checkSalesOrderLocked(c.var.DB, id);
  return c.json({
    success: true,
    data: rowToSO(so, itemsRes.results ?? []),
    lockReason,
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
    })),
    statusHistory: (statusRes.results ?? []).map(rowToStatusChange),
    priceOverrides: (overridesRes.results ?? []).map(rowToPriceOverride),
  });
});

// ---------------------------------------------------------------------------
// PUT /api/sales-orders/:id — update SO, status transitions, replace items
// ---------------------------------------------------------------------------
app.put("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const existing = await c.var.DB.prepare(
      "SELECT * FROM sales_orders WHERE id = ?",
    )
      .bind(id)
      .first<SalesOrderRow>();
    if (!existing) {
      return c.json({ success: false, error: "Order not found" }, 404);
    }
    // Cascade lock — once any production order has reached COMPLETED, the
    // SO's structural fields (items, quantities, prices, customer) become
    // read-only because tangible output exists. Status transitions
    // (CONFIRM, ON_HOLD, RESUME, CANCEL) bypass the lock — those are
    // handled below this guard, BEFORE the items/header re-write block.
    const lockMsg = await checkSalesOrderLocked(c.var.DB, id);
    const body = await c.req.json();
    const isStatusOnly =
      body.status &&
      !body.items &&
      !body.customerId &&
      !body.companySODate &&
      !body.customerDeliveryDate &&
      !body.hookkaExpectedDD;
    if (lockMsg && !isStatusOnly) {
      return c.json(lockedResponse(lockMsg), 403);
    }

    // ---------------------------------------------------------------------
    // Edit-eligibility re-check (defense-in-depth, mirrors the
    // /:id/edit-eligibility GET endpoint logic). Rule 1 is implicit in the
    // existing status-transition validator further down. Rule 2
    // (dept_completed) and Rule 3 (production_window) get explicit checks
    // here so a malicious / stale FE can't bypass them by hitting PUT
    // directly. Status-only edits skip BOTH checks (an admin closing or
    // cancelling shouldn't be blocked by these).
    //
    // overrideToken bypass: SUPER_ADMIN / ADMIN can mint a one-shot token
    // via POST /:id/override-edit-lock and forward it on this PUT body to
    // skip Rule 3 ONLY. Rules 1 and 2 are NOT bypassable — they protect
    // committed production output and state-machine validity, which no
    // amount of admin override can safely waive.
    // ---------------------------------------------------------------------
    if (
      !isStatusOnly &&
      (existing.status === "IN_PRODUCTION" ||
        existing.status === "CONFIRMED")
    ) {
      // Pull earliest completed JC + earliest scheduled JC dueDate in one
      // round-trip — same query shape as the eligibility GET handler.
      const [completedRes, earliestDueRes] = await Promise.all([
        c.var.DB
          .prepare(
            `SELECT jc.completedDate, jc.departmentName, jc.departmentCode
               FROM job_cards jc
               JOIN production_orders po ON po.id = jc.productionOrderId
              WHERE po.salesOrderId = ?
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
              WHERE po.salesOrderId = ?
                AND jc.dueDate IS NOT NULL
                AND jc.dueDate <> ''
              ORDER BY jc.dueDate ASC
              LIMIT 1`,
          )
          .bind(id)
          .first<{ dueDate: string | null }>(),
      ]);

      // Rule 2 — dept_completed. NOT bypassable by overrideToken: real
      // production output exists, editing items would orphan finished WIP.
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

      // Rule 3 — production_window. Bypassable via a valid overrideToken.
      const earliestDue = earliestDueRes?.dueDate?.slice(0, 10) ?? "";
      if (earliestDue.length === 10) {
        const cutoff = new Date();
        cutoff.setUTCDate(cutoff.getUTCDate() + 2);
        const cutoffStr = cutoff.toISOString().slice(0, 10);
        if (earliestDue <= cutoffStr) {
          const overrideToken =
            typeof body.overrideToken === "string" ? body.overrideToken : "";
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
          // Verify + atomically consume the token. Rejects on wrong order
          // / expired / already-used / not-found — each maps to a distinct
          // 403 error message so the FE can show the operator what went
          // wrong (token expired → "request a new override", etc.).
          const consumed = await consumeEditLockOverrideToken(
            c.var.DB,
            overrideToken,
            "SO",
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
    const now = new Date().toISOString();

    const statements: D1PreparedStatement[] = [];
    let newStatus: string = existing.status;
    let pendingStatusChangeId: string | null = null;
    let isDraftToConfirmed = false;
    // Cascade result from ON_HOLD / CANCELLED / RESUME transitions — prepended
    // to the batch below so the SO + PO + JC updates land atomically.
    let cascade: SOCascadeResult | null = null;

    // --- Status change with validation ---
    if (body.status && body.status !== existing.status) {
      const requested = body.status as string;
      const validNext = VALID_TRANSITIONS[existing.status] || [];
      if (!validNext.includes(requested)) {
        return c.json(
          {
            success: false,
            error: `Invalid status transition: ${existing.status} -> ${requested}. Valid transitions: ${validNext.join(", ") || "none"}`,
          },
          400,
        );
      }
      newStatus = requested;
      // 2026-04-28: confirm-equivalent transitions are DRAFT/PENDING → either
      // CONFIRMED (legacy callers) or IN_PRODUCTION (new direct path). Both
      // need the production-order cascade and the same audit-row deferral.
      isDraftToConfirmed =
        (existing.status === "DRAFT" || existing.status === "PENDING") &&
        (newStatus === "CONFIRMED" || newStatus === "IN_PRODUCTION");

      // Pre-flight: block CANCELLED transition when any job_card under this
      // SO's POs has a completedDate stamped. Stranded inventory would result
      // if we cascaded CANCELLED through completed work — operators must
      // first clear the completion dates or reassign those finished units to
      // another order. Returns 409 Conflict (distinct from 4xx validation
      // errors) so the frontend can render a specific blocked-cancel modal.
      if (newStatus === "CANCELLED") {
        const blockingRes = await c.var.DB
          .prepare(
            `SELECT jc.id, jc.completedDate, jc.departmentCode, jc.departmentName, po.poNo
               FROM job_cards jc
               JOIN production_orders po ON po.id = jc.productionOrderId
              WHERE po.salesOrderId = ?
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
          return c.json(
            {
              success: false,
              error: "Cannot cancel: completed work blocks cancellation",
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

      // Run cascade for ON_HOLD / CANCELLED transitions and for RESUME
      // (ON_HOLD → CONFIRMED / IN_PRODUCTION). cascadeSOStatusToPOs is a no-op
      // for any other transition, so calling it unconditionally is cheap.
      cascade = await cascadeSOStatusToPOs(
        c.var.DB,
        id,
        newStatus,
        existing.status,
        now,
      );

      // Defer the status-change INSERT until after the PO cascade runs so we
      // can stamp autoActions with the created PO numbers.
      pendingStatusChangeId = genStatusId();
      if (!isDraftToConfirmed) {
        statements.push(
          c.var.DB.prepare(
            `INSERT INTO so_status_changes
               (id, soId, fromStatus, toStatus, changedBy, timestamp, notes, autoActions)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            pendingStatusChangeId,
            id,
            existing.status,
            newStatus,
            (body.changedBy as string) || "Admin",
            now,
            (body.statusNotes as string) || `Status changed to ${newStatus}`,
            JSON.stringify(cascade?.actions ?? []),
          ),
        );
        // Queue the cascade UPDATEs for POs (and job_cards on CANCELLED).
        if (cascade && cascade.statements.length > 0) {
          statements.push(...cascade.statements);
        }
      }
    }

    // --- Customer / hub resolution ---
    let customerId = existing.customerId;
    let customerName = existing.customerName;
    let customerState = existing.customerState ?? "";
    let hubId = existing.hubId;
    let hubName = existing.hubName ?? "";

    if (body.customerId) {
      const customer = await c.var.DB.prepare(
        "SELECT id, name FROM customers WHERE id = ?",
      )
        .bind(body.customerId)
        .first<{ id: string; name: string }>();
      if (customer) {
        customerId = customer.id;
        customerName = customer.name;
      }
    }

    if (body.hubId !== undefined) {
      if (body.hubId) {
        const hub = await c.var.DB.prepare(
          "SELECT id, state, shortName FROM delivery_hubs WHERE id = ? AND customerId = ?",
        )
          .bind(body.hubId, customerId)
          .first<{ id: string; state: string | null; shortName: string }>();
        if (hub) {
          hubId = hub.id;
          hubName = hub.shortName;
          customerState = hub.state ?? customerState;
        } else {
          hubId = null;
          hubName = "";
        }
      } else {
        hubId = null;
        hubName = "";
      }
    }

    // --- Merge scalar fields ---
    const merged = {
      customerPO: body.customerPO ?? existing.customerPO ?? "",
      customerPOId: body.customerPOId ?? existing.customerPOId ?? "",
      customerPODate: body.customerPODate ?? existing.customerPODate ?? "",
      customerSO: body.customerSO ?? existing.customerSO ?? "",
      customerSOId: body.customerSOId ?? existing.customerSOId ?? "",
      reference: body.reference ?? existing.reference ?? "",
      customerState,
      companySO: body.companySO ?? existing.companySO ?? "",
      companySODate: body.companySODate ?? existing.companySODate ?? "",
      customerDeliveryDate:
        body.customerDeliveryDate ?? existing.customerDeliveryDate ?? "",
      hookkaExpectedDD: body.hookkaExpectedDD ?? existing.hookkaExpectedDD ?? "",
      hookkaDeliveryOrder:
        body.hookkaDeliveryOrder ?? existing.hookkaDeliveryOrder ?? "",
      overdue: body.overdue ?? existing.overdue ?? "PENDING",
      notes: body.notes ?? existing.notes ?? "",
    };

    // --- Replace items (if provided) ---
    let subtotalSen = existing.subtotalSen;
    let totalSen = existing.totalSen;

    if (body.items) {
      const rawItems: Array<Record<string, unknown>> = body.items;

      // Hard restriction: SOFA + BEDFRAME may NOT coexist on a single SO.
      // Same rule as POST — see helper for the why. Fail fast before any
      // DB writes are queued.
      if (
        hasMixedSofaBedframe(
          rawItems.map((it) => ({
            itemCategory:
              typeof it.itemCategory === "string" ? it.itemCategory : null,
          })),
        )
      ) {
        return c.json({ success: false, error: SO_MIXED_CATEGORY_ERROR }, 400);
      }

      const oldItemsRes = await c.var.DB.prepare(
        "SELECT * FROM sales_order_items WHERE salesOrderId = ?",
      )
        .bind(id)
        .all<SalesOrderItemRow>();
      const oldItems = oldItemsRes.results ?? [];
      const priceAsOf =
        typeof merged.companySODate === "string" && merged.companySODate
          ? merged.companySODate.slice(0, 10)
          : new Date().toISOString().slice(0, 10);
      const newItems = await Promise.all(rawItems.map(async (item, idx) => {
        const incomingBase = Number(item.basePriceSen) || 0;
        let basePriceSen = incomingBase;
        // Customer-specific override: only when request didn't supply a price.
        const productIdForLookup = (item.productId as string) || "";
        if (incomingBase === 0 && productIdForLookup && customerId) {
          try {
            const cp = await resolveCustomerPriceAsOf(
              c.var.DB,
              productIdForLookup,
              customerId,
              priceAsOf,
            );
            if (cp) {
              const seatHeight = String(item.seatHeight ?? "");
              if (cp.seatHeightPrices && cp.seatHeightPrices.length > 0 && seatHeight) {
                const shp = cp.seatHeightPrices.find(
                  (p) => p.height === seatHeight || p.height === `${seatHeight}"`,
                );
                basePriceSen = shp?.priceSen ?? cp.basePriceSen ?? 0;
              } else {
                basePriceSen = cp.basePriceSen ?? 0;
              }
            }
          } catch {
            // Non-fatal — keep basePriceSen at 0 if lookup fails.
          }
        }
        const divanPriceSen = Number(item.divanPriceSen) || 0;
        const legPriceSen = Number(item.legPriceSen) || 0;
        const specialOrderPriceSen = Number(item.specialOrderPriceSen) || 0;
        const unitPriceSen = calculateUnitPrice({
          basePriceSen,
          divanPriceSen,
          legPriceSen,
          specialOrderPriceSen,
        });
        const quantity = Number(item.quantity) || 0;
        const lineTotalSen = calculateLineTotal(unitPriceSen, quantity);
        const lineNo = idx + 1;
        const lineSuffix = `-${String(lineNo).padStart(2, "0")}`;

        const oldItem = oldItems.find(
          (oi) =>
            oi.id === item.id ||
            (oi.productId === item.productId && oi.lineNo === lineNo),
        );

        const priceOverride =
          oldItem && oldItem.unitPriceSen !== unitPriceSen
            ? {
                id: genOverrideId(),
                originalPrice: oldItem.unitPriceSen,
                overridePrice: unitPriceSen,
                reason:
                  (item.priceOverrideReason as string) || "No reason provided",
                approvedBy: (body.changedBy as string) || "Admin",
              }
            : null;

        return {
          id: (item.id as string) || genItemId(),
          lineNo,
          lineSuffix,
          productId: (item.productId as string) || "",
          productCode: (item.productCode as string) || "",
          productName: (item.productName as string) || "",
          itemCategory: (item.itemCategory as string) || "BEDFRAME",
          sizeCode: (item.sizeCode as string) || "",
          sizeLabel: (item.sizeLabel as string) || "",
          fabricId: (item.fabricId as string) || "",
          fabricCode: (item.fabricCode as string) || "",
          quantity,
          gapInches: item.gapInches ?? null,
          divanHeightInches: item.divanHeightInches ?? null,
          divanPriceSen,
          legHeightInches: item.legHeightInches ?? null,
          legPriceSen,
          specialOrder: (item.specialOrder as string) || "",
          specialOrderPriceSen,
          basePriceSen,
          unitPriceSen,
          lineTotalSen,
          notes: (item.notes as string) || "",
          _priceOverride: priceOverride,
          _lineIndex: idx,
        };
      }));

      subtotalSen = newItems.reduce((sum, i) => sum + i.lineTotalSen, 0);
      totalSen = subtotalSen;

      // Delete old, insert new
      statements.push(
        c.var.DB.prepare(
          "DELETE FROM sales_order_items WHERE salesOrderId = ?",
        ).bind(id),
      );
      for (const item of newItems) {
        statements.push(
          c.var.DB.prepare(
            `INSERT INTO sales_order_items (id, salesOrderId, lineNo, lineSuffix,
               productId, productCode, productName, itemCategory, sizeCode, sizeLabel,
               fabricId, fabricCode, quantity, gapInches, divanHeightInches,
               divanPriceSen, legHeightInches, legPriceSen, specialOrder,
               specialOrderPriceSen, basePriceSen, unitPriceSen, lineTotalSen, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            item.id,
            id,
            item.lineNo,
            item.lineSuffix,
            item.productId,
            item.productCode,
            item.productName,
            item.itemCategory,
            item.sizeCode,
            item.sizeLabel,
            item.fabricId,
            item.fabricCode,
            item.quantity,
            item.gapInches,
            item.divanHeightInches,
            item.divanPriceSen,
            item.legHeightInches,
            item.legPriceSen,
            item.specialOrder,
            item.specialOrderPriceSen,
            item.basePriceSen,
            item.unitPriceSen,
            item.lineTotalSen,
            item.notes,
          ),
        );

        if (item._priceOverride) {
          statements.push(
            c.var.DB.prepare(
              `INSERT INTO price_overrides
                 (id, soId, soNumber, lineIndex, originalPrice, overridePrice,
                  reason, approvedBy, timestamp)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).bind(
              item._priceOverride.id,
              id,
              existing.companySOId ?? "",
              item._lineIndex,
              item._priceOverride.originalPrice,
              item._priceOverride.overridePrice,
              item._priceOverride.reason,
              item._priceOverride.approvedBy,
              now,
            ),
          );
        }
      }
    }

    statements.push(
      c.var.DB.prepare(
        `UPDATE sales_orders SET
           customerPO = ?, customerPOId = ?, customerPODate = ?,
           customerSO = ?, customerSOId = ?, reference = ?,
           customerId = ?, customerName = ?, customerState = ?,
           hubId = ?, hubName = ?, companySO = ?, companySODate = ?,
           customerDeliveryDate = ?, hookkaExpectedDD = ?, hookkaDeliveryOrder = ?,
           subtotalSen = ?, totalSen = ?, status = ?, overdue = ?, notes = ?,
           updated_at = ?
         WHERE id = ?`,
      ).bind(
        merged.customerPO,
        merged.customerPOId,
        merged.customerPODate,
        merged.customerSO,
        merged.customerSOId,
        merged.reference,
        customerId,
        customerName,
        merged.customerState,
        hubId,
        hubName,
        merged.companySO,
        merged.companySODate,
        merged.customerDeliveryDate,
        merged.hookkaExpectedDD,
        merged.hookkaDeliveryOrder,
        subtotalSen,
        totalSen,
        newStatus,
        merged.overdue,
        merged.notes,
        now,
        id,
      ),
    );

    // --- DRAFT -> CONFIRMED cascade: auto-create production_orders ---
    let createdProductionOrders: CreatedProductionOrder[] = [];
    if (isDraftToConfirmed) {
      // BOM completeness guard — checks the items that will actually be
      // persisted (body.items if provided, else current DB rows). Fires
      // before batch runs so a 422 leaves the SO + PO tables untouched.
      const bomCheckItems: SalesOrderItemRow[] = body.items
        ? (body.items as Array<Record<string, unknown>>).map((item, idx) => ({
            id: (item.id as string) || "",
            salesOrderId: id,
            lineNo: idx + 1,
            lineSuffix: `-${String(idx + 1).padStart(2, "0")}`,
            productId: (item.productId as string) || "",
            productCode: (item.productCode as string) || "",
            productName: (item.productName as string) || "",
            itemCategory: (item.itemCategory as string) || "BEDFRAME",
            sizeCode: (item.sizeCode as string) || "",
            sizeLabel: (item.sizeLabel as string) || "",
            fabricId: (item.fabricId as string) || "",
            fabricCode: (item.fabricCode as string) || "",
            quantity: Number(item.quantity) || 0,
            gapInches: (item.gapInches as number | null) ?? null,
            divanHeightInches: (item.divanHeightInches as number | null) ?? null,
            divanPriceSen: Number(item.divanPriceSen) || 0,
            legHeightInches: (item.legHeightInches as number | null) ?? null,
            legPriceSen: Number(item.legPriceSen) || 0,
            specialOrder: (item.specialOrder as string) || "",
            specialOrderPriceSen: Number(item.specialOrderPriceSen) || 0,
            basePriceSen: Number(item.basePriceSen) || 0,
            unitPriceSen: 0,
            lineTotalSen: 0,
            notes: (item.notes as string) || "",
          }))
        : (
            await c.var.DB.prepare(
              "SELECT * FROM sales_order_items WHERE salesOrderId = ?",
            )
              .bind(id)
              .all<SalesOrderItemRow>()
          ).results ?? [];

      const incompleteProducts = await findIncompleteBomProducts(
        c.var.DB,
        bomCheckItems,
      );
      if (incompleteProducts.length > 0) {
        return c.json(
          {
            success: false,
            error: "BOM incomplete — cannot confirm. Save as draft first.",
            details: { incompleteProducts },
          },
          422,
        );
      }

      // Build the "effective" SO row (merged fields) so the PO cascade uses
      // the freshest customer/hub/date values — body.items may also have
      // replaced items already queued for delete+insert above.
      const effectiveSO: SalesOrderRow = {
        ...existing,
        customerPOId: merged.customerPOId,
        reference: merged.reference,
        customerId,
        customerName,
        customerState: merged.customerState,
        hubId,
        hubName,
        companySODate: merged.companySODate,
        customerDeliveryDate: merged.customerDeliveryDate,
        hookkaExpectedDD: merged.hookkaExpectedDD,
      };

      // Items source: if the body is replacing items, read them from the body
      // so we can cascade against the NEW items. Otherwise fetch from DB.
      let effectiveItems: SalesOrderItemRow[];
      if (body.items) {
        const rawItems: Array<Record<string, unknown>> = body.items;
        effectiveItems = rawItems.map((item, idx) => {
          const lineNo = idx + 1;
          const lineSuffix = `-${String(lineNo).padStart(2, "0")}`;
          return {
            id: (item.id as string) || "",
            salesOrderId: id,
            lineNo,
            lineSuffix,
            productId: (item.productId as string) || "",
            productCode: (item.productCode as string) || "",
            productName: (item.productName as string) || "",
            itemCategory: (item.itemCategory as string) || "BEDFRAME",
            sizeCode: (item.sizeCode as string) || "",
            sizeLabel: (item.sizeLabel as string) || "",
            fabricId: (item.fabricId as string) || "",
            fabricCode: (item.fabricCode as string) || "",
            quantity: Number(item.quantity) || 0,
            gapInches: (item.gapInches as number | null) ?? null,
            divanHeightInches: (item.divanHeightInches as number | null) ?? null,
            divanPriceSen: Number(item.divanPriceSen) || 0,
            legHeightInches: (item.legHeightInches as number | null) ?? null,
            legPriceSen: Number(item.legPriceSen) || 0,
            specialOrder: (item.specialOrder as string) || "",
            specialOrderPriceSen: Number(item.specialOrderPriceSen) || 0,
            basePriceSen: Number(item.basePriceSen) || 0,
            unitPriceSen: 0,
            lineTotalSen: 0,
            notes: (item.notes as string) || "",
          };
        });
      } else {
        const itemsRes = await c.var.DB.prepare(
          "SELECT * FROM sales_order_items WHERE salesOrderId = ?",
        )
          .bind(id)
          .all<SalesOrderItemRow>();
        effectiveItems = itemsRes.results ?? [];
      }

      const { statements: poStmts, created, preExisting } =
        await createProductionOrdersForSO(
          c.var.DB,
          effectiveSO,
          effectiveItems,
        );
      createdProductionOrders = created;

      const autoActions = preExisting
        ? ["Production orders already exist for this SO — skipped duplicate creation."]
        : created.map((po) => `Created PO ${po.poNo}`);

      statements.push(
        c.var.DB.prepare(
          `INSERT INTO so_status_changes
             (id, soId, fromStatus, toStatus, changedBy, timestamp, notes, autoActions)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          pendingStatusChangeId ?? genStatusId(),
          id,
          existing.status,
          newStatus,
          (body.changedBy as string) || "Admin",
          now,
          (body.statusNotes as string) || `Status changed to ${newStatus}`,
          JSON.stringify(autoActions),
        ),
      );
      statements.push(...poStmts);
    }

    await c.var.DB.batch(statements);

    const updated = await fetchSOWithItems(c.var.DB, id);
    return c.json({
      success: true,
      data: updated,
      linkedPOs: createdProductionOrders,
      productionOrders: createdProductionOrders,
      // Cascade summary surfaced to the UI so the toast can show
      // "3 production orders moved to ON_HOLD". Null when the PUT
      // didn't change status or the transition doesn't cascade.
      cascade: cascade
        ? {
            affectedPoCount: cascade.affectedPoCount,
            affectedJcCount: cascade.affectedJcCount,
            actions: cascade.actions,
          }
        : null,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[PUT /api/sales-orders/:id] failed:", msg, err);
    if (err instanceof SyntaxError) {
      return c.json({ success: false, error: "Invalid JSON in request body" }, 400);
    }
    return c.json({ success: false, error: msg || "Internal error updating sales order" }, 500);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/sales-orders/:id — cascades to items via FK
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.var.DB.prepare(
    "SELECT id FROM sales_orders WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string }>();
  if (!existing) {
    return c.json({ success: false, error: "Order not found" }, 404);
  }
  await c.var.DB.prepare("DELETE FROM sales_orders WHERE id = ?").bind(id).run();
  return c.json({ success: true });
});

export default app;
