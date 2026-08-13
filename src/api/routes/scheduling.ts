// ---------------------------------------------------------------------------
// D1-backed Scheduling route.
//
// Reads/writes schedule_entries (JSON deptSchedule column) and pulls lead
// times from dept_lead_times so the backward-scheduling logic works without
// the in-memory mock arrays. Capacity endpoint computes loading per
// department/day against workers in D1.
//
// deptSchedule is stored as JSON TEXT, parsed on read.
// ---------------------------------------------------------------------------
import { Hono } from "hono";
import type { Env } from "../worker";
import { requirePermission } from "../lib/rbac";

const app = new Hono<Env>();

type ScheduleEntryRow = {
  id: string;
  productionOrderId: string | null;
  soNumber: string | null;
  productCode: string | null;
  category: string | null;
  customerDeliveryDate: string | null;
  customerName: string | null;
  hookkaExpectedDD: string | null;
  deptSchedule: string | null;
};

type DeptLeadTimeRow = {
  deptCode: string;
  deptName: string;
  bedframeDays: number;
  sofaDays: number;
};

type DepartmentRow = {
  id: string;
  code: string;
  name: string;
  shortName: string;
  sequence: number;
  color: string;
  workingHoursPerDay: number;
};

type WorkerRow = {
  id: string;
  departmentCode: string | null;
  status: string;
};

type DeptScheduleSegment = {
  deptCode: string;
  deptName: string;
  startDate: string;
  endDate: string;
  minutes: number;
  status: "SCHEDULED" | "IN_PROGRESS" | "COMPLETED" | "OVERDUE";
};

function parseJSON<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function rowToEntry(row: ScheduleEntryRow) {
  return {
    id: row.id,
    productionOrderId: row.productionOrderId ?? "",
    soNumber: row.soNumber ?? "",
    productCode: row.productCode ?? "",
    category: (row.category ?? "BEDFRAME") as "BEDFRAME" | "SOFA",
    customerDeliveryDate: row.customerDeliveryDate ?? "",
    customerName: row.customerName ?? "",
    hookkaExpectedDD: row.hookkaExpectedDD ?? "",
    deptSchedule: parseJSON<DeptScheduleSegment[]>(row.deptSchedule, []),
  };
}

function genId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

// --- Backward schedule helpers. Originally ported from a frontend copy in
// src/lib/scheduling.ts, changed to read lead times from the DB instead of the
// mock array. That frontend copy kept reading `deptLeadTimes` from
// src/lib/mock-data.ts and had no importer, so the two versions could disagree
// with only this one reachable; it was deleted in chore/dead-code-sweep. The
// helpers below are now the only backward-scheduling implementation. ---------

function subtractWorkingDays(from: Date, days: number): Date {
  const result = new Date(from);
  let remaining = days;
  while (remaining > 0) {
    result.setDate(result.getDate() - 1);
    if (result.getDay() !== 0) remaining--;
  }
  return result;
}

