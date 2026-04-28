import { Hono } from 'hono';
import { attendanceRecords, workers, departments, generateId } from '../../lib/mock-data';
import type { AttendanceRecord, AttendanceStatus } from '../../lib/mock-data';

const app = new Hono();

// GET /api/attendance?date=2026-04-13
app.get('/', (c) => {
  const date = c.req.query('date');
  let filtered = attendanceRecords;
  if (date) {
    filtered = attendanceRecords.filter((r) => r.date === date);
  }
  return c.json({ success: true, data: filtered, total: filtered.length });
});

// POST /api/attendance
app.post('/', async (c) => {
  const body = await c.req.json();

  const worker = workers.find((w) => w.id === body.employeeId);
  if (!worker) {
    return c.json({ success: false, error: 'Worker not found' }, 400);
  }

  const date = body.date || new Date().toISOString().split('T')[0];
  const now = new Date();
  const time =
    body.time ||
    `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const record = attendanceRecords.find(
    (r) => r.employeeId === body.employeeId && r.date === date
  );

  if (body.action === 'CLOCK_IN') {
    if (record) {
      record.clockIn = time;
      record.status = 'PRESENT';
      return c.json({ success: true, data: record });
    }

    const dept = departments.find((d) => d.id === worker.departmentId);

    const newRecord: AttendanceRecord = {
      id: generateId(),
      employeeId: worker.id,
      employeeName: worker.name,
      departmentCode: worker.departmentCode,
      departmentName: dept?.shortName || '',
      date,
      clockIn: time,
      clockOut: null,
      status: 'PRESENT' as AttendanceStatus,
      workingMinutes: 0,
      productionTimeMinutes: 0,
      efficiencyPct: 0,
      overtimeMinutes: 0,
      deptBreakdown: [{ deptCode: worker.departmentCode, minutes: 0, productCode: '' }],
      notes: '',
    };

    attendanceRecords.push(newRecord);
    return c.json({ success: true, data: newRecord }, 201);
  }

  if (body.action === 'CLOCK_OUT') {
    if (!record) {
      return c.json({ success: false, error: 'No clock-in record found for this date' }, 400);
    }

    record.clockOut = time;

    if (record.clockIn) {
      const [inH, inM] = record.clockIn.split(':').map(Number);
      const [outH, outM] = time.split(':').map(Number);
      const totalMinutes = outH * 60 + outM - (inH * 60 + inM);
      record.workingMinutes = Math.max(0, totalMinutes);
      record.productionTimeMinutes = Math.max(0, Math.round(totalMinutes * 0.85));
      const standardMinutes = (worker.workingHoursPerDay || 9) * 60;
      record.efficiencyPct = Math.round((record.productionTimeMinutes / standardMinutes) * 100);
      record.overtimeMinutes = Math.max(0, totalMinutes - standardMinutes);
      record.deptBreakdown = [
        { deptCode: worker.departmentCode, minutes: record.productionTimeMinutes, productCode: '' },
      ];
    }

    return c.json({ success: true, data: record });
  }

  return c.json({ success: false, error: 'Invalid action. Use CLOCK_IN or CLOCK_OUT' }, 400);
});

export default app;
