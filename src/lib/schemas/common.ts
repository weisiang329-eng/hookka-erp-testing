// ---------------------------------------------------------------------------
// Common schema helpers shared across boundary schemas.
//
// We deliberately keep these loose — `.passthrough()` lets unknown extra
// fields flow through unchanged, so a route adding a column never breaks
// the SPA. The point of these schemas is to give TS a typed shape at the
// fetch boundary, NOT to be an authoritative spec of the API contract.
// ---------------------------------------------------------------------------
import { z } from "zod";

/** A response shape used by mutation endpoints: { success, data?, error? }. */
export const MutationResultSchema = z
  .object({
    success: z.boolean().optional(),
    error: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();
export type MutationResult = z.infer<typeof MutationResultSchema>;

/** Returned by mutation endpoints that include a `data` payload (the new row). */
export function mutationWithData<T extends z.ZodTypeAny>(data: T) {
  return z
    .object({
      success: z.boolean().optional(),
      error: z.string().optional(),
      message: z.string().optional(),
      data: data.optional(),
    })
    .passthrough();
}