function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function calculateBackwardSchedule(
  deliveryDate: string,
  category: "BEDFRAME" | "SOFA",
  leadTimes: DeptLeadTimeRow[],
): DeptScheduleSegment[] {
  const delivery = parseDate(deliveryDate);
  const getLeadDays = (deptCode: string): number => {
    const lt = leadTimes.find((d) => d.deptCode === deptCode);
    if (!lt) return 0;
    return category === "BEDFRAME" ? lt.bedframeDays : lt.sofaDays;
  };
  const deptName = (deptCode: string): string =>
    leadTimes.find((d) => d.deptCode === deptCode)?.deptName ?? deptCode;

  const bufferDays = category === "BEDFRAME" ? 2 : 1;
  const hookkaDD = subtractWorkingDays(delivery, bufferDays);

  const packingDays = getLeadDays("PACKING");
  const packingEnd = new Date(hookkaDD);
  const packingStart = subtractWorkingDays(packingEnd, packingDays);

  const upholsteryDays = getLeadDays("UPHOLSTERY");
  const upholsteryEnd = new Date(packingStart);
  const upholsteryStart = subtractWorkingDays(upholsteryEnd, upholsteryDays);

  const feederEnd = new Date(upholsteryStart);

  const fabSewDays = getLeadDays("FAB_SEW");
  const fabSewEnd = new Date(feederEnd);
  const fabSewStart = subtractWorkingDays(fabSewEnd, fabSewDays);

  const fabCutDays = getLeadDays("FAB_CUT");
  const fabCutEnd = new Date(fabSewStart);
  const fabCutStart = subtractWorkingDays(fabCutEnd, fabCutDays);

  const foamDays = getLeadDays("FOAM");
  const foamEnd = new Date(feederEnd);
  const foamStart = subtractWorkingDays(foamEnd, foamDays);

  const framingDays = getLeadDays("FRAMING");
  const framingEnd = new Date(feederEnd);
  const framingStart = subtractWorkingDays(framingEnd, framingDays);

  const woodCutDays = getLeadDays("WOOD_CUT");
  const woodCutEnd = new Date(framingStart);
  const woodCutStart = subtractWorkingDays(woodCutEnd, woodCutDays);

  const webbingDays = getLeadDays("WEBBING");
  const webbingEnd = new Date(feederEnd);
  const webbingStart = subtractWorkingDays(webbingEnd, webbingDays);

  return [
    { deptCode: "FAB_CUT", deptName: deptName("FAB_CUT"), startDate: toISO(fabCutStart), endDate: toISO(fabCutEnd), minutes: 0, status: "SCHEDULED" },
    { deptCode: "FAB_SEW", deptName: deptName("FAB_SEW"), startDate: toISO(fabSewStart), endDate: toISO(fabSewEnd), minutes: 0, status: "SCHEDULED" },
    { deptCode: "FOAM", deptName: deptName("FOAM"), startDate: toISO(foamStart), endDate: toISO(foamEnd), minutes: 0, status: "SCHEDULED" },
    { deptCode: "WOOD_CUT", deptName: deptName("WOOD_CUT"), startDate: toISO(woodCutStart), endDate: toISO(woodCutEnd), minutes: 0, status: "SCHEDULED" },
    { deptCode: "FRAMING", deptName: deptName("FRAMING"), startDate: toISO(framingStart), endDate: toISO(framingEnd), minutes: 0, status: "SCHEDULED" },
    { deptCode: "WEBBING", deptName: deptName("WEBBING"), startDate: toISO(webbingStart), endDate: toISO(webbingEnd), minutes: 0, status: "SCHEDULED" },
    { deptCode: "UPHOLSTERY", deptName: deptName("UPHOLSTERY"), startDate: toISO(upholsteryStart), endDate: toISO(upholsteryEnd), minutes: 0, status: "SCHEDULED" },
    { deptCode: "PACKING", deptName: deptName("PACKING"), startDate: toISO(packingStart), endDate: toISO(packingEnd), minutes: 0, status: "SCHEDULED" },
  ];
}

function calculateHookkaDD(
  deliveryDate: string,
  category: "BEDFRAME" | "SOFA",
): string {
  const delivery = parseDate(deliveryDate);
  const bufferDays = category === "BEDFRAME" ? 2 : 1;
  return toISO(subtractWorkingDays(delivery, bufferDays));
}

// GET /api/scheduling
app.get("/", async (c) => {
  const res = await c.var.DB.prepare(
    "SELECT * FROM schedule_entries",
  ).all<ScheduleEntryRow>();
  const data = (res.results ?? []).map(rowToEntry);
  return c.json({ success: true, data, total: data.length });
});

