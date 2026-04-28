// ---------------------------------------------------------------------------
// Delivery-order + DO-item schemas. Mirror src/api/routes/delivery-orders.ts
// rowToOrder output. Loose passthrough so future columns don't break.
// ---------------------------------------------------------------------------
import { z } from "zod";

export const DeliveryOrderItemSchema = z
  .object({
    id: z.string(),
    productionOrderId: z.string().optional(),
    poNo: z.string().optional(),
    productCode: z.string().optional(),
    productName: z.string().optional(),
    sizeLabel: z.string().optional(),
    fabricCode: z.string().optional(),
    quantity: z.number().optional(),
    itemM3: z.number().optional(),
    rackingNumber: z.string().optional(),
    packingStatus: z.string().optional(),
    salesOrderNo: z.string().optional(),
  })
  .passthrough();

export const DeliveryOrderSchema = z
  .object({
    id: z.string(),
    doNo: z.string(),
    salesOrderId: z.string().optional(),
    companySO: z.string().optional(),
    companySOId: z.string().optional(),
    customerId: z.string().optional(),
    customerPOId: z.string().optional(),
    customerName: z.string().optional(),
    customerState: z.string().optional(),
    deliveryAddress: z.string().optional(),
    contactPerson: z.string().optional(),
    contactPhone: z.string().optional(),
    hubId: z.string().nullable().optional(),
    hubName: z.string().optional(),
    dropPoints: z.number().optional(),
    deliveryCostSen: z.number().optional(),
    lorryId: z.string().nullable().optional(),
    lorryName: z.string().optional(),
    deliveryDate: z.string().optional(),
    hookkaExpectedDD: z.string().optional(),
    driverId: z.string().nullable().optional(),
    driverName: z.string().optional(),
    vehicleNo: z.string().optional(),
    items: z.array(DeliveryOrderItemSchema).optional(),
    totalM3: z.number().optional(),
    totalItems: z.number().optional(),
    status: z.string(),
    overdue: z.string().optional(),
    dispatchedAt: z.string().nullable().optional(),
    deliveredAt: z.string().nullable().optional(),
    remarks: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
    doQrCode: z.string().optional(),
    fgUnitIds: z.array(z.string()).optional(),
    signedAt: z.string().nullable().optional(),
    signedByWorkerId: z.string().nullable().optional(),
    signedByWorkerName: z.string().optional(),
    proofOfDelivery: z.unknown().optional(),
  })
  .passthrough();

export type DeliveryOrderFromApi = z.infer<typeof DeliveryOrderSchema>;
