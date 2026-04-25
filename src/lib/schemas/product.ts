// ---------------------------------------------------------------------------
// Product schemas. Mirror src/api/routes-d1/products.ts rowToProduct output.
// Loose passthrough so the SPA's pages/products page sees extra fields too.
// ---------------------------------------------------------------------------
import { z } from "zod";

export const BomComponentSchema = z
  .object({
    id: z.string(),
    materialCategory: z.string(),
    materialName: z.string(),
    qtyPerUnit: z.number(),
    unit: z.string(),
    wastePct: z.number(),
  })
  .passthrough();

export const DeptWorkingTimeSchema = z
  .object({
    departmentCode: z.string(),
    minutes: z.number(),
    category: z.string().optional(),
  })
  .passthrough();

export const ProductSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    category: z.string(),
    description: z.string().optional(),
    baseModel: z.string().optional(),
    sizeCode: z.string().optional(),
    sizeLabel: z.string().optional(),
    fabricUsage: z.number().optional(),
    unitM3: z.number().optional(),
    status: z.string().optional(),
    costPriceSen: z.number().optional(),
    basePriceSen: z.number().optional(),
    price1Sen: z.number().optional(),
    productionTimeMinutes: z.number().optional(),
    subAssemblies: z.array(z.string()).optional(),
    bomComponents: z.array(BomComponentSchema).optional(),
    deptWorkingTimes: z.array(DeptWorkingTimeSchema).optional(),
    skuCode: z.string().optional(),
    fabricColor: z.string().optional(),
    pieces: z
      .object({ count: z.number(), names: z.array(z.string()) })
      .nullable()
      .optional(),
    seatHeightPrices: z
      .array(z.object({ height: z.string(), priceSen: z.number() }))
      .optional(),
  })
  .passthrough();

export type ProductFromApi = z.infer<typeof ProductSchema>;
