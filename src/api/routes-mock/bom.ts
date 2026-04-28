import { Hono } from 'hono';
import { bomVersions, bomTemplates, generateId } from '../../lib/mock-data';
import type { BOMVersion, BOMTemplate } from '../../lib/mock-data';

const app = new Hono();

// GET /api/bom
app.get('/', (c) => {
  const productId = c.req.query('productId');
  let data = bomVersions;
  if (productId) data = bomVersions.filter((b) => b.productId === productId);
  return c.json({ success: true, data });
});

// POST /api/bom
app.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { productId, productCode, version, status, effectiveFrom, effectiveTo, tree, totalMinutes, labourCost, materialCost, totalCost } = body;
    if (!productId || !productCode || !tree) {
      return c.json({ success: false, error: 'productId, productCode, and tree are required' }, 400);
    }
    const newBom: BOMVersion = {
      id: generateId(), productId, productCode, version: version || 'v1.0',
      status: status || 'DRAFT',
      effectiveFrom: effectiveFrom || new Date().toISOString().slice(0, 10),
      effectiveTo: effectiveTo || null, tree,
      totalMinutes: totalMinutes || 0, labourCost: labourCost || 0,
      materialCost: materialCost || 0, totalCost: totalCost || 0,
    };
    bomVersions.push(newBom);
    return c.json({ success: true, data: newBom }, 201);
  } catch { return c.json({ success: false, error: 'Invalid request body' }, 400); }
});

// GET /api/bom/templates
app.get('/templates', (c) => {
  const category = c.req.query('category');
  const baseModel = c.req.query('baseModel');
  const search = c.req.query('search');
  const version = c.req.query('version');
  const versionStatus = c.req.query('versionStatus');
  const productCode = c.req.query('productCode');
  let data = bomTemplates;
  if (category) data = data.filter((t) => t.category === category.toUpperCase());
  if (baseModel) data = data.filter((t) => t.baseModel === baseModel);
  if (productCode) data = data.filter((t) => t.productCode === productCode);
  if (version) data = data.filter((t) => t.version === version);
  if (versionStatus) data = data.filter((t) => t.versionStatus === versionStatus.toUpperCase());
  if (search) {
    const q = search.toLowerCase();
    data = data.filter((t) => t.productCode.toLowerCase().includes(q) || t.baseModel.toLowerCase().includes(q));
  }
  return c.json({ success: true, data });
});

// POST /api/bom/templates
app.post('/templates', async (c) => {
  try {
    const body = await c.req.json();
    const { productCode, baseModel, category, l1Processes, wipComponents } = body;
    if (!productCode || !baseModel || !category) {
      return c.json({ success: false, error: 'productCode, baseModel, and category are required' }, 400);
    }
    const newTemplate: BOMTemplate = {
      id: generateId(), productCode, baseModel, category,
      l1Processes: l1Processes || [], wipComponents: wipComponents || [],
      version: body.version || '1.0', versionStatus: body.versionStatus || 'DRAFT',
      effectiveFrom: body.effectiveFrom || new Date().toISOString(),
      effectiveTo: body.effectiveTo, changeLog: body.changeLog,
    };
    bomTemplates.push(newTemplate);
    return c.json({ success: true, data: newTemplate }, 201);
  } catch { return c.json({ success: false, error: 'Invalid request body' }, 400); }
});

// PUT /api/bom/templates — bulk replace
app.put('/templates', async (c) => {
  try {
    const body = await c.req.json();
    const incoming: unknown = body?.templates;
    if (!Array.isArray(incoming)) {
      return c.json({ success: false, error: 'templates must be an array' }, 400);
    }
    const sanitized: BOMTemplate[] = [];
    for (const raw of incoming as Partial<BOMTemplate>[]) {
      if (!raw || typeof raw !== 'object') continue;
      if (!raw.productCode) continue;
      sanitized.push({
        id: raw.id || generateId(), productCode: raw.productCode,
        baseModel: raw.baseModel || raw.productCode,
        category: raw.category === 'SOFA' ? 'SOFA' : 'BEDFRAME',
        l1Processes: Array.isArray(raw.l1Processes) ? raw.l1Processes : [],
        wipComponents: Array.isArray(raw.wipComponents) ? raw.wipComponents : [],
        version: raw.version || '1.0', versionStatus: raw.versionStatus || 'ACTIVE',
        effectiveFrom: raw.effectiveFrom || new Date().toISOString(),
        effectiveTo: raw.effectiveTo, changeLog: raw.changeLog,
      });
    }
    bomTemplates.splice(0, bomTemplates.length, ...sanitized);
    return c.json({ success: true, count: bomTemplates.length });
  } catch { return c.json({ success: false, error: 'Invalid request body' }, 400); }
});

// GET /api/bom/:id
app.get('/:id', (c) => {
  const id = c.req.param('id');
  const idx = bomVersions.findIndex((b) => b.id === id);
  if (idx === -1) return c.json({ success: false, error: 'BOM version not found' }, 404);
  return c.json({ success: true, data: bomVersions[idx] });
});

// PUT /api/bom/:id
app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = bomVersions.findIndex((b) => b.id === id);
  if (idx === -1) return c.json({ success: false, error: 'BOM version not found' }, 404);
  try {
    const body = await c.req.json();
    const updated = { ...bomVersions[idx], ...body, id };
    bomVersions[idx] = updated;
    return c.json({ success: true, data: updated });
  } catch { return c.json({ success: false, error: 'Invalid request body' }, 400); }
});

export default app;
