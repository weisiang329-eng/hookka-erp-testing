# Employees & Payroll — Module Guide

> **Last verified: 2026-08-14** (branch `docs/docs-vs-code-audit`) — corrected against the
> source by the prose audit; the row(s) touched here are itemised in
> [`docs/DOCS-VS-CODE-AUDIT.md`](../DOCS-VS-CODE-AUDIT.md). Only the claims listed there were
> re-verified; the rest of this file still carries its earlier stamp.

> **Last verified: 2026-08-13** against `src/pages/employees.tsx`, `src/lib/labor-engine.ts`, `src/lib/costing.ts`, `src/api/routes/{workers,worker,worker-auth,payslips,payroll,payroll-hour-deductions,working-hour-entries,attendance,departments,department-performance}.ts`, and `tests/labor-engine.test.mjs`.
> Corrected 2026-08-13: `employees.tsx` is 11,746 lines (was 11002) and every tab-component anchor had drifted 130–740 lines — `EmployeesPage` is at **:11424**, not :10684. `worker.ts` is 4,130 lines (was 3539), `payslips.ts` 1,353 (was 1095), `department-performance.ts` 807 (was 680). All `labor-engine.ts` anchors were within ~45 lines and are refreshed to exact.

> Self-navigating docs (L2). Repo-wide map: [[CODEBASE-MAP]]. Never grep the whole repo — use the file:line below.

## What it does
Owns the whole workforce lifecycle: the **employee master** (workers + effective-dated salary), the **factory-worker mobile app** (PIN login → clock in/out, department scans, packing, payslip/leave/issue self-service), **working-hour capture** (the efficiency numerator/denominator), and **payroll** — draft payslip generation, statutory deductions, day-typed OT, and short-hour docks. The payroll/cost math is the most coupled part of the repo: one engine (`src/lib/labor-engine.ts`) drives three reconciling screens (Payroll / Dept Labor / Labor Cost). Pay-side absence/late/OT use a unified ÷26 rate; cost-side uses the real Mon–Sat working-day count. Money is integer sen throughout.

## Entry points
- **Admin pages**
  - `/employees` → `src/pages/employees.tsx` (11,897 lines) — 9-tab admin shell. `EmployeesPage` shell + tab switch at **:11572**; the `activeTab` render block is at the tail of that component.
  - Worker mobile app (X-Worker-Token auth): `src/pages/worker/index.tsx` (home), `scan.tsx` (clock/dept-scan/packing, 3218), `pay.tsx` (payslip), `me.tsx` (profile), `team.tsx`, `issue.tsx`, `qc.tsx`, `login.tsx` (PIN).
- **API routes**
  - Employee master + effective-dated salary → `src/api/routes/workers.ts` (1266)
  - Worker mobile self-service backend → `src/api/routes/worker.ts` (4220)
  - PIN auth (login / reset / logout / me) → `src/api/routes/worker-auth.ts` (349)
  - Working-hour entries (efficiency source) → `src/api/routes/working-hour-entries.ts` (1643)
  - Payroll run header → `src/api/routes/payroll.ts` (205); payslip generate/read → `src/api/routes/payslips.ts` (1625)
  - Short-hour docks → `src/api/routes/payroll-hour-deductions.ts` (418)
  - Salary advances → `src/api/routes/employee-advances.ts` (CRUD + `GET /payout-listing`); the maths, the runtime self-apply and the payroll hook live in `src/api/lib/employee-advances.ts`
  - Admin attendance → `src/api/routes/attendance.ts` (553); departments → `src/api/routes/departments.ts` (431)
  - Read-only aggregate → `src/api/routes/department-performance.ts` (848); leaves → `src/api/routes/leaves.ts` (354)
- **Engine libs**
  - `src/lib/labor-engine.ts` — THE payroll + costing engine (`computeMonthlyLabor`).
  - `src/lib/costing.ts` — per-minute labour rate for product/BOM costing (distinct from payroll divisor).

## Data model
- `workers` — employee master (empNo, department codes/categories, `basicSalarySen`, `workingDaysPerMonth` default 26, `workingHoursPerDay`, `otMultiplier`, statutory toggles, `joinDate`/`resignedAt`).
- `worker_salary_history` (mig 0153) — effective-dated salary; a worker's pay on any date is the latest row with `effectiveFrom <= date`. Never read a single "current" salary.
- `worker_pins` / `worker_tokens` — PIN auth store (D1-backed; replaced old in-memory maps). PINs are SHA-256 hex; `must_reset` forces the 4→6-digit reset.
- `working_hour_entries` — per-worker per-day production minutes by department (efficiency numerator/denominator source).
- `attendance_records` — admin-side attendance (punch photos, dept breakdown JSON).
- `payroll_records` / `payroll_payslips` — generated payslip rows per period; `payroll_hour_deductions` (mig 0152) = short-hour docks.
- `employee_advances` (mig 0211, runtime self-applied by `ensureAdvanceTables`) — one row per cash advance: `worker_id`, `advance_date` (the day the cash was handed over — THIS is what puts it in a pay period), `amount_sen`, `note`, `entered_by`, `status` UNSETTLED|SETTLED. `payslips.advance_deduction_sen` snapshots what each generated payslip recovered.
- `departments` — department master (`isProduction` flag gates the efficiency denominator); `leaves`, `worker_issues`, `public_holidays` (via `kv_config['public_holidays']`).

