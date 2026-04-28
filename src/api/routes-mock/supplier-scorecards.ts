import { Hono } from 'hono';
import { supplierScorecards } from '../../lib/mock-data';

const app = new Hono();

// GET /api/supplier-scorecards?supplierId=...
app.get('/', (c) => {
  const supplierId = c.req.query('supplierId');

  if (supplierId) {
    const card = supplierScorecards.find((s) => s.supplierId === supplierId);
    if (!card) return c.json({ error: 'Scorecard not found' }, 404);
    return c.json({ success: true, data: card });
  }

  return c.json({ success: true, data: supplierScorecards });
});

export default app;
