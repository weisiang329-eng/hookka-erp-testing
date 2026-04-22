import { Hono } from 'hono';
import { productionLeadTimes, type LeadTimeCategory } from '../../lib/mock-data';

const app = new Hono();

// GET /api/production/leadtimes
app.get('/', (c) => c.json({ success: true, data: productionLeadTimes }));

// PUT /api/production/leadtimes
app.put('/', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return c.json({ success: false, error: 'Body must be an object' }, 400);
  }

  const categories: LeadTimeCategory[] = ['BEDFRAME', 'SOFA'];
  for (const cat of categories) {
    const incoming = (body as Record<string, unknown>)[cat];
    if (!incoming || typeof incoming !== 'object') continue;
    const next: Record<string, number> = {};
    for (const [deptCode, raw] of Object.entries(incoming as Record<string, unknown>)) {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) continue;
      next[deptCode] = Math.round(n);
    }
    const target = productionLeadTimes[cat];
    for (const k of Object.keys(target)) delete target[k];
    Object.assign(target, next);
  }

  return c.json({ success: true, data: productionLeadTimes });
});

export default app;
