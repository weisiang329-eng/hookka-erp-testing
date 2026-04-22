import { Hono } from 'hono';
import { payrollRecords, workers, getNextPayrollId } from '../../lib/mock-data';
import type { PayrollRecord } from '../../lib/mock-data';

const app = new Hono();

// GET /api/payroll?period=2026-04
app.get('/', (c) => {
  const period = c.req.query('period');
  let filtered = payrollRecords;
  if (period) filtered = payrollRecords.filter((r) => r.period === period);
  return c.json({ success: true, data: filtered, total: filtered.length });
});

// POST /api/payroll
app.post('/', async (c) => {
  const body = await c.req.json();
  const { period } = body;

  if (!period) {
    return c.json({ success: false, error: 'Period is required (e.g. 2026-04)' }, 400);
  }

  const existing = payrollRecords.filter((r) => r.period === period);
  if (existing.length > 0) {
    return c.json(
      { success: false, error: 'Payroll already generated for this period. Delete first to regenerate.' },
      400
    );
  }

  const activeWorkers = workers.filter((w) => w.status === 'ACTIVE');
  const newRecords: PayrollRecord[] = [];

  for (const worker of activeWorkers) {
    const hourlyRateSen = worker.basicSalarySen / (26 * 9);

    const otHoursWeekday = Math.floor(Math.random() * 16) + 2;
    const otHoursSunday = Math.random() > 0.5 ? Math.floor(Math.random() * 8) : 0;
    const otHoursHoliday = Math.random() > 0.8 ? Math.floor(Math.random() * 8) : 0;

    const otWeekdayAmountSen = Math.round(hourlyRateSen * otHoursWeekday * 1.5);
    const otSundayAmountSen = Math.round(hourlyRateSen * otHoursSunday * 2.0);
    const otHolidayAmountSen = Math.round(hourlyRateSen * otHoursHoliday * 3.0);
    const otAmountSen = otWeekdayAmountSen + otSundayAmountSen + otHolidayAmountSen;

    const grossSalarySen = worker.basicSalarySen + otAmountSen;

    const epfEmployeeSen = Math.round(worker.basicSalarySen * 0.11);
    const epfEmployerSen = Math.round(worker.basicSalarySen * 0.13);
    const socsoEmployeeSen = 745;
    const socsoEmployerSen = 2615;
    const eisEmployeeSen = 390;
    const eisEmployerSen = 390;
    const pcbSen = 0;

    const totalDeductionsSen = epfEmployeeSen + socsoEmployeeSen + eisEmployeeSen + pcbSen;
    const netPaySen = grossSalarySen - totalDeductionsSen;

    const record: PayrollRecord = {
      id: getNextPayrollId(),
      workerId: worker.id,
      workerName: worker.name,
      period,
      basicSalarySen: worker.basicSalarySen,
      workingDays: worker.workingDaysPerMonth,
      otHoursWeekday,
      otHoursSunday,
      otHoursHoliday,
      otAmountSen,
      grossSalarySen,
      epfEmployeeSen,
      epfEmployerSen,
      socsoEmployeeSen,
      socsoEmployerSen,
      eisEmployeeSen,
      eisEmployerSen,
      pcbSen,
      totalDeductionsSen,
      netPaySen,
      status: 'DRAFT',
    };

    payrollRecords.push(record);
    newRecords.push(record);
  }

  return c.json({ success: true, data: newRecords, total: newRecords.length }, 201);
});

// PUT /api/payroll
app.put('/', async (c) => {
  const body = await c.req.json();
  const { period, status } = body;

  if (!period || !status) {
    return c.json({ success: false, error: 'Period and status are required' }, 400);
  }

  let updated = 0;
  for (const record of payrollRecords) {
    if (record.period === period) {
      record.status = status;
      updated++;
    }
  }

  return c.json({ success: true, updated });
});

export default app;
