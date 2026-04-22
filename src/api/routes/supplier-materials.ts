import { Hono } from 'hono';
import { supplierMaterialBindings, generateId } from '../../lib/mock-data';
import type { SupplierMaterialBinding } from '../../lib/mock-data';

const app = new Hono();

app.get('/', (c) => {
  const supplierId = c.req.query('supplierId');
  const materialCode = c.req.query('materialCode');
  let results = [...supplierMaterialBindings];
  if (supplierId) results = results.filter((b) => b.supplierId === supplierId);
  if (materialCode) results = results.filter((b) => b.materialCode === materialCode);
  return c.json({ success: true, data: results });
});

app.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { supplierId, materialCode, materialName, supplierSku, unitPrice } = body;
    if (!supplierId || !materialCode || !materialName || !supplierSku || unitPrice == null) {
      return c.json({ success: false, error: 'supplierId, materialCode, materialName, supplierSku, and unitPrice are required' }, 400);
    }
    const newBinding: SupplierMaterialBinding = {
      id: generateId(), supplierId: body.supplierId, materialCode: body.materialCode,
      materialName: body.materialName, supplierSku: body.supplierSku, unitPrice: body.unitPrice,
      currency: body.currency ?? 'MYR', leadTimeDays: body.leadTimeDays ?? 7,
      paymentTerms: body.paymentTerms ?? 'NET30', moq: body.moq ?? 1,
      priceValidFrom: body.priceValidFrom ?? new Date().toISOString().slice(0, 10),
      priceValidTo: body.priceValidTo ?? '2026-12-31', isMainSupplier: body.isMainSupplier ?? false,
    };
    supplierMaterialBindings.push(newBinding);
    return c.json({ success: true, data: newBinding }, 201);
  } catch { return c.json({ success: false, error: 'Invalid request body' }, 400); }
});

app.get('/:id', (c) => {
  const id = c.req.param('id');
  const idx = supplierMaterialBindings.findIndex((b) => b.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Binding not found' }, 404);
  return c.json({ success: true, data: supplierMaterialBindings[idx] });
});

app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = supplierMaterialBindings.findIndex((b) => b.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Binding not found' }, 404);
  try {
    const body = await c.req.json();
    const existing = supplierMaterialBindings[idx];
    const updated = { ...existing, ...body, id: existing.id };
    supplierMaterialBindings[idx] = updated;
    return c.json({ success: true, data: updated });
  } catch { return c.json({ success: false, error: 'Invalid request body' }, 400); }
});

app.delete('/:id', (c) => {
  const id = c.req.param('id');
  const idx = supplierMaterialBindings.findIndex((b) => b.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Binding not found' }, 404);
  const removed = supplierMaterialBindings.splice(idx, 1)[0];
  return c.json({ success: true, data: removed });
});

export default app;
