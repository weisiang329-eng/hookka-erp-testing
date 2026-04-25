// ---------------------------------------------------------------------------
// Tiny CRUD factory used by resources whose API follows the standard pattern:
//
//   GET    /api/<base>          → list
//   GET    /api/<base>/:id      → single
//   POST   /api/<base>          → create
//   PUT    /api/<base>/:id      → update
//   DELETE /api/<base>/:id      → delete
//
// Every list endpoint in this codebase returns either a bare array or
// `{ success, data: [...] }`; `arrayOrEnvelope` collapses both into `T[]`.
// Single-record endpoints return `{ success, data: {...} }`; we unwrap to
// the bare row.
//
// Resources with non-CRUD verbs (e.g. salesOrders.confirm) override their
// own file rather than use this factory.
// ---------------------------------------------------------------------------
import type { z } from "zod";
import { arrayOrEnvelope, envelope } from "../../fetch-json";
import { MutationResultSchema } from "../../schemas";
import { buildUrl, getJson, mutateJson } from "../request";
import type { ApiClientOptions, ListParams, TtlBucket } from "../request";

export type CrudResource<T> = {
  list(params?: ListParams, options?: ApiClientOptions): Promise<T[]>;
  get(id: string, options?: ApiClientOptions): Promise<T>;
  create(payload: unknown, options?: ApiClientOptions): Promise<T>;
  update(id: string, patch: unknown, options?: ApiClientOptions): Promise<T>;
  delete(id: string, options?: ApiClientOptions): Promise<unknown>;
  /** Returns the URL prefix used for cache invalidation. */
  invalidate(): string;
};

export function makeCrud<TSchema extends z.ZodTypeAny>(opts: {
  base: string;
  schema: TSchema;
  bucket?: TtlBucket;
}): CrudResource<z.infer<TSchema>> {
  type Row = z.infer<TSchema>;
  const { base, schema, bucket = "master" } = opts;
  const ListSchema = arrayOrEnvelope(schema);
  const SingleEnvelope = envelope(schema);

  // The envelope type is widened to a generic ZodObject by Zod's helpers, so
  // direct `.data` access trips structural typing. Pull the row off via a
  // local cast — runtime shape is guaranteed by the schema's safeParse.
  const unwrap = (raw: unknown): Row => (raw as { data: Row }).data;

  return {
    list(params, options) {
      return getJson(buildUrl(base, params), ListSchema, bucket, options) as Promise<Row[]>;
    },
    get(id, options) {
      return getJson(`${base}/${id}`, SingleEnvelope, bucket, options).then(unwrap);
    },
    create(payload, options) {
      return mutateJson(base, "POST", SingleEnvelope, payload, {
        ...options,
        invalidate: base,
      }).then(unwrap);
    },
    update(id, patch, options) {
      return mutateJson(`${base}/${id}`, "PUT", SingleEnvelope, patch, {
        ...options,
        invalidate: base,
      }).then(unwrap);
    },
    delete(id, options) {
      return mutateJson(
        `${base}/${id}`,
        "DELETE",
        MutationResultSchema,
        undefined,
        {
          ...options,
          invalidate: base,
        },
      );
    },
    invalidate() {
      return base;
    },
  };
}
