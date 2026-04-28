import { Hono } from 'hono';
import { workers, departments, generateId } from '../../lib/mock-data';
import type { Worker } from '../../lib/mock-data';

const app = new Hono();

// GET /api/workers?departmentId=dept-1
app.get('/', (c) => {
  const departmentId = c.req.query('departmentId');
  let filtered = workers;
  if (departmentId) {
    filtered = workers.filter((w) => w.departmentId === departmentId);
  }
  return c.json({ success: true, data: filtered, total: filtered.length });
});

// POST /api/workers
app.post('/', async (c) => {
  const body = await c.req.json();
  const { name, empNo, departmentId, position, phone, basicSalarySen, workingHoursPerDay } = body;

  const department = departments.find((d) => d.id === departmentId);
  if (!department) {
    return c.json({ success: false, error: 'Department not found' }, 400);
  }

  const newWorker: Worker = {
    id: generateId(),
    empNo,
    name,
    departmentId,
    departmentCode: department.code,
    position,
    phone,
    status: 'ACTIVE',
    basicSalarySen,
    workingHoursPerDay: workingHoursPerDay ?? department.workingHoursPerDay,
    workingDaysPerMonth: 26,
    joinDate: new Date().toISOString().split('T')[0],
    icNumber: '',
    passportNumber: '',
    nationality: '',
  };

  workers.push(newWorker);
  return c.json({ success: true, data: newWorker }, 201);
});

// GET /api/workers/:id
app.get('/:id', (c) => {
  const id = c.req.param('id');
  const worker = workers.find((w) => w.id === id);
  if (!worker) return c.json({ success: false, error: 'Worker not found' }, 404);
  return c.json({ success: true, data: worker });
});

// PUT /api/workers/:id
app.put('/:id', async (c) => {
  const id = c.req.param('id');
  const index = workers.findIndex((w) => w.id === id);
  if (index === -1) return c.json({ success: false, error: 'Worker not found' }, 404);

  const body = await c.req.json();
  const allowedFields: (keyof Worker)[] = [
    'name', 'empNo', 'departmentId', 'departmentCode', 'position',
    'phone', 'status', 'basicSalarySen', 'workingHoursPerDay',
    'workingDaysPerMonth', 'joinDate', 'icNumber', 'passportNumber', 'nationality',
  ];

  const updates: Partial<Worker> = {};
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      (updates as Record<string, unknown>)[field] = body[field];
    }
  }

  if (updates.departmentId && updates.departmentId !== workers[index].departmentId) {
    const department = departments.find((d) => d.id === updates.departmentId);
    if (!department) {
      return c.json({ success: false, error: 'Department not found' }, 400);
    }
    updates.departmentCode = department.code;
  }

  workers[index] = { ...workers[index], ...updates };
  return c.json({ success: true, data: workers[index] });
});

// DELETE /api/workers/:id
app.delete('/:id', (c) => {
  const id = c.req.param('id');
  const index = workers.findIndex((w) => w.id === id);
  if (index === -1) return c.json({ success: false, error: 'Worker not found' }, 404);
  const removed = workers.splice(index, 1)[0];
  return c.json({ success: true, data: removed });
});

export default app;
