# Handoff — invoice top-up (RM 15,480) + DB password rotation

> **Last verified: 2026-08-13** against `scripts/exec-invoice-topup-2026-07-23.mjs`, `scripts/_plan-invoice-topup-2026-07-23.json`, `scripts/audit-billable-2026-07-22.mjs` and `docs/SECURITY-ROTATION-TODO.md`.
> **STEP 2 IS STILL OPEN** — `docs/SECURITY-ROTATION-TODO.md` still exists and still reads "🔴 Secret rotation — OPEN, owner action required". The handoff's own exit condition was "rotate, then delete that TODO file", so the file's presence is the evidence: the prod Supabase password has NOT been rotated as of 2026-08-13.
> **UNVERIFIED ASSERTION** (as of 2026-08-13): whether STEP 1 was ever executed is **not checkable from source** — the script and the frozen plan are both still on disk, but they are idempotent and re-verify live before writing, so their presence proves nothing either way. Run the dry run (`node scripts/exec-invoice-topup-2026-07-23.mjs`) and read its output before assuming the RM 15,480 gap is open or closed. Do not re-run `--execute` on the assumption it never ran.

Everything from the 2026-07-22/23 pricing work is shipped **except two steps that need a
login or a dashboard**, which is why they are handed off rather than done.

## Context (what was already fixed and verified)

- Divan/leg height surcharge is now derived server-side (PR #82) — the leak is stopped.
- 140 **un-shipped** SO lines were re-priced (RM 10,530), read-back clean.
- SO-2607-135 (a partly-shipped SO the status filter had excluded) was corrected on the SO.
- The two class tests + the daily money-invariant check are live (PR #83, #84).
- Fossil price lists deleted and the seeder stopped re-planting them (PR #85).
- DO consolidated-hub label fixed forward (PR #86).
- Dead login password scrubbed from 58 scripts (PR #87).

## STEP 1 — top up 65 issued invoices, then re-send  ⟶ needs a login

154 lines on 65 **SENT, unpaid** invoices bill below their sales order (RM 15,480 total).
They are all in the range the system itself allows editing — `PUT /api/invoices/:id` only
accepts price edits on a **DRAFT or unpaid SENT** invoice (`invoices.ts:1646`), so this uses
the tested path that **restates the GL in lockstep**. Do NOT raw-SQL the invoice rows — that
changes the total without moving the AR/revenue ledger.

The plan is frozen: `scripts/_plan-invoice-topup-2026-07-23.json` (every line's invoice, item
id, current price, target = SO price). Validated: 154 lines, 65 invoices, RM 15,480, 0 lines
missing an id, every target equals the SO unit.

**Run it (in your own terminal — the committed login password was rotated):**

```powershell
$env:HOOKKA_EMAIL="weisiang329@gmail.com"
$env:HOOKKA_PASSWORD="<the current login password>"
node scripts/exec-invoice-topup-2026-07-23.mjs             # dry run — lists each invoice + delta
node scripts/exec-invoice-topup-2026-07-23.mjs --execute   # writes, via PUT /api/invoices
```

The executor **re-verifies every line live before writing**: the invoice must still be live and
unpaid, the item must still under-bill, and `price_edited` must be 0. Anything that no longer
matches is skipped and reported — it never forces a change.

After `--execute`, re-run `scripts/audit-billable-2026-07-22.mjs` to confirm the gap closed,
then **re-send the corrected invoices to the customer** (a person's decision, not automated).

### Deliberately EXCLUDED from the plan — decide separately

- **47 lines, RM 2,405** with `price_edited = 1` — someone revised these on purpose (a
  negotiated price / goodwill / claim). Not touched. Review the list before deciding.
- **4 base-price lines, RM 540** — RM 510 of it is SO-2607-086 L1 `2006(A)-(SP)` billed
  RM 1,140 vs the customer list's RM 1,650. Likely a negotiated special; confirm before changing.
- **337 lines** that could not be matched to a unique invoice line (duplicate SKU + fabric on a
  consolidated invoice). Not in any total above; need manual matching if pursued.
- **PO-009631** (Houzs chasing list) was never keyed into the ERP — someone must create the SO.

## STEP 2 — rotate the prod DB password  ⟶ needs the Supabase dashboard

See `docs/SECURITY-ROTATION-TODO.md`. ~109 scripts carry the live prod Supabase connection
string in plaintext, and it is in git history, so editing files cannot remediate it. Rotate the
DB password in Supabase (project `vpwdqtsxexpiqxzweivd`), update the Cloudflare `HYPERDRIVE` /
`DATABASE_URL` binding and local `.dev.vars`, then delete that TODO file. The dead login
password is already inert; this DB string is the remaining live exposure.

## Why an agent could not finish these two

Both are gated on a credential or a console an automated agent must not drive: entering a
password to authenticate, and rotating a secret in a third-party dashboard. The scripts and the
plan are ready so the human step is one command and one dashboard action.