// POST /api/scheduling — run backward scheduling (optionally persist)
app.post("/", async (c) => {
  const denied = await requirePermission(c, "scheduling", "create");
  if (denied) return denied;
  try {
    const body = await c.req.json();
    const { deliveryDate, category, productCode, soNumber, customerName } = body;
    if (!deliveryDate || !category) {
      return c.json(
        { success: false, error: "deliveryDate and category are required" },
        400,
      );
    }
    if (category !== "BEDFRAME" && category !== "SOFA") {
      return c.json(
        { success: false, error: "category must be BEDFRAME or SOFA" },
        400,
      );
    }

    const leadRes = await c.var.DB.prepare(
      "SELECT deptCode, deptName, bedframeDays, sofaDays FROM dept_lead_times",
    ).all<DeptLeadTimeRow>();
    const leadTimes = leadRes.results ?? [];

    const schedule = calculateBackwardSchedule(deliveryDate, category, leadTimes);
    const hookkaDD = calculateHookkaDD(deliveryDate, category);

    const entry = {
      id: genId("sch"),
      productionOrderId: "",
      soNumber: soNumber ?? "",
      productCode: productCode ?? "",
      category: category as "BEDFRAME" | "SOFA",
      customerDeliveryDate: deliveryDate,
      customerName: customerName ?? "",
      deptSchedule: schedule,
      hookkaExpectedDD: hookkaDD,
    };

    if (body.apply) {
      await c.var.DB.prepare(
        `INSERT INTO schedule_entries (id, productionOrderId, soNumber, productCode,
           category, customerDeliveryDate, customerName, hookkaExpectedDD, deptSchedule)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          entry.id,
          entry.productionOrderId,
          entry.soNumber,
          entry.productCode,
          entry.category,
          entry.customerDeliveryDate,
          entry.customerName,
          entry.hookkaExpectedDD,
          JSON.stringify(entry.deptSchedule),
        )
        .run();
    }

    return c.json({
      success: true,
      data: entry,
      schedule,
      hookkaExpectedDD: hookkaDD,
    });
  } catch {
    return c.json({ success: false, error: "Invalid request body" }, 400);
  }
});

// GET /api/scheduling/capacity
//
// `HOURS_PER_DAY = 9` used to be a hardcoded literal, and every department's
// capacity was `workerCount × 9 × 60 × 0.85` — while `workingHoursPerDay`, the
// real per-department column, was SELECTed one screen down and thrown away.
// It now comes from the department row. BUG-2026-08-13-014.
//
// EFFICIENCY is a PLANNING ASSUMPTION, not a measurement: nothing observes
// that a department realises 85% of its clocked hours. It is kept because a
// capacity figure has to assume something, but it is (a) named as an
// assumption, (b) published in the response as `assumedEfficiency` so any
// consumer can show it beside the number, and (c) the derived `utilization`
// and its CRITICAL / WARNING / MODERATE / NORMAL level inherit that
// assumption. A measured alternative already exists per worker
// (`/api/department-performance`: production minutes ÷ clocked minutes) — if
// the owner wants this RAG driven by measurement rather than assumption, that
// is the source, and it is a separate change.
//
// NOTE: nothing consumes this endpoint today — `src/pages/planning/index.tsx`
// records that Capacity Overview and Capacity Loading both compute
// client-side. It is fixed rather than left as a trap for the next consumer;
// whether to delete it is in the PR's owner-decision list.
const EFFICIENCY = 0.85;
const DEFAULT_HOURS_PER_DAY = 9;

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

app.get("/capacity", async (c) => {
  const [deptRes, workerRes, schedRes] = await Promise.all([
    c.var.DB.prepare(
      "SELECT id, code, name, shortName, sequence, color, workingHoursPerDay FROM departments ORDER BY sequence",
    ).all<DepartmentRow>(),
    c.var.DB.prepare(
      "SELECT id, departmentCode, status FROM workers",
    ).all<WorkerRow>(),
    c.var.DB.prepare("SELECT * FROM schedule_entries").all<ScheduleEntryRow>(),
  ]);

  const departments = deptRes.results ?? [];
  const workers = workerRes.results ?? [];
  const entries = (schedRes.results ?? []).map(rowToEntry);

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
      (w) => w.departmentCode === dept.code && w.status === "ACTIVE",
    );
    const workerCount = deptWorkers.length;
    const hoursPerDay = dept.workingHoursPerDay || DEFAULT_HOURS_PER_DAY;
    const dailyCapacityMinutes = Math.round(
      workerCount * hoursPerDay * 60 * EFFICIENCY,
    );

    const dailyLoading = days.map((dateStr) => {
      let loadedMinutes = 0;
      for (const entry of entries) {
        for (const ds of entry.deptSchedule) {
          if (
            ds.deptCode === dept.code &&
            ds.startDate <= dateStr &&
            ds.endDate >= dateStr
          ) {
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

      const utilization =
        dailyCapacityMinutes > 0
          ? Math.round((loadedMinutes / dailyCapacityMinutes) * 100)
          : 0;

      return {
        date: dateStr,
        loadedMinutes,
        capacityMinutes: dailyCapacityMinutes,
        utilization,
        level:
          utilization > 100
            ? "CRITICAL"
            : utilization > 90
              ? "WARNING"
              : utilization > 70
                ? "MODERATE"
                : "NORMAL",
      };
    });

    return {
      deptCode: dept.code,
      deptName: dept.name,
      color: dept.color,
      workerCount,
      hoursPerDay,
      dailyCapacityMinutes,
      dailyLoading,
    };
  });

  // `assumedEfficiency` travels WITH the numbers it produced. A utilization
  // percentage whose denominator carries an unstated assumption is exactly the
  // shape this sweep exists to remove.
  return c.json({
    success: true,
    data: capacityByDept,
    days,
    assumedEfficiency: EFFICIENCY,
  });
});

export default app;
