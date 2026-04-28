import { Hono } from 'hono';
import {
  grns,
  purchaseOrders,
  rawMaterials,
  rmBatches,
  costLedger,
  supplierMaterialBindings,
  generateId,
  getNextGRNNumber,
} from '../../lib/mock-data';
import type { GRNItem, GoodsReceiptNote, RawMaterial } from '../../types';
import { makeLedgerEntry } from '../../lib/costing';

const app = new Hono();

// ---------------------------------------------------------------------------
// GRN → RMBatch helpers
//
// When a GRN transitions from DRAFT → CONFIRMED/POSTED, each accepted line
// spawns:
//   • a new RMBatch (source: "GRN") with original/remaining = acceptedQty
//   • a RM_RECEIPT ledger entry (direction IN)
//   • an increment to RawMaterial.balanceQty (the pre-costing gap)
//
// Idempotency: we tag each batch with sourceRefId = grn.id. Re-running the
// same transition is a no-op because we short-circuit when batches already
// exist for the GRN.
// ---------------------------------------------------------------------------

const COMMITTED_STATUSES = new Set(['CONFIRMED', 'POSTED']);

/**
 * Resolve a GRN line to the underlying RawMaterial.
 *
 * Strategies, in order:
 *   1. Newer POs encode "itemCode - description" into materialName — try
 *      splitting on " - " and looking up by itemCode.
 *   2. Map through supplierMaterialBindings: grn.materialCode is the
 *      supplierSKU → binding.materialCode is the RM itemCode.
 *   3. Fall back to matching rawMaterials.description === grn.materialName.
 */
function resolveRmForGRNItem(item: GRNItem): RawMaterial | undefined {
  const name = item.materialName || '';
  const dashIdx = name.indexOf(' - ');
  if (dashIdx > 0) {
    const codeFragment = name.slice(0, dashIdx).trim();
    if (codeFragment) {
      const hit = rawMaterials.find((rm) => rm.itemCode === codeFragment);
      if (hit) return hit;
    }
  }

  if (item.materialCode) {
    const binding = supplierMaterialBindings.find(
      (b) => b.supplierSku === item.materialCode,
    );
    if (binding) {
      const hit = rawMaterials.find((rm) => rm.itemCode === binding.materialCode);
      if (hit) return hit;
    }
  }

  return rawMaterials.find((rm) => rm.description === name);
}

/**
 * Create RMBatches + RM_RECEIPT ledger entries for every GRN line that
 * has acceptedQty > 0 and resolves to a known RawMaterial. Also bumps
 * the RawMaterial.balanceQty so on-hand displays stay consistent.
 *
 * Returns a quick summary so the PUT handler can include it in its
 * response (useful for debugging and UI toast messages later).
 */
function postGRNToStock(grn: GoodsReceiptNote): {
  batchesCreated: number;
  ledgerEntries: number;
  unresolvedLines: { materialCode: string; materialName: string }[];
} {
  // Idempotency guard — if we already posted this GRN, do nothing.
  const already = rmBatches.some(
    (b) => b.source === 'GRN' && b.sourceRefId === grn.id,
  );
  if (already) {
    return { batchesCreated: 0, ledgerEntries: 0, unresolvedLines: [] };
  }

  const nowIso = new Date().toISOString();
  const receivedIso = grn.receiveDate
    ? new Date(grn.receiveDate).toISOString()
    : nowIso;

  let batchesCreated = 0;
  let ledgerEntries = 0;
  const unresolved: { materialCode: string; materialName: string }[] = [];

  grn.items.forEach((item, lineIdx) => {
    const qty = Number(item.acceptedQty) || 0;
    if (qty <= 0) return;

    const rm = resolveRmForGRNItem(item);
    if (!rm) {
      unresolved.push({
        materialCode: item.materialCode,
        materialName: item.materialName,
      });
      return;
    }

    const batchId = `rmb-grn-${grn.id}-${lineIdx + 1}`;
    rmBatches.push({
      id: batchId,
      rmId: rm.id,
      source: 'GRN',
      sourceRefId: grn.id,
      receivedDate: receivedIso,
      originalQty: qty,
      remainingQty: qty,
      unitCostSen: Number(item.unitPrice) || 0,
      createdAt: nowIso,
      notes: `GRN ${grn.grnNumber} line ${lineIdx + 1}`,
    });
    batchesCreated++;

    costLedger.push(
      makeLedgerEntry({
        date: receivedIso,
        type: 'RM_RECEIPT',
        itemType: 'RM',
        itemId: rm.id,
        batchId,
        qty,
        direction: 'IN',
        unitCostSen: Number(item.unitPrice) || 0,
        refType: 'GRN',
        refId: grn.id,
        notes: `Received via ${grn.grnNumber}`,
      }),
    );
    ledgerEntries++;

    // Update RawMaterial on-hand — this is the bookkeeping side of the
    // receipt. Our FIFO layer tracks lot-level qty/cost; balanceQty is the
    // rollup other pages still read from.
    rm.balanceQty = (rm.balanceQty || 0) + qty;
  });

  return { batchesCreated, ledgerEntries, unresolvedLines: unresolved };
}

