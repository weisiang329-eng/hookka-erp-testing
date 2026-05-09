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
import {
  snapItemToCatalog,
  loadProductCatalog,
} from "./_shared/item-catalog-snap";
import { withOrgScope } from "../lib/tenant";
import {
  createProductionOrdersForOrder,
  parseL1Processes,
  type CreatedProductionOrder,
} from "./_shared/production-builder";
import { checkSalesOrderLocked, lockedResponse } from "../lib/lock-helpers";
import {
  createEditLockOverride,
  lookupActorDisplayName,
  MIN_OVERRIDE_REASON_LEN,
} from "../lib/edit-lock-override";
import { readIdempotencyKey, withIdempotency } from "../lib/idempotency";
import {
  validateFabricCodes,
  unknownFabricCodeError,
} from "../lib/fabric-validation";

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
  // Base64-encoded PNG of the original customer PO page(s) when this SO was
  // created from a Scan PO upload. Nullable — populated only by PO_SCAN_CLAUDE.
  customerPOImageB64: string | null;
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
  fabricCode: string | null;
  quantity: number;
  gapInches: number | null;
  divanHeightInches: number | null;
  divanPriceSen: number;
  legHeightInches: number | null;
  legPriceSen: number;
  specialOrder: string | null;
  specialOrderPriceSen: number;
  // Free-text custom specials per line. Stored as JSON string of
  // Array<{ description: string; surchargeSen: number }>. NULL/empty when
  // the operator hasn't attached any. The aggregate surcharge is folded
  // into specialOrderPriceSen at write time and the descriptions are
  // suffixed into `specialOrder` as "OTHER: <desc>" tokens so legacy
  // readers (DO print, invoice, detail page) still see the full list.
  // See migration 0074.
  customSpecials: string | null;
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

// Parse the customSpecials JSON column into a plain array. Always returns
// an array — invalid JSON / non-array shapes fall back to [] so the
// frontend can iterate without null checks. See migration 0074.
function parseCustomSpecials(
  raw: string | null,
): Array<{ description: string; surchargeSen: number }> {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is { description: string; surchargeSen: number } =>
          !!e &&
          typeof e === "object" &&
          typeof (e as { description?: unknown }).description === "string" &&
          typeof (e as { surchargeSen?: unknown }).surchargeSen === "number",
      )
      .map((e) => ({
        description: e.description,
        surchargeSen: e.surchargeSen,
      }));
  } catch {
    return [];
  }
}

// Sanitize an incoming `customSpecials` payload from a POST/PUT body. Drops
// entries with empty descriptions, coerces surchargeSen to a non-negative
// integer, and returns the cleaned list. Non-array input → [].
type IncomingCustomSpecial = { description: string; surchargeSen: number };
function sanitizeCustomSpecials(raw: unknown): IncomingCustomSpecial[] {
  if (!Array.isArray(raw)) return [];
  const out: IncomingCustomSpecial[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const obj = e as Record<string, unknown>;
    const desc =
      typeof obj.description === "string" ? obj.description.trim() : "";
    if (!desc) continue;
    const surcharge = Number(obj.surchargeSen);
    out.push({
      description: desc,
      surchargeSen: Number.isFinite(surcharge) && surcharge > 0
        ? Math.round(surcharge)
        : 0,
    });
  }
  return out;
}

