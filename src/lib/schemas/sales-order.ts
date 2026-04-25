// ---------------------------------------------------------------------------
// Sales-order schema. Mirror src/api/routes-d1/sales-orders.ts rowToSO output.
// Loose passthrough — the SO shape is broad and varies by route variant.
// ---------------------------------------------------------------------------
import { z } from "zod";

export const SalesOrderItemSchema = z
  .object({
    id: z.string(),
    lineNo: z.number().optional(),
    lineSuffix: z.string().optional(),
    productId: z.string().optional(),
    productCode: z.string().optional(),
    productName: z.string().optional(),
    itemCategory: z.string().optional(),
    sizeCode: z.string().optional(),
    sizeLabel: z.string().optional(),
    fabricId: z.string().optional(),
    fabricCode: z.string().optional(),
    quantity: z.number().optional(),
    gapInches: z.number().nullable().optional(),
    divanHeightInches: z.number().nullable().optional(),
    divanPriceSen: z.number().optional(),
    legHeightInches: z.number().nullable().optional(),
    legPriceSen: z.number().optional(),
    specialOrder: z.string().optional(),
    specialOrderPriceSen: z.number().optional(),
    basePriceSen: z.number().optional(),
    unitPriceSen: z.number().optional(),
    lineTotalSen: z.number().optional(),
    notes: z.string().optional(),
  })
  .passthrough();

export const SalesOrderSchema = z
  .object({
    id: z.string(),
    customerPO: z.string().optional(),
    customerPOId: z.string().optional(),
    customerPODate: z.string().optional(),
    customerSO: z.string().optional(),
    customerSOId: z.string().optional(),
    reference: z.string().optional(),
    customerId: z.string(),
    customerName: z.string().optional(),
    customerState: z.string().optional(),
    hubId: z.string().nullable().optional(),
    hubName: z.string().optional(),
    companySO: z.string().optional(),
    companySOId: z.string().optional(),
    companySODate: z.string().optional(),
    customerDeliveryDate: z.string().optional(),
    hookkaExpectedDD: z.string().optional(),
    hookkaDeliveryOrder: z.string().optional(),
    items: z.array(SalesOrderItemSchema).optional(),
    subtotalSen: z.number().optional(),
    totalSen: z.number().optional(),
    status: z.string().optional(),
    overdue: z.string().optional(),
    notes: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

export type SalesOrderFromApi = z.infer<typeof SalesOrderSchema>;
