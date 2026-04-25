// ---------------------------------------------------------------------------
// Worker-facing schemas. The worker scan/index/issue pages call several
// boundary endpoints (clock-in, scan, attendance, RM lookup) — keep these
// loose passthrough since worker payloads change quickly with the floor's
// hardware integration.
// ---------------------------------------------------------------------------
import { z } from "zod";

export const WorkerJobCardSchema = z
  .object({
    id: z.string().optional(),
    poNo: z.string().optional(),
    deptCode: z.string().optional(),
    productCode: z.string().optional(),
    productName: z.string().optional(),
    quantity: z.number().optional(),
    status: z.string().optional(),
  })
  .passthrough();

/** Generic worker scan response — could be an attendance result, a job pickup, etc. */
export const WorkerScanResultSchema = z
  .object({
    success: z.boolean().optional(),
    error: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

/** Used for raw-material issuance + attendance API payloads. */
export const WorkerActionResultSchema = z
  .object({
    success: z.boolean().optional(),
    error: z.string().optional(),
    message: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

export type WorkerJobCardFromApi = z.infer<typeof WorkerJobCardSchema>;
