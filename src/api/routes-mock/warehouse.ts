import { Hono } from 'hono';
import { rackLocations, stockMovements, computeRackStatus, generateId } from '../../lib/mock-data';
import type { RackItem, StockMovement } from '../../types';

const app = new Hono();

// GET /api/warehouse
app.get('/', (c) => {
  for (const loc of rackLocations) loc.status = computeRackStatus(loc.items, loc.reserved);
  const grouped: Record<string, typeof rackLocations> = {};
  for (const loc of rackLocations) grouped[loc.rack] = [loc];
  const total = rackLocations.length;
  const occupied = rackLocations.filter((l) => l.status === 'OCCUPIED').length;
  const empty = rackLocations.filter((l) => l.status === 'EMPTY').length;
  const reserved = rackLocations.filter((l) => l.status === 'RESERVED').length;
  return c.json({
    success: true, data: rackLocations, grouped,
    summary: { total, occupied, empty, reserved, occupancyRate: Math.round((occupied / total) * 100) },
  });
});

// POST /api/warehouse
app.post('/', async (c) => {
  const body = await c.req.json() as {
    rackLocationId: string;
    productionOrderId?: string;
    productCode: string;
    productName?: string;
    sizeLabel?: string;
    customerName?: string;
    notes?: string;
    qty?: number;
  };
  const { rackLocationId, productionOrderId, productCode, productName, sizeLabel, customerName, notes, qty } = body;
  const idx = rackLocations.findIndex((l) => l.id === rackLocationId);
  if (idx === -1) return c.json({ success: false, error: 'Rack location not found' }, 404);
  const loc = rackLocations[idx];
  if (!loc.items) loc.items = [];
  loc.items.push({
    productionOrderId: productionOrderId || '', productCode, productName,
    sizeLabel: sizeLabel || '', customerName: customerName || '',
    qty: qty ?? 1, stockedInDate: new Date().toISOString().split('T')[0],
    notes: notes || '',
  });
  loc.status = computeRackStatus(loc.items, loc.reserved);
  rackLocations[idx] = loc;
  return c.json({ success: true, data: loc });
});

// GET /api/warehouse/movements
app.get('/movements', (c) => {
  const type = c.req.query('type');
  const from = c.req.query('from');
  const to = c.req.query('to');
  let filtered = [...stockMovements];
  if (type) filtered = filtered.filter((m) => m.type === type);
  if (from) filtered = filtered.filter((m) => m.createdAt >= from);
  if (to) { const toEnd = to + 'T23:59:59Z'; filtered = filtered.filter((m) => m.createdAt <= toEnd); }
  filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return c.json({ success: true, data: filtered, total: filtered.length });
});

// POST /api/warehouse/movements
app.post('/movements', async (c) => {
  const body = await c.req.json() as {
    type?: StockMovement['type'];
    rackLocationId?: string;
    rackLabel?: string;
    productionOrderId?: string;
    productCode?: string;
    productName?: string;
    quantity?: number;
    reason?: string;
    performedBy?: string;
  };
  const { type, rackLocationId, rackLabel, productionOrderId, productCode, productName, quantity, reason, performedBy } = body;
  if (!type || !rackLocationId || !productCode || !productName) {
    return c.json({ success: false, error: 'Missing required fields' }, 400);
  }
  const movement: StockMovement = {
    id: generateId(), type, rackLocationId, rackLabel: rackLabel || rackLocationId,
    productionOrderId: productionOrderId || '', productCode, productName,
    quantity: quantity || 1, reason: reason || '', performedBy: performedBy || 'System',
    createdAt: new Date().toISOString(),
  };
  stockMovements.push(movement);
  return c.json({ success: true, data: movement });
});

// GET /api/warehouse/:id
app.get('/:id', (c) => {
  const id = c.req.param('id');
  const loc = rackLocations.find((l) => l.id === id);
  if (!loc) return c.json({ success: false, error: 'Rack location not found' }, 404);
  return c.json({ success: true, data: loc });
});

// PUT /api/warehouse/:id
app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = rackLocations.findIndex((l) => l.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Rack location not found' }, 404);
  const body = await c.req.json() as { items?: RackItem[]; reserved?: boolean };
  const loc = rackLocations[idx];
  if (Array.isArray(body.items)) loc.items = body.items;
  if (body.reserved !== undefined) loc.reserved = body.reserved;
  loc.status = computeRackStatus(loc.items, loc.reserved);
  rackLocations[idx] = loc;
  return c.json({ success: true, data: loc });
});

// DELETE /api/warehouse/:id
app.delete('/:id', (c) => {
  const id = c.req.param('id');
  const idx = rackLocations.findIndex((l) => l.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Rack location not found' }, 404);
  const url = new URL(c.req.url);
  const productCode = url.searchParams.get('productCode');
  const loc = rackLocations[idx];
  const previousItems = loc.items ? [...loc.items] : [];
  const previousData = { ...loc, items: previousItems };
  if (!loc.items) loc.items = [];
  if (productCode) {
    const itemIdx = loc.items.findIndex((it) => it.productCode === productCode);
    if (itemIdx !== -1) loc.items.splice(itemIdx, 1);
  } else {
    loc.items = [];
  }
  loc.status = computeRackStatus(loc.items, loc.reserved);
  rackLocations[idx] = loc;
  return c.json({ success: true, data: loc, previousData });
});

export default app;
