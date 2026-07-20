import { z } from "zod";

const nonEmptyId = z.string().trim().min(1);
const positiveSen = z.coerce.number().finite().int().positive();
const nonNegativeSen = z.coerce.number().finite().int().nonnegative();

const customerAllocationSchema = z.object({
  invoiceId: nonEmptyId,
  amount: positiveSen,
});

function rejectDuplicateCustomerAllocations(
  allocations: Array<{ invoiceId: string }>,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const allocation of allocations) {
    if (seen.has(allocation.invoiceId)) {
      ctx.addIssue({
        code: "custom",
        path: ["allocations"],
        message: `Invoice ${allocation.invoiceId} is allocated more than once`,
      });
    }
    seen.add(allocation.invoiceId);
  }
}

export const CustomerPaymentCreateRequestSchema = z
  .object({
    customerId: nonEmptyId,
    amount: positiveSen,
    method: nonEmptyId,
    reference: z.string().optional().default(""),
    bankAccount: nonEmptyId.optional(),
    date: z.iso.date().optional(),
    receiptNumber: nonEmptyId.optional(),
    allocations: z.array(customerAllocationSchema).min(1),
  })
  .superRefine((body, ctx) => {
    rejectDuplicateCustomerAllocations(body.allocations, ctx);
    let allocatedSen = 0;
    for (const allocation of body.allocations) {
      allocatedSen += allocation.amount;
    }
    if (body.amount !== allocatedSen) {
      ctx.addIssue({
        code: "custom",
        path: ["amount"],
        message: `Payment amount (${body.amount}) must equal allocation total (${allocatedSen})`,
      });
    }
  });

export const CustomerPaymentRestateRequestSchema = z
  .object({
    method: nonEmptyId.optional(),
    reference: z.string().nullable().optional(),
    bankAccount: nonEmptyId.optional(),
    date: z.iso.date().optional(),
    allocations: z.array(customerAllocationSchema).min(1),
  })
  .superRefine((body, ctx) => {
    rejectDuplicateCustomerAllocations(body.allocations, ctx);
  });

const supplierAllocationSchema = z
  .object({
    piId: nonEmptyId,
    payMyrSen: positiveSen.optional(),
    foreignSen: positiveSen.optional(),
    payRate: z.coerce.number().finite().positive().optional(),
    full: z.boolean().optional().default(false),
  })
  .refine(
    (allocation) =>
      allocation.full ||
      allocation.payMyrSen !== undefined ||
      allocation.foreignSen !== undefined,
    { message: "Allocation requires an amount or full settlement" },
  );

export const SupplierPaymentCreateRequestSchema = z
  .object({
    supplierId: nonEmptyId,
    payFrom: nonEmptyId,
    date: z.iso.date(),
    reference: z.string().optional().default(""),
    allocations: z.array(supplierAllocationSchema).optional().default([]),
    advanceSen: nonNegativeSen.optional().default(0),
  })
  .superRefine((body, ctx) => {
    if (body.allocations.length === 0 && body.advanceSen === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["allocations"],
        message: "At least one allocation or an advance amount is required",
      });
    }
    const seen = new Set<string>();
    for (const allocation of body.allocations) {
      if (seen.has(allocation.piId)) {
        ctx.addIssue({
          code: "custom",
          path: ["allocations"],
          message: `Purchase invoice ${allocation.piId} is allocated more than once`,
        });
      }
      seen.add(allocation.piId);
    }
  });

export type CustomerPaymentCreateRequest = z.infer<
  typeof CustomerPaymentCreateRequestSchema
>;
export type SupplierPaymentCreateRequest = z.infer<
  typeof SupplierPaymentCreateRequestSchema
>;
export type CustomerPaymentRestateRequest = z.infer<
  typeof CustomerPaymentRestateRequestSchema
>;

export function firstRequestValidationError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid request body";
  const field = issue.path.join(".");
  return field ? `${field}: ${issue.message}` : issue.message;
}
