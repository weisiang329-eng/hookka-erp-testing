import { Hono } from 'hono';
import { threeWayMatches, grns, purchaseOrders, generateId } from '../../lib/mock-data';

const app = new Hono();

// GET /api/three-way-match
app.get('/', (c) => c.json(threeWayMatches));

// POST /api/three-way-match
app.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { grnId, invoiceId, invoiceNumber, invoiceTotal, invoiceItems } = body;

    if (!grnId) return c.json({ error: 'grnId is required' }, 400);

    const grn = grns.find((g) => g.id === grnId);
    if (!grn) return c.json({ error: 'GRN not found' }, 404);

    const po = purchaseOrders.find((p) => p.id === grn.poId);
    if (!po) return c.json({ error: 'Related PO not found' }, 404);

    const TOLERANCE = 0.02;

    const matchItems = grn.items.map((gi) => {
      const poItem = po.items[gi.poItemIndex];
      const invItem = invoiceItems?.find(
        (ii: { materialCode: string }) => ii.materialCode === gi.materialCode
      );

      const poQty = poItem?.quantity ?? 0;
      const grnQty = gi.acceptedQty;
      const invoiceQty = invItem?.quantity ?? null;
      const poPrice = poItem?.unitPriceSen ?? 0;
      const grnPrice = gi.unitPrice;
      const invPrice = invItem?.unitPrice ?? null;

      const qtyMatch = invoiceQty !== null
        ? poQty === grnQty && grnQty === invoiceQty
        : poQty === grnQty;
      const priceMatch = invoiceQty !== null
        ? poPrice === grnPrice && grnPrice === (invPrice ?? 0)
        : poPrice === grnPrice;

      return {
        materialCode: gi.materialCode,
        poQty, grnQty, invoiceQty,
        poPrice, grnPrice, invoicePrice: invPrice,
        matched: qtyMatch && priceMatch,
      };
    });

    const poTotal = po.totalSen;
    const grnTotal = grn.totalAmount;
    const invTotal = invoiceTotal ?? null;

    let variance: number;
    if (invTotal !== null) {
      const poGrnDiff = Math.abs(poTotal - grnTotal);
      const poInvDiff = Math.abs(poTotal - (invTotal as number));
      const grnInvDiff = Math.abs(grnTotal - (invTotal as number));
      variance = Math.max(poGrnDiff, poInvDiff, grnInvDiff);
    } else {
      variance = Math.abs(poTotal - grnTotal);
    }

    const variancePercent = poTotal > 0 ? (variance / poTotal) * 100 : 0;
    const withinTolerance = variancePercent <= TOLERANCE * 100;

    const allMatched = matchItems.every((i) => i.matched);
    let matchStatus: 'FULL_MATCH' | 'PARTIAL_MATCH' | 'MISMATCH' | 'PENDING_INVOICE';

    if (!invoiceId) {
      matchStatus = 'PENDING_INVOICE';
    } else if (allMatched && withinTolerance) {
      matchStatus = 'FULL_MATCH';
    } else if (variancePercent <= 10) {
      matchStatus = 'PARTIAL_MATCH';
    } else {
      matchStatus = 'MISMATCH';
    }

    const newMatch = {
      id: generateId(),
      poId: po.id,
      poNumber: po.poNo,
      grnId: grn.id,
      grnNumber: grn.grnNumber,
      invoiceId: invoiceId ?? null,
      invoiceNumber: invoiceNumber ?? null,
      supplierId: grn.supplierId,
      supplierName: grn.supplierName,
      matchStatus,
      poTotal,
      grnTotal,
      invoiceTotal: invTotal,
      variance,
      variancePercent: Math.round(variancePercent * 100) / 100,
      withinTolerance,
      items: matchItems,
    };

    threeWayMatches.push(newMatch);
    return c.json(newMatch, 201);
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }
});

export default app;