app.get('/', (c) => {
  const poId = c.req.query('poId');
  const supplierId = c.req.query('supplierId');
  let result = [...grns];
  if (poId) result = result.filter((g) => g.poId === poId);
  if (supplierId) result = result.filter((g) => g.supplierId === supplierId);
  return c.json({ success: true, data: result });
});

app.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { poId, items, receivedBy, notes, qcStatus } = body;
    if (!poId || !items || items.length === 0) return c.json({ success: false, error: 'poId and items are required' }, 400);
    const po = purchaseOrders.find((p) => p.id === poId);
    if (!po) return c.json({ success: false, error: 'Purchase order not found' }, 404);
    for (const item of items) {
      const poItem = po.items[item.poItemIndex];
      if (poItem) {
        const tolerance = poItem.quantity * 1.1;
        if (item.receivedQty > tolerance) {
          return c.json({ success: false, error: `Over-receipt for ${poItem.materialName}: received ${item.receivedQty} exceeds 110% of ordered ${poItem.quantity}. Requires ADMIN approval.` }, 400);
        }
      }
    }
    const grnItems: GRNItem[] = items.map(
      (item: { poItemIndex: number; receivedQty: number; acceptedQty: number; rejectedQty: number; rejectionReason: string | null }) => {
        const poItem = po.items[item.poItemIndex];
        return {
          poItemIndex: item.poItemIndex, materialCode: poItem?.supplierSKU ?? '',
          materialName: poItem?.materialName ?? '', orderedQty: poItem?.quantity ?? 0,
          receivedQty: item.receivedQty, acceptedQty: item.acceptedQty,
          rejectedQty: item.rejectedQty, rejectionReason: item.rejectionReason || null,
          unitPrice: poItem?.unitPriceSen ?? 0,
        };
      }
    );
    const totalAmount = grnItems.reduce((sum, i) => sum + i.acceptedQty * i.unitPrice, 0);
    const newGRN = {
      id: generateId(), grnNumber: getNextGRNNumber(), poId: po.id, poNumber: po.poNo,
      supplierId: po.supplierId, supplierName: po.supplierName,
      receiveDate: body.receiveDate || new Date().toISOString().split('T')[0],
      receivedBy: receivedBy || '', items: grnItems, totalAmount,
      qcStatus: (qcStatus as 'PENDING' | 'PASSED' | 'PARTIAL' | 'FAILED') || 'PENDING',
      status: 'DRAFT' as const, notes: notes || '',
    };
    grns.push(newGRN);
    return c.json({ success: true, data: newGRN }, 201);
  } catch { return c.json({ success: false, error: 'Invalid request body' }, 400); }
});

app.get('/:id', (c) => {
  const id = c.req.param('id');
  const idx = grns.findIndex((g) => g.id === id);
  if (idx === -1) return c.json({ success: false, error: 'GRN not found' }, 404);
  return c.json({ success: true, data: grns[idx] });
});

app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = grns.findIndex((g) => g.id === id);
  if (idx === -1) return c.json({ success: false, error: 'GRN not found' }, 404);
  try {
    const body = await c.req.json();
    const prevStatus = grns[idx].status;
    if (body.qcStatus) grns[idx].qcStatus = body.qcStatus;
    if (body.status) grns[idx].status = body.status;
    if (body.notes !== undefined) grns[idx].notes = body.notes;
    if (body.receivedBy) grns[idx].receivedBy = body.receivedBy;
    if (body.items) {
      grns[idx].items = body.items;
      grns[idx].totalAmount = body.items.reduce(
        (sum: number, i: { acceptedQty: number; unitPrice: number }) => sum + i.acceptedQty * i.unitPrice, 0
      );
    }

    // Post to stock when transitioning into a committed status.
    let postSummary: ReturnType<typeof postGRNToStock> | undefined;
    const newStatus = grns[idx].status;
    if (
      newStatus !== prevStatus &&
      COMMITTED_STATUSES.has(newStatus) &&
      !COMMITTED_STATUSES.has(prevStatus)
    ) {
      postSummary = postGRNToStock(grns[idx]);
    }

    return c.json({ success: true, data: grns[idx], costing: postSummary });
  } catch { return c.json({ success: false, error: 'Invalid request body' }, 400); }
});

export default app;
