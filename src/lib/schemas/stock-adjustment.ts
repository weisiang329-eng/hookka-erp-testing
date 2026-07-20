import { z } from "zod";

export const stockAdjustmentTypes = ["RM", "WIP", "FG"] as const;
export const stockAdjustmentReasons = [
  "FOUND",
  "DAMAGED",
  "COUNT_CORRECTION",
  "WRITE_OFF",
  "SERVICE_REPLACEMENT",
  "OTHER",
] as const;

export const createStockAdjustmentSchema = z
  .object({
    type: z.enum(stockAdjustmentTypes),
    itemId: z.string().trim().min(1).max(160),
    qtyDelta: z.number().finite().refine((value) => value !== 0, {
      message: "qtyDelta must be non-zero",
    }),
    unitCostSen: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    reason: z.enum(stockAdjustmentReasons),
    notes: z.string().trim().max(2_000).nullable().optional(),
    caseId: z.string().trim().min(1).max(160).nullable().optional(),
  })
  .strict();

export type CreateStockAdjustmentInput = z.infer<
  typeof createStockAdjustmentSchema
>;

export const scrapServiceReturnSchema = z
  .object({
    fgBatchId: z.string().trim().min(1).max(160),
    unitCostSen: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    notes: z.string().trim().max(2_000).nullable().optional(),
  })
  .strict();
