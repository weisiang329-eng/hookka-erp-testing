# Bug history and regression policy

`docs/BUG-HISTORY.md` is Hookka ERP's anti-regression ledger. It is not only a
post-mortem log: developers and AI agents must search it before changing a module
so that a solved failure mode is not reintroduced through another write path.

## Before changing code

Run a focused search using business words, route names and category tags:

```sh
npm run bugs:search -- snapshot inventory stale
npm run bugs:search -- supplier payment idempotency
```

Read the matching root causes and regression tests before editing. A similar bug
in another caller is part of the same change surface and should be handled in the
shared rule, not left as a follow-up.

## Recording a bug

Entries stay newest-first and use an immutable, unique ID:

```md
## BUG-YYYY-MM-DD-NNN — user-visible failure `module` `failure-class` 🟢

**Symptom:** what the operator saw and the affected scope.
**Root cause:** the confirmed mechanism, including every affected caller.
**Fix:** the shared rule or boundary changed, plus any data remediation.
**Regression test:** `tests/example.test.mjs` and what old behavior it catches.
**Verified:** staging evidence and production evidence, when promoted.
```

Use 🔴 for identified, 🟡 for in progress and 🟢 only after code and verification
are complete. If a deterministic automated test is genuinely impossible, write
`Regression: N/A — <specific reason and manual check>`; a bare `N/A` is not valid.

## Machine guard

For entries dated 2026-07-20 or later, `npm run bugs:check` requires:

- a status marker and at least one category tag in the heading;
- fixed entries to contain explicit Root cause and Fix sections;
- a referenced, existing `tests/*.test.mjs`, or a specific regression waiver;
- unique IDs across the entire ledger;
- `docs/bug-history-index.json` to exactly match the source document.

Regenerate the compact Admin Health/AI index with `npm run bugs:index`. The
generated file has no timestamp, so unchanged bug history creates no noisy commit.
