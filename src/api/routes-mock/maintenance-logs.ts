import { Hono } from 'hono';
import { maintenanceLogs } from '../../lib/mock-data';

const app = new Hono();

// GET /api/maintenance-logs
app.get('/', (c) => c.json({ success: true, data: maintenanceLogs, total: maintenanceLogs.length }));

export default app;
