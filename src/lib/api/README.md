# `@/lib/api` — Unified API SDK

One typed entry point for every `/api/*` call. Wraps `fetchJson` with
SWR caching, AbortSignal propagation, and a single `ApiError` type.

```ts
import { apiClient, ApiError } from "@/lib/api";
```

## Why this exists

Before: every page wrote its own `fetch(url).then(r => r.json())` plus an
inline Zod schema. ~200 fetch sites in `src/`, drift everywhere.

Now: `apiClient.salesOrders.list()` — autocomplete picks the resource,
the schema is reused from `src/lib/schemas/`, the response is validated,
the SWR cache hands back the previous result instantly while a refetch
runs in the background.

## Patterns

### List + cache

```ts
const orders = await apiClient.salesOrders.list({ status: "PENDING" });
// orders: SalesOrderFromApi[]
//
// Same call within 5s returns the cached array immediately. Repeated
// concurrent callers share a single in-flight request.
```

### Get a single record

```ts
const so = await apiClient.salesOrders.get(soId);
```

### Mutation + invalidate

Mutations always invalidate their domain prefix automatically — no manual
cache-busting needed:

```ts
const updated = await apiClient.salesOrders.update(soId, { status: "CONFIRMED" });
// All cached entries under "/api/sales-orders" are dropped.
```

For mutations that affect multiple domains, the resource module already
declares cross-prefix invalidation. e.g. `salesOrders.confirm` clears
both `/api/sales-orders` and `/api/production-orders`.

### Cancel on unmount

```ts
useEffect(() => {
  const ctrl = new AbortController();
  apiClient.customers.list(undefined, { signal: ctrl.signal })
    .then(setRows)
    .catch((e) => {
      if (e instanceof ApiError && e.code === "ABORTED") return;
      setError(e);
    });
  return () => ctrl.abort();
}, []);
```

### Error handling

```ts
try {
  await apiClient.salesOrders.get(id);
} catch (e) {
  if (e instanceof ApiError) {
    switch (e.code) {
      case "NOT_FOUND":     return show404();
      case "UNAUTHORIZED":  return; // global interceptor will redirect
      case "VALIDATION":    console.error(e.zodIssues); break;
      case "NETWORK":       return showOfflineBanner();
      case "ABORTED":       return; // expected on unmount
      default:              return showGenericError(e.message);
    }
  }
}
```

`ApiError` carries:

- `status` — HTTP status (0 for network/abort)
- `code` — typed enum (`NOT_FOUND`, `VALIDATION`, etc.)
- `url` — the request URL
- `details` — parsed response body, if any
- `zodIssues` — Zod's issue list when validation failed

### Force a refetch (bypass cache)

```ts
const fresh = await apiClient.products.list(undefined, { cache: "no-cache" });
```

### Force-cache (only call network if no entry yet)

```ts
const cached = await apiClient.customers.list(undefined, { cache: "force-cache" });
```

### Override TTL on the call

```ts
const cheap = await apiClient.workers.list(undefined, { ttlSec: 300 });
```

### Manual invalidation

Most calls don't need this — mutations auto-invalidate. But if you have a
mutation that bypasses the SDK (legacy fetch), wipe the SDK cache for the
affected domain:

```ts
import { invalidatePrefix } from "@/lib/api";
invalidatePrefix("/api/sales-orders");
```

To also wipe the legacy page cache from `cached-fetch.ts`:

```ts
import { invalidateCachePrefix } from "@/lib/api";
invalidateCachePrefix("/api/sales-orders");
```

## Resource map

| Domain                | Methods                                                                                              |
|-----------------------|------------------------------------------------------------------------------------------------------|
| `customers`           | `list`, `get`, `create`, `update`, `delete`, `hubs(id)`, `products(id)`                              |
| `customerHubs`        | `list`, `get`, `create`, `update`, `delete`                                                          |
| `customerProducts`    | `list`, `get`, `create`, `update`, `delete`                                                          |
| `products`            | `list`, `get`, `create`, `update`, `delete`                                                          |
| `salesOrders`         | `list`, `get`, `create`, `update`, `confirm`, `delete`                                               |
| `productionOrders`    | `list`, `get`, `create`, `update`, `delete`                                                          |
| `deliveryOrders`      | `list`, `get`, `create`, `update`, `delete`                                                          |
| `invoices`            | `list`, `get`, `create`, `update`, `delete`                                                          |
| `payments`            | `list`, `get`, `create`, `update`, `delete`                                                          |
| `creditNotes`         | `list`, `get`, `create`, `update`, `delete`                                                          |
| `debitNotes`          | `list`, `get`, `create`, `update`, `delete`                                                          |
| `eInvoices`           | `list`, `get`, `create`, `update`, `delete`                                                          |
| `purchaseOrders`      | `list`, `get`, `create`, `update`, `delete`                                                          |
| `grns`                | `list`, `get`, `create`, `update`, `delete`                                                          |
| `suppliers`           | `list`, `get`, `create`, `update`, `delete`                                                          |
| `workers`             | `list`, `get`, `create`, `update`, `delete`                                                          |
| `payslips`            | `list`, `get`, `create`, `update`, `delete`                                                          |
| `attendance`          | `list`, `get`, `create`, `update`, `delete`                                                          |
| `equipment`           | `list`, `get`, `create`, `update`, `delete`                                                          |
| `maintenance`         | `list`, `get`, `create`, `update`, `delete`                                                          |
| `rdProjects`          | `list`, `get`, `create`, `update`, `delete`                                                          |
| `consignments`        | `list`, `get`, `create`, `update`, `delete`                                                          |
| `bomTemplates`        | `list`, `get`, `create`, `update`, `delete`                                                          |

Every resource also exposes `.invalidate()` returning the URL prefix used
for cache busting (handy in tests / mutation handlers).

## TTL buckets

Default cache freshness by domain (override per-call with `ttlSec`):

- `reference` — 60s  (BOM templates, fabric catalogue, etc.)
- `master`    — 15s  (products, customers, suppliers, workers)
- `transactional` — 5s  (sales/production/delivery orders, invoices)
- `report`    — 30s  (aggregates, dashboards)

## Migration notes

This SDK lives **alongside** the existing `fetch` and `fetchJson` helpers.
Pages migrate one at a time. Don't bulk-rewrite.

When migrating a page:

1. Replace the inline schema + `fetchJson` with `apiClient.<domain>.<verb>`.
2. Delete the page-local schema if it duplicates `src/lib/schemas/`.
3. Keep an `AbortController` in your `useEffect` cleanup.
4. Remove manual cache-bust calls — the SDK handles invalidation.

## What's NOT in scope

- WebSocket / SSE — no real-time channel exists yet.
- Optimistic updates — the cache is read-only outside of refetch.
- Retries / exponential backoff — by design; we surface failures fast.
- Batch / bulk endpoints — added per-resource as the API gains them.
