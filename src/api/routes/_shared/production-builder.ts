// ---------------------------------------------------------------------------
// Shared production-order builder. Source-agnostic — accepts either a Sales
// Order (sourceType: 'SO') or a Consignment Order (sourceType: 'CO') and
// drives the same downstream pipeline:
//
//   1. Idempotency guard — return existing POs if the order already
//      cascaded.
//   2. BOM lookup → WIP breakdown via breakBomIntoWips().
//   3. Reverse-schedule per-dept dueDates from the delivery anchor.
//   4. INSERT one production_orders row per piece (BF/ACC) or per SO line
//      (SOFA stays as one PO with the full set quantity).
//   5. INSERT one job_cards row per (WIP × dept) plus FG-level cards for
//      any l1Processes the BOM declares.
//
// production_orders carries TWO nullable source FK columns: salesOrderId
// and consignmentOrderId. The migration enforces exactly-one via app code
// (this function); SQLite ALTER cannot add a CHECK after table creation,
// so we do not rely on a DB constraint.
//
// History: extracted from src/api/routes/sales-orders.ts
// (createProductionOrdersForSO, ~425 lines) when the consignment-order
// flow landed. The SO-specific wrapper in sales-orders.ts now adapts
// SalesOrderRow → OrderForProduction and calls this; consignment.ts has
// a parallel wrapper for ConsignmentOrderRow.
// ---------------------------------------------------------------------------

import {
  ensureLeadTimesSeeded,
  loadLeadTimes,
  leadDaysFor,
  addDays,
  DEPT_ORDER,
  ensureHookkaDDBufferSeeded,
  loadHookkaDDBuffer,
  hookkaDDBufferFor,
} from "../../lib/lead-times";
import {
  breakBomIntoWips,
  type BomVariantContext,
} from "../../lib/bom-wip-breakdown";

// ---------------------------------------------------------------------------
// L1 (FG-level) processes — BOM column shape:
//   JSON [{ dept, deptCode, category, minutes }]
// e.g. sofa Packing — Base/Cushion/Arm have already been assembled into a
// single sofa by Upholstery, so Packing is one job per finished unit.
// ---------------------------------------------------------------------------
export type L1Process = {
  deptCode: string;
  category: string;
  minutes: number;
};

