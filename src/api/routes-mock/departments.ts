import { Hono } from 'hono';
import { departments } from '../../lib/mock-data';

const app = new Hono();

// GET /api/departments
app.get('/', (c) => c.json({ success: true, data: departments }));

export default app;
