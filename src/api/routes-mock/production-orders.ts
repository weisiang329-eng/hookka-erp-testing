import { Hono } from 'hono';
import {
  productionOrders,
  workers,
  salesOrders,
  deliveryOrders,
  wipItems,
  products,
  rawMaterials,
  rmBatches,
  costLedger,
  fgBatches,
  generateId,
} from '../../lib/mock-data';
import type {
  ProductionOrder,
  JobCard,
  SalesOrder,
  WipItem,
} from '../../lib/mock-data';
import {
  applyOverridesOnce,
  saveJobCardOverride,
  savePOOverride,
} from '../lib/job-card-persistence';
import { getRawMaterialStock } from '../../lib/material-lookup';
import {
  fifoConsume,
  laborRateForDate,
  makeLedgerEntry,
} from '../../lib/costing';

const app = new Hono();

// Restore persisted jobCard completions into in-memory mock-data
applyOverridesOnce();

// ---------------------------------------------------------------
// WIP inventory helpers
// ---------------------------------------------------------------

/**
 * Derive a stable WIP code and type for a production order + department.
 * Returns null if this department does not produce a trackable WIP output.
 *
 * For bedframes:
 *   - UPHOLSTERY dept  → HB  WIP: "{productCode}-HB{divanHeight}""
 *   - FRAMING dept     → DIVAN WIP: "{divanHeight}" Divan-{sizeLabel}"
 * For sofas:
 *   - FRAMING dept     → BASE WIP:    "{productCode}-{seatHeight}"-BASE"
 *   - FAB_SEW dept     → CUSHION WIP: "{productCode}-{seatHeight}"-CUSHION"
 *   - WEBBING dept     → ARM WIP:     "{productCode}-{seatHeight}"-ARM"
 */
/**
 * Find or create a wipItem entry for the given code/type/relatedProduct.
 * Returns the (possibly new) entry — it is already pushed into wipItems.
 */
