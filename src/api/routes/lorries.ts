import { Hono } from 'hono';
import { lorries } from '../../lib/mock-data';

const app = new Hono();

// GET /api/lorries
app.get('/', (c) => c.json({ success: true, data: lorries, total: lorries.length }));

// PUT /api/lorries
app.put('/', async (c) => {
  const body = await c.req.json();
  const { id, status, driverName, driverContact } = body;

  const lorry = lorries.find((l) => l.id === id);
  if (!lorry) return c.json({ success: false, error: 'Lorry not found' }, 404);

  if (status) lorry.status = status;
  if (driverName !== undefined) lorry.driverName = driverName;
  if (driverContact !== undefined) lorry.driverContact = driverContact;

  return c.json({ success: true, data: lorry });
});

export default app;
