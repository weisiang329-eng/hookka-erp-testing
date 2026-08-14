# ISO 9001:2015 — Gap Analysis for Hookka ERP

> **Last verified: 2026-08-14** (branch `docs/docs-vs-code-audit`) — corrected against the
> source by the prose audit; the row(s) touched here are itemised in
> [`docs/DOCS-VS-CODE-AUDIT.md`](DOCS-VS-CODE-AUDIT.md). Only the claims listed there were
> re-verified; the rest of this file still carries its earlier stamp.

> **Last verified: 2026-08-13** against `src/api/routes/` (136 route files — no
> `ncr`/`nonconformance`/`capa`/`internal-audit`/`management-review`/`calibration`/
> `risk` route exists), `migrations-postgres/` (244 files — no such table exists),
> `src/pages/quality.tsx`, `src/api/routes/qc-inspections.ts`,
> `src/api/routes/qc-pending.ts`, `src/api/routes/fg-units.ts`,
> `src/api/lib/fg-batch-link.ts`, `migrations-postgres/0177_document_lifecycle.sql`.
>
> **Every 🔴 gap is still open on 2026-08-13** — nothing from the build plan was
> built. QC is still explicitly non-gating (`quality.tsx:16`: "Tags are informational,
> not gating — production keeps running"), and DO dispatch still runs no QC check.
> `0177_document_lifecycle.sql` is **not** ISO 7.5 document control: it is
> ACTIVE/VOID/DELETED state on *financial documents* for the GL audit log.
>
> Corrected 2026-08-13, two "Have" descriptions have moved on:
> - **8.6** — QC generation was reworked 2026-08-08 into three stage rhythms (RM one
>   inspection per goods receipt per material family; WIP one slot per working
>   department per run; FG a sampled share of units, each bound to ONE unit and its SO
>   line — `src/api/routes/qc-pending.ts`), plus risk-weighted FG sampling
>   (`0218_qc_fg_risk_weighted_sample.sql`, `src/api/lib/qc-fg-risk.ts`). A WIP fail
>   now also resets the job card to BLOCKED. The clause verdict (non-gating) is
>   unchanged; the evidence paragraph is out of date.
> - **8.5.2** — the "`fg_units.batchId` is a random number" line is stale. The column
>   was NULL on all 4,866 rows and now has a WRITER — stamped at completion, with a
>   backfill ladder available and a backfill endpoint at `fg-units.ts:998-1021`.
>   **Whether that backfill has been RUN on prod is UNMEASURED** (this branch has no DB
>   credentials); the in-repo note at `stock-breakdown.ts:509-516` says it had NOT been as
>   of 2026-08-08, which is what `ERP-FEATURE-GAP.md` still reports — the two docs
>   disagreed, and the honest answer is UNMEASURED. The ladder is (`src/api/lib/fg-batch-link.ts`, `fg-completion.ts`,
>   `fg-ledger-reconcile.ts`), linking a piece to its **cost lot**. The genuine gap —
>   unit → physical *material lot* genealogy — is still open.
>
> > **UNVERIFIED ASSERTION** (as of 2026-08-13): the clause interpretations, the
> > "~80% of the records" estimate, what a registrar will ask for, and the suggested
> > build order are professional judgement, not checkable from source. Treat as owner
> > intent, not fact.

**Date:** 2026-07-18 · **Status:** assessment only — NO code changed.
**Purpose:** owner asked whether the ERP can align to ISO 9001, and to see the gaps first.

---

## The one honest caveat (read this first)

**ISO 9001 certification is not something software achieves.** It also needs written
procedures (a quality manual), management commitment, trained staff, internal audits,
and an external certification body (registrar) that audits and issues the certificate.
**The ERP's job is to be the system-of-record that makes the evidence easy to produce**
— it can carry ~80% of the *records* an auditor asks to see, but it can't be certified
by itself.

The good news: the ERP is already a **strong operational + traceability backbone**. Most
gaps below are the *formal QMS scaffolding* (numbered NCRs, audit program, review records)
rather than missing operational data.

---

## Executive summary

| ISO 9001:2015 clause | Where we stand | Severity |
|---|---|---|
| 8.5.2 Identification & traceability | Document chain SO→PO→JC→DO→Invoice + per-unit QR is strong; **but a finished unit can't be traced to the physical material lot** | 🟡 partial |
| 8.6 Release of products | QC inspections exist but are **explicitly non-gating**; dispatch runs no QC check | 🔴 gap |
| 8.7 Control of nonconforming outputs | Returns have disposition; **no numbered NCR** for in-line/incoming nonconformance | 🔴 gap |
| 10.2 Nonconformity & corrective action (CAPA) | Service cases capture root cause + preventive action; **no effectiveness-verification, complaint-triggered only** | 🟡 partial |
| 7.5 Documented information (document control) | File storage + change-logging only; **no revision/approval/obsolete control** | 🔴 gap |
| 8.4 Externally provided processes (suppliers) | Performance scorecards + incoming QC + 3-way match strong; **no Approved Vendor List gate or re-evaluation cycle** | 🟡 partial |
| 7.1.5 Monitoring & measuring resources (calibration) | Preventive **maintenance** register exists; **no calibration register** | 🔴 gap |
| 7.2 / 7.1.6 Competence & knowledge | Position/department only; **no training records or skills matrix** | 🔴 gap |
| 9.2 Internal audit | Data-change audit **logs** only; **no QMS audit program** | 🔴 gap |
| 9.3 Management review | Operational reports only; **no management-review record** | 🔴 gap |
| 6.1 Risks & opportunities | **No risk register** | 🔴 gap |

Strong foundations: 8.5.2 (document chain), 8.4 (supplier performance / 3-way match),
9.1 monitoring (operations reports, KPIs — not listed above but well covered).

---

## Detail + code evidence

### 8.5.2 Identification & traceability — 🟡 partial
**Have:** the full document chain is assembled and shown — `sales-orders.ts:3161/3220/3277`
(linkedDOs / linkedInvoices / linkedPOs), rendered in `sales/detail.tsx`. Per-unit identity
+ QR sticker per finished unit with PACK→LOAD→DELIVER→RETURN timestamps and packer identity
(`fg-units.ts:439/798-897`). Fabric identification by code (`fabric-tracking.ts:38`,
`production-orders.ts:293`).
**Gap:** a finished unit's `fg_units.batchId` — **corrected 2026-08-14: not a random number.** It has a real writer (see the banner); the surviving gap is that unit → physical *material lot* genealogy is still not
roll / GRN batch (`fg-units.ts:415`) — there is no link from the unit to the physical
material lot. FIFO material consumption at PO completion is a deferred TODO
(`production-orders.ts:13-17`). Scan state is overwrite-in-place, not an append-only scan log.
→ *For certification:* genealogy from unit → material lot, and an append-only scan event log.

### 8.6 Release of products — 🔴 gap
**Have:** numbered QC inspections `QC-YYMM-NNN`, per-item PASS/FAIL/NA, templates
(`qc-inspections.ts:108-147`, `qc-templates.ts`), cron-generated pending inspections.
**Gap:** QC is **explicitly non-gating** — the code says so (`quality.tsx:10-12`: "Tags are
informational, not gating — production keeps running"). DO dispatch performs **no QC check**
(`delivery-orders.ts` LOADED/dispatch path has zero QC references). No authorized release
sign-off per unit/DO.
→ *For certification:* a release gate — dispatch blocked (or explicitly overridden with sign-off)
until the shipped units' QC is PASS.

### 8.7 Control of nonconforming outputs — 🔴 gap
**Have:** returned-goods disposition exists — service returns `PENDING_DECISION → REPAIRABLE →
SCRAPPED` with stock adjustment (`service-orders.ts:1295-1508`); delivery returns with per-item
disposition (`delivery-returns.ts:323-352`). QC defects carry a bare `actionTaken` enum.
**Gap:** **no formal Nonconformance Report (NCR)** — no numbered record with a controlled
disposition (rework / scrap / accept-as-is / return-to-supplier) as a first-class entity, and
`actionTaken` is never surfaced in the UI. The "Supplier NCR" tab was deliberately removed
(`quality.tsx:17`). No quarantine/segregation of nonconforming stock.
→ *For certification:* a numbered NCR entity with disposition + approver, covering in-line and
incoming (supplier) nonconformance, not just customer returns.

### 10.2 Nonconformity & corrective action (CAPA) — 🟡 partial
**Have:** genuine CAPA-shaped record on service cases — root cause (`rootCauseCategory` +
multi-cause array), preventive action + owner + status `PENDING/IN_PROGRESS/DONE/NOT_NEEDED`,
5W issue description, pipeline stepper, action log (`service-cases.ts:30-96`,
`service-cases/detail.tsx`). Tested.
**Gap:** no **effectiveness-verification** step to close the loop (ISO 10.2.1 e/f) — prevention
ends at `DONE`, self-declared, no verifier/date/re-check. Containment/correction isn't a distinct
field. CAPA is **complaint-triggered only** — internal QC fails, NCRs, and supplier
nonconformance don't feed a corrective-action record.
→ *For certification:* an "effectiveness verified" closure field, and CAPA links from QC/NCR/supplier.

### 7.5 Documented information (document control) — 🔴 gap
**Have:** file storage (`file_assets`: filename/type/size/uploadedBy/uploadedAt,
`files.ts:177-320`) with who-uploaded-what change-logging to `audit_events`. Production Docs
library + CNC "single source of truth" by convention (`products/documents.tsx`). A real
approval workflow exists **but only for supplier prices** (`price-history.ts` APPROVED/PENDING/
REJECTED), not documents.
**Gap:** no document version/revision numbering, no approval/sign-off state or approver on
documents, no obsolete-copy / superseded control, no review/effective date.
→ *For certification:* revision number + approval state + effective date + obsolete control on
controlled documents (starting with the CNC templates / production docs already treated as masters).

### 8.4 Control of externally provided processes (suppliers) — 🟡 partial
**Have (strong):** supplier scorecards — live on-time rate, defect rate, avg lead days, overall
rating from POs + GRNs (`supplier-scorecards.ts:280-322`). Incoming-goods inspection — GRN lines
carry `acceptedQty`/`rejectedQty`/`qcStatus` (`grn.ts:175-176`). Three-way match PO↔GRN↔PI with
2% tolerance (`three-way-match.ts`). Supplier master has status/rating/priority.
**Gap:** no **Approved Vendor List** gate — supplier status is only ACTIVE/INACTIVE and nothing
blocks a PO against an unapproved vendor; the approve/pending/reject workflow is on prices, not
vendors. No periodic re-evaluation date/cycle. Supplier NCR register was removed.
→ *For certification:* an AVL approval gate on suppliers + a re-evaluation cadence; restore a
supplier-nonconformance path.

### 7.1.5 Monitoring & measuring resources (calibration) — 🔴 gap
**Have:** an equipment register with preventive-**maintenance** cycle + logs
(`equipment.ts:17-44`). That is 7.1.3 infrastructure, not calibration.
**Gap:** no calibration register for measuring equipment — no last-calibrated / calibration-due
/ reference-standard / certificate fields anywhere.
→ *For certification:* a calibration register (may be light-scope for furniture — tape measures,
moisture meters, scales — but auditors expect it to exist).

### 7.2 / 7.1.6 Competence & organizational knowledge — 🔴 gap
**Have:** employees carry position + department(s); labour/performance surfaces exist.
**Gap:** no training records, no competence/skills matrix, no certification/qualification fields.
Department assignment is not a competence record.
→ *For certification:* a per-worker skills/training matrix (which processes each worker is
qualified for, training dates, re-training due).

### 9.2 Internal audit — 🔴 gap
**Have:** `audit_events` — a "who changed what and when" data-change trail (`audit-events.ts`).
**Gap:** this is transaction auditing, **not** a QMS internal-audit program — no audit schedule/
plan, auditor assignment, findings, or nonconformity closure.
→ *For certification:* an internal-audit module (schedule → checklist → findings → closure),
distinct from the data-change log.

### 9.3 Management review — 🔴 gap
**Have:** daily/weekly/monthly operational reports (`reports.ts`, `compliance-report.ts`,
`daily-report.tsx`, `hookka-report-editions.tsx`) — excellent *inputs* to a review.
**Gap:** no management-review **record** — no minutes, review inputs/outputs, decisions, action
items, or scheduled cadence.
→ *For certification:* a management-review record that pulls the existing reports as its inputs
and captures decisions + actions.

### 6.1 Risks & opportunities — 🔴 gap
**Have:** nothing.
**Gap:** no risk/opportunity register, scoring, or mitigation tracking.
→ *For certification:* a simple risk register tied to QMS processes.

---

## Suggested build order (owner decides — nothing built yet)

Auditors always open with document control, NCR/CAPA closure, internal audit, and management
review, so those give the most certification leverage per unit of effort. The operational data
(traceability, QC, supplier performance) is already the hard part and it's largely done.

**P1 — the QMS spine auditors check first (mostly new record modules, reuse existing data):**
1. **Formal NCR** entity (numbered, disposition, approver) + wire QC-fail and supplier-reject into it (8.6/8.7).
2. **CAPA effectiveness-verification** closure field on service cases + feed NCRs into CAPA (10.2).
3. **Document control** — revision # + approval + effective/obsolete on the CNC/production docs (7.5).
4. **Internal audit** module (schedule → findings → closure) (9.2).
5. **Management review** record that consumes the existing reports (9.3).

**P2 — operational conformance:**
6. **QC release gate** at DO dispatch (8.6) — the one change that touches live dispatch flow, needs care.
7. **Approved Vendor List** gate + re-evaluation cadence on suppliers (8.4).
8. **Skills/training matrix** per worker (7.2).

**P3 — completeness:**
9. **Unit → material-lot genealogy** (finish the deferred FIFO consumption link) (8.5.2).
10. **Calibration register** (7.1.5) + **risk register** (6.1) — light modules.

Each is a normal feature: **mockup → owner approval → staging → prod**, per house rules. None
touch money. The one to flag as higher-risk is #6 (QC release gate) because it gates live dispatch.

Related: [MFRS-GAP-ANALYSIS.md](MFRS-GAP-ANALYSIS.md) (accounting side).
