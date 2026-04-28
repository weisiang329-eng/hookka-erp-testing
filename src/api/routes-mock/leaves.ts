import { Hono } from 'hono';
import { leaveRecords, workers } from '../../lib/mock-data';
import type { LeaveRecord } from '../../lib/mock-data';

const app = new Hono();

// GET /api/leaves?workerId=emp-1&status=PENDING
app.get('/', (c) => {
  const workerId = c.req.query('workerId');
  const status = c.req.query('status');

  let filtered = leaveRecords;
  if (workerId) filtered = filtered.filter((r) => r.workerId === workerId);
  if (status) filtered = filtered.filter((r) => r.status === status);

  return c.json({ success: true, data: filtered, total: filtered.length });
});

// POST /api/leaves
app.post('/', async (c) => {
  const body = await c.req.json();
  const { workerId, type, startDate, endDate, days, reason } = body;

  const worker = workers.find((w) => w.id === workerId);
  if (!worker) {
    return c.json({ success: false, error: 'Worker not found' }, 400);
  }

  const newLeave: LeaveRecord = {
    id: `LV-${String(leaveRecords.length + 1).padStart(3, '0')}`,
    workerId,
    workerName: worker.name,
    type,
    startDate,
    endDate,
    days: days || 1,
    status: 'PENDING',
    reason: reason || '',
  };

  leaveRecords.push(newLeave);
  return c.json({ success: true, data: newLeave }, 201);
});

// PUT /api/leaves
app.put('/', async (c) => {
  const body = await c.req.json();
  const { id, status, approvedBy } = body;

  const record = leaveRecords.find((r) => r.id === id);
  if (!record) {
    return c.json({ success: false, error: 'Leave record not found' }, 404);
  }

  record.status = status;
  if (approvedBy) record.approvedBy = approvedBy;

  return c.json({ success: true, data: record });
});

export default app;
