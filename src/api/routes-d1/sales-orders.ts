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
import { calculateUnitPrice, calculateLineTotal } from "../../lib/pricing";
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

const app = new Hono<Env>();

type SalesOrderRow = {
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
  created_at: string | null;
  updated_at: string | null;
};

type SalesOrderItemRow = {
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
    createdAt: row.created_at ?? "",
    updatedAt: row.updated_at ?? "",
  };
}

function parseAutoActions(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
// Shared cascade: auto-create one production_orders row per SO item row on
// SO confirmation. Idempotent at the PO level — if ANY production_orders row
// already exists for the SO, return the existing set without duplicating.
//
// Additionally walks each product's BOM (bom_templates.wipComponents JSON) to
// break the FG into WIPs (DIVAN/HEADBOARD for BEDFRAME, SOFA_BASE + modules
// for SOFA) and generate one job_cards row per (WIP × dept) combination with
// a reverse-scheduled `dueDate` so the Production tracker UI can populate
// every dept column.
//
// Idempotency is tracked separately for job_cards: if any job_cards exist for
// a PO, that PO's job_card generation is skipped even if the PO row is brand
// new (should not happen in practice but guards against partial failures).
//
// Returned shape matches what the confirm/PUT handlers already expose on
// the JSON response as `productionOrders`.
// ---------------------------------------------------------------------------
type CreatedProductionOrder = {
  id: string;
  poNo: string;
  productName: string;
  quantity: number;
  status: string;
};

async function createProductionOrdersForSO(
  db: D1Database,
  so: SalesOrderRow,
  items: SalesOrderItemRow[],
): Promise<{ statements: D1PreparedStatement[]; created: CreatedProductionOrder[]; preExisting: boolean }> {
  // Ensure lead times are seeded. Safe to call every pass — short-circuits
  // after the first insert (COUNT(*) > 0).
  await ensureLeadTimesSeeded(db);
  await ensureHookkaDDBufferSeeded(db);
  const leadTimes = await loadLeadTimes(db);
  const hookkaDDBuffer = await loadHookkaDDBuffer(db);

  // Idempotency guard (PO-level) — if any PO exists for this SO, return the
  // existing set. Job-card backfill for those existing POs is handled by
  // `buildJobCardStatementsForPo` below when invoked for a PO that has zero
  // job_cards; here we return preExisting=true so the caller's status-change
  // log reflects "already exists".
  const existing = await db
    .prepare(
      "SELECT id, poNo, productName, quantity, status FROM production_orders WHERE salesOrderId = ? ORDER BY lineNo",
    )
    .bind(so.id)
    .all<{ id: string; poNo: string; productName: string | null; quantity: number; status: string }>();
  const existingRows = existing.results ?? [];
  if (existingRows.length > 0) {
    return {
      statements: [],
      created: existingRows.map((r) => ({
        id: r.id,
        poNo: r.poNo,
        productName: r.productName ?? "",
        quantity: r.quantity,
        status: r.status,
      })),
      preExisting: true,
    };
  }

  // Load department lookup once — job_cards stores both departmentId and
  // departmentCode; we need the FK for the departmentId column.
  const deptRes = await db
    .prepare("SELECT id, code, name FROM departments").all<{ id: string; code: string; name: string }>();
  const deptByCode = new Map<string, { id: string; name: string }>();
  for (const d of deptRes.results ?? []) {
    deptByCode.set(d.code, { id: d.id, name: d.name });
  }

  const nowIso = new Date().toISOString();
  const today = nowIso.split("T")[0];
  const statements: D1PreparedStatement[] = [];
  const created: CreatedProductionOrder[] = [];
  const sortedItems = [...items].sort((a, b) => a.lineNo - b.lineNo);
  // If the SO already has an explicit Hookka Expected DD, honour it (users may
  // have overridden the computed value). Otherwise derive packingAnchor from
  // customerDeliveryDate minus the per-category buffer — see
  // migrations/0007_hookka_dd_buffer.sql for the buffer definition.
  const explicitHookkaDD = so.hookkaExpectedDD || "";
  const customerDD = so.customerDeliveryDate || "";
  const startDate = so.companySODate || today;
  const companySoId = so.companySOId ?? "";

  for (const item of sortedItems) {
    const lineSuffix =
      item.lineSuffix ?? `-${String(item.lineNo).padStart(2, "0")}`;
    // poNo follows production-order-builder convention: companySOId + lineSuffix
    const poNo = companySoId
      ? `${companySoId}${lineSuffix}`
      : `${so.id}${lineSuffix}`;
    // Deterministic id — re-running a failed confirm regenerates the same id so
    // UNIQUE on production_orders.id still catches retries.
    const poId = `pord-${so.id}-${String(item.lineNo).padStart(2, "0")}`;

    const category = item.itemCategory ?? "BEDFRAME";
    const productCode = item.productCode ?? "";

    // Reverse-schedule anchor. If the user explicitly set hookkaExpectedDD on
    // the SO we use that as-is (they committed to a date). Otherwise we shift
    // customerDeliveryDate backwards by the category buffer, leaving the
    // buffer days free for dispatch/loading/shipping.
    const bufferDays = hookkaDDBufferFor(hookkaDDBuffer, category);
    const packingAnchor = explicitHookkaDD
      ? explicitHookkaDD
      : customerDD
      ? addDays(customerDD, -bufferDays)
      : "";

    // ------ BOM → WIP breakdown ------
    // Look up active BOM template for this productCode; if none, fall back
    // to the latest template regardless of status.
    let bomRow = await db
      .prepare(
        `SELECT wipComponents FROM bom_templates
           WHERE productCode = ? AND versionStatus = 'ACTIVE'
           ORDER BY effectiveFrom DESC LIMIT 1`,
      )
      .bind(productCode)
      .first<{ wipComponents: string | null }>();
    if (!bomRow) {
      bomRow = await db
        .prepare(
          `SELECT wipComponents FROM bom_templates
             WHERE productCode = ? ORDER BY effectiveFrom DESC LIMIT 1`,
        )
        .bind(productCode)
        .first<{ wipComponents: string | null }>();
    }

    const variants: BomVariantContext = {
      productCode: item.productCode ?? "",
      sizeLabel: item.sizeLabel ?? "",
      sizeCode: item.sizeCode ?? "",
      fabricCode: item.fabricCode ?? "",
      divanHeightInches: item.divanHeightInches ?? null,
      legHeightInches: item.legHeightInches ?? null,
      gapInches: item.gapInches ?? null,
    };
    const wips = breakBomIntoWips(bomRow?.wipComponents ?? null, productCode, variants);

    // ------ Reverse-schedule dept dueDates ------
    // Goal: build a per-dept `dueDate` string for every (wip, dept) entry.
    // If we have deliveryDate, walk BACKWARDS from it: PACKING = deliveryDate,
    // each earlier dept = prevDept.dueDate - prevDept.leadDays.
    // If we don't have deliveryDate, FORWARD-schedule from startDate.
    type PlannedJc = {
      wipType: string;
      wipCode: string;
      wipLabel: string;
      wipKey: string;
      wipQty: number;
      sequence: number;
      deptCode: string;
      deptId: string;
      deptName: string;
      dueDate: string;
      category: string;
      minutes: number;
    };
    const planned: PlannedJc[] = [];

    for (const wip of wips) {
      // Each wip has its own independent dept chain; reverse-schedule it end
      // at delivery (or forward-schedule from start).
      const wipQty = Math.max(1, Math.floor(item.quantity * wip.quantityMultiplier));

      // Compute per-dept dueDate for this wip's chain. We iterate in DEPT_ORDER
      // so the `sequence` matches the forward chain (0-based).
      const chain = wip.processes;

      if (packingAnchor) {
        // Reverse pass. Start with the LAST dept in chain = packingAnchor
        // (the internal target; customerDD − buffer, or explicit hookkaDD).
        // Each earlier dept = nextDept.dueDate - nextDept.leadDays.
        const dueByDept = new Map<string, string>();
        const lastIdx = chain.length - 1;
        if (lastIdx >= 0) {
          // Anchor: LAST dept in chain due on packingAnchor.
          dueByDept.set(chain[lastIdx].deptCode, packingAnchor);
          for (let i = lastIdx - 1; i >= 0; i--) {
            const nextDept = chain[i + 1];
            const prevDue = dueByDept.get(nextDept.deptCode)!;
            const nextLeadDays = leadDaysFor(leadTimes, category, nextDept.deptCode);
            // Current dept due = nextDept's dueDate minus nextDept's leadDays.
            dueByDept.set(chain[i].deptCode, addDays(prevDue, -nextLeadDays));
          }
        }
        for (let i = 0; i < chain.length; i++) {
          const p = chain[i];
          const deptMeta = deptByCode.get(p.deptCode);
          if (!deptMeta) continue;
          planned.push({
            wipType: wip.wipType,
            wipCode: p.wipCode || wip.wipCode,
            wipLabel: p.wipLabel || wip.wipLabel,
            wipKey: wip.wipKey,
            wipQty,
            sequence: i,
            deptCode: p.deptCode,
            deptId: deptMeta.id,
            deptName: deptMeta.name,
            dueDate: dueByDept.get(p.deptCode) || packingAnchor,
            category: p.category,
            minutes: p.minutes,
          });
        }
      } else {
        // Forward pass from startDate.
        let cursor = startDate;
        for (let i = 0; i < chain.length; i++) {
          const p = chain[i];
          const deptMeta = deptByCode.get(p.deptCode);
          const leadDays = leadDaysFor(leadTimes, category, p.deptCode);
          cursor = addDays(cursor, leadDays);
          if (!deptMeta) continue;
          planned.push({
            wipType: wip.wipType,
            wipCode: p.wipCode || wip.wipCode,
            wipLabel: p.wipLabel || wip.wipLabel,
            wipKey: wip.wipKey,
            wipQty,
            sequence: i,
            deptCode: p.deptCode,
            deptId: deptMeta.id,
            deptName: deptMeta.name,
            dueDate: cursor,
            category: p.category,
            minutes: p.minutes,
          });
        }
      }
    }

    // Overall targetEndDate = packingAnchor (internal production target) or
    // last planned dept dueDate. Customer-facing deliveryDate intentionally
    // NOT used here — targetEndDate tracks when production finishes, not when
    // the truck arrives at the customer.
    const poTargetEnd =
      packingAnchor ||
      planned.reduce<string>((acc, p) => (p.dueDate > acc ? p.dueDate : acc), startDate);

    // PO.currentDepartment = first-in-DEPT_ORDER dept across all WIP chains
    // (see task spec H3).
    let currentDept = "FAB_CUT";
    if (planned.length > 0) {
      let minIdx = 999;
      for (const p of planned) {
        const idx = DEPT_ORDER.indexOf(p.deptCode as (typeof DEPT_ORDER)[number]);
        if (idx >= 0 && idx < minIdx) {
          minIdx = idx;
          currentDept = p.deptCode;
        }
      }
    }

    statements.push(
      db
        .prepare(
          `INSERT INTO production_orders (id, poNo, salesOrderId, salesOrderNo, lineNo,
             customerPOId, customerReference, customerName, customerState, companySOId,
             productId, productCode, productName, itemCategory, sizeCode, sizeLabel,
             fabricCode, quantity, gapInches, divanHeightInches, legHeightInches,
             specialOrder, notes, status, currentDepartment, progress, startDate,
             targetEndDate, completedDate, rackingNumber, stockedIn, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          poId,
          poNo,
          so.id,
          companySoId,
          item.lineNo,
          so.customerPOId ?? "",
          so.reference ?? "",
          so.customerName,
          so.customerState ?? "",
          companySoId,
          item.productId ?? "",
          productCode,
          item.productName ?? "",
          category,
          item.sizeCode ?? "",
          item.sizeLabel ?? "",
          item.fabricCode ?? "",
          item.quantity,
          item.gapInches,
          item.divanHeightInches,
          item.legHeightInches,
          item.specialOrder ?? "",
          item.notes ?? "",
          "PENDING",
          currentDept,
          0,
          startDate,
          poTargetEnd,
          null,
          "",
          0,
          nowIso,
          nowIso,
        ),
    );

    // ------ job_cards — one per (WIP × dept) ------
    // The first dept of each WIP's chain gets prerequisiteMet=1 so workers
    // can pick it up immediately; subsequent depts get prerequisiteMet=0.
    for (const p of planned) {
      const jcId = `jc-${poId}-${p.wipCode}-${p.deptCode}`
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 128);
      const isFirstDeptForWip = p.sequence === 0;
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO job_cards (id, productionOrderId, departmentId, departmentCode,
               departmentName, sequence, status, dueDate, wipKey, wipCode, wipType, wipLabel,
               wipQty, prerequisiteMet, pic1Id, pic1Name, pic2Id, pic2Name, completedDate,
               estMinutes, actualMinutes, category, productionTimeMinutes, overdue, rackingNumber)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            p.wipKey,
            p.wipCode,
            p.wipType,
            p.wipLabel,
            p.wipQty,
            isFirstDeptForWip ? 1 : 0,
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
          ),
      );
    }

    created.push({
      id: poId,
      poNo,
      productName: item.productName ?? "",
      quantity: item.quantity,
      status: "PENDING",
    });
  }

  return { statements, created, preExisting: false };
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
      `SELECT wipComponents FROM bom_templates
         WHERE productCode = ? AND versionStatus = 'ACTIVE'
         ORDER BY effectiveFrom DESC LIMIT 1`,
    )
    .bind(productCode)
    .first<{ wipComponents: string | null }>();
  if (!bomRow) {
    bomRow = await db
      .prepare(
        `SELECT wipComponents FROM bom_templates
           WHERE productCode = ? ORDER BY effectiveFrom DESC LIMIT 1`,
      )
      .bind(productCode)
      .first<{ wipComponents: string | null }>();
  }
  const backfillVariants: BomVariantContext = {
    productCode: po.productCode ?? "",
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
    }> = [];

    if (packingAnchor) {
      const dueByDept = new Map<string, string>();
      const lastIdx = chain.length - 1;
      if (lastIdx >= 0) {
        dueByDept.set(chain[lastIdx].deptCode, packingAnchor);
        for (let i = lastIdx - 1; i >= 0; i--) {
          const nextDept = chain[i + 1];
          const prevDue = dueByDept.get(nextDept.deptCode)!;
          const nextLeadDays = leadDaysFor(leadTimes, category, nextDept.deptCode);
          dueByDept.set(chain[i].deptCode, addDays(prevDue, -nextLeadDays));
        }
      }
      for (let i = 0; i < chain.length; i++) {
        const p = chain[i];
        const deptMeta = deptByCode.get(p.deptCode);
        if (!deptMeta) continue;
        planned.push({
          deptCode: p.deptCode,
          deptId: deptMeta.id,
          deptName: deptMeta.name,
          sequence: i,
          dueDate: dueByDept.get(p.deptCode) || packingAnchor,
          category: p.category,
          minutes: p.minutes,
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
      const jcId = `jc-${poId}-${deptWipCode}-${p.deptCode}`
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 128);
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO job_cards (id, productionOrderId, departmentId, departmentCode,
               departmentName, sequence, status, dueDate, wipKey, wipCode, wipType, wipLabel,
               wipQty, prerequisiteMet, pic1Id, pic1Name, pic2Id, pic2Name, completedDate,
               estMinutes, actualMinutes, category, productionTimeMinutes, overdue, rackingNumber)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          ),
      );
      jcCount++;
    }
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

// Valid status transitions — mirrors the in-memory route
const VALID_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["IN_PRODUCTION", "ON_HOLD", "CANCELLED"],
  IN_PRODUCTION: ["READY_TO_SHIP", "ON_HOLD", "CANCELLED"],
  READY_TO_SHIP: ["SHIPPED", "ON_HOLD"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: ["INVOICED"],
  INVOICED: ["CLOSED"],
  ON_HOLD: ["CONFIRMED", "IN_PRODUCTION", "CANCELLED"],
  CLOSED: [],
  CANCELLED: [],
};

// ---------------------------------------------------------------------------
// GET /api/sales-orders — list all SOs with nested items
// ---------------------------------------------------------------------------
app.get("/", async (c) => {
  const [sos, items] = await Promise.all([
    c.env.DB.prepare(
      "SELECT * FROM sales_orders ORDER BY created_at DESC, id DESC",
    ).all<SalesOrderRow>(),
    c.env.DB.prepare("SELECT * FROM sales_order_items").all<SalesOrderItemRow>(),
  ]);
  const data = (sos.results ?? []).map((s) => rowToSO(s, items.results ?? []));
  return c.json({ success: true, data, total: data.length });
});

// ---------------------------------------------------------------------------
// GET /api/sales-orders/status-changes — full audit log
// (defined BEFORE /:id so the route matches first)
// ---------------------------------------------------------------------------
app.get("/status-changes", async (c) => {
  const res = await c.env.DB.prepare(
    "SELECT * FROM so_status_changes ORDER BY timestamp DESC",
  ).all<SOStatusChangeRow>();
  const data = (res.results ?? []).map(rowToStatusChange);
  return c.json({ success: true, data, total: data.length });
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
  const db = c.env.DB;
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
// POST /api/sales-orders — create a new SO + items atomically
// ---------------------------------------------------------------------------
app.post("/", async (c) => {
  try {
    const body = await c.req.json();

    // Validate customer
    const customer = await c.env.DB.prepare(
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
      chosenHub = await c.env.DB.prepare(
        "SELECT id, state, shortName FROM delivery_hubs WHERE id = ? AND customerId = ?",
      )
        .bind(hubIdField, customer.id)
        .first<{ id: string; state: string | null; shortName: string }>();
    }
    if (!chosenHub) {
      chosenHub = await c.env.DB.prepare(
        "SELECT id, state, shortName FROM delivery_hubs WHERE customerId = ? ORDER BY isDefault DESC LIMIT 1",
      )
        .bind(customer.id)
        .first<{ id: string; state: string | null; shortName: string }>();
    }

    const rawItems: Array<Record<string, unknown>> = Array.isArray(body.items)
      ? body.items
      : [];

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
          resolvedProduct = await c.env.DB.prepare(
            "SELECT id, name, category, sizeCode, sizeLabel, basePriceSen, seatHeightPrices FROM products WHERE code = ? LIMIT 1",
          )
            .bind(productCode)
            .first();
          if (!resolvedProduct) {
            resolvedProduct = await c.env.DB.prepare(
              "SELECT id, name, category, sizeCode, sizeLabel, basePriceSen, seatHeightPrices FROM products WHERE LOWER(code) = LOWER(?) LIMIT 1",
            )
              .bind(productCode)
              .first();
          }
        }

        let basePriceSen = Number(item.basePriceSen) || 0;
        if (basePriceSen === 0 && resolvedProduct) {
          const seatHeight = String(item.seatHeight ?? "");
          if (resolvedProduct.seatHeightPrices && seatHeight) {
            try {
              const shpList = JSON.parse(resolvedProduct.seatHeightPrices) as Array<{
                height: string;
                priceSen: number;
              }>;
              const shp = shpList.find(
                (p) => p.height === seatHeight || p.height === `${seatHeight}"`,
              );
              basePriceSen = shp?.priceSen || resolvedProduct.basePriceSen || 0;
            } catch {
              basePriceSen = resolvedProduct.basePriceSen || 0;
            }
          } else {
            basePriceSen = resolvedProduct.basePriceSen || 0;
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
    const companySOId = await generateCompanySOId(c.env.DB);
    const soId = genSoId();
    const today = now.split("T")[0];

    const customerState =
      chosenHub?.state ??
      (typeof body.customerState === "string" ? body.customerState : "") ??
      "";

    const statements = [
      c.env.DB.prepare(
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
        c.env.DB.prepare(
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

    await c.env.DB.batch(statements);

    const created = await fetchSOWithItems(c.env.DB, soId);
    if (!created) {
      return c.json(
        { success: false, error: "Failed to create sales order" },
        500,
      );
    }
    return c.json({ success: true, data: created }, 201);
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// POST /api/sales-orders/:id/confirm
//
// Flips DRAFT/PENDING -> CONFIRMED, writes so_status_changes, and cascades
// production_orders insertion — one PO row per SO item. All writes batched
// so a partial failure leaves no dangling state. Idempotent: re-submitting
// confirm returns the existing production orders without duplicating.
// ---------------------------------------------------------------------------
app.post("/:id/confirm", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare(
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
      const existingPos = await c.env.DB.prepare(
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
    const dup = await c.env.DB.prepare(
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
  const itemsRes = await c.env.DB.prepare(
    "SELECT * FROM sales_order_items WHERE salesOrderId = ?",
  )
    .bind(id)
    .all<SalesOrderItemRow>();
  const items = itemsRes.results ?? [];

  const { statements: poStmts, created: productionOrders, preExisting } =
    await createProductionOrdersForSO(c.env.DB, existing, items);

  const autoActions = preExisting
    ? ["Production orders already exist for this SO — skipped duplicate creation."]
    : productionOrders.map((po) => `Created PO ${po.poNo}`);

  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE sales_orders SET status = 'CONFIRMED', updated_at = ? WHERE id = ?",
    ).bind(now, id),
    c.env.DB.prepare(
      `INSERT INTO so_status_changes
         (id, soId, fromStatus, toStatus, changedBy, timestamp, notes, autoActions)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      genStatusId(),
      id,
      fromStatus,
      "CONFIRMED",
      (body.changedBy as string) || "Admin",
      now,
      (body.notes as string) || "Order confirmed",
      JSON.stringify(autoActions),
    ),
    ...poStmts,
  ]);

  const order = await fetchSOWithItems(c.env.DB, id);

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
});

// ---------------------------------------------------------------------------
// GET /api/sales-orders/:id — SO + items + statusHistory + priceOverrides
// ---------------------------------------------------------------------------
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [so, itemsRes, statusRes, overridesRes] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM sales_orders WHERE id = ?")
      .bind(id)
      .first<SalesOrderRow>(),
    c.env.DB.prepare("SELECT * FROM sales_order_items WHERE salesOrderId = ?")
      .bind(id)
      .all<SalesOrderItemRow>(),
    c.env.DB.prepare(
      "SELECT * FROM so_status_changes WHERE soId = ? ORDER BY timestamp DESC",
    )
      .bind(id)
      .all<SOStatusChangeRow>(),
    c.env.DB.prepare("SELECT * FROM price_overrides WHERE soId = ?")
      .bind(id)
      .all<PriceOverrideRow>(),
  ]);
  if (!so) {
    return c.json({ success: false, error: "Order not found" }, 404);
  }
  return c.json({
    success: true,
    data: rowToSO(so, itemsRes.results ?? []),
    linkedPOs: [], // Production orders — Phase 4
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
    const existing = await c.env.DB.prepare(
      "SELECT * FROM sales_orders WHERE id = ?",
    )
      .bind(id)
      .first<SalesOrderRow>();
    if (!existing) {
      return c.json({ success: false, error: "Order not found" }, 404);
    }
    const body = await c.req.json();
    const now = new Date().toISOString();

    const statements: D1PreparedStatement[] = [];
    let newStatus: string = existing.status;
    let pendingStatusChangeId: string | null = null;
    let isDraftToConfirmed = false;

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
      isDraftToConfirmed =
        (existing.status === "DRAFT" || existing.status === "PENDING") &&
        newStatus === "CONFIRMED";

      // Defer the status-change INSERT until after the PO cascade runs so we
      // can stamp autoActions with the created PO numbers.
      pendingStatusChangeId = genStatusId();
      if (!isDraftToConfirmed) {
        statements.push(
          c.env.DB.prepare(
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
            JSON.stringify([]),
          ),
        );
      }
    }

    // --- Customer / hub resolution ---
    let customerId = existing.customerId;
    let customerName = existing.customerName;
    let customerState = existing.customerState ?? "";
    let hubId = existing.hubId;
    let hubName = existing.hubName ?? "";

    if (body.customerId) {
      const customer = await c.env.DB.prepare(
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
        const hub = await c.env.DB.prepare(
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
      const oldItemsRes = await c.env.DB.prepare(
        "SELECT * FROM sales_order_items WHERE salesOrderId = ?",
      )
        .bind(id)
        .all<SalesOrderItemRow>();
      const oldItems = oldItemsRes.results ?? [];

      const rawItems: Array<Record<string, unknown>> = body.items;
      const newItems = rawItems.map((item, idx) => {
        const basePriceSen = Number(item.basePriceSen) || 0;
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
      });

      subtotalSen = newItems.reduce((sum, i) => sum + i.lineTotalSen, 0);
      totalSen = subtotalSen;

      // Delete old, insert new
      statements.push(
        c.env.DB.prepare(
          "DELETE FROM sales_order_items WHERE salesOrderId = ?",
        ).bind(id),
      );
      for (const item of newItems) {
        statements.push(
          c.env.DB.prepare(
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
            c.env.DB.prepare(
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
      c.env.DB.prepare(
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
        const itemsRes = await c.env.DB.prepare(
          "SELECT * FROM sales_order_items WHERE salesOrderId = ?",
        )
          .bind(id)
          .all<SalesOrderItemRow>();
        effectiveItems = itemsRes.results ?? [];
      }

      const { statements: poStmts, created, preExisting } =
        await createProductionOrdersForSO(
          c.env.DB,
          effectiveSO,
          effectiveItems,
        );
      createdProductionOrders = created;

      const autoActions = preExisting
        ? ["Production orders already exist for this SO — skipped duplicate creation."]
        : created.map((po) => `Created PO ${po.poNo}`);

      statements.push(
        c.env.DB.prepare(
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

    await c.env.DB.batch(statements);

    const updated = await fetchSOWithItems(c.env.DB, id);
    return c.json({
      success: true,
      data: updated,
      linkedPOs: createdProductionOrders,
      productionOrders: createdProductionOrders,
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/sales-orders/:id — cascades to items via FK
// ---------------------------------------------------------------------------
app.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = await c.env.DB.prepare(
    "SELECT id FROM sales_orders WHERE id = ?",
  )
    .bind(id)
    .first<{ id: string }>();
  if (!existing) {
    return c.json({ success: false, error: "Order not found" }, 404);
  }
  await c.env.DB.prepare("DELETE FROM sales_orders WHERE id = ?").bind(id).run();
  return c.json({ success: true });
});

export default app;
