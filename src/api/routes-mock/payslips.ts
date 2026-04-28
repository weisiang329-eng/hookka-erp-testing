import { Hono } from 'hono';
import {
  payslipDetails,
  workers,
  getNextPayslipId,
  calcHourlyRate,
  calcOT,
  calcStatutory,
} from '../../lib/mock-data';
import type { PayslipDetail } from '../../lib/mock-data';

const app = new Hono();

// GET /api/payslips?period=2026-03&employeeId=emp-1
app.get('/', (c) => {
  const period = c.req.query('period');
  const employeeId = c.req.query('employeeId');

  let filtered = payslipDetails;
  if (period) filtered = filtered.filter((r) => r.period === period);
  if (employeeId) filtered = filtered.filter((r) => r.employeeId === employeeId);

  return c.json({ success: true, data: filtered, total: filtered.length });
});

// POST /api/payslips
app.post('/', async (c) => {
  const body = await c.req.json();
  const { period } = body;

  if (!period) {
    return c.json({ success: false, error: 'Period is required (e.g. 2026-04)' }, 400);
  }

  const existing = payslipDetails.filter((r) => r.period === period);
  if (existing.length > 0) {
    return c.json({ success: false, error: 'Payslips already generated for this period.' }, 400);
  }

  const activeWorkers = workers.filter((w) => w.status === 'ACTIVE');
  const newRecords: PayslipDetail[] = [];

  for (const worker of activeWorkers) {
    const hourlyRate = calcHourlyRate(worker.basicSalarySen);
    const otWeekday = Math.floor(Math.random() * 16) + 2;
    const otSunday = Math.random() > 0.5 ? Math.floor(Math.random() * 8) : 0;
    const otPH = Math.random() > 0.8 ? Math.floor(Math.random() * 8) : 0;
    const allowances = 0;

    const ot = calcOT(hourlyRate, otWeekday, otSunday, otPH);
    const grossPay = worker.basicSalarySen + ot.total + allowances;
    const stat = calcStatutory(worker.basicSalarySen);
    const totalDeductions = stat.epfEmployee + stat.socsoEmployee + stat.eisEmployee + stat.pcb;
    const netPay = grossPay - totalDeductions;

    const record: PayslipDetail = {
      id: getNextPayslipId(),
      employeeId: worker.id,
      employeeName: worker.name,
      employeeNo: worker.empNo,
      departmentCode: worker.departmentCode,
      period,
      basicSalary: worker.basicSalarySen,
      workingDays: worker.workingDaysPerMonth,
      otWeekdayHours: otWeekday,
      otSundayHours: otSunday,
      otPHHours: otPH,
      hourlyRate,
      otWeekdayAmount: ot.weekday,
      otSundayAmount: ot.sunday,
      otPHAmount: ot.ph,
      totalOT: ot.total,
      allowances,
      grossPay,
      epfEmployee: stat.epfEmployee,
      epfEmployer: stat.epfEmployer,
      socsoEmployee: stat.socsoEmployee,
      socsoEmployer: stat.socsoEmployer,
      eisEmployee: stat.eisEmployee,
      eisEmployer: stat.eisEmployer,
      pcb: stat.pcb,
      totalDeductions,
      netPay,
      bankAccount: `CIMB-${worker.empNo.replace('EMP-', '')}XXXX`,
      status: 'DRAFT',
    };

    payslipDetails.push(record);
    newRecords.push(record);
  }

  return c.json({ success: true, data: newRecords, total: newRecords.length }, 201);
});

// PUT /api/payslips
app.put('/', async (c) => {
  const body = await c.req.json();
  const { period, status } = body;

  if (!period || !status) {
    return c.json({ success: false, error: 'Period and status are required' }, 400);
  }

  let updated = 0;
  for (const record of payslipDetails) {
    if (record.period === period) {
      record.status = status;
      updated++;
    }
  }

  return c.json({ success: true, updated });
});

// GET /api/payslips/:id
app.get('/:id', (c) => {
  const id = c.req.param('id');
  const payslip = payslipDetails.find((p) => p.id === id);

  if (!payslip) {
    return c.json({ success: false, error: 'Payslip not found' }, 404);
  }

  const year = payslip.period.split('-')[0];
  const employeeSlips = payslipDetails.filter(
    (p) => p.employeeId === payslip.employeeId && p.period.startsWith(year)
  );

  const ytd = employeeSlips.reduce(
    (acc, p) => ({
      basicSalary: acc.basicSalary + p.basicSalary,
      totalOT: acc.totalOT + p.totalOT,
      grossPay: acc.grossPay + p.grossPay,
      epfEmployee: acc.epfEmployee + p.epfEmployee,
      epfEmployer: acc.epfEmployer + p.epfEmployer,
      socsoEmployee: acc.socsoEmployee + p.socsoEmployee,
      socsoEmployer: acc.socsoEmployer + p.socsoEmployer,
      eisEmployee: acc.eisEmployee + p.eisEmployee,
      eisEmployer: acc.eisEmployer + p.eisEmployer,
      pcb: acc.pcb + p.pcb,
      totalDeductions: acc.totalDeductions + p.totalDeductions,
      netPay: acc.netPay + p.netPay,
    }),
    {
      basicSalary: 0, totalOT: 0, grossPay: 0, epfEmployee: 0, epfEmployer: 0,
      socsoEmployee: 0, socsoEmployer: 0, eisEmployee: 0, eisEmployer: 0,
      pcb: 0, totalDeductions: 0, netPay: 0,
    }
  );

  return c.json({ success: true, data: payslip, ytd, monthsIncluded: employeeSlips.length });
});

export default app;
