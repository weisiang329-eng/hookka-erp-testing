# Onboarding Path — how to get productive without grepping

New here (human or AI)? This repo is large and `grep`/`glob` over the whole tree **time out**.
You never need them. Read your way in through these layers instead:

```
L1  CODEBASE-MAP  →  which module owns it, where the files are
L2  modules/<x>   →  how that module works + the exact function:line
L3  SYMBOLS       →  jump to any API endpoint by path
+   GOTCHAS       →  the traps that will bite (schema/money/SQL/ship)
```

## Day-1 read order (top-down)
1. **`CLAUDE.md`** (repo root, outside this folder) — the non-negotiable rules + the fast-path links. Loaded automatically every session; Claude reads it itself, you never open it.
2. **[[CODEBASE-MAP]]** — the single authoritative map. Skim all module headers so you know what exists.
3. **[[HOME]]** — the Obsidian home note; hub for everything below.
4. **[[HOOKKA-GOTCHAS]]** — read before touching schema, money, SQL, or shipping. These are the real time-savers.
5. Pick the area you're working in and open its **module guide** (`docs/modules/*.md`) — see the map below.

## "I need to change X" — the 3-step jump (never grep)
1. Open **[[CODEBASE-MAP]]**, find the module → note its files.
2. Open that **module guide** (`docs/modules/<module>.md`) → its *Core flows* + *Key functions* table gives you the exact `file:line`.
3. Need an API endpoint? Ctrl-F **[[SYMBOLS]]** for the path (e.g. `POST /api/invoices`) → handler `file:line`.
Then `Read` that file at that line with an offset. No searching.

## Mental model — how the modules connect (business flow order)
Read the guides in this order to understand the system end-to-end; each links to the next:

1. [[products]] — the catalog + BOM (what we make)
2. [[sales]] — customer orders (SO / consignment); confirming an SO drives everything downstream
3. [[production]] — SO → production orders / job cards / WIP (how it's built)
4. [[inventory]] — raw materials in, finished goods out, warehouse racks
5. [[procurement]] — buying materials (PO → GRN → Purchase Invoice → supplier payment)
6. [[delivery]] — finished goods out the door (DO / Consignment Notes / 3PL)
7. [[accounting]] — the money spine: invoices, payments, GL, P&L (everything posts here)

Supporting modules: [[customers]] · [[employees]] · [[planning]] · [[dashboard]] · [[service-repair]] · [[reports]] · [[quality-warehouse]] · [[rnd]]

## The golden rules (full list in [[HOOKKA-GOTCHAS]])
- **Never `grep`/`glob` the whole repo** — it times out. Use the map + guides + SYMBOLS.
- **Money = integer sen** (RM × 100). Never floats.
- **New DB columns = snake_case**; migrations only reach prod via runtime self-apply.
- **Money / inventory / auth changes**: investigate → propose → confirm → PR + `build:strict` + verify on prod.
- **Update-on-touch**: edit a module → refresh its `docs/modules/*.md` entry as a byproduct so this never goes stale.
