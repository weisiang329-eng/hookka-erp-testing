# Program Execution Status (6 Major Tasks)

## How execution works
- You do **not** need to click each task manually in this repository.
- Work executes through code commits and CI workflows.
- Planning docs are not auto-running jobs; implementation starts when corresponding code/infra changes are merged.

## Current status snapshot

| Task | Status | Execution started? | Notes |
| --- | --- | --- | --- |
| 1. Startup/UX performance hardening | In progress | Yes | Keep-alive cap, deferred BOM hydration, hidden-tab polling pause landed. |
| 2. CI/testing baseline | Complete | Yes | Smoke tests are running in CI deploy workflow before build. |
| 3. TypeScript high-priority bug fixes | In progress | Yes | TS1294/fetch-json, password salt typing, setConfig bug fixed; broad app debt now ~190 TS errors. |
| 4. Broad fetch migration (`res.json()` -> `fetchJson`) | Not started at scale | Partially | Needs staged conversion across many pages. |
| 5. React hooks lint debt refactor | Not started at scale | No | Needs module-by-module refactor sprint. |
| 6. Docs alignment to current runtime architecture | In progress | Partial | Index + execution status added; full README/architecture rewrite still pending. |

## What is already "running" in CI
- `npm test` (smoke suite)
- `npm run build`
- Cloudflare deploy on push according to workflow conditions

## Next recommended execution order
1. Sales/Delivery/Production fetch migration (highest traffic first).
2. Update README/ARCHITECTURE/CLOUDFLARE docs to match Supabase+Hyperdrive reality.
3. Tackle hook lint debt in targeted modules after fetch migration stabilizes.
