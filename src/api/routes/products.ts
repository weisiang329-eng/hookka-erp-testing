import { Hono } from 'hono';
import { products, generateId } from '../../lib/mock-data';
import type { Product } from '../../lib/mock-data';

const app = new Hono();

app.get('/', (c) => {
  return c.json({ success: true, data: products.filter((p) => p.status === 'ACTIVE') });
});

app.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { code, name, category, description, baseModel, sizeCode, sizeLabel, subAssemblies, bomComponents, deptWorkingTimes, fabricUsage, unitM3, costPriceSen } = body;
    if (!code || !name || !category) {
      return c.json({ success: false, error: 'code, name, and category are required' }, 400);
    }
    if (products.find((p) => p.code === code)) {
      return c.json({ success: false, error: `Product code ${code} already exists` }, 400);
    }
    const totalMinutes = (deptWorkingTimes || []).reduce(
      (sum: number, d: { minutes: number }) => sum + (d.minutes || 0), 0
    );
    const newProduct: Product = {
      id: generateId(), code, name, category,
      description: description || '', baseModel: baseModel || code,
      sizeCode: sizeCode || '', sizeLabel: sizeLabel || '',
      fabricUsage: fabricUsage || 0, unitM3: unitM3 || 0,
      status: 'ACTIVE', costPriceSen: costPriceSen || 0,
      productionTimeMinutes: totalMinutes,
      subAssemblies: subAssemblies || [],
      bomComponents: (bomComponents || []).map(
        (comp: { materialCategory: string; materialName: string; qtyPerUnit: number; unit: string; wastePct: number }) => ({
          id: generateId(), materialCategory: comp.materialCategory,
          materialName: comp.materialName, qtyPerUnit: comp.qtyPerUnit || 0,
          unit: comp.unit || 'PCS', wastePct: comp.wastePct || 0,
        })
      ),
      deptWorkingTimes: deptWorkingTimes || [],
    };
    products.push(newProduct);
    return c.json({ success: true, data: newProduct }, 201);
  } catch {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }
});

app.get('/:id', (c) => {
  const id = c.req.param('id');
  const product = products.find((p) => p.id === id);
  if (!product) return c.json({ success: false, error: 'Product not found' }, 404);
  return c.json({ success: true, data: product });
});

app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = products.findIndex((p) => p.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Product not found' }, 404);
  try {
    const body = await c.req.json();
    const existing = products[idx];
    const deptTimes = body.deptWorkingTimes || existing.deptWorkingTimes;
    const totalMinutes = deptTimes.reduce(
      (sum: number, d: { minutes: number }) => sum + (d.minutes || 0), 0
    );
    const updated: Product = {
      ...existing,
      code: body.code ?? existing.code, name: body.name ?? existing.name,
      category: body.category ?? existing.category,
      description: body.description ?? existing.description,
      baseModel: body.baseModel ?? existing.baseModel,
      sizeCode: body.sizeCode ?? existing.sizeCode,
      sizeLabel: body.sizeLabel ?? existing.sizeLabel,
      fabricUsage: body.fabricUsage ?? existing.fabricUsage,
      unitM3: body.unitM3 ?? existing.unitM3,
      status: body.status ?? existing.status,
      costPriceSen: body.costPriceSen ?? existing.costPriceSen,
      basePriceSen: body.basePriceSen ?? existing.basePriceSen,
      price1Sen: body.price1Sen ?? existing.price1Sen,
      seatHeightPrices: body.seatHeightPrices ?? existing.seatHeightPrices,
      productionTimeMinutes: totalMinutes,
      subAssemblies: body.subAssemblies ?? existing.subAssemblies,
      bomComponents: body.bomComponents
        ? body.bomComponents.map(
            (comp: { id?: string; materialCategory: string; materialName: string; qtyPerUnit: number; unit: string; wastePct: number }) => ({
              id: comp.id || generateId(), materialCategory: comp.materialCategory,
              materialName: comp.materialName, qtyPerUnit: comp.qtyPerUnit || 0,
              unit: comp.unit || 'PCS', wastePct: comp.wastePct || 0,
            })
          )
        : existing.bomComponents,
      deptWorkingTimes: body.deptWorkingTimes ?? existing.deptWorkingTimes,
    };
    products[idx] = updated;
    return c.json({ success: true, data: updated });
  } catch {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }
});

app.delete('/:id', (c) => {
  const id = c.req.param('id');
  const idx = products.findIndex((p) => p.id === id);
  if (idx === -1) return c.json({ success: false, error: 'Product not found' }, 404);
  products[idx] = { ...products[idx], status: 'INACTIVE' };
  return c.json({ success: true, data: products[idx] });
});

export default app;
