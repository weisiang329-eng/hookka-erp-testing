import { Hono } from 'hono';
import { threePLProviders, generateId } from '../../lib/mock-data';
import type { ThreePLProvider } from '../../lib/mock-data';

const app = new Hono();

app.get('/', (c) => {
  return c.json({ success: true, data: threePLProviders, total: threePLProviders.length });
});

app.post('/', async (c) => {
  const body = await c.req.json();
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (!name || !phone) {
    return c.json({ success: false, error: 'Name and phone are required' }, 400);
  }
  const now = new Date().toISOString();
  const status: ThreePLProvider['status'] =
    body.status === 'INACTIVE' || body.status === 'ON_LEAVE' ? body.status : 'ACTIVE';
  const newProvider: ThreePLProvider = {
    id: generateId(), name, phone,
    contactPerson: typeof body.contactPerson === 'string' ? body.contactPerson.trim() : '',
    vehicleNo: typeof body.vehicleNo === 'string' ? body.vehicleNo.trim() : '',
    vehicleType: typeof body.vehicleType === 'string' ? body.vehicleType.trim() : '',
    capacityM3: Number(body.capacityM3) || 0,
    ratePerTripSen: Number(body.ratePerTripSen) || 30000,
    ratePerExtraDropSen: Number(body.ratePerExtraDropSen) || 5000,
    status,
    remarks: typeof body.remarks === 'string' ? body.remarks : '',
    createdAt: now, updatedAt: now,
  };
  threePLProviders.unshift(newProvider);
  return c.json({ success: true, data: newProvider }, 201);
});

app.get('/:id', (c) => {
  const id = c.req.param('id');
  const provider = threePLProviders.find((d) => d.id === id);
  if (!provider) return c.json({ success: false, error: '3PL provider not found' }, 404);
  return c.json({ success: true, data: provider });
});

app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = threePLProviders.findIndex((d) => d.id === id);
  if (idx === -1) return c.json({ success: false, error: '3PL provider not found' }, 404);
  const body = await c.req.json();
  const current = threePLProviders[idx];
  const allowedStatus: ThreePLProvider['status'][] = ['ACTIVE', 'INACTIVE', 'ON_LEAVE'];
  const nextStatus: ThreePLProvider['status'] =
    typeof body.status === 'string' && allowedStatus.includes(body.status as ThreePLProvider['status'])
      ? (body.status as ThreePLProvider['status']) : current.status;
  const updated: ThreePLProvider = {
    ...current,
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : current.name,
    phone: typeof body.phone === 'string' && body.phone.trim() ? body.phone.trim() : current.phone,
    contactPerson: body.contactPerson !== undefined ? String(body.contactPerson || '') : current.contactPerson,
    vehicleNo: body.vehicleNo !== undefined ? String(body.vehicleNo || '') : current.vehicleNo,
    vehicleType: body.vehicleType !== undefined ? String(body.vehicleType || '') : current.vehicleType,
    capacityM3: body.capacityM3 !== undefined ? Number(body.capacityM3) || 0 : current.capacityM3,
    ratePerTripSen: body.ratePerTripSen !== undefined ? Number(body.ratePerTripSen) : current.ratePerTripSen,
    ratePerExtraDropSen: body.ratePerExtraDropSen !== undefined ? Number(body.ratePerExtraDropSen) : current.ratePerExtraDropSen,
    status: nextStatus,
    remarks: body.remarks !== undefined ? String(body.remarks || '') : current.remarks,
    updatedAt: new Date().toISOString(),
  };
  threePLProviders[idx] = updated;
  return c.json({ success: true, data: updated });
});

app.delete('/:id', (c) => {
  const id = c.req.param('id');
  const idx = threePLProviders.findIndex((d) => d.id === id);
  if (idx === -1) return c.json({ success: false, error: '3PL provider not found' }, 404);
  const [removed] = threePLProviders.splice(idx, 1);
  return c.json({ success: true, data: removed });
});

export default app;
