// ---------------------------------------------------------------------------
// deliveryOrders — /api/delivery-orders. Transactional.
// ---------------------------------------------------------------------------
import { DeliveryOrderSchema } from "../../schemas";
import { makeCrud } from "./_crud";

export const deliveryOrders = makeCrud({
  base: "/api/delivery-orders",
  schema: DeliveryOrderSchema,
  bucket: "transactional",
});
