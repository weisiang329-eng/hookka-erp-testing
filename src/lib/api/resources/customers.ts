// ---------------------------------------------------------------------------
// customers + customer-hubs + customer-products. CRUD + a couple of derived
// reads under /api/customers/<id>/...
// ---------------------------------------------------------------------------
import { z } from "zod";
import { CustomerSchema, DeliveryHubSchema, ProductSchema } from "../../schemas";
import { arrayOrEnvelope } from "../../fetch-json";
import { buildUrl, getJson, mutateJson } from "../request";
import type { ApiClientOptions, ListParams } from "../request";
import { makeCrud } from "./_crud";

export const customers = {
  ...makeCrud({
    base: "/api/customers",
    schema: CustomerSchema,
    bucket: "master",
  }),
  hubs(customerId: string, options?: ApiClientOptions) {
    return getJson(
      `/api/customers/${customerId}/hubs`,
      arrayOrEnvelope(DeliveryHubSchema),
      "master",
      options,
    );
  },
  products(customerId: string, options?: ApiClientOptions) {
    return getJson(
      `/api/customers/${customerId}/products`,
      arrayOrEnvelope(ProductSchema),
      "master",
      options,
    );
  },
};

export const customerHubs = {
  list(params?: ListParams, options?: ApiClientOptions) {
    return getJson(
      buildUrl("/api/customer-hubs", params),
      arrayOrEnvelope(DeliveryHubSchema),
      "master",
      options,
    );
  },
  get(id: string, options?: ApiClientOptions) {
    return getJson(
      `/api/customer-hubs/${id}`,
      z.object({ data: DeliveryHubSchema }).passthrough(),
      "master",
      options,
    ).then((r) => r.data);
  },
  create(payload: unknown, options?: ApiClientOptions) {
    return mutateJson(
      "/api/customer-hubs",
      "POST",
      z.object({ data: DeliveryHubSchema.optional() }).passthrough(),
      payload,
      { ...options, invalidate: ["/api/customer-hubs", "/api/customers"] },
    );
  },
  update(id: string, patch: unknown, options?: ApiClientOptions) {
    return mutateJson(
      `/api/customer-hubs/${id}`,
      "PUT",
      z.object({ data: DeliveryHubSchema.optional() }).passthrough(),
      patch,
      { ...options, invalidate: ["/api/customer-hubs", "/api/customers"] },
    );
  },
  delete(id: string, options?: ApiClientOptions) {
    return mutateJson(
      `/api/customer-hubs/${id}`,
      "DELETE",
      z.object({ success: z.boolean().optional() }).passthrough(),
      undefined,
      { ...options, invalidate: ["/api/customer-hubs", "/api/customers"] },
    );
  },
  invalidate() {
    return "/api/customer-hubs";
  },
};

export const customerProducts = makeCrud({
  base: "/api/customer-products",
  schema: ProductSchema,
  bucket: "master",
});
