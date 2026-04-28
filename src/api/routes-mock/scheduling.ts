import { Hono } from 'hono';
import { scheduleEntries, departments, workers, generateId } from '../../lib/mock-data';
import { calculateBackwardSchedule, calculateHookkaDD } from '../../lib/scheduling';

const app = new Hono();

// GET /api/scheduling
app.get('/', (c) => {
  return c.json({ success: true, data: scheduleEntries, total: scheduleEntries.length });
});

// POST /api/scheduling - run backward scheduling
app.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const { deliveryDate, category, productCode, soNumber, customerName } = body;

    if (!deliveryDate || !category) {
      return c.json({ success: false, error: 'deliveryDate and category are required' }, 400);
    }
    if (category !== 'BEDFRAME' && category !== 'SOFA') {
      return c.json({ success: false, error: 'category must be BEDFRAME or SOFA' }, 400);
    }

    const schedule = calculateBackwardSchedule(deliveryDate, category);
    const hookkaDD = calculateHookkaDD(deliveryDate, category);

    const entry = {
      id: generateId(),
      productionOrderId: '',
      soNumber: soNumber || '',
      productCode: productCode || '',
      category,
      customerDeliveryDate: deliveryDate,
      customerName: customerName || '',
      deptSchedule: schedule.map((s) => ({
        deptCode: s.deptCode,
        deptName: s.deptName,
        startDate: s.startDate,
        endDate: s.endDate,
        minutes: 0,
        status: 'SCHEDULED' as const,
      })),
      hookkaExpectedDD: hookkaDD,
    };

    if (body.apply) {
      scheduleEntries.push(entry);
    }

    return c.json({ success: true, data: entry, schedule, hookkaExpectedDD: hookkaDD });
  } catch {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }
});

// GET /api/scheduling/capacity
const EFFICIENCY = 0.85;
const HOURS_PER_DAY = 9;

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

app.get('/capacity', (c) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const days: string[] = [];
  for (let i = 0; i < 28; i++) {
    const d = addDays(today, i);
    if (d.getDay() !== 0) {
      days.push(toISO(d));
    }
  }

  const capacityByDept = departments.map((dept) => {
    const deptWorkers = workers.filter(
      (w) => w.departmentCode === dept.code && w.status === 'ACTIVE'
    );
    const workerCount = deptWorkers.length;
    const dailyCapacityMinutes = Math.round(workerCount * HOURS_PER_DAY * 60 * EFFICIENCY);

    const dailyLoading = days.map((dateStr) => {
      let loadedMinutes = 0;
      for (const entry of scheduleEntries) {
        for (const ds of entry.deptSchedule) {
          if (ds.deptCode === dept.code && ds.startDate <= dateStr && ds.endDate >= dateStr) {
            const start = new Date(ds.startDate);
            const end = new Date(ds.endDate);
            let workingDaysInSpan = 0;
            const cur = new Date(start);
            while (cur <= end) {
              if (cur.getDay() !== 0) workingDaysInSpan++;
              cur.setDate(cur.getDate() + 1);
            }
            if (workingDaysInSpan > 0) {
              loadedMinutes += Math.round(ds.minutes / workingDaysInSpan);
            }
          }
        }
      }

      const utilization = dailyCapacityMinutes > 0
        ? Math.round((loadedMinutes / dailyCapacityMinutes) * 100)
        : 0;

      return {
        date: dateStr,
        loadedMinutes,
        capacityMinutes: dailyCapacityMinutes,
        utilization,
        level: utilization > 100 ? 'CRITICAL' : utilization > 90 ? 'WARNING' : utilization > 70 ? 'MODERATE' : 'NORMAL',
      };
    });

    return {
      deptCode: dept.code,
      deptName: dept.name,
      color: dept.color,
      workerCount,
      dailyCapacityMinutes,
      dailyLoading,
    };
  });

  return c.json({ success: true, data: capacityByDept, days });
});

export default app;
