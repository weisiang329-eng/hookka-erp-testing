// ---------------------------------------------------------------------------
// Shared Production Order + JobCard builder — single source of truth.
//
// Used by:
//   1. POST /api/sales-orders/[id]/confirm  (runtime SO confirmation)
//   2. mock-data.ts seedConfirmBFOrders()    (boot-time mock seeding)
//
// The confirm route previously had its own `createJobCardsFromBOM`; the seed
// IIFE duplicated ~90% of that logic. Both now call into this module.
// ---------------------------------------------------------------------------

import {
  bomTemplates,
  departments,
  generateId,
  createJobCards,
  computeBackwardSchedule,
  resolveWipCode,
} from "./mock-data";
import type {
  ProductionOrder,
  SalesOrder,
  SalesOrderItem,
  JobCard,
  JobCardStatus,
  LeadTimeCategory,
  WipCodeContext,
  BOMTemplateWIP,
} from "./mock-data";

// ---- constants & helpers ---------------------------------------------------

const WIP_LABELS: Record<string, string> = {
  DIVAN: "Divan",
  HEADBOARD: "Headboard",
  SOFA_BASE: "Sofa Base",
  SOFA_CUSHION: "Cushion",
  SOFA_ARMREST: "Armrest",
};

/** Prefer the BOM's own wipCode; fall back to generic label. */
function wipLabelFor(wipType: string, wipCode: string): string {
  return wipCode || WIP_LABELS[wipType] || wipType;
}

/**
 * Normalize a product code for fuzzy matching: strip non-alphanumerics,
 * uppercase. Handles catalog dash drift like "2023-(HF)(W)-(S)" vs
 * "2023(HF)(W)-(S)".
 */
