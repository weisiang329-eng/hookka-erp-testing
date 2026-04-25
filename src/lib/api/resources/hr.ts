// ---------------------------------------------------------------------------
// Workers, payslips, attendance. HR / shopfloor domain.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { makeCrud } from "./_crud";

const WorkerSchema = z
  .object({
    id: z.string(),
    employeeNo: z.string().optional(),
    name: z.string(),
    departmentCode: z.string().optional(),
    isActive: z.boolean().optional(),
  })
  .passthrough();

const PayslipSchema = z
  .object({
    id: z.string(),
    workerId: z.string().optional(),
    periodMonth: z.string().optional(),
    grossSen: z.number().optional(),
    netSen: z.number().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const AttendanceSchema = z
  .object({
    id: z.string(),
    workerId: z.string().optional(),
    date: z.string().optional(),
    clockIn: z.string().nullable().optional(),
    clockOut: z.string().nullable().optional(),
    status: z.string().optional(),
  })
  .passthrough();

export const workers = makeCrud({
  base: "/api/workers",
  schema: WorkerSchema,
  bucket: "master",
});

export const payslips = makeCrud({
  base: "/api/payslips",
  schema: PayslipSchema,
  bucket: "transactional",
});

export const attendance = makeCrud({
  base: "/api/attendance",
  schema: AttendanceSchema,
  bucket: "transactional",
});
