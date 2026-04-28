import { Hono } from 'hono';
import { monthlyStockValues, stockAccounts, generateId } from '../../lib/mock-data';
import type { MonthlyStockValue } from '../../lib/mock-data';

const app = new Hono();

// GET /api/stock-value?period=2026-04
app.get('/', (c) => {
  const period = c.req.query('period');
  let data = monthlyStockValues;
  if (period) data = data.filter((v) => v.period === period);
  return c.json({ success: true, data });
});

// POST /api/stock-value
app.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { period } = body;

    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      return c.json({ success: false, error: 'Valid period (YYYY-MM) is required' }, 400);
    }

    const existing = monthlyStockValues.filter((v) => v.period === period);
    if (existing.length > 0) {
      return c.json({ success: false, error: 'Entries already exist for this period' }, 409);
    }

    const [year, month] = period.split('-').map(Number);
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;
    const prevPeriod = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
    const prevEntries = monthlyStockValues.filter((v) => v.period === prevPeriod);

    const newEntries: MonthlyStockValue[] = stockAccounts.map((acct) => {
      const prev = prevEntries.find((e) => e.accountCode === acct.code);
      const openingValue = prev ? prev.closingValue : 0;

      return {
        id: generateId(),
        period,
        accountCode: acct.code,
        accountDescription: acct.description,
        openingValue,
        purchasesValue: 0,
        consumptionValue: 0,
        closingValue: openingValue,
        physicalCountValue: null,
        variancePercent: null,
        status: 'DRAFT',
        postedDate: null,
        postedBy: null,
      };
    });

    monthlyStockValues.push(...newEntries);
    return c.json({ success: true, data: newEntries }, 201);
  } catch {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }
});

// GET /api/stock-value/:id
app.get('/:id', (c) => {
  const id = c.req.param('id');
  const entry = monthlyStockValues.find((v) => v.id === id);
  if (!entry) return c.json({ success: false, error: 'Stock value entry not found' }, 404);
  return c.json({ success: true, data: entry });
});

// PUT /api/stock-value/:id
app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = monthlyStockValues.findIndex((v) => v.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Stock value entry not found' }, 404);

  try {
    const body = await c.req.json();
    const existing = monthlyStockValues[idx];

    const updated = {
      ...existing,
      purchasesValue: body.purchasesValue ?? existing.purchasesValue,
      consumptionValue: body.consumptionValue ?? existing.consumptionValue,
      closingValue: body.closingValue ?? existing.closingValue,
      physicalCountValue: body.physicalCountValue !== undefined ? body.physicalCountValue : existing.physicalCountValue,
      variancePercent: body.variancePercent !== undefined ? body.variancePercent : existing.variancePercent,
      status: body.status ?? existing.status,
      postedDate: body.postedDate !== undefined ? body.postedDate : existing.postedDate,
      postedBy: body.postedBy !== undefined ? body.postedBy : existing.postedBy,
    };

    if (body.purchasesValue !== undefined || body.consumptionValue !== undefined) {
      updated.closingValue = updated.openingValue + updated.purchasesValue - updated.consumptionValue;
    }

    if (updated.physicalCountValue !== null && updated.closingValue !== 0) {
      updated.variancePercent = Math.round(
        ((updated.physicalCountValue - updated.closingValue) / updated.closingValue) * 10000
      ) / 100;
    }

    monthlyStockValues[idx] = updated;
    return c.json({ success: true, data: updated });
  } catch {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }
});

export default app;
