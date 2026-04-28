import { Hono } from 'hono';
import { historicalSales } from '../../lib/mock-data';

const app = new Hono();

// GET /api/historical-sales?productId=xxx&from=2025-05&to=2026-04
app.get('/', (c) => {
  const productId = c.req.query('productId');
  const from = c.req.query('from');
  const to = c.req.query('to');

  let result = [...historicalSales];
  if (productId) result = result.filter((s) => s.productId === productId);
  if (from) result = result.filter((s) => s.period >= from);
  if (to) result = result.filter((s) => s.period <= to);

  return c.json(result);
});

export default app;
