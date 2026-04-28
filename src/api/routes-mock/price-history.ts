import { Hono } from 'hono';
import { priceHistories, generateId } from '../../lib/mock-data';
import type { PriceHistory } from '../../lib/mock-data';

const app = new Hono();

// GET /api/price-history?materialCode=...&supplierId=...
app.get('/', (c) => {
  const materialCode = c.req.query('materialCode');
  const supplierId = c.req.query('supplierId');

  let results = [...priceHistories];
  if (materialCode) results = results.filter((h) => h.materialCode === materialCode);
  if (supplierId) results = results.filter((h) => h.supplierId === supplierId);

  return c.json({ success: true, data: results });
});

// POST /api/price-history
app.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { bindingId, supplierId, materialCode, oldPrice, newPrice } = body;
    if (!bindingId || !supplierId || !materialCode || oldPrice == null || newPrice == null) {
      return c.json(
        { error: 'bindingId, supplierId, materialCode, oldPrice, and newPrice are required' },
        400
      );
    }

    const entry: PriceHistory = {
      id: generateId(),
      bindingId: body.bindingId,
      supplierId: body.supplierId,
      materialCode: body.materialCode,
      oldPrice: body.oldPrice,
      newPrice: body.newPrice,
      currency: body.currency ?? 'MYR',
      changedDate: body.changedDate ?? new Date().toISOString().slice(0, 10),
      changedBy: body.changedBy ?? 'System',
      reason: body.reason ?? '',
      approvalStatus: body.approvalStatus ?? 'PENDING',
    };

    priceHistories.push(entry);
    return c.json({ success: true, data: entry }, 201);
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }
});

export default app;
