import { Hono } from 'hono';
import { fabrics } from '../../lib/mock-data';

const app = new Hono();

// GET /api/fabrics
app.get('/', (c) => c.json({ success: true, data: fabrics }));

export default app;
