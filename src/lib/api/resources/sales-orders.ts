// ---------------------------------------------------------------------------
// salesOrders — typed wrapper around /api/sales-orders.
//
// `confirm` returns an envelope with both the SO and the production-orders
// generated from it; we model that explicitly so callers don't have to cast.
// ---------------------------------------------------------------------------
import { z } from "zod";
import { arrayOrEnvelope, envelope } from "../../fetch-json";
import {
  ProductionOrderSchema,
  SalesOrderSchema,
  MutationResultSchema,
} from "../../schemas";
import { buildUrl, getJson, mutateJson } from "../request";
import type { ApiClientOptions, ListParams } from "../request";

const BASE = "/api/sales-orders";
const PREFIX = "/api/sales-orders";

const ListSchema = arrayOrEnvelope(SalesOrderSchema);
const SingleEnvelope = envelope(SalesOrderSchema);
const ConfirmSchema = z
  .object({
    success: z.boolean().optional(),
    data: SalesOrderSchema.optional(),
    productionOrders: z.array(ProductionOrderSchema).optional(),
  })
  .passthrough();

export const salesOrders = {
  list(params?: ListParams, options?: ApiClientOptions) {
    return getJson(buildUrl(BASE, params), ListSchema, "transactional", options);
  },
  get(id: string, options?: ApiClientOptions) {
    return getJson(`${BASE}/${id}`, SingleEnvelope, "transactional", options).then(
      (r) => r.data,
    );
  },
  create(payload: unknown, options?: ApiClientOptions) {
    return mutateJson(BASE, "POST", SingleEnvelope, payload, {
      ...options,
      invalidate: PREFIX,
    }).then((r) => r.data);
  },
  update(id: string, patch: unknown, options?: ApiClientOptions) {
    return mutateJson(`${BASE}/${id}`, "PUT", SingleEnvelope, patch, {
      ...options,
      invalidate: PREFIX,
    }).then((r) => r.data);
  },
  confirm(id: string, body?: unknown, options?: ApiClientOptions) {
    return mutateJson(`${BASE}/${id}/confirm`, "POST", ConfirmSchema, body ?? {}, {
      ...options,
      invalidate: [PREFIX, "/api/production-orders"],
    });
  },
  delete(id: string, options?: ApiClientOptions) {
    return mutateJson(`${BASE}/${id}`, "DELETE", MutationResultSchema, undefined, {
      ...options,
      invalidate: PREFIX,
    });
  },
  invalidate() {
    // Helper for callers that want to wipe SO cache without making a call.
    return PREFIX;
  },
};
