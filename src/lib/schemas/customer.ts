// ---------------------------------------------------------------------------
// Customer + delivery-hub schemas. Mirror src/api/routes/customers.ts
// rowToCustomer output. Loose passthrough so extra columns don't break
// validation.
// ---------------------------------------------------------------------------
import { z } from "zod";

export const DeliveryHubSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    shortName: z.string(),
    state: z.string().optional(),
    address: z.string().optional(),
    contactName: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    isDefault: z.boolean().optional(),
  })
  .passthrough();

export const CustomerSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    ssmNo: z.string().optional(),
    companyAddress: z.string().optional(),
    creditTerms: z.string().optional(),
    creditLimitSen: z.number().optional(),
    outstandingSen: z.number().optional(),
    isActive: z.boolean().optional(),
    contactName: z.string().optional(),
    phone: z.string().optional(),
    email: z.string().optional(),
    deliveryHubs: z.array(DeliveryHubSchema).optional(),
  })
  .passthrough();

export type CustomerFromApi = z.infer<typeof CustomerSchema>;
