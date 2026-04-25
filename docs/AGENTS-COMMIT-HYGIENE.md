# Sub-agent commit hygiene

This repo is routinely worked on by multiple Claude sub-agents in parallel — TS cleanup, governance docs, RBAC migrations, slow-query fixes — sharing one working tree. Without explicit hygiene, agents using `git add -A` accidentally sweep up siblings' pending edits, mislabeling work and making history confusing.

Three commits on 2026-04-25 (`9dc583f`, `1fcd468`, `745801a`) demonstrated the failure mode: each was labeled `fix(ts): migrate X to fetchJson` but actually carried governance docs, CI gate config, cached-fetch dedup, and production-orders chunking — all from a different agent.

## Rules

### 1. Stage only what you touched

```bash
# DO
git add src/pages/products/index.tsx src/lib/schemas/product.ts

# DON'T
git add -A
git add .
git commit -a
```

If you don't remember every file you touched, run `git status` before staging.  Anything you didn't intentionally edit must NOT be in your commit.

### 2. Verify the diff before committing

```bash
git diff --cached --stat
```

If files appear that you didn't touch, unstage them: `git restore --staged path/to/file`.

### 3. Commit message reflects only what's in this commit

If your staged diff is `src/pages/products/*` only, the message is about products. Don't mention work other agents have in their working tree.

### 4. Reference the control board

Where applicable, cite the task ID from `docs/UPGRADE-CONTROL-BOARD.md` (e.g. `Closes P3.1`) so the audit trail back to the 90-day plan is visible.

### 5. Push frequency

Push immediately after each batch lands (`git push origin main`). Holding multiple local commits before push increases the window where another agent's unrelated work might race in.

### 6. If you accidentally swept

Don't try to rewrite history once pushed — other agents may have based work on it. Note the mislabeling in the next commit's message: `chore: note that prior commit X also contained Y from another agent's WIP`. Cite both commits in the control board's Done lane.

## Pre-commit checklist

Before every commit:

- [ ] Ran `git status` and confirm modified files match what I intended to change
- [ ] Used `git add <specific paths>` — never `-A` / `-a` / `.`
- [ ] Ran `git diff --cached --stat` and verified file list
- [ ] Commit message describes only the staged diff
- [ ] If applicable, referenced control-board task ID
- [ ] Pushed within the same batch (don't accumulate multi-batch local commits)

## Why this matters

This repo's git log is the audit trail for a 90-day enterprise upgrade ([PROGRAM-90D-EXECUTION.md](PROGRAM-90D-EXECUTION.md)). When a future engineer asks "when did we add the AbortController to useCachedJson?", `git log src/lib/cached-fetch.ts` should answer cleanly. Sweep-style commits make that lookup return a TS-migration commit that mentions nothing about the actual fix.
