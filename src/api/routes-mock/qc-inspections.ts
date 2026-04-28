import { Hono } from 'hono';
import { qcInspections, generateId, getNextQCNo } from '../../lib/mock-data';
import type { QCInspection, QCDefect } from '../../lib/mock-data';

const app = new Hono();

// GET /api/qc-inspections
app.get('/', (c) => {
  const department = c.req.query('department');
  const result = c.req.query('result');
  const dateFrom = c.req.query('dateFrom');
  const dateTo = c.req.query('dateTo');

  let filtered = [...qcInspections];
  if (department) filtered = filtered.filter((i) => i.department === department);
  if (result) filtered = filtered.filter((i) => i.result === result);
  if (dateFrom) filtered = filtered.filter((i) => i.inspectionDate >= dateFrom);
  if (dateTo) filtered = filtered.filter((i) => i.inspectionDate <= dateTo);

  filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return c.json({ success: true, data: filtered, total: filtered.length });
});

// POST /api/qc-inspections
app.post('/', async (c) => {
  const body = await c.req.json();

  const defects: QCDefect[] = (body.defects || []).map((d: Partial<QCDefect>) => ({
    id: generateId(),
    type: d.type || 'OTHER',
    severity: d.severity || 'MINOR',
    description: d.description || '',
    actionTaken: d.actionTaken || 'ACCEPT',
  }));

  const newInspection: QCInspection = {
    id: generateId(),
    inspectionNo: getNextQCNo(),
    productionOrderId: body.productionOrderId || '',
    poNo: body.poNo || '',
    productCode: body.productCode || '',
    productName: body.productName || '',
    customerName: body.customerName || '',
    department: body.department || 'UPHOLSTERY',
    inspectorId: body.inspectorId || '',
    inspectorName: body.inspectorName || 'QA Manager',
    result: body.result || 'PASS',
    defects,
    notes: body.notes || '',
    inspectionDate: body.inspectionDate || new Date().toISOString().split('T')[0],
    createdAt: new Date().toISOString(),
  };

  qcInspections.unshift(newInspection);
  return c.json({ success: true, data: newInspection }, 201);
});

// GET /api/qc-inspections/:id
app.get('/:id', (c) => {
  const id = c.req.param('id');
  const inspection = qcInspections.find((i) => i.id === id);
  if (!inspection) return c.json({ success: false, error: 'QC inspection not found' }, 404);
  return c.json({ success: true, data: inspection });
});

// PUT /api/qc-inspections/:id
app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const idx = qcInspections.findIndex((i) => i.id === id);
  if (idx === -1) return c.json({ success: false, error: 'QC inspection not found' }, 404);

  const body = await c.req.json();
  const inspection = qcInspections[idx];

  if (body.result !== undefined) inspection.result = body.result;
  if (body.notes !== undefined) inspection.notes = body.notes;
  if (body.department !== undefined) inspection.department = body.department;
  if (body.defects !== undefined) {
    inspection.defects = body.defects.map((d: Partial<QCDefect>) => ({
      id: d.id || generateId(),
      type: d.type || 'OTHER',
      severity: d.severity || 'MINOR',
      description: d.description || '',
      actionTaken: d.actionTaken || 'ACCEPT',
    }));
  }
  if (body.addDefect) {
    inspection.defects.push({
      id: generateId(),
      type: body.addDefect.type || 'OTHER',
      severity: body.addDefect.severity || 'MINOR',
      description: body.addDefect.description || '',
      actionTaken: body.addDefect.actionTaken || 'ACCEPT',
    });
  }

  qcInspections[idx] = inspection;
  return c.json({ success: true, data: inspection });
});

// DELETE /api/qc-inspections/:id
app.delete('/:id', (c) => {
  const id = c.req.param('id');
  const idx = qcInspections.findIndex((i) => i.id === id);
  if (idx === -1) return c.json({ success: false, error: 'QC inspection not found' }, 404);
  const removed = qcInspections.splice(idx, 1)[0];
  return c.json({ success: true, data: removed });
});

export default app;
