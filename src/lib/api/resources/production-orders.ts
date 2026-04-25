// ---------------------------------------------------------------------------
// productionOrders — /api/production-orders. Transactional; short TTL.
// ---------------------------------------------------------------------------
import { ProductionOrderSchema } from "../../schemas";
import { makeCrud } from "./_crud";

export const productionOrders = makeCrud({
  base: "/api/production-orders",
  schema: ProductionOrderSchema,
  bucket: "transactional",
});
