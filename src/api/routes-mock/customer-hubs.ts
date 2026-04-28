import { Hono } from 'hono';
import { customerHubs } from '../../lib/mock-data';

const app = new Hono();

// GET /api/customer-hubs?parentId=xxx
app.get('/', (c) => {
  const parentId = c.req.query('parentId');
  if (parentId) {
    const filtered = customerHubs.filter((h) => h.parentId === parentId);
    return c.json({ success: true, data: filtered });
  }
  return c.json({ success: true, data: customerHubs });
});

export default app;
