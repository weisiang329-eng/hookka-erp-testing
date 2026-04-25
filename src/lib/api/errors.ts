// ---------------------------------------------------------------------------
// Single error type for every SDK call. Resource modules never throw raw
// FetchJsonError or DOMException — `request.ts` normalises everything to
// ApiError so consumers can do:
//
//   try { await apiClient.salesOrders.get(id) }
//   catch (e) {
//     if (e instanceof ApiError && e.code === "NOT_FOUND") { ... }
//   }
// ---------------------------------------------------------------------------
import type { z } from "zod";

export type ApiErrorCode =
  | "NETWORK"
  | "ABORTED"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION"
  | "CLIENT"
  | "SERVER"
  | "UNKNOWN";

export type ApiErrorOptions = {
  status: number;
  code: ApiErrorCode;
  url: string;
  details?: unknown;
  zodIssues?: z.ZodIssue[];
  cause?: Error;
};

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: ApiErrorCode;
  public readonly url: string;
  public readonly details?: unknown;
  public readonly zodIssues?: z.ZodIssue[];

  constructor(message: string, opts: ApiErrorOptions) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = "ApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.url = opts.url;
    this.details = opts.details;
    this.zodIssues = opts.zodIssues;
  }

  /** True for any error that isn't a deliberate cancellation. */
  get isFailure(): boolean {
    return this.code !== "ABORTED";
  }
}