function normCode(s: string): string {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

// ---- BOM-driven JobCard generation -----------------------------------------

export interface BOMJobCardResult {
  jobCards: JobCard[];
  usedBom: boolean;
  warnings: string[];
}

/**
 * Generate job cards for a single SO line item using the BOM template tree.
 *
 * Each WIP component (Divan, Headboard, Sofa Base, Cushion, Armrest, ...)
 * and the FG-level L1 processes get their OWN row per dept they touch.
 *
 * Falls back to the legacy 8-dept `createJobCards` when no BOM exists.
 *
 * @param itemQuantity - SO line quantity, used to compute wipQty per card
 */
export function createJobCardsFromBOM(
  productCode: string,
  targetDate: string,
  fallbackEstMinutes: number,
  leadCategory: LeadTimeCategory,
  customerDeliveryDate: string,
  itemCtx: WipCodeContext,
  itemQuantity: number = 1,
): BOMJobCardResult {
  const want = normCode(productCode);

  // Prefer ACTIVE version; fall back to any version if no ACTIVE found
  const bom =
    bomTemplates.find(
      (t) => t.productCode === productCode && t.versionStatus === "ACTIVE",
    ) ||
    bomTemplates.find(
      (t) => normCode(t.productCode) === want && t.versionStatus === "ACTIVE",
    ) ||
    bomTemplates.find((t) => t.productCode === productCode) ||
    bomTemplates.find((t) => normCode(t.productCode) === want);

  if (!bom) {
    return {
      jobCards: createJobCards(targetDate, "BEDFRAME", fallbackEstMinutes),
      usedBom: false,
      warnings: [
        `No BOM template for ${productCode} — fell back to default 8-dept routing`,
      ],
    };
  }

  const warnings: string[] = [];

  // Pre-compute the backward schedule once per SO line so every node in
  // the tree pulls its dueDate from the same leadtime config.
  const schedule = customerDeliveryDate
    ? computeBackwardSchedule(customerDeliveryDate, leadCategory)
    : null;

  // Recursive walker — each WIP node (including nested children) emits one
  // card per process, labelled with THAT node's resolved codeSegments.
  // wipKey = top-level wipType so the entire subtree is grouped together
  // for dept dashboard filtering. ALL cards start with prerequisiteMet:
  // true — scheduling is driven purely by dueDate (no sequential gating).
  const cards: JobCard[] = [];

  const walkWip = (
    node: BOMTemplateWIP,
    topWipType: string,
    parentQty: number,
  ): void => {
    // `itemQuantity` (SO-line bedframe count) is already baked into the
    // initial parentQty on the outer call (see the `for (const w of
    // bom.wipComponents)` loop below). Multiplying it again here caused
    // a compounding bug where every extra recursion level re-applied
    // itemQuantity — e.g. a qty=2 bedframe ended up with FAB_CUT cards
    // showing wipQty=16 instead of the correct 4.
    const effectiveQty =
      (node.quantity || 1) * (parentQty || 1);
    const label = resolveWipCode(
      node.codeSegments,
      itemCtx,
      wipLabelFor(node.wipType, node.wipCode),
    );

    for (const p of node.processes || []) {
      const dept = departments.find((d) => d.code === p.deptCode);
      if (!dept) {
        warnings.push(
          `Unknown dept ${p.deptCode} on ${productCode}/${label} — skipped`,
        );
        continue;
      }
      // Initialize one piecePic slot per physical piece (wipQty). These are
      // the real work units for B-flow sticker-binding FIFO — pic1/pic2 and
      // completion timing live at piece level, not the aggregate JC.
      const pieceSlots = Math.max(1, Math.floor(effectiveQty || 1));
      const piecePics = Array.from({ length: pieceSlots }, (_, i) => ({
        pieceNo: i + 1,
        pic1Id: null,
        pic1Name: "",
        pic2Id: null,
        pic2Name: "",
        completedAt: null,
        lastScanAt: null,
        boundStickerKey: null,
      }));
      cards.push({
        id: generateId(),
        departmentId: dept.id,
        departmentCode: dept.code,
        departmentName: dept.shortName,
        sequence: dept.sequence,
        status: "WAITING" as JobCardStatus,
        dueDate: schedule?.deptDueDates[dept.code] || targetDate || "",
        wipKey: topWipType,
        wipCode: node.wipCode,
        wipType: node.wipType,
        wipLabel: label,
        wipQty: effectiveQty,
        prerequisiteMet: true,
        pic1Id: null,
        pic1Name: "",
        pic2Id: null,
        pic2Name: "",
        completedDate: null,
        estMinutes: p.minutes,
        actualMinutes: null,
        category: p.category || "CAT 1",
        productionTimeMinutes: p.minutes,
        overdue: "PENDING",
        piecePics,
      } as JobCard);
    }

    for (const child of node.children || []) {
      walkWip(child, topWipType, effectiveQty);
    }
  };

  // Seed the recursion with `itemQuantity` as the root parentQty — this is
  // the "how many finished bedframes does this SO line want" multiplier, and
  // it only needs to be applied once. The walker then just multiplies each
  // node's relative BOM quantity against the running parent product.
  const rootParentQty = itemQuantity || 1;
  for (const w of bom.wipComponents) {
    walkWip(w, w.wipType, rootParentQty);
  }

  if (cards.length === 0) {
    return {
      jobCards: createJobCards(targetDate, "BEDFRAME", fallbackEstMinutes),
      usedBom: false,
      warnings: [
        ...warnings,
        `No valid departments resolved for ${productCode}`,
      ],
    };
  }

  // Sort: by dept sequence first, then WIP key
  cards.sort((a, b) => {
    if (a.sequence !== b.sequence) return a.sequence - b.sequence;
    return (a.wipKey || "").localeCompare(b.wipKey || "");
  });

  return { jobCards: cards, usedBom: true, warnings };
}

// ---- Full PO builder -------------------------------------------------------

export interface BuildPOResult {
  po: ProductionOrder;
  usedBom: boolean;
  warnings: string[];
}

/**
 * Build a single ProductionOrder (with job cards) from a SalesOrder + item.
 *
 * This is the authoritative factory for PO creation — both the confirm API
 * route and the mock-data seed call this function.
 */
export function buildProductionOrderForSOItem(
  order: SalesOrder,
  item: SalesOrderItem,
): BuildPOResult {
  const poNo = `${order.companySOId}${item.lineSuffix}`;
  const now = new Date().toISOString();

  // Estimate minutes per department based on item category
  const estMinutes = item.productCode?.startsWith("DIVAN")
    ? 20
    : item.itemCategory === "ACCESSORY"
      ? 15
      : 60;

  // Derive leadtime category
  const leadCategory: LeadTimeCategory =
    item.itemCategory === "SOFA" ? "SOFA" : "BEDFRAME";

  // Backward-schedule from the customer delivery date
  if (order.customerDeliveryDate) {
    const schedule = computeBackwardSchedule(
      order.customerDeliveryDate,
      leadCategory,
    );
    if (!order.hookkaExpectedDD) {
      order.hookkaExpectedDD = schedule.hookkaExpectedDD;
    }
  }

  const targetDate = order.hookkaExpectedDD || order.customerDeliveryDate;

  // WIP code context for resolving BOM labels
  const itemCtx: WipCodeContext = {
    productCode: item.productCode,
    sizeLabel: item.sizeLabel,
    sizeCode: item.sizeCode,
    fabricCode: item.fabricCode,
    divanHeightInches: item.divanHeightInches,
    legHeightInches: item.legHeightInches,
    gapInches: item.gapInches,
  };

  const { jobCards, usedBom, warnings } = createJobCardsFromBOM(
    item.productCode,
    targetDate,
    estMinutes,
    leadCategory,
    order.customerDeliveryDate,
    itemCtx,
    item.quantity,
  );

  const po: ProductionOrder = {
    id: generateId(),
    poNo,
    salesOrderId: order.id,
    salesOrderNo: order.companySOId,
    lineNo: item.lineNo,
    customerPOId: order.customerPOId,
    customerReference: order.reference,
    customerName: order.customerName,
    customerState: order.customerState,
    companySOId: order.companySOId,
    productId: item.productId,
    productCode: item.productCode,
    productName: item.productName,
    itemCategory: item.itemCategory,
    sizeCode: item.sizeCode,
    sizeLabel: item.sizeLabel,
    fabricCode: item.fabricCode,
    quantity: item.quantity,
    gapInches: item.gapInches,
    divanHeightInches: item.divanHeightInches,
    legHeightInches: item.legHeightInches,
    specialOrder: item.specialOrder,
    notes: item.notes,
    status: "PENDING",
    currentDepartment: "FAB_CUT",
    progress: 0,
    jobCards,
    startDate: order.companySODate,
    targetEndDate: targetDate || "",
    completedDate: null,
    rackingNumber: "",
    stockedIn: false,
    createdAt: now,
    updatedAt: now,
  };

  return { po, usedBom, warnings };
}
