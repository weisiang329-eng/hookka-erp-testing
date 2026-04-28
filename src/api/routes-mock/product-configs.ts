import { Hono } from 'hono';
import { productDeptConfigs } from '../../lib/mock-data';

const app = new Hono();

// GET /api/product-configs
app.get('/', (c) => c.json({ success: true, data: productDeptConfigs }));

export default app;
