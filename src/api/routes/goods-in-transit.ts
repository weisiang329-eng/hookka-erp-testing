import { Hono } from 'hono';
import { goodsInTransit, generateId } from '../../lib/mock-data';
import type { GoodsInTransit } from '../../lib/mock-data';

const app = new Hono();

// GET /api/goods-in-transit?status=...&supplierId=...
app.get('/', (c) => {
  const status = c.req.query('status');
  const supplierId = c.req.query('supplierId');

  let filtered = [...goodsInTransit];
  if (status) filtered = filtered.filter((g) => g.status === status);
  if (supplierId) filtered = filtered.filter((g) => g.supplierId === supplierId);

  return c.json({ success: true, data: filtered });
});

// POST /api/goods-in-transit
app.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { poNumber, supplierId, supplierName, shippingMethod, items } = body;
    if (!poNumber || !supplierId || !supplierName || !shippingMethod || !items || items.length === 0) {
      return c.json(
        { success: false, error: 'poNumber, supplierId, supplierName, shippingMethod, and items are required' },
        400
      );
    }

    const productCost = Number(body.productCost) || 0;
    const shippingCost = Number(body.shippingCost) || 0;
    const customsDuty = Number(body.customsDuty) || 0;

    const newEntry: GoodsInTransit = {
      id: generateId(),
      poId: body.poId ?? '',
      poNumber,
      supplierId,
      supplierName,
      shippingMethod,
      containerNumber: body.containerNumber ?? null,
      trackingNumber: body.trackingNumber ?? null,
      carrierName: body.carrierName ?? '',
      status: body.status ?? 'ORDERED',
      orderDate: body.orderDate ?? new Date().toISOString().split('T')[0],
      shippedDate: body.shippedDate ?? null,
      expectedArrival: body.expectedArrival ?? '',
      actualArrival: body.actualArrival ?? null,
      customsClearanceDate: body.customsClearanceDate ?? null,
      customsStatus: body.customsStatus ?? 'N/A',
      currency: body.currency ?? 'MYR',
      productCost,
      shippingCost,
      customsDuty,
      exchangeRate: body.exchangeRate ?? null,
      landedCost: body.landedCost ?? productCost + shippingCost + customsDuty,
      items: items.map((item: Record<string, unknown>) => ({
        materialCode: item.materialCode ?? '',
        materialName: item.materialName ?? '',
        quantity: Number(item.quantity) || 0,
        unitCost: Number(item.unitCost) || 0,
      })),
      notes: body.notes ?? '',
    };

    goodsInTransit.push(newEntry);
    return c.json({ success: true, data: newEntry }, 201);
  } catch {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }
});

// GET /api/goods-in-transit/:id
app.get('/:id', (c) => {
  const id = c.req.param('id');
  const entry = goodsInTransit.find((g) => g.id === id);
  if (!entry) return c.json({ success: false, error: 'Transit entry not found' }, 404);
  return c.json({ success: true, data: entry });
});

// PUT /api/goods-in-transit/:id
app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = goodsInTransit.findIndex((g) => g.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Transit entry not found' }, 404);

  try {
    const body = await c.req.json();
    const existing = goodsInTransit[idx];

    const updated = {
      ...existing,
      status: body.status ?? existing.status,
      shippedDate: body.shippedDate !== undefined ? body.shippedDate : existing.shippedDate,
      expectedArrival: body.expectedArrival ?? existing.expectedArrival,
      actualArrival: body.actualArrival !== undefined ? body.actualArrival : existing.actualArrival,
      customsClearanceDate: body.customsClearanceDate !== undefined ? body.customsClearanceDate : existing.customsClearanceDate,
      customsStatus: body.customsStatus ?? existing.customsStatus,
      containerNumber: body.containerNumber !== undefined ? body.containerNumber : existing.containerNumber,
      trackingNumber: body.trackingNumber !== undefined ? body.trackingNumber : existing.trackingNumber,
      carrierName: body.carrierName ?? existing.carrierName,
      shippingMethod: body.shippingMethod ?? existing.shippingMethod,
      productCost: body.productCost ?? existing.productCost,
      shippingCost: body.shippingCost ?? existing.shippingCost,
      customsDuty: body.customsDuty ?? existing.customsDuty,
      exchangeRate: body.exchangeRate !== undefined ? body.exchangeRate : existing.exchangeRate,
      landedCost: body.landedCost ?? existing.landedCost,
      notes: body.notes ?? existing.notes,
    };

    goodsInTransit[idx] = updated;
    return c.json({ success: true, data: updated });
  } catch {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }
});

// DELETE /api/goods-in-transit/:id
app.delete('/:id', (c) => {
  const id = c.req.param('id');
  const idx = goodsInTransit.findIndex((g) => g.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Transit entry not found' }, 404);
  const removed = goodsInTransit.splice(idx, 1)[0];
  return c.json({ success: true, data: removed });
});

export default app;
