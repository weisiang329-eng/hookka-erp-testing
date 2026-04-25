// ---------------------------------------------------------------------------
// Production-order schema. Production-orders have many fields and several
// flavours (worker view, planner view) — keep loose passthrough.
// ---------------------------------------------------------------------------
import { z } from "zod";

export const ProductionOrderSchema = z
  .object({
    id: z.string(),
    poNo: z.string().optional(),
    salesOrderId: z.string().optional(),
    customerId: z.string().optional(),
    customerName: z.string().optional(),
    productCode: z.string().optional(),
    productName: z.string().optional(),
    quantity: z.number().optional(),
    status: z.string().optional(),
  })
  .passthrough();

export type ProductionOrderFromApi = z.infer<typeof ProductionOrderSchema>;