## Core flows
1. **PIN login → token** — `worker-auth.ts` `POST /login` **:124**. First login with `firstTimePin` registers the PIN; SHA-256 (`hashPin`, `src/api/lib/auth-utils.ts`); legacy cleartext rows rewritten on match; brute-force throttle 10/15 min; `must_reset` gate forces 6-digit reset. Every worker-app request then carries `X-Worker-Token`, resolved by `resolveWorkerToken` (`worker-auth.ts:337`) via `getWorker` (`worker.ts:160`), which also 403s any non-ACTIVE worker (locks a resigned phone mid-session).
2. **Clock / dept-scan** — `worker.ts` `POST /clock` **:1067** (CLOCK_IN/OUT, optional geo + selfie), `POST /dept-scan` **:1324**, `GET /today` **:362**. Feeds working-hour capture and attendance.
3. **Payslip generation (the engine)** — `payslips.ts` `POST /` **:994** calls `computeMonthlyLabor` (`labor-engine.ts:557`) once per worker (`:1246`); `GET /projected` **:710** runs the IDENTICAL engine for all ACTIVE workers (`:855`). Salary resolved via `effectiveSalarySenForMonth` (`labor-engine.ts:408`); statutory via `calcStatutory` (`payslips.ts:295`); per-day absence/OT detail via `buildDayDetailForPeriod` (`:480`). **`payroll.ts POST /` (**:125**) is NOT a run-header guard — it is DISABLED.** After the `payroll:create` RBAC check it returns **501** unconditionally (`payroll.ts:125-139`), because it used to invent overtime hours with a random number generator instead of reading attendance; its own header calls it "a legacy duplicate" and says refusing is the fix. Payroll is generated only by `POST /api/payslips`. `GET`/`PUT` on `/api/payroll` are left working so existing rows stay readable.
4. **Day-typed OT** — inside `computeMonthlyLabor` (`labor-engine.ts:557`), OT hours split into weekday(1.5×)/Sunday(2×)/holiday(3×) buckets; payslips persist `otWeekday/Sunday/HolidayPaySen`. Holidays from `kv_config['public_holidays']`.
5. **Short-hour dock** — `payroll-hour-deductions.ts` `POST /auto-from-punch` **:149** derives docks from punches; `POST /settle-period` **:211** folds them into the period.
6. **Effective-dated salary** — `workers.ts` `GET /salary/effective` **:1199** returns each worker's day-weighted rate for a period; `resyncCurrentSalary` (`:1122`) keeps `workers.basicSalarySen` in sync with the latest history row.

## Key functions / sections (locate-to-function)
| Symbol / section | file:line | Role |
|---|---|---|
| `EmployeesPage` (shell + tab switch) | `src/pages/employees.tsx:11572` | 9-tab admin host (default export, at file tail) |
| `WorkingHoursTab` | `src/pages/employees.tsx:1015` | Tab 1 — flat working-hours grid |
| `EmployeeMasterTab` | `src/pages/employees.tsx:2364` | Tab 2 — worker master + salary |
| `EfficiencyOverviewTab` | `src/pages/employees.tsx:3804` | Tab 3 — efficiency overview |
| `DepartmentLaborTab` | `src/pages/employees.tsx:4369` | Dept labor cost breakdown |
| `EmployeeDetailTab` | `src/pages/employees.tsx:5346` | Tab 4 — guard-unmounted detail |
| `PayrollTab` | `src/pages/employees.tsx:6722` | Tab 5 — payroll drafts |
| `LaborCostTab` | `src/pages/employees.tsx:8570` | Tab 5b — labor cost + DepartmentsManager |
| `LeaveManagementTab` / `AttendanceTab` | `src/pages/employees.tsx:10213 / 11340` | Leave + attendance tabs |
| `computeMonthlyLabor` | `src/lib/labor-engine.ts:557` | THE payroll + cost engine (both divisors) |
| `effectiveSalarySenForMonth` / `salaryAsOfSen` | `src/lib/labor-engine.ts:408 / 382` | Day-weighted effective salary |
| `countElapsedWorkingDays` | `src/lib/labor-engine.ts:135` | Cost-side divisor (real Mon–Sat − holidays) |
| `countPublicHolidaysInMonth` | `src/lib/labor-engine.ts:109` | Holiday count for both divisors |
| `computeAttendanceDayDetail` | `src/lib/labor-engine.ts:301` | Per-day absence/OT day-type detail |
| `laborRatePerMinuteSen` | `src/lib/costing.ts:73` | Per-minute rate for product/BOM costing |
| `computeMonthlyLabor` call sites | `src/api/routes/payslips.ts:863 / 1254` | Projected (all) + generate (per worker) |
| `calcStatutory` / `buildDayDetailForPeriod` | `src/api/routes/payslips.ts:295 / 480` | EPF/SOCSO/EIS/PCB + per-day detail |
| `POST /login` / `resolveWorkerToken` | `src/api/routes/worker-auth.ts:124 / 337` | PIN login + token resolution |
| `getWorker` (token gate) | `src/api/routes/worker.ts:160` | X-Worker-Token → ACTIVE worker or 401/403 |
| `POST /clock` / `POST /dept-scan` | `src/api/routes/worker.ts:1067 / 1324` | Clock in/out + department scan |
| `GET /salary/effective` | `src/api/routes/workers.ts:1199` | Day-weighted salary per period |
| `POST /auto-from-punch` / `settle-period` | `src/api/routes/payroll-hour-deductions.ts:149 / 211` | Short-hour docks |