// Serialize the cleaned customSpecials list for storage. Returns null when
// the list is empty so the column stays NULL rather than '"[]"' — keeps
// legacy reads (and the parser) cheap.
function serializeCustomSpecials(list: IncomingCustomSpecial[]): string | null {
  return list.length === 0 ? null : JSON.stringify(list);
}

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
    fabricCode: r.fabricCode ?? "",
    quantity: r.quantity,
    gapInches: r.gapInches,
    divanHeightInches: r.divanHeightInches,
    divanPriceSen: r.divanPriceSen,
    legHeightInches: r.legHeightInches,
    legPriceSen: r.legPriceSen,
    specialOrder: r.specialOrder ?? "",
    specialOrderPriceSen: r.specialOrderPriceSen,
    // Hand the parsed array to the frontend, not the raw JSON string.
    // The form pages mutate this list directly; serialization back to
    // JSON happens on the POST/PUT path.
    customSpecials: parseCustomSpecials(r.customSpecials),
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
    customerPOImageB64: row.customerPOImageB64 ?? null,
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
//
// opts.force = true (NEW): blow away any existing job_cards for the PO and
// regenerate them from the current BOM template + Production Time master.
// Used by the bulk regen endpoint in production-orders.ts (added 2026-04-29
// so the user can wipe the snapshotted JC values across every PO after
// editing the BOM/PT master). The DELETE statement is prepended to the
// returned `statements` array so the caller's `db.batch([...])` runs
// DELETE + re-insert atomically — no window where the PO is JC-less.
// User confirmed there is NO scan history / completion data on the existing
// job_cards (small shop, freshly-spun-up data set), so the wipe is lossless.
// ---------------------------------------------------------------------------
export async function backfillJobCardsForPo(
  db: D1Database,
  poId: string,
  opts?: { force?: boolean },
): Promise<{ statements: D1PreparedStatement[]; jcCount: number; currentDept: string | null }> {
  await ensureLeadTimesSeeded(db);
  await ensureHookkaDDBufferSeeded(db);
  const leadTimes = await loadLeadTimes(db);
  const hookkaDDBuffer = await loadHookkaDDBuffer(db);

  const force = opts?.force === true;

  // Skip if any job_cards already exist (unless force-mode says wipe-and-redo).
  if (!force) {
    const existingJc = await db
      .prepare("SELECT id FROM job_cards WHERE productionOrderId = ? LIMIT 1")
      .bind(poId)
      .first<{ id: string }>();
    if (existingJc) {
      return { statements: [], jcCount: 0, currentDept: null };
    }
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
  // Force-mode: prepend a DELETE so any pre-existing job_cards for this PO
  // are wiped in the same atomic batch as the re-insert. Caller passes the
  // returned `statements` straight into db.batch([...]).
  if (force) {
    statements.push(
      db.prepare("DELETE FROM job_cards WHERE productionOrderId = ?").bind(poId),
    );
  }
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
// GET /api/sales-orders/stats — whole-dataset status bucket counts + revenue.
//
// Returns:
//   {
//     byStatus: Record<status, count>,
//     revenueByStatus: Record<status, totalSen>,
//     total: count,
//     totalRevenueSen: raw sum across every status,
//     csRevenueSen: "Confirmed Sales" — sum across the post-DRAFT, non-paused,
//                    non-cancelled status set (CONFIRMED → CLOSED). This is
//                    the headline revenue number the operator reads off the
//                    SO list page.
//   }
//
// Used by the list page tile cards so "Revenue" reflects the whole table
// rather than just the current paginated page (the previous client-side
// `orders.reduce(...)` was bounded by PAGE_SIZE=200 when no filter was
// active, so a 444-row dataset under-reported revenue by ~half).
//
// Single aggregate SELECT — cheap. Tenant-scoped via withOrgScope.
// Registered BEFORE /:id (Hono route ordering: static before wildcards).
// ---------------------------------------------------------------------------
const CS_STATUSES = new Set([
  "CONFIRMED",
  "IN_PRODUCTION",
  "READY_TO_SHIP",
  "SHIPPED",
  "DELIVERED",
  "INVOICED",
  "CLOSED",
]);

app.get("/stats", async (c) => {
  const { whereSql: orgWhere, params: orgParams } = withOrgScope(
    c,
    "sales_orders",
  );
  const res = await c.var.DB
    .prepare(
      `SELECT status                        AS "status",
              COUNT(*)                      AS "n",
              COALESCE(SUM(totalSen), 0)    AS "revenueSen"
         FROM sales_orders
         ${orgWhere}
         GROUP BY status`,
    )
    .bind(...orgParams)
    .all<{ status: string; n: number; revenueSen: number }>();
  const byStatus: Record<string, number> = {};
  const revenueByStatus: Record<string, number> = {};
  let total = 0;
  let totalRevenueSen = 0;
  let csRevenueSen = 0;
  for (const row of res.results ?? []) {
    byStatus[row.status] = row.n;
    revenueByStatus[row.status] = Number(row.revenueSen) || 0;
    total += row.n;
    totalRevenueSen += Number(row.revenueSen) || 0;
    if (CS_STATUSES.has(row.status)) {
      csRevenueSen += Number(row.revenueSen) || 0;
    }
  }
  return c.json({
    success: true,
    byStatus,
    revenueByStatus,
    total,
    totalRevenueSen,
    csRevenueSen,
  });
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
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;
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

  // IN_PRODUCTION — Option D unified rule (2026-05-06): the SO is editable
  // only when EVERY job_card under its POs is still WAITING or CANCELLED.
  // Once any JC has been stamped IN_PROGRESS / COMPLETED / TRANSFERRED, real
  // production is underway and a teardown+rebuild from sales_order_items
  // would orphan that work — so we hard-lock structural edits. This subsumes
  // the old "dept_completed" rule (which only checked completedDate) and the
  // 2-day production_window soft lock (already removed earlier).
  const productionStartedRes = await c.var.DB
    .prepare(
      `SELECT jc.departmentName, jc.departmentCode, jc.status, jc.completedDate
         FROM job_cards jc
         JOIN production_orders po ON po.id = jc.productionOrderId
        WHERE po.salesOrderId = ?
          AND jc.status NOT IN ('WAITING', 'CANCELLED')
        ORDER BY jc.sequence ASC, jc.id ASC
        LIMIT 1`,
    )
    .bind(id)
    .first<{
      departmentName: string | null;
      departmentCode: string | null;
      status: string | null;
      completedDate: string | null;
    }>();

  // Rule 2 (Option D): any JC has moved past WAITING → fully locked.
  if (productionStartedRes && productionStartedRes.status) {
    return c.json({
      success: true,
      editable: false,
      reason: "production_started",
      status: so.status,
      startedDept:
        productionStartedRes.departmentName ||
        productionStartedRes.departmentCode ||
        "A department",
      startedDeptCode: productionStartedRes.departmentCode || "",
      jcStatus: productionStartedRes.status,
      completedAt: productionStartedRes.completedDate || null,
    });
  }

  // IN_PRODUCTION + every JC still WAITING/CANCELLED → editable. PUT will
  // teardown + rebuild POs/JCs from sales_order_items on save.
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

// Self-applying migrations — columns added at first POST per isolate.
// `ALTER ... ADD COLUMN IF NOT EXISTS` is idempotent + cheap, so running it
// here removes the deploy ordering footgun where new columns aren't applied
// to Supabase yet (the legacy `migrations/` D1 folder doesn't auto-replay
// on Postgres). Module-level promise ensures one round of ALTERs per
// isolate boot, not per request.
let pendingMigrations: Promise<void> | null = null;
function ensurePendingMigrations(db: D1Database): Promise<void> {
  if (pendingMigrations) return pendingMigrations;
  pendingMigrations = (async () => {
    // Each ALTER runs independently so a permission failure on one doesn't
    // mask the others. Best-effort: a real schema-mismatch error will
    // resurface on the INSERT below with a clearer message.
    const stmts = [
      // 0108 — customer PO PNG attachment for dispute proof.
      "ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS customerPOImageB64 TEXT",
      // 0113 — drop fabric_id (UI-only artifact; canonical reference is
      // fabric_code). See migrations-postgres/0113_drop_fabric_id_from_order_items.sql
      // for the full rationale. Idempotent — DROP IF EXISTS no-ops once applied.
      "ALTER TABLE sales_order_items DROP COLUMN IF EXISTS fabric_id",
      "ALTER TABLE consignment_order_items DROP COLUMN IF EXISTS fabric_id",
      // 0114 — drop sales_orders.is_project_order. Toggle removed 2026-05-09
      // because SOFA qty>1 is now rejected (commit 7302f0f) so the per-piece
      // SOFA fan-out the toggle controlled is moot; FAB_CUT cross-PO merge
      // becomes unconditional. See migrations-postgres/0114_drop_so_is_project_order.sql.
      "ALTER TABLE sales_orders DROP COLUMN IF EXISTS is_project_order",
    ];
    for (const sql of stmts) {
      try {
        await db.prepare(sql).run();
      } catch {
        // ignore — column may already exist or DDL transiently rejected
      }
    }
  })();
  return pendingMigrations;
}

// ---------------------------------------------------------------------------
// POST /api/sales-orders — create a new SO + items atomically
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  // RBAC gate (P3.3) — only roles with sales-orders:create may create SOs.
  const denied = await requirePermission(c, "sales-orders", "create");
  if (denied) return denied;
  await ensurePendingMigrations(c.var.DB);

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

    // Fabric integrity gate — every non-empty incoming fabricCode must
    // resolve to a row in raw_materials with a fabric itemGroup. Closes
    // the door on operators saving stale/typo codes (e.g. M2402-04 when
    // only M2402-4 exists). Empty fabricCode is legal — line items
    // without fabric simply skip the check.
    {
      const fabCheck = await validateFabricCodes(
        c.var.DB,
        rawItems.map((it) => (it.fabricCode as string | null | undefined)),
      );
      if (!fabCheck.valid) {
        return c.json(unknownFabricCodeError(fabCheck.unknown), 400);
      }
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
        const incomingItemCategory = String(item.itemCategory ?? "");
        const isSofaItem = incomingItemCategory === "SOFA";
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
        // Free-text custom specials per line (migration 0074). Sanitized
        // here — empty descriptions dropped, surcharge coerced to ≥0 sen.
        // Stored as JSON string in sales_order_items.customSpecials. The
        // aggregate surcharge is already folded into specialOrderPriceSen
        // by the client; we trust the client value rather than recomputing
        // (the existing flow does the same for predefined specials).
        const cleanedCustomSpecials = sanitizeCustomSpecials(item.customSpecials);

        // 2026-05-09: fabricId resolve removed. Picker now keys on fabricCode
        // directly; sales_order_items.fabricId is being dropped in a follow-up
        // migration. Persist null so existing rows aren't accidentally seeded
        // with a fresh stale id.
        const incomingFabricCode = String(item.fabricCode ?? "");

        // Sofa seat-size normalization. The OCR pipeline ships sizeLabel
        // as a bare number (e.g. "28") matching the SOFA Sizes catalog
        // entry, but the Edit/Detail dropdowns key against quoted values
        // (e.g. '28"'). Normalize once at the storage boundary so every
        // downstream reader (Edit form, production sheet, etc.) sees the
        // same shape. Only applies to SOFA items — bedframe sizeLabel is
        // a free-form string like "Queen 5FT".
        // Catalog vs client priority depends on category:
        //   BEDFRAME — sizeLabel IS catalog data ("6FT" / "5FT" etc.).
        //              Catalog ALWAYS wins. Shuts the OCR back-door where
        //              the modal could persist PDF junk like "(K)".
        //   SOFA — sizeLabel is the seat height the user picked (e.g.
        //          "24""). Catalog's SOFA sizeLabel is the variant tag
        //          ("1A(LHF)"), which is NOT what we store on the SO line.
        //          Client wins, falls back to catalog only when missing.
        let normalizedSizeLabel: string;
        let normalizedSizeCode: string;
        if (isSofaItem) {
          normalizedSizeLabel =
            (item.sizeLabel as string) ||
            (item.sizeCode as string) ||
            "";
          if (
            normalizedSizeLabel &&
            /^\d+(\.\d+)?$/.test(normalizedSizeLabel.trim())
          ) {
            normalizedSizeLabel = `${normalizedSizeLabel.trim()}"`;
          }
          normalizedSizeCode = (item.sizeCode as string) || "";
          if (!normalizedSizeCode && normalizedSizeLabel) {
            normalizedSizeCode = normalizedSizeLabel.replace(/"/g, "").trim();
          }
        } else {
          // BEDFRAME / ACCESSORY — catalog wins for both.
          normalizedSizeLabel =
            resolvedProduct?.sizeLabel ||
            (item.sizeLabel as string) ||
            "";
          normalizedSizeCode =
            resolvedProduct?.sizeCode ||
            (item.sizeCode as string) ||
            "";
        }

        return {
          id: (item.id as string) || genItemId(),
          lineNo,
          lineSuffix,
          productId: resolvedProduct?.id || (item.productId as string) || "",
          productCode,
          // Catalog wins. If productCode resolves to a product, its name
          // is what we persist — the client can't shove PDF text through.
          productName:
            resolvedProduct?.name || (item.productName as string) || productCode,
          itemCategory:
            resolvedProduct?.category ||
            (item.itemCategory as string) ||
            "BEDFRAME",
          sizeCode: normalizedSizeCode,
          sizeLabel: normalizedSizeLabel,
          fabricCode: incomingFabricCode,
          quantity,
          gapInches: item.gapInches ?? null,
          divanHeightInches: item.divanHeightInches ?? null,
          divanPriceSen,
          legHeightInches: item.legHeightInches ?? null,
          legPriceSen,
          specialOrder: (item.specialOrder as string) || "",
          specialOrderPriceSen,
          customSpecials: cleanedCustomSpecials,
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

    // Auto-derive Hookka Expected DD = customer DD - per-category buffer.
    // Filled at create time so the SO list / detail page show it right
    // away (don't wait for confirm cascade). Operator can still override
    // by passing body.hookkaExpectedDD explicitly. Mirrors what
    // production-order-builder does on confirm — but eagerly.
    let resolvedHookkaExpectedDD =
      typeof body.hookkaExpectedDD === "string" && body.hookkaExpectedDD
        ? body.hookkaExpectedDD
        : "";
    if (!resolvedHookkaExpectedDD && body.customerDeliveryDate) {
      try {
        const buf = await loadHookkaDDBuffer(c.var.DB);
        // Use the dominant item category — mixed-category SOs are
        // forbidden upstream by hasMixedSofaBedframe so first item is
        // representative.
        const dominantCat =
          (items[0]?.itemCategory as string | undefined) || "BEDFRAME";
        const days = hookkaDDBufferFor(buf, dominantCat);
        resolvedHookkaExpectedDD = addDays(
          String(body.customerDeliveryDate).slice(0, 10),
          -days,
        );
      } catch {
        // Lead-time table missing or malformed — fall through with empty
        // string. Cascade will fill it on confirm.
      }
    }

    // Customer PO image is optional — only PO_SCAN_CLAUDE source supplies it.
    // Stored inline as base64 PNG so the SO detail page can render it as
    // proof-of-source when a customer disputes a delivery.
    const customerPOImageB64 =
      typeof body.customerPOImageB64 === "string" && body.customerPOImageB64
        ? body.customerPOImageB64
        : null;

    const statements = [
      c.var.DB.prepare(
        `INSERT INTO sales_orders (id, customerPO, customerPOId, customerPODate,
           customerSO, customerSOId, reference, customerId, customerName,
           customerState, hubId, hubName, companySO, companySOId, companySODate,
           customerDeliveryDate, hookkaExpectedDD, hookkaDeliveryOrder,
           subtotalSen, totalSen, status, overdue, notes,
           customerPOImageB64, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        resolvedHookkaExpectedDD,
        body.hookkaDeliveryOrder ?? "",
        subtotalSen,
        subtotalSen,
        "DRAFT",
        "PENDING",
        body.notes ?? "",
        customerPOImageB64,
        now,
        now,
      ),
      ...items.map((item) =>
        c.var.DB.prepare(
          `INSERT INTO sales_order_items (id, salesOrderId, lineNo, lineSuffix,
             productId, productCode, productName, itemCategory, sizeCode, sizeLabel,
             fabricCode, quantity, gapInches, divanHeightInches,
             divanPriceSen, legHeightInches, legPriceSen, specialOrder,
             specialOrderPriceSen, customSpecials, basePriceSen, unitPriceSen, lineTotalSen, notes)
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
          item.fabricCode,
          item.quantity,
          item.gapInches,
          item.divanHeightInches,
          item.divanPriceSen,
          item.legHeightInches,
          item.legPriceSen,
          item.specialOrder,
          item.specialOrderPriceSen,
          serializeCustomSpecials(item.customSpecials),
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

  // DRAFT / PENDING orders are confirmable. CONFIRMED or IN_PRODUCTION
  // orders are also allowed through IF every existing PO is CANCELLED —
  // this covers two flows:
  //   1. Backfill: SO was confirmed before the PO cascade existed and is
  //      sitting at CONFIRMED with zero POs.
  //   2. Re-cascade: operator cancelled all POs (e.g. because the SO needs
  //      extra line items) and wants the cascade to fan fresh POs out
  //      against the current item set without resetting the SO to DRAFT.
  // The PO creation helper is idempotent and now skips CANCELLED rows in
  // its existence check, so re-running confirm in either case is safe.
  const allowedStatuses = ["DRAFT", "PENDING"];
  const fallThroughStatuses = ["CONFIRMED", "IN_PRODUCTION"];
  if (!allowedStatuses.includes(existing.status)) {
    if (fallThroughStatuses.includes(existing.status)) {
      const existingPos = await c.var.DB.prepare(
        `SELECT id FROM production_orders
           WHERE salesOrderId = ? AND status <> 'CANCELLED' LIMIT 1`,
      )
        .bind(id)
        .first<{ id: string }>();
      if (existingPos) {
        return c.json(
          {
            success: false,
            error: `Order ${existing.companySOId ?? id} is already ${existing.status} with active production orders. Cancel them first to re-cascade.`,
          },
          400,
        );
      }
      // Fall through: CONFIRMED/IN_PRODUCTION + zero active POs → run cascade.
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

  // Google Sheets sync — fire-and-forget. Push every freshly-created JC to
  // its dept tab so the operator workspace mirrors the new POs the moment
  // confirm completes. Wrapped in waitUntil so the Sheets round-trip never
  // blocks the response. Helper silently no-ops when GOOGLE_SHEETS_SA_KEY
  // is missing — see docs/SHEETS-SYNC.md.
  if (!preExisting && productionOrders.length > 0) {
    const ctx = (c as unknown as {
      executionCtx?: { waitUntil(p: Promise<unknown>): void };
    }).executionCtx;
    const pushPromise = pushNewlyCreatedJobCardsToSheet(
      c.env as unknown as {
        GOOGLE_SHEETS_SA_KEY?: string;
        SHEETS_SPREADSHEET_ID?: string;
      },
      c.var.DB,
      productionOrders.map((p) => p.id),
    ).catch((err) => {
      console.error(
        "[sales-orders/confirm] sheets-sync push failed",
        err instanceof Error ? err.message : err,
      );
    });
    if (ctx?.waitUntil) {
      ctx.waitUntil(pushPromise);
    }
    // If executionCtx isn't available (unit tests / wrangler dev edge cases)
    // the promise still runs; we just don't await it.
  }

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
// Sheets-sync helper — load every JC for the freshly-created POs and push
// them to the matching dept tab. Lives in this file (instead of the lib)
// because it joins production_orders + sales_orders + job_cards in one
// shot, which is specific to the SO-confirm fanout path.
// ---------------------------------------------------------------------------
async function pushNewlyCreatedJobCardsToSheet(
  env: {
    GOOGLE_SHEETS_SA_KEY?: string;
    SHEETS_SPREADSHEET_ID?: string;
  },
  db: D1Database,
  poIds: string[],
): Promise<void> {
  if (poIds.length === 0) return;
  const placeholders = poIds.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT jc.id          AS id,
              jc.departmentCode AS departmentCode,
              jc.status      AS status,
              jc.dueDate     AS dueDate,
              jc.completedDate AS completedDate,
              jc.pic1Name    AS pic1Name,
              jc.pic2Name    AS pic2Name,
              jc.wipLabel    AS wipLabel,
              jc.category    AS category,
              jc.wipQty      AS wipQty,
              po.poNo        AS poNo,
              po.customerName AS customerName,
              po.productCode AS productCode,
              so.customerPOId AS customerPOId,
              so.reference   AS "soReference"
         FROM job_cards jc
         JOIN production_orders po ON po.id = jc.productionOrderId
    LEFT JOIN sales_orders so ON so.id = po.salesOrderId
        WHERE po.id IN (${placeholders})`,
    )
    .bind(...poIds)
    .all<{
      id: string;
      departmentCode: string | null;
      status: string | null;
      dueDate: string | null;
      completedDate: string | null;
      pic1Name: string | null;
      pic2Name: string | null;
      wipLabel: string | null;
      category: string | null;
      wipQty: number | null;
      poNo: string | null;
      customerName: string | null;
      productCode: string | null;
      customerPOId: string | null;
      soReference: string | null;
    }>();

  const { syncJobCardToSheet } = await import("../lib/sheets-sync");
  for (const r of rows.results ?? []) {
    await syncJobCardToSheet(
      env,
      {
        id: r.id,
        departmentCode: r.departmentCode,
        status: r.status,
        dueDate: r.dueDate,
        completedDate: r.completedDate,
        pic1Name: r.pic1Name,
        pic2Name: r.pic2Name,
        wipLabel: r.wipLabel,
        category: r.category,
        wipQty: r.wipQty,
      },
      {
        poNo: r.poNo,
        customerName: r.customerName,
        productCode: r.productCode,
      },
      {
        customerPOId: r.customerPOId,
        reference: r.soReference,
      },
    );
  }
}

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
  const denied = await requirePermission(c, "sales-orders", "update");
  if (denied) return denied;
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
    // /:id/edit-eligibility GET endpoint logic).
    //
    // Option D unified rule (2026-05-06): structural edits are allowed
    // while every JC under the SO is still WAITING (or CANCELLED). The
    // moment any JC has been stamped IN_PROGRESS / COMPLETED / TRANSFERRED
    // we hard-lock the SO — a teardown+rebuild from sales_order_items
    // would orphan that work. Subsumes the old dept_completed rule.
    //
    // Status-only edits skip the gate (an admin closing/cancelling
    // shouldn't be blocked).
    // ---------------------------------------------------------------------
    if (
      !isStatusOnly &&
      (existing.status === "IN_PRODUCTION" ||
        existing.status === "CONFIRMED")
    ) {
      const productionStartedRes = await c.var.DB
        .prepare(
          `SELECT jc.status, jc.departmentName, jc.departmentCode, jc.completedDate
             FROM job_cards jc
             JOIN production_orders po ON po.id = jc.productionOrderId
            WHERE po.salesOrderId = ?
              AND jc.status NOT IN ('WAITING', 'CANCELLED')
            ORDER BY jc.sequence ASC, jc.id ASC
            LIMIT 1`,
        )
        .bind(id)
        .first<{
          status: string | null;
          departmentName: string | null;
          departmentCode: string | null;
          completedDate: string | null;
        }>();

      if (productionStartedRes && productionStartedRes.status) {
        const dept =
          productionStartedRes.departmentName ||
          productionStartedRes.departmentCode ||
          "A department";
        return c.json(
          {
            success: false,
            error: `Cannot edit — ${dept} has started production (job card status: ${productionStartedRes.status}). Editing items would orphan in-flight work.`,
            reason: "production_started",
            startedDept: dept,
            startedDeptCode: productionStartedRes.departmentCode || "",
            jcStatus: productionStartedRes.status,
            completedAt: productionStartedRes.completedDate || null,
          },
          403,
        );
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

      // Fabric integrity gate — see the POST handler for the rationale.
      // Reject before any items are deleted/inserted so a bad payload
      // can't half-write a new row set.
      {
        const fabCheck = await validateFabricCodes(
          c.var.DB,
          rawItems.map((it) => (it.fabricCode as string | null | undefined)),
        );
        if (!fabCheck.valid) {
          return c.json(unknownFabricCodeError(fabCheck.unknown), 400);
        }
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
      // OCR back-door closure (BUG-001 fix): catalog wins on every PUT just
      // like POST. Loaded once here, reused for every line via snapItemToCatalog.
      const productByCodeForPut = await loadProductCatalog(c.var.DB);
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

        // 2026-05-09: fabricId resolve removed (matches POST path). Persist
        // null — column being dropped in a follow-up migration.
        const incomingFabricCode = String(item.fabricCode ?? "");

        // OCR back-door closure (BUG-001 fix, 2026-05-09): catalog wins on
        // every PUT just like POST (cd6a417). When productCode resolves to a
        // catalog product, that product is the source of truth for productId,
        // productName, itemCategory, and (BF/ACC) sizeLabel/sizeCode. Prevents
        // PDF text from sneaking back in via the Edit page when an OCR'd SO
        // gets re-saved.
        const snapped = snapItemToCatalog(
          {
            productCode: item.productCode,
            productId: item.productId,
            productName: item.productName,
            itemCategory: item.itemCategory,
            sizeCode: item.sizeCode,
            sizeLabel: item.sizeLabel,
          },
          productByCodeForPut,
        );
        const itemCategory = snapped.itemCategory;
        const isSofaItem = itemCategory === "SOFA";
        let normalizedSizeLabel = snapped.sizeLabel;
        if (
          isSofaItem &&
          normalizedSizeLabel &&
          /^\d+(\.\d+)?$/.test(normalizedSizeLabel.trim())
        ) {
          normalizedSizeLabel = `${normalizedSizeLabel.trim()}"`;
        }
        let normalizedSizeCode = snapped.sizeCode;
        if (isSofaItem && !normalizedSizeCode && normalizedSizeLabel) {
          normalizedSizeCode = normalizedSizeLabel.replace(/"/g, "").trim();
        }

        // Free-text custom specials per line (migration 0074). Same
        // sanitization as the POST path — empty descriptions dropped, the
        // surcharge sum is already folded into specialOrderPriceSen
        // client-side.
        const cleanedCustomSpecials = sanitizeCustomSpecials(item.customSpecials);

        return {
          id: (item.id as string) || genItemId(),
          lineNo,
          lineSuffix,
          productId: snapped.productId,
          productCode: snapped.productCode,
          productName: snapped.productName,
          itemCategory,
          sizeCode: normalizedSizeCode,
          sizeLabel: normalizedSizeLabel,
          fabricCode: incomingFabricCode,
          quantity,
          gapInches: item.gapInches ?? null,
          divanHeightInches: item.divanHeightInches ?? null,
          divanPriceSen,
          legHeightInches: item.legHeightInches ?? null,
          legPriceSen,
          specialOrder: (item.specialOrder as string) || "",
          specialOrderPriceSen,
          customSpecials: cleanedCustomSpecials,
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
               fabricCode, quantity, gapInches, divanHeightInches,
               divanPriceSen, legHeightInches, legPriceSen, specialOrder,
               specialOrderPriceSen, customSpecials, basePriceSen, unitPriceSen, lineTotalSen, notes)
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
            item.fabricCode,
            item.quantity,
            item.gapInches,
            item.divanHeightInches,
            item.divanPriceSen,
            item.legHeightInches,
            item.legPriceSen,
            item.specialOrder,
            item.specialOrderPriceSen,
            serializeCustomSpecials(item.customSpecials),
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
           subtotalSen = ?, totalSen = ?, status = ?, overdue = ?,
           notes = ?,
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
            fabricCode: (item.fabricCode as string) || "",
            quantity: Number(item.quantity) || 0,
            gapInches: (item.gapInches as number | null) ?? null,
            divanHeightInches: (item.divanHeightInches as number | null) ?? null,
            divanPriceSen: Number(item.divanPriceSen) || 0,
            legHeightInches: (item.legHeightInches as number | null) ?? null,
            legPriceSen: Number(item.legPriceSen) || 0,
            specialOrder: (item.specialOrder as string) || "",
            specialOrderPriceSen: Number(item.specialOrderPriceSen) || 0,
            customSpecials: serializeCustomSpecials(
              sanitizeCustomSpecials(item.customSpecials),
            ),
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
            fabricCode: (item.fabricCode as string) || "",
            quantity: Number(item.quantity) || 0,
            gapInches: (item.gapInches as number | null) ?? null,
            divanHeightInches: (item.divanHeightInches as number | null) ?? null,
            divanPriceSen: Number(item.divanPriceSen) || 0,
            legHeightInches: (item.legHeightInches as number | null) ?? null,
            legPriceSen: Number(item.legPriceSen) || 0,
            specialOrder: (item.specialOrder as string) || "",
            specialOrderPriceSen: Number(item.specialOrderPriceSen) || 0,
            customSpecials: serializeCustomSpecials(
              sanitizeCustomSpecials(item.customSpecials),
            ),
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

    // ---------------------------------------------------------------------
    // Option D — pre-production rebuild (2026-05-06).
    //
    // When the SO is CONFIRMED or IN_PRODUCTION (NOT DRAFT) and the operator
    // edited items, treat sales_order_items as the single source of truth:
    // teardown every existing production_orders + job_cards row for this SO
    // and re-fan-out from the freshly-written items. The Rule 2 gate above
    // already proved no JC has moved past WAITING, so this is safe.
    //
    // Skipped when:
    //   * isStatusOnly — no items changed, nothing to rebuild.
    //   * isDraftToConfirmed — the confirm cascade above already created POs
    //     from the new items via createProductionOrdersForSO; rebuilding now
    //     would double-fire (existing-PO short-circuit returns the just-made
    //     ones, but we'd also re-DELETE+rebuild needlessly).
    //   * existing.status === "DRAFT" and not transitioning — DRAFT has no
    //     POs yet by definition.
    //
    // Order matters in the DELETE: fg_units → job_cards → production_orders.
    // fg_units.po_id is a NOT-NULL FK without CASCADE; its presence on a
    // PENDING / fan-out-stub row would FK-block the PO delete. Pre-WAITING
    // SOs only have PENDING fg_units stubs (the Rule 2 gate forbids any PO
    // with non-PENDING fg_units), so removing them is lossless. job_cards
    // CASCADE on productionOrderId, but we DELETE explicitly to be defensive
    // against schema drift. piece_pics CASCADE on jobCardId.
    // ---------------------------------------------------------------------
    const itemsChanged = !!body.items;
    const shouldRebuild =
      itemsChanged &&
      !isStatusOnly &&
      !isDraftToConfirmed &&
      existing.status !== "DRAFT" &&
      existing.status !== "PENDING" &&
      // Skip rebuild on terminal/cancelled transitions — cascade already
      // handled the JC/PO state for those.
      newStatus !== "CANCELLED" &&
      newStatus !== "ON_HOLD";

    if (shouldRebuild) {
      // Re-fetch the freshly-written SO + items so the rebuild uses the
      // PUT's mutated state (not the pre-batch `existing` snapshot).
      const freshSO = await c.var.DB
        .prepare("SELECT * FROM sales_orders WHERE id = ?")
        .bind(id)
        .first<SalesOrderRow>();
      const freshItemsRes = await c.var.DB
        .prepare("SELECT * FROM sales_order_items WHERE salesOrderId = ?")
        .bind(id)
        .all<SalesOrderItemRow>();
      const freshItems = freshItemsRes.results ?? [];

      if (freshSO && freshItems.length > 0) {
        // Build the rebuild statements FIRST (read-only), then run DELETE
        // + INSERTs in one batch. forceRebuild=true so the builder doesn't
        // bail on the about-to-be-deleted POs (deterministic poId
        // pord-{soId}-NN collides with the existing rows, but the DELETE
        // in the same batch frees them first).
        const built = await createProductionOrdersForOrder(
          c.var.DB,
          {
            id: freshSO.id,
            sourceType: "SO",
            companyOrderId: freshSO.companySOId ?? "",
            companyOrderDate: freshSO.companySODate,
            customerPOId: freshSO.customerPOId,
            reference: freshSO.reference,
            customerName: freshSO.customerName,
            customerState: freshSO.customerState,
            hookkaExpectedDD: freshSO.hookkaExpectedDD,
            customerDeliveryDate: freshSO.customerDeliveryDate,
          },
          freshItems.map((it) => ({
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
          { forceRebuild: true },
        );

        const deleteFgUnitsStmt = c.var.DB
          .prepare(
            `DELETE FROM fg_units WHERE po_id IN (
               SELECT id FROM production_orders WHERE salesOrderId = ?)`,
          )
          .bind(id);
        const deleteJcsStmt = c.var.DB
          .prepare(
            `DELETE FROM job_cards WHERE productionOrderId IN (
               SELECT id FROM production_orders WHERE salesOrderId = ?)`,
          )
          .bind(id);
        const deletePosStmt = c.var.DB
          .prepare("DELETE FROM production_orders WHERE salesOrderId = ?")
          .bind(id);

        await c.var.DB.batch([
          deleteFgUnitsStmt,
          deleteJcsStmt,
          deletePosStmt,
          ...built.statements,
        ]);
        createdProductionOrders = built.created;
      }
    }

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
  const denied = await requirePermission(c, "sales-orders", "delete");
  if (denied) return denied;
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