function getOrCreateWipItem(
  code: string,
  type: string,
  relatedProduct: string,
  deptCode: string
): WipItem {
  let entry = wipItems.find((w) => w.code === code);
  if (!entry) {
    entry = {
      id: `wip-dyn-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      code,
      type,
      relatedProduct,
      deptStatus: deptCode,
      stockQty: 0,
      status: 'PENDING',
    };
    wipItems.push(entry);
  }
  return entry;
}

/**
 * BOM-driven WIP inventory tracking.
 *
 * Each job card carries wipLabel / wipType / wipKey from the BOM tree.
 * The BOM tree is hierarchical (child → parent):
 *
 *   Wood Cut produces "8" Divan- 5FT (WD)"
 *     → Framing starts: consumes "8" Divan- 5FT (WD)"
 *     → Framing completes: produces "8" Divan- 5FT Frame"
 *       → Webbing starts: consumes "8" Divan- 5FT Frame"
 *       ... and so on up the tree.
 *
 * To find what to consume on IN_PROGRESS, we look for the child job card
 * in the SAME wipKey group that feeds into this department (i.e. the one
 * with the highest sequence that is still below this card's sequence).
 *
 * @param order            The production order being updated
 * @param changedJcDeptCode The dept code of the job card whose status changed
 * @param newStatus         The new status being set on that job card
 */
function applyWipInventoryChange(
  order: ProductionOrder,
  changedJcDeptCode: string,
  newStatus: string
): void {
  // Find ALL job cards for this dept (there may be multiple: one per wipKey)
  const changedJcs = order.jobCards.filter(
    (jc) => jc.departmentCode === changedJcDeptCode
  );

  for (const changedJc of changedJcs) {
    const wipLabel = (changedJc as Record<string, unknown>).wipLabel as string | undefined;
    const wipType = (changedJc as Record<string, unknown>).wipType as string | undefined;
    const wipKey = (changedJc as Record<string, unknown>).wipKey as string | undefined;
    const wipQty = ((changedJc as Record<string, unknown>).wipQty as number) || order.quantity || 1;

    if (!wipLabel) continue; // No BOM data — skip

    // Shorten wipType for inventory display: HEADBOARD → HB, SOFA_BASE → BASE, etc.
    const shortType = (() => {
      const t = (wipType || '').toUpperCase();
      if (t === 'HEADBOARD') return 'HB';
      if (t === 'SOFA_BASE') return 'BASE';
      if (t === 'SOFA_CUSHION') return 'CUSHION';
      if (t === 'SOFA_ARMREST') return 'ARMREST';
      return t || 'WIP';
    })();

    // --- Case 1: Job card completed → produce this WIP into inventory ---
    if (newStatus === 'COMPLETED' || newStatus === 'TRANSFERRED') {
      const entry = getOrCreateWipItem(
        wipLabel,
        shortType,
        order.productCode,
        changedJcDeptCode
      );
      entry.stockQty += wipQty;
      entry.deptStatus = changedJcDeptCode;
      entry.status = 'COMPLETED';
    }

    // --- Case 2: Job card started → consume child WIP from inventory ---
    if (newStatus === 'IN_PROGRESS') {
      // Find child job cards: same wipKey, lower sequence (these feed into us)
      const sameWipKeyCards = order.jobCards.filter((jc) => {
        const jcWipKey = (jc as Record<string, unknown>).wipKey as string | undefined;
        return jcWipKey === wipKey && jc.sequence < changedJc.sequence;
      });

      // The immediate child is the one with the highest sequence below ours
      const childJc = sameWipKeyCards.sort(
        (a, b) => b.sequence - a.sequence
      )[0];

      if (childJc) {
        const childWipLabel = (childJc as Record<string, unknown>).wipLabel as string | undefined;
        if (childWipLabel) {
          const entry = wipItems.find((w) => w.code === childWipLabel);
          if (entry && entry.stockQty > 0) {
            entry.stockQty = Math.max(0, entry.stockQty - wipQty);
            if (entry.stockQty === 0) {
              entry.status = 'IN_PRODUCTION';
            }
          }
        }
      }
    }
  }
}

// Cascade upholstery completion to SO status
function cascadeUpholsteryToSO(poId: string) {
  const po = productionOrders.find((o) => o.id === poId);
  if (!po || !po.salesOrderId) return;
  const so = salesOrders.find((s) => s.id === po.salesOrderId);
  if (!so) return;

  const siblingPOs = productionOrders.filter((p) => p.salesOrderId === so.id);
  if (siblingPOs.length === 0) return;

  const totalUph = siblingPOs.reduce(
    (n, p) => n + p.jobCards.filter((j) => j.departmentCode === 'UPHOLSTERY').length,
    0
  );
  if (totalUph === 0) return;

  const everyUphDone = siblingPOs.every((p) => {
    const uph = p.jobCards.filter((j) => j.departmentCode === 'UPHOLSTERY');
    if (uph.length === 0) return true;
    return uph.every((j) => j.status === 'COMPLETED' || j.status === 'TRANSFERRED');
  });

  if (everyUphDone) {
    // Mark each PO as stocked-in (finished good in inventory)
    for (const p of siblingPOs) {
      const pUph = p.jobCards.filter((j) => j.departmentCode === 'UPHOLSTERY');
      if (pUph.length > 0 && pUph.every((j) => j.status === 'COMPLETED' || j.status === 'TRANSFERRED')) {
        p.stockedIn = true;
      }
    }
    if (so.status !== 'READY_TO_SHIP') {
      so.status = 'READY_TO_SHIP';
      so.updatedAt = new Date().toISOString();
    }
  } else {
    if (so.status === 'READY_TO_SHIP') {
      so.status = 'CONFIRMED';
      so.updatedAt = new Date().toISOString();
    }
  }
}

// ---------------------------------------------------------------
// Production order completion → FIFO consume + labor + FGBatch
// ---------------------------------------------------------------
//
// When a PO transitions into COMPLETED we need to:
//
//   1. Walk the product's BOM, FIFO-consume RM batches, emit RM_ISSUE
//      ledger entries, and bump RM balanceQty downward.
//   2. Compute labor cost for the batch using the floating per-minute
//      rate (see laborRateForDate) against total production minutes —
//      actual minutes if recorded, otherwise plan (deptWorkingTimes ×
//      order quantity).
//   3. Create a single FGBatch layer with materialCost + laborCost,
//      unit cost = total / orderQty.
//   4. Emit the LABOR_POSTED and FG_COMPLETED ledger entries.
//
// Idempotency: guarded by "is there already an FGBatch for this PO?".
//
// BOM resolution: a BOM component names a materialCategory (e.g.
// "PLYWOOD", "BM_FABRIC"). We look up matching rawMaterials via
// getRawMaterialStock.items (which maps categories to itemGroups), then
// gather all rmBatches for those RMs and FIFO-consume cross-RM by
// receivedDate. If a BOMComponent has an exact materialName match on
// RM description/itemCode, prefer that narrower pool.
function postProductionOrderCompletion(order: ProductionOrder): {
  materialCostSen: number;
  laborCostSen: number;
  fgBatchId: string | null;
  shortageLines: { materialName: string; shortageQty: number }[];
} | undefined {
  // Idempotency — if we've already minted an FG layer for this PO, bail.
  const already = fgBatches.some((b) => b.productionOrderId === order.id);
  if (already) return;

  const product = products.find((p) => p.id === order.productId);
  const orderQty = Number(order.quantity) || 0;
  if (!product || orderQty <= 0) return;

  const completedAtIso = order.completedDate
    ? new Date(`${order.completedDate}T12:00:00`).toISOString()
    : new Date().toISOString();
  const createdIso = new Date().toISOString();

  let materialCostTotalSen = 0;
  const shortages: { materialName: string; shortageQty: number }[] = [];

  // ---- Material FIFO consume ---------------------------------------------
  for (const bom of product.bomComponents || []) {
    const perUnit = Number(bom.qtyPerUnit) || 0;
    if (perUnit <= 0) continue;
    const waste = Math.max(0, Number(bom.wastePct) || 0) / 100;
    const requiredQty = perUnit * orderQty * (1 + waste);
    if (requiredQty <= 0) continue;

    // Preferred RM set: exact match on name/code, else full category group.
    const categoryMatches = getRawMaterialStock(bom.materialCategory).items;
    const exact = categoryMatches.find(
      (rm) =>
        rm.description === bom.materialName ||
        rm.itemCode === bom.materialName,
    );
    const rmPool = exact ? [exact] : categoryMatches;
    if (rmPool.length === 0) {
      shortages.push({ materialName: bom.materialName, shortageQty: requiredQty });
      continue;
    }

    // Gather batches for the pool, FIFO consume (function mutates
    // remainingQty in place on the live rmBatches array).
    const poolIds = new Set(rmPool.map((rm) => rm.id));
    const batchesPool = rmBatches.filter((b) => poolIds.has(b.rmId));
    const result = fifoConsume(batchesPool, requiredQty);
    materialCostTotalSen += result.totalCostSen;

    for (const slice of result.slices) {
      const batch = rmBatches.find((b) => b.id === slice.batchId);
      if (!batch) continue;
      const rm = rawMaterials.find((r) => r.id === batch.rmId);
      if (rm) {
        rm.balanceQty = Math.max(0, (rm.balanceQty || 0) - slice.qty);
      }
      costLedger.push(
        makeLedgerEntry({
          date: completedAtIso,
          type: 'RM_ISSUE',
          itemType: 'RM',
          itemId: batch.rmId,
          batchId: slice.batchId,
          qty: slice.qty,
          direction: 'OUT',
          unitCostSen: slice.unitCostSen,
          refType: 'PRODUCTION_ORDER',
          refId: order.id,
          notes: `Issued for ${order.poNo} (${bom.materialName})`,
        }),
      );
    }

    if (result.shortageQty > 0) {
      shortages.push({
        materialName: bom.materialName,
        shortageQty: result.shortageQty,
      });
    }
  }

  // ---- Labor cost --------------------------------------------------------
  const ratePerMinSen = laborRateForDate(completedAtIso);
  const actualSum = order.jobCards.reduce(
    (s, jc) => s + (Number(jc.actualMinutes) || 0),
    0,
  );
  let totalMinutes = 0;
  if (actualSum > 0) {
    // actualMinutes is already an absolute time across the job card
    totalMinutes = actualSum;
  } else {
    const planPerUnit = (product.deptWorkingTimes || []).reduce(
      (s, dwt) => s + (Number(dwt.minutes) || 0),
      0,
    );
    totalMinutes = planPerUnit * orderQty;
  }
  const laborCostTotalSen = Math.round(ratePerMinSen * totalMinutes);

  if (laborCostTotalSen > 0) {
    costLedger.push(
      makeLedgerEntry({
        date: completedAtIso,
        type: 'LABOR_POSTED',
        itemType: 'WIP',
        itemId: order.id,
        qty: totalMinutes,
        direction: 'IN',
        unitCostSen: Math.round(ratePerMinSen),
        refType: 'PRODUCTION_ORDER',
        refId: order.id,
        notes: `Labor for ${product.name} (${orderQty} pcs / ${totalMinutes} min)`,
      }),
    );
  }

  // ---- FG batch layer ----------------------------------------------------
  const totalCostSen = materialCostTotalSen + laborCostTotalSen;
  const unitCostSen = orderQty > 0 ? Math.round(totalCostSen / orderQty) : 0;
  const fgBatchId = `fgb-${order.id}`;
  fgBatches.push({
    id: fgBatchId,
    productId: product.id,
    productionOrderId: order.id,
    completedDate: completedAtIso,
    originalQty: orderQty,
    remainingQty: orderQty,
    unitCostSen,
    materialCostSen: materialCostTotalSen,
    laborCostSen: laborCostTotalSen,
    overheadCostSen: 0,
    createdAt: createdIso,
  });

  costLedger.push(
    makeLedgerEntry({
      date: completedAtIso,
      type: 'FG_COMPLETED',
      itemType: 'FG',
      itemId: product.id,
      batchId: fgBatchId,
      qty: orderQty,
      direction: 'IN',
      unitCostSen,
      refType: 'PRODUCTION_ORDER',
      refId: order.id,
      notes: `Completed ${order.poNo}`,
    }),
  );

  return {
    materialCostSen: materialCostTotalSen,
    laborCostSen: laborCostTotalSen,
    fgBatchId,
    shortageLines: shortages,
  };
}

// One-time cleanup of auto-created DOs
if (!(globalThis as { __hookka_doCleanupDone__?: boolean }).__hookka_doCleanupDone__) {
  for (let i = deliveryOrders.length - 1; i >= 0; i--) {
    const r = deliveryOrders[i]?.remarks || '';
    if (
      r === 'Auto-created on Upholstery completion' ||
      r === 'Auto-created — all SO upholstery complete'
    ) {
      deliveryOrders.splice(i, 1);
    }
  }
  (globalThis as { __hookka_doCleanupDone__?: boolean }).__hookka_doCleanupDone__ = true;
}

// GET /api/production-orders
app.get('/', (c) => {
  return c.json({
    success: true,
    data: productionOrders,
    total: productionOrders.length,
  });
});

// ---------------------------------------------------------------
// Stock (make-to-stock) PO creation
//
// When the factory has spare capacity, operators can pre-produce a WIP
// (just the Divan, or just the Headboard) or an entire FG (complete
// bedset) and park it as stock against a placeholder "SOH-YYMM-NNN" SO.
// When a real customer order lands later, that SOH SO is renamed in
// place to the customer's SO number — the PO/jobCard/progress survives
// the swap. That renaming is Phase B and is not implemented here; this
// block only covers Phase A (creation).
//
// ---------------------------------------------------------------

type HistoricalWip = {
  wipLabel: string;
  wipKey?: string;
  wipCode?: string;
  wipType?: string;
  sourcePoId: string;
  sourceJcId: string;
  sourcePoNo: string;
  itemCategory: ProductionOrder['itemCategory'];
  productCode: string;
  productName: string;
  sizeCode: string;
  sizeLabel: string;
  fabricCode: string;
  lastSeen: string; // source PO createdAt, used for sort
};

type HistoricalFg = {
  sourcePoId: string;
  sourcePoNo: string;
  itemCategory: ProductionOrder['itemCategory'];
  productCode: string;
  productName: string;
  sizeCode: string;
  sizeLabel: string;
  fabricCode: string;
  lastSeen: string;
};

// GET /api/production-orders/historical-wips
// Distinct WIPs that have appeared in any JobCard to date. Dedupe key is
// `wipLabel + wipKey + sizeCode + fabricCode` — varying size or fabric
// means "different stock SKU" from the operator's point of view.
app.get('/historical-wips', (c) => {
  const seen = new Map<string, HistoricalWip>();
  for (const po of productionOrders) {
    for (const jc of po.jobCards) {
      if (!jc.wipLabel) continue;
      const key = `${jc.wipLabel}::${jc.wipKey ?? ''}::${po.sizeCode}::${po.fabricCode}`;
      const prev = seen.get(key);
      // Keep the most recent source — helpful when seed data gets
      // refreshed and wipLabel strings are re-used across POs.
      if (!prev || (po.createdAt || '') > (prev.lastSeen || '')) {
        seen.set(key, {
          wipLabel: jc.wipLabel,
          wipKey: jc.wipKey,
          wipCode: jc.wipCode,
          wipType: jc.wipType,
          sourcePoId: po.id,
          sourceJcId: jc.id,
          sourcePoNo: po.poNo,
          itemCategory: po.itemCategory,
          productCode: po.productCode,
          productName: po.productName,
          sizeCode: po.sizeCode,
          sizeLabel: po.sizeLabel,
          fabricCode: po.fabricCode,
          lastSeen: po.createdAt || '',
        });
      }
    }
  }
  const list = Array.from(seen.values()).sort((a, b) => {
    // Most-recent first, then alphabetical on the label so the top of
    // the list is "stuff you've been producing lately".
    if (a.lastSeen !== b.lastSeen) return a.lastSeen > b.lastSeen ? -1 : 1;
    return a.wipLabel.localeCompare(b.wipLabel);
  });
  return c.json({ success: true, data: list });
});

// GET /api/production-orders/historical-fgs
// Distinct finished goods by product + size + fabric. Same sort rules.
app.get('/historical-fgs', (c) => {
  const seen = new Map<string, HistoricalFg>();
  for (const po of productionOrders) {
    const key = `${po.productCode}::${po.sizeCode}::${po.fabricCode}`;
    const prev = seen.get(key);
    if (!prev || (po.createdAt || '') > (prev.lastSeen || '')) {
      seen.set(key, {
        sourcePoId: po.id,
        sourcePoNo: po.poNo,
        itemCategory: po.itemCategory,
        productCode: po.productCode,
        productName: po.productName,
        sizeCode: po.sizeCode,
        sizeLabel: po.sizeLabel,
        fabricCode: po.fabricCode,
        lastSeen: po.createdAt || '',
      });
    }
  }
  const list = Array.from(seen.values()).sort((a, b) => {
    if (a.lastSeen !== b.lastSeen) return a.lastSeen > b.lastSeen ? -1 : 1;
    return a.productName.localeCompare(b.productName);
  });
  return c.json({ success: true, data: list });
});

// Month-based counter: "SOH-2604-001" etc. Resets each calendar month.
// Scanning the existing salesOrders is O(n) — we only have a couple of
// thousand rows even in the full mock data, and this endpoint is rare.
function nextSOHNumber(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `SOH-${yy}${mm}-`;
  let maxSeq = 0;
  for (const so of salesOrders) {
    if (!so.companySOId || !so.companySOId.startsWith(prefix)) continue;
    const tail = so.companySOId.slice(prefix.length);
    const n = parseInt(tail, 10);
    if (Number.isFinite(n) && n > maxSeq) maxSeq = n;
  }
  return `${prefix}${String(maxSeq + 1).padStart(3, '0')}`;
}

// POST /api/production-orders/stock
// Body: {
//   type: "WIP" | "FG",
//   sourcePoId: string,
//   sourceJcId?: string (required for WIP — picks the wipKey group),
//   quantity: number,
//   targetEndDate: string (YYYY-MM-DD),
// }
//
// Returns: { success, data: newPO }.
//
// Cloning strategy:
//   - WIP mode → copy only the jobCards that share `wipKey` with the
//     selected source JC. For a Divan pick on a bedframe PO that means
//     WOOD_CUT + FRAMING + WEBBING + UPHOLSTERY Divan — HB is dropped,
//     PACKING is dropped. Result is a PO that produces one physical
//     Divan and ends at Upholstery (stocking-in).
//   - FG mode → copy every jobCard on the source PO (full pipeline
//     including PACKING). Result is a stock-ready finished bedset.
//
// Every copied jobCard is reset: pic* cleared, status=WAITING,
// completedDate=null, actualMinutes=null, piecePics left undefined so
// the scan endpoint lazily initialises them from wipQty on first scan.
app.post('/stock', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const type = body?.type as 'WIP' | 'FG' | undefined;
  const sourcePoId = body?.sourcePoId as string | undefined;
  const sourceJcId = body?.sourceJcId as string | undefined;
  const quantity = Math.max(1, Math.floor(Number(body?.quantity) || 0));
  const targetEndDate = body?.targetEndDate as string | undefined;

  if (type !== 'WIP' && type !== 'FG') {
    return c.json({ success: false, error: 'type must be WIP or FG' }, 400);
  }
  if (!sourcePoId) {
    return c.json({ success: false, error: 'sourcePoId is required' }, 400);
  }
  if (type === 'WIP' && !sourceJcId) {
    return c.json({ success: false, error: 'sourceJcId is required for WIP stock PO' }, 400);
  }
  if (!quantity) {
    return c.json({ success: false, error: 'quantity must be >= 1' }, 400);
  }
  if (!targetEndDate || !/^\d{4}-\d{2}-\d{2}$/.test(targetEndDate)) {
    return c.json({ success: false, error: 'targetEndDate must be YYYY-MM-DD' }, 400);
  }

  const sourcePO = productionOrders.find((p) => p.id === sourcePoId);
  if (!sourcePO) {
    return c.json({ success: false, error: 'Source PO not found' }, 404);
  }

  // Pick which jobCards to clone.
  let jcsToCopy: JobCard[];
  let selectedWipLabel = '';
  if (type === 'WIP') {
    const sourceJc = sourcePO.jobCards.find((j) => j.id === sourceJcId);
    if (!sourceJc) {
      return c.json({ success: false, error: 'Source JC not found on source PO' }, 404);
    }
    selectedWipLabel = sourceJc.wipLabel || '';
    if (sourceJc.wipKey) {
      jcsToCopy = sourcePO.jobCards.filter((j) => j.wipKey === sourceJc.wipKey);
    } else {
      // Legacy seed data without wipKey — fall back to single-JC clone.
      jcsToCopy = [sourceJc];
    }
  } else {
    jcsToCopy = [...sourcePO.jobCards];
  }
  if (jcsToCopy.length === 0) {
    return c.json({ success: false, error: 'No jobCards to clone from source PO' }, 422);
  }

  const nowIso = new Date().toISOString();
  const today = nowIso.split('T')[0];

  // ----- Generate placeholder SO (SOH-YYMM-NNN) -----
  const sohNo = nextSOHNumber();
  const soId = generateId();

  // Minimal single-item line derived from the source PO spec, so downstream
  // code (delivery, invoicing, etc.) that assumes items.length > 0 doesn't
  // explode when it encounters a stock SO.
  const newItem = {
    id: generateId(),
    lineNo: 1,
    lineSuffix: '-01',
    productId: sourcePO.productId,
    productCode: sourcePO.productCode,
    productName: sourcePO.productName,
    itemCategory: sourcePO.itemCategory,
    sizeCode: sourcePO.sizeCode,
    sizeLabel: sourcePO.sizeLabel,
    fabricId: '',
    fabricCode: sourcePO.fabricCode,
    quantity,
    gapInches: sourcePO.gapInches,
    divanHeightInches: sourcePO.divanHeightInches,
    divanPriceSen: 0,
    legHeightInches: sourcePO.legHeightInches,
    legPriceSen: 0,
    specialOrder: sourcePO.specialOrder || '',
    specialOrderPriceSen: 0,
    basePriceSen: 0,
    unitPriceSen: 0,
    lineTotalSen: 0,
    notes: type === 'WIP' ? `Stock WIP: ${selectedWipLabel}` : 'Stock FG',
  };

  const newSO: SalesOrder = {
    id: soId,
    customerPO: '',
    customerPOId: '',
    customerPODate: '',
    customerSO: '',
    customerSOId: '',
    reference: type === 'WIP' ? `Stock WIP (${selectedWipLabel})` : 'Stock FG',
    customerId: '',
    customerName: '— Stock —',
    customerState: '',
    companySO: sohNo,
    companySOId: sohNo,
    companySODate: today,
    customerDeliveryDate: targetEndDate,
    hookkaExpectedDD: targetEndDate,
    hookkaDeliveryOrder: '',
    items: [newItem],
    subtotalSen: 0,
    totalSen: 0,
    // DRAFT keeps stock SOs out of sales-side pipeline queries (CONFIRMED/IN_PRODUCTION)
    // until an actual customer order replaces the placeholder SOH number.
    status: 'DRAFT',
    overdue: 'PENDING',
    notes: 'Stock placeholder — will be renamed to the customer SO when a real order lands.',
    isStock: true,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  salesOrders.push(newSO);

  // ----- Clone jobCards (reset worker-side state) -----
  const minSeq = jcsToCopy.reduce(
    (m, j) => (j.sequence < m ? j.sequence : m),
    jcsToCopy[0].sequence,
  );
  const sourceQty = Math.max(1, sourcePO.quantity || 1);

  const newJCs: JobCard[] = jcsToCopy.map((jc) => {
    // Scale wipQty from the source PO's quantity to the new one.
    // Example: source qty=2, source jc.wipQty=2 (per-unit: 1). New qty=3
    // → new wipQty = 3.
    const perUnit = (jc.wipQty ?? sourceQty) / sourceQty;
    const newWipQty = Math.max(1, Math.round(perUnit * quantity));
    return {
      ...jc,
      id: generateId(),
      status: 'WAITING',
      dueDate: targetEndDate,
      prerequisiteMet: jc.sequence === minSeq,
      pic1Id: null,
      pic1Name: '',
      pic2Id: null,
      pic2Name: '',
      completedDate: null,
      actualMinutes: null,
      overdue: 'PENDING',
      rackingNumber: undefined,
      piecePics: undefined,
      wipQty: newWipQty,
    };
  });

  // ----- Build PO -----
  const newPoId = generateId();
  const newPoNo = `${sohNo}-01`;
  const firstDept = newJCs
    .slice()
    .sort((a, b) => a.sequence - b.sequence)[0]?.departmentCode || 'WOOD_CUT';

  const newPO: ProductionOrder = {
    id: newPoId,
    poNo: newPoNo,
    salesOrderId: soId,
    salesOrderNo: sohNo,
    lineNo: 1,
    customerPOId: '',
    customerReference: type === 'WIP' ? `Stock WIP (${selectedWipLabel})` : 'Stock FG',
    customerName: '— Stock —',
    customerState: '',
    companySOId: sohNo,
    productId: sourcePO.productId,
    productCode: sourcePO.productCode,
    productName: sourcePO.productName,
    itemCategory: sourcePO.itemCategory,
    sizeCode: sourcePO.sizeCode,
    sizeLabel: sourcePO.sizeLabel,
    fabricCode: sourcePO.fabricCode,
    quantity,
    gapInches: sourcePO.gapInches,
    divanHeightInches: sourcePO.divanHeightInches,
    legHeightInches: sourcePO.legHeightInches,
    specialOrder: sourcePO.specialOrder || '',
    notes: type === 'WIP'
      ? `Stock PO — WIP only (${selectedWipLabel}). Cloned from ${sourcePO.poNo}.`
      : `Stock PO — FG. Cloned from ${sourcePO.poNo}.`,
    status: 'PENDING',
    currentDepartment: firstDept,
    progress: 0,
    jobCards: newJCs,
    startDate: today,
    targetEndDate,
    completedDate: null,
    rackingNumber: '',
    stockedIn: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  productionOrders.push(newPO);

  return c.json({ success: true, data: newPO });
});

// GET /api/production-orders/:id
app.get('/:id', (c) => {
  const id = c.req.param('id');
  const order = productionOrders.find((o) => o.id === id);
  if (!order) {
    return c.json({ success: false, error: 'Production order not found' }, 404);
  }
  return c.json({ success: true, data: order });
});

// PUT /api/production-orders/:id
app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = productionOrders.findIndex((o) => o.id === id);
  if (idx === -1) {
    return c.json({ success: false, error: 'Production order not found' }, 404);
  }

  const body = await c.req.json();
  const order = productionOrders[idx];

  if (body.jobCardId) {
    const jcIdx = order.jobCards.findIndex((jc) => jc.id === body.jobCardId);
    if (jcIdx === -1) {
      return c.json({ success: false, error: 'Job card not found' }, 404);
    }

    const jobCard = order.jobCards[jcIdx];

    if (body.status) {
      jobCard.status = body.status;
      const isDone = body.status === 'COMPLETED' || body.status === 'TRANSFERRED';
      if (isDone) {
        if (!jobCard.completedDate) {
          jobCard.completedDate = new Date().toISOString().split('T')[0];
        }
        jobCard.overdue = 'COMPLETED';
      } else {
        if (body.completedDate === undefined) {
          jobCard.completedDate = null;
        }
      }
      // Track WIP inventory changes
      applyWipInventoryChange(order, jobCard.departmentCode, body.status);
    }

    if (body.completedDate !== undefined) {
      jobCard.completedDate = body.completedDate || null;
    }

    if (body.pic1Id !== undefined) {
      jobCard.pic1Id = body.pic1Id;
      const worker1 = workers.find((w) => w.id === body.pic1Id);
      jobCard.pic1Name = worker1?.name || '';
    }
    if (body.pic2Id !== undefined) {
      jobCard.pic2Id = body.pic2Id;
      const worker2 = workers.find((w) => w.id === body.pic2Id);
      jobCard.pic2Name = worker2?.name || '';
    }

    if (body.actualMinutes !== undefined) {
      jobCard.actualMinutes = body.actualMinutes;
    }

    if (body.dueDate !== undefined) {
      jobCard.dueDate = body.dueDate;
    }

    if (body.rackingNumber !== undefined && body.jobCardId) {
      jobCard.rackingNumber = body.rackingNumber;
      order.rackingNumber = body.rackingNumber;
    }

    order.jobCards[jcIdx] = jobCard;

    // Persist jobCard delta
    const jcPatch: Record<string, unknown> = {};
    if (body.status !== undefined) jcPatch.status = jobCard.status;
    if (body.completedDate !== undefined || body.status !== undefined) {
      jcPatch.completedDate = jobCard.completedDate;
    }
    if (body.pic1Id !== undefined) {
      jcPatch.pic1Id = jobCard.pic1Id;
      jcPatch.pic1Name = jobCard.pic1Name;
    }
    if (body.pic2Id !== undefined) {
      jcPatch.pic2Id = jobCard.pic2Id;
      jcPatch.pic2Name = jobCard.pic2Name;
    }
    if (body.actualMinutes !== undefined) jcPatch.actualMinutes = jobCard.actualMinutes;
    if (body.dueDate !== undefined) jcPatch.dueDate = jobCard.dueDate;
    if (body.rackingNumber !== undefined) jcPatch.rackingNumber = jobCard.rackingNumber;
    if (Object.keys(jcPatch).length > 0) {
      saveJobCardOverride(order.id, jobCard.id, jcPatch);
    }

    // Recalculate progress
    const completedCount = order.jobCards.filter(
      (jc) => jc.status === 'COMPLETED' || jc.status === 'TRANSFERRED'
    ).length;
    order.progress = Math.round((completedCount / order.jobCards.length) * 100);

    if (completedCount === order.jobCards.length) {
      order.status = 'COMPLETED';
      order.completedDate = new Date().toISOString().split('T')[0];

      // FIFO consume + labor + FGBatch (Phase 2b / 3a)
      postProductionOrderCompletion(order);

      if (order.salesOrderId) {
        const so = salesOrders.find((s) => s.id === order.salesOrderId);
        if (so) {
          const siblingPOs = productionOrders.filter((po) => po.salesOrderId === so.id);
          const allComplete =
            siblingPOs.length > 0 && siblingPOs.every((po) => po.status === 'COMPLETED');
          if (allComplete && so.status !== 'READY_TO_SHIP') {
            so.status = 'READY_TO_SHIP';
            so.updatedAt = new Date().toISOString();
          }
        }
      }
    } else {
      order.status = 'IN_PROGRESS';
      order.completedDate = null;
    }

    const activeDept = order.jobCards.find(
      (jc) => jc.status === 'IN_PROGRESS' || jc.status === 'WAITING'
    );
    order.currentDepartment = activeDept?.departmentCode || 'PACKING';
  }

  if (body.targetEndDate !== undefined) order.targetEndDate = body.targetEndDate;
  if (body.rackingNumber !== undefined) order.rackingNumber = body.rackingNumber;
  if (body.stockedIn !== undefined) order.stockedIn = body.stockedIn;

  // Persist PO-level deltas
  const poPatch: Record<string, unknown> = {};
  if (body.targetEndDate !== undefined) poPatch.targetEndDate = order.targetEndDate;
  if (body.rackingNumber !== undefined) poPatch.rackingNumber = order.rackingNumber;
  if (body.stockedIn !== undefined) poPatch.stockedIn = order.stockedIn;
  if (body.jobCardId) {
    poPatch.status = order.status;
    poPatch.progress = order.progress;
    poPatch.completedDate = order.completedDate;
    poPatch.currentDepartment = order.currentDepartment;
  }
  if (Object.keys(poPatch).length > 0) {
    savePOOverride(order.id, poPatch);
  }

  order.updatedAt = new Date().toISOString();
  productionOrders[idx] = order;

  cascadeUpholsteryToSO(order.id);

  return c.json({ success: true, data: order });
});

// POST /api/production-orders/:id/scan-complete
// ── B-FLOW SCAN — piecePics + sticker-binding FIFO ─────────────────────────
//
// Data model:
//   Each JC carries `piecePics: PiecePic[]` — one slot per physical piece
//   (wipQty = Divan BOM qty × PO qty). Every slot tracks its own pic1/pic2,
//   completedAt, lastScanAt, and `boundStickerKey` (the sticker that
//   FIFO-routed to it).
//
// Sticker = the QR on a specific physical piece. Key = poId::jcId::pieceNo
// encoded in the URL (`p=<pieceNo>&t=<totalPieces>`). 1 sticker = 1 piece.
//
// Scan flow:
//   1. Build stickerKey from the scan payload.
//   2. Look for a piecePic (across all POs in the same spec) where
//      boundStickerKey === stickerKey.
//        • Found  → this sticker has been routed before; stay on that slot.
//                   (2nd worker on the SAME physical piece → share time.)
//        • None   → fresh sticker. Run FIFO over all unbound/pic1-empty
//                   same-spec piecePics; pick oldest PO targetEndDate;
//                   bind stickerKey onto that slot.
//   3. Guards applied at PIECE level:
//        • same-worker → 409 ALREADY_PIC1 / ALREADY_PIC2
//        • 3-second debounce on piece.lastScanAt → 429 DEBOUNCE
//        • both slots filled by OTHERS → 400 PIC_FULL (no FIFO jump; the
//          sticker is already bound, we don't silently move it)
//   4. Fill slot: pic1 first → piece.completedAt = now. pic2 optional share.
//   5. JC rollup: all piecePics have pic1Id → JC status = COMPLETED.
//      Legacy jc.pic1Id / pic2Id mirror the piece that triggered completion
//      so A-flow readers (older dashboards) keep working.
//
// wipQty × share: actualMinutes stored on JC is the full planned time;
// per-worker efficiency divides by pic count on each piece when aggregating.
app.post('/:id/scan-complete', async (c) => {
  const scannedId = c.req.param('id');
  const scannedPoIdx = productionOrders.findIndex((o) => o.id === scannedId);
  if (scannedPoIdx === -1) {
    return c.json({ success: false, error: 'Production order not found' }, 404);
  }

  const body = await c.req.json();
  const { jobCardId, workerId } = body || {};
  const rawPiece = Number(body?.pieceNo);
  // Default to piece 1 when scan came from a pre-piecePics sticker or manual
  // entry — the JC still has at least one slot, so this is safe.
  const pieceNo = Number.isFinite(rawPiece) && rawPiece >= 1 ? Math.floor(rawPiece) : 1;
  if (!jobCardId || !workerId) {
    return c.json({ success: false, error: 'jobCardId and workerId are required' }, 400);
  }

  const scannedPo = productionOrders[scannedPoIdx];
  const scannedJcIdx = scannedPo.jobCards.findIndex((jc) => jc.id === jobCardId);
  if (scannedJcIdx === -1) {
    return c.json({ success: false, error: 'Job card not found' }, 404);
  }

  const worker = workers.find((w) => w.id === workerId);
  if (!worker) {
    return c.json({ success: false, error: 'Worker not found' }, 400);
  }

  const scannedJc = scannedPo.jobCards[scannedJcIdx];

  // ── Ensure the scanned JC has piecePics (back-fill for older stickers) ──
  // Older JCs created before the Y-path rewrite may not have piecePics. We
  // lazy-init one slot per wipQty unit so the rest of the logic is uniform.
  const ensurePiecePics = (jc: typeof scannedJc) => {
    if (jc.piecePics && jc.piecePics.length > 0) return;
    const slots = Math.max(1, Math.floor((jc as Record<string, unknown>).wipQty as number || 1));
    jc.piecePics = Array.from({ length: slots }, (_, i) => ({
      pieceNo: i + 1,
      pic1Id: null,
      pic1Name: '',
      pic2Id: null,
      pic2Name: '',
      completedAt: null,
      lastScanAt: null,
      boundStickerKey: null,
    }));
  };
  ensurePiecePics(scannedJc);

  // ── Spec key: used to scope FIFO candidates ────────────────────────────
  const specKeyFor = (jc: typeof scannedJc, po: typeof scannedPo): string => {
    const wipLabel = jc.wipLabel;
    if (wipLabel) return `${jc.departmentCode}::${wipLabel}`;
    return `${jc.departmentCode}::${po.productCode}`;
  };
  const targetKey = specKeyFor(scannedJc, scannedPo);
  const stickerKey = `${scannedPo.id}::${scannedJc.id}::${pieceNo}`;

  // ── Find whether this sticker is already bound somewhere ───────────────
  // Scan every PO's JCs in the same spec; look for the piecePic that
  // recorded this stickerKey on its first routing. Sticker binding is
  // permanent for the life of the piece — even after 2 PICs are on it,
  // re-scanning returns the bound slot (so the worker sees the completion).
  type Hit = {
    po: ProductionOrder;
    poIdx: number;
    jc: typeof scannedJc;
    jcIdx: number;
    slot: NonNullable<typeof scannedJc.piecePics>[number];
  };

  let bound: Hit | null = null;
  for (let pI = 0; pI < productionOrders.length; pI++) {
    const p = productionOrders[pI];
    for (let jI = 0; jI < p.jobCards.length; jI++) {
      const j = p.jobCards[jI];
      if (specKeyFor(j, p) !== targetKey) continue;
      ensurePiecePics(j);
      if (!j.piecePics) continue;
      const hit = j.piecePics.find((s) => s.boundStickerKey === stickerKey);
      if (hit) {
        bound = { po: p, poIdx: pI, jc: j, jcIdx: jI, slot: hit };
        break;
      }
    }
    if (bound) break;
  }

  // ── FIFO routing for fresh stickers ───────────────────────────────────
  // Candidate = any piecePic in the same spec whose pic1 slot is still
  // open. Sort by PO targetEndDate asc, then createdAt asc, then pieceNo.
  // We explicitly DO include pieces that are already bound to a different
  // sticker but still have no pic1 — that would be weird but possible if
  // binding happened then was abandoned; safer to re-offer than to lock.
  let selected: Hit | null = bound;
  if (!selected) {
    const candidates: Hit[] = [];
    for (let pI = 0; pI < productionOrders.length; pI++) {
      const p = productionOrders[pI];
      for (let jI = 0; jI < p.jobCards.length; jI++) {
        const j = p.jobCards[jI];
        if (specKeyFor(j, p) !== targetKey) continue;
        if (!j.piecePics) continue;

        // Skip completed JCs entirely — the legacy seed data marks these
        // as COMPLETED/TRANSFERRED long before piecePics existed, so their
        // piecePics array is all-empty even though the JC is done. Without
        // this guard, FIFO would happily route a fresh scan into a closed
        // JC's empty slot, inflating progress on an already-finished PO.
        if (j.status === 'COMPLETED' || j.status === 'TRANSFERRED') continue;

        // Legacy-pic fallback: JCs that completed BEFORE the piecePics
        // rewrite may carry jc.pic1Id but have empty piecePics slots. If
        // the status isn't COMPLETED (caught above) but the JC nonetheless
        // has a legacy pic1 assignee, mirror that into slot 1 so FIFO
        // doesn't re-offer the first piece.
        if (j.pic1Id && j.piecePics[0] && !j.piecePics[0].pic1Id) {
          j.piecePics[0].pic1Id = j.pic1Id;
          j.piecePics[0].pic1Name = j.pic1Name || '';
        }
        if (j.pic2Id && j.piecePics[0] && !j.piecePics[0].pic2Id) {
          j.piecePics[0].pic2Id = j.pic2Id;
          j.piecePics[0].pic2Name = j.pic2Name || '';
        }

        for (const s of j.piecePics) {
          // Pieces waiting for pic1 are FIFO-eligible. Once pic1 is set, the
          // sticker is already bound (by whoever scanned first) so we don't
          // poach it — the bound-lookup above would've found it.
          if (s.pic1Id) continue;
          candidates.push({ po: p, poIdx: pI, jc: j, jcIdx: jI, slot: s });
        }
      }
    }
    if (candidates.length === 0) {
      // No pending same-spec work anywhere. Sticker is fresh but there's
      // nothing to bind it to — the scanned JC is fully done or has been
      // claimed by all slots already.
      return c.json(
        {
          success: false,
          error: `No pending work for ${targetKey}. All pieces in this spec are already in progress or complete.`,
          code: 'PIC_FULL',
        },
        400
      );
    }
    // FIFO priority:
    //   1. jc.dueDate (THE value shown in the Production Sheet "Due" column —
    //      what the user expects FIFO to honour). Per-JC because different
    //      departments on one PO have staggered internal deadlines.
    //   2. po.targetEndDate (overall PO deadline) — tiebreaker when two JCs
    //      have identical dueDates.
    //   3. po.createdAt — secondary tiebreaker; older PO wins.
    //   4. pieceNo — final stable-sort key so the same inputs always pick
    //      piece 1 over piece 2 and the result is reproducible.
    candidates.sort((a, b) => {
      const aJD = a.jc.dueDate || '9999-12-31';
      const bJD = b.jc.dueDate || '9999-12-31';
      if (aJD !== bJD) return aJD.localeCompare(bJD);
      const aTD = a.po.targetEndDate || '9999-12-31';
      const bTD = b.po.targetEndDate || '9999-12-31';
      if (aTD !== bTD) return aTD.localeCompare(bTD);
      const aC = a.po.createdAt || '';
      const bC = b.po.createdAt || '';
      if (aC !== bC) return aC.localeCompare(bC);
      return a.slot.pieceNo - b.slot.pieceNo;
    });
    selected = candidates[0];
    // Bind the sticker to the winning slot so all future scans of this same
    // sticker land on the same target (enables 2-worker share).
    selected.slot.boundStickerKey = stickerKey;
  }

  const target = selected;

  // ── Piece-level same-worker guard ───────────────────────────────────────
  if (target.slot.pic1Id === worker.id) {
    return c.json(
      {
        success: false,
        error: `You are already PIC1 on this piece (${worker.name}). A second PIC must be a different worker.`,
        code: 'ALREADY_PIC1',
        data: { jobCard: target.jc, assignedSlot: 1, workerName: worker.name, pieceNo: target.slot.pieceNo },
      },
      409
    );
  }
  if (target.slot.pic2Id === worker.id) {
    return c.json(
      {
        success: false,
        error: `You are already PIC2 on this piece (${worker.name}).`,
        code: 'ALREADY_PIC2',
        data: { jobCard: target.jc, assignedSlot: 2, workerName: worker.name, pieceNo: target.slot.pieceNo },
      },
      409
    );
  }

  // ── Piece-level 3-second debounce ───────────────────────────────────────
  if (target.slot.lastScanAt) {
    const elapsedMs = Date.now() - new Date(target.slot.lastScanAt).getTime();
    if (elapsedMs < 3000) {
      return c.json(
        {
          success: false,
          error: 'This piece was just scanned. Please wait a moment before scanning again.',
          code: 'DEBOUNCE',
        },
        429
      );
    }
  }

  // ── Piece-level PIC_FULL guard ──────────────────────────────────────────
  // Both slots filled by OTHER workers (same-worker case was caught above).
  if (target.slot.pic1Id && target.slot.pic2Id) {
    return c.json(
      {
        success: false,
        error: `This piece already has 2 PICs (${target.slot.pic1Name} / ${target.slot.pic2Name}). A third person cannot scan the same piece.`,
        code: 'PIC_FULL',
        data: { jobCard: target.jc, pieceNo: target.slot.pieceNo },
      },
      400
    );
  }

  // ── Fill the slot ───────────────────────────────────────────────────────
  const nowIso = new Date().toISOString();
  const today = nowIso.split('T')[0];
  let assignedSlot: 1 | 2;
  let jcJustCompleted = false;

  if (!target.slot.pic1Id) {
    target.slot.pic1Id = worker.id;
    target.slot.pic1Name = worker.name;
    target.slot.completedAt = nowIso;
    assignedSlot = 1;
  } else {
    target.slot.pic2Id = worker.id;
    target.slot.pic2Name = worker.name;
    assignedSlot = 2;
  }
  target.slot.lastScanAt = nowIso;

  // ── JC rollup: all pieces have pic1 → JC COMPLETED ─────────────────────
  const allPiecesDone =
    target.jc.piecePics && target.jc.piecePics.every((s) => !!s.pic1Id);
  if (allPiecesDone && target.jc.status !== 'COMPLETED' && target.jc.status !== 'TRANSFERRED') {
    target.jc.status = 'COMPLETED';
    target.jc.completedDate = today;
    target.jc.overdue = 'COMPLETED';
    jcJustCompleted = true;
    applyWipInventoryChange(target.po, target.jc.departmentCode, 'COMPLETED');
  }

  // ── Legacy JC-level pic1/pic2 mirror (A-flow compat) ───────────────────
  // The production dashboards / efficiency reports still read jc.pic1Id.
  // Mirror from the FIRST piece that filled each slot so the old UIs stay
  // populated. This is an approximation when piecePics > 1 — the real per-
  // piece attribution lives in piecePics for aggregation.
  if (!target.jc.pic1Id && target.jc.piecePics) {
    const firstWithPic1 = target.jc.piecePics.find((s) => s.pic1Id);
    if (firstWithPic1) {
      target.jc.pic1Id = firstWithPic1.pic1Id;
      target.jc.pic1Name = firstWithPic1.pic1Name;
    }
  }
  if (!target.jc.pic2Id && target.jc.piecePics) {
    const firstWithPic2 = target.jc.piecePics.find((s) => s.pic2Id);
    if (firstWithPic2) {
      target.jc.pic2Id = firstWithPic2.pic2Id;
      target.jc.pic2Name = firstWithPic2.pic2Name;
    }
  }
  (target.jc as Record<string, unknown>).lastScanAt = nowIso;

  // ── Persist ─────────────────────────────────────────────────────────────
  target.po.jobCards[target.jcIdx] = target.jc;
  saveJobCardOverride(target.po.id, target.jc.id, {
    status: target.jc.status,
    completedDate: target.jc.completedDate,
    pic1Id: target.jc.pic1Id,
    pic1Name: target.jc.pic1Name,
    pic2Id: target.jc.pic2Id,
    pic2Name: target.jc.pic2Name,
    piecePics: target.jc.piecePics,
  });

  // ── PO progress / status rollup ─────────────────────────────────────────
  const completedCount = target.po.jobCards.filter(
    (jc) => jc.status === 'COMPLETED' || jc.status === 'TRANSFERRED'
  ).length;
  target.po.progress = Math.round((completedCount / target.po.jobCards.length) * 100);

  if (completedCount === target.po.jobCards.length) {
    target.po.status = 'COMPLETED';
    target.po.completedDate = today;

    // FIFO consume + labor + FGBatch (Phase 2b / 3a)
    postProductionOrderCompletion(target.po);

    if (target.po.salesOrderId) {
      const so = salesOrders.find((s) => s.id === target.po.salesOrderId);
      if (so) {
        const siblingPOs = productionOrders.filter(
          (po) => po.salesOrderId === so.id
        );
        const allComplete =
          siblingPOs.length > 0 &&
          siblingPOs.every((po) => po.status === 'COMPLETED');
        if (allComplete && so.status !== 'READY_TO_SHIP') {
          so.status = 'READY_TO_SHIP';
          so.updatedAt = nowIso;
        }
      }
    }
  } else if (completedCount > 0) {
    target.po.status = 'IN_PROGRESS';
  }

  const activeDept = target.po.jobCards.find(
    (jc) => jc.status === 'IN_PROGRESS' || jc.status === 'WAITING'
  );
  target.po.currentDepartment = activeDept?.departmentCode || 'PACKING';

  savePOOverride(target.po.id, {
    status: target.po.status,
    progress: target.po.progress,
    completedDate: target.po.completedDate,
    currentDepartment: target.po.currentDepartment,
  });

  target.po.updatedAt = nowIso;
  productionOrders[target.poIdx] = target.po;
  cascadeUpholsteryToSO(target.po.id);

  const redirected = target.po.id !== scannedPo.id || target.jc.id !== scannedJc.id;

  return c.json({
    success: true,
    data: {
      jobCard: target.jc,
      assignedSlot,
      workerName: worker.name,
      pieceNo: target.slot.pieceNo,
      pieceCompletedAt: target.slot.completedAt,
      jcJustCompleted,
      // Diagnostic fields (additive — A-shape consumers ignore these)
      fifoRedirected: redirected,
      scannedPoId: scannedPo.id,
      scannedPoNo: scannedPo.poNo,
      assignedPoId: target.po.id,
      assignedPoNo: target.po.poNo,
      specKey: targetKey,
      // The FIFO winner's jc.dueDate — that's the value the Production Sheet
      // shows in the "Due" column, so the worker can reconcile "why this PO
      // instead of the one I scanned?" at a glance. Fall back to PO-level
      // targetEndDate when the JC has no explicit due.
      fifoDueDate: target.jc.dueDate || target.po.targetEndDate,
      stickerKey,
    },
  });
});

// PATCH /api/production-orders/:id — alias for PUT
app.patch('/:id', async (c) => {
  // Re-dispatch to PUT handler
  const id = c.req.param('id');
  const idx = productionOrders.findIndex((o) => o.id === id);
  if (idx === -1) {
    return c.json({ success: false, error: 'Production order not found' }, 404);
  }

  // Clone the request context and call the same logic
  // For simplicity, we duplicate the PUT handler call
  const body = await c.req.json();
  const order = productionOrders[idx];

  if (body.jobCardId) {
    const jcIdx = order.jobCards.findIndex((jc) => jc.id === body.jobCardId);
    if (jcIdx === -1) {
      return c.json({ success: false, error: 'Job card not found' }, 404);
    }

    const jobCard = order.jobCards[jcIdx];

    if (body.status) {
      jobCard.status = body.status;
      const isDone = body.status === 'COMPLETED' || body.status === 'TRANSFERRED';
      if (isDone) {
        if (!jobCard.completedDate) {
          jobCard.completedDate = new Date().toISOString().split('T')[0];
        }
        jobCard.overdue = 'COMPLETED';
      } else {
        if (body.completedDate === undefined) {
          jobCard.completedDate = null;
        }
      }
      // Track WIP inventory changes
      applyWipInventoryChange(order, jobCard.departmentCode, body.status);
    }

    if (body.completedDate !== undefined) jobCard.completedDate = body.completedDate || null;
    if (body.pic1Id !== undefined) {
      jobCard.pic1Id = body.pic1Id;
      const worker1 = workers.find((w) => w.id === body.pic1Id);
      jobCard.pic1Name = worker1?.name || '';
    }
    if (body.pic2Id !== undefined) {
      jobCard.pic2Id = body.pic2Id;
      const worker2 = workers.find((w) => w.id === body.pic2Id);
      jobCard.pic2Name = worker2?.name || '';
    }
    if (body.actualMinutes !== undefined) jobCard.actualMinutes = body.actualMinutes;
    if (body.dueDate !== undefined) jobCard.dueDate = body.dueDate;
    if (body.rackingNumber !== undefined && body.jobCardId) {
      jobCard.rackingNumber = body.rackingNumber;
      order.rackingNumber = body.rackingNumber;
    }

    order.jobCards[jcIdx] = jobCard;

    const jcPatch: Record<string, unknown> = {};
    if (body.status !== undefined) jcPatch.status = jobCard.status;
    if (body.completedDate !== undefined || body.status !== undefined) jcPatch.completedDate = jobCard.completedDate;
    if (body.pic1Id !== undefined) { jcPatch.pic1Id = jobCard.pic1Id; jcPatch.pic1Name = jobCard.pic1Name; }
    if (body.pic2Id !== undefined) { jcPatch.pic2Id = jobCard.pic2Id; jcPatch.pic2Name = jobCard.pic2Name; }
    if (body.actualMinutes !== undefined) jcPatch.actualMinutes = jobCard.actualMinutes;
    if (body.dueDate !== undefined) jcPatch.dueDate = jobCard.dueDate;
    if (body.rackingNumber !== undefined) jcPatch.rackingNumber = jobCard.rackingNumber;
    if (Object.keys(jcPatch).length > 0) saveJobCardOverride(order.id, jobCard.id, jcPatch);

    const completedCount = order.jobCards.filter(
      (jc) => jc.status === 'COMPLETED' || jc.status === 'TRANSFERRED'
    ).length;
    order.progress = Math.round((completedCount / order.jobCards.length) * 100);

    if (completedCount === order.jobCards.length) {
      order.status = 'COMPLETED';
      order.completedDate = new Date().toISOString().split('T')[0];

      // FIFO consume + labor + FGBatch (Phase 2b / 3a)
      postProductionOrderCompletion(order);

      if (order.salesOrderId) {
        const so = salesOrders.find((s) => s.id === order.salesOrderId);
        if (so) {
          const siblingPOs = productionOrders.filter((po) => po.salesOrderId === so.id);
          const allComplete = siblingPOs.length > 0 && siblingPOs.every((po) => po.status === 'COMPLETED');
          if (allComplete && so.status !== 'READY_TO_SHIP') {
            so.status = 'READY_TO_SHIP';
            so.updatedAt = new Date().toISOString();
          }
        }
      }
    } else {
      order.status = 'IN_PROGRESS';
      order.completedDate = null;
    }

    const activeDept = order.jobCards.find((jc) => jc.status === 'IN_PROGRESS' || jc.status === 'WAITING');
    order.currentDepartment = activeDept?.departmentCode || 'PACKING';
  }

  if (body.targetEndDate !== undefined) order.targetEndDate = body.targetEndDate;
  if (body.rackingNumber !== undefined) order.rackingNumber = body.rackingNumber;
  if (body.stockedIn !== undefined) order.stockedIn = body.stockedIn;

  const poPatch: Record<string, unknown> = {};
  if (body.targetEndDate !== undefined) poPatch.targetEndDate = order.targetEndDate;
  if (body.rackingNumber !== undefined) poPatch.rackingNumber = order.rackingNumber;
  if (body.stockedIn !== undefined) poPatch.stockedIn = order.stockedIn;
  if (body.jobCardId) {
    poPatch.status = order.status;
    poPatch.progress = order.progress;
    poPatch.completedDate = order.completedDate;
    poPatch.currentDepartment = order.currentDepartment;
  }
  if (Object.keys(poPatch).length > 0) savePOOverride(order.id, poPatch);

  order.updatedAt = new Date().toISOString();
  productionOrders[idx] = order;
  cascadeUpholsteryToSO(order.id);

  return c.json({ success: true, data: order });
});

export default app;
