import { Hono } from 'hono';
import { purchaseOrders, generateId, getNextPONo } from '../../lib/mock-data';

const app = new Hono();

app.get('/', (c) => c.json({ success: true, data: purchaseOrders }));

app.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { supplierId, supplierName, items } = body;
    if (!supplierId || !supplierName || !items || items.length === 0) {
      return c.json({ success: false, error: 'supplierId, supplierName, and items are required' }, 400);
    }
    const poItems = items.map((item: Record<string, unknown>) => ({
      id: generateId(), materialCategory: item.materialCategory ?? '',
      materialName: item.materialName ?? '', supplierSKU: item.supplierSKU ?? '',
      quantity: Number(item.quantity) || 0, unitPriceSen: Number(item.unitPriceSen) || 0,
      totalSen: (Number(item.quantity) || 0) * (Number(item.unitPriceSen) || 0),
      receivedQty: 0, unit: item.unit ?? 'pcs',
    }));
    const subtotalSen = poItems.reduce((sum: number, i: { totalSen: number }) => sum + i.totalSen, 0);
    const now = new Date().toISOString();
    const newPO = {
      id: generateId(), poNo: getNextPONo(), supplierId: body.supplierId,
      supplierName: body.supplierName, items: poItems, subtotalSen,
      totalSen: subtotalSen, status: body.status ?? 'DRAFT',
      orderDate: body.orderDate ?? now.split('T')[0], expectedDate: body.expectedDate ?? '',
      receivedDate: null, notes: body.notes ?? '', createdAt: now, updatedAt: now,
    };
    purchaseOrders.push(newPO);
    return c.json({ success: true, data: newPO }, 201);
  } catch { return c.json({ success: false, error: 'Invalid request body' }, 400); }
});

app.get('/:id', (c) => {
  const id = c.req.param('id');
  const idx = purchaseOrders.findIndex((po) => po.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Purchase order not found' }, 404);
  return c.json({ success: true, data: purchaseOrders[idx] });
});

app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = purchaseOrders.findIndex((po) => po.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Purchase order not found' }, 404);
  try {
    const body = await c.req.json();
    const existing = purchaseOrders[idx];
    const now = new Date().toISOString();
    const VALID_TRANSITIONS: Record<string, string[]> = {
      DRAFT: ['SUBMITTED', 'CANCELLED'], SUBMITTED: ['CONFIRMED', 'CANCELLED'],
      CONFIRMED: ['PARTIAL_RECEIVED', 'RECEIVED', 'CANCELLED'],
      PARTIAL_RECEIVED: ['RECEIVED', 'CANCELLED'], RECEIVED: [], CANCELLED: [],
    };
    if (body.status && body.status !== existing.status) {
      const allowed = VALID_TRANSITIONS[existing.status] || [];
      if (!allowed.includes(body.status)) {
        return c.json({ success: false, error: `Cannot transition from ${existing.status} to ${body.status}. Allowed: ${allowed.join(', ') || 'none'}` }, 400);
      }
    }
    const updated = {
      ...existing, supplierId: body.supplierId ?? existing.supplierId,
      supplierName: body.supplierName ?? existing.supplierName,
      items: body.items ?? existing.items, subtotalSen: body.subtotalSen ?? existing.subtotalSen,
      totalSen: body.totalSen ?? existing.totalSen, status: body.status ?? existing.status,
      orderDate: body.orderDate ?? existing.orderDate, expectedDate: body.expectedDate ?? existing.expectedDate,
      receivedDate: body.receivedDate !== undefined ? body.receivedDate : existing.receivedDate,
      notes: body.notes ?? existing.notes, updatedAt: now,
    };
    purchaseOrders[idx] = updated;
    return c.json({ success: true, data: updated });
  } catch { return c.json({ success: false, error: 'Invalid request body' }, 400); }
});

app.delete('/:id', (c) => {
  const id = c.req.param('id');
  const idx = purchaseOrders.findIndex((po) => po.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Purchase order not found' }, 404);
  const removed = purchaseOrders.splice(idx, 1)[0];
  return c.json({ success: true, data: removed });
});

export default app;