export function parseL1Processes(raw: string | null): L1Process[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .map((p) => ({
        deptCode: String((p as { deptCode?: unknown }).deptCode ?? ""),
        category: String((p as { category?: unknown }).category ?? ""),
        minutes: Number((p as { minutes?: unknown }).minutes) || 0,
      }))
      .filter((p) => p.deptCode.length > 0);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Option C: FAB_CUT consolidation (added 2026-05-01).
//
// Real-world cutting reality: a cutter lays one bolt of fabric down and cuts
// every component for a given (SOID + baseModel + fabric) combination in a
// single pass. Previously each piece (HB, DV, sofa-base, sofa-cushion, ...)
// got its own FAB_CUT JC; from the cutter's perspective those rows duplicated
// a single physical operation.
//
// Aggregator strategy: BOM resolution stays untouched — every per-piece
// breakdown is computed as today. THEN, after the per-PO loop completes, we
// collect the would-be FAB_CUT job_cards and merge them by
// (companySOId, baseModel, fabricCode). One merged JC is INSERTed per group.
// Other depts (FAB_SEW, UPH, ...) stay per-piece since each piece is
// physically a different operation downstream.
//
// The merged JC carries:
//   - wipLabel  = `[modelLabel, (size), (totalH), (DV h), fabric, (FC)]`
//                 with modelLabel = uniqueProductCodes.join("+") and shared
//                 prefix stripping (mirrors the pre-77ba23c frontend merge).
//   - wipKey    = `{companySOId}::{baseModel}::{fabric}::FAB_CUT` (stable,
//                 globally unique, used by downstream consume lookup).
//   - poId      = anchor (first source PO in the group).
//   - prodTime  = sum of source slots' minutes.
//   - dueDate   = earliest dueDate across siblings (cutter's deadline).
//   - wipQty    = anchor slot's wipQty (sofa: line qty; BF: 1 piece per
//                 source slot — set count).
// ---------------------------------------------------------------------------
type FcSlotInfo = {
  poId: string;
  productCode: string;
  baseModel: string;
  fabricCode: string;
  sizeLabel: string;
  isBF: boolean;
  // itemCategory — drives the aggregator group key (SOFA cross-PO merge,
  // BF/ACC per-PO). Distinct from `processCategory` which is what the JC
  // table's category column actually stores (BOM-process classification).
  itemCategory: string;
  processCategory: string;
  totalH: number;
  divanHeightInches: number | null;
  // JC fields (would have been used for the per-piece INSERT)
  deptId: string;
  deptCode: string;
  deptName: string;
  sequence: number;
  dueDate: string;
  minutes: number;
  wipQty: number;
  wipKey: string;
  wipCode: string;
  wipLabel: string;
  wipType: string;
  branchKey: string;
};

type FcMergedJc = {
  jcId: string;
  poId: string;
  deptId: string;
  deptCode: string;
  deptName: string;
  sequence: number;
  dueDate: string;
  wipKey: string;
  wipCode: string;
  wipLabel: string;
  wipType: string;
  wipQty: number;
  category: string;
  minutes: number;
  branchKey: string;
};

// Build the human-readable wipLabel for a FAB_CUT JC. Mirrors the formula in
// `src/pages/inventory/index.tsx:483-494` (kept in lockstep so Inventory and
// the Production sheet always show the identical string).
function buildFcWipLabel(
  modelLabel: string,
  sizeLabel: string,
  totalH: number,
  divanHeightInches: number | null,
  fabricCode: string,
  isBF: boolean,
): string {
  return [
    modelLabel,
    sizeLabel ? `(${sizeLabel})` : "",
    isBF && totalH > 0 ? `(${totalH}")` : "",
    isBF && divanHeightInches ? `(DV ${divanHeightInches}")` : "",
    fabricCode || "",
    "(FC)",
  ]
    .filter(Boolean)
    .join(" | ");
}

// Join multiple productCodes into a single composite label with shared-prefix
// stripping. Mirrors the pre-77ba23c frontend merge code:
//   ["5535-2A(LHF)", "5535-L(RHF)"]  →  "5535-2A(LHF)+L(RHF)"
//   ["5531"]                         →  "5531"
//   ["5531", "5535"]                 →  "5531+5535"  (no shared prefix)
function joinModelLabel(productCodes: string[]): string {
  const unique = [...new Set(productCodes.filter(Boolean))];
  if (unique.length === 0) return "";
  if (unique.length === 1) return unique[0];
  const firstDash = unique[0].indexOf("-");
  if (firstDash > 0) {
    const prefix = unique[0].slice(0, firstDash + 1);
    if (unique.every((m) => m.startsWith(prefix))) {
      return prefix + unique.map((m) => m.slice(prefix.length)).join("+");
    }
  }
  return unique.join("+");
}

// Aggregator — category-aware grouping per the pre-77ba23c frontend rule:
//   SOFA  → (companySOId, baseModel, fabricCode)  cross-PO merge within SO
//   BF/ACC → (poId)                               per-PO, never cross-line
// Each BF set already lives on its own line-suffixed po_no so two sets of
// the same model+fabric in the same parent SO MUST stay separate. Sofa
// configurations span multiple lines that cutter physically cuts together,
// so they collapse across POs into one merged JC.
function aggregateFcSlots(
  slots: FcSlotInfo[],
  companySOId: string,
): FcMergedJc[] {
  const groups = new Map<string, FcSlotInfo[]>();
  for (const slot of slots) {
    const key =
      slot.itemCategory === "SOFA"
        ? `SOFA::${companySOId}::${slot.baseModel || slot.productCode}::${slot.fabricCode}`
        : `PO::${slot.poId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(slot);
  }
  const merged: FcMergedJc[] = [];
  for (const group of groups.values()) {
    const anchor = group[0];
    const totalMinutes = group.reduce((sum, s) => sum + s.minutes, 0);
    const earliestDue =
      group
        .map((s) => s.dueDate)
        .filter(Boolean)
        .sort()[0] ?? anchor.dueDate;
    const modelLabel = joinModelLabel(group.map((s) => s.productCode));
    const wipLabel = buildFcWipLabel(
      modelLabel,
      anchor.sizeLabel,
      anchor.totalH,
      anchor.divanHeightInches,
      anchor.fabricCode,
      anchor.isBF,
    );
    // Category-aware wipKey: SOFA merges across POs so the key must be
    // SO-scoped. BF/ACC merge stays inside one PO so embed poId to keep
    // multi-set SOs (e.g. 2 BF lines of same baseModel + fabric) cleanly
    // separated.
    const wipKey =
      anchor.itemCategory === "SOFA"
        ? `${companySOId}::${anchor.baseModel || modelLabel}::${anchor.fabricCode}::FAB_CUT`
        : `${anchor.poId}::${anchor.baseModel || modelLabel}::${anchor.fabricCode}::FAB_CUT`;
    const jcIdSeed =
      anchor.itemCategory === "SOFA"
        ? `jc-fc-so-${companySOId}-${anchor.baseModel || modelLabel}-${anchor.fabricCode}`
        : `jc-fc-po-${anchor.poId}`;
    merged.push({
      jcId: jcIdSeed.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128),
      poId: anchor.poId,
      deptId: anchor.deptId,
      deptCode: "FAB_CUT",
      deptName: anchor.deptName,
      sequence: 0,
      dueDate: earliestDue,
      wipKey,
      wipCode: anchor.wipCode,
      wipLabel,
      wipType: anchor.wipType,
      wipQty: anchor.wipQty,
      category: anchor.processCategory,
      minutes: totalMinutes,
      branchKey: "",
    });
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Generic source-order shape. Both SalesOrderRow and ConsignmentOrderRow
// can be adapted to this minimal interface — see the wrappers in
// sales-orders.ts and consignments.ts.
// ---------------------------------------------------------------------------
export interface OrderForProduction {
  id: string;
  sourceType: "SO" | "CO";
  /** companySOId for SO, companyCOId for CO. Used as poNo prefix. */
  companyOrderId: string;
  /** companySODate for SO, companyCODate for CO. Forward-schedule anchor. */
  companyOrderDate: string | null;
  /** Customer's PO number — SO only; null for CO. */
  customerPOId: string | null;
  reference: string | null;
  customerName: string;
  customerState: string | null;
  hookkaExpectedDD: string | null;
  customerDeliveryDate: string | null;
}

export interface OrderItemForProduction {
  lineNo: number;
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
  legHeightInches: number | null;
  specialOrder: string | null;
  notes: string | null;
}

export type CreatedProductionOrder = {
  id: string;
  poNo: string;
  productName: string;
  quantity: number;
  status: string;
};

export async function createProductionOrdersForOrder(
  db: D1Database,
  order: OrderForProduction,
  items: OrderItemForProduction[],
): Promise<{
  statements: D1PreparedStatement[];
  created: CreatedProductionOrder[];
  preExisting: boolean;
}> {
  await ensureLeadTimesSeeded(db);
  await ensureHookkaDDBufferSeeded(db);
  const leadTimes = await loadLeadTimes(db);
  const hookkaDDBuffer = await loadHookkaDDBuffer(db);

  // ---- Idempotency guard (PO-level) ----
  // If any LIVE PO already exists for this source order, return the existing
  // set. CANCELLED rows are excluded so a cancel + re-confirm cycle (after
  // an SO edit added new lines) can fan out fresh POs for the new items
  // instead of being silently no-op'd by the idempotency check.
  const fkColumn =
    order.sourceType === "SO" ? "salesOrderId" : "consignmentOrderId";
  const existing = await db
    .prepare(
      `SELECT id, poNo, productName, quantity, status FROM production_orders
         WHERE ${fkColumn} = ? AND status <> 'CANCELLED' ORDER BY lineNo`,
    )
    .bind(order.id)
    .all<{
      id: string;
      poNo: string;
      productName: string | null;
      quantity: number;
      status: string;
    }>();
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

  // ---- Department lookup ----
  const deptRes = await db
    .prepare("SELECT id, code, name FROM departments")
    .all<{ id: string; code: string; name: string }>();
  const deptByCode = new Map<string, { id: string; name: string }>();
  for (const d of deptRes.results ?? []) {
    deptByCode.set(d.code, { id: d.id, name: d.name });
  }

  const nowIso = new Date().toISOString();
  const today = nowIso.split("T")[0];
  const statements: D1PreparedStatement[] = [];
  const created: CreatedProductionOrder[] = [];
  const sortedItems = [...items].sort((a, b) => a.lineNo - b.lineNo);

  // FAB_CUT consolidation buffer (Option C, see top-of-file aggregator block).
  // Per-piece FC slots collected here during the items loop are merged after
  // the loop into one JC per (companySOId, baseModel, fabricCode). Other
  // depts insert per-piece JCs in the inner loop unchanged.
  const fcSlotsForSo: FcSlotInfo[] = [];

  const explicitHookkaDD = order.hookkaExpectedDD || "";
  const customerDD = order.customerDeliveryDate || "";
  const startDate = order.companyOrderDate || today;
  const companyOrderId = order.companyOrderId ?? "";

  // Source-typed INSERT values for production_orders. Only one source FK
  // is ever non-null; the company-side number lives in the matching column
  // (companySOId for SO, companyCOId for CO).
  const isSO = order.sourceType === "SO";
  const insertSalesOrderId = isSO ? order.id : null;
  const insertSalesOrderNo = isSO ? companyOrderId : null;
  const insertCompanySOId = isSO ? companyOrderId : null;
  const insertConsignmentOrderId = isSO ? null : order.id;
  const insertCompanyCOId = isSO ? null : companyOrderId;

  // Fan-out counter — each piece of a BF/ACC item becomes its own PO. Sofa
  // stays as one PO per source line (one set per order by convention).
  let poSequence = 0;
  for (const item of sortedItems) {
    const isSetItem = (item.itemCategory ?? "BEDFRAME") === "SOFA";
    const pieceCount = isSetItem ? 1 : Math.max(1, item.quantity || 1);
    const perPoQty = isSetItem ? item.quantity || 1 : 1;
    for (let pieceIdx = 0; pieceIdx < pieceCount; pieceIdx++) {
      poSequence++;
      const lineSuffix = `-${String(poSequence).padStart(2, "0")}`;
      // poNo follows the convention companyOrderId + lineSuffix. The "SO-"
      // / "CO-" prefix is part of companyOrderId and disambiguates the two
      // sources in the unified production_orders.poNo namespace.
      const poNo = companyOrderId
        ? `${companyOrderId}${lineSuffix}`
        : `${order.id}${lineSuffix}`;
      const poId = `pord-${order.id}-${String(poSequence).padStart(2, "0")}`;

      const category = item.itemCategory ?? "BEDFRAME";
      const productCode = item.productCode ?? "";

      // Reverse-schedule anchor.
      const bufferDays = hookkaDDBufferFor(hookkaDDBuffer, category);
      const packingAnchor = explicitHookkaDD
        ? explicitHookkaDD
        : customerDD
          ? addDays(customerDD, -bufferDays)
          : "";

      // ---- BOM → WIP breakdown ----
      type BomRow = {
        wipComponents: string | null;
        l1Processes: string | null;
        baseModel: string | null;
      };
      let bomRow = await db
        .prepare(
          `SELECT wipComponents, l1Processes, baseModel FROM bom_templates
             WHERE productCode = ? AND versionStatus = 'ACTIVE'
             ORDER BY effectiveFrom DESC LIMIT 1`,
        )
        .bind(productCode)
        .first<BomRow>();
      if (!bomRow) {
        bomRow = await db
          .prepare(
            `SELECT wipComponents, l1Processes, baseModel FROM bom_templates
               WHERE productCode = ? ORDER BY effectiveFrom DESC LIMIT 1`,
          )
          .bind(productCode)
          .first<BomRow>();
      }

      const variants: BomVariantContext = {
        productCode: item.productCode ?? "",
        // Parent model — see BUG-2026-04-27-004 for why {MODEL} ≠ {PRODUCT_CODE}.
        model: bomRow?.baseModel ?? (item.productCode ?? ""),
        sizeLabel: item.sizeLabel ?? "",
        sizeCode: item.sizeCode ?? "",
        fabricCode: item.fabricCode ?? "",
        divanHeightInches: item.divanHeightInches ?? null,
        legHeightInches: item.legHeightInches ?? null,
        gapInches: item.gapInches ?? null,
      };
      const wips = breakBomIntoWips(
        bomRow?.wipComponents ?? null,
        productCode,
        variants,
      );

      // ---- Reverse-schedule dept dueDates ----
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
        branchKey: string;
      };
      const planned: PlannedJc[] = [];

      for (const wip of wips) {
        const wipQty = Math.max(
          1,
          Math.floor(perPoQty * wip.quantityMultiplier),
        );
        const chain = wip.processes;

        if (packingAnchor) {
          // Each dept's dueDate = customerDeliveryDate minus that dept's own
          // lead time. Depts run in parallel — staggered by their own offset
          // from the delivery anchor, NOT cumulative.
          const anchor = explicitHookkaDD || customerDD || packingAnchor;
          for (let i = 0; i < chain.length; i++) {
            const p = chain[i];
            const deptMeta = deptByCode.get(p.deptCode);
            if (!deptMeta) continue;
            const leadDays = leadDaysFor(leadTimes, category, p.deptCode);
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
              dueDate: addDays(anchor, -leadDays),
              category: p.category,
              minutes: p.minutes,
              branchKey: p.branchKey ?? "",
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
              branchKey: p.branchKey ?? "",
            });
          }
        }
      }

      // Overall targetEndDate = packingAnchor or last planned dueDate.
      const poTargetEnd =
        packingAnchor ||
        planned.reduce<string>(
          (acc, p) => (p.dueDate > acc ? p.dueDate : acc),
          startDate,
        );

      // PO.currentDepartment = first-in-DEPT_ORDER dept across all WIP chains.
      let currentDept = "FAB_CUT";
      if (planned.length > 0) {
        let minIdx = 999;
        for (const p of planned) {
          const idx = DEPT_ORDER.indexOf(
            p.deptCode as (typeof DEPT_ORDER)[number],
          );
          if (idx >= 0 && idx < minIdx) {
            minIdx = idx;
            currentDept = p.deptCode;
          }
        }
      }

      // ---- INSERT production_orders ----
      // Two new columns vs the original SO-only INSERT: consignmentOrderId,
      // companyCOId. Either is non-null per the source-mutex invariant.
      statements.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO production_orders (id, poNo, salesOrderId, salesOrderNo,
               consignmentOrderId, companyCOId, lineNo, customerPOId, customerReference,
               customerName, customerState, companySOId, productId, productCode, productName,
               itemCategory, sizeCode, sizeLabel, fabricCode, quantity, gapInches,
               divanHeightInches, legHeightInches, specialOrder, notes, status,
               currentDepartment, progress, startDate, targetEndDate, completedDate,
               rackingNumber, stockedIn, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            poId,
            poNo,
            insertSalesOrderId,
            insertSalesOrderNo,
            insertConsignmentOrderId,
            insertCompanyCOId,
            poSequence,
            order.customerPOId ?? "",
            order.reference ?? "",
            order.customerName,
            order.customerState ?? "",
            insertCompanySOId,
            item.productId ?? "",
            productCode,
            item.productName ?? "",
            category,
            item.sizeCode ?? "",
            item.sizeLabel ?? "",
            item.fabricCode ?? "",
            perPoQty,
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

      // ---- job_cards — one per (WIP × dept), with FAB_CUT diverted to the
      // SO-wide aggregator (Option C, 2026-05-01).
      const totalH =
        (item.gapInches ?? 0) +
        (item.divanHeightInches ?? 0) +
        (item.legHeightInches ?? 0);
      const isBF = category === "BEDFRAME";
      for (const p of planned) {
        // FAB_CUT — collect for post-loop aggregation, do NOT insert per-piece.
        if (p.deptCode === "FAB_CUT") {
          fcSlotsForSo.push({
            poId,
            productCode,
            baseModel: bomRow?.baseModel ?? productCode,
            fabricCode: item.fabricCode ?? "",
            sizeLabel: item.sizeLabel ?? "",
            isBF,
            totalH,
            divanHeightInches: item.divanHeightInches ?? null,
            deptId: p.deptId,
            deptCode: p.deptCode,
            deptName: p.deptName,
            sequence: p.sequence,
            dueDate: p.dueDate,
            // SOFA / BEDFRAME / ACCESSORY drives the merge key; pass the
            // item's itemCategory rather than the BOM-process category
            // which is something else entirely (sub-assembly classification).
            itemCategory: category,
            processCategory: p.category,
            minutes: p.minutes,
            wipQty: p.wipQty,
            wipKey: p.wipKey,
            wipCode: p.wipCode,
            wipLabel: p.wipLabel,
            wipType: p.wipType,
            branchKey: p.branchKey ?? "",
          });
          continue;
        }

        const jcId = `jc-${poId}-${p.wipKey}-${p.deptCode}`
          .replace(/[^a-zA-Z0-9_-]/g, "_")
          .slice(0, 128);
        const isFirstDeptForWip = p.sequence === 0;
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
              p.branchKey ?? "",
            ),
        );
      }

      // ---- job_cards — FG-level (one per l1Process) ----
      const l1Procs = parseL1Processes(bomRow?.l1Processes ?? null);
      for (const l1p of l1Procs) {
        const deptMeta = deptByCode.get(l1p.deptCode);
        if (!deptMeta) continue;
        const jcId = `jc-${poId}-FG-${l1p.deptCode}`
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
              deptMeta.id,
              l1p.deptCode,
              deptMeta.name,
              99, // high sequence so nothing else treats this as "first in chain"
              "WAITING",
              packingAnchor || poTargetEnd,
              "FG",
              productCode,
              "FG",
              productCode,
              perPoQty,
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
              "",
            ),
        );
      }

      created.push({
        id: poId,
        poNo,
        productName: item.productName ?? "",
        quantity: perPoQty,
        status: "PENDING",
      });
    }
  }

  // ---- FAB_CUT post-merge (Option C) ----
  // Items loop has finished pushing per-piece JC INSERTs for non-FAB_CUT
  // depts and collected FAB_CUT slots into fcSlotsForSo. Now group by
  // (companySOId, baseModel, fabricCode) and emit one merged JC per group.
  // companySOId here is the SO-side companyOrderId (or CO equivalent) — the
  // shop-floor "SOID" that already disambiguates BF sets via the -01/-02
  // line-suffix convention, while sofa stays single-SOID per order.
  if (fcSlotsForSo.length > 0) {
    const mergedFc = aggregateFcSlots(fcSlotsForSo, companyOrderId || order.id);
    for (const m of mergedFc) {
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
            m.jcId,
            m.poId,
            m.deptId,
            m.deptCode,
            m.deptName,
            m.sequence,
            "WAITING",
            m.dueDate,
            m.wipKey,
            m.wipCode,
            m.wipType,
            m.wipLabel,
            m.wipQty,
            1, // FAB_CUT is always the first dept in its chain → prerequisiteMet=1
            null,
            "",
            null,
            "",
            null,
            m.minutes,
            null,
            m.category,
            m.minutes,
            "PENDING",
            null,
            m.branchKey,
          ),
      );
    }
  }

  return { statements, created, preExisting: false };
}
