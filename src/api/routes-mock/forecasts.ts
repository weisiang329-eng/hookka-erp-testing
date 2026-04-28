import { Hono } from 'hono';
import { forecastEntries, generateId } from '../../lib/mock-data';
import type { ForecastEntry } from '../../lib/mock-data';

const app = new Hono();

// GET /api/forecasts?productId=xxx&period=2026-05
app.get('/', (c) => {
  const productId = c.req.query('productId');
  const period = c.req.query('period');

  let result = [...forecastEntries];
  if (productId) result = result.filter((f) => f.productId === productId);
  if (period) result = result.filter((f) => f.period === period);

  return c.json(result);
});

// POST /api/forecasts
app.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { productId, productName, productCode, period, forecastQty, method, confidence } = body;

    if (!productId || !period || !forecastQty || !method) {
      return c.json({ error: 'productId, period, forecastQty, and method are required' }, 400);
    }

    const entry: ForecastEntry = {
      id: generateId(),
      productId,
      productName: productName || '',
      productCode: productCode || '',
      period,
      forecastQty,
      actualQty: null,
      method,
      confidence: confidence ?? 50,
      createdDate: new Date().toISOString().split('T')[0],
    };

    forecastEntries.push(entry);
    return c.json(entry, 201);
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }
});

export default app;
