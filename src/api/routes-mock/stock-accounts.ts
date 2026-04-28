import { Hono } from 'hono';
import { stockAccounts } from '../../lib/mock-data';

const app = new Hono();

// GET /api/stock-accounts
app.get('/', (c) => c.json({ success: true, data: stockAccounts }));

export default app;
