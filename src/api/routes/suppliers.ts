import { Hono } from 'hono';
import { suppliers, generateId } from '../../lib/mock-data';

const app = new Hono();

// GET /api/suppliers
app.get('/', (c) => c.json({ success: true, data: suppliers }));

// POST /api/suppliers
app.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { code, name } = body;
    if (!code || !name) {
      return c.json({ success: false, error: 'code and name are required' }, 400);
    }

    const newSupplier = {
      id: generateId(),
      code: body.code,
      name: body.name,
      contactPerson: body.contactPerson ?? '',
      phone: body.phone ?? '',
      email: body.email ?? '',
      address: body.address ?? '',
      state: body.state ?? '',
      paymentTerms: body.paymentTerms ?? 'NET30',
      status: body.status ?? 'ACTIVE',
      rating: body.rating ?? 3,
      materials: body.materials ?? [],
    };

    suppliers.push(newSupplier);
    return c.json({ success: true, data: newSupplier }, 201);
  } catch {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }
});

// GET /api/suppliers/:id
app.get('/:id', (c) => {
  const id = c.req.param('id');
  const supplier = suppliers.find((s) => s.id === id);
  if (!supplier) return c.json({ success: false, error: 'Supplier not found' }, 404);
  return c.json({ success: true, data: supplier });
});

// PUT /api/suppliers/:id
app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = suppliers.findIndex((s) => s.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Supplier not found' }, 404);

  try {
    const body = await c.req.json();
    const existing = suppliers[idx];
    const updated = {
      ...existing,
      code: body.code ?? existing.code,
      name: body.name ?? existing.name,
      contactPerson: body.contactPerson ?? existing.contactPerson,
      phone: body.phone ?? existing.phone,
      email: body.email ?? existing.email,
      address: body.address ?? existing.address,
      state: body.state ?? existing.state,
      paymentTerms: body.paymentTerms ?? existing.paymentTerms,
      status: body.status ?? existing.status,
      rating: body.rating ?? existing.rating,
      materials: body.materials ?? existing.materials,
    };
    suppliers[idx] = updated;
    return c.json({ success: true, data: updated });
  } catch {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }
});

// DELETE /api/suppliers/:id
app.delete('/:id', (c) => {
  const id = c.req.param('id');
  const idx = suppliers.findIndex((s) => s.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Supplier not found' }, 404);
  const removed = suppliers.splice(idx, 1)[0];
  return c.json({ success: true, data: removed });
});

export default app;
