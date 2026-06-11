# Payroll & Worker Portal — Explanation Guide

Audience: office staff and anyone explaining pay to workers. Everything here
matches the live engine (and the printable **Calculation Guide** button on the
Payroll tab, which produces a worked-example handout for workers).

---

## 1. The Worker Portal (what workers see on their phone)

Workers log in with their employee PIN at `/worker`. Pages:

### Home — Punch In / Punch Out
- One big **Clock In / Clock Out** button. Punching **requires a selfie**
  (front camera opens automatically; cancelling the camera cancels the punch)
  — this is the anti-buddy-punching control.
- The phone's location is captured softly: inside the 200 m factory fence →
  **At factory**; outside → **Off-site** (flagged to the office, never blocks
  the punch); no permission → **No GPS**.
- The punch time uses Malaysia time and lands instantly in the office's
  **Attendance** tab (time + location badge + the two selfies) and pre-fills
  the **Working Hours** grid's Punch column.

### Scan
- Shop-floor job-card scanning (Fab Cut / Fab Sew stickers). Not pay-related.

### My Pay
- **Month picker** (current month = live estimate; past months = the
  finalised payslip).
- The **estimate** updates in real time as Working Hours are keyed and is
  marked "estimate". It becomes final when the office presses
  **Generate (finalise)** at month-end — the numbers match by design because
  both run the same engine.
- Lines shown (tappable lines expand to the exact days):
  - **Full salary** — the worker's monthly salary (effective-dated if a raise
    happened mid-month).
  - **Absent · Nd** — tap to see WHICH days; each confirmed absent working
    day deducts salary ÷ 26.
  - **Late / short hours** — tap to see which days and how many hours were
    docked (after the same-day OT offset).
  - **Basic** — full salary minus absence and late/short.
  - **Overtime · Nh** — tap to see the OT days; weekday 1.5×, Sunday 2×,
    public holiday 3×.
  - **Efficiency allowance** — the flat bonus when the month's cumulative
    efficiency reaches the worker's target (otherwise RM0).
  - **Gross** — basic + OT + allowance. Statutory deductions (EPF/SOCSO/EIS)
    then produce net pay on the payslip.

---

## 2. The pay rules (one page)

| Rule | Value |
|---|---|
| Shift | 08:00–18:00, 1 h unpaid lunch = **9 h standard day**, Mon–Sat |
| Late grace | First 10 minutes forgiven |
| Lateness rounding | Rounds **UP** in 15-min blocks (08:11 → 15 min late) |
| Day rate (unified) | Salary ÷ **26** — the same fixed divisor every month, for every money rule below |
| Late/short rate | Salary ÷ 26 ÷ 10 (= the OT base rate — one hourly rate) |
| OT window | After 18:00 only, 15-min blocks (must fill a block: 16–29 → 15) |
| OT base rate | Salary ÷ 26 ÷ 10 |
| OT multipliers | Weekday 1.5× (per-worker) · **Sunday 2×** · **Public holiday 3×** (whole day counts as OT on Sun/PH) |
| OT offsets lateness | Same-day OT covers the late/short gap 1:1 first; only the remainder is docked |
| Absence | − salary ÷ 26 per confirmed absent working day; a blank day is "Pending" for 2 working days before it becomes an absence; backfilling the hours removes it automatically |
| Join / resign mid-month | No proration — working days not worked (before joining or after the last day) simply count as absences at the ÷26 day rate (e.g. RM4,000: each missed working day deducts RM153.85) |
| Efficiency allowance | Flat per-worker amount, paid only when monthly cumulative efficiency ≥ the worker's target; no proration |
| Statutory | EPF 11% / 13%, SOCSO ~RM7.45 / 26.15, EIS ~RM3.90 / 3.90 — per-worker toggle |

Maintained where:
- **Public holidays** → the Public Holidays panel (drives 3× OT and
  working-day counts).
- **Salary (with effective date), OT multiplier, hours/day, statutory
  toggles, efficiency allowance** → Employee Master.
- **Shift times, lunch, late grace/blocks, the ÷10 hour divisor, Sunday /
  holiday multipliers, absence grace, statutory rates** → the **Pay Rules
  panel** on the Payroll tab. Changes are scheduled with an effective date
  (history is kept; past months keep the rules that were in force).
- The ÷26 day-rate divisor itself is per-worker (Employee Master,
  "working days per month") and the weekday OT multiplier is per-worker —
  everything else above is engine-locked (tested).

---

## 3. The office side (how the three screens relate)

- **Working Hours** — the source of truth for hours. Punches pre-fill the
  Punch column and auto-compute Hours via the same rules (lunch deducted,
  late rounded, OT blocks).
- **Payroll** — the month's pay per worker (estimate mid-month, locked by
  Generate). Columns include the day-typed OT split and the Allowance column;
  expanding a row shows the OT calculation, statutory, pay summary, and the
  exact absent / OT / late days.
- **Labor Cost & Department Labor** — the cost view. Totals always reconcile
  to the same Total Payroll Cost; absence/OT/late/allowance differences are
  attributed to each worker's department line.
- Flow at month-end: key/verify Working Hours → resolve the Under-recorded
  list (Keep pay / Deduct) → **Generate (finalise)** → reconcile (the badge
  shows "Reconciled · 0 difference").

---

## 4. Printable handout

The **Calculation Guide** button on the Payroll tab prints the
worked-example version of this document (RM2,050 / June example for every
rule) — hand that to workers who want the arithmetic.
