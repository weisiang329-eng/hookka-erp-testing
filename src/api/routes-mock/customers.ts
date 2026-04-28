import { Hono } from 'hono';
import { customers, generateId } from '../../lib/mock-data';

const app = new Hono();

app.get('/', (c) => c.json({ success: true, data: customers }));

app.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { code, name } = body;
    if (!code || !name) {
      return c.json({ success: false, error: 'code and name are required' }, 400);
    }
    const newCustomer = {
      id: generateId(),
      code: body.code,
      name: body.name,
      ssmNo: body.ssmNo ?? '',
      companyAddress: body.companyAddress ?? '',
      creditTerms: body.creditTerms ?? 'NET30',
      creditLimitSen: body.creditLimitSen ?? 0,
      outstandingSen: body.outstandingSen ?? 0,
      isActive: body.isActive ?? true,
      contactName: body.contactName ?? '',
      phone: body.phone ?? '',
      email: body.email ?? '',
      deliveryHubs: body.deliveryHubs ?? [],
    };
    customers.push(newCustomer);
    return c.json({ success: true, data: newCustomer }, 201);
  } catch {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }
});

app.get('/:id', (c) => {
  const id = c.req.param('id');
  const idx = customers.findIndex((cu) => cu.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Customer not found' }, 404);
  return c.json({ success: true, data: customers[idx] });
});

app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = customers.findIndex((cu) => cu.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Customer not found' }, 404);
  try {
    const body = await c.req.json();
    const existing = customers[idx];
    const updated = {
      ...existing,
      code: body.code ?? existing.code,
      name: body.name ?? existing.name,
      ssmNo: body.ssmNo ?? existing.ssmNo,
      companyAddress: body.companyAddress ?? existing.companyAddress,
      creditTerms: body.creditTerms ?? existing.creditTerms,
      creditLimitSen: body.creditLimitSen ?? existing.creditLimitSen,
      outstandingSen: body.outstandingSen ?? existing.outstandingSen,
      isActive: body.isActive ?? existing.isActive,
      contactName: body.contactName ?? existing.contactName,
      phone: body.phone ?? existing.phone,
      email: body.email ?? existing.email,
      deliveryHubs: body.deliveryHubs ?? existing.deliveryHubs,
    };
    customers[idx] = updated;
    return c.json({ success: true, data: updated });
  } catch {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }
});

app.delete('/:id', (c) => {
  const id = c.req.param('id');
  const idx = customers.findIndex((cu) => cu.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Customer not found' }, 404);
  const removed = customers.splice(idx, 1)[0];
  return c.json({ success: true, data: removed });
});

export default app;
