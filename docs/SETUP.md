# Setup

Everything you need to go from a fresh machine to a running dev environment.

---

## Prerequisites

| Tool        | Version    | Why                                              |
| ----------- | ---------- | ------------------------------------------------ |
| Node.js     | ≥ 20.12    | Vite 8 and Hono require modern Node runtime      |
| npm         | ≥ 10       | Ships with Node 20                               |
| Git         | any recent | Only if cloning from a remote                    |

Optional but useful:

- **VS Code** with extensions: ESLint, Tailwind CSS IntelliSense, Prettier
- **Windows Terminal** or similar — two tabs: one for API, one for Vite

Check versions:

```bash
node -v   # v20.x or later
npm -v    # 10.x or later
```

---

## First-time setup

```bash
# 1. Clone (skip if you already have the folder)
git clone <repo-url> hookka-erp-vite
cd hookka-erp-vite

# 2. Install dependencies (npm, not pnpm — lockfile is package-lock.json)
npm install

# 3. Verify the type-check passes before you start hacking
npx tsc --noEmit
```

No `.env` file is required. The API port defaults to 3001 and the Vite dev
server to 3000; if you have a conflict see "Changing ports" below.

---

## Daily workflow

Two long-running processes — open two terminal tabs:

**Terminal 1 — API**

```bash
npm run api
```

Runs `npx tsx src/api/index.ts` with the app tsconfig. You should see:

```
Hookka ERP API server starting on port 3001...
Hookka ERP API server running at http://localhost:3001
```

**Terminal 2 — Vite dev server**

```bash
npm run dev
```

Then open http://localhost:3000. The Vite config proxies `/api/*` to
`localhost:3001` so the browser always talks to relative URLs.

### Hot reload

- Vite HMR is on for every file under `src/`. Edits to pages / components
  update without a full reload.
- The API does **not** hot-reload. Restart `npm run api` after API-route
  changes. (Add `tsx watch` if you want this — the tradeoff is flakier
  behaviour on large file trees.)

---

## Build and preview

```bash
npm run build       # tsc -b (type-check all references) + vite build
npm run preview     # serve the dist/ bundle on localhost:4173
```

Production bundle lands in `dist/`. Both commands fail loud on TypeScript
errors — `npm run build` runs `tsc -b` before `vite build`.

---

## Linting

Flat ESLint config at `eslint.config.js`. Rules:

- `@eslint/js` recommended
- `typescript-eslint` recommended
- `eslint-plugin-react-hooks` flat recommended
- `eslint-plugin-react-refresh` vite preset
- `@typescript-eslint/no-unused-vars` with underscore-prefix ignore pattern

Run it:

```bash
npm run lint          # lint everything
npx eslint src/pages  # lint just pages
```

Barrel export files (`src/components/ui/index.ts`, any `src/**/index.ts`)
have `react-refresh/only-export-components` disabled because their whole job
is to re-export a mix of components, types, and helpers.

---

## Common tasks

### Add a new page

1. Create `src/pages/<module>/index.tsx` (or a subdirectory for multi-screen
   modules).
2. Add a lazy import + route entry in `src/router.tsx`.
3. If it needs API data, add a route file in `src/api/routes/<module>.ts`
   and mount it in `src/api/index.ts`.

### Add a new API endpoint

1. Add a route handler to the relevant file in `src/api/routes/`.
2. If it's a new resource, create the file and mount it in
   `src/api/index.ts`.
3. Restart `npm run api`.

### Add a new status value

Two-step, enforced by the compiler:

1. Add the value to the `type` union in `src/types/index.ts` (or the
   relevant interface in `mock-data.ts`).
2. Add a row in the matching `*_STATUS_COLOR` record in
   `src/lib/design-tokens.ts`. TypeScript will red-underline until you do.

### Add a new colour token

Only when a genuinely new semantic exists (e.g. a new severity). Add it to
`src/lib/design-tokens.ts` as a `SemanticStyle` constant. Do **not** add
ad-hoc `text-[#xxx]` classes in page code.

---

## Changing ports

If 3000 or 3001 is taken:

- **Vite** — edit `server.port` in `vite.config.ts`.
- **API** — set `API_PORT` before `npm run api`:

  ```bash
  API_PORT=3002 npm run api
  ```

  Also update `src/api/index.ts` → `cors.origin` to include the new Vite
  port, and update the Vite proxy target in `vite.config.ts`.

---

## Troubleshooting

### "EADDRINUSE: address already in use"

Something is on the port. Either kill it or switch ports (see above). On
Windows:

```powershell
# find the PID on port 3001
Get-NetTCPConnection -LocalPort 3001 | Select-Object OwningProcess
# then Stop-Process -Id <pid>
```

### `tsx` errors about path aliases

The `@/…` aliases are resolved by `tsconfig-paths` via the tsconfig
referenced in `npm run api`. If you see `Cannot find module '@/lib/…'`,
make sure you ran the script via `npm run api` (not `node` or `tsx src/api/index.ts`
directly) so the tsconfig is picked up.

### `npm install` hangs on Windows

Usually antivirus scanning `node_modules`. Add `node_modules` to the
exclusion list or install with `--prefer-offline` after one clean install.

### ESLint reports React-Refresh errors on a new file

If you're authoring a new barrel / index file that re-exports non-component
symbols, add it to the override block in `eslint.config.js` (same pattern
as `src/components/ui/index.ts`).

### PDFs look wrong in preview

jsPDF honours the system fonts embedded in `lib/pdf-utils.ts`. If a new
generator uses a different font, add the font file to
`src/assets/fonts/…` and register it in `pdf-utils.ts`.

### Dev data resets every time I restart

That's expected — `lib/mock-data.ts` is in-memory. Seed data is re-created
on each `npm run api`. Persisting to a DB is the Extension Point #1 in
`docs/ARCHITECTURE.md`.

### Vite dev server can't reach the API

Check:

1. Is `npm run api` actually running? (`curl http://localhost:3001/health`
   should return `{ "status": "ok", … }`.)
2. Is the proxy target in `vite.config.ts` still `http://localhost:3001`?
3. Is CORS configured for your Vite origin? (See
   `src/api/index.ts` → `cors.origin`.)

---

## IDE tips

- **VS Code path-alias autocompletion** — the `@/*` alias in
  `tsconfig.app.json` is recognised out of the box with the TypeScript
  extension; no extra config needed.
- **Tailwind IntelliSense** — install the official extension. Hex classes
  like `bg-[#EEF3E4]` get a colour preview.
- **Save-on-format** — enable VS Code's "Format on Save" with the Prettier
  extension if you like, but there is no committed Prettier config; the
  codebase tolerates a range of styles.
