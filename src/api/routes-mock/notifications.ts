import { Hono } from 'hono';
import { notifications } from '../../lib/mock-data';

const app = new Hono();

// GET /api/notifications?type=...&isRead=true
app.get('/', (c) => {
  const type = c.req.query('type');
  const isRead = c.req.query('isRead');

  let filtered = [...notifications];
  if (type) filtered = filtered.filter((n) => n.type === type);
  if (isRead !== undefined && isRead !== null && isRead !== '') {
    const readBool = isRead === 'true';
    filtered = filtered.filter((n) => n.isRead === readBool);
  }

  filtered.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return c.json(filtered);
});

// PUT /api/notifications - mark as read
app.put('/', async (c) => {
  const body = await c.req.json();
  const { ids } = body as { ids: string[] };

  if (!ids || !Array.isArray(ids)) {
    return c.json({ error: 'ids must be an array of notification IDs' }, 400);
  }

  let updated = 0;
  for (const notif of notifications) {
    if (ids.includes(notif.id)) {
      notif.isRead = true;
      updated++;
    }
  }

  return c.json({ updated });
});

export default app;
