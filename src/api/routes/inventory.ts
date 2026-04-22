import { Hono } from 'hono';
import { products, rawMaterials, wipItems, generateId } from '../../lib/mock-data';

const app = new Hono();

function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

app.get('/', (c) => {
  const finishedProducts = products.map((p, i) => ({
    ...p, stockQty: Math.floor(seededRandom(i + 1) * 51),
  }));
  return c.json({ success: true, data: { finishedProducts, wipItems, rawMaterials } });
});

app.post('/raw-materials', async (c) => {
  try {
    const body = await c.req.json();
    const { itemCode, description, baseUOM } = body;
    if (!itemCode || !description) {
      return c.json({ success: false, error: 'itemCode and description are required' }, 400);
    }
    // Check for duplicate
    const exists = rawMaterials.find((r) => r.itemCode === itemCode);
    if (exists) {
      return c.json({ success: false, error: `Raw material ${itemCode} already exists` }, 400);
    }
    const newRM = {
      id: generateId(),
      itemCode,
      description,
      baseUOM: baseUOM || 'PCS',
      itemGroup: body.itemGroup || 'General',
      isActive: body.isActive ?? true,
      balanceQty: body.balanceQty || 0,
    };
    rawMaterials.push(newRM);
    return c.json({ success: true, data: newRM }, 201);
  } catch {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }
});

export default app;