## Gotchas
- **A salary advance is neither an earning nor a statutory deduction.** `netPay = gross − totalDeductions − advance`, and `totalDeductionsSen` stays statutory-only — folding advances into it would inflate every YTD and statutory report. The advance is subtracted AFTER the statutory block, in both `payslips.ts POST /` and `GET /projected` (one shared helper, so the finalised slip and the estimate cannot disagree). Net pay is deliberately NOT clamped at zero: drawing more than the month earns shows a negative net pay (a debt) rather than silently writing the difference off. Approving a period settles its advances (locking edit/delete); reverting to DRAFT unlocks them.
- **Two divisors, both in `labor-engine.ts`, never revert either.** Pay side = ÷26 (`workingDaysPerMonth`) for absence, late/short docks, OT base; hourly = ÷26 ÷ the worker's DAY SPAN (daily hours + lunch, e.g. 9h→÷10). Cost side = ÷ ACTUAL Mon–Sat working days minus holidays (`countElapsedWorkingDays:135` → `costingDailyRateSen:706`). NEVER revert to fixed-26 or ÷calendar. (Note: `src/lib/costing.ts` is a *different* rate — per-minute product costing, not the payroll divisor.)
- **Day-typed OT must stay byte-identical for weekday-only.** OT splits weekday(1.5×)/Sunday(2×)/holiday(3×) inline in `computeMonthlyLabor` (`labor-engine.ts:557`); premium routes to the dept line, not Overhead. Holidays from `kv_config['public_holidays']`.
- **Three screens reconcile to the sen.** Payroll / Dept Labor / Labor Cost tie out via `roundSen` + `distributeRoundSen` (largest-remainder, `src/lib/utils.ts`); leftover sen → largest-fraction dept. Don't add per-screen ad-hoc plugs.
- **Salary is effective-dated** (`worker_salary_history`, mig 0153) — never read one "current" salary; use `GET /salary/effective`. Join/resign does NO proration; unworked working days dock ÷26 as absences.
- **Migrations are inert** — `payroll_hour_deductions` (0152), `worker_salary_history` (0153) etc. reach prod only via runtime `ensurePendingMigrations` self-apply, not by replaying migration files on deploy.
- **PINs are SHA-256, unsalted by design** (10^4–10^6 space; brute-force is throttled instead). A resigned/inactive worker is locked out of the ENTIRE app mid-session via `getWorker` (`worker.ts:160`), not just at login.
- **camelCase DB columns fold to lowercase** and can silently return undefined (`clockinphoto ↛ clockInPhoto`); read at-risk cols dual-keyed `r.camelCase ?? r.snake_case`. New columns snake_case; a write to a camelCase col needs a `column-rename-map.json` entry.
- **Employee Detail tab is intentionally guard-unmounted** (`{activeTab === "detail" && …}` inside `EmployeesPage`, `employees.tsx:11572`) — don't refactor to always-mounted.
- **UI is 100% English** — no Chinese strings/comments. Add a new tab to BOTH the tab array and the `activeTab` switch inside `EmployeesPage`.

## Common tasks (mini-playbook)
- **Add a field to the worker master** → snake_case column self-applied via `ensurePendingMigrations`; persist in `workers.ts POST /` (:279) and `PUT /:id` (:455); surface in `rowToWorker` (:192); render in `EmployeeMasterTab` (`employees.tsx:2364`). camelCase col → `column-rename-map.json` entry.
- **Change payroll math** → edit `computeMonthlyLabor` (`labor-engine.ts:557`) ONLY; both `payslips.ts` (generate :1246, projected :855) call it. Verify with `tests/labor-engine.test.mjs`; keep weekday-only OT byte-identical.
- **Adjust a statutory rate** → `calcStatutory` (`payslips.ts:295`); toggles live per-worker in the master.
- **Touch the worker app** → gate every new endpoint with `getWorker` (`worker.ts:160`); add the route to `worker.ts` and the screen under `src/pages/worker/`.
- **Change efficiency** → source is `working-hour-entries.ts` (summary :499, dept-category-summary :613); only `isProduction` departments count in the denominator (nonprod approvals credit the numerator).

## Related modules
[[production]] [[accounting]] [[customers]] [[delivery]]
