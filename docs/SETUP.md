# Setup

> **Last verified: 2026-08-13** against `package.json` (scripts block), `vite.config.ts:215-224`, `src/api/worker.ts`, `wrangler.toml`, and `ls src/api/`.
> Corrected 2026-08-13: the whole "run the API with `npm run api` / `src/api/index.ts`" workflow was fiction — neither the script nor the file exists; the API is a Cloudflare Pages Function (`functions/api/[[route]].ts` → `src/api/worker.ts`) and is run locally with `npm run dev:worker`.

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
git clone <repo-url> hookka-erp-testing
cd hookka-erp-testing

# 2. Install dependencies (npm, not pnpm — lockfile is package-lock.json)
npm install

# 3. Verify the strict type-check passes before you start hacking
npm run typecheck:app     # tsc -p tsconfig.app.json --noEmit
```

For UI-only work no env file is required. For anything that touches the API
you need `.dev.vars` with a `DATABASE_URL` pointing at a Supabase Postgres —
copy `.dev.vars.example` and fill it in. There is no local D1/SQLite and no
in-memory API server.

---

## Daily workflow

### UI-only (no API)

```bash
npm run dev        # Vite on http://localhost:3000
```

Note: this serves the UI only — `/api/*` calls have no backend here. Until
chore/dead-code-sweep `vite.config.ts` proxied `/api` to
`http://localhost:3001`, but **nothing in this repo has listened on 3001**
since the standalone Node API server (`src/api/index.ts`, `npm run api`) was
removed for Cloudflare Pages Functions. The proxy is gone; the behaviour is
unchanged (it never reached anything).

### Full stack (SPA + real Hono API)

```bash
npm run dev:worker    # wrangler pages dev --port 8787 -- vite
```

This boots the Workers runtime on http://localhost:8787 with
`functions/api/[[route]].ts` → `src/api/worker.ts` mounted at `/api/*`, and
runs Vite behind it. The API talks to Supabase Postgres via `DATABASE_URL`
in `.dev.vars` (Hyperdrive is only bound on Cloudflare, so local dev falls
back to the raw URL — see `pickDbUrl` in `src/api/worker.ts:305`).

### Hot reload

- Vite HMR is on for every file under `src/`. Edits to pages / components
  update without a full reload.
- Worker-side (`src/api/**`) changes are picked up by `wrangler pages dev`
  on save, but a failed rebuild leaves the previous bundle serving — watch
  the wrangler output rather than assuming.

---

## Build and preview

```bash
npm run build         # vite build
npm run build:strict  # typecheck:app && vite build  ← use this before pushing
npm run preview       # serve the dist/ bundle on localhost:4173
```

Production bundle lands in `dist/`. **`npm run build` alone does NOT
type-check** — it is a bare `vite build`. The typecheck gate is
`npm run build:strict`, which is also what CI runs
(`.github/workflows/deploy.yml`, step `npm run build:strict`).

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
   and mount it in `src/api/worker.ts`.

### Add a new API endpoint

1. Add a route handler to the relevant file in `src/api/routes/` (136 route
   files live there).
2. If it's a new resource, create the file and `app.route("/api/<name>", …)`
   it in `src/api/worker.ts`. Mount it **after** `app.use("/api/*",
   authMiddleware)` (`src/api/worker.ts:913`) unless it is deliberately
   public — public routes are mounted above that line to bypass the gate.
3. Use `c.var.DB` (the `SupabaseAdapter` D1-shaped wrapper over Postgres),
   never `c.env.DB` — the D1 binding was retired 2026-04-27.

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

- **Vite** — edit `server.port` in `vite.config.ts` (currently 3000, with
  `host: true` so phones on the same wifi can reach the `/worker` portal).
- **Worker runtime** — edit the `--port 8787` flag in the `dev:worker`
  script in `package.json`.

CORS for the deployed app is driven by the `API_CORS_ORIGIN` var in
`wrangler.toml`, not by a hard-coded origin list in the code.

---

## Troubleshooting

### "EADDRINUSE: address already in use"

Something is on the port. Either kill it or switch ports (see above). On
Windows:

```powershell
# find the PID on port 8787
Get-NetTCPConnection -LocalPort 8787 | Select-Object OwningProcess
# then Stop-Process -Id <pid>
```

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

### Vite dev server can't reach the API

Under plain `npm run dev` it never can — see "Daily workflow" above. Use
`npm run dev:worker` and hit port 8787.

If `npm run dev:worker` is running and `/api/*` still fails:

1. `curl http://localhost:8787/api/health` — a 500 here means the DB, not
   the routing.
2. Is `DATABASE_URL` set in `.dev.vars`? Without it `pickDbUrl`
   (`src/api/worker.ts:305`) has nothing to fall back to, since the
   `HYPERDRIVE` binding only exists on Cloudflare.
3. File-storage routes returning `503 file storage unavailable` are
   expected locally — `SUPABASE_PROJECT_REF` / `SUPABASE_SERVICE_KEY` are
   unset, and `src/api/lib/supabase-storage.ts` fails closed by design.

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
