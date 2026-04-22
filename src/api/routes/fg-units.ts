// FG Unit Tracking API (Part A)
// ---------------------------------------------------------------
// One FGUnit row = one physical box (a specific piece of a specific unit
// inside a PO). Stickers are printed per FGUnit, not per PO. This route
// handles listing, generating (per PO) and status transitions driven by
// QR scans from the packing / loading / delivery / returns flows.

import { Hono } from 'hono';
import {
  fgUnits,
  productionOrders,
  salesOrders,
  products,
  workers,
  generateFGUnitsForPO,
} from '../../lib/mock-data';
import type { FGUnit, FGUnitStatus } from '../../lib/mock-data';

const app = new Hono();

// GET /api/fg-units?poId=&soId=&status=&serial=
app.get('/', (c) => {
  const poId = c.req.query('poId');
  const soId = c.req.query('soId');
  const status = c.req.query('status') as FGUnitStatus | undefined;
  const serial = c.req.query('serial');

  let out: FGUnit[] = fgUnits;
  if (poId) out = out.filter((u) => u.poId === poId);
  if (soId) out = out.filter((u) => u.soId === soId);
  if (status) out = out.filter((u) => u.status === status);
  if (serial) {
    out = out.filter(
      (u) => u.unitSerial === serial || u.shortCode === serial,
    );
  }
  return c.json({ success: true, data: out, total: out.length });
});

// GET /api/fg-units/:id
app.get('/:id', (c) => {
  const id = c.req.param('id');
  const unit = fgUnits.find((u) => u.id === id);
  if (!unit) return c.json({ success: false, error: 'Unit not found' }, 404);
  return c.json({ success: true, data: unit });
});

// POST /api/fg-units/generate/:poId
// Idempotent — if units already exist for this PO, returns them as-is.
app.post('/generate/:poId', (c) => {
  const poId = c.req.param('poId');
  const po = productionOrders.find((p) => p.id === poId);
  if (!po) return c.json({ success: false, error: 'Production order not found' }, 404);

  const existing = fgUnits.filter((u) => u.poId === poId);
  if (existing.length > 0) {
    return c.json({
      success: true,
      data: existing,
      total: existing.length,
      generated: false,
    });
  }

  const so = salesOrders.find((s) => s.id === po.salesOrderId);
  const product = products.find(
    (p) => p.id === po.productId || p.code === po.productCode,
  );
  // SO might be missing for old seed data — helper tolerates undefined.
  const units = generateFGUnitsForPO(po, so as Parameters<typeof generateFGUnitsForPO>[1], product);
  fgUnits.push(...units);
  return c.json({
    success: true,
    data: units,
    total: units.length,
    generated: true,
  }, 201);
});

// POST /api/fg-units/scan
// Body: { serial: string, action: "PACK"|"LOAD"|"DELIVER"|"RETURN", workerId?: string }
type ScanAction = 'PACK' | 'LOAD' | 'DELIVER' | 'RETURN';
app.post('/scan', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { serial, action, workerId } = body as {
    serial?: string;
    action?: ScanAction;
    workerId?: string;
  };

  if (!serial || !action) {
    return c.json({ success: false, error: 'serial and action are required' }, 400);
  }

  const unit = fgUnits.find(
    (u) => u.unitSerial === serial || u.shortCode === serial,
  );
  if (!unit) {
    return c.json({ success: false, error: `Unit not found for serial "${serial}"` }, 404);
  }

  const now = new Date().toISOString();

  switch (action) {
    case 'PACK': {
      if (unit.status !== 'PENDING') {
        return c.json(
          { success: false, error: `Cannot PACK — unit already ${unit.status}` },
          400,
        );
      }
      if (!workerId) {
        return c.json({ success: false, error: 'workerId required for PACK action' }, 400);
      }
      const worker = workers.find((w) => w.id === workerId);
      if (!worker) {
        return c.json({ success: false, error: 'Worker not found' }, 400);
      }
      unit.status = 'PACKED';
      unit.packerId = worker.id;
      unit.packerName = worker.name;
      unit.packedAt = now;
      break;
    }
    case 'LOAD': {
      if (unit.status !== 'PACKED') {
        return c.json(
          { success: false, error: `Cannot LOAD — unit is ${unit.status}, must be PACKED first` },
          400,
        );
      }
      unit.status = 'LOADED';
      unit.loadedAt = now;
      break;
    }
    case 'DELIVER': {
      if (unit.status !== 'LOADED') {
        return c.json(
          { success: false, error: `Cannot DELIVER — unit is ${unit.status}, must be LOADED first` },
          400,
        );
      }
      unit.status = 'DELIVERED';
      unit.deliveredAt = now;
      break;
    }
    case 'RETURN': {
      // Returns can come from any state (customer rejection, damage, etc.)
      unit.status = 'RETURNED';
      unit.returnedAt = now;
      break;
    }
    default:
      return c.json({ success: false, error: `Unknown action "${action}"` }, 400);
  }

  return c.json({ success: true, data: unit });
});

export default app;
