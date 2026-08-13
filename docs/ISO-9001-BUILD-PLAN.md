# ISO 9001:2015 — Build Plan (the QMS spine)

> **Last verified: 2026-08-13** against `src/api/routes/` (136 files) and
> `migrations-postgres/` (244 files, latest `0223_trade_finance.sql`).
>
> Corrected 2026-08-13: **nothing in this plan has been built.** Four weeks on, none
> of Phase 1–4 exists in code — there is no `nonconformances` table and no
> `nonconformance`/`ncr`/`capa`/`internal-audit`/`management-review` migration or
> route; the only QMS-adjacent surfaces are still `qc-inspections.ts`,
> `qc-pending.ts`, `qc-templates.ts`, `equipment.ts` and `audit-events.ts` (the
> data-change log, explicitly *not* an internal-audit program). This is a **proposal
> awaiting the owner's go-ahead**, not work in progress.
>
> The closing line "Phase 1 (NCR) mockup is already on screen" refers to a
> `show_widget` render inside the 2026-07-18 chat session. That mockup is not in the
> repo and cannot be recovered — a future agent must re-mock before building.
>
> > **UNVERIFIED ASSERTION** (as of 2026-08-13): the phase ordering, the clause
> > mapping, and the claim that these five modules give the most certification
> > leverage are owner/consultant judgement, not checkable from source.

**Date:** 2026-07-18 · **Owner decision:** build the ISO 9001 quality modules (MFRS goes to the
accountant, not built here — see [MFRS-GAP-ANALYSIS.md](MFRS-GAP-ANALYSIS.md)).
**Source of gaps:** [ISO-9001-GAP-ANALYSIS.md](ISO-9001-GAP-ANALYSIS.md).

---

## The idea in one line

Build the five QMS record modules as **one connected flow**, not five silos: a nonconformance
caught anywhere (QC fail, supplier reject, customer return, audit finding) becomes a numbered
**NCR** → a significant one raises a **CAPA** that only closes on **effectiveness verification**;
**internal audit** feeds the same NCR pipe; **management review** sits on top consuming the
stats; **document control** governs the procedures all of it references.

Everything reuses data the ERP already has. **Nothing touches money.** Each module ships the house
way: **mockup → your approval → build → staging → live-verify → you merge to prod.**

---

## What software can and can't do (the honest boundary)

- ✅ Software builds the **evidence system** — the records an auditor asks to see.
- ❌ Software can't write your **quality manual / procedures**, be the **auditor**, or issue the
  **certificate**. That's you + a consultant + a certification body (registrar).

So this plan makes the ERP carry ~the records side of the standard; you still run the management
system around it.

---

## Phases (dependency-ordered)

### Phase 1 — NCR (Nonconformance register) · clause 8.7 · **the hub**
The biggest single gap and the thing everything else hangs off.
- **New table** `nonconformances` (snake_case, runtime self-apply, numbered `NCR-YYMM-NNN`).
- **Feeds in from existing data:** a QC inspection FAIL (`qc_inspections`), a GRN line rejection
  (`grn_items.rejectedQty`), a customer return (`delivery_returns` / `service_order_returns`) each
  offer a one-click "raise NCR" — no re-keying.
- **Fields:** source + link, item/lot, defect + severity, qty affected + **quarantine**,
  disposition (rework / scrap / accept-as-is / return-to-supplier), owner, **approver**
  (disposition authority — 8.7 requires it), status (open → dispositioned → closed), evidence
  photos (reuse `/api/files`).
- **Closes:** 8.7; strengthens 8.6 and 8.4 (supplier nonconformance revived — the old "Supplier
  NCR" tab that was removed).

### Phase 2 — CAPA (Corrective & preventive action) · clause 10.2
Extends the CAPA shape that already exists on service cases; adds the missing closure.
- **Reuse** the service-case root-cause + preventive-action structure (`service_cases`
  rootCauses / preventionAction / preventionStatus), promoted to a general CAPA that ANY NCR can
  raise (not just customer complaints).
- **Adds the missing step:** `containment`, and **effectiveness verification** (verifier + date +
  re-check) — a CAPA can't reach "closed" without it (10.2.1 e/f).
- **Closes:** 10.2 (closed-loop, multi-trigger).

### Phase 3 — Document control + Internal audit · clauses 7.5 & 9.2 (parallel-ish, both new registers)
- **Document control (7.5):** add revision number + approval state + effective/obsolete to the
  existing product document library (CNC templates, production docs already treated as masters).
  A controlled-document register; superseded copies marked obsolete.
- **Internal audit (9.2):** schedule audits (by process / department / clause) → checklist →
  findings; a nonconformity finding raises an NCR/CAPA (into the Phase-1 pipe) → closure tracked.
  Distinct from the existing `audit_events` data-change log.

### Phase 4 — Management review · clause 9.3 · **the roof**
- A periodic review record whose **inputs auto-populate** from what now exists: audit results,
  NCR/CAPA stats, the daily/weekly/monthly operations reports, customer returns/feedback, supplier
  scorecards. You fill in **outputs**: decisions, action items, resource needs.
- **Closes:** 9.3.

---

## Deferred on purpose (do after the paper spine)

- **QC release gate at DO dispatch (8.6)** — the one change that touches the LIVE dispatch flow
  (block, or override-with-sign-off, until shipped units' QC is PASS). Higher risk, so it comes
  after the evidence modules are solid.
- **P2:** Approved Vendor List gate + re-evaluation (8.4); skills/training matrix (7.2).
- **P3:** unit→material-lot genealogy (8.5.2 — finish the deferred FIFO consumption link);
  calibration register (7.1.5); risk register (6.1).

---

## How each module ships (the process, every time)

1. **Mockup** via show_widget → you approve the fields + flow (per house rule: mockup before build).
2. **Build** — new snake_case table(s) + runtime self-apply; backend route; page under a new
   **Quality / QMS** area; reuse DataGrid / Confirm / `/api/files`.
3. **build:strict** typecheck + unit tests (money-grade discipline even though no money here).
4. **Staging** first (features → staging, house rule) → live-verify the read AND write path.
5. **You merge to prod** on explicit OK (never auto-merge a feature).
6. Log in BUG-HISTORY if any bug found; refresh the CODEBASE-MAP entry.

---

## What I need from you to keep moving

- **Phase 1 (NCR) mockup is already on screen** — confirm the fields/flow (or add: claim amount,
  recurrence count, etc.) and I build it.
- After NCR, I'll mockup CAPA, then document control + internal audit, then management review — one
  at a time, your approval between each.
- No accountant/consultant needed for these five (they're internal records). The certificate,
  procedures, and the QC-release-gate policy are the parts that involve people outside the ERP.

Tracked in [WORK-TRACKER.md](WORK-TRACKER.md); decisions in memory `project_iso9001_mfrs_program`.
