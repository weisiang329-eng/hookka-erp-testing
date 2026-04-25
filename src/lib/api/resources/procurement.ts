// ---------------------------------------------------------------------------
// Purchase orders, GRNs, suppliers. Procurement domain.
// Schemas in `src/lib/schemas` don't cover these explicitly, so we use loose
// passthrough rows — extra columns flow through unchanged.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { makeCrud } from "./_crud";

const PurchaseOrderSchema = z
  .object({
    id: z.string(),
    poNo: z.string().optional(),
    supplierId: z.string().optional(),
    supplierName: z.string().optional(),
    status: z.string().optional(),
    totalSen: z.number().optional(),
  })
  .passthrough();

const GrnSchema = z
  .object({
    id: z.string(),
    grnNo: z.string().optional(),
    purchaseOrderId: z.string().optional(),
    supplierId: z.string().optional(),
    receivedAt: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough();

const SupplierSchema = z
  .object({
    id: z.string(),
    code: z.string().optional(),
    name: z.string(),
    isActive: z.boolean().optional(),
  })
  .passthrough();

export const purchaseOrders = makeCrud({
  base: "/api/purchase-orders",
  schema: PurchaseOrderSchema,
  bucket: "transactional",
});

export const grns = makeCrud({
  base: "/api/grn",
  schema: GrnSchema,
  bucket: "transactional",
});

export const suppliers = makeCrud({
  base: "/api/suppliers",
  schema: SupplierSchema,
  bucket: "master",
});
