// ---------------------------------------------------------------------------
// Public SDK entry point. `import { apiClient, ApiError } from "@/lib/api"`.
//
// Re-exports:
//   - apiClient singleton + ApiClient type (client.ts)
//   - ApiError + ApiErrorCode (errors.ts)
//   - ApiClientOptions, ListParams, TtlBucket, DEFAULT_TTL_SEC (request.ts)
//   - cache helpers callers may want for manual invalidation (cache.ts)
//   - all domain types from src/lib/schemas (so callers don't dual-import)
// ---------------------------------------------------------------------------
export { apiClient } from "./client";
export type { ApiClient } from "./client";

export { ApiError } from "./errors";
export type { ApiErrorCode, ApiErrorOptions } from "./errors";

export { DEFAULT_TTL_SEC } from "./request";
export type { ApiClientOptions, ListParams, TtlBucket } from "./request";

export {
  cachedFetch,
  invalidate as invalidateKey,
  invalidatePrefix,
  invalidateCachePrefix,
  clearAll as clearAllSdkCache,
} from "./cache";

// Re-export schema types so consumers get the inferred row shapes from one
// import. Source of truth still lives in src/lib/schemas/*.
export type {
  CustomerFromApi,
  DeliveryOrderFromApi,
  ProductFromApi,
  ProductionOrderFromApi,
  SalesOrderFromApi,
  InvoiceFromApi,
  PaymentFromApi,
  CreditNoteFromApi,
  DebitNoteFromApi,
  RdProjectFromApi,
  WorkerJobCardFromApi,
} from "../schemas";
