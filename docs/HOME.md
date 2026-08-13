# Hookka ERP — Docs Home

> **Last verified: 2026-08-13** — links updated for the doc-vs-code reconciliation.
> **Check the `Last verified:` line under any doc's title before trusting it.**
> No line, or an old date, means UNVERIFIED — read the code first.

Open `docs/` as an Obsidian vault and start here. `[[wikilinks]]` resolve by note name across
any folder.

## Fast path (read in this order)
- [[CODEBASE-MAP]] — **find code by file:line; never grep the repo (it times out)**
- [[PLAYBOOKS]] — fixed steps for recurring tasks
- [[HOOKKA-GOTCHAS]] — hard-won traps (schema / money / SQL / ship)
- [[DEV-OPERATING-FRAMEWORK]] — how deep to review (fast-lane vs focused vs deep)
- [[DOCS-INDEX]] — the full documentation index

## Product & domain reference
- [[MODULES]] — module-by-module product reference (what each does)
- Domain packs (`context-packs/`): [[architecture]] · [[backend]] · [[frontend]] · [[database]] · [[core-flow]] · [[security]]
- [[API]] (generated — `node scripts/gen-api-docs.mjs`) · [[DESIGN-SYSTEM]] · [[UI-CONVENTIONS]] · [[BUG-HISTORY]] · [[KNOWN-ISSUES]]

## Active programs
- [[ISO-9001-BUILD-PLAN]] · [[WORK-TRACKER]]
  (`PROGRAM-90D-EXECUTION` and `UPGRADE-CONTROL-BOARD` were archived 2026-08-13 — the
  90-day programme ended in July and neither had been updated since April.)

## History
- `archive/` holds retired one-off docs (audits, handoffs, dated readouts). Kept for git history,
  out of the hot path so agents don't wade through them.

## Module deep guides (L2) — open FIRST for any module
Verified, kept-fresh; each has function→line, flows, gotchas, common tasks.

[[sales]] · [[procurement]] · [[delivery]] · [[accounting]] · [[production]] · [[inventory]] · [[products]] · [[customers]] · [[employees]] · [[planning]] · [[dashboard]] · [[service-repair]] · [[reports]] · [[rnd]] · [[quality-warehouse]]

## Find fast
- [[ONBOARDING-PATH]] — how to get productive without grepping (the reading order)
- [[SYMBOLS]] — API endpoint index; Ctrl-F the path instead of grepping
