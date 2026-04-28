import { Hono } from 'hono';
import { fabricTrackings } from '../../lib/mock-data';

const app = new Hono();

// GET /api/fabric-tracking?category=B.M-FABR&shortageOnly=true
app.get('/', (c) => {
  const category = c.req.query('category');
  const shortageOnly = c.req.query('shortageOnly') === 'true';

  let data = [...fabricTrackings];
  if (category) data = data.filter((f) => f.fabricCategory === category);
  if (shortageOnly) data = data.filter((f) => f.shortage < 0);

  return c.json({ success: true, data });
});

// PUT /api/fabric-tracking/:id
app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = fabricTrackings.findIndex((f) => f.id === id);
  if (idx === -1) {
    return c.json({ success: false, error: 'Fabric tracking entry not found' }, 404);
  }

  const body = await c.req.json();
  const fabric = fabricTrackings[idx];

  if (body.priceTier !== undefined) {
    if (body.priceTier === 'PRICE_1' || body.priceTier === 'PRICE_2') {
      fabric.priceTier = body.priceTier;
    }
  }
  if (body.price !== undefined) fabric.price = Number(body.price);
  if (body.soh !== undefined) fabric.soh = Number(body.soh);
  if (body.reorderPoint !== undefined) fabric.reorderPoint = Number(body.reorderPoint);

  fabricTrackings[idx] = fabric;

  return c.json({ success: true, data: fabric });
});

export default app;
