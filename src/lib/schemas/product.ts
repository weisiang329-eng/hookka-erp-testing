// ---------------------------------------------------------------------------
// Product schemas. Mirror src/api/routes/products.ts rowToProduct output.
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
    // Each entry now optionally carries a fabric `tier` so a sofa SKU can
    // hold its full price matrix (5 heights × {P1,P2,P3}). Legacy entries
    // without a tier field are treated as P2 by every reader (kept the
    // historical default to avoid a one-shot data migration).
    seatHeightPrices: z
      .array(
        z.object({
          height: z.string(),
          priceSen: z.number(),
          // Tier values match fabric_tracking.priceTier ("PRICE_1" | "PRICE_2"
          // | "PRICE_3") so the CS Order sofa path can do a direct
          // fabric→matrix lookup with no string mapping. UI labels render as
          // "P1" / "P2" / "P3" — that's a display concern, not a data one.
          tier: z.enum(["PRICE_1", "PRICE_2", "PRICE_3"]).optional(),
        }),
      )
      .optional(),
  })
  .passthrough();

export type ProductFromApi = z.infer<typeof ProductSchema>;
