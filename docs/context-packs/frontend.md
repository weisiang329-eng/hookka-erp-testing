# Context Pack: Frontend

Use this pack for React pages, routing, UI components, forms, tables, and browser-side API calls.

> Reuse the shared primitives — don't hand-roll: `PageHeader`/`ObjectPageHeader`, `DataGrid`, `useConfirm`, `MoneyInput`, `DiscountInput`, `SearchableSelect` (UI/PDF/grid standards in `docs/UI-CONVENTIONS.md`). If a new DB column reads back `undefined` on the frontend, suspect the camelCase fold — the API row is `toCamel`'d, so read `r.camelCase ?? r.snake_case` (see `docs/HOOKKA-GOTCHAS.md`).

## Read first

- `src/main.tsx`
- `src/router.tsx`
- `src/dashboard-routes.tsx`
- `src/lib/api-client.ts`
- `src/components/ui/`
- The target module under `src/pages/<module>/`

## Frontend data path

Most pages call same-origin `/api/*` endpoints directly. `src/lib/api-client.ts` patches `window.fetch` so dashboard requests include credentials and CSRF handling consistently.

## Useful searches

```bash
rg -n "fetch\(|/api/" src/pages/<module> src/components src/hooks src/lib
rg -n "useEffect|useMemo|useState|useForm" src/pages/<module>
rg -n "PageHeader|FilterBar|DataGrid|DataTable|StatusBadge" src/pages/<module> src/components
```

## Common follow-up files

- Backend route: `src/api/routes/<resource>.ts`
- Shared types/helpers: `src/lib/`, `src/types/`
- Tests: `tests/*.mjs`
